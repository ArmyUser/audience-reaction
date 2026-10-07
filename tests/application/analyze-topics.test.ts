import { describe, expect, it, vi } from "vitest";
import { FixtureTopicDiscoverer, type TopicFixture } from "../../src/adapters/fakes/fixture-topic-discoverer";
import { analyzeTopics, MAX_TOPIC_ATTEMPTS } from "../../src/application/analyze-topics";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { ClassificationOutputError } from "../../src/core/classification/validation";
import type { ClassifiedComment } from "../../src/core/domain/types";
import type { TopicDiscoverer, TopicDiscoveryRequest } from "../../src/core/ports";
import type { TopicAnalysis, TopicIssue } from "../../src/core/topics/types";
import { TopicDiscoveryOutputError } from "../../src/core/topics/validation";
import { goldDeps } from "../helpers";
import { classified, spam } from "../topic-helpers";

const schema = createClassificationSchema({ focusConfigured: false });
/** A discoverer that returns `outputs[n]` on call n (the last repeats); an Error output is thrown. Records requests. */
const seq = (outputs: unknown[], label = "raw test discoverer"): TopicDiscoverer & { calls: TopicDiscoveryRequest[] } => {
  const calls: TopicDiscoveryRequest[] = [];
  return {
    label,
    calls,
    discoverTopics: async (request) => {
      calls.push(structuredClone(request));
      const out = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      if (out instanceof Error) throw out;
      return out;
    },
  };
};
const raw = (output: unknown, label?: string) => seq([output], label);
/** These tests use topics smaller than the default minimum size (10), so the floor is 1; min size is tested elsewhere. */
const run: typeof analyzeTopics = (input, deps) => analyzeTopics(input, { params: { minTopicSizeFloor: 1 }, ...deps });
const available = (r: TopicAnalysis) => {
  if (r.status !== "available") throw new Error(`expected available, got ${JSON.stringify(r)}`);
  return r;
};
/** AC-23 and the absence of a rejected bucket, checked on every available result in this file. */
function expectAc23(r: Extract<TopicAnalysis, { status: "available" }>) {
  const c = r.coverage;
  expect(c.namedTopics.count + c.other.count + c.noSpecificTopic.count).toBe(c.sentimentBase);
  expect(r.topics.reduce((sum, t) => sum + t.mentionCount, 0)).toBe(c.namedTopics.count);
  for (const s of [c.namedTopics, c.other, c.noSpecificTopic]) expect(s.base).toBe(c.sentimentBase);
  expect(Object.keys(c)).not.toContain("assignmentRejected");
  expect(Object.keys(r)).not.toContain("issues");
}

const comments = [classified("k1", "positive"), classified("k2", "negative"), spam("s1")];
const topics = [
  { key: "key1", name: "Audio" },
  { key: "key2", name: "Pricing" },
];
const VALID = {
  topics,
  assignments: [
    { commentId: "k1", disposition: "primary_topic", topicKey: "key1", topicSentiment: "negative" },
    { commentId: "k2", disposition: "no_specific_topic" },
  ],
};

