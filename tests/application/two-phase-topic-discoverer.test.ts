import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FixtureDecision } from "../../src/adapters/fakes/fixture-topic-discoverer";
import { FixtureTopicAssigner, FixtureTopicTaxonomyGenerator, type FixtureAssignerStep } from "../../src/adapters/fakes/fixture-topic-phases";
import { analyzeTopics } from "../../src/application/analyze-topics";
import { analyzeVideoSync, type AnalyzeVideoDeps } from "../../src/application/analyze-video-sync";
import { TwoPhaseTopicDiscoverer, type TwoPhaseTopicDiscovererOptions } from "../../src/application/two-phase-topic-discoverer";
import { createClassificationSchema } from "../../src/core/classification/schema";
import type { ClassifiedComment, SentimentLabel } from "../../src/core/domain/types";
import { DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, discoveryCandidateOf, selectDiscoverySample } from "../../src/core/topics/discovery-sample";
import { validateTopicAttempt } from "../../src/core/topics/topic-result";
import type { TopicAnalysis } from "../../src/core/topics/types";
import { Report } from "../../src/web/Report";
import { goldDeps, VALID_URL, reportProps } from "../helpers";
import { classified, spam } from "../topic-helpers";

const schema = createClassificationSchema({ focusConfigured: false });
const SENTIMENTS: SentimentLabel[] = ["positive", "neutral", "negative"];
/** 12 eligible comments (overall sentiment cycles) plus one spam comment that must never reach either phase. */
const comments: ClassifiedComment[] = [...Array.from({ length: 12 }, (_, i) => classified(`k${String(i + 1).padStart(2, "0")}`, SENTIMENTS[i % 3]!)), spam("s01")];
const eligible = comments.filter((c) => c.classification.type !== "spam_irrelevant");
const SAMPLE = { seed: "topic-seed", maxSize: 6 };
const sampleIds = selectDiscoverySample(eligible.map(discoveryCandidateOf), { ...DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, ...SAMPLE }).commentIds;

const TAXONOMY = {
  topics: [
    { key: "audio", name: "Audio Quality", definition: "Comments about sound, microphone or mixing." },
    { key: "price", name: "Pricing", definition: "Comments about what the product costs." },
  ],
};
const topicOf = (topicKey: string, topicSentiment: SentimentLabel): FixtureDecision => ({ disposition: "primary_topic", topicKey, topicSentiment });
/** k01–k04 audio (negative toward the topic, whatever their overall sentiment), k05–k06 pricing, k07 other, rest generic. */
const DECISIONS: Record<string, FixtureDecision> = {
  k01: topicOf("audio", "negative"),
  k02: topicOf("audio", "negative"),
  k03: topicOf("audio", "negative"),
  k04: topicOf("audio", "negative"),
  k05: topicOf("price", "positive"),
  k06: topicOf("price", "neutral"),
  k07: { disposition: "other" },
};
const VALID_ASSIGNMENT: FixtureAssignerStep = { decisions: DECISIONS, unlisted: "no_specific_topic" };

function setup(taxonomySteps: unknown[], assignerSteps: FixtureAssignerStep[], extra: Partial<TwoPhaseTopicDiscovererOptions> = {}) {
  const generator = new FixtureTopicTaxonomyGenerator(taxonomySteps);
  const assigner = new FixtureTopicAssigner(assignerSteps);
  const discoverer = new TwoPhaseTopicDiscoverer({ generator, assigner, sample: SAMPLE, ...extra });
  const run = () => analyzeTopics({ classified: comments, schema }, { discoverer, params: { minTopicSizeFloor: 1 } });
  return { generator, assigner, discoverer, run };
}
const available = (r: TopicAnalysis) => {
  if (r.status !== "available") throw new Error(`expected available, got ${JSON.stringify(r)}`);
  return r;
};
function expectAc23(r: Extract<TopicAnalysis, { status: "available" }>) {
  const c = r.coverage;
  expect(c.namedTopics.count + c.other.count + c.noSpecificTopic.count).toBe(c.sentimentBase);
  expect(Object.keys(c)).not.toContain("assignmentRejected");
}

