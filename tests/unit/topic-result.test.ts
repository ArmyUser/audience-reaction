import { describe, expect, it } from "vitest";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { aggregateTopics } from "../../src/core/topics/aggregate-topics";
import { invariantViolations, toValidationFeedback, validateTopicAttempt } from "../../src/core/topics/topic-result";
import type { TopicAccounting, TopicAssignment, TopicDiscoveryResult } from "../../src/core/topics/types";
import { classified } from "../topic-helpers";

const schema = createClassificationSchema({ focusConfigured: false });
const base = [classified("k1", "positive"), classified("k2", "negative")];
const params = { maxTopics: 12, evidencePerTopic: 3, smallSampleThreshold: 30, minTopicSizeFloor: 1, minTopicSizePercentOfBase: 1, otherWarningThresholdPercent: 35 };
const topic = { id: "topic:audio", name: "audio", formation: { sourceNames: ["Audio"], providerKeys: ["key1"], providerExampleIds: [] } };
const discovery = (assignments: TopicAssignment[]): TopicDiscoveryResult => ({ topics: [topic], assignments, rejectedCommentIds: [], issues: [] });
const good: TopicAssignment[] = [
  { commentId: "k1", disposition: "primary_topic", topicId: "topic:audio", topicSentiment: "negative" },
  { commentId: "k2", disposition: "no_specific_topic" },
];
const accounting = (d: TopicDiscoveryResult): TopicAccounting => aggregateTopics(d, base, schema, params).coverage;
const details = (d: TopicDiscoveryResult, c: TopicAccounting = accounting(d)) => invariantViolations(d, c, base, schema).map((i) => i.detail);

describe("successful-result invariants", () => {
  it("hold for a complete, consistent result", () => {
    expect(details(discovery(good))).toEqual([]);
  });

  it("catch a missing disposition, a duplicate, an undiscovered topic and topic sentiment on other", () => {
    expect(details(discovery([good[0]!]))).toContain("not every eligible comment has exactly one disposition");
    const dup = discovery([...good, good[1]!]);
    expect(details(dup, accounting(discovery(good)))).toContain("more than one disposition for a comment");
    expect(details(discovery([{ ...good[0]!, topicId: "topic:nope" } as TopicAssignment, good[1]!]), accounting(discovery(good)))).toContain(
      "primary topic is not a discovered topic",
    );
    const withSentiment = { commentId: "k2", disposition: "other", topicSentiment: "positive" } as unknown as TopicAssignment;
    expect(details(discovery([good[0]!, withSentiment]))).toContain("other/no_specific_topic carries a topic or topic sentiment");
  });

  it("catch rejected comments and coverage that does not sum to the base (AC-23)", () => {
    const d = discovery(good);
    const c = accounting(d);
    expect(details(d, { ...c, assignmentRejected: { count: 1, base: 2, percent: 50 } })).toContain("rejected assignments in a result");
    expect(details(d, { ...c, noSpecificTopic: { count: 0, base: 2, percent: 0 } })).toContain("coverage does not sum to the topic base");
    expect(details(d, { ...c, other: { count: 0, base: 3, percent: 0 } })).toContain("a coverage share is not over the topic base");
  });

  it("a valid attempt reports the final coverage without a rejected bucket", () => {
    const raw = {
      topics: [{ key: "key1", name: "Audio" }],
      assignments: [
        { commentId: "k1", disposition: "primary_topic", topicKey: "key1", topicSentiment: "negative" },
        { commentId: "k2", disposition: "no_specific_topic" },
      ],
    };
    const result = validateTopicAttempt(raw, base, schema, params);
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.coverage).toEqual({
      sentimentBase: 2,
      spamExcluded: 0,
      namedTopics: { count: 1, base: 2, percent: 50 },
      other: { count: 0, base: 2, percent: 0 },
      noSpecificTopic: { count: 1, base: 2, percent: 50 },
    });
  });
});

describe("validation feedback", () => {
  it("groups by code in code order, keeps only analysed-comment IDs (input order) and identifier-like keys", () => {
    expect(
      toValidationFeedback(
        1,
        [
          { code: "unknown_topic", commentId: "k2", topicKey: "has spaces in it" },
          { code: "unknown_topic", commentId: "k1", topicKey: "topic-9" },
          { code: "missing_assignment", commentId: "k2" },
          { code: "invalid_assignment", index: 3, detail: "free text that must not travel" },
          { code: "unknown_example_comment", commentId: "not analysed" },
        ],
        ["k1", "k2"],
      ),
    ).toEqual({
      attempt: 1,
      issues: [
        { code: "invalid_assignment", count: 1 },
        { code: "missing_assignment", count: 1, commentIds: ["k2"] },
        { code: "unknown_example_comment", count: 1 },
        { code: "unknown_topic", count: 2, commentIds: ["k1", "k2"], topicKeys: ["topic-9"] },
      ],
    });
  });
});
