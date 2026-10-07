import { describe, expect, it } from "vitest";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { ClassificationOutputError } from "../../src/core/classification/validation";
import type { SentimentLabel } from "../../src/core/domain/types";
import { aggregateTopics, DEFAULT_TOPIC_PARAMETERS, type TopicAggregationParameters } from "../../src/core/topics/aggregate-topics";
import { selectTopicEvidence } from "../../src/core/topics/evidence";
import type { DiscoveredTopic, PrimaryTopicAssignment, TopicAssignment, TopicDiscoveryResult, TopicMention } from "../../src/core/topics/types";
import { classified, spam } from "../topic-helpers";

const schema = createClassificationSchema({ focusConfigured: false });
const mixedSchema = createClassificationSchema({ focusConfigured: false, mixedEnabled: true });

/** These tests exercise counting with tiny topics, so the minimum topic size floor is 1 (tested separately). */
const agg = (d: TopicDiscoveryResult, c: Parameters<typeof aggregateTopics>[1], sch = schema, p: Partial<TopicAggregationParameters> = {}) =>
  aggregateTopics(d, c, sch, { ...DEFAULT_TOPIC_PARAMETERS, minTopicSizeFloor: 1, ...p });

const idOf = (name: string) => `topic:${name.replaceAll(" ", "-")}`;
function topic(name: string, providerExampleIds: string[] = []): DiscoveredTopic {
  return { id: idOf(name), name, formation: { sourceNames: [name], providerKeys: [name], providerExampleIds } };
}
const assign = (commentId: string, name: string, topicSentiment: SentimentLabel, confidence?: number): PrimaryTopicAssignment => ({
  commentId,
  disposition: "primary_topic",
  topicId: idOf(name),
  topicSentiment,
  ...(confidence !== undefined ? { confidence } : {}),
});
/** A generic comment (spec NO_SPECIFIC_TOPIC). */
const generic = (commentId: string): TopicAssignment => ({ commentId, disposition: "no_specific_topic" });
const discovery = (topics: DiscoveredTopic[], assignments: TopicAssignment[], rejectedCommentIds: string[] = []): TopicDiscoveryResult => ({
  topics,
  assignments,
  rejectedCommentIds,
  issues: [],
});
const rows = (t: { topicSentiment: { rows: { label: string; count: number; percent: number }[] } }) =>
  Object.fromEntries(t.topicSentiment.rows.map((r) => [r.label, [r.count, r.percent]]));

describe("topic sentiment is sentiment toward the topic, separate from overall sentiment", () => {
  it("a positive comment whose primary topic is audio quality counts as negative under audio quality", () => {
    const comments = [classified("great-info-bad-audio", "positive")];
    const r = agg(discovery([topic("audio quality")], [assign("great-info-bad-audio", "audio quality", "negative")]), comments, schema);
    expect(rows(r.topics[0]!)).toEqual({ positive: [0, 0], neutral: [0, 0], negative: [1, 100] });
    expect(r.topics[0]!.evidence).toEqual([{ commentId: "great-info-bad-audio", topicSentiment: "negative", rank: 1, providerExample: false }]);
    expect(comments[0]!.classification.sentiment).toBe("positive");
  });

  it("when topic and overall sentiment agree, the topic shows the same label", () => {
    const comments = [classified("bad-audio", "negative")];
    const r = agg(discovery([topic("audio quality")], [assign("bad-audio", "audio quality", "negative")]), comments, schema);
    expect(rows(r.topics[0]!)).toEqual({ positive: [0, 0], neutral: [0, 0], negative: [1, 100] });
  });

  it("aggregates topic sentiment only: overall sentiment never changes the topic distribution", () => {
    const overall: SentimentLabel[] = ["positive", "positive", "neutral", "negative"];
    const comments = overall.map((s, i) => classified(`k${i}`, s));
    const allNegativeTowardTopic = comments.map((c) => assign(c.comment.id, "pricing", "negative"));
    const r = agg(discovery([topic("pricing")], allNegativeTowardTopic), comments, schema);
    expect(rows(r.topics[0]!)).toEqual({ positive: [0, 0], neutral: [0, 0], negative: [4, 100] });
  });

  it("does not change the classifications it reads", () => {
    const comments = [classified("k1", "positive"), classified("k2", "neutral")];
    const before = structuredClone(comments);
    agg(discovery([topic("audio")], [assign("k1", "audio", "negative"), assign("k2", "audio", "positive")]), comments, schema);
    expect(comments).toEqual(before);
  });
});