describe("analyzeTopics orchestration", () => {
  it("sends only sentiment-base comments with the context, then validates, normalises and aggregates", async () => {
    const discoverer = raw({
      topics: [
        { key: "key1", name: "Audio Quality" },
        { key: "key2", name: "audio-quality" },
      ],
      assignments: [
        { commentId: "k1", disposition: "primary_topic", topicKey: "key1", topicSentiment: "negative" },
        { commentId: "k2", disposition: "primary_topic", topicKey: "key2", topicSentiment: "negative" },
      ],
    });
    const result = available(await run({ classified: comments, schema, focus: { name: "Acme", aliases: [] } }, { discoverer }));
    expect(discoverer.calls).toEqual([
      {
        comments: [
          // Sampling labels only (type, overall sentiment, focus mention); a provider workflow must not forward them.
          { id: "k1", text: "synthetic comment k1", classification: { type: "opinion", sentiment: "positive", focusMentioned: false } },
          { id: "k2", text: "synthetic comment k2", classification: { type: "opinion", sentiment: "negative", focusMentioned: false } },
        ],
        context: { focus: { name: "Acme", aliases: [] }, sentimentLabels: ["positive", "neutral", "negative"], maxTopics: 12 },
        run: { id: expect.stringMatching(/^topics-run-\d+$/), attempt: 1 },
      },
    ]);
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]).toMatchObject({ id: "topic:audio-quality", mentionCount: 2, formation: { providerKeys: ["key1", "key2"] } });
    expect(result.topics[0]!.topicSentiment.rows.map((r) => [r.label, r.count])).toEqual([
      ["positive", 0],
      ["neutral", 0],
      ["negative", 2],
    ]);
    expect(result.coverage).toMatchObject({ sentimentBase: 2, spamExcluded: 1 });
    expect(result.method).toEqual({
      providerLabel: "raw test discoverer",
      normalizationVersion: "tn1",
      commentsSent: 2,
      attempts: 1,
      parameters: {
        maxTopics: 12,
        evidencePerTopic: 3,
        smallSampleThreshold: 30,
        minTopicSizeFloor: 1,
        minTopicSizePercentOfBase: 1,
        otherWarningThresholdPercent: 35,
      },
    });
    expectAc23(result);
  });

  it("passes mixed as an allowed topic sentiment only when the schema enables it", async () => {
    const mixedSchema = createClassificationSchema({ focusConfigured: false, mixedEnabled: true });
    const discoverer = raw({
      topics,
      assignments: [
        { commentId: "k1", disposition: "primary_topic", topicKey: "key1", topicSentiment: "mixed" },
        { commentId: "k2", disposition: "other" },
      ],
    });
    const result = available(await run({ classified: comments, schema: mixedSchema }, { discoverer }));
    expect(discoverer.calls[0]!.context.sentimentLabels).toEqual(["positive", "neutral", "negative", "mixed"]);
    expect(result.topics[0]!.topicSentiment.rows.find((r) => r.label === "mixed")!.count).toBe(1);
    expectAc23(result);
  });

  it("returns an available result without topics when every comment is other or generic", async () => {
    const result = available(
      await run(
        { classified: comments, schema },
        {
          discoverer: raw({
            topics: [],
            assignments: [
              { commentId: "k1", disposition: "no_specific_topic" },
              { commentId: "k2", disposition: "other" },
            ],
          }),
        },
      ),
    );
    expect(result.topics).toEqual([]);
    expect(result.coverage).toMatchObject({ noSpecificTopic: { count: 1, base: 2 }, other: { count: 1, base: 2 } });
    expect(result.other).toMatchObject({ providerOther: 1, smallTopics: 0 });
    expectAc23(result);
  });

  it("does not call the provider when every comment is spam or there are none", async () => {
    for (const input of [[spam("s1"), spam("s2")], []]) {
      const discoverer = raw(VALID);
      const result = available(await run({ classified: input, schema }, { discoverer }));
      expect(discoverer.calls).toHaveLength(0);
      expect(result.topics).toEqual([]);
      expect(result.method).toMatchObject({ commentsSent: 0, attempts: 0 });
      expectAc23(result);
    }
  });

  it("rejects invalid classified input before calling the provider", async () => {
    const discoverer = raw(VALID);
    const bad: ClassifiedComment[] = [classified("k1", "positive"), classified("k1", "negative")];
    await expect(run({ classified: bad, schema }, { discoverer })).rejects.toThrow(ClassificationOutputError);
    expect(discoverer.calls).toHaveLength(0);
  });

  it("never changes the classifications, including overall sentiment", async () => {
    const before = structuredClone(comments);
    await run({ classified: comments, schema }, { discoverer: raw(VALID) });
    expect(comments).toEqual(before);
  });

  it("accepts any TopicDiscoverer: swapping the fake for another implementation keeps the contract", async () => {
    const fixture: TopicFixture = {
      topics: [{ key: "edit", name: "Editing" }],
      unlisted: "no_specific_topic",
      decisions: { k1: { disposition: "primary_topic", topicKey: "edit", topicSentiment: "positive" }, k2: { disposition: "primary_topic", topicKey: "edit", topicSentiment: "negative" } },
    };
    const fake = available(await run({ classified: comments, schema }, { discoverer: new FixtureTopicDiscoverer(fixture) }));
    const other = available(
      await run(
        { classified: comments, schema },
        {
          discoverer: raw(
            {
              topics: [{ key: "other-key", name: "editing" }],
              assignments: [
                { commentId: "k2", disposition: "primary_topic", topicKey: "other-key", topicSentiment: "negative" },
                { commentId: "k1", disposition: "primary_topic", topicKey: "other-key", topicSentiment: "positive" },
              ],
            },
            fake.method.providerLabel,
          ),
        },
      ),
    );
    const withoutFormation = (r: typeof fake) => ({ ...r, topics: r.topics.map((t) => ({ ...t, formation: undefined })) });
    expect(withoutFormation(other)).toEqual(withoutFormation(fake));
  });
});

