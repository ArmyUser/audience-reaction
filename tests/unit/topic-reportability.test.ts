import { describe, expect, it } from "vitest";
import { createClassificationSchema } from "../../src/core/classification/schema";
import type { ClassifiedComment, SentimentLabel } from "../../src/core/domain/types";
import { aggregateTopics, DEFAULT_TOPIC_PARAMETERS, highOtherShareWarning, minimumTopicSize } from "../../src/core/topics/aggregate-topics";
import { toTopicsSection } from "../../src/core/topics/topics-section";
import type { DiscoveredTopic, TopicAccounting, TopicAnalysis, TopicAssignment, TopicCoverage, TopicDiscoveryResult, TopicMethod } from "../../src/core/topics/types";
import { classified, spam } from "../topic-helpers";

// Reportability rules on top of topic aggregation (spec.md §2.6, §7.6, §7.7, §7.9, §8.7): the three dispositions,
// minimum topic size → OTHER, NO_SPECIFIC_TOPIC, coverage buckets and HIGH_OTHER_SHARE. Default parameters throughout.

const schema = createClassificationSchema({ focusConfigured: false });
const idOf = (name: string) => `topic:${name.replaceAll(" ", "-")}`;
const topic = (name: string): DiscoveredTopic => ({ id: idOf(name), name, formation: { sourceNames: [`Raw ${name}!!`], providerKeys: [name], providerExampleIds: [] } });
const discovery = (topics: DiscoveredTopic[], assignments: TopicAssignment[], rejectedCommentIds: string[] = []): TopicDiscoveryResult => ({
  topics,
  assignments,
  rejectedCommentIds,
  issues: [],
});
const comments = (n: number, prefix = "cm", sentiment: SentimentLabel = "neutral"): ClassifiedComment[] =>
  Array.from({ length: n }, (_, i) => classified(`${prefix}${String(i).padStart(4, "0")}`, sentiment));
const ids = (pool: ClassifiedComment[], from: number, count: number) => pool.slice(from, from + count).map((c) => c.comment.id);
/** Dispositions for `count` comments of `pool` starting at `from`. */
const toTopic = (pool: ClassifiedComment[], from: number, count: number, name: string, topicSentiment: SentimentLabel = "neutral"): TopicAssignment[] =>
  ids(pool, from, count).map((commentId) => ({ commentId, disposition: "primary_topic", topicId: idOf(name), topicSentiment }));
const toOther = (pool: ClassifiedComment[], from: number, count: number): TopicAssignment[] => ids(pool, from, count).map((commentId) => ({ commentId, disposition: "other" }));
const toGeneric = (pool: ClassifiedComment[], from: number, count: number): TopicAssignment[] =>
  ids(pool, from, count).map((commentId) => ({ commentId, disposition: "no_specific_topic" }));
const bucketsSum = (c: TopicAccounting) => c.namedTopics.count + c.other.count + c.noSpecificTopic.count + c.assignmentRejected.count;

describe("minimum topic size = max(10, ceil(1% of the non-spam topic base))", () => {
  it.each([
    [0, 10],
    [56, 10],
    [999, 10],
    [1000, 10],
    [1001, 11],
    [1500, 15],
    [2000, 20],
    [2001, 21],
  ])("topic base %i → %i", (base, expected) => {
    expect(minimumTopicSize(base, DEFAULT_TOPIC_PARAMETERS)).toBe(expected);
  });

  it("uses the non-spam base, not all comments and not only comments with a topic", () => {
    const eligible = comments(1001);
    const all = [...eligible, ...Array.from({ length: 600 }, (_, i) => spam(`sp${i}`))];
    const r = aggregateTopics(discovery([topic("audio")], [...toTopic(eligible, 0, 11, "audio"), ...toGeneric(eligible, 11, 990)]), all, schema);
    // 1001 eligible → 11. With spam counted (1601) it would be 17; with only topic comments (11) it would be 10.
    expect(r.minTopicSize).toBe(11);
    expect(r.topics.map((t) => t.id)).toEqual(["topic:audio"]);
  });

  it("a topic exactly at the minimum stays named; one below is merged into OTHER", () => {
    const pool = comments(25);
    const r = aggregateTopics(discovery([topic("audio"), topic("pricing")], [...toTopic(pool, 0, 10, "audio"), ...toTopic(pool, 10, 9, "pricing"), ...toGeneric(pool, 19, 6)]), pool, schema);
    expect(r.minTopicSize).toBe(10);
    expect(r.topics.map((t) => [t.id, t.mentionCount])).toEqual([["topic:audio", 10]]);
    expect(r.other.mergedTopics).toEqual([{ id: "topic:pricing", name: "pricing", mentionCount: 9 }]);
  });

  it("respects configured parameters", () => {
    expect(minimumTopicSize(300, { minTopicSizeFloor: 2, minTopicSizePercentOfBase: 1 })).toBe(3);
    expect(() => minimumTopicSize(-1, DEFAULT_TOPIC_PARAMETERS)).toThrow(RangeError);
  });
});