describe("topic × sentiment aggregation", () => {
  const overall = classified("other", "positive");
  const plan: [string, SentimentLabel][] = [
    ...["p1", "p2", "p3"].map((id) => [id, "positive"] as [string, SentimentLabel]),
    ...["n1", "n2", "n3", "n4"].map((id) => [id, "neutral"] as [string, SentimentLabel]),
    ...["x1", "x2", "x3", "x4", "x5", "x6", "x7"].map((id) => [id, "negative"] as [string, SentimentLabel]),
  ];
  // Overall sentiment is deliberately the opposite of topic sentiment for every comment.
  const comments = [...plan.map(([id, s]) => classified(id, s === "positive" ? "negative" : "positive")), overall];
  const battery = plan.map(([id, s]) => assign(id, "battery life", s));
  const result = agg(discovery([topic("battery life")], [...battery, generic("other")]), comments, schema);

  it("counts mentions and topic sentiment per topic", () => {
    const t = result.topics[0]!;
    expect(t).toMatchObject({ id: "topic:battery-life", name: "battery life", mentionCount: 14 });
    expect(t.topicSentiment.base).toBe(14);
    expect(rows(t)).toEqual({ positive: [3, 21], neutral: [4, 29], negative: [7, 50] });
  });

  it("percentages are integers that sum to exactly 100", () => {
    const sums = [0, 1, 2, 3].map((extra) => {
      const extraComments = Array.from({ length: extra }, (_, i) => classified(`e${i}`, "neutral"));
      const all = [...comments, ...extraComments];
      const r = agg(discovery([topic("topic")], all.map((c) => assign(c.comment.id, "topic", c.classification.sentiment))), all, schema);
      return r.topics[0]!.topicSentiment.rows.reduce((s, row) => s + row.percent, 0);
    });
    expect(sums).toEqual([100, 100, 100, 100]);
  });

  it("reports coverage over the sentiment base", () => {
    expect(result.coverage).toEqual({
      sentimentBase: 15,
      spamExcluded: 0,
      namedTopics: { count: 14, base: 15, percent: 93 },
      other: { count: 0, base: 15, percent: 0 },
      noSpecificTopic: { count: 1, base: 15, percent: 7 },
      assignmentRejected: { count: 0, base: 15, percent: 0 },
    });
  });

  it("flags small samples with the shared threshold", () => {
    expect(DEFAULT_TOPIC_PARAMETERS.smallSampleThreshold).toBe(30);
    expect(result.topics[0]!.smallSample).toBe(true);
    const big = agg(discovery([topic("battery life")], battery), comments, schema, { smallSampleThreshold: 14 });
    expect(big.topics[0]!.smallSample).toBe(false);
  });

  it("preserves mixed as its own topic-sentiment label when the schema enables it", () => {
    const mixed = [classified("m1", "positive"), classified("m2", "positive"), classified("m3", "negative")];
    const r = agg(discovery([topic("audio")], [assign("m1", "audio", "mixed"), assign("m2", "audio", "positive"), assign("m3", "audio", "negative")]), mixed, mixedSchema);
    expect(rows(r.topics[0]!)).toEqual({ positive: [1, 34], neutral: [0, 0], negative: [1, 33], mixed: [1, 33] });
  });

  it("rejects a topic sentiment outside the schema (mixed when not enabled) instead of remapping it", () => {
    const r = agg(discovery([topic("audio")], [assign("k1", "audio", "mixed")]), [classified("k1", "positive")], schema);
    expect(r.topics).toEqual([]);
    expect(r.issues).toEqual([{ code: "invalid_assignment", commentId: "k1" }]);
    expect(r.coverage.assignmentRejected.count).toBe(1);
  });

  it("rejects classifications that do not fit the schema instead of remapping them", () => {
    expect(() => agg(discovery([], []), [classified("k1", "mixed")], schema)).toThrow(ClassificationOutputError);
  });
});