describe("two-phase discoverer: happy path", () => {
  it("samples deterministically, discovers on the sample, validates, assigns everything, and is available (AC-23)", async () => {
    const { generator, assigner, run } = setup([TAXONOMY], [VALID_ASSIGNMENT]);
    const result = available(await run());
    expect(generator.requests).toHaveLength(1);
    expect(assigner.requests).toHaveLength(1);
    expect(generator.requests[0]!.sample.map((c) => c.id)).toEqual(sampleIds);
    expect(sampleIds).toHaveLength(6);
    expect(assigner.requests[0]!.comments.map((c) => c.id)).toEqual(eligible.map((c) => c.comment.id));
    expect(result.method.attempts).toBe(1);
    expect(result.topics.map((t) => [t.id, t.mentionCount, t.description])).toEqual([
      ["topic:audio-quality", 4, "Comments about sound, microphone or mixing."],
      ["topic:pricing", 2, "Comments about what the product costs."],
    ]);
    expect(result.other).toMatchObject({ providerOther: 1, smallTopics: 0 });
    expect(result.coverage.noSpecificTopic.count).toBe(5);
    expectAc23(result);
  });

  it("is deterministic under deterministic fakes", async () => {
    const a = await setup([TAXONOMY], [VALID_ASSIGNMENT]).run();
    const b = await setup([TAXONOMY], [VALID_ASSIGNMENT]).run();
    expect(b).toEqual(a);
  });
});

describe("two-phase discoverer: phase boundaries", () => {
  it("discovery receives only the sample's IDs and text: no classification labels, no spam, no other comments", async () => {
    const { generator, run } = setup([TAXONOMY], [VALID_ASSIGNMENT]);
    await run();
    const request = generator.requests[0]!;
    for (const c of request.sample) expect(Object.keys(c).sort()).toEqual(["id", "text"]);
    // The context carries only the allowed label vocabulary (frozen); no comment carries its own labels.
    expect(JSON.stringify(request.sample)).not.toMatch(/classification|sentiment|positive|negative|neutral|opinion|focusMentioned/);
    expect(request.sample.map((c) => c.id)).not.toContain("s01");
    expect(request.feedback).toBeUndefined();
  });

  it("assignment receives the validated taxonomy (keys, normalised names, definitions) and no labels", async () => {
    const { assigner, run } = setup([TAXONOMY], [VALID_ASSIGNMENT]);
    await run();
    const request = assigner.requests[0]!;
    expect(request.taxonomy).toEqual([
      { key: "audio", name: "audio quality", definition: "Comments about sound, microphone or mixing." },
      { key: "price", name: "pricing", definition: "Comments about what the product costs." },
    ]);
    for (const c of request.comments) expect(Object.keys(c).sort()).toEqual(["id", "text"]);
    expect(request.comments.map((c) => c.id)).not.toContain("s01");
  });

  it("topic sentiment comes only from assignment, never from overall sentiment", async () => {
    // k01 is positive overall, k02 neutral, k03 negative: all negative toward audio quality.
    const result = available(await setup([TAXONOMY], [VALID_ASSIGNMENT]).run());
    expect(["k01", "k02", "k03"].map((id) => comments.find((c) => c.comment.id === id)!.classification.sentiment)).toEqual(["positive", "neutral", "negative"]);
    expect(result.topics[0]!.topicSentiment.rows.map((r) => [r.label, r.count])).toEqual([
      ["positive", 0],
      ["neutral", 0],
      ["negative", 4],
    ]);
  });
});

