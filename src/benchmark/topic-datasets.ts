import { readFileSync } from "node:fs";
import { assertValidInput } from "../core/aggregation/aggregate";
import { createFocusMatcher } from "../core/classification/focus-matcher";
import { createClassificationSchema, type ClassificationSchema } from "../core/classification/schema";
import type { ClassifiedComment, CommentClassification, FocusMentionType, FocusTarget, SentimentLabel } from "../core/domain/types";
import { DEFAULT_TOPIC_PARAMETERS } from "../core/topics/aggregate-topics";
import { validateTopicTaxonomy } from "../core/topics/taxonomy";
import { datasetVersion } from "./datasets";

// Registry of topic benchmark datasets, separate from the classifier benchmark registry (datasets.ts), so the Jev
// benchmark and its datasets are unaffected. Synthetic fixtures written for this project (never YouTube data).
// - t1-topics-v1: ~200 comments with a gold taxonomy, one gold topic disposition per non-spam comment and the
//   sentiment toward its primary topic; lexically audited (fixtures/t1-topics-v1/leakage-audit.json).
// - t2-topics-v1: ~200 comments, independent validation set authored separately from t1 (different product domain,
//   comments, taxonomy and gold; same schema and gold semantics); independence audit in
//   fixtures/t2-topics-v1/leakage-audit.json.
// - t3-topics-v1: ~200 comments, final hold-out set authored separately from t1 and t2 (another product domain,
//   comments, taxonomy and gold; same schema and gold semantics); independence audit in
//   fixtures/t3-topics-v1/leakage-audit.json.
// - t4-topics-v1: ~200 comments, pre-registered hold-out for the topic-consolidation-v4 experiment, authored
//   separately from t1-t3 (another product domain, comments, taxonomy and gold; same schema and gold semantics);
//   independence audit in fixtures/t4-topics-v1/leakage-audit.json.
// - t5-topics-v1: ~200 comments, hold-out for a later paired consolidation comparison, authored separately from
//   t1-t4 (another product domain, comments, taxonomy and gold; same schema and gold semantics); independence audit
//   in fixtures/t5-topics-v1/leakage-audit.json.

export const TOPIC_BENCHMARK_DATASETS = {
  "t1-topics-v1": "fixtures/t1-topics-v1/comments.json",
  "t2-topics-v1": "fixtures/t2-topics-v1/comments.json",
  "t3-topics-v1": "fixtures/t3-topics-v1/comments.json",
  "t4-topics-v1": "fixtures/t4-topics-v1/comments.json",
  "t5-topics-v1": "fixtures/t5-topics-v1/comments.json",
} as const;

export type TopicBenchmarkDatasetId = keyof typeof TOPIC_BENCHMARK_DATASETS;

export function isTopicBenchmarkDatasetId(value: string): value is TopicBenchmarkDatasetId {
  return Object.hasOwn(TOPIC_BENCHMARK_DATASETS, value);
}

/** A gold concept: stable key, reference name (valid after tn1 normalisation) and definition. */
export interface GoldTopic {
  key: string;
  name: string;
  definition: string;
  /** Alternative names a discoverer might reasonably use. Informational only: matching never uses names. */
  acceptedNames: string[];
}

/** Gold topic disposition of a non-spam comment. No rejected state exists in gold. */
export type GoldTopicDisposition =
  | { disposition: "primary_topic"; topicKey: string; topicSentiment: SentimentLabel }
  | { disposition: "other" }
  | { disposition: "no_specific_topic" };

export interface TopicBenchmarkComment {
  id: string;
  text: string;
  /** Slice tags (strong, borderline, sentiment_diverges, prompt_injection, spam, …). */
  tags: string[];
  /** Overall classification (oracle input for sampling and aggregation). */
  classification: Omit<CommentClassification, "commentId">;
  focusMention: FocusMentionType;
  /** Null exactly for spam/irrelevant comments, which stay outside the topic base. */
  topic: GoldTopicDisposition | null;
}