describe("analyzeTopics validation and the single retry (spec.md §7.8)", () => {
  const primary = (commentId: string, topicKey: string, topicSentiment: unknown = "negative") => ({ commentId, disposition: "primary_topic", topicKey, topicSentiment });

  it("a valid first attempt makes exactly one provider call and sends no feedback", async () => {
    const discoverer = seq([VALID]);
    const result = available(await run({ classified: comments, schema }, { discoverer }));
    expect(discoverer.calls).toHaveLength(1);
    expect(discoverer.calls[0]!.feedback).toBeUndefined();
    expect(result.method.attempts).toBe(1);
    expectAc23(result);
  });

  it.each([
    ["malformed top-level structure", { results: [] }, [{ code: "invalid_output", count: 1 }]],
    ["invalid topic taxonomy", { topics: [...topics, { key: "bad", name: "!!!" }], assignments: VALID.assignments }, [{ code: "invalid_topic_name", count: 1, topicKeys: ["bad"] }]],
    [
      "missing disposition",
      { topics, assignments: [primary("k1", "key1")] },
      [{ code: "missing_assignment", count: 1, commentIds: ["k2"] }],
    ],
    [
      "unknown topic",
      { topics, assignments: [primary("k1", "nope"), VALID.assignments[1]] },
      [{ code: "unknown_topic", count: 1, commentIds: ["k1"], topicKeys: ["nope"] }],
    ],
    [
      "multiple dispositions",
      { topics, assignments: [primary("k1", "key1"), primary("k1", "key2"), VALID.assignments[1]] },
      [{ code: "multiple_primary_topics", count: 1, commentIds: ["k1"] }],
    ],
    [
      "invalid topic sentiment",
      { topics, assignments: [primary("k1", "key1", "very negative"), VALID.assignments[1]] },
      [{ code: "invalid_assignment", count: 1, commentIds: ["k1"] }],
    ],
    [
      "mixed when the schema does not enable it",
      { topics, assignments: [primary("k1", "key1", "mixed"), VALID.assignments[1]] },
      [{ code: "invalid_assignment", count: 1, commentIds: ["k1"] }],
    ],
    [
      "forbidden fields on other / no_specific_topic",
      { topics, assignments: [VALID.assignments[0], { commentId: "k2", disposition: "other", topicSentiment: "positive" }] },
      [{ code: "invalid_assignment", count: 1, commentIds: ["k2"] }],
    ],
    [
      "a disposition for a comment that was not sent (spam)",
      { topics, assignments: [...VALID.assignments, primary("s1", "key1")] },
      [{ code: "unknown_comment", count: 1 }],
    ],
  ])("%s → retried once with structured feedback; a valid second attempt is used", async (_name, invalid, expectedIssues) => {
    const discoverer = seq([invalid, VALID]);
    const result = available(await run({ classified: comments, schema }, { discoverer }));
    expect(discoverer.calls).toHaveLength(2);
    expect(discoverer.calls[0]!.feedback).toBeUndefined();
    expect(discoverer.calls[1]!.feedback).toEqual({ attempt: 1, issues: expectedIssues });
    expect(discoverer.calls[1]!.comments).toEqual(discoverer.calls[0]!.comments);
    expect(result.method.attempts).toBe(2);
    expect(result.topics.map((t) => t.id)).toEqual(["topic:audio"]);
    expectAc23(result);
  });

  it("two invalid attempts → unavailable after exactly two calls, with no partial topics", async () => {
    const partlyValid = { topics, assignments: [primary("k1", "key1")] };
    const discoverer = seq([partlyValid]);
    const result = await run({ classified: comments, schema }, { discoverer });
    expect(discoverer.calls).toHaveLength(MAX_TOPIC_ATTEMPTS);
    expect(result).toEqual({
      status: "unavailable",
      reason: "TOPICS_UNAVAILABLE",
      issues: [
        { code: "missing_assignment", commentId: "k2", attempt: 1 },
        { code: "missing_assignment", commentId: "k2", attempt: 2 },
      ],
      method: expect.objectContaining({ attempts: 2, commentsSent: 2 }),
    });
    for (const key of ["topics", "other", "coverage", "warnings"]) expect(Object.keys(result)).not.toContain(key);
  });

  it("provider errors are retried once; the message is never copied", async () => {
    const recovered = seq([new Error("secret-ish upstream detail"), VALID]);
    expect(available(await run({ classified: comments, schema }, { discoverer: recovered })).method.attempts).toBe(2);
    expect(recovered.calls[1]!.feedback).toEqual({ attempt: 1, issues: [{ code: "provider_error", count: 1 }] });

    const failing = seq([new Error("secret-ish upstream detail")], "failing");
    const result = await run({ classified: comments, schema }, { discoverer: failing });
    expect(failing.calls).toHaveLength(2);
    expect(result).toEqual({
      status: "unavailable",
      reason: "TOPICS_UNAVAILABLE",
      issues: [
        { code: "provider_error", attempt: 1 },
        { code: "provider_error", attempt: 2 },
      ],
      method: expect.objectContaining({ providerLabel: "failing", attempts: 2 }),
    });
    expect(JSON.stringify([result, failing.calls])).not.toContain("secret-ish");
  });

  it("too many topics on both attempts → unavailable", async () => {
    const many = { topics: ["key1", "key2", "key3"].map((k) => ({ key: k, name: `Topic ${k}` })), assignments: VALID.assignments };
    const result = await run({ classified: comments, schema }, { discoverer: seq([many]), params: { maxTopics: 2 } });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.issues.map((i) => [i.attempt, i.code])).toEqual([
      [1, "too_many_topics"],
      [2, "too_many_topics"],
    ]);
  });
});

