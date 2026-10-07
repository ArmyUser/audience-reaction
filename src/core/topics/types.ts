import type { Distribution, Share } from "../aggregation/distribution";
import type { SentimentLabel } from "../domain/types";

// Topic domain (spec.md §7, §8.7–8.8, §9). Topics are derived analytics: they hold names, counts and comment-ID
// references only, never comment text or commenter identity. Sentiment always comes from the existing comment
// classification; the topic layer never derives or changes sentiment.

/** Stable topic ID derived from the normalised name (`topic:<words-joined-by-hyphens>`), see normalize.ts. */
export type TopicId = string;

/** How a topic was formed from provider output, so the result can be explained without the provider. */
export interface TopicFormation {
  /** Names exactly as the provider returned them that normalised to this topic, in provider order. */
  sourceNames: string[];
  /** The provider's own topic keys merged into this topic, in provider order. */
  providerKeys: string[];
  /** Example comment IDs the provider offered for this topic that exist in the analysed comments, in provider order. */
  providerExampleIds: string[];
}

/** A validated, normalised topic from discovery, before aggregation. */
export interface DiscoveredTopic {
  id: TopicId;
  /** Normalised name (normalize.ts). */
  name: string;
  /** First non-empty description among the merged provider topics. */
  description?: string;
  formation: TopicFormation;
}

/**
 * The role of an assignment. M4 has exactly one primary topic per comment (spec.md §7.6). Multi-topic assignment
 * (OD-04) would add roles here; until then any second assignment for a comment is rejected.
 */
export type TopicAssignmentRole = "primary";

/**
 * Per-comment topic disposition (spec.md §7.6, §S6): exactly one of
 * - `primary_topic`: the comment's primary topic is a discovered topic;
 * - `other`: substantive, but not covered by any discovered topic (spec `OTHER`);
 * - `no_specific_topic`: generic, no specific topic ("great video", "😂") (spec `NO_SPECIFIC_TOPIC`).
 */
export type TopicDisposition = "primary_topic" | "other" | "no_specific_topic";

/**
 * A validated primary-topic assignment. `topicSentiment` is the sentiment toward this topic (spec.md §7.6), supplied by
 * topic assignment; it is independent of, and never replaces, the comment's overall classifier sentiment.
 */
export interface PrimaryTopicAssignment {
  commentId: string;
  disposition: "primary_topic";
  topicId: TopicId;
  topicSentiment: SentimentLabel;
  /** Provider confidence in [0, 1], when the provider supplies one. */
  confidence?: number;
}

/**
 * A validated `other` or `no_specific_topic` disposition. There is no assigned topic, so there is no topic sentiment
 * (spec.md §7.6 defines topic sentiment only toward an assigned topic; §8.7 reports these as counts/shares only).
 */
export interface UnassignedTopicDisposition {
  commentId: string;
  disposition: "other" | "no_specific_topic";
  confidence?: number;
}

/** One validated disposition per comment (single primary topic, OD-04). */
export type TopicAssignment = PrimaryTopicAssignment | UnassignedTopicDisposition;

export type TopicIssueCode =
  /** The whole output is unusable (wrong shape). */
  | "invalid_output"
  | "too_many_topics"
  | "provider_error"
  /** Topic analysis failed unexpectedly; the rest of the analysis is unaffected. */
  | "internal_error"
  /** Item-level problems: the item is dropped and reported, never repaired or guessed. */
  | "invalid_topic"
  | "duplicate_topic_key"
  | "invalid_topic_name"
  /** Taxonomy stage (AC-21): a key that is not a plain identifier. */
  | "invalid_topic_key"
  /** Taxonomy stage (AC-21): an empty definition. */
  | "missing_definition"
  /** Taxonomy stage (AC-21): two topics whose names normalise identically. */
  | "duplicate_topic_name"
  | "unknown_example_comment"
  | "invalid_assignment"
  | "unknown_comment"
  | "unknown_topic"
  | "assignment_to_dropped_topic"
  /** More than one assignment for a comment: all of them are rejected (one primary topic per comment). */
  | "multiple_primary_topics"
  /** The provider gave no disposition for an analysed comment. */
  | "missing_assignment"
  /** A successful-result invariant (one valid disposition per comment, AC-23) does not hold. */
  | "invariant_violation"
  | "excluded_comment";

/**
 * A problem found in provider output. Never contains comment text; comment IDs are included only when they belong to
 * the analysed comments, and positions (`index`) point into the provider's arrays.
 */
export interface TopicIssue {
  code: TopicIssueCode;
  /** The provider attempt (1 or 2) the issue was found in; set by topic analysis. */
  attempt?: number;
  index?: number;
  topicKey?: string;
  commentId?: string;
  detail?: string;
}

