import { z } from "zod";
import { isValidNormalizedTopicName, normalizeTopicName, topicIdOf } from "./normalize";
import type { SentimentLabel } from "../domain/types";
import type { DiscoveredTopic, TopicAssignment, TopicDiscoveryResult, TopicId, TopicIssue } from "./types";

export class TopicDiscoveryOutputError extends Error {
  override readonly name = "TopicDiscoveryOutputError";
  constructor(readonly issues: TopicIssue[]) {
    super(`Invalid topic discovery output: ${issues.map((i) => i.code).join(", ")}`);
  }
}

// Expected raw provider shape. Nothing is coerced.
const outputSchema = z.strictObject({ topics: z.array(z.unknown()), assignments: z.array(z.unknown()) });
const topicItem = z.strictObject({
  key: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  exampleCommentIds: z.array(z.string()).optional(),
});
const confidence = z.number().min(0).max(1).optional();
/** One entry per comment. Only `primary_topic` has a topic and a topic sentiment; nothing is inferred. */
const assignmentItem = (sentimentLabels: readonly SentimentLabel[]) =>
  z.discriminatedUnion("disposition", [
    z.strictObject({
      commentId: z.string().min(1),
      disposition: z.literal("primary_topic"),
      topicKey: z.string().min(1),
      /** Sentiment toward the assigned topic; same labels as the classification schema (no new taxonomy). */
      topicSentiment: z.enum(sentimentLabels as [SentimentLabel, ...SentimentLabel[]]),
      confidence,
    }),
    z.strictObject({ commentId: z.string().min(1), disposition: z.literal("other"), confidence }),
    z.strictObject({ commentId: z.string().min(1), disposition: z.literal("no_specific_topic"), confidence }),
  ]);

export interface TopicOutputOptions {
  maxTopics: number;
  /** The analysis schema's sentiment labels: `mixed` is accepted as topic sentiment only when the schema enables it. */
  sentimentLabels: readonly SentimentLabel[];
}

export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Validates and normalises raw provider output against the exact comments sent to the provider.
 * - Wrong overall shape, or more distinct topics than `maxTopics`: throws TopicDiscoveryOutputError.
 * - Invalid items are dropped and reported in `issues`; nothing is repaired or guessed.
 * - Topics whose names normalise to the same name collapse into one topic; the first non-empty description wins.
 * - One disposition per comment (spec.md §7.6): `primary_topic` (with topic sentiment), `other` or
 *   `no_specific_topic` (neither has a topic sentiment). A comment with more than one entry (even repeating the same
 *   topic) has all of them rejected, since none can be chosen without guessing. A comment whose single entry is
 *   invalid, or that has no entry at all, is rejected too. Rejected comments are listed, never silently treated as
 *   `other` or `no_specific_topic`.
 * Assignments and rejected comments are ordered by input comment order.
 */