describe("two-phase discoverer: taxonomy failure", () => {
  const INVALID_TAXONOMY = {
    topics: [
      { key: "audio", name: "Audio Quality", definition: "" },
      { key: "audio-2", name: "audio-quality", definition: "Sound." },
    ],
  };

  it("never assigns against an invalid taxonomy; rediscovers from the same sample with the taxonomy feedback", async () => {
    const { generator, assigner, run } = setup([INVALID_TAXONOMY, TAXONOMY], [VALID_ASSIGNMENT]);
    const result = available(await run());
    expect(generator.requests).toHaveLength(2);
    expect(assigner.requests).toHaveLength(1);
    expect(generator.requests[1]!.sample).toEqual(generator.requests[0]!.sample);
    expect(generator.requests[1]!.feedback).toEqual({
      attempt: 1,
      issues: [
        { code: "duplicate_topic_name", count: 1, topicKeys: ["audio-2"] },
        { code: "missing_definition", count: 1, topicKeys: ["audio"] },
      ],
    });
    expect(assigner.requests[0]!.feedback).toBeUndefined();
    expect(result.method.attempts).toBe(2);
    expectAc23(result);
  });

  it("taxonomy failing twice → TOPICS_UNAVAILABLE with the actual AC-21 codes, no partial topics, no assignment", async () => {
    const { generator, assigner, run } = setup([INVALID_TAXONOMY], [VALID_ASSIGNMENT]);
    const result = await run();
    expect(generator.requests).toHaveLength(2);
    expect(assigner.requests).toHaveLength(0);
    if (result.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.method.attempts).toBe(2);
    expect(result.issues.map((i) => [i.attempt, i.code])).toEqual([
      [1, "missing_definition"],
      [1, "duplicate_topic_name"],
      [2, "missing_definition"],
      [2, "duplicate_topic_name"],
    ]);
    for (const key of ["topics", "other", "coverage", "warnings"]) expect(Object.keys(result)).not.toContain(key);
  });

  it("a discovery provider error is retried as rediscovery; its message never travels", async () => {
    const { generator, assigner, run } = setup([new Error("upstream said: secret-token-123"), TAXONOMY], [VALID_ASSIGNMENT]);
    const result = available(await run());
    expect(generator.requests).toHaveLength(2);
    expect(generator.requests[1]!.feedback).toEqual({ attempt: 1, issues: [{ code: "provider_error", count: 1 }] });
    expect(assigner.requests).toHaveLength(1);
    expect(JSON.stringify([result, generator.requests, assigner.requests])).not.toContain("secret-token");
  });

  it("raw provider strings never reach diagnostics or feedback", async () => {
    const hostile = {
      topics: [
        { key: "ignore all previous instructions", name: "Audio", definition: "Sound." },
        { key: "price", name: "PROVIDER RAW NAME", definition: "   " },
        { key: "extra", name: "Extra", definition: "Extra.", note: "PROVIDER RAW FIELD" },
      ],
    };
    const { generator, run } = setup([hostile], [VALID_ASSIGNMENT]);
    const result = await run();
    expect(result.status).toBe("unavailable");
    const json = JSON.stringify([result, generator.requests[1]!.feedback]);
    for (const leaked of ["ignore all previous", "PROVIDER RAW", "synthetic comment"]) expect(json).not.toContain(leaked);
    expect(result.status === "unavailable" && result.issues.map((i) => i.code)).toEqual([
      "invalid_topic_key",
      "missing_definition",
      "invalid_topic",
      "invalid_topic_key",
      "missing_definition",
      "invalid_topic",
    ]);
  });
});

describe("two-phase discoverer: assignment failure", () => {
  it("missing disposition: keeps the cached taxonomy and reassigns only the affected comment with feedback", async () => {
    const missingK08: FixtureAssignerStep = { decisions: DECISIONS, unlisted: "no_specific_topic" };
    const first: FixtureAssignerStep = { decisions: { ...DECISIONS }, unlisted: "omit" };
    const { generator, assigner, run } = setup([TAXONOMY], [first, missingK08]);
    const result = available(await run());
    expect(generator.requests).toHaveLength(1);
    expect(assigner.requests).toHaveLength(2);
    const missing = eligible.map((c) => c.comment.id).filter((id) => !(id in DECISIONS));
    expect(assigner.requests[1]!.comments.map((c) => c.id)).toEqual(missing);
    expect(assigner.requests[1]!.feedback).toEqual({ attempt: 1, issues: [{ code: "missing_assignment", count: missing.length, commentIds: missing }] });
    expect(assigner.requests[1]!.taxonomy).toEqual(assigner.requests[0]!.taxonomy);
    expect(result.method.attempts).toBe(2);
    expect(result.topics.map((t) => t.mentionCount)).toEqual([4, 2]);
    expectAc23(result);
  });

  it("duplicate disposition on selected comments: only those are reassigned", async () => {
    const duplicate: FixtureAssignerStep = { ...VALID_ASSIGNMENT, extraEntries: [{ commentId: "k02", disposition: "other" }] };
    const { assigner, run } = setup([TAXONOMY], [duplicate, VALID_ASSIGNMENT]);
    available(await run());
    expect(assigner.requests[1]!.comments.map((c) => c.id)).toEqual(["k02"]);
    expect(assigner.requests[1]!.feedback!.issues).toEqual([{ code: "multiple_primary_topics", count: 1, commentIds: ["k02"] }]);
  });

  it("unknown topic key: only that comment is reassigned", async () => {
    const unknown: FixtureAssignerStep = { decisions: { ...DECISIONS, k05: topicOf("made-up", "positive") }, unlisted: "no_specific_topic" };
    const { assigner, run } = setup([TAXONOMY], [unknown, VALID_ASSIGNMENT]);
    const result = available(await run());
    expect(assigner.requests[1]!.comments.map((c) => c.id)).toEqual(["k05"]);
    expect(assigner.requests[1]!.feedback!.issues).toEqual([{ code: "unknown_topic", count: 1, commentIds: ["k05"], topicKeys: ["made-up"] }]);
    expect(result.topics.map((t) => [t.id, t.mentionCount])).toEqual([
      ["topic:audio-quality", 4],
      ["topic:pricing", 2],
    ]);
  });

  it("an issue no comment can be blamed for → every comment is reassigned", async () => {
    const junk: FixtureAssignerStep = { ...VALID_ASSIGNMENT, extraEntries: ["NOT AN ENTRY"] };
    const { assigner, run } = setup([TAXONOMY], [junk, VALID_ASSIGNMENT]);
    available(await run());
    expect(assigner.requests[1]!.comments).toHaveLength(12);
  });

  it("assignmentRetry 'all' reassigns every comment even when the issues name comments", async () => {
    const first: FixtureAssignerStep = { decisions: DECISIONS, unlisted: "omit" };
    const { assigner, run } = setup([TAXONOMY], [first, VALID_ASSIGNMENT], { assignmentRetry: "all" });
    available(await run());
    expect(assigner.requests[1]!.comments).toHaveLength(12);
    expect(assigner.requests[1]!.feedback!.issues[0]!.code).toBe("missing_assignment");
  });

  it("an assignment provider error keeps the taxonomy and reassigns everything", async () => {
    const { generator, assigner, run } = setup([TAXONOMY], [new Error("assigner down"), VALID_ASSIGNMENT]);
    available(await run());
    expect(generator.requests).toHaveLength(1);
    expect(assigner.requests).toHaveLength(2);
    expect(assigner.requests[1]!.comments).toHaveLength(12);
  });

  it("assignment failing twice → TOPICS_UNAVAILABLE, no rediscovery, no partial topics", async () => {
    const first: FixtureAssignerStep = { decisions: DECISIONS, unlisted: "omit" };
    const { generator, assigner, run } = setup([TAXONOMY], [first]);
    const result = await run();
    expect(generator.requests).toHaveLength(1);
    expect(assigner.requests).toHaveLength(2);
    if (result.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.method.attempts).toBe(2);
    expect(new Set(result.issues.map((i) => i.code))).toEqual(new Set(["missing_assignment"]));
    expect(Object.keys(result)).not.toContain("topics");
  });
});

