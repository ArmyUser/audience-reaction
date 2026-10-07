import { aggregate, DEFAULT_ANALYSIS_PARAMETERS, type AggregateMetrics, type AnalysisParameters } from "../aggregation/aggregate";
import { classifyComments, DEFAULT_CLASSIFY_OPTIONS, type ClassifyCommentsResult } from "../classification/classify-comments";
import { createFocusMatcher } from "../classification/focus-matcher";
import { GUIDELINE_VERSION } from "../classification/guidelines";
import { createClassificationSchema, type ClassificationSchema } from "../classification/schema";
import type { ClassifiedComment, CommentClassification, FocusMentionType, FocusTarget } from "../domain/types";
import { PolicyBlockedError, type CompliancePolicy } from "../policy/compliance-policy";
import type { Classifier, CommentSource } from "../ports";
import { REPRESENTATIVENESS_NOTE, type ReportModel } from "../reporting/report-model";

export interface AnalysisInput {
  videoId: string;
  focus?: FocusTarget;
}

export interface AnalysisDeps {
  source: CommentSource;
  classifier: Classifier;
  policy: CompliancePolicy;
  /** Candidate `mixed` label; server-side configuration only. */
  mixedSentimentEnabled?: boolean;
  params?: AnalysisParameters;
  classification?: {
    /** Re-request rounds for comments without a valid classification. */
    retryRounds?: number;
    /** Above this share of failed comments the analysis fails instead of reporting (spec.md F11). */
    maxFailureRate?: number;
  };
}

export const DEFAULT_MAX_CLASSIFICATION_FAILURE_RATE = 0.05;

export class ClassificationFailedError extends Error {
  override readonly name = "ClassificationFailedError";
  constructor(readonly result: ClassifyCommentsResult, readonly total: number) {
    super(`${result.failures.length} of ${total} comments could not be classified.`);
  }
}

export type AnalysisOutcome =
  | { status: "completed"; report: ReportModel; classified: ClassifiedComment[]; classification: ClassifyCommentsResult; schema: ClassificationSchema }
  | { status: "insufficient_data"; metrics: AggregateMetrics };

/**
 * Synchronous pipeline: policy gate → retrieve → classify (per-comment validation + bounded retries) → derive focus
 * mentions → aggregate → report. The policy gate runs before any retrieval. Topics are added by the application layer
 * (the report starts with topics `not_run`); evidence and synthesis are not run yet (placeholders).
 */
export async function runAnalysis(input: AnalysisInput, deps: AnalysisDeps): Promise<AnalysisOutcome> {
  if (!deps.policy.derivedAnalyticsAllowed(deps.source.origin)) throw new PolicyBlockedError(deps.source.origin);

  const focus = normalizeFocus(input.focus);
  const schema = createClassificationSchema({ mixedEnabled: deps.mixedSentimentEnabled ?? false, focusConfigured: focus !== undefined });
  const comments = await deps.source.listComments(input.videoId);
  const classification = await classifyComments(comments, deps.classifier, schema, focus, {
    retryRounds: deps.classification?.retryRounds ?? DEFAULT_CLASSIFY_OPTIONS.retryRounds,
  });
  const maxFailureRate = deps.classification?.maxFailureRate ?? DEFAULT_MAX_CLASSIFICATION_FAILURE_RATE;
  if (comments.length > 0 && classification.failures.length / comments.length > maxFailureRate) {
    throw new ClassificationFailedError(classification, comments.length);
  }

  // Comments that failed classification are excluded and counted; they are never given a label.
  const byId = new Map(classification.classifications.map((c) => [c.commentId, c]));
  const matches = focus ? createFocusMatcher(focus) : undefined;
  const classified: ClassifiedComment[] = comments.flatMap((comment) => {
    const c = byId.get(comment.id);
    if (!c) return [];
    return matches ? [{ comment, classification: c, focusMention: focusMentionOf(c, matches(comment.text)) }] : [{ comment, classification: c }];
  });

  const metrics = aggregate(classified, schema, deps.params ?? DEFAULT_ANALYSIS_PARAMETERS, {
    classificationFailures: classification.failures.length,
    consistencyIssues: classification.consistencyIssues.length,
  });
  if (!metrics.sufficientForReport) return { status: "insufficient_data", metrics };

  return {
    status: "completed",
    classified,
    classification,
    schema,
    report: {
      videoId: input.videoId,
      ...(focus ? { focus } : {}),
      metrics,
      topics: { status: "not_run" },
      evidence: { status: "not_run" },
      synthesis: { status: "not_run" },
      methodology: {
        schemaVersion: schema.version,
        guidelineVersion: GUIDELINE_VERSION,
        sentimentLabels: schema.sentimentLabels,
        mixedCandidateEnabled: schema.mixedEnabled,
        sourceLabel: deps.source.label,
        sourceOrigin: deps.source.origin,
        classifierLabel: deps.classifier.label,
        sampling: "All available comments from the source were analysed; no sampling or cap was applied.",
        representativenessNote: REPRESENTATIVENESS_NOTE,
        policyNote: deps.policy.describeYouTubeGate(),
      },
    },
  };
}

/** Explicit = deterministic name/alias match; inferred = addressed without a match; none = not addressed. */
function focusMentionOf(classification: CommentClassification, explicitMatch: boolean): FocusMentionType {
  if (explicitMatch) return "explicit";
  return classification.targets.focus !== "not_addressed" ? "inferred" : "none";
}

function normalizeFocus(focus: FocusTarget | undefined): FocusTarget | undefined {
  const name = focus?.name.trim() ?? "";
  if (!focus || name === "") return undefined;
  const aliases = focus.aliases.map((a) => a.trim()).filter((a) => a.length > 0);
  // Sponsorship is kept only when explicitly known; it is never derived from the name or aliases.
  return typeof focus.isVideoSponsor === "boolean" ? { name, aliases, isVideoSponsor: focus.isVideoSponsor } : { name, aliases };
}
