import { describe, expect, it } from "vitest";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseTopicDiscoveryOutput, TopicDiscoveryOutputError } from "../../src/core/topics/validation";

const IDS = ["c1", "c2", "c3", "c4"];
const LABELS = createClassificationSchema({ focusConfigured: false }).sentimentLabels;
const MIXED_LABELS = createClassificationSchema({ focusConfigured: false, mixedEnabled: true }).sentimentLabels;
const parse = (raw: unknown, maxTopics = 12, sentimentLabels = LABELS, ids: readonly string[] = IDS) => parseTopicDiscoveryOutput(raw, ids, { maxTopics, sentimentLabels });
/** Topic-level checks run against no analysed comments, so no assignment is expected. */
const parseTopics = (topics: unknown[], ids: readonly string[] = []) => parse({ topics, assignments: [] }, 12, LABELS, ids);
const topicEntry = (commentId: string, topicKey: string, topicSentiment: unknown = "neutral") => ({ commentId, disposition: "primary_topic", topicKey, topicSentiment });
const generic = (commentId: string) => ({ commentId, disposition: "no_specific_topic" });

describe("topic discovery output: overall shape", () => {
  it.each([
    ["null", null],
    ["a string", "battery life"],
    ["an array", []],
    ["missing assignments", { topics: [] }],
    ["topics not an array", { topics: {}, assignments: [] }],
    ["unexpected top-level field", { topics: [], assignments: [], note: "x" }],
  ])("rejects %s as a whole", (_name, raw) => {
    expect(() => parse(raw)).toThrow(TopicDiscoveryOutputError);
    try {
      parse(raw);
    } catch (error) {
      expect((error as TopicDiscoveryOutputError).issues[0]!.code).toBe("invalid_output");
    }
  });

  it("accepts an empty result when every comment is generic", () => {
    expect(parse({ topics: [], assignments: IDS.map(generic) })).toEqual({
      topics: [],
      assignments: IDS.map((commentId) => ({ commentId, disposition: "no_specific_topic" })),
      rejectedCommentIds: [],
      issues: [],
    });
  });

  it("rejects more distinct topics than maxTopics, counting after duplicate collapse", () => {
    const topics = [
      { key: "key1", name: "Audio" },
      { key: "key2", name: "audio" },
      { key: "key3", name: "Pricing" },
    ];
    expect(parse({ topics, assignments: [] }, 2, LABELS, []).topics).toHaveLength(2);
    expect(() => parse({ topics, assignments: [] }, 1, LABELS, [])).toThrow(/too_many_topics/);
  });
});

describe("topic discovery output: topics", () => {
  it("normalises names, derives stable IDs and keeps its description", () => {
    const result = parseTopics([{ key: "key1", name: "  Battery-Life ", description: " Comments about how long a charge lasts. " }]);
    expect(result.topics).toEqual([
      {
        id: "topic:battery-life",
        name: "battery life",
        description: "Comments about how long a charge lasts.",
        formation: { sourceNames: ["  Battery-Life "], providerKeys: ["key1"], providerExampleIds: [] },
      },
    ]);
  });

  it("collapses topics whose names normalise identically and records how", () => {
    const result = parse({
      topics: [
        { key: "key1", name: "Battery Life", exampleCommentIds: ["c1"] },
        { key: "key2", name: "battery-life", description: "How long a charge lasts.", exampleCommentIds: ["c2", "c1"] },
        { key: "key3", name: "battery duration" },
      ],
      assignments: IDS.map(generic),
    });
    expect(result.topics.map((t) => t.id)).toEqual(["topic:battery-life", "topic:battery-duration"]);
    expect(result.topics[0]).toMatchObject({
      description: "How long a charge lasts.",
      formation: { sourceNames: ["Battery Life", "battery-life"], providerKeys: ["key1", "key2"], providerExampleIds: ["c1", "c2"] },
    });
    expect(result.issues).toEqual([]);
  });

  it("drops invalid topics and reports them; never repairs them", () => {
    const result = parseTopics([
      { key: "good", name: "Audio quality" },
      { key: "", name: "Empty key" },
      { name: "No key" },
      { key: "num", name: 42 },
      { key: "extra", name: "Extra", extra: true },
      { key: "good", name: "Duplicate key" },
      { key: "blank", name: " ?! " },
      { key: "long", name: "one two three four five six" },
    ]);
    expect(result.topics.map((t) => t.name)).toEqual(["audio quality"]);
    expect(result.issues.map((i) => [i.code, i.index])).toEqual([
      ["invalid_topic", 1],
      ["invalid_topic", 2],
      ["invalid_topic", 3],
      ["invalid_topic", 4],
      ["duplicate_topic_key", 5],
      ["invalid_topic_name", 6],
      ["invalid_topic_name", 7],
    ]);
  });

  it("drops example IDs that are not analysed comments without echoing them", () => {
    const result = parse({ topics: [{ key: "key1", name: "Audio", exampleCommentIds: ["c3", "not a comment: buy now", "c3"] }], assignments: IDS.map(generic) });
    expect(result.topics[0]!.formation.providerExampleIds).toEqual(["c3"]);
    expect(result.issues).toEqual([{ code: "unknown_example_comment", index: 0, topicKey: "key1" }]);
    expect(JSON.stringify(result)).not.toContain("buy now");
  });
});