/** Validated, normalised provider output: duplicate topics collapsed, invalid items dropped and listed in `issues`. */
export interface TopicDiscoveryResult {
  topics: DiscoveredTopic[];
  /** At most one per comment, in input comment order. */
  assignments: TopicAssignment[];
  /** Analysed comments without a valid disposition (invalid, more than one, or missing), in input order. */
  rejectedCommentIds: string[];
  issues: TopicIssue[];
}

/**
 * A comment counted under its primary topic. Keeps the two sentiments apart: `topicSentiment` (toward the topic,
 * aggregated per topic) and `overallSentiment` (the classifier's label for the whole comment, carried unchanged for
 * explanation only, never aggregated here).
 */
export interface TopicMention {
  commentId: string;
  topicId: TopicId;
  role: TopicAssignmentRole;
  topicSentiment: SentimentLabel;
  overallSentiment: SentimentLabel;
  confidence?: number;
}

/**
 * Topic × sentiment over the topic's mentions, using topic sentiment: counts and integer percentages (largest
 * remainder, sum to 100) over the schema's sentiment labels. `mixed` appears as its own row only when the schema enables it; it is never
 * folded into positive or negative.
 */
export type TopicSentimentSummary = Distribution<SentimentLabel>;

/** A reference to a representative comment. The comment text stays with the evidence lifecycle (spec.md §9.7). */
export interface TopicEvidence {
  commentId: string;
  /** Sentiment toward the topic, not the comment's overall sentiment. */
  topicSentiment: SentimentLabel;
  /** 1-based position within the topic's evidence. */
  rank: number;
  confidence?: number;
  /** The provider offered this comment as an example of the topic. */
  providerExample: boolean;
}

export interface Topic {
  id: TopicId;
  name: string;
  description?: string;
  /** Sentiment-base comments whose primary topic this is. */
  mentionCount: number;
  topicSentiment: TopicSentimentSummary;
  /** mentionCount < small-sample threshold: show counts only (spec.md §8.6). */
  smallSample: boolean;
  evidence: TopicEvidence[];
  formation: TopicFormation;
}

/**
 * Final topic coverage of an available result (spec.md §8.7, AC-23): every non-spam analysed comment has exactly one
 * disposition, so namedTopics + other + noSpecificTopic = sentimentBase exactly. All Shares use base = sentimentBase.
 */
export interface TopicCoverage {
  /** Topic base B: validly classified comments that are not spam/irrelevant. Spam never enters any bucket. */
  sentimentBase: number;
  /** Spam/irrelevant comments: never sent to discovery and never counted in any bucket. */
  spamExcluded: number;
  /** Comments whose valid primary topic is a named topic (meets the minimum topic size). */
  namedTopics: Share;
  /** OTHER: provider `other` (substantive, no discovered topic fits) + comments of topics below the minimum size. */
  other: Share;
  /** NO_SPECIFIC_TOPIC: the provider's `no_specific_topic` disposition (generic comments). */
  noSpecificTopic: Share;
}

/**
 * Diagnostic accounting of one provider attempt: the coverage buckets plus comments without a valid disposition. It
 * is used to validate an attempt; a result with any rejected comment is invalid (spec.md §7.8) and never reported.
 * namedTopics + other + noSpecificTopic + assignmentRejected = sentimentBase.
 */
export interface TopicAccounting extends TopicCoverage {
  /** No valid disposition: the provider's entry was invalid, there was more than one, or there was none. */
  assignmentRejected: Share;
}

/** Discovered topics that end up with no valid mention; listed for the method record, not shown as topics. */
export interface DroppedTopic {
  id: TopicId;
  name: string;
  reason: "no_mentions";
}

/** A discovered topic merged into OTHER for being below the minimum topic size; kept so OTHER can be explained. */
export interface MergedTopic {
  id: TopicId;
  name: string;
  mentionCount: number;
}

/**
 * OTHER (spec.md §7.6, §7.7), from two origins kept apart for explanation:
 * - provider `other`: substantive comments no discovered topic covers;
 * - small topics: comments whose discovered topic is below the minimum topic size (a reportability rule; nothing is
 *   merged by meaning).
 * The report shows one OTHER share. No evidence is selected for OTHER.
 */
export interface OtherTopics {
  /** providerOther + smallTopics. */
  mentionCount: number;
  providerOther: number;
  smallTopics: number;
  /**
   * Topic sentiment of the small-topic comments only (each toward its own original topic); base = smallTopics.
   * Provider `other` comments have no topic and therefore no topic sentiment.
   */
  smallTopicSentiment: TopicSentimentSummary;
  /** The merged small topics, ordered by mention count (descending), then topic ID. */
  mergedTopics: MergedTopic[];
}

