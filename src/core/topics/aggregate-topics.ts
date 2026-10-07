import { assertValidInput, DEFAULT_ANALYSIS_PARAMETERS } from "../aggregation/aggregate";
import { buildDistribution, share } from "../aggregation/distribution";
import type { ClassificationSchema } from "../classification/schema";
import type { ClassifiedComment } from "../domain/types";
import { selectTopicEvidence } from "./evidence";
import { compareIds } from "./validation";
import type {
  DroppedTopic,
  MergedTopic,
  OtherTopics,
  Topic,
  CommentTopicLabel,
  TopicAccounting,
  TopicCoverage,
  TopicDiscoveryResult,
  TopicIssue,
  TopicMention,
  TopicParameters,
  TopicWarning,
} from "./types";

export type { CommentTopicLabel } from "./types";

/** spec.md §2.6 proposals. Provider-neutral constants; not tuned. */
export const DEFAULT_TOPIC_PARAMETERS: Readonly<TopicParameters> = Object.freeze({
  maxTopics: 12,
  evidencePerTopic: 3,
  smallSampleThreshold: DEFAULT_ANALYSIS_PARAMETERS.smallSampleThreshold,
  minTopicSizeFloor: 10,
  minTopicSizePercentOfBase: 1,
  otherWarningThresholdPercent: 35,
});

export type TopicAggregationParameters = Pick<
  TopicParameters,
  "evidencePerTopic" | "smallSampleThreshold" | "minTopicSizeFloor" | "minTopicSizePercentOfBase" | "otherWarningThresholdPercent"
>;

export interface TopicAggregation {
  /** Named topics (at or above the minimum topic size). */
  topics: Topic[];
  other: OtherTopics;
  minTopicSize: number;
  droppedTopics: DroppedTopic[];
  /** Diagnostic accounting, including comments without a valid disposition. */
  coverage: TopicAccounting;
  warnings: TopicWarning[];
  /** Assignments that could not be counted (spam/irrelevant or unknown comments, unknown topics, invalid labels). */
  issues: TopicIssue[];
  /** Every counted disposition, ordered by comment ID (derived from the same data; changes no count). */
  commentTopics: CommentTopicLabel[];
}

/**
 * spec.md §2.6 `min_topic_size` = max(floor, ceil(percent% × topicBase)), where topicBase is the number of eligible
 * (non-spam) analysed comments: not all retrieved comments, and not only comments that have a topic.
 */
export function minimumTopicSize(topicBase: number, params: Pick<TopicParameters, "minTopicSizeFloor" | "minTopicSizePercentOfBase">): number {
  if (!Number.isInteger(topicBase) || topicBase < 0) throw new RangeError(`Invalid topic base ${topicBase}`);
  return Math.max(params.minTopicSizeFloor, Math.ceil((topicBase * params.minTopicSizePercentOfBase) / 100));
}

/**
 * HIGH_OTHER_SHARE (spec.md §7.9): (OTHER + NO_SPECIFIC_TOPIC) / topicBase strictly greater than the threshold.
 * Compared on exact counts (not rounded percentages), so exactly the threshold does not warn.
 */
export function highOtherShareWarning(coverage: TopicCoverage, thresholdPercent: number): TopicWarning[] {
  const base = coverage.sentimentBase;
  const combined = coverage.other.count + coverage.noSpecificTopic.count;
  if (base === 0 || combined * 100 <= thresholdPercent * base) return [];
  return [{ code: "HIGH_OTHER_SHARE", other: coverage.other, noSpecificTopic: coverage.noSpecificTopic, combined: share(combined, base), thresholdPercent }];
}

/**
 * Deterministic topic × sentiment aggregation (spec.md §7.6, §7.10, §8.7–8.8).
 * - Base: validly classified comments that are not spam/irrelevant. Assignments to spam/irrelevant comments are
 *   excluded and reported (`excluded_comment`), never counted.
 * - One disposition per comment (spec.md §7.6): a discovered primary topic, `other` or `no_specific_topic`. A discovery
 *   result with two entries for one comment violates its contract and throws, so nothing is double-counted.
 * - The per-topic distribution uses topic sentiment (toward the topic). The comment's overall classifier sentiment is
 *   carried on each mention for explanation only; it is neither aggregated here nor changed. Labels follow the schema,
 *   so `mixed` is its own row when enabled.
 * - Topics without any valid mention are listed in `droppedTopics`.
 * - Topics with fewer mentions than the minimum topic size are merged into OTHER (names and IDs kept); the rest are
 *   named topics, ordered by mention count (descending), then topic ID.
 * - OTHER = provider `other` + small-topic comments (both origins counted separately); NO_SPECIFIC_TOPIC = provider
 *   `no_specific_topic`. Neither carries a topic sentiment.
 * - Coverage buckets partition the topic base exactly: every base comment is named, OTHER, NO_SPECIFIC_TOPIC, or
 *   (lacking a valid disposition: invalid, multiple, missing, unknown topic) assignmentRejected.
 */