describe("two-phase discoverer: attempt bounds and errors", () => {
  it.each([
    ["invalid taxonomy", [{ topics: [{ key: "audio", name: "Audio", definition: "" }] }], [VALID_ASSIGNMENT]],
    ["invalid assignment", [TAXONOMY], [{ decisions: {}, unlisted: "omit" } as FixtureAssignerStep]],
    ["failing providers", [new Error("x")], [new Error("y")]],
  ])("%s: never more than two outer attempts, two discovery calls or two assignment calls", async (_name, taxonomySteps, assignerSteps) => {
    const { generator, assigner, run } = setup(taxonomySteps as unknown[], assignerSteps as FixtureAssignerStep[]);
    const result = await run();
    expect(result.status).toBe("unavailable");
    expect(result.method.attempts).toBe(2);
    expect(generator.requests.length).toBeLessThanOrEqual(2);
    expect(assigner.requests.length).toBeLessThanOrEqual(2);
  });

  it("a non-array assignment response is an invalid output, retried once", async () => {
    const assigner = { label: "odd", calls: 0, async assignTopics() { this.calls += 1; return this.calls === 1 ? ({ nope: true } as unknown as unknown[]) : [] } };
    const generator = new FixtureTopicTaxonomyGenerator([TAXONOMY]);
    const discoverer = new TwoPhaseTopicDiscoverer({ generator, assigner, sample: SAMPLE });
    const result = await analyzeTopics({ classified: comments, schema }, { discoverer, params: { minTopicSizeFloor: 1 } });
    expect(result.status === "unavailable" && result.issues.map((i) => [i.attempt, i.code])[0]).toEqual([1, "invalid_output"]);
    expect(assigner.calls).toBe(2);
  });

  it("an unexpected engine error is not relabelled as a provider issue: it propagates, and the pipeline contains it", async () => {
    const { run: _unused, discoverer } = setup([TAXONOMY], [VALID_ASSIGNMENT]);
    await expect(analyzeTopics({ classified: comments, schema }, { discoverer, params: { minTopicSizeFloor: 1, evidencePerTopic: -1 } })).rejects.toThrow(RangeError);
  });
});