describe("the three dispositions", () => {
  // 40 eligible: 12 named, 5 provider other, 6 in a small topic, 15 generic, 2 without a disposition; plus 2 spam.
  const pool = comments(40, "cm", "positive");
  const all = [...pool, spam("sp1"), spam("sp2")];
  const assignments: TopicAssignment[] = [
    ...toTopic(pool, 0, 12, "sponsor segment", "negative"),
    ...toOther(pool, 12, 5),
    ...toTopic(pool, 17, 4, "audio quality", "negative"),
    ...toTopic(pool, 21, 2, "audio quality", "neutral"),
    ...toGeneric(pool, 23, 15),
    { commentId: "sp1", disposition: "other" },
    { commentId: "sp2", disposition: "primary_topic", topicId: idOf("sponsor segment"), topicSentiment: "positive" },
  ];
  const topics = [topic("audio quality"), topic("sponsor segment")];
  const r = aggregateTopics(discovery(topics, assignments, ids(pool, 38, 2)), all, schema);

  it("substantive no-match (provider other) → OTHER", () => {
    expect(r.other.providerOther).toBe(5);
  });

  it("generic comments → NO_SPECIFIC_TOPIC", () => {
    expect(r.coverage.noSpecificTopic).toEqual({ count: 15, base: 40, percent: 38 });
  });

  it("a small discovered topic → OTHER, with its name kept", () => {
    expect(r.other.smallTopics).toBe(6);
    expect(r.other.mergedTopics).toEqual([{ id: "topic:audio-quality", name: "audio quality", mentionCount: 6 }]);
  });

  it("OTHER contains both provider other and small-topic comments, each origin counted", () => {
    expect(r.other.mentionCount).toBe(11);
    expect(r.coverage.other).toEqual({ count: 11, base: 40, percent: 28 });
  });

  it("spam stays outside the topic base even when the provider gives it a disposition", () => {
    expect(r.coverage).toMatchObject({ sentimentBase: 40, spamExcluded: 2 });
    expect(r.issues).toEqual([
      { code: "excluded_comment", commentId: "sp1" },
      { code: "excluded_comment", commentId: "sp2" },
    ]);
    expect(r.topics[0]!.mentionCount).toBe(12);
  });

  it("comments without a valid disposition stay in their own rejected bucket", () => {
    expect(r.coverage.assignmentRejected).toEqual({ count: 2, base: 40, percent: 5 });
  });

  it("the four buckets partition the non-spam topic base exactly", () => {
    expect(r.coverage).toEqual({
      sentimentBase: 40,
      spamExcluded: 2,
      namedTopics: { count: 12, base: 40, percent: 30 },
      other: { count: 11, base: 40, percent: 28 },
      noSpecificTopic: { count: 15, base: 40, percent: 38 },
      assignmentRejected: { count: 2, base: 40, percent: 5 },
    });
    expect(bucketsSum(r.coverage)).toBe(40);
  });

  it("provider other has no topic sentiment; OTHER's distribution covers only the small-topic comments", () => {
    expect(r.other.smallTopicSentiment).toEqual({
      base: 6,
      rows: [
        { label: "positive", count: 0, percent: 0 },
        { label: "neutral", count: 2, percent: 33 },
        { label: "negative", count: 4, percent: 67 },
      ],
    });
  });

  it("never reuses overall sentiment as topic sentiment (every comment here is positive overall)", () => {
    expect(r.topics[0]!.topicSentiment.rows.find((x) => x.label === "positive")!.count).toBe(0);
    expect(r.other.smallTopicSentiment.rows.find((x) => x.label === "positive")!.count).toBe(0);
  });

  it("is deterministic regardless of provider topic or assignment order (issues keep the provider's order as diagnostics)", () => {
    const reversed = aggregateTopics(discovery([...topics].reverse(), [...assignments].reverse(), ids(pool, 38, 2)), all, schema);
    expect({ ...reversed, issues: undefined }).toEqual({ ...r, issues: undefined });
    expect(reversed.issues).toEqual([...r.issues].reverse());
  });
});

