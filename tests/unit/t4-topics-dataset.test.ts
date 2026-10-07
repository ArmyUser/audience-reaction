import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BENCHMARK_DATASETS } from "../../src/benchmark/datasets";
import { definitionProblems, runTopicBenchmark } from "../../src/benchmark/topic-benchmark";
import { V4_EXPERIMENT } from "../../src/benchmark/topic-consolidation-experiment";
import { goldOf, isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, parseTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import { DEFAULT_TOPIC_PARAMETERS, minimumTopicSize } from "../../src/core/topics/aggregate-topics";
import { normalizeTopicName } from "../../src/core/topics/normalize";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { normalize } from "../heldout/leakage-audit";
import { collectFrozenSources, FROZEN_AUDITS, frozenIndependenceChecks, loadManifest } from "../topics-benchmark/audit-source-manifest";
import { HOLDOUT_THRESHOLDS, T4_AUDIT } from "../topics-benchmark/holdout-independence-audit";
import { T1_THRESHOLDS } from "../topics-benchmark/t1-leakage-audit";

// Pre-registered hold-out t4-topics-v1 for the topic-consolidation-v4 experiment: 201 synthetic comments for an
// independent creator's review of a fictional language-learning service, authored separately from t1-t3 with the same
// schema and gold semantics. Gold was written before any provider run on it and without any result file.

const T4_VERSION = "sha256:58e225f986238591";
const dataset = loadTopicBenchmarkDataset("t4-topics-v1");
const gold = goldOf(dataset);
const comments = dataset.comments;
const tagged = (tag: string) => comments.filter((c) => c.tags.includes(tag));
const fileText = readFileSync(T4_AUDIT.config.path, "utf8");
const references = (["t1-topics-v1", "t2-topics-v1", "t3-topics-v1"] as const).map((id) => loadTopicBenchmarkDataset(id));
const keyOf = (c: (typeof comments)[number]) => (c.topic === null ? "spam" : c.topic.disposition === "primary_topic" ? c.topic.topicKey : c.topic.disposition);

describe("t4-topics-v1 registry and identity", () => {
  it("is registered after t1-t3 and is the experiment's pre-registered dataset", () => {
    expect(Object.keys(TOPIC_BENCHMARK_DATASETS)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1"]);
    expect(isTopicBenchmarkDatasetId("t4-topics-v1")).toBe(true);
    expect(V4_EXPERIMENT.dataset).toBe("t4-topics-v1");
    expect(Object.keys(BENCHMARK_DATASETS)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
  });

  it("loads with a stable content hash, the shared schema and its own fictional, unsponsored focus", () => {
    expect(dataset.version).toBe(T4_VERSION);
    for (const ref of references) {
      expect(dataset.schema).toEqual(ref.schema);
      expect(dataset.focus.name).not.toBe(ref.focus.name);
    }
    expect(dataset.focus).toEqual({ name: "Lingomoor", aliases: ["Lingomoor Plus"], isVideoSponsor: false });
  });

  it("has 201 comments with sequential t4 IDs and unique texts, sharing none with any earlier dataset", () => {
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 201 }, (_, i) => `t4-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(comments.map((c) => normalize(c.text) || c.text)).size).toBe(201);
    for (const path of [...Object.values(BENCHMARK_DATASETS), ...references.map((r) => TOPIC_BENCHMARK_DATASETS[r.id as keyof typeof TOPIC_BENCHMARK_DATASETS])]) {
      const other = JSON.parse(readFileSync(path, "utf8")) as { comments: { id: string; text: string }[] };
      const ids = new Set(other.comments.map((c) => c.id));
      const texts = new Set(other.comments.map((c) => normalize(c.text)));
      for (const c of comments) {
        expect(ids.has(c.id), c.id).toBe(false);
        expect(texts.has(normalize(c.text)), c.id).toBe(false);
      }
    }
  });
});

describe("t4-topics-v1 gold", () => {
  it("has 9 topics with keys, names and definitions of its own that pass AC-21", () => {
    expect(dataset.taxonomy.map((t) => t.key)).toEqual(["lessons", "pronunciation", "tutors", "chat_partner", "motivation", "grammar", "course_catalog", "progress", "offline"]);
    expect(new Set(dataset.taxonomy.map((t) => normalizeTopicName(t.name))).size).toBe(9);
    for (const t of dataset.taxonomy) expect(definitionProblems(t.name, t.definition, comments.map((c) => c.text)), t.key).toEqual([]);
    const refKeys = new Set(references.flatMap((r) => r.taxonomy.map((t) => t.key)));
    const refNames = new Set(references.flatMap((r) => r.taxonomy.flatMap((t) => [t.name, ...t.acceptedNames])).map(normalizeTopicName));
    for (const t of dataset.taxonomy) {
      expect(refKeys.has(t.key), t.key).toBe(false);
      for (const n of [t.name, ...t.acceptedNames]) expect(refNames.has(normalizeTopicName(n)), n).toBe(false);
    }
    const ac21 = validateTopicTaxonomy({ topics: dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition })) }, { sampleCommentIds: gold.baseIds, maxTopics: DEFAULT_TOPIC_PARAMETERS.maxTopics });
    expect(ac21.status).toBe("valid");
  });

  it("has the required counts: base, dispositions, spam, topic sizes and the minimum topic size", () => {
    expect(gold.baseIds).toHaveLength(189);
    const counts: Record<string, number> = {};
    for (const d of gold.dispositions.values()) counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;
    expect(counts).toEqual({ primary_topic: 135, other: 28, no_specific_topic: 26 });
    expect(tagged("spam")).toHaveLength(12);
    const sizes = Object.fromEntries(dataset.taxonomy.map((t) => [t.key, gold.members.get(t.key)!.length]));
    expect(sizes).toEqual({ lessons: 20, pronunciation: 18, tutors: 15, chat_partner: 14, motivation: 22, grammar: 12, course_catalog: 13, progress: 11, offline: 10 });
    expect(minimumTopicSize(gold.baseIds.length, DEFAULT_TOPIC_PARAMETERS)).toBe(10);
    expect(((28 + 26) / 189) * 100).toBeLessThan(DEFAULT_TOPIC_PARAMETERS.otherWarningThresholdPercent);
  });

  it("keeps side-subject bundles, the comment-form trap and the addressee trap in OTHER", () => {
    expect(tagged("peripheral")).toHaveLength(13);
    expect(tagged("meta_trap")).toHaveLength(4);
    expect(tagged("addressee_trap")).toHaveLength(4);
    for (const tag of ["peripheral", "meta_trap", "addressee_trap", "incidental_mention", "focus_mention_only"]) for (const c of tagged(tag)) expect(keyOf(c), `${tag} ${c.id}`).toBe("other");
    for (const c of tagged("focus_mention_only")) expect(c, c.id).toMatchObject({ focusMention: "explicit", classification: { targets: { focus: "not_addressed" } } });
    // Requests about a subject belong to that subject; requests for other content are the addressee trap.
    expect(tagged("request").filter((c) => keyOf(c) !== "other")).toHaveLength(9);
  });

  it("groups aspects into a broad topic, has adjacent topics, and 17 topic-vs-overall sentiment divergences", () => {
    expect(new Set(tagged("broad_scope").map(keyOf))).toEqual(new Set(["motivation"]));
    expect(tagged("adjacent").length).toBeGreaterThanOrEqual(8);
    for (const t of dataset.taxonomy) {
      const labels = new Set(gold.members.get(t.key)!.map((id) => (gold.dispositions.get(id) as { topicSentiment: string }).topicSentiment));
      expect([...labels].sort(), t.key).toEqual(["negative", "neutral", "positive"]);
    }
    const diverging = gold.baseIds.filter((id) => {
      const d = gold.dispositions.get(id)!;
      return d.disposition === "primary_topic" && d.topicSentiment !== gold.overallSentiment.get(id);
    });
    expect(diverging).toHaveLength(17);
    for (const c of tagged("sentiment_diverges")) expect((c.topic as { topicSentiment: string }).topicSentiment).not.toBe(c.classification.sentiment);
  });

  it("covers the adversarial and stylistic slices", () => {
    for (const tag of ["question", "request", "sarcasm", "slang", "prompt_injection", "fake_json", "fake_markup", "html_script", "short", "generic", "focus_evaluation", "creator_content", "lexical_variant", "ambiguous"]) {
      expect(tagged(tag).length, tag).toBeGreaterThan(0);
    }
    for (const tag of ["prompt_injection", "fake_json", "fake_markup", "html_script", "generic"]) for (const c of tagged(tag)) expect(keyOf(c), `${tag} ${c.id}`).toBe("no_specific_topic");
    const mentions: Record<string, number> = {};
    for (const c of comments) mentions[c.focusMention] = (mentions[c.focusMention] ?? 0) + 1;
    expect(mentions).toEqual({ explicit: 2, inferred: 141, none: 58 });
  });

  it("is checked by the same parser", () => {
    const doc = JSON.parse(fileText);
    doc.comments.find((c: { topic: { disposition?: string } | null }) => c.topic?.disposition === "primary_topic").topic.topicKey = "not_a_t4_topic";
    expect(() => parseTopicBenchmarkDataset(JSON.stringify(doc), "t4-topics-v1")).toThrow(/unknown gold topic not_a_t4_topic/);
  });
});

describe("t4-topics-v1 oracle gate", () => {
  it("the oracle passes with every metric perfect, and every offline scenario meets its expectation", async () => {
    const report = await runTopicBenchmark(dataset);
    expect(report.oracleGate).toEqual({ passed: true, failures: [] });
    expect(report.scenarios[0]!.perfect).toBe(true);
    for (const s of report.scenarios) expect(s.expectationFailures, s.id).toEqual([]);
  });
});

describe("t4-topics-v1 independence and leakage audit", () => {
  const artifact = JSON.parse(readFileSync(T4_AUDIT.config.auditPath, "utf8")) as {
    datasetId: string;
    datasetVersion: string;
    references: string[];
    thresholds: typeof T1_THRESHOLDS;
    summary: { comments: number; goldDefinitions: number; violations: number; independenceChecksFailed: number };
    independence: { passed: boolean }[];
    provenance: { ownResultFiles: string[] };
    sourceSegments: Record<string, number>;
  };

  it("the stored audit belongs to this version, covers t1-t3 with the t3 standard and reports no violations", () => {
    expect(HOLDOUT_THRESHOLDS).toEqual(T1_THRESHOLDS);
    expect(artifact).toMatchObject({ datasetId: "t4-topics-v1", datasetVersion: T4_VERSION, references: ["t1-topics-v1", "t2-topics-v1", "t3-topics-v1"], thresholds: T1_THRESHOLDS });
    expect(artifact.summary).toMatchObject({ comments: 201, goldDefinitions: 9, violations: 0, independenceChecksFailed: 0 });
    expect(artifact.independence.map((c) => c.passed)).toEqual(Array(8).fill(true));
    expect(artifact.provenance.ownResultFiles).toEqual([]);
    for (const kind of ["m2", "m2-heldout-v1", "guideline", "question", "prompt", "spec.md", "design", "test", "fake", "t1", "t1-gold", "t2", "t2-gold", "t3", "t3-gold", "t1-replay", "model-output"]) {
      expect(artifact.sourceSegments[kind], kind).toBeGreaterThan(0);
    }
  });

  it("re-running the audit against its frozen sources finds no overlap; every consolidation contract's prompt is a source", () => {
    // The comparison sources are the ones the completed audit used (tests/topics-benchmark/manifests/), so results
    // stored after the audit cannot change its meaning; see tests/unit/audit-source-manifests.test.ts.
    const manifest = loadManifest(FROZEN_AUDITS["t4-topics-v1"]!.manifestPath);
    const sources = collectFrozenSources(manifest);
    for (const prefix of ["t1:", "t2:", "t3:", "t3-gold:", "t1-replay:", "model-output:", "prompt:discovery", "prompt:assignment", "prompt:topic-consolidation-v3", "prompt:topic-consolidation-v4"]) {
      expect(sources.some((s) => s.source.startsWith(prefix)), prefix).toBe(true);
    }
    expect(sources.some((s) => /^test:tests\/(unit\/t4-|topics-benchmark\/)/.test(s.source))).toBe(false);
    const { comments: audited, gold: goldAudit } = T4_AUDIT.auditTexts(JSON.parse(fileText), sources);
    expect([...audited, ...goldAudit].filter((r) => r.violations.length > 0)).toEqual([]);
    expect(frozenIndependenceChecks(manifest, fileText).filter((c) => !c.passed)).toEqual([]);
  }, 120_000);

  it("the structural checks catch IDs, text and labels of any reference, metadata, provider vocabulary and model output", () => {
    const refs = T4_AUDIT.loadReferences();
    const doc = JSON.parse(fileText);
    doc.comments[0].id = refs[2]!.comments[0]!.id;
    doc.comments[1].text = refs[0]!.comments[1]!.text;
    doc.taxonomy[0].acceptedNames.push(refs[1]!.taxonomy[0]!.name);
    doc.comments[2].provider = "x";
    doc.description += " Labelled with help from Sonnet.";
    doc.taxonomy[1].definition = "Synthetic model wording for a probe topic.";
    const failed = T4_AUDIT.checkIndependence(JSON.stringify(doc), refs, [{ source: "probe", strings: ["Synthetic model wording for a probe topic."] }]).filter((c) => !c.passed).map((c) => c.check);
    expect(failed).toHaveLength(6);
    expect(failed.join("\n")).toMatch(/comment IDs[\s\S]*comment text[\s\S]*gold topic key[\s\S]*schema fields[\s\S]*vocabulary[\s\S]*model output/);
  });
});