describe("one primary topic per comment", () => {
  it("throws on a discovery result with two assignments for one comment (contract violation, never double-counted)", () => {
    const comments = [classified("k1", "negative")];
    expect(() => agg(discovery([topic("audio"), topic("pricing")], [assign("k1", "audio", "negative"), assign("k1", "pricing", "positive")]), comments, schema)).toThrow(
      /more than one primary topic/,
    );
  });

  it("mention counts sum to the commented-with-topic count and never exceed the eligible base", () => {
    const comments = ["k1", "k2", "k3", "k4", "k5"].map((id) => classified(id, "neutral"));
    const r = agg(
      discovery([topic("audio"), topic("pricing")], [assign("k1", "audio", "negative"), assign("k2", "pricing", "positive"), assign("k3", "audio", "neutral"), generic("k5")], ["k4"]),
      [...comments, spam("s1")],
      schema,
    );
    const total = r.topics.reduce((sum, t) => sum + t.mentionCount, 0);
    expect(total).toBe(r.coverage.namedTopics.count);
    expect(total).toBeLessThanOrEqual(r.coverage.sentimentBase);
    const c = r.coverage;
    expect(c.namedTopics.count + c.other.count + c.noSpecificTopic.count + c.assignmentRejected.count).toBe(c.sentimentBase);
    expect(r.coverage).toEqual({
      sentimentBase: 5,
      spamExcluded: 1,
      namedTopics: { count: 3, base: 5, percent: 60 },
      other: { count: 0, base: 5, percent: 0 },
      noSpecificTopic: { count: 1, base: 5, percent: 20 },
      assignmentRejected: { count: 1, base: 5, percent: 20 },
    });
  });

  it("is deterministic: the same input gives the same topics, order and coverage", () => {
    const comments = ["k1", "k2", "k3"].map((id) => classified(id, "neutral"));
    const input = discovery([topic("zeta"), topic("beta"), topic("alpha")], [assign("k1", "zeta", "positive"), assign("k2", "zeta", "negative"), assign("k3", "alpha", "neutral")]);
    const a = agg(input, comments, schema);
    expect(agg(structuredClone(input), structuredClone(comments), schema)).toEqual(a);
    expect(a.topics.map((t) => t.id)).toEqual(["topic:zeta", "topic:alpha"]);
    expect(a.droppedTopics.map((t) => t.id)).toEqual(["topic:beta"]);
  });
});

describe("topic aggregation edge cases", () => {
  it("never counts spam/irrelevant comments: excluded from topics, the base and coverage", () => {
    const comments = [classified("k1", "positive"), spam("s1"), spam("s2")];
    const r = agg(
      discovery([topic("audio"), topic("crypto")], [assign("k1", "audio", "positive"), assign("s1", "audio", "negative"), assign("s2", "crypto", "positive")], ["s1"]),
      comments,
      schema,
    );
    expect(r.topics.map((t) => [t.id, t.mentionCount])).toEqual([["topic:audio", 1]]);
    expect(rows(r.topics[0]!)).toEqual({ positive: [1, 100], neutral: [0, 0], negative: [0, 0] });
    expect(r.droppedTopics).toEqual([{ id: "topic:crypto", name: "crypto", reason: "no_mentions" }]);
    expect(r.coverage).toMatchObject({ sentimentBase: 1, spamExcluded: 2, namedTopics: { count: 1, base: 1 }, assignmentRejected: { count: 0 } });
    expect(r.issues.map((i) => i.code)).toEqual(["excluded_comment", "excluded_comment"]);
  });

  it("supports comments without a topic (explicit no_specific_topic)", () => {
    const r = agg(discovery([topic("audio")], [assign("k1", "audio", "neutral"), generic("k2")]), [classified("k1", "neutral"), classified("k2", "positive")], schema);
    expect(r.coverage.noSpecificTopic).toEqual({ count: 1, base: 2, percent: 50 });
    expect(r.coverage.assignmentRejected.count).toBe(0);
  });

  it("counts a base comment with no disposition at all as rejected, never as no_specific_topic", () => {
    const r = agg(discovery([topic("audio")], [assign("k1", "audio", "neutral")]), [classified("k1", "neutral"), classified("k2", "positive")], schema);
    expect(r.coverage.noSpecificTopic.count).toBe(0);
    expect(r.coverage.assignmentRejected).toEqual({ count: 1, base: 2, percent: 50 });
  });

  it("drops topics with zero valid mentions instead of showing empty distributions", () => {
    const r = agg(discovery([topic("audio")], [generic("k1")]), [classified("k1", "positive")], schema);
    expect(r.topics).toEqual([]);
    expect(r.droppedTopics).toEqual([{ id: "topic:audio", name: "audio", reason: "no_mentions" }]);
    expect(r.coverage.noSpecificTopic).toEqual({ count: 1, base: 1, percent: 100 });
  });

  it("keeps a topic with a single mention, flagged as a small sample", () => {
    const r = agg(discovery([topic("audio")], [assign("k1", "audio", "neutral")]), [classified("k1", "negative")], schema);
    expect(r.topics[0]).toMatchObject({ mentionCount: 1, smallSample: true });
    expect(rows(r.topics[0]!)).toEqual({ positive: [0, 0], neutral: [1, 100], negative: [0, 0] });
  });

  it("reports assignments to unknown comments or topics without counting them", () => {
    const r = agg(discovery([topic("audio")], [assign("ghost", "audio", "neutral"), assign("k1", "nope", "neutral"), assign("k2", "audio", "neutral")]), [classified("k1", "neutral"), classified("k2", "neutral")], schema);
    expect(r.topics[0]!.mentionCount).toBe(1);
    expect(r.issues.map((i) => i.code)).toEqual(["unknown_comment", "unknown_topic"]);
    expect(r.coverage.assignmentRejected.count).toBe(1);
  });

  it("handles no topics and no comments", () => {
    const zero = { count: 0, base: 0, percent: 0 };
    expect(agg(discovery([], []), [], schema)).toEqual({
      topics: [],
      commentTopics: [],
      other: {
        mentionCount: 0,
        providerOther: 0,
        smallTopics: 0,
        smallTopicSentiment: { base: 0, rows: schema.sentimentLabels.map((label) => ({ label, count: 0, percent: 0 })) },
        mergedTopics: [],
      },
      minTopicSize: 1,
      droppedTopics: [],
      coverage: { sentimentBase: 0, spamExcluded: 0, namedTopics: zero, other: zero, noSpecificTopic: zero, assignmentRejected: zero },
      warnings: [],
      issues: [],
    });
  });
});

