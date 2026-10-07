import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BENCHMARK_DATASETS } from "../../src/benchmark/datasets";
import { definitionProblems, runTopicBenchmark } from "../../src/benchmark/topic-benchmark";
import { goldOf, isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, parseTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import { DEFAULT_TOPIC_PARAMETERS, minimumTopicSize } from "../../src/core/topics/aggregate-topics";
import { normalizeTopicName } from "../../src/core/topics/normalize";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { normalize } from "../heldout/leakage-audit";
import { collectFrozenSources, FROZEN_AUDITS, frozenIndependenceChecks, loadManifest, segmentKinds, type AuditSourceManifest } from "../topics-benchmark/audit-source-manifest";
import { HOLDOUT_THRESHOLDS } from "../topics-benchmark/holdout-independence-audit";
import { T1_THRESHOLDS } from "../topics-benchmark/t1-leakage-audit";
import { frozenDocumentSegments, T5_AUDIT, T5_DOCUMENTS, type FrozenDocument } from "../topics-benchmark/t5-holdout-audit";

// Hold-out t5-topics-v1 for a later paired consolidation comparison: 206 synthetic comments for an independent
// creator's review of a fictional home espresso machine, authored separately from t1-t4 with the same schema and gold
// semantics. Gold was written before any provider run on it and without any result file. No experiment is registered
// on it here.

const T5_VERSION = "sha256:cec6e6563d81a179";
const T5_SHA256 = "cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3";
const dataset = loadTopicBenchmarkDataset("t5-topics-v1");
const gold = goldOf(dataset);
const comments = dataset.comments;
const tagged = (tag: string) => comments.filter((c) => c.tags.includes(tag));
const fileText = readFileSync(T5_AUDIT.config.path, "utf8");
const references = (["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1"] as const).map((id) => loadTopicBenchmarkDataset(id));
const keyOf = (c: (typeof comments)[number]) => (c.topic === null ? "spam" : c.topic.disposition === "primary_topic" ? c.topic.topicKey : c.topic.disposition);
const diverging = () =>
  gold.baseIds.filter((id) => {
    const d = gold.dispositions.get(id)!;
    return d.disposition === "primary_topic" && d.topicSentiment !== gold.overallSentiment.get(id);
  });

describe("t5-topics-v1 registry and identity", () => {
  it("is registered after t1-t4", () => {
    expect(Object.keys(TOPIC_BENCHMARK_DATASETS)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1"]);
    expect(isTopicBenchmarkDatasetId("t5-topics-v1")).toBe(true);
    expect(Object.keys(BENCHMARK_DATASETS)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
  });

  it("loads with a stable content hash, the shared schema and its own fictional, unsponsored focus", () => {
    expect(dataset.version).toBe(T5_VERSION);
    expect(createHash("sha256").update(fileText).digest("hex")).toBe(T5_SHA256);
    for (const ref of references) {
      expect(dataset.schema).toEqual(ref.schema);
      expect(dataset.focus.name).not.toBe(ref.focus.name);
    }
    expect(dataset.focus).toEqual({ name: "Vellora", aliases: ["Vellora Duo"], isVideoSponsor: false });
  });

  it("has 206 comments with sequential t5 IDs and unique texts, sharing none with any earlier dataset", () => {
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 206 }, (_, i) => `t5-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(comments.map((c) => normalize(c.text) || c.text)).size).toBe(206);
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

describe("t5-topics-v1 gold", () => {
  it("has 9 topics with keys, names and definitions of its own that pass AC-21", () => {
    expect(dataset.taxonomy.map((t) => t.key)).toEqual(["extraction", "thermal", "grinder", "steam_wand", "upkeep", "warmup", "noise", "interface", "aftercare"]);
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
    expect(gold.baseIds).toHaveLength(194);
    const counts: Record<string, number> = {};
    for (const d of gold.dispositions.values()) counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;
    expect(counts).toEqual({ primary_topic: 143, other: 26, no_specific_topic: 25 });
    expect(tagged("spam")).toHaveLength(12);
    const sizes = Object.fromEntries(dataset.taxonomy.map((t) => [t.key, gold.members.get(t.key)!.length]));
    expect(sizes).toEqual({ extraction: 19, thermal: 14, grinder: 17, steam_wand: 16, upkeep: 21, warmup: 12, noise: 13, interface: 15, aftercare: 16 });
    // Every named topic is above the production minimum; none needs an exception.
    expect(minimumTopicSize(gold.baseIds.length, DEFAULT_TOPIC_PARAMETERS)).toBe(10);
    expect(Math.min(...Object.values(sizes))).toBeGreaterThan(10);
    expect(((26 + 25) / 194) * 100).toBeLessThan(DEFAULT_TOPIC_PARAMETERS.otherWarningThresholdPercent);
  });

  it("keeps side-subject bundles, the comment-form trap and the addressee trap in OTHER", () => {
    expect(tagged("peripheral")).toHaveLength(13);
    expect(tagged("meta_trap")).toHaveLength(4);
    expect(tagged("addressee_trap")).toHaveLength(4);
    for (const tag of ["peripheral", "meta_trap", "addressee_trap", "incidental_mention", "focus_mention_only"]) for (const c of tagged(tag)) expect(keyOf(c), `${tag} ${c.id}`).toBe("other");
    for (const c of tagged("focus_mention_only")) expect(c, c.id).toMatchObject({ focusMention: "explicit", classification: { targets: { focus: "not_addressed" } } });
    // The comment-form trap: score cards ("n/10") about side subjects are OTHER; one about the steam wand is not.
    const scoreCards = comments.filter((c) => /\b\d+\/10\b/.test(c.text));
    expect(scoreCards.filter((c) => keyOf(c) === "other").map((c) => c.id)).toEqual(tagged("meta_trap").map((c) => c.id));
    expect(scoreCards.filter((c) => keyOf(c) !== "other").map(keyOf)).toEqual(["steam_wand"]);
    // Requests about a subject belong to that subject (one per topic); requests for other content are the addressee trap.
    expect(tagged("request").filter((c) => keyOf(c) !== "other").map(keyOf).sort()).toEqual(dataset.taxonomy.map((t) => t.key).sort());
  });

  it("groups aspects into a broad topic, has adjacent topics, and 18 topic-vs-overall sentiment divergences in both directions", () => {
    expect(new Set(tagged("broad_scope").map(keyOf))).toEqual(new Set(["upkeep"]));
    expect(tagged("adjacent").length).toBeGreaterThanOrEqual(8);
    for (const t of dataset.taxonomy) {
      const labels = new Set(gold.members.get(t.key)!.map((id) => (gold.dispositions.get(id) as { topicSentiment: string }).topicSentiment));
      expect([...labels].sort(), t.key).toEqual(["negative", "neutral", "positive"]);
    }
    expect(diverging()).toHaveLength(18);
    expect(diverging().map((id) => tagged("sentiment_diverges").some((c) => c.id === id))).toEqual(Array(18).fill(true));
    const direction = (overall: string) => diverging().filter((id) => gold.overallSentiment.get(id) === overall).length;
    expect([direction("positive"), direction("negative")]).toEqual([9, 9]);
  });

  it("covers the adversarial and stylistic slices", () => {
    for (const tag of ["question", "request", "sarcasm", "slang", "prompt_injection", "fake_json", "fake_markup", "html_script", "short", "generic", "focus_evaluation", "creator_content", "lexical_variant", "ambiguous", "incidental_mention", "focus_mention_only"]) {
      expect(tagged(tag).length, tag).toBeGreaterThan(0);
    }
    for (const tag of ["prompt_injection", "fake_json", "fake_markup", "html_script", "generic"]) for (const c of tagged(tag)) expect(keyOf(c), `${tag} ${c.id}`).toBe("no_specific_topic");
    const mentions: Record<string, number> = {};
    for (const c of comments) mentions[c.focusMention] = (mentions[c.focusMention] ?? 0) + 1;
    expect(mentions).toEqual({ explicit: 4, inferred: 135, none: 67 });
  });

  it("is checked by the same parser", () => {
    const doc = JSON.parse(fileText);
    doc.comments.find((c: { topic: { disposition?: string } | null }) => c.topic?.disposition === "primary_topic").topic.topicKey = "not_a_t5_topic";
    expect(() => parseTopicBenchmarkDataset(JSON.stringify(doc), "t5-topics-v1")).toThrow(/unknown gold topic not_a_t5_topic/);
  });
});

describe("t5-topics-v1 oracle gate", () => {
  it("the oracle passes with every metric perfect, every offline scenario meets its expectation, and reruns are identical", async () => {
    const report = await runTopicBenchmark(dataset);
    expect(report.oracleGate).toEqual({ passed: true, failures: [] });
    expect(report.scenarios[0]!.perfect).toBe(true);
    for (const s of report.scenarios) expect(s.expectationFailures, s.id).toEqual([]);
    expect(await runTopicBenchmark(dataset)).toEqual(report);
  });
});

describe("t5-topics-v1 independence and leakage audit", () => {
  const artifact = JSON.parse(readFileSync(T5_AUDIT.config.auditPath, "utf8")) as {
    datasetId: string;
    datasetVersion: string;
    references: string[];
    thresholds: typeof T1_THRESHOLDS;
    frozenDataset: Record<string, unknown>;
    summary: { comments: number; goldDefinitions: number; violations: number; independenceChecksFailed: number };
    independence: { passed: boolean }[];
    provenance: { ownResultFiles: string[] };
    sourceSegments: Record<string, number>;
  };
  const manifest = loadManifest(FROZEN_AUDITS["t5-topics-v1"]!.manifestPath) as AuditSourceManifest & { documents: FrozenDocument[] };

  it("the stored audit belongs to this version, covers t1-t4 with the established thresholds and reports no violations", () => {
    expect(HOLDOUT_THRESHOLDS).toEqual(T1_THRESHOLDS);
    expect(artifact).toMatchObject({ datasetId: "t5-topics-v1", datasetVersion: T5_VERSION, references: ["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1"], thresholds: T1_THRESHOLDS });
    expect(artifact.summary).toMatchObject({ comments: 206, goldDefinitions: 9, violations: 0, independenceChecksFailed: 0 });
    expect(artifact.independence.map((c) => c.passed)).toEqual(Array(8).fill(true));
    expect(artifact.provenance.ownResultFiles).toEqual([]);
    for (const kind of ["m2", "m2-heldout-v1", "guideline", "question", "prompt", "spec.md", "design", "test", "fake", "t1", "t1-gold", "t2", "t2-gold", "t3", "t3-gold", "t4", "t4-gold", "t1-replay", "model-output", "doc"]) {
      expect(artifact.sourceSegments[kind], kind).toBeGreaterThan(0);
    }
  });

  it("records the frozen dataset: SHA-256, counts, dispositions and sentiment disagreements", () => {
    expect(artifact.frozenDataset).toEqual({
      fileSha256: T5_SHA256,
      comments: 206,
      topicBase: 194,
      spam: 12,
      goldTopics: 9,
      dispositions: { other: 26, primary_topic: 143, no_specific_topic: 25 },
      topicSizes: { extraction: 19, thermal: 14, grinder: 17, steam_wand: 16, upkeep: 21, warmup: 12, noise: 13, interface: 15, aftercare: 16 },
      sentimentDisagreements: diverging().length,
    });
  });

  it("the frozen sources cover every earlier dataset, every stored result (incl. the t4 paired smoke test) and every t1-t4 analysis document", () => {
    expect(manifest.references.map((r) => r.id)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1"]);
    expect(manifest.modelOutputs.some((f) => f.path.includes("-t4-topics-v1-paired-consolidation-"))).toBe(true);
    expect(manifest.modelOutputs.some((f) => f.path.includes("t5-topics-v1"))).toBe(false);
    expect(manifest.prompts.map((p) => p.source).filter((s) => s.includes("consolidation"))).toEqual(["prompt:topic-consolidation-v3", "prompt:topic-consolidation-v3:retry", "prompt:topic-consolidation-v4", "prompt:topic-consolidation-v4:retry"]);
    expect(manifest.documents.map((d) => d.path)).toEqual([...T5_DOCUMENTS]);
    for (const doc of ["docs/topic-validation-t1-t2-sonnet-v3.md", "docs/topic-validation-t1-t2-t3-sonnet-v3.md", "docs/topic-consolidation-v4-postmortem.md", "docs/topic-consolidation-v4-experiment.md"]) {
      expect(T5_DOCUMENTS, doc).toContain(doc);
    }
    // No earlier audit's frozen sources mention t5.
    for (const id of ["t2-topics-v1", "t3-topics-v1", "t4-topics-v1"]) expect(readFileSync(FROZEN_AUDITS[id]!.manifestPath, "utf8"), id).not.toContain("t5-topics-v1");
  });

  it("re-running the audit against its frozen sources reproduces the recorded counts and finds no overlap", () => {
    const sources = [...collectFrozenSources(manifest), ...frozenDocumentSegments(manifest.documents)];
    const kinds = segmentKinds(sources);
    for (const kind of ["model-output", "t1-replay", "prompt", "t1", "t1-gold", "t2", "t2-gold", "t3", "t3-gold", "t4", "t4-gold", "doc"]) expect(kinds[kind], kind).toBe(artifact.sourceSegments[kind]);
    expect(sources.some((s) => /^test:tests\/(unit\/t5-|topics-benchmark\/)/.test(s.source))).toBe(false);
    const { comments: audited, gold: goldAudit } = T5_AUDIT.auditTexts(JSON.parse(fileText), sources);
    expect([...audited, ...goldAudit].filter((r) => r.violations.length > 0)).toEqual([]);
    expect(frozenIndependenceChecks(manifest, fileText).filter((c) => !c.passed)).toEqual([]);
  }, 240_000);

  it("a changed or missing frozen document fails loudly", () => {
    const [first, ...rest] = manifest.documents;
    expect(() => frozenDocumentSegments([{ ...first!, sha256: "0".repeat(64) }, ...rest])).toThrow(/frozen audit document changed/);
    expect(() => frozenDocumentSegments([{ ...first!, path: "docs/not-a-document.md" }])).toThrow(/frozen audit document missing/);
  });

  it("the structural checks catch IDs, text and labels of any reference, metadata, provider vocabulary and model output", () => {
    const refs = T5_AUDIT.loadReferences();
    const doc = JSON.parse(fileText);
    doc.comments[0].id = refs[3]!.comments[0]!.id;
    doc.comments[1].text = refs[0]!.comments[1]!.text;
    doc.taxonomy[0].acceptedNames.push(refs[1]!.taxonomy[0]!.name);
    doc.comments[2].provider = "x";
    doc.description += " Labelled with help from Sonnet.";
    doc.taxonomy[1].definition = "Synthetic model wording for a probe topic.";
    const failed = T5_AUDIT.checkIndependence(JSON.stringify(doc), refs, [{ source: "probe", strings: ["Synthetic model wording for a probe topic."] }]).filter((c) => !c.passed).map((c) => c.check);
    expect(failed).toHaveLength(6);
    expect(failed.join("\n")).toMatch(/comment IDs[\s\S]*comment text[\s\S]*gold topic key[\s\S]*schema fields[\s\S]*vocabulary[\s\S]*model output/);
  });
});