describe("structured rejections thrown by a discoverer", () => {
  it("keep their known codes (sanitised) in feedback and diagnostics instead of provider_error", async () => {
    const thrown = new TopicDiscoveryOutputError([
      { code: "missing_definition", index: 0, topicKey: "audio", detail: "PROVIDER DETAIL TEXT" },
      { code: "duplicate_topic_name", index: 1, topicKey: "has spaces: PROVIDER KEY TEXT" },
      { code: "missing_assignment", commentId: "not-sent: PROVIDER ID TEXT" },
      { code: "made_up_code" } as unknown as TopicIssue,
    ]);
    const discoverer = seq([thrown]);
    const result = await run({ classified: comments, schema }, { discoverer });
    if (result.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.issues.filter((i) => i.attempt === 1)).toEqual([
      { code: "missing_definition", index: 0, topicKey: "audio", attempt: 1 },
      { code: "duplicate_topic_name", index: 1, attempt: 1 },
      { code: "missing_assignment", attempt: 1 },
      { code: "provider_error", attempt: 1 },
    ]);
    expect(discoverer.calls[1]!.feedback).toEqual({
      attempt: 1,
      issues: [
        { code: "duplicate_topic_name", count: 1 },
        { code: "missing_assignment", count: 1 },
        { code: "missing_definition", count: 1, topicKeys: ["audio"] },
        { code: "provider_error", count: 1 },
      ],
    });
    expect(JSON.stringify([result, discoverer.calls[1]!.feedback])).not.toContain("PROVIDER");
  });

  it("an empty structured rejection is a provider error; other exceptions stay provider errors without their message", async () => {
    const empty = await run({ classified: comments, schema }, { discoverer: seq([new TopicDiscoveryOutputError([])]) });
    expect(empty.status === "unavailable" && empty.issues.map((i) => i.code)).toEqual(["provider_error", "provider_error"]);
    const plain = await run({ classified: comments, schema }, { discoverer: seq([new Error("PROVIDER SECRET")]) });
    expect(JSON.stringify(plain)).not.toContain("PROVIDER SECRET");
  });
});