describe("two-phase discoverer in the analysis pipeline", () => {
  // m2-synthetic: 56 eligible comments, minimum topic size 10.
  const sponsor = ["m2-c05", "m2-c07", "m2-c08", "m2-c09", "m2-c10", "m2-c12", "m2-c27", "m2-c28", "m2-c53", "m2-c56"];
  const params = { minAnalyzableForReport: 1, lowVolumeWarningThreshold: 1, smallSampleThreshold: 30 };
  const report = async (discoverer: TwoPhaseTopicDiscoverer) => {
    const result = await analyzeVideoSync({ url: VALID_URL }, goldDeps({ params, topics: { discoverer } } as Partial<AnalyzeVideoDeps>));
    if (result.status !== "ok") throw new Error(result.status);
    return result.report;
  };

  it("an available two-phase result flows into the report", async () => {
    const generator = new FixtureTopicTaxonomyGenerator([{ topics: [{ key: "sponsor", name: "Sponsor segment", definition: "The sponsor read and its placement." }] }]);
    const assigner = new FixtureTopicAssigner([{ decisions: Object.fromEntries(sponsor.map((id) => [id, topicOf("sponsor", "negative")])), unlisted: "no_specific_topic" }]);
    const r = await report(new TwoPhaseTopicDiscoverer({ generator, assigner, sample: { seed: "pipeline" } }));
    if (r.topics.status !== "available") throw new Error("expected available");
    expect(r.topics.topics.map((t) => [t.name, t.count.count])).toEqual([["Sponsor segment", 10]]);
    expect(generator.requests[0]!.sample).toHaveLength(56);
    // Methodology (spec §8.3): sample size, base, strategy, version and seed reach the view and the page.
    expect(r.topics.discoverySample).toEqual({ size: 56, eligible: 56, usedAll: true, strategy: "seeded_stratified", version: "ds1", seed: "pipeline" });
    const html = renderToStaticMarkup(createElement(Report, reportProps(r)));
    expect(html).toMatch(/Discovery sample: (<!-- -->)?56(<!-- -->)? of (<!-- -->)?56/);
  });

  it("taxonomy failing twice leaves the rest of the report intact with TOPICS_UNAVAILABLE", async () => {
    const generator = new FixtureTopicTaxonomyGenerator([{ topics: [{ key: "sponsor", name: "Sponsor segment", definition: "" }] }]);
    const assigner = new FixtureTopicAssigner([{ decisions: {}, unlisted: "no_specific_topic" }]);
    const r = await report(new TwoPhaseTopicDiscoverer({ generator, assigner, sample: { seed: "pipeline" } }));
    expect(r.topics.status).toBe("unavailable");
    expect(r.warnings.map((w) => w.code)).toContain("TOPICS_UNAVAILABLE");
    expect(r.commentsAnalysed).toBe(60);
    expect(assigner.requests).toHaveLength(0);
  });
});

describe("discovery sample methodology (spec §8.3)", () => {
  const EXPECTED_SAMPLE_METHOD = {
    version: "ds1",
    strategy: "seeded_stratified",
    population: "non_spam_topic_base",
    seed: "topic-seed",
    eligible: 12,
    size: 6,
    usedAll: false,
    parameters: { maxSize: 6, focusReservePercent: 15, trivialMaxPercent: 10, shortWordThreshold: 4, minPerSentimentLabel: 10 },
  };

  it("an available result records how the sample was drawn, without comment IDs or text", async () => {
    const result = available(await setup([TAXONOMY], [VALID_ASSIGNMENT]).run());
    const sample = result.method.discoverySample!;
    expect(sample).toMatchObject(EXPECTED_SAMPLE_METHOD);
    expect(sample.strata.reduce((s, x) => s + x.available, 0)).toBe(12);
    expect(sample.strata.reduce((s, x) => s + x.selected, 0)).toBe(6);
    expect(JSON.stringify(result.method)).not.toMatch(/k\d\d|synthetic comment/);
  });

  it("the same input and seed give the same sample metadata; a different seed is recorded as such", async () => {
    const a = available(await setup([TAXONOMY], [VALID_ASSIGNMENT]).run()).method.discoverySample;
    const b = available(await setup([TAXONOMY], [VALID_ASSIGNMENT]).run()).method.discoverySample;
    expect(b).toEqual(a);
    const generator = new FixtureTopicTaxonomyGenerator([TAXONOMY]);
    const other = new TwoPhaseTopicDiscoverer({ generator, assigner: new FixtureTopicAssigner([VALID_ASSIGNMENT]), sample: { ...SAMPLE, seed: "another-seed" } });
    const c = available(await analyzeTopics({ classified: comments, schema }, { discoverer: other, params: { minTopicSizeFloor: 1 } })).method.discoverySample!;
    expect(c.seed).toBe("another-seed");
    expect(generator.requests[0]!.sample.map((x) => x.id)).toEqual(
      selectDiscoverySample(eligible.map(discoveryCandidateOf), { ...DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, ...SAMPLE, seed: "another-seed" }).commentIds,
    );
  });

  it("an unavailable result records the sample too", async () => {
    const result = await setup([{ topics: [{ key: "audio", name: "Audio", definition: "" }] }], [VALID_ASSIGNMENT]).run();
    expect(result.method.discoverySample).toMatchObject(EXPECTED_SAMPLE_METHOD);
  });

  it("a discoverer without sampling records none; malformed methodology from a discoverer is dropped", async () => {
    const plain = { label: "plain", discoverTopics: async () => ({ topics: [], assignments: eligible.map((c) => ({ commentId: c.comment.id, disposition: "no_specific_topic" })) }) };
    expect(available(await analyzeTopics({ classified: comments, schema }, { discoverer: plain })).method).not.toHaveProperty("discoverySample");
    const lying = { ...plain, finishRun: () => ({ discoverySample: { ...EXPECTED_SAMPLE_METHOD, strata: [], note: "k01 synthetic comment" } as never }) };
    expect(available(await analyzeTopics({ classified: comments, schema }, { discoverer: lying })).method).not.toHaveProperty("discoverySample");
  });
});

