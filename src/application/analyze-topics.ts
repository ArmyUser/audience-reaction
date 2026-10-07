import { assertValidInput } from "../core/aggregation/aggregate";
import type { ClassificationSchema } from "../core/classification/schema";
import type { ClassifiedComment, FocusTarget } from "../core/domain/types";
import type { TopicDiscoverer } from "../core/ports";
import { DEFAULT_TOPIC_PARAMETERS } from "../core/topics/aggregate-topics";
import { parseDiscoverySampleMethod } from "../core/topics/discovery-sample";
import { TOPIC_NORMALIZATION_VERSION } from "../core/topics/normalize";
import { sanitizeReportedIssues, toValidationFeedback, validateTopicAttempt } from "../core/topics/topic-result";
import { TopicDiscoveryOutputError } from "../core/topics/validation";
import type { DiscoverySampleMethod, TopicAnalysis, TopicIssue, TopicMethod, TopicParameters, TopicValidationFeedback } from "../core/topics/types";

export interface AnalyzeTopicsInput {
  /** Validly classified comments (classification failures are already excluded). */
  classified: readonly ClassifiedComment[];
  schema: ClassificationSchema;
  focus?: FocusTarget;
}

export interface AnalyzeTopicsDeps {
  discoverer: TopicDiscoverer;
  params?: Partial<TopicParameters>;
}

/** spec.md §7.8: the first attempt plus exactly one retry. */
export const MAX_TOPIC_ATTEMPTS = 2;

/** Process-local counter for opaque run IDs: unique per analyzeTopics execution, never derived from content or stored. */
let runCounter = 0;

/**
 * M4 use case: classified comments → topic discovery (one disposition per comment, with the sentiment toward its
 * primary topic) → normalised topics → topic × topic-sentiment → evidence references.
 * - Only the sentiment base (no spam/irrelevant) is sent to the discoverer; with an empty base it is not called.
 * - Each attempt is validated as a whole (validateTopicAttempt). An invalid attempt, a provider error or a structured
 *   rejection thrown by the discoverer (TopicDiscoveryOutputError, kept as sanitised issues) is retried once with
 *   structured feedback; a second failure yields `unavailable` (TOPICS_UNAVAILABLE, spec.md §7.8) with the
 *   diagnostics of both attempts and no partial topics. At most two provider calls; the rest of an analysis is
 *   unaffected. Provider error messages are never copied.
 * - Both attempts carry the same opaque `run` identity, so a shared stateful discoverer keeps retry state per analysis;
 *   `finishRun` is called exactly once at the end (also on failure) to release that state and collect sampling
 *   methodology for the method record.
 * - An available result always satisfies AC-23: named + OTHER + NO_SPECIFIC_TOPIC = topic base.
 * - Classifications, including overall comment sentiment, are read, never changed.
 * The contract does not depend on the discoverer: any TopicDiscoverer can replace the fixture fake.
 */
export async function analyzeTopics(input: AnalyzeTopicsInput, deps: AnalyzeTopicsDeps): Promise<TopicAnalysis> {
  const parameters: TopicParameters = { ...DEFAULT_TOPIC_PARAMETERS, ...deps.params };
  assertValidInput(input.classified, input.schema);
  const base = input.classified.filter((c) => c.classification.type !== "spam_irrelevant");
  const baseIds = base.map((c) => c.comment.id);
  const method = (attempts: number, discoverySample?: DiscoverySampleMethod): TopicMethod => ({
    providerLabel: deps.discoverer.label,
    normalizationVersion: TOPIC_NORMALIZATION_VERSION,
    commentsSent: attempts === 0 ? 0 : base.length,
    attempts,
    parameters,
    ...(discoverySample ? { discoverySample } : {}),
  });

  if (base.length === 0) {
    const empty = validateTopicAttempt({ topics: [], assignments: [] }, input.classified, input.schema, parameters);
    if (empty.status !== "valid") throw new Error("An empty topic base must validate");
    return { status: "available", ...empty.aggregation, coverage: empty.coverage, method: method(0) };
  }

  const analysedIds = new Set(baseIds);
  const runId = `topics-run-${++runCounter}`;
  let finished = false;
  /** Ends the run once: releases discoverer state; sampling methodology is kept only if well-formed. */
  const finishRun = (): DiscoverySampleMethod | undefined => {
    if (finished) return undefined;
    finished = true;
    try {
      return parseDiscoverySampleMethod(deps.discoverer.finishRun?.(runId)?.discoverySample);
    } catch {
      return undefined;
    }
  };
  const callProvider = async (attempt: number, feedback: TopicValidationFeedback | undefined): Promise<{ ok: true; raw: unknown } | { ok: false; issues: TopicIssue[] }> => {
    try {
      const raw = await deps.discoverer.discoverTopics({
        comments: base.map((c) => ({
          id: c.comment.id,
          text: c.comment.text,
          classification: {
            type: c.classification.type,
            sentiment: c.classification.sentiment,
            focusMentioned: c.focusMention === "explicit" || c.focusMention === "inferred",
          },
        })),
        context: { ...(input.focus ? { focus: input.focus } : {}), sentimentLabels: input.schema.sentimentLabels, maxTopics: parameters.maxTopics },
        ...(feedback ? { feedback } : {}),
        run: { id: runId, attempt },
      });
      return { ok: true, raw };
    } catch (error) {
      // A discoverer may reject its own intermediate output with structured issues (e.g. a taxonomy failing AC-21);
      // those are kept, sanitised. Any other failure is a provider error; its message is never copied.
      if (error instanceof TopicDiscoveryOutputError) return { ok: false, issues: sanitizeReportedIssues(error.issues, analysedIds) };
      return { ok: false, issues: [{ code: "provider_error" }] };
    }
  };

  try {
    const diagnostics: TopicIssue[] = [];
    let feedback: TopicValidationFeedback | undefined;
    for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
      const call = await callProvider(attempt, feedback);
      let issues: TopicIssue[] = call.ok ? [] : call.issues;
      if (call.ok) {
        // Unexpected engine errors (not provider output problems) propagate to the caller.
        const result = validateTopicAttempt(call.raw, input.classified, input.schema, parameters);
        if (result.status === "valid") return { status: "available", ...result.aggregation, coverage: result.coverage, method: method(attempt, finishRun()) };
        issues = result.issues;
      }
      diagnostics.push(...issues.map((i) => ({ ...i, attempt })));
      feedback = toValidationFeedback(attempt, issues, baseIds);
    }
    return { status: "unavailable", reason: "TOPICS_UNAVAILABLE", issues: diagnostics, method: method(MAX_TOPIC_ATTEMPTS, finishRun()) };
  } finally {
    // Also on an unexpected engine error: the discoverer's run state is always released.
    finishRun();
  }
}
