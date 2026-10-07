import type { ClassificationSchema } from "../classification/schema";
import { ClassificationOutputError, classificationItemSchema } from "../classification/validation";
import {
  COMMENT_TYPES,
  type ClassifiedComment,
  type CommentType,
  type SentimentLabel,
  type Target,
} from "../domain/types";
import { buildDistribution, share, type Distribution, type Share } from "./distribution";

/** Thresholds from spec.md §2.6 (proposed starting values; configurable, not tuned). */
export interface AnalysisParameters {
  minAnalyzableForReport: number;
  lowVolumeWarningThreshold: number;
  smallSampleThreshold: number;
}

export const DEFAULT_ANALYSIS_PARAMETERS: Readonly<AnalysisParameters> = Object.freeze({
  minAnalyzableForReport: 50,
  lowVolumeWarningThreshold: 200,
  smallSampleThreshold: 30,
});

export type WarningCode =
  | "INSUFFICIENT_DATA"
  | "LOW_VOLUME"
  | "TARGET_SMALL_SAMPLE"
  | "CLASSIFICATION_FAILURES"
  | "CONSISTENCY_ISSUES";

/** Comments retrieved but not analysed, and data-quality signals from classification (spec.md §8.0, §8.11). */
export interface ClassificationExclusions {
  /** Comments that never received a valid classification after retries (X_fail). */
  classificationFailures: number;
  /** Valid classifications that broke a consistency rule (reported, not corrected). */
  consistencyIssues: number;
}

export interface AnalysisWarning {
  code: WarningCode;
  target?: Target;
}

export interface TargetMetrics {
  target: Target;
  /** Comments in the sentiment base that address this target; base = sentiment base B. */
  mentions: Share;
  /** Sentiment toward the target among comments that address it; base = mentions. */
  sentiment: Distribution<SentimentLabel>;
  /** True when mentions < smallSampleThreshold: show counts only, no headline percentages (spec.md §8.6). */
  smallSample: boolean;
  /** Focus target only: how addressed comments referenced it. */
  focusReferences?: { explicit: number; inferred: number };
}

export interface AggregateMetrics {
  /** R: comments retrieved from the source = A + classification failures. */
  commentsRetrieved: number;
  /** Excluded because no valid classification could be obtained (never counted as any label). */
  classificationFailures: number;
  consistencyIssues: number;
  /** A: all analysed (validly classified) comments. */
  commentsAnalysed: number;
  /** S: spam/irrelevant comments, excluded from the sentiment base. */
  spamExcluded: number;
  /** B = A − S. */
  sentimentBase: number;
  /** Primary-type distribution over A. */
  commentTypes: Distribution<CommentType>;
  /** Overall sentiment over B. */
  overallSentiment: Distribution<SentimentLabel>;
  /** Flags over B; independent of the primary-type distribution. */
  questions: Share;
  requests: Share;
  targets: TargetMetrics[];
  sufficientForReport: boolean;
  warnings: AnalysisWarning[];
}

/**
 * Deterministic aggregation (spec.md §8). Inputs are re-validated: invalid, duplicated or missing data is rejected,
 * never guessed. Output depends only on the classifications, never on which provider produced them.
 */
export function aggregate(
  classified: readonly ClassifiedComment[],
  schema: ClassificationSchema,
  params: AnalysisParameters = DEFAULT_ANALYSIS_PARAMETERS,
  exclusions: ClassificationExclusions = { classificationFailures: 0, consistencyIssues: 0 },
): AggregateMetrics {
  if (![exclusions.classificationFailures, exclusions.consistencyIssues].every((n) => Number.isInteger(n) && n >= 0)) {
    throw new RangeError("Exclusion counts must be non-negative integers");
  }
  assertValidInput(classified, schema);

  const base = classified.filter((c) => c.classification.type !== "spam_irrelevant");
  const B = base.length;

  const targets: TargetMetrics[] = schema.targets.map((target) => {
    const addressing = base.filter((c) => targetLabel(c, target) !== "not_addressed");
    const metrics: TargetMetrics = {
      target,
      mentions: share(addressing.length, B),
      sentiment: buildDistribution(schema.sentimentLabels, addressing.map((c) => targetLabel(c, target) as SentimentLabel)),
      smallSample: addressing.length < params.smallSampleThreshold,
    };
    if (target === "focus") {
      metrics.focusReferences = {
        explicit: addressing.filter((c) => c.focusMention === "explicit").length,
        inferred: addressing.filter((c) => c.focusMention === "inferred").length,
      };
    }
    return metrics;
  });

  const warnings: AnalysisWarning[] = [];
  if (B < params.minAnalyzableForReport) warnings.push({ code: "INSUFFICIENT_DATA" });
  else if (B < params.lowVolumeWarningThreshold) warnings.push({ code: "LOW_VOLUME" });
  for (const t of targets) if (t.smallSample) warnings.push({ code: "TARGET_SMALL_SAMPLE", target: t.target });
  if (exclusions.classificationFailures > 0) warnings.push({ code: "CLASSIFICATION_FAILURES" });
  if (exclusions.consistencyIssues > 0) warnings.push({ code: "CONSISTENCY_ISSUES" });

  return {
    commentsRetrieved: classified.length + exclusions.classificationFailures,
    classificationFailures: exclusions.classificationFailures,
    consistencyIssues: exclusions.consistencyIssues,
    commentsAnalysed: classified.length,
    spamExcluded: classified.length - B,
    sentimentBase: B,
    commentTypes: buildDistribution(COMMENT_TYPES, classified.map((c) => c.classification.type)),
    overallSentiment: buildDistribution(schema.sentimentLabels, base.map((c) => c.classification.sentiment)),
    questions: share(base.filter((c) => c.classification.isQuestion).length, B),
    requests: share(base.filter((c) => c.classification.isRequest).length, B),
    targets,
    sufficientForReport: B >= params.minAnalyzableForReport,
    warnings,
  };
}

function targetLabel(c: ClassifiedComment, target: Target) {
  const label = c.classification.targets[target];
  if (label === undefined) throw new ClassificationOutputError([`missing ${target} target for ${c.comment.id}`]);
  return label;
}

/** Re-validates classified comments against the schema (shared by metric and topic aggregation). */
export function assertValidInput(classified: readonly ClassifiedComment[], schema: ClassificationSchema): void {
  const item = classificationItemSchema(schema);
  const ids = new Set<string>();
  const issues: string[] = [];
  for (const c of classified) {
    const id = c.comment.id;
    if (c.classification.commentId !== id) issues.push(`classification does not belong to comment ${id}`);
    if (ids.has(id)) issues.push(`duplicate comment ${id}`);
    ids.add(id);
    const parsed = item.safeParse(c.classification);
    if (!parsed.success) issues.push(...parsed.error.issues.map((i) => `${id}: ${i.path.join(".")} ${i.message}`));
    if (schema.focusConfigured) {
      const focus = c.classification.targets.focus;
      if (c.focusMention === undefined) issues.push(`${id}: focus mention type missing`);
      else if (c.focusMention === "inferred" && focus === "not_addressed") issues.push(`${id}: inferred focus mention without focus sentiment`);
      else if (c.focusMention === "none" && focus !== "not_addressed") issues.push(`${id}: focus addressed but mention type is none`);
    } else if (c.focusMention !== undefined) {
      issues.push(`${id}: focus mention type without a focus target`);
    }
  }
  if (issues.length > 0) throw new ClassificationOutputError(issues);
}