describe("OTHER from small topics", () => {
  const pool = comments(40);
  const assignments = [
    ...toTopic(pool, 0, 12, "sponsor segment", "negative"),
    ...toTopic(pool, 12, 4, "audio quality", "negative"),
    ...toTopic(pool, 16, 2, "audio quality", "positive"),
    ...toTopic(pool, 18, 6, "testing depth", "neutral"),
    ...toTopic(pool, 24, 3, "intro length", "positive"),
    ...toGeneric(pool, 27, 13),
  ];
  const r = aggregateTopics(discovery([topic("intro length"), topic("testing depth"), topic("sponsor segment"), topic("audio quality")], assignments), pool, schema);

  it("keeps the merged topics' normalised names and IDs, ordered by count then ID", () => {
    expect(r.other.mergedTopics).toEqual([
      { id: "topic:audio-quality", name: "audio quality", mentionCount: 6 },
      { id: "topic:testing-depth", name: "testing depth", mentionCount: 6 },
      { id: "topic:intro-length", name: "intro length", mentionCount: 3 },
    ]);
  });

  it("preserves the topic-sentiment distribution of the merged comments and counts each once", () => {
    expect(r.other).toMatchObject({ mentionCount: 15, providerOther: 0, smallTopics: 15 });
    expect(r.other.smallTopicSentiment.rows.map((x) => [x.label, x.count, x.percent])).toEqual([
      ["positive", 5, 33],
      ["neutral", 6, 40],
      ["negative", 4, 27],
    ]);
    expect(bucketsSum(r.coverage)).toBe(40);
  });
});

describe("HIGH_OTHER_SHARE: OTHER + NO_SPECIFIC_TOPIC strictly above 35% of the topic base", () => {
  /** 100 eligible comments: `named` in one large topic, `small` in a small topic (OTHER), `other` provider other, rest generic. */
  function withCounts(named: number, small: number, other = 0) {
    const pool = comments(100);
    return aggregateTopics(
      discovery(
        [topic("big"), topic("small")],
        [...toTopic(pool, 0, named, "big"), ...toTopic(pool, named, small, "small"), ...toOther(pool, named + small, other), ...toGeneric(pool, named + small + other, 100 - named - small - other)],
      ),
      pool,
      schema,
    );
  }

  it("exactly 35% does not warn", () => {
    const r = withCounts(65, 5);
    expect(r.coverage.other.count + r.coverage.noSpecificTopic.count).toBe(35);
    expect(r.warnings).toEqual([]);
  });

  it("36% warns, with structured shares and the threshold", () => {
    expect(withCounts(64, 5).warnings).toEqual([
      {
        code: "HIGH_OTHER_SHARE",
        other: { count: 5, base: 100, percent: 5 },
        noSpecificTopic: { count: 31, base: 100, percent: 31 },
        combined: { count: 36, base: 100, percent: 36 },
        thresholdPercent: 35,
      },
    ]);
  });

  it("counts provider other towards the warning", () => {
    expect(withCounts(64, 0, 36).warnings[0]).toMatchObject({ other: { count: 36 }, noSpecificTopic: { count: 0 }, combined: { count: 36 } });
  });

  it("compares exact counts, not rounded percentages", () => {
    // 7 of 20 = 35% exactly → none; 351 of 1000 = 35.1% (rounds to 35%) → warns.
    const coverage = (combined: number, base: number): TopicCoverage => ({
      sentimentBase: base,
      spamExcluded: 0,
      namedTopics: { count: base - combined, base, percent: 0 },
      other: { count: 0, base, percent: 0 },
      noSpecificTopic: { count: combined, base, percent: 0 },
    });
    expect(highOtherShareWarning(coverage(7, 20), 35)).toEqual([]);
    expect(highOtherShareWarning(coverage(351, 1000), 35)).toHaveLength(1);
    expect(highOtherShareWarning(coverage(0, 0), 35)).toEqual([]);
  });

  it("rejected assignments do not count towards the warning", () => {
    const pool = comments(20);
    const r = aggregateTopics(discovery([topic("big")], toTopic(pool, 0, 12, "big"), ids(pool, 12, 8)), pool, schema);
    expect(r.coverage.assignmentRejected.count).toBe(8);
    expect(r.warnings).toEqual([]);
  });
});