export function parseTopicDiscoveryOutput(raw: unknown, commentIds: readonly string[], options: TopicOutputOptions): TopicDiscoveryResult {
  const top = outputSchema.safeParse(raw);
  if (!top.success) {
    throw new TopicDiscoveryOutputError([
      { code: "invalid_output", detail: top.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") },
    ]);
  }

  const issues: TopicIssue[] = [];
  const order = new Map(commentIds.map((id, index) => [id, index]));
  const idByKey = new Map<string, TopicId>();
  const droppedKeys = new Set<string>();
  const topics = new Map<TopicId, DiscoveredTopic>();

  top.data.topics.forEach((item, index) => {
    const parsed = topicItem.safeParse(item);
    if (!parsed.success) return void issues.push({ code: "invalid_topic", index });
    const { key, name, description, exampleCommentIds } = parsed.data;
    if (idByKey.has(key) || droppedKeys.has(key)) return void issues.push({ code: "duplicate_topic_key", index, topicKey: key });
    const normalized = normalizeTopicName(name);
    if (!isValidNormalizedTopicName(normalized)) {
      droppedKeys.add(key);
      return void issues.push({ code: "invalid_topic_name", index, topicKey: key });
    }

    const id = topicIdOf(normalized);
    idByKey.set(key, id);
    let topic = topics.get(id);
    if (!topic) {
      topic = { id, name: normalized, formation: { sourceNames: [], providerKeys: [], providerExampleIds: [] } };
      topics.set(id, topic);
    }
    topic.formation.sourceNames.push(name);
    topic.formation.providerKeys.push(key);
    const trimmed = description?.trim();
    if (trimmed && topic.description === undefined) topic.description = trimmed;
    for (const exampleId of exampleCommentIds ?? []) {
      // Unknown IDs are not echoed: they are untrusted provider strings.
      if (!order.has(exampleId)) issues.push({ code: "unknown_example_comment", index, topicKey: key });
      else if (!topic.formation.providerExampleIds.includes(exampleId)) topic.formation.providerExampleIds.push(exampleId);
    }
  });

  if (topics.size > options.maxTopics) {
    throw new TopicDiscoveryOutputError([...issues, { code: "too_many_topics", detail: `${topics.size} distinct topics; maximum ${options.maxTopics}` }]);
  }

  // Pass 1: attribute each entry to an analysed comment (without trusting the rest of the entry yet).
  const entriesByComment = new Map<string, number[]>();
  top.data.assignments.forEach((item, index) => {
    const commentId = typeof item === "object" && item !== null && "commentId" in item ? (item as { commentId: unknown }).commentId : undefined;
    if (typeof commentId !== "string" || commentId === "") return void issues.push({ code: "invalid_assignment", index });
    if (!order.has(commentId)) return void issues.push({ code: "unknown_comment", index });
    const entries = entriesByComment.get(commentId);
    if (entries) entries.push(index);
    else entriesByComment.set(commentId, [index]);
  });

  // Pass 2: exactly one valid entry per comment becomes its primary topic.
  const item = assignmentItem(options.sentimentLabels);
  const assignments: TopicAssignment[] = [];
  const rejected = new Set<string>();
  for (const [commentId, indexes] of entriesByComment) {
    const reject = (issue: TopicIssue) => {
      rejected.add(commentId);
      issues.push(issue);
    };
    if (indexes.length > 1) {
      reject({ code: "multiple_primary_topics", commentId, detail: `${indexes.length} assignments (indexes ${indexes.join(", ")})` });
      continue;
    }
    const index = indexes[0]!;
    const parsed = item.safeParse(top.data.assignments[index]);
    if (!parsed.success) {
      reject({ code: "invalid_assignment", index, commentId });
      continue;
    }
    if (parsed.data.disposition !== "primary_topic") {
      const { disposition, confidence } = parsed.data;
      assignments.push(confidence === undefined ? { commentId, disposition } : { commentId, disposition, confidence });
      continue;
    }
    const { topicKey, topicSentiment, confidence } = parsed.data;
    if (droppedKeys.has(topicKey)) {
      reject({ code: "assignment_to_dropped_topic", index, topicKey, commentId });
      continue;
    }
    const topicId = idByKey.get(topicKey);
    if (topicId === undefined) {
      reject({ code: "unknown_topic", index, topicKey, commentId });
      continue;
    }
    const disposition = "primary_topic";
    assignments.push(confidence === undefined ? { commentId, disposition, topicId, topicSentiment } : { commentId, disposition, topicId, topicSentiment, confidence });
  }
  for (const commentId of commentIds) {
    if (entriesByComment.has(commentId)) continue;
    rejected.add(commentId);
    issues.push({ code: "missing_assignment", commentId });
  }

  const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!;
  return {
    topics: [...topics.values()],
    assignments: assignments.sort((a, b) => byOrder(a.commentId, b.commentId)),
    rejectedCommentIds: [...rejected].sort(byOrder),
    issues,
  };
}
