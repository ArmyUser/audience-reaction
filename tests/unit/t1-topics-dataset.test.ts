import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { definitionProblems } from "../../src/benchmark/topic-benchmark";
import { BENCHMARK_DATASETS } from "../../src/benchmark/datasets";
import { goldOf, isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, parseTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import { DEFAULT_TOPIC_PARAMETERS, minimumTopicSize } from "../../src/core/topics/aggregate-topics";
import { normalizeTopicName } from "../../src/core/topics/normalize";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { normalize, THRESHOLDS as HELDOUT_THRESHOLDS } from "../heldout/leakage-audit";
import { auditT1Comments, collectT1Sources, T1_AUDIT_PATH, T1_PATH, T1_THRESHOLDS } from "../topics-benchmark/t1-leakage-audit";

// Topic benchmark dataset t1-topics-v1: 200 synthetic comments for a fictional sponsored folding e-bike review, with a
// gold taxonomy and one gold topic disposition (plus topic sentiment) per non-spam comment.

const T1_VERSION = "sha256:e44ac9d63b94ebc9";
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const comments = dataset.comments;
const tagged = (tag: string) => comments.filter((c) => c.tags.includes(tag));
const fileText = readFileSync(T1_PATH, "utf8");

describe("t1-topics-v1 registry and identity", () => {
  it("has its own registry; the classifier benchmark datasets are unchanged", () => {
    expect(Object.keys(TOPIC_BENCHMARK_DATASETS)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1"]);
    expect(isTopicBenchmarkDatasetId("t1-topics-v1")).toBe(true);
    expect(isTopicBenchmarkDatasetId("m2-heldout-v1")).toBe(false);
    expect(Object.keys(BENCHMARK_DATASETS)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
  });

  it("loads with its dataset ID, a stable content hash, the 3-label focus schema and a new fictional focus", () => {
    expect(dataset.id).toBe("t1-topics-v1");
    expect(dataset.version).toBe(T1_VERSION);
    expect(dataset.schema.sentimentLabels).toEqual(["positive", "neutral", "negative"]);
    expect(dataset.schema.focusConfigured).toBe(true);
    expect(dataset.focus).toEqual({ name: "Corvid Fold 2", aliases: ["Corvid", "Fold 2"], isVideoSponsor: true });
  });

  it("has exactly 200 comments with sequential, unique IDs and unique texts", () => {
    expect(comments).toHaveLength(200);
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 200 }, (_, i) => `t1-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(comments.map((c) => normalize(c.text) || c.text)).size).toBe(200);
  });

  it("shares no ID, text or focus target with m2-synthetic or m2-heldout-v1", () => {
    for (const path of Object.values(BENCHMARK_DATASETS)) {
      const other = JSON.parse(readFileSync(path, "utf8")) as { focus: { name: string }; comments: { id: string; text: string }[] };
      expect(other.focus.name).not.toBe(dataset.focus.name);
      const ids = new Set(other.comments.map((c) => c.id));
      const texts = new Set(other.comments.map((c) => normalize(c.text)));
      for (const c of comments) {
        expect(ids.has(c.id), c.id).toBe(false);
        expect(texts.has(normalize(c.text)), c.id).toBe(false);
      }
    }
  });
});

describe("t1-topics-v1 gold taxonomy", () => {
  it("has 8 topics with stable keys, unique normalised names and one-sentence definitions", () => {
    expect(dataset.taxonomy.map((t) => t.key)).toEqual(["range", "motor", "folding", "comfort", "charging", "value", "brakes", "app"]);
    expect(new Set(dataset.taxonomy.map((t) => normalizeTopicName(t.name))).size).toBe(8);
    for (const t of dataset.taxonomy) {
      expect(definitionProblems(t.name, t.definition, comments.map((c) => c.text)), t.key).toEqual([]);
      expect(t.acceptedNames.length, t.key).toBeGreaterThan(0);
    }
  });

  it("passes the production AC-21 taxonomy validation against the topic base", () => {
    const result = validateTopicTaxonomy(
      { topics: dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition })) },
      { sampleCommentIds: gold.baseIds, maxTopics: DEFAULT_TOPIC_PARAMETERS.maxTopics },
    );
    expect(result.status).toBe("valid");
  });
});

describe("t1-topics-v1 gold assignment", () => {
  it("gives every non-spam comment exactly one gold disposition and spam none", () => {
    expect(gold.baseIds).toHaveLength(188);
    for (const c of comments) {
      expect(c.topic === null, c.id).toBe(c.classification.type === "spam_irrelevant");
      if (c.topic === null) continue;
      if (c.topic.disposition === "primary_topic") expect(Object.keys(c.topic).sort()).toEqual(["disposition", "topicKey", "topicSentiment"]);
      else expect(Object.keys(c.topic)).toEqual(["disposition"]);
    }
    const counts: Record<string, number> = {};
    for (const d of gold.dispositions.values()) counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;
    expect(counts).toEqual({ primary_topic: 134, other: 22, no_specific_topic: 32 });
    expect(tagged("spam")).toHaveLength(12);
  });

  it("has large, medium and small topics; one gold topic is below the production minimum topic size", () => {
    const sizes = Object.fromEntries(dataset.taxonomy.map((t) => [t.key, gold.members.get(t.key)!.length]));
    expect(sizes).toEqual({ range: 28, motor: 24, folding: 20, comfort: 16, charging: 14, value: 14, brakes: 12, app: 6 });
    const min = minimumTopicSize(gold.baseIds.length, DEFAULT_TOPIC_PARAMETERS);
    expect(min).toBe(10);
    expect(Object.entries(sizes).filter(([, n]) => n < min).map(([k]) => k)).toEqual(["app"]);
    // Gold OTHER (22 + 6 small-topic) and NO_SPECIFIC_TOPIC (32) are meaningful but below the 35% warning together.
    expect(((22 + 6 + 32) / 188) * 100).toBeLessThan(DEFAULT_TOPIC_PARAMETERS.otherWarningThresholdPercent);
  });

  it("varies topic sentiment within every topic", () => {
    for (const t of dataset.taxonomy) {
      const labels = new Set(gold.members.get(t.key)!.map((id) => (gold.dispositions.get(id) as { topicSentiment: string }).topicSentiment));
      expect([...labels].sort(), t.key).toEqual(["negative", "neutral", "positive"]);
    }
  });

  it("separates topic sentiment from overall sentiment in every direction", () => {
    const pairs = new Map<string, number>();
    for (const id of gold.baseIds) {
      const d = gold.dispositions.get(id)!;
      if (d.disposition !== "primary_topic") continue;
      const overall = gold.overallSentiment.get(id)!;
      if (overall !== d.topicSentiment) pairs.set(`${overall}->${d.topicSentiment}`, (pairs.get(`${overall}->${d.topicSentiment}`) ?? 0) + 1);
    }
    expect([...pairs.values()].reduce((s, n) => s + n, 0)).toBe(17);
    for (const pair of ["positive->negative", "negative->positive", "neutral->positive", "neutral->negative", "negative->neutral"]) expect(pairs.get(pair) ?? 0, pair).toBeGreaterThan(0);
    for (const c of tagged("sentiment_diverges")) {
      expect(c.topic?.disposition, c.id).toBe("primary_topic");
      expect((c.topic as { topicSentiment: string }).topicSentiment, c.id).not.toBe(c.classification.sentiment);
    }
  });

  it("covers every required slice", () => {
    const counts: Record<string, number> = {};
    for (const c of comments) for (const t of c.tags) counts[t] = (counts[t] ?? 0) + 1;
    expect(counts).toEqual({
      strong: 57, borderline: 26, sentiment_diverges: 17, neutral_overall: 5, mixed: 6, short: 19, generic: 30,
      no_topic_match: 16, incidental_mention: 4, focus_evaluation: 10, creator_content: 14, sponsor: 3, question: 18,
      request: 9, sarcasm: 3, prompt_injection: 3, fake_json: 1, html_script: 3, lexical_variant: 8, spam: 12, off_topic: 5,
    });
    // Mentions of a topic's vocabulary that are not about that topic stay out of it.
    for (const c of tagged("incidental_mention")) expect(c.topic?.disposition, c.id).not.toBe("primary_topic");
    // Questions and requests about a topic are assigned to it with a neutral topic sentiment.
    const neutralOnTopic = (tag: string) => tagged(tag).filter((c) => c.topic?.disposition === "primary_topic" && c.topic.topicSentiment === "neutral").length;
    expect(neutralOnTopic("question")).toBe(13);
    expect(neutralOnTopic("request")).toBe(8);
  });

  it("uses explicit and inferred focus mentions consistent with the engine's focus matcher", () => {
    const mentions: Record<string, number> = {};
    for (const c of comments) mentions[c.focusMention] = (mentions[c.focusMention] ?? 0) + 1;
    expect(mentions).toEqual({ explicit: 11, inferred: 117, none: 72 });
    for (const c of tagged("spam")) {
      expect(c.classification).toMatchObject({ isQuestion: false, isRequest: false, targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" } });
    }
  });
});

describe("t1-topics-v1 dataset validation", () => {
  const mutate = (fn: (doc: { taxonomy: { key: string; name: string }[]; comments: Record<string, unknown>[] }) => void) => {
    const doc = JSON.parse(fileText);
    fn(doc);
    return () => parseTopicBenchmarkDataset(JSON.stringify(doc), "t1-topics-v1");
  };
  const firstPrimary = (doc: { comments: Record<string, unknown>[] }) => doc.comments.find((c) => (c.topic as { disposition?: string } | null)?.disposition === "primary_topic")!;

  it.each([
    ["a non-spam comment without gold", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void (firstPrimary(d).topic = null), /gold topic must be null exactly for spam/],
    ["an unknown gold topic key", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void ((firstPrimary(d).topic as { topicKey: string }).topicKey = "nope"), /unknown gold topic nope/],
    ["a topic sentiment outside the schema", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void ((firstPrimary(d).topic as { topicSentiment: string }).topicSentiment = "mixed"), /outside the schema/],
    ["a topic on an OTHER disposition", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void (d.comments.find((c) => (c.topic as { disposition?: string } | null)?.disposition === "other")!.topic = { disposition: "other", topicKey: "range" }), /carries a topic/],
    ["a duplicate ID", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void (d.comments[1]!.id = d.comments[0]!.id), /duplicate id/],
    ["an inconsistent focus mention", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void (d.comments.find((c) => c.focusMention === "none")!.focusMention = "explicit"), /focusMention explicit, expected none/],
    ["a duplicate normalised gold name", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void (d.taxonomy[1]!.name = d.taxonomy[0]!.name.toUpperCase()), /gold taxonomy fails AC-21: duplicate_topic_name/],
    ["a wrong dataset ID", (d: Parameters<Parameters<typeof mutate>[0]>[0]) => void ((d as unknown as { datasetId: string }).datasetId = "t2"), /datasetId is t2/],
  ])("rejects %s", (_name, change, message) => {
    expect(mutate(change)).toThrow(message);
  });
});

describe("t1-topics-v1 leakage audit", () => {
  const artifact = JSON.parse(readFileSync(T1_AUDIT_PATH, "utf8")) as {
    datasetVersion: string;
    thresholds: typeof T1_THRESHOLDS;
    sourceSegments: Record<string, number>;
    summary: { comments: number; violations: number };
    comments: { id: string; violations: string[] }[];
  };

  it("the stored audit belongs to this exact dataset version, uses stricter thresholds than m2-heldout-v1 and reports no violations", () => {
    expect(artifact.datasetVersion).toBe(T1_VERSION);
    expect(artifact.thresholds).toEqual(T1_THRESHOLDS);
    expect(T1_THRESHOLDS.tokenJaccard).toBeLessThan(HELDOUT_THRESHOLDS.tokenJaccard);
    expect(T1_THRESHOLDS.trigramJaccard).toBeLessThan(HELDOUT_THRESHOLDS.trigramJaccard);
    expect(artifact.summary).toMatchObject({ comments: 200, violations: 0 });
    expect(artifact.comments.map((c) => c.id)).toEqual(comments.map((c) => c.id));
    for (const kind of ["m2", "m2-heldout-v1", "guideline", "question", "prompt", "spec.md", "design", "test", "fake"]) expect(artifact.sourceSegments[kind], kind).toBeGreaterThan(0);
  });

  it("re-running the audit now finds no exact, contained or near-duplicate overlap with any source", () => {
    const sources = collectT1Sources();
    for (const prefix of ["m2:", "m2-heldout-v1:", "guideline:", "question:jev-q1:", "question:jev-q2:", "prompt:", "design:", "test:tests/unit/topic-", "fake:src/adapters/fakes/fixture-topic"]) {
      expect(sources.some((s) => s.source.startsWith(prefix)), prefix).toBe(true);
    }
    expect(sources.some((s) => s.source.startsWith("test:tests/topics-benchmark/"))).toBe(false);
    expect(auditT1Comments(comments, sources).filter((r) => r.violations.length > 0)).toEqual([]);
  });

  it("flags exact, contained and near-duplicate texts", () => {
    const sources = [{ source: "probe", text: "The hinge on this folding frame wobbles after a month." }];
    const [exact, contained, near, clean] = auditT1Comments(
      [
        { id: "a", text: "the hinge on this folding frame wobbles after a month" },
        { id: "b", text: "hinge on this folding frame" },
        { id: "c", text: "This folding frame hinge wobbles after one month." },
        { id: "d", text: "Lovely olive paint." },
      ],
      sources,
    );
    expect(exact!.violations).toContain("exact:probe");
    expect(contained!.violations).toContain("contained-in:probe");
    expect(near!.violations.some((v) => v.startsWith("token-jaccard:"))).toBe(true);
    expect(clean!.violations).toEqual([]);
  });
});