/** Combined OTHER + NO_SPECIFIC_TOPIC share above the threshold (spec.md §7.9). Structured; no prose. */
export interface HighOtherShareWarning {
  code: "HIGH_OTHER_SHARE";
  other: Share;
  noSpecificTopic: Share;
  combined: Share;
  thresholdPercent: number;
}

export type TopicWarning = HighOtherShareWarning;

export interface TopicParameters {
  /** spec.md §2.6 `max_topics`: more distinct topics than this invalidates the output. */
  maxTopics: number;
  /** spec.md §2.6 `evidence_per_topic`. */
  evidencePerTopic: number;
  smallSampleThreshold: number;
  /** spec.md §2.6 `min_topic_size` = max(minTopicSizeFloor, ceil(minTopicSizePercentOfBase% of the topic base)). */
  minTopicSizeFloor: number;
  minTopicSizePercentOfBase: number;
  /** spec.md §2.6 `other_warning_threshold`: warn when OTHER + NO_SPECIFIC_TOPIC exceeds this percentage of the base. */
  otherWarningThresholdPercent: number;
}

export interface TopicMethod {
  providerLabel: string;
  normalizationVersion: string;
  /** Comments sent to the provider (the sentiment base). */
  commentsSent: number;
  /** Provider calls made: 1, or 2 after a failed first attempt (spec.md §7.8). 0 when nothing was sent. */
  attempts: number;
  parameters: TopicParameters;
  /** How the discovery sample was drawn (spec.md §7.2, §8.3), when the discoverer samples. */
  discoverySample?: DiscoverySampleMethod;
}

/**
 * Methodology of a discovery sample: counts, strategy and parameters only. No comment IDs, text or identity.
 * The seed is a non-secret configuration value, recorded so the sample can be reproduced (spec §7.2).
 */
export interface DiscoverySampleMethod {
  /** Sampler version, e.g. `ds1`. */
  version: string;
  strategy: "seeded_stratified";
  /** Drawn only from the non-spam topic base. */
  population: "non_spam_topic_base";
  seed: string;
  /** Eligible comments considered (the topic base). */
  eligible: number;
  /** Comments sampled. */
  size: number;
  /** True when the base fitted, so every eligible comment was used. */
  usedAll: boolean;
  /** `<pool>:<overall sentiment>` composition; availables sum to `eligible`, selections to `size`. */
  strata: { key: string; available: number; selected: number }[];
  parameters: { maxSize: number; focusReservePercent: number; trivialMaxPercent: number; shortWordThreshold: number; minPerSentimentLabel: number };
}

/**
 * Structured validation feedback for the single retry (spec.md §7.8). Codes, analysed-comment IDs and topic keys
 * only: never comment text, raw provider output, provider error messages or vendor-specific fields.
 */
export interface TopicValidationFeedback {
  /** The attempt whose output failed validation. */
  attempt: number;
  /** One entry per issue code, ordered by code. */
  issues: { code: TopicIssueCode; count: number; commentIds?: string[]; topicKeys?: string[] }[];
}

/**
 * The counted disposition of one base comment, for display and drill-down only (never persisted in the report model:
 * per-comment labels are intermediate data, spec.md §11). Comments merged into OTHER from a small topic keep that
 * topic's ID in `mergedFromTopicId`; OTHER and NO_SPECIFIC_TOPIC carry no topic sentiment.
 */
export type CommentTopicLabel =
  | { commentId: string; disposition: "topic"; topicId: TopicId; topicSentiment: SentimentLabel }
  | { commentId: string; disposition: "other"; mergedFromTopicId?: TopicId }
  | { commentId: string; disposition: "no_specific_topic" };

export type TopicAnalysis =
  | {
      status: "available";
      /** Named topics: at or above the minimum topic size. */
      topics: Topic[];
      other: OtherTopics;
      /** The minimum topic size applied to this analysis. */
      minTopicSize: number;
      droppedTopics: DroppedTopic[];
      /** AC-23: namedTopics + other + noSpecificTopic = sentimentBase. No rejected bucket exists here. */
      coverage: TopicCoverage;
      warnings: TopicWarning[];
      method: TopicMethod;
      /** Every counted disposition, ordered by comment ID; view-model input only, never part of the report. */
      commentTopics: CommentTopicLabel[];
    }
  /** No topics and no topic × sentiment (spec.md §7.8); `issues` holds every attempt's diagnostics. */
  | { status: "unavailable"; reason: "TOPICS_UNAVAILABLE"; issues: TopicIssue[]; method: TopicMethod };