describe("retry feedback contains structured validation information only", () => {
  it("has codes, counts, analysed-comment IDs and identifier-like keys; never text, raw output, details or messages", async () => {
    const hostile = {
      topics: [
        { key: "key1", name: "Audio" },
        { key: "bad", name: "!!!", description: "RAW PROVIDER DESCRIPTION" },
      ],
      assignments: [
        { commentId: "k1", disposition: "primary_topic", topicKey: "ignore previous instructions", topicSentiment: "negative" },
        { commentId: "k2", disposition: "primary_topic", topicKey: "key1", topicSentiment: "RAW SENTIMENT TEXT" },
        { commentId: "not-a-comment: synthetic comment k1", disposition: "other" },
        "RAW STRING ENTRY",
      ],
      extra: "RAW TOP LEVEL",
    };
    const nearlyValid = { ...hostile, extra: undefined };
    delete (nearlyValid as { extra?: unknown }).extra;
    const discoverer = seq([nearlyValid, VALID]);
    await run({ classified: comments, schema }, { discoverer });
    const feedback = discoverer.calls[1]!.feedback!;
    expect(feedback).toEqual({
      attempt: 1,
      issues: [
        { code: "invalid_assignment", count: 2, commentIds: ["k2"] },
        { code: "invalid_topic_name", count: 1, topicKeys: ["bad"] },
        { code: "unknown_comment", count: 1 },
        { code: "unknown_topic", count: 1, commentIds: ["k1"] },
      ],
    });
    const json = JSON.stringify(feedback);
    for (const leaked of ["synthetic comment", "RAW", "ignore previous", "not-a-comment", "Audio", "detail", "index"]) expect(json).not.toContain(leaked);

    const malformed = seq([hostile, VALID]);
    await run({ classified: comments, schema }, { discoverer: malformed });
    expect(malformed.calls[1]!.feedback).toEqual({ attempt: 1, issues: [{ code: "invalid_output", count: 1 }] });
    expect(JSON.stringify(malformed.calls[1]!.feedback)).not.toContain("extra");
  });
});

