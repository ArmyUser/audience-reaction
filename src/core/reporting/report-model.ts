import type { AggregateMetrics } from "../aggregation/aggregate";
import type { Distribution, Share } from "../aggregation/distribution";
import type { FocusTarget, SentimentLabel, SourceOrigin } from "../domain/types";
import type { TopicCoverage, TopicEvidence, TopicId, TopicIssueCode, TopicMethod, TopicWarning } from "../topics/types";

// Report model (spec.md §8). Long-lived parts contain no comment text, commenter identity or video title
// (spec.md §11.0). Topics, evidence and synthesis are typed now and produced from M4/M7/M8 on.

/** A named topic. Shares use base = the topic base (non-spam analysed comments); sentiment is topic sentiment. */
export interface TopicSummary {
  id: TopicId;
  /** Normalised topic name (Category B; never comment text). */
  name: string;
  description?: string;
  count: Share;
  topicSentiment: Distribution<SentimentLabel>;
  smallSample: boolean;
  /** Evidence by comment ID only; text is rendered from the evidence lifecycle (spec.md §9.7). */
  evidence: TopicEvidence[];
}

/**
 * OTHER (one user-facing share) with its provenance: provider `other` (substantive, no discovered topic fits) and
 * comments of topics below the minimum topic size. All Shares use base = the topic base.
 */
export interface OtherTopicsSummary {
  count: Share;
  providerOther: Share;
  smallTopics: Share;
  /** Topic sentiment of the small-topic comments only (base = smallTopics.count); provider `other` has none. */
  smallTopicSentiment: Distribution<SentimentLabel>;
  /** Normalised names (and IDs) of the merged topics, for the methodology note (spec.md §7.7). */
  mergedTopics: { id: TopicId; name: string; mentionCount: number }[];
}

export interface TopicIssueCount {
  /** The provider attempt the issues were found in. */
  attempt: number;
  code: TopicIssueCode;
  count: number;
}

export type TopicsSection =
  | { status: "not_run" }
  /**
   * Discovery failed or returned invalid output twice (spec.md §7.8): no topics and no topic × sentiment; the rest of
   * the report is unaffected. Diagnostics are counts per attempt and code only (no provider content).
   */
  | { status: "unavailable"; reason: "TOPICS_UNAVAILABLE"; issues: TopicIssueCount[]; method: TopicMethod }
  /** AC-23: topic shares + OTHER + NO_SPECIFIC_TOPIC = 100% of the topic base (counts sum exactly). */
  | {
      status: "available";
      topics: TopicSummary[];
      other: OtherTopicsSummary;
      noSpecificTopic: Share;
      coverage: TopicCoverage;
      minTopicSize: number;
      warnings: TopicWarning[];
      method: TopicMethod;
    };

/** Evidence quotes are source data with their own lifecycle (spec.md §9.7); referenced, not embedded. */
export interface EvidenceRef {
  id: string;
  commentId: string;
  section: string;
  state: "active" | "refresh_due" | "removed" | "expired";
}

export type EvidenceSection = { status: "not_run" } | { status: "available"; items: EvidenceRef[] };

export interface SynthesisPart {
  key: string;
  text: string;
  citedMetricKeys: string[];
  citedEvidenceIds: string[];
}

export type SynthesisSection =
  | { status: "not_run" }
  | { status: "unavailable"; reason: "SYNTHESIS_UNAVAILABLE" }
  | { status: "available"; parts: SynthesisPart[] };

export interface Methodology {
  schemaVersion: string;
  guidelineVersion: string;
  sentimentLabels: readonly SentimentLabel[];
  mixedCandidateEnabled: boolean;
  sourceLabel: string;
  sourceOrigin: SourceOrigin;
  classifierLabel: string;
  sampling: string;
  representativenessNote: string;
  policyNote: string;
}

export interface ReportModel {
  videoId: string;
  focus?: FocusTarget;
  metrics: AggregateMetrics;
  topics: TopicsSection;
  evidence: EvidenceSection;
  synthesis: SynthesisSection;
  methodology: Methodology;
}

export const REPRESENTATIVENESS_NOTE =
  "Figures describe the analysed comments, not the video's entire audience. Commenters are a self-selected subset of " +
  "viewers, and the analysed comments are not a statistically representative sample of the audience.";