describe("run identity and lifecycle", () => {
  it("both attempts share one opaque run ID; each analysis gets a new one; phase providers never see it", async () => {
    const first: FixtureAssignerStep = { decisions: DECISIONS, unlisted: "omit" };
    const generator = new FixtureTopicTaxonomyGenerator([TAXONOMY]);
    // Each analysis: first assignment incomplete, retry complete.
    const assigner = new FixtureTopicAssigner([first, VALID_ASSIGNMENT, first, VALID_ASSIGNMENT]);
    const inner = new TwoPhaseTopicDiscoverer({ generator, assigner, sample: SAMPLE });
    const seen: { id: string; attempt: number }[] = [];
    const discoverer = { label: inner.label, finishRun: (id: string) => inner.finishRun(id), discoverTopics: (r: Parameters<typeof inner.discoverTopics>[0]) => (seen.push(r.run!), inner.discoverTopics(r)) };
    await analyzeTopics({ classified: comments, schema }, { discoverer, params: { minTopicSizeFloor: 1 } });
    await analyzeTopics({ classified: comments, schema }, { discoverer, params: { minTopicSizeFloor: 1 } });
    expect(seen.map((r) => r.attempt)).toEqual([1, 2, 1, 2]);
    expect(seen[0]!.id).toBe(seen[1]!.id);
    expect(seen[2]!.id).toBe(seen[3]!.id);
    expect(seen[2]!.id).not.toBe(seen[0]!.id);
    expect(seen[0]!.id).toMatch(/^topics-run-\d+$/);
    expect(JSON.stringify([generator.requests, assigner.requests])).not.toMatch(/topics-run|"run"/);
  });

  it("finishRun runs exactly once and releases the state: after success, after unavailable, and after an engine error", async () => {
    for (const [steps, params] of [
      [[TAXONOMY], { minTopicSizeFloor: 1 }],
      [[{ topics: [{ key: "audio", name: "Audio", definition: "" }] }], { minTopicSizeFloor: 1 }],
      [[TAXONOMY], { minTopicSizeFloor: 1, evidencePerTopic: -1 }],
    ] as const) {
      const inner = new TwoPhaseTopicDiscoverer({ generator: new FixtureTopicTaxonomyGenerator([...steps]), assigner: new FixtureTopicAssigner([VALID_ASSIGNMENT]), sample: SAMPLE });
      let finished = 0;
      const discoverer = { label: inner.label, discoverTopics: inner.discoverTopics.bind(inner), finishRun: (id: string) => (finished++, inner.finishRun(id)) };
      await analyzeTopics({ classified: comments, schema }, { discoverer, params }).catch(() => undefined);
      expect(finished).toBe(1);
      expect(inner.openRuns).toBe(0);
    }
  });

  it("callers without run identity still get a working retry, keyed by their comments", async () => {
    const generator = new FixtureTopicTaxonomyGenerator([{ topics: [{ key: "audio", name: "Audio", definition: "" }] }, TAXONOMY]);
    const discoverer = new TwoPhaseTopicDiscoverer({ generator, assigner: new FixtureTopicAssigner([VALID_ASSIGNMENT]), sample: SAMPLE });
    const request = { comments: eligible.map((c) => ({ id: c.comment.id, text: c.comment.text })), context: { sentimentLabels: schema.sentimentLabels, maxTopics: 12 } };
    await expect(discoverer.discoverTopics(request)).rejects.toThrow();
    await discoverer.discoverTopics({ ...request, feedback: { attempt: 1, issues: [{ code: "missing_definition", count: 1, topicKeys: ["audio"] }] } });
    expect(generator.requests[1]!.sample).toEqual(generator.requests[0]!.sample);
  });
});

