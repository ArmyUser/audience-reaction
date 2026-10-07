import type { SentimentLabel } from "../../core/domain/types";
import type { TopicDiscoverer, TopicDiscoveryRequest } from "../../core/ports";
import type { TopicValidationFeedback } from "../../core/topics/types";

export interface FixtureTopic {
  key: string;
  name: string;
  description?: string;
  exampleCommentIds?: string[];
}

/**
 * A comment's topic disposition (spec.md §7.6): a discovered primary topic with the sentiment toward it (which may
 * differ from the comment's overall sentiment), `other` (substantive, no topic fits) or `no_specific_topic` (generic).
 * Only a primary topic has a topic sentiment.
 */
export type FixtureDecision =
  | { disposition: "primary_topic"; topicKey: string; topicSentiment: SentimentLabel; confidence?: number }
  | { disposition: "other"; confidence?: number }
  | { disposition: "no_specific_topic"; confidence?: number };

export interface TopicFixture {
  topics: FixtureTopic[];
  /** Explicit comment ID → its one disposition. */
  decisions: Record<string, FixtureDecision>;
  /**
   * Requested comments not listed in `decisions`: emit an explicit `no_specific_topic`, or emit nothing (a missing
   * assignment, which the engine rejects).
   */
  unlisted: "no_specific_topic" | "omit";
}

/**
 * Test-only fake: replays a hand-written comment → disposition mapping. It never reads comment text and performs no
 * discovery or sentiment analysis. Output is deterministic: topics in fixture order, assignments in request comment
 * order, and only for comments in the request (like a real provider, it can only label what it was shown).
 *
 * For retry tests it accepts one fixture per call (call n uses fixture n; the last one repeats) and records the
 * validation feedback each call received.
 */
export class FixtureTopicDiscoverer implements TopicDiscoverer {
  readonly label = "Fake topic discoverer (fixture mapping)";
  /** Feedback received per call (undefined on a first attempt). */
  readonly feedbackReceived: (TopicValidationFeedback | undefined)[] = [];
  private readonly fixtures: readonly TopicFixture[];

  constructor(fixtures: TopicFixture | readonly TopicFixture[]) {
    this.fixtures = Array.isArray(fixtures) ? fixtures : [fixtures as TopicFixture];
    if (this.fixtures.length === 0) throw new RangeError("At least one topic fixture is required");
  }

  get calls(): number {
    return this.feedbackReceived.length;
  }

  async discoverTopics(request: TopicDiscoveryRequest): Promise<unknown> {
    const fixture = this.fixtures[Math.min(this.calls, this.fixtures.length - 1)]!;
    this.feedbackReceived.push(request.feedback === undefined ? undefined : structuredClone(request.feedback));
    const assignments = request.comments.flatMap((comment) => {
      if (Object.hasOwn(fixture.decisions, comment.id)) return [{ commentId: comment.id, ...fixture.decisions[comment.id]! }];
      return fixture.unlisted === "no_specific_topic" ? [{ commentId: comment.id, disposition: "no_specific_topic" }] : [];
    });
    return { topics: fixture.topics.map((t) => ({ ...t, ...(t.exampleCommentIds ? { exampleCommentIds: [...t.exampleCommentIds] } : {}) })), assignments };
  }
}
