import type { ClassificationSchema } from "./classification/schema";
import type { CommentInput, CommentType, FocusTarget, SentimentLabel, SourceOrigin } from "./domain/types";
import type { TopicModelRequest } from "./topics/provider-contracts";
import type { DiscoverySampleMethod, TopicValidationFeedback } from "./topics/types";

/** Supplies top-level comments for a video. Implemented by adapters (fixtures now; YouTube later). */
export interface CommentSource {
  readonly label: string;
  /** Drives compliance policy decisions (e.g. CG-1 for "youtube"). */
  readonly origin: SourceOrigin;
  listComments(videoId: string): Promise<CommentInput[]>;
}

export interface ClassificationRequest {
  comments: readonly CommentInput[];
  schema: ClassificationSchema;
  focus?: FocusTarget;
}

/**
 * Classifies comments. Implemented by adapters (fakes, LLM providers, other classifiers). The return value is deliberately
 * `unknown`: provider output is untrusted and is always parsed by the engine (classification/validation.ts).
 * Expected shape: `{ results: CommentClassification[] }`.
 */
export interface Classifier {
  readonly label: string;
  classify(request: ClassificationRequest): Promise<unknown>;
}

/** A comment shown to topic discovery. Text is untrusted input. */
export interface TopicDiscoveryComment {
  id: string;
  text: string;
  /**
   * The existing classification, for discovery sampling only (spec §7.2 strata). Set by topic analysis; a provider
   * workflow must not forward it to a model (topic names stay sentiment-neutral, spec §7.4, §S5).
   */
  classification?: TopicSamplingLabels;
}

/** Classification facts the discovery sample is stratified on. Never commenter identity or engagement. */
export interface TopicSamplingLabels {
  type: CommentType;
  sentiment: SentimentLabel;
  focusMentioned: boolean;
}

export interface TopicDiscoveryContext {
  focus?: FocusTarget;
  /** Allowed topic-sentiment labels: the analysis schema's sentiment labels. */
  sentimentLabels: readonly SentimentLabel[];
  /** Upper bound on distinct topics; output above it is rejected. */
  maxTopics: number;
}

export interface TopicDiscoveryRequest {
  /** Sentiment-base comments only: spam/irrelevant comments are never sent. */
  comments: readonly TopicDiscoveryComment[];
  context: TopicDiscoveryContext;
  /**
   * Present only on the single retry (spec.md §7.8): structured validation feedback on the previous attempt (codes,
   * analysed-comment IDs, topic keys). Never contains comment text, raw provider output or error messages.
   */
  feedback?: TopicValidationFeedback;
  /**
   * Opaque identity of one topic analysis, the same on both attempts: lets a stateful discoverer keep retry state
   * per analysis when one instance serves several at once. Not derived from comment text; never persisted; a
   * discoverer must not forward it to a model.
   */
  run?: { id: string; attempt: number };
}

/**
 * Discovers topics and gives every comment exactly one disposition (spec.md §7.6): a discovered primary topic with the
 * sentiment toward it, `other` (substantive, but no discovered topic fits) or `no_specific_topic` (generic). Implemented
 * by adapters (a fixture fake now; model-based providers later). Like the classifier, the return value is `unknown` and
 * always parsed by the engine (topics/validation.ts). Expected shape:
 * `{ topics: { key, name, description?, exampleCommentIds? }[],
 *    assignments: ({ commentId, disposition: "primary_topic", topicKey, topicSentiment, confidence? }
 *                | { commentId, disposition: "other" | "no_specific_topic", confidence? })[] }`
 * with exactly one entry per comment; a comment without an entry is rejected, never assumed generic. Any invalid item
 * makes the whole attempt invalid; after one retry with `feedback`, topics are unavailable.
 */
export interface TopicDiscoverer {
  readonly label: string;
  discoverTopics(request: TopicDiscoveryRequest): Promise<unknown>;
  /**
   * Optional. Called exactly once when a topic analysis ends (available, unavailable or failed): releases any state
   * kept for `runId` and returns provider-neutral methodology for the method record.
   */
  finishRun?(runId: string): TopicDiscoveryRunInfo | undefined;
}

export interface TopicDiscoveryRunInfo {
  discoverySample?: DiscoverySampleMethod;
}

// Two-phase topic provider roles (design: m4-topic-provider-design.md). A future two-phase TopicDiscoverer composes
// them: discovery proposes a taxonomy from the discovery sample (Generator role, spec §S5); assignment gives every
// eligible comment one disposition against the validated taxonomy (Classifier role, spec §S6). Not implemented yet.

export interface TopicTaxonomyRequest {
  /** The discovery sample (spec §7.2), at most `discovery_sample_size` comments. */
  sample: readonly TopicDiscoveryComment[];
  context: TopicDiscoveryContext;
  /** Present only when redoing discovery after a taxonomy-stage failure. */
  feedback?: TopicValidationFeedback;
}

export interface TopicTaxonomyGenerator {
  readonly label: string;
  /**
   * Untrusted; validated as a whole by validateTopicTaxonomy (topics/taxonomy.ts). Expected shape:
   * `{ topics: { key, name, definition, exampleCommentIds? }[] }`.
   */
  proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown>;
}

export interface TopicAssignmentRequest {
  /** Every eligible (non-spam) comment, or the subset being redone after assignment feedback. */
  comments: readonly TopicDiscoveryComment[];
  /** The validated taxonomy: provider keys, normalised names and definitions only. */
  taxonomy: readonly { key: string; name: string; definition: string }[];
  context: TopicDiscoveryContext;
  /** Present only when redoing assignment after assignment-stage feedback. */
  feedback?: TopicValidationFeedback;
}

export interface TopicAssigner {
  readonly label: string;
  /**
   * Untrusted; one entry per requested comment in the TopicDiscoverer assignment shape
   * (`{ commentId, disposition, topicKey?, topicSentiment?, confidence? }`), validated by validateTopicAttempt.
   */
  assignTopics(request: TopicAssignmentRequest): Promise<unknown[]>;
}

/**
 * Reaches a model for one topic phase (topic-provider-contracts-v1.md): receives a rendered provider-neutral request
 * (core/topics/provider-contracts.ts) and returns the model's raw response text, unaltered. Implemented by adapters
 * (a deterministic replay transport now; vendor transports later). Parsing and validation never happen here.
 */
export interface TopicModelTransport {
  readonly label: string;
  complete(request: TopicModelRequest): Promise<string>;
}