describe("per-run isolation on one shared discoverer instance", () => {
  const request = (runId: string, attempt: number, feedback?: Parameters<TwoPhaseTopicDiscoverer["discoverTopics"]>[0]["feedback"]) => ({
    comments: eligible.map((c) => ({ id: c.comment.id, text: c.comment.text, classification: { type: c.classification.type, sentiment: c.classification.sentiment, focusMentioned: false } })),
    context: { sentimentLabels: schema.sentimentLabels, maxTopics: 12 },
    ...(feedback ? { feedback } : {}),
    run: { id: runId, attempt },
  });
  const taxonomyFor = (prefix: string) => ({
    topics: [
      { key: `${prefix}-audio`, name: `${prefix} audio`, definition: "Comments about sound." },
      { key: `${prefix}-price`, name: `${prefix} pricing`, definition: "Comments about cost." },
    ],
  });
  const decisionsFor = (prefix: string, ids: string[]): Record<string, FixtureDecision> => Object.fromEntries(ids.map((id, i) => [id, topicOf(`${prefix}-${i % 2 ? "price" : "audio"}`, "negative")]));
  const allIds = eligible.map((c) => c.comment.id);
  const validate = (raw: unknown) => validateTopicAttempt(raw, comments, schema, { maxTopics: 12, evidencePerTopic: 3, smallSampleThreshold: 30, minTopicSizeFloor: 1, minTopicSizePercentOfBase: 1, otherWarningThresholdPercent: 35 });

  it("A1, B1, A2, B2 interleaved: each retry uses only its own sample, taxonomy, entries and feedback", async () => {
    // Same comments and seed for both runs: only the run identity tells them apart.
    const generator = new FixtureTopicTaxonomyGenerator([
      { topics: [{ key: "a-audio", name: "a audio", definition: "" }] }, // A1: invalid taxonomy
      taxonomyFor("b"), // B1: valid
      taxonomyFor("a"), // A2: valid after feedback
    ]);
    const assigner = new FixtureTopicAssigner([
      { decisions: decisionsFor("b", allIds.slice(0, 11)), unlisted: "omit" }, // B1: k12 missing
      { decisions: decisionsFor("a", allIds), unlisted: "omit" }, // A2: complete
      { decisions: { k12: topicOf("b-price", "positive") }, unlisted: "omit" }, // B2: only k12
    ]);
    const discoverer = new TwoPhaseTopicDiscoverer({ generator, assigner, sample: SAMPLE });

    await expect(discoverer.discoverTopics(request("A", 1))).rejects.toThrow(); // A1
    const b1 = await discoverer.discoverTopics(request("B", 1)); // B1
    expect(validate(b1).status).toBe("invalid");
    const a2 = await discoverer.discoverTopics(request("A", 2, { attempt: 1, issues: [{ code: "missing_definition", count: 1, topicKeys: ["a-audio"] }] }));
    const b2 = await discoverer.discoverTopics(request("B", 2, { attempt: 1, issues: [{ code: "missing_assignment", count: 1, commentIds: ["k12"] }] }));

    // A rediscovered (its own feedback, same sample); B never rediscovered.
    expect(generator.requests).toHaveLength(3);
    expect(generator.requests[2]!.feedback!.issues[0]!.topicKeys).toEqual(["a-audio"]);
    expect(generator.requests[2]!.sample).toEqual(generator.requests[0]!.sample);
    // A's assignment ran against A's taxonomy; B's retry reassigned only k12 against B's cached taxonomy.
    expect(assigner.requests[1]!.taxonomy.map((t) => t.key)).toEqual(["a-audio", "a-price"]);
    expect(assigner.requests[2]!.comments.map((c) => c.id)).toEqual(["k12"]);
    expect(assigner.requests[2]!.taxonomy.map((t) => t.key)).toEqual(["b-audio", "b-price"]);
    expect(assigner.requests[2]!.feedback!.issues[0]!.code).toBe("missing_assignment");

    const resultA = validate(a2);
    const resultB = validate(b2);
    if (resultA.status !== "valid" || resultB.status !== "valid") throw new Error("expected both valid");
    expect(resultA.aggregation.topics.map((t) => t.id).sort()).toEqual(["topic:a-audio", "topic:a-pricing"]);
    expect(resultB.aggregation.topics.map((t) => t.id).sort()).toEqual(["topic:b-audio", "topic:b-pricing"]);
    expect(resultB.coverage.namedTopics.count).toBe(12);

    // Each run's methodology is its own; both are released.
    expect(discoverer.openRuns).toBe(2);
    expect(discoverer.finishRun("A")?.discoverySample?.size).toBe(6);
    expect(discoverer.finishRun("B")?.discoverySample?.size).toBe(6);
    expect(discoverer.openRuns).toBe(0);
    expect(discoverer.finishRun("A")).toBeUndefined();
  });

  it("a retry for an unknown or finished run never consumes another run's state", async () => {
    const generator = new FixtureTopicTaxonomyGenerator([taxonomyFor("b"), taxonomyFor("c")]);
    const assigner = new FixtureTopicAssigner([{ decisions: decisionsFor("b", allIds.slice(0, 11)), unlisted: "omit" }, { decisions: decisionsFor("c", allIds), unlisted: "omit" }]);
    const discoverer = new TwoPhaseTopicDiscoverer({ generator, assigner, sample: SAMPLE });
    await discoverer.discoverTopics(request("B", 1));
    // "C" carries assignment feedback but has no state: it starts fresh instead of reusing B's taxonomy or entries.
    const c = await discoverer.discoverTopics(request("C", 2, { attempt: 1, issues: [{ code: "missing_assignment", count: 1, commentIds: ["k12"] }] }));
    expect(generator.requests).toHaveLength(2);
    expect(assigner.requests[1]!.comments).toHaveLength(12);
    const result = validate(c);
    expect(result.status === "valid" && result.aggregation.topics.map((t) => t.id).sort()).toEqual(["topic:c-audio", "topic:c-pricing"]);
  });

  it("two concurrent analyzeTopics runs on one instance stay isolated end to end", async () => {
    // Fakes keyed by the focus target in the (forwarded) context, so they can serve two interleaved analyses.
    const calls = { gen: { Alpha: 0, Beta: 0 }, assign: { Alpha: 0, Beta: 0 } };
    const assignRequests: { focus: string; ids: string[]; keys: string[] }[] = [];
    const generator = {
      label: "keyed generator",
      async proposeTaxonomy(r: { context: { focus?: { name: string } } }) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const focus = r.context.focus!.name as "Alpha" | "Beta";
        calls.gen[focus] += 1;
        if (focus === "Alpha" && calls.gen.Alpha === 1) return { topics: [{ key: "a-audio", name: "a audio", definition: "" }] };
        return taxonomyFor(focus === "Alpha" ? "a" : "b");
      },
    };
    const assigner = {
      label: "keyed assigner",
      async assignTopics(r: { comments: readonly { id: string }[]; taxonomy: readonly { key: string }[]; context: { focus?: { name: string } } }) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const focus = r.context.focus!.name as "Alpha" | "Beta";
        calls.assign[focus] += 1;
        assignRequests.push({ focus, ids: r.comments.map((c) => c.id), keys: r.taxonomy.map((t) => t.key) });
        const ids = r.comments.map((c) => c.id).filter((id) => !(focus === "Beta" && calls.assign.Beta === 1 && id === "k12"));
        return ids.map((id, i) => ({ commentId: id, disposition: "primary_topic", topicKey: r.taxonomy[i % 2]!.key, topicSentiment: "neutral" }));
      },
    };
    const discoverer = new TwoPhaseTopicDiscoverer({ generator, assigner, sample: SAMPLE });
    const run = (name: string) => analyzeTopics({ classified: comments, schema, focus: { name, aliases: [] } }, { discoverer, params: { minTopicSizeFloor: 1 } });
    const [alpha, beta] = await Promise.all([run("Alpha"), run("Beta")]);

    const a = available(alpha);
    const b = available(beta);
    expect(a.method.attempts).toBe(2);
    expect(b.method.attempts).toBe(2);
    expect(a.topics.map((t) => t.id).sort()).toEqual(["topic:a-audio", "topic:a-pricing"]);
    expect(b.topics.map((t) => t.id).sort()).toEqual(["topic:b-audio", "topic:b-pricing"]);
    expect(calls).toEqual({ gen: { Alpha: 2, Beta: 1 }, assign: { Alpha: 1, Beta: 2 } });
    // Beta's retry reassigned only its missing comment, against Beta's taxonomy.
    expect(assignRequests.filter((r) => r.focus === "Beta")[1]).toEqual({ focus: "Beta", ids: ["k12"], keys: ["b-audio", "b-price"] });
    expect(discoverer.openRuns).toBe(0);
  });
});