describe("FixtureTopicDiscoverer with an attempt sequence", () => {
  const valid: TopicFixture = { topics: [{ key: "audio", name: "Audio" }], unlisted: "no_specific_topic", decisions: { k1: { disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" } } };
  const invalid: TopicFixture = { ...valid, unlisted: "omit" };

  it("first attempt invalid, second valid → available; the fake records the feedback", async () => {
    const discoverer = new FixtureTopicDiscoverer([invalid, valid]);
    const result = available(await run({ classified: comments, schema }, { discoverer }));
    expect(discoverer.calls).toBe(2);
    expect(discoverer.feedbackReceived).toEqual([undefined, { attempt: 1, issues: [{ code: "missing_assignment", count: 1, commentIds: ["k2"] }] }]);
    expectAc23(result);
  });

  it("both attempts invalid → unavailable", async () => {
    const discoverer = new FixtureTopicDiscoverer(invalid);
    const result = await run({ classified: comments, schema }, { discoverer });
    expect(result.status).toBe("unavailable");
    expect(discoverer.calls).toBe(2);
  });
});

describe("analyzeTopics end to end: classified comments → fake discovery → topics × topic sentiment → evidence", () => {
  // Explicit test mapping over m2-synthetic ids: one primary topic per comment and the sentiment toward that topic.
  // Spam comment m2-c35 is mapped too: it is never sent to discovery and never counted.
  const fixture: TopicFixture = {
    topics: [
      { key: "sponsor", name: "Sponsor segment", description: "Comments about the sponsor read and its placement.", exampleCommentIds: ["m2-c27"] },
      { key: "reliability", name: "Acme VPN reliability" },
      { key: "reliability-dup", name: "acme-vpn  Reliability!" },
      { key: "pricing", name: "Acme VPN pricing" },
      { key: "audio", name: "Audio quality" },
      { key: "testing", name: "Testing depth" },
      { key: "followups", name: "Follow-up content requests" },
      { key: "crypto", name: "Crypto signals" },
    ],
    unlisted: "no_specific_topic",
    decisions: {
      "m2-c03": { disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" },
      "m2-c30": { disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" },
      "m2-c14": { disposition: "primary_topic", topicKey: "audio", topicSentiment: "neutral" },
      "m2-c05": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
      // Overall positive (praise for the product), but negative toward the sponsor segment's placement.
      "m2-c07": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
      "m2-c08": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
      "m2-c10": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "neutral" },
      "m2-c27": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
      "m2-c53": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "positive" },
      "m2-c06": { disposition: "primary_topic", topicKey: "reliability", topicSentiment: "negative" },
      "m2-c09": { disposition: "primary_topic", topicKey: "reliability", topicSentiment: "positive" },
      "m2-c11": { disposition: "primary_topic", topicKey: "reliability-dup", topicSentiment: "negative" },
      "m2-c13": { disposition: "primary_topic", topicKey: "reliability-dup", topicSentiment: "neutral" },
      "m2-c12": { disposition: "primary_topic", topicKey: "pricing", topicSentiment: "positive" },
      "m2-c56": { disposition: "primary_topic", topicKey: "pricing", topicSentiment: "neutral" },
      "m2-c22": { disposition: "primary_topic", topicKey: "testing", topicSentiment: "negative" },
      "m2-c33": { disposition: "primary_topic", topicKey: "testing", topicSentiment: "negative" },
      "m2-c55": { disposition: "primary_topic", topicKey: "testing", topicSentiment: "negative" },
      "m2-c16": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
      // Overall positive (praise), neutral toward the follow-up request itself.
      "m2-c17": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
      "m2-c18": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
      "m2-c57": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
      "m2-c35": { disposition: "primary_topic", topicKey: "crypto", topicSentiment: "positive" },
    },
  };
  const schemaUsed = createClassificationSchema({ focusConfigured: false });

  async function classifiedFixture() {
    const outcome = await runAnalysis({ videoId: "dQw4w9WgXcQ" }, goldDeps({ params: { minAnalyzableForReport: 1, lowVolumeWarningThreshold: 1, smallSampleThreshold: 30 } }));
    if (outcome.status !== "completed") throw new Error("expected a completed analysis");
    return outcome.classified;
  }

  it("produces normalised topics with counts, topic-sentiment percentages, evidence and formation metadata", async () => {
    const input = await classifiedFixture();
    const result = available(await run({ classified: input, schema: schemaUsed }, { discoverer: new FixtureTopicDiscoverer(fixture) }));
    const summary = result.topics.map((t) => [t.id, t.mentionCount, t.topicSentiment.rows.map((r) => `${r.label}:${r.count}/${r.percent}%`).join(" ")]);
    expect(summary).toEqual([
      ["topic:sponsor-segment", 6, "positive:1/17% neutral:1/16% negative:4/67%"],
      ["topic:acme-vpn-reliability", 4, "positive:1/25% neutral:1/25% negative:2/50%"],
      ["topic:follow-up-content-requests", 4, "positive:0/0% neutral:4/100% negative:0/0%"],
      ["topic:audio-quality", 3, "positive:0/0% neutral:1/33% negative:2/67%"],
      ["topic:testing-depth", 3, "positive:0/0% neutral:0/0% negative:3/100%"],
      ["topic:acme-vpn-pricing", 2, "positive:1/50% neutral:1/50% negative:0/0%"],
    ]);

    // m2-c07 is positive overall but counts as negative under the sponsor segment; its classification is unchanged.
    const sentimentOf = (id: string) => input.find((c) => c.comment.id === id)!.classification.sentiment;
    expect(sentimentOf("m2-c07")).toBe("positive");
    expect(["m2-c05", "m2-c08", "m2-c27"].map(sentimentOf)).toEqual(["negative", "negative", "negative"]);
    // m2-c03 agrees: negative overall and negative toward audio quality.
    expect(sentimentOf("m2-c03")).toBe("negative");

    const sponsor = result.topics[0]!;
    expect(sponsor.description).toBe("Comments about the sponsor read and its placement.");
    expect(sponsor.evidence).toEqual([
      { commentId: "m2-c27", topicSentiment: "negative", rank: 1, providerExample: true },
      { commentId: "m2-c53", topicSentiment: "positive", rank: 2, providerExample: false },
      { commentId: "m2-c10", topicSentiment: "neutral", rank: 3, providerExample: false },
    ]);
    expect(result.topics.every((t) => t.smallSample)).toBe(true);

    expect(result.topics[1]!.formation).toEqual({
      sourceNames: ["Acme VPN reliability", "acme-vpn  Reliability!"],
      providerKeys: ["reliability", "reliability-dup"],
      providerExampleIds: [],
    });
    expect(result.droppedTopics).toEqual([{ id: "topic:crypto-signals", name: "crypto signals", reason: "no_mentions" }]);
    expect(result.coverage).toEqual({
      sentimentBase: 56,
      spamExcluded: 4,
      namedTopics: { count: 22, base: 56, percent: 39 },
      other: { count: 0, base: 56, percent: 0 },
      noSpecificTopic: { count: 34, base: 56, percent: 61 },
    });
    expect(result.topics.reduce((sum, t) => sum + t.mentionCount, 0)).toBe(result.coverage.namedTopics.count);
    expect(result.warnings).toEqual([
      {
        code: "HIGH_OTHER_SHARE",
        other: { count: 0, base: 56, percent: 0 },
        noSpecificTopic: { count: 34, base: 56, percent: 61 },
        combined: { count: 34, base: 56, percent: 61 },
        thresholdPercent: 35,
      },
    ]);
    expect(result.method.attempts).toBe(1);
    expectAc23(result);
  });

  it("stores no comment text in the result, leaves the classifications unchanged and is deterministic", async () => {
    const input = await classifiedFixture();
    const before = structuredClone(input);
    const first = await run({ classified: input, schema: schemaUsed }, { discoverer: new FixtureTopicDiscoverer(fixture) });
    const second = await run({ classified: input, schema: schemaUsed }, { discoverer: new FixtureTopicDiscoverer(fixture) });
    expect(input).toEqual(before);
    expect(second).toEqual(first);
    const json = JSON.stringify(first);
    for (const c of input) if (c.comment.text.length > 12) expect(json, c.comment.id).not.toContain(c.comment.text);
  });

  it("calls the discoverer exactly once with the 56 sentiment-base comments", async () => {
    const discoverer = new FixtureTopicDiscoverer(fixture);
    const spy = vi.spyOn(discoverer, "discoverTopics");
    await run({ classified: await classifiedFixture(), schema: schemaUsed }, { discoverer });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].comments).toHaveLength(56);
    expect(spy.mock.calls[0]![0].comments.some((c) => c.id === "m2-c35")).toBe(false);
  });
});