describe("topics report section", () => {
  const method: TopicMethod = { providerLabel: "test provider", normalizationVersion: "tn1", commentsSent: 30, attempts: 1, parameters: { ...DEFAULT_TOPIC_PARAMETERS } };
  const pool = comments(30);
  const aggregation = aggregateTopics(
    discovery(
      [topic("sponsor segment"), topic("audio quality")],
      [...toTopic(pool, 0, 10, "sponsor segment"), ...toTopic(pool, 10, 4, "audio quality", "negative"), ...toOther(pool, 14, 3), ...toGeneric(pool, 17, 13)],
    ),
    pool,
    schema,
  );
  const { coverage: accounting, issues: _issues, ...rest } = aggregation;
  const coverage: TopicCoverage = {
    sentimentBase: accounting.sentimentBase,
    spamExcluded: accounting.spamExcluded,
    namedTopics: accounting.namedTopics,
    other: accounting.other,
    noSpecificTopic: accounting.noSpecificTopic,
  };
  const analysis: TopicAnalysis = { status: "available", ...rest, coverage, method };

  it("exposes one OTHER share with its provenance and NO_SPECIFIC_TOPIC separately; no rejected bucket, no issues", () => {
    const section = toTopicsSection(analysis);
    if (section.status !== "available") throw new Error("expected available");
    expect(section.topics).toEqual([
      {
        id: "topic:sponsor-segment",
        name: "sponsor segment",
        count: { count: 10, base: 30, percent: 33 },
        topicSentiment: aggregation.topics[0]!.topicSentiment,
        smallSample: true,
        evidence: aggregation.topics[0]!.evidence,
      },
    ]);
    expect(section.other).toEqual({
      count: { count: 7, base: 30, percent: 23 },
      providerOther: { count: 3, base: 30, percent: 10 },
      smallTopics: { count: 4, base: 30, percent: 13 },
      smallTopicSentiment: aggregation.other.smallTopicSentiment,
      mergedTopics: [{ id: "topic:audio-quality", name: "audio quality", mentionCount: 4 }],
    });
    expect(section.noSpecificTopic).toEqual({ count: 13, base: 30, percent: 43 });
    // AC-23: named + OTHER + NO_SPECIFIC_TOPIC = B.
    expect(section.topics[0]!.count.count + section.other.count.count + section.noSpecificTopic.count).toBe(30);
    expect(Object.keys(section)).not.toContain("assignmentRejected");
    expect(Object.keys(section)).not.toContain("issues");
    expect(Object.keys(section.coverage)).not.toContain("assignmentRejected");
    expect(section.warnings.map((w) => w.code)).toEqual(["HIGH_OTHER_SHARE"]);
    const json = JSON.stringify(section);
    for (const leaked of ["Raw ", "assignmentRejected", "synthetic comment", "formation"]) expect(json).not.toContain(leaked);
  });

  it("refuses to map an available analysis that violates AC-23", () => {
    const broken: TopicAnalysis = { ...analysis, coverage: { ...coverage, noSpecificTopic: { count: 12, base: 30, percent: 40 } } };
    expect(() => toTopicsSection(broken)).toThrow(/AC-23/);
  });

  it("maps an unavailable analysis to TOPICS_UNAVAILABLE with issue counts per attempt and code only", () => {
    const section = toTopicsSection({
      status: "unavailable",
      reason: "TOPICS_UNAVAILABLE",
      issues: [
        { code: "missing_assignment", attempt: 1, commentId: "cm0001" },
        { code: "missing_assignment", attempt: 1, commentId: "cm0002" },
        { code: "unknown_topic", attempt: 1, topicKey: "provider-key-xyz" },
        { code: "invalid_output", attempt: 2, detail: "topics: expected array" },
      ],
      method: { ...method, attempts: 2 },
    });
    expect(section).toEqual({
      status: "unavailable",
      reason: "TOPICS_UNAVAILABLE",
      issues: [
        { attempt: 1, code: "missing_assignment", count: 2 },
        { attempt: 1, code: "unknown_topic", count: 1 },
        { attempt: 2, code: "invalid_output", count: 1 },
      ],
      method: { ...method, attempts: 2 },
    });
    for (const leaked of ["provider-key-xyz", "expected array", "cm0001"]) expect(JSON.stringify(section)).not.toContain(leaked);
  });
});

describe("per-comment topic labels", () => {
  const pool = comments(30);
  const assignments = [
    ...toTopic(pool, 0, 12, "sponsor segment", "negative"),
    ...toTopic(pool, 12, 3, "audio quality", "positive"),
    ...toGeneric(pool, 15, 15),
  ];
  const r = aggregateTopics(discovery([topic("sponsor segment"), topic("audio quality")], assignments), pool, schema);

  it("label every counted comment once, consistent with the counts, merged small topics as OTHER", () => {
    expect(r.commentTopics).toHaveLength(r.coverage.namedTopics.count + r.coverage.other.count + r.coverage.noSpecificTopic.count);
    expect(new Set(r.commentTopics.map((c) => c.commentId)).size).toBe(r.commentTopics.length);
    const named = r.commentTopics.filter((c) => c.disposition === "topic");
    expect(named).toHaveLength(r.coverage.namedTopics.count);
    expect(named.every((c) => c.disposition === "topic" && c.topicId === "topic:sponsor-segment" && c.topicSentiment === "negative")).toBe(true);
    const merged = r.commentTopics.filter((c) => c.disposition === "other");
    expect(merged).toHaveLength(r.other.smallTopics + r.other.providerOther);
    expect(merged.every((c) => c.disposition === "other" && c.mergedFromTopicId === "topic:audio-quality")).toBe(true);
  });
});
