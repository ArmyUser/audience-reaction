import type { ClassificationSchema } from "../classification/schema";
import type { ClassifiedComment } from "../domain/types";
import { aggregateTopics, type TopicAggregation, type TopicAggregationParameters } from "./aggregate-topics";
import { TOPIC_KEY_PATTERN } from "./taxonomy";
import { compareIds, parseTopicDiscoveryOutput, TopicDiscoveryOutputError } from "./validation";
import type { TopicCoverage, TopicDiscoveryResult, TopicIssue, TopicIssueCode, TopicValidationFeedback } from "./types";

/** A provider attempt that may be reported: every non-spam comment has exactly one valid disposition (AC-23). */
export interface ValidTopicAttempt {
  status: "valid";
  aggregation: Omit<TopicAggregation, "coverage" | "issues">;
  coverage: TopicCoverage;
}

export interface InvalidTopicAttempt {
  status: "invalid";
  issues: TopicIssue[];
}

/**
 * Validates one complete provider attempt (spec.md §7.8, AC-21, AC-23). The attempt is valid only if the output
 * parses, every check passes with no issue at all (nothing is dropped from an otherwise available result) and every
 * successful-result invariant holds. Anything else is invalid, with structured issues for feedback and diagnostics.
 */
export function validateTopicAttempt(
  raw: unknown,
  classified: readonly ClassifiedComment[],
  schema: ClassificationSchema,
  params: TopicAggregationParameters & { maxTopics: number },
): ValidTopicAttempt | InvalidTopicAttempt {
  const base = classified.filter((c) => c.classification.type !== "spam_irrelevant");
  let discovery: TopicDiscoveryResult;
  try {
    discovery = parseTopicDiscoveryOutput(raw, base.map((c) => c.comment.id), { maxTopics: params.maxTopics, sentimentLabels: schema.sentimentLabels });
  } catch (error) {
    if (error instanceof TopicDiscoveryOutputError) return { status: "invalid", issues: error.issues };
    throw error;
  }
  const { coverage, issues: aggregationIssues, ...aggregation } = aggregateTopics(discovery, classified, schema, params);
  const issues = [...discovery.issues, ...aggregationIssues];
  if (issues.length > 0) return { status: "invalid", issues };
  // Final safety check on an otherwise clean attempt.
  const violations = invariantViolations(discovery, coverage, base, schema);
  if (violations.length > 0) return { status: "invalid", issues: violations };
  const final: TopicCoverage = {
    sentimentBase: coverage.sentimentBase,
    spamExcluded: coverage.spamExcluded,
    namedTopics: coverage.namedTopics,
    other: coverage.other,
    noSpecificTopic: coverage.noSpecificTopic,
  };
  return { status: "valid", aggregation, coverage: final };
}

/**
 * Successful-result invariants (one valid disposition per eligible comment, topic sentiment only on primary topics,
 * AC-23). Redundant with validation by design: a violation means the result is unusable.
 */
export function invariantViolations(
  discovery: TopicDiscoveryResult,
  coverage: TopicAggregation["coverage"],
  base: readonly ClassifiedComment[],
  schema: ClassificationSchema,
): TopicIssue[] {
  const violation = (detail: string): TopicIssue => ({ code: "invariant_violation", detail });
  const out: TopicIssue[] = [];
  const baseIds = new Set(base.map((c) => c.comment.id));
  const topicIds = new Set(discovery.topics.map((t) => t.id));
  const seen = new Set<string>();
  for (const a of discovery.assignments) {
    if (seen.has(a.commentId)) out.push(violation("more than one disposition for a comment"));
    seen.add(a.commentId);
    if (a.disposition === "primary_topic") {
      if (!topicIds.has(a.topicId)) out.push(violation("primary topic is not a discovered topic"));
      if (!schema.sentimentLabels.includes(a.topicSentiment)) out.push(violation("topic sentiment outside the schema"));
    } else if ("topicSentiment" in a || "topicId" in a) {
      out.push(violation("other/no_specific_topic carries a topic or topic sentiment"));
    }
  }
  if (seen.size !== baseIds.size || [...baseIds].some((id) => !seen.has(id))) out.push(violation("not every eligible comment has exactly one disposition"));
  if (coverage.assignmentRejected.count !== 0) out.push(violation("rejected assignments in a result"));
  const B = coverage.sentimentBase;
  if (coverage.namedTopics.count + coverage.other.count + coverage.noSpecificTopic.count !== B) out.push(violation("coverage does not sum to the topic base"));
  if ([coverage.namedTopics, coverage.other, coverage.noSpecificTopic].some((s) => s.base !== B)) out.push(violation("a coverage share is not over the topic base"));
  return out;
}