describe("topic evidence references", () => {
  const labels = schema.sentimentLabels;
  const m = (commentId: string, topicSentiment: SentimentLabel, confidence?: number, overallSentiment: SentimentLabel = "neutral"): TopicMention => ({
    commentId,
    topicId: "topic:topic",
    role: "primary",
    topicSentiment,
    overallSentiment,
    ...(confidence !== undefined ? { confidence } : {}),
  });

  it("covers each present topic-sentiment label before repeating one, largest label first", () => {
    const mentions = [m("n1", "negative"), m("n2", "negative"), m("n3", "negative"), m("p1", "positive"), m("p2", "positive"), m("u1", "neutral")];
    expect(selectTopicEvidence(mentions, labels, [], 3).map((e) => [e.commentId, e.topicSentiment, e.rank])).toEqual([
      ["n1", "negative", 1],
      ["p1", "positive", 2],
      ["u1", "neutral", 3],
    ]);
    expect(selectTopicEvidence(mentions, labels, [], 5).map((e) => e.commentId)).toEqual(["n1", "p1", "u1", "n2", "p2"]);
  });

  it("groups by topic sentiment, not overall sentiment", () => {
    const mentions = [m("e1", "negative", undefined, "positive"), m("e2", "negative", undefined, "positive"), m("e3", "positive", undefined, "negative")];
    expect(selectTopicEvidence(mentions, labels, [], 3).map((e) => [e.commentId, e.topicSentiment])).toEqual([
      ["e1", "negative"],
      ["e3", "positive"],
      ["e2", "negative"],
    ]);
  });

  it("ranks within a label by confidence, then provider example, then comment ID", () => {
    const mentions = [m("cc", "negative"), m("bb", "negative", 0.6), m("aa", "negative"), m("dd", "negative", 0.9), m("ee", "negative")];
    expect(selectTopicEvidence(mentions, labels, ["ee"], 5).map((e) => e.commentId)).toEqual(["dd", "bb", "ee", "aa", "cc"]);
  });

  it("is independent of mention order and returns references only", () => {
    const mentions = [m("x2", "positive"), m("x1", "positive"), m("y1", "negative", 0.5)];
    const a = selectTopicEvidence(mentions, labels, ["x2"], 3);
    expect(selectTopicEvidence([...mentions].reverse(), labels, ["x2"], 3)).toEqual(a);
    expect(a).toEqual([
      { commentId: "x2", topicSentiment: "positive", rank: 1, providerExample: true },
      { commentId: "y1", topicSentiment: "negative", rank: 2, confidence: 0.5, providerExample: false },
      { commentId: "x1", topicSentiment: "positive", rank: 3, providerExample: false },
    ]);
  });

  it("breaks equal label counts by schema label order", () => {
    expect(selectTopicEvidence([m("nn", "negative"), m("pp", "positive")], labels, [], 1).map((e) => e.commentId)).toEqual(["pp"]);
  });

  it("returns fewer items when there are fewer mentions, and none for limit 0", () => {
    expect(selectTopicEvidence([m("k1", "neutral")], labels, [], 3)).toHaveLength(1);
    expect(selectTopicEvidence([m("k1", "neutral")], labels, [], 0)).toEqual([]);
    expect(() => selectTopicEvidence([], labels, [], -1)).toThrow(RangeError);
  });

  it("aggregation attaches evidence per topic using the provider examples it recorded", () => {
    const comments = ["k1", "k2", "k3", "k4"].map((id) => classified(id, "neutral"));
    const r = agg(discovery([topic("audio", ["k3"])], comments.map((c) => assign(c.comment.id, "audio", "neutral"))), comments, schema);
    expect(r.topics[0]!.evidence.map((e) => e.commentId)).toEqual(["k3", "k1", "k2"]);
    expect(JSON.stringify(r)).not.toContain("synthetic comment");
  });
});
