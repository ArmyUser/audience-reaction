import type { SentimentLabel } from "../domain/types";
import { compareIds } from "./validation";
import type { TopicEvidence, TopicMention } from "./types";

/**
 * Deterministic evidence references for one topic (spec.md §9.2, without likes or seeded randomness, which the
 * current comment model does not support):
 * 1. sentiment groups are visited in order of their count in the topic (descending), ties by schema label order, so
 *    evidence reflects the topic's distribution and every present label gets a slot before any label gets a second;
 * 2. slots are filled round-robin across groups until `limit` is reached or candidates run out;
 * 3. within a group: higher confidence first (missing confidence last), then provider examples, then comment ID
 *    (code-point order) as the final, stable tie-break.
 * Groups use topic sentiment (toward the topic), not the comment's overall sentiment. Only comment IDs are returned;
 * the comment text stays with the evidence lifecycle.
 */
export function selectTopicEvidence(
  mentions: readonly TopicMention[],
  sentimentLabels: readonly SentimentLabel[],
  providerExampleIds: readonly string[],
  limit: number,
): TopicEvidence[] {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`Invalid evidence limit ${limit}`);
  const examples = new Set(providerExampleIds);
  const byConfidence = (c: number | undefined) => c ?? -1;

  const groups = sentimentLabels
    .map((label, labelIndex) => ({
      labelIndex,
      queue: mentions
        .filter((m) => m.topicSentiment === label)
        .sort(
          (a, b) =>
            byConfidence(b.confidence) - byConfidence(a.confidence) ||
            Number(examples.has(b.commentId)) - Number(examples.has(a.commentId)) ||
            compareIds(a.commentId, b.commentId),
        ),
    }))
    .filter((g) => g.queue.length > 0)
    .sort((a, b) => b.queue.length - a.queue.length || a.labelIndex - b.labelIndex);

  const picked: TopicMention[] = [];
  for (let round = 0; picked.length < limit; round++) {
    const available = groups.filter((g) => g.queue.length > round);
    if (available.length === 0) break;
    for (const g of available) {
      if (picked.length >= limit) break;
      picked.push(g.queue[round]!);
    }
  }

  return picked.map((m, i) => ({
    commentId: m.commentId,
    topicSentiment: m.topicSentiment,
    rank: i + 1,
    ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
    providerExample: examples.has(m.commentId),
  }));
}