export interface TopicBenchmarkDataset {
  id: string;
  version: string;
  description: string;
  schema: ClassificationSchema;
  focus: FocusTarget;
  taxonomy: GoldTopic[];
  comments: TopicBenchmarkComment[];
}

/** Loads a topic dataset relative to the working directory (the repository root for the CLI and tests). */
export function loadTopicBenchmarkDataset(id: TopicBenchmarkDatasetId): TopicBenchmarkDataset {
  return parseTopicBenchmarkDataset(readFileSync(TOPIC_BENCHMARK_DATASETS[id], "utf8"), id);
}

/**
 * Parses and checks a topic dataset; throws listing every problem. Checks: shape; unique IDs and texts; the dataset
 * ID; valid classifications for the declared schema (the engine's own input check); focus mention types consistent
 * with the engine's focus matcher; gold null exactly for spam; gold keys in the taxonomy and topic sentiments in the
 * schema; every gold topic used; the gold taxonomy passing the production AC-21 taxonomy validation.
 */
export function parseTopicBenchmarkDataset(fileText: string, expectedId: string): TopicBenchmarkDataset {
  const raw = JSON.parse(fileText) as Record<string, unknown>;
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  if (raw.datasetId !== expectedId) fail(`datasetId is ${String(raw.datasetId)}, expected ${expectedId}`);
  const schemaOptions = raw.schema as { mixedEnabled?: unknown; focusConfigured?: unknown } | undefined;
  if (typeof schemaOptions?.mixedEnabled !== "boolean" || schemaOptions.focusConfigured !== true) fail("schema must be { mixedEnabled: boolean, focusConfigured: true }");
  const schema = createClassificationSchema({ mixedEnabled: schemaOptions?.mixedEnabled === true, focusConfigured: true });
  const focus = raw.focus as FocusTarget;
  if (typeof focus?.name !== "string" || !Array.isArray(focus.aliases)) fail("focus must be a focus target");
  const taxonomy = (Array.isArray(raw.taxonomy) ? raw.taxonomy : []) as GoldTopic[];
  const comments = (Array.isArray(raw.comments) ? raw.comments : []) as TopicBenchmarkComment[];
  if (taxonomy.length === 0 || comments.length === 0) fail("taxonomy and comments must be non-empty arrays");

  const keys = new Set<string>();
  for (const t of taxonomy) {
    if (typeof t.key !== "string" || typeof t.name !== "string" || typeof t.definition !== "string" || !Array.isArray(t.acceptedNames)) fail(`malformed gold topic ${JSON.stringify(t.key)}`);
    if (keys.has(t.key)) fail(`duplicate gold topic key ${t.key}`);
    keys.add(t.key);
  }

  const ids = new Set<string>();
  const texts = new Set<string>();
  const used = new Set<string>();
  const matches = typeof focus?.name === "string" ? createFocusMatcher(focus) : () => false;
  for (const c of comments) {
    if (typeof c.id !== "string" || typeof c.text !== "string" || !Array.isArray(c.tags) || c.tags.length === 0) {
      fail(`malformed comment ${JSON.stringify(c.id)}`);
      continue;
    }
    if (ids.has(c.id)) fail(`duplicate id ${c.id}`);
    if (texts.has(c.text)) fail(`duplicate text in ${c.id}`);
    ids.add(c.id);
    texts.add(c.text);
    const spam = c.classification?.type === "spam_irrelevant";
    if (spam !== (c.topic === null)) fail(`${c.id}: gold topic must be null exactly for spam/irrelevant comments`);
    const explicit = matches(c.text);
    const addressed = c.classification?.targets?.focus !== "not_addressed";
    const expectedMention: FocusMentionType = explicit ? "explicit" : addressed ? "inferred" : "none";
    if (c.focusMention !== expectedMention) fail(`${c.id}: focusMention ${c.focusMention}, expected ${expectedMention}`);
    if (c.topic === null) continue;
    const d = c.topic.disposition;
    if (d === "primary_topic") {
      const { topicKey, topicSentiment } = c.topic as { topicKey: unknown; topicSentiment: unknown };
      if (typeof topicKey !== "string" || !keys.has(topicKey)) fail(`${c.id}: unknown gold topic ${String(topicKey)}`);
      else used.add(topicKey);
      if (!schema.sentimentLabels.includes(topicSentiment as SentimentLabel)) fail(`${c.id}: topic sentiment ${String(topicSentiment)} outside the schema`);
      if (Object.keys(c.topic).length !== 3) fail(`${c.id}: unexpected gold fields`);
    } else if (d === "other" || d === "no_specific_topic") {
      if (Object.keys(c.topic).length !== 1) fail(`${c.id}: ${d} carries a topic or topic sentiment`);
    } else {
      fail(`${c.id}: unknown disposition ${String(d)}`);
    }
  }
  for (const k of keys) if (!used.has(k)) fail(`gold topic ${k} has no comments`);

  if (problems.length === 0) {
    try {
      assertValidInput(toClassified(comments, true), schema);
    } catch (error) {
      fail(`invalid classification: ${(error as Error).message}`);
    }
    const base = comments.filter((c) => c.topic !== null).map((c) => c.id);
    const gold = validateTopicTaxonomy({ topics: taxonomy.map(({ key, name, definition }) => ({ key, name, definition })) }, { sampleCommentIds: base, maxTopics: DEFAULT_TOPIC_PARAMETERS.maxTopics });
    if (gold.status === "invalid") fail(`gold taxonomy fails AC-21: ${gold.issues.map((i) => i.code).join(", ")}`);
  }
  if (problems.length > 0) throw new Error(`Invalid topic dataset ${expectedId}:\n- ${problems.join("\n- ")}`);

  return { id: expectedId, version: datasetVersion(fileText), description: String(raw.description ?? ""), schema, focus, taxonomy, comments };
}