describe("topic discovery output: one disposition per comment", () => {
  const topics = [
    { key: "audio", name: "Audio" },
    { key: "price", name: "Pricing" },
    { key: "audio-dup", name: "AUDIO" },
    { key: "bad-name", name: "" },
  ];
  /** Assignment-level issues only (the topics above include one invalid topic on purpose). */
  const assignmentIssues = (raw: unknown, ids?: readonly string[]) => parse(raw, 12, LABELS, ids).issues.filter((i) => i.code !== "invalid_topic_name");

  it("accepts a primary topic (with topic sentiment), other and no_specific_topic", () => {
    const result = parse({
      topics,
      assignments: [
        { ...topicEntry("c3", "audio", "negative"), confidence: 0.7 },
        { commentId: "c2", disposition: "other", confidence: 0.6 },
        topicEntry("c1", "price", "positive"),
        generic("c4"),
      ],
    });
    expect(result.assignments).toEqual([
      { commentId: "c1", disposition: "primary_topic", topicId: "topic:pricing", topicSentiment: "positive" },
      { commentId: "c2", disposition: "other", confidence: 0.6 },
      { commentId: "c3", disposition: "primary_topic", topicId: "topic:audio", topicSentiment: "negative", confidence: 0.7 },
      { commentId: "c4", disposition: "no_specific_topic" },
    ]);
    expect(result.rejectedCommentIds).toEqual([]);
    expect(assignmentIssues({ topics, assignments: [topicEntry("c1", "price"), { commentId: "c2", disposition: "other" }, generic("c3"), generic("c4")] })).toEqual([]);
  });

  it("other and no_specific_topic need no topic sentiment and may not carry a topic or a topic sentiment", () => {
    for (const disposition of ["other", "no_specific_topic"]) {
      expect(parse({ topics, assignments: [{ commentId: "c1", disposition }] }, 12, LABELS, ["c1"]).assignments).toEqual([{ commentId: "c1", disposition }]);
      for (const extra of [{ topicSentiment: "negative" }, { topicKey: "audio" }, { sentiment: "positive" }]) {
        const raw = { topics, assignments: [{ commentId: "c1", disposition, ...extra }] };
        expect(parse(raw, 12, LABELS, ["c1"]).rejectedCommentIds, `${disposition} ${JSON.stringify(extra)}`).toEqual(["c1"]);
        expect(assignmentIssues(raw, ["c1"])).toEqual([{ code: "invalid_assignment", index: 0, commentId: "c1" }]);
      }
    }
  });

  it("requires an explicit, known disposition", () => {
    for (const entry of [
      { commentId: "c1", topicKey: "audio", topicSentiment: "neutral" },
      { commentId: "c1", disposition: "OTHER" },
      { commentId: "c1", disposition: "none" },
    ]) {
      expect(parse({ topics, assignments: [entry] }, 12, LABELS, ["c1"]).rejectedCommentIds, JSON.stringify(entry)).toEqual(["c1"]);
    }
  });

  it("rejects a comment the provider gave no disposition, without treating it as no_specific_topic", () => {
    const result = parse({ topics, assignments: [topicEntry("c1", "audio"), generic("c3")] });
    expect(result.assignments.map((a) => [a.commentId, a.disposition])).toEqual([
      ["c1", "primary_topic"],
      ["c3", "no_specific_topic"],
    ]);
    expect(result.rejectedCommentIds).toEqual(["c2", "c4"]);
    expect(assignmentIssues({ topics, assignments: [topicEntry("c1", "audio"), generic("c3")] })).toEqual([
      { code: "missing_assignment", commentId: "c2" },
      { code: "missing_assignment", commentId: "c4" },
    ]);
  });

  it("rejects every entry of a comment that has more than one (different topics or dispositions)", () => {
    const raw = {
      topics,
      assignments: [topicEntry("c1", "audio", "negative"), topicEntry("c2", "audio", "positive"), topicEntry("c1", "price", "positive"), generic("c3"), { commentId: "c3", disposition: "other" }],
    };
    const result = parse(raw, 12, LABELS, ["c1", "c2", "c3"]);
    expect(result.assignments).toEqual([{ commentId: "c2", disposition: "primary_topic", topicId: "topic:audio", topicSentiment: "positive" }]);
    expect(result.rejectedCommentIds).toEqual(["c1", "c3"]);
    expect(assignmentIssues(raw, ["c1", "c2", "c3"])).toEqual([
      { code: "multiple_primary_topics", commentId: "c1", detail: "2 assignments (indexes 0, 2)" },
      { code: "multiple_primary_topics", commentId: "c3", detail: "2 assignments (indexes 3, 4)" },
    ]);
  });

  it.each([
    ["the same topic again", topicEntry("c1", "audio", "negative")],
    ["the same topic via a collapsed key", topicEntry("c1", "audio-dup", "negative")],
    ["an invalid second entry", { commentId: "c1", disposition: "primary_topic", topicKey: "audio" }],
  ])("rejects a comment assigned twice: %s", (_name, second) => {
    const raw = { topics, assignments: [topicEntry("c1", "audio", "negative"), second] };
    const result = parse(raw, 12, LABELS, ["c1"]);
    expect(result.assignments).toEqual([]);
    expect(result.rejectedCommentIds).toEqual(["c1"]);
    expect(assignmentIssues(raw, ["c1"]).map((i) => i.code)).toEqual(["multiple_primary_topics"]);
  });

  it("requires a primary topic's sentiment from the schema's labels; mixed only when enabled", () => {
    const entry = (topicSentiment?: unknown) => ({
      topics,
      assignments: [{ commentId: "c1", disposition: "primary_topic", topicKey: "audio", ...(topicSentiment === undefined ? {} : { topicSentiment }) }],
    });
    for (const bad of [undefined, "mixed", "very negative", "not_addressed", 1]) {
      const result = parse(entry(bad), 12, LABELS, ["c1"]);
      expect(result.assignments, String(bad)).toEqual([]);
      expect(result.rejectedCommentIds, String(bad)).toEqual(["c1"]);
    }
    expect(parse(entry("mixed"), 12, MIXED_LABELS, ["c1"]).assignments).toEqual([{ commentId: "c1", disposition: "primary_topic", topicId: "topic:audio", topicSentiment: "mixed" }]);
  });

  it("drops and reports malformed, unknown and dangling assignments", () => {
    const result = parse({
      topics,
      assignments: [
        topicEntry("c1", "audio"),
        { disposition: "primary_topic", topicKey: "audio", topicSentiment: "neutral" },
        "c2:audio",
        topicEntry("c9", "audio"),
        topicEntry("c2", "missing"),
        topicEntry("c3", "bad-name"),
        { ...topicEntry("c4", "audio"), confidence: 1.5 },
      ],
    });
    expect(result.issues.filter((i) => i.code !== "invalid_topic_name").map((i) => i.code)).toEqual([
      "invalid_assignment",
      "invalid_assignment",
      "unknown_comment",
      "unknown_topic",
      "assignment_to_dropped_topic",
      "invalid_assignment",
    ]);
    expect(result.assignments.map((a) => a.commentId)).toEqual(["c1"]);
    expect(result.rejectedCommentIds).toEqual(["c2", "c3", "c4"]);
  });

  it("does not accept an overall-sentiment field in place of topic sentiment", () => {
    const raw = { topics, assignments: [{ commentId: "c1", disposition: "primary_topic", topicKey: "audio", sentiment: "negative" }] };
    expect(parse(raw, 12, LABELS, ["c1"]).assignments).toEqual([]);
    expect(assignmentIssues(raw, ["c1"])).toEqual([{ code: "invalid_assignment", index: 0, commentId: "c1" }]);
  });

  it("orders assignments by input comment order, independent of provider order", () => {
    const assignments = [topicEntry("c4", "audio"), topicEntry("c1", "price", "negative"), { commentId: "c3", disposition: "other" }, topicEntry("c2", "audio", "positive")];
    const forward = parse({ topics, assignments });
    expect(parse({ topics, assignments: [...assignments].reverse() }).assignments).toEqual(forward.assignments);
    expect(forward.assignments.map((a) => a.commentId)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});