/** Topic keys are echoed only when they look like identifiers; anything else could be provider-written content. */
const SAFE_KEY = TOPIC_KEY_PATTERN;

/** Every issue code, checked against the type at compile time. */
const ISSUE_CODES: Record<TopicIssueCode, true> = {
  invalid_output: true,
  too_many_topics: true,
  provider_error: true,
  internal_error: true,
  invalid_topic: true,
  duplicate_topic_key: true,
  invalid_topic_name: true,
  invalid_topic_key: true,
  missing_definition: true,
  duplicate_topic_name: true,
  unknown_example_comment: true,
  invalid_assignment: true,
  unknown_comment: true,
  unknown_topic: true,
  assignment_to_dropped_topic: true,
  multiple_primary_topics: true,
  missing_assignment: true,
  invariant_violation: true,
  excluded_comment: true,
};

/**
 * Structured issues a discoverer reports by throwing TopicDiscoveryOutputError (e.g. a two-phase workflow whose
 * taxonomy failed AC-21), reduced to what may travel: known codes, integer indexes, analysed-comment IDs and
 * identifier-like keys. Free text (`detail`) is dropped; an unknown code or an empty list becomes `provider_error`.
 */
export function sanitizeReportedIssues(issues: readonly TopicIssue[], analysedCommentIds: ReadonlySet<string>): TopicIssue[] {
  const out = issues.map((issue): TopicIssue => {
    if (typeof issue?.code !== "string" || !Object.hasOwn(ISSUE_CODES, issue.code)) return { code: "provider_error" };
    return {
      code: issue.code,
      ...(Number.isInteger(issue.index) && issue.index! >= 0 ? { index: issue.index! } : {}),
      ...(typeof issue.commentId === "string" && analysedCommentIds.has(issue.commentId) ? { commentId: issue.commentId } : {}),
      ...(typeof issue.topicKey === "string" && SAFE_KEY.test(issue.topicKey) ? { topicKey: issue.topicKey } : {}),
    };
  });
  return out.length > 0 ? out : [{ code: "provider_error" }];
}

/**
 * Retry feedback from an invalid attempt: per issue code, its count, the affected analysed-comment IDs and
 * identifier-like topic keys. Free-text details, indexes and unknown IDs are never included.
 */
export function toValidationFeedback(attempt: number, issues: readonly TopicIssue[], analysedCommentIds: readonly string[]): TopicValidationFeedback {
  const order = new Map(analysedCommentIds.map((id, i) => [id, i]));
  const byCode = new Map<TopicIssueCode, { count: number; commentIds: Set<string>; topicKeys: Set<string> }>();
  for (const issue of issues) {
    const entry = byCode.get(issue.code) ?? { count: 0, commentIds: new Set<string>(), topicKeys: new Set<string>() };
    byCode.set(issue.code, entry);
    entry.count += 1;
    if (issue.commentId !== undefined && order.has(issue.commentId)) entry.commentIds.add(issue.commentId);
    if (issue.topicKey !== undefined && SAFE_KEY.test(issue.topicKey)) entry.topicKeys.add(issue.topicKey);
  }
  return {
    attempt,
    issues: [...byCode]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([code, e]) => ({
        code,
        count: e.count,
        ...(e.commentIds.size > 0 ? { commentIds: [...e.commentIds].sort((a, b) => order.get(a)! - order.get(b)!) } : {}),
        ...(e.topicKeys.size > 0 ? { topicKeys: [...e.topicKeys].sort(compareIds) } : {}),
      })),
  };
}