/** The dataset's comments as validly classified input for analyzeTopics (spam included; the engine excludes it). */
export function classifiedCommentsOf(dataset: TopicBenchmarkDataset): ClassifiedComment[] {
  return toClassified(dataset.comments, dataset.schema.focusConfigured);
}

function toClassified(comments: readonly TopicBenchmarkComment[], focusConfigured: boolean): ClassifiedComment[] {
  return comments.map((c) => ({
    comment: { id: c.id, text: c.text },
    classification: { commentId: c.id, ...structuredClone(c.classification) },
    ...(focusConfigured ? { focusMention: c.focusMention } : {}),
  }));
}

/** Gold views used by the harness and the oracle providers. */
export interface TopicGold {
  /** Non-spam comment IDs (the topic base), in dataset order. */
  baseIds: string[];
  dispositions: ReadonlyMap<string, GoldTopicDisposition>;
  /** Gold key → member comment IDs, in dataset order. */
  members: ReadonlyMap<string, string[]>;
  overallSentiment: ReadonlyMap<string, SentimentLabel>;
}

export function goldOf(dataset: TopicBenchmarkDataset): TopicGold {
  const dispositions = new Map<string, GoldTopicDisposition>();
  const members = new Map<string, string[]>(dataset.taxonomy.map((t) => [t.key, []]));
  const overallSentiment = new Map<string, SentimentLabel>();
  const baseIds: string[] = [];
  for (const c of dataset.comments) {
    if (c.topic === null) continue;
    baseIds.push(c.id);
    dispositions.set(c.id, c.topic);
    overallSentiment.set(c.id, c.classification.sentiment);
    if (c.topic.disposition === "primary_topic") members.get(c.topic.topicKey)!.push(c.id);
  }
  return { baseIds, dispositions, members, overallSentiment };
}