export function aggregateTopics(
  discovery: TopicDiscoveryResult,
  classified: readonly ClassifiedComment[],
  schema: ClassificationSchema,
  params: TopicAggregationParameters = DEFAULT_TOPIC_PARAMETERS,
): TopicAggregation {
  assertValidInput(classified, schema);
  const byId = new Map(classified.map((c) => [c.comment.id, c.classification]));
  const base = classified.filter((c) => c.classification.type !== "spam_irrelevant");
  const known = new Set(discovery.topics.map((t) => t.id));

  const issues: TopicIssue[] = [];
  const assigned = new Set<string>();
  let providerOther = 0;
  let noSpecificTopic = 0;
  const mentionsByTopic = new Map<string, TopicMention[]>();
  const counted: ({ commentId: string; disposition: "other" | "no_specific_topic" } | TopicMention)[] = [];
  for (const a of discovery.assignments) {
    if (assigned.has(a.commentId)) throw new RangeError("A comment has more than one primary topic assignment");
    assigned.add(a.commentId);
    const classification = byId.get(a.commentId);
    if (!classification) {
      issues.push({ code: "unknown_comment" });
      continue;
    }
    if (classification.type === "spam_irrelevant") {
      issues.push({ code: "excluded_comment", commentId: a.commentId });
      continue;
    }
    if (a.disposition !== "primary_topic") {
      if (a.disposition === "other") providerOther += 1;
      else noSpecificTopic += 1;
      counted.push({ commentId: a.commentId, disposition: a.disposition });
      continue;
    }
    if (!known.has(a.topicId)) {
      issues.push({ code: "unknown_topic", commentId: a.commentId });
      continue;
    }
    if (!schema.sentimentLabels.includes(a.topicSentiment)) {
      issues.push({ code: "invalid_assignment", commentId: a.commentId });
      continue;
    }
    const mention: TopicMention = {
      commentId: a.commentId,
      topicId: a.topicId,
      role: "primary",
      topicSentiment: a.topicSentiment,
      overallSentiment: classification.sentiment,
    };
    if (a.confidence !== undefined) mention.confidence = a.confidence;
    counted.push(mention);
    const list = mentionsByTopic.get(a.topicId);
    if (list) list.push(mention);
    else mentionsByTopic.set(a.topicId, [mention]);
  }

  const minTopicSize = minimumTopicSize(base.length, params);
  const topics: Topic[] = [];
  const merged: MergedTopic[] = [];
  const smallTopicMentions: TopicMention[] = [];
  const droppedTopics: DroppedTopic[] = [];
  for (const t of discovery.topics) {
    const mentions = mentionsByTopic.get(t.id) ?? [];
    if (mentions.length === 0) {
      droppedTopics.push({ id: t.id, name: t.name, reason: "no_mentions" });
      continue;
    }
    if (mentions.length < minTopicSize) {
      merged.push({ id: t.id, name: t.name, mentionCount: mentions.length });
      smallTopicMentions.push(...mentions);
      continue;
    }
    topics.push({
      id: t.id,
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      mentionCount: mentions.length,
      topicSentiment: buildDistribution(schema.sentimentLabels, mentions.map((m) => m.topicSentiment)),
      smallSample: mentions.length < params.smallSampleThreshold,
      evidence: selectTopicEvidence(mentions, schema.sentimentLabels, t.formation.providerExampleIds, params.evidencePerTopic),
      formation: t.formation,
    });
  }
  const byCountThenId = (a: { mentionCount: number; id: string }, b: { mentionCount: number; id: string }) => b.mentionCount - a.mentionCount || compareIds(a.id, b.id);
  topics.sort(byCountThenId);
  merged.sort(byCountThenId);

  const mergedIds = new Set(merged.map((m) => m.id));
  const named = topics.reduce((sum, t) => sum + t.mentionCount, 0);
  const other = providerOther + smallTopicMentions.length;
  const B = base.length;
  // Every base comment without a counted disposition (rejected in validation, or unusable here) is rejected.
  const coverage: TopicAccounting = {
    sentimentBase: B,
    spamExcluded: classified.length - B,
    namedTopics: share(named, B),
    other: share(other, B),
    noSpecificTopic: share(noSpecificTopic, B),
    assignmentRejected: share(B - named - other - noSpecificTopic, B),
  };
  return {
    topics,
    other: {
      mentionCount: other,
      providerOther,
      smallTopics: smallTopicMentions.length,
      smallTopicSentiment: buildDistribution(schema.sentimentLabels, smallTopicMentions.map((m) => m.topicSentiment)),
      mergedTopics: merged,
    },
    minTopicSize,
    droppedTopics,
    coverage,
    warnings: highOtherShareWarning(coverage, params.otherWarningThresholdPercent),
    issues,
    commentTopics: counted
      .map((c): CommentTopicLabel => {
        if (!("topicId" in c)) return c.disposition === "other" ? { commentId: c.commentId, disposition: "other" } : { commentId: c.commentId, disposition: "no_specific_topic" };
        return mergedIds.has(c.topicId) ? { commentId: c.commentId, disposition: "other", mergedFromTopicId: c.topicId } : { commentId: c.commentId, disposition: "topic", topicId: c.topicId, topicSentiment: c.topicSentiment };
      })
      .sort((a, b) => compareIds(a.commentId, b.commentId)),
  };
}
