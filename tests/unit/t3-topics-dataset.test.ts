import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BENCHMARK_DATASETS } from "../../src/benchmark/datasets";
import { definitionProblems, runTopicBenchmark } from "../../src/benchmark/topic-benchmark";
import { goldOf, isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, parseTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import { DEFAULT_TOPIC_PARAMETERS, minimumTopicSize } from "../../src/core/topics/aggregate-topics";
import { TOPIC_CONSOLIDATION_CONTRACT } from "../../src/core/topics/consolidation-contract";
import { normalizeTopicName } from "../../src/core/topics/normalize";
import { TOPIC_DISCOVERY_CONTRACT } from "../../src/core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { normalize } from "../heldout/leakage-audit";
import { T1_THRESHOLDS } from "../topics-benchmark/t1-leakage-audit";
import { collectFrozenT3Sources, frozenIndependenceChecks, loadManifest } from "../topics-benchmark/audit-source-manifest";
import { auditT3Texts, checkT3Independence, loadReferences, T3_AUDIT_PATH, T3_PATH } from "../topics-benchmark/t3-leakage-audit";

// Final hold-out set t3-topics-v1: 204 synthetic comments for an independent creator's review of a fictional
// cooperative board game, authored separately from t1 and t2 (different domain, comments, taxonomy and gold) with
// the same schema and gold semantics. Gold was written before any provider run on it and without any result file.

const T3_VERSION = "sha256:41e90795c48cf637";
const ROOT = join(__dirname, "..", "..");
const dataset = loadTopicBenchmarkDataset("t3-topics-v1");
const gold = goldOf(dataset);
const comments = dataset.comments;
const tagged = (tag: string) => comments.filter((c) => c.tags.includes(tag));
const fileText = readFileSync(T3_PATH, "utf8");
const references = (["t1-topics-v1", "t2-topics-v1"] as const).map((id) => loadTopicBenchmarkDataset(id));
const keyOf = (c: (typeof comments)[number]) => (c.topic === null ? "spam" : c.topic.disposition === "primary_topic" ? c.topic.topicKey : c.topic.disposition);

describe("t3-topics-v1 registry and identity", () => {
  it("is registered after t1 and t2; the classifier benchmark datasets are unchanged", () => {
    expect(Object.keys(TOPIC_BENCHMARK_DATASETS)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1"]);
    expect(isTopicBenchmarkDatasetId("t3-topics-v1")).toBe(true);
    expect(Object.keys(BENCHMARK_DATASETS)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
  });

  it("loads with its dataset ID, a stable content hash, the shared schema and its own fictional, unsponsored focus", () => {
    expect(dataset.id).toBe("t3-topics-v1");
    expect(dataset.version).toBe(T3_VERSION);
    for (const ref of references) {
      expect(dataset.schema).toEqual(ref.schema);
      expect(dataset.focus.name).not.toBe(ref.focus.name);
    }
    expect(dataset.focus).toEqual({ name: "Driftwardens", aliases: ["Driftwarden"], isVideoSponsor: false });
  });

  it("has 204 comments with sequential t3 IDs and unique texts", () => {
    expect(comments).toHaveLength(204);
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 204 }, (_, i) => `t3-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(comments.map((c) => normalize(c.text) || c.text)).size).toBe(204);
  });

  it("shares no ID, text or focus target with t1, t2, m2-synthetic or m2-heldout-v1", () => {
    const others = [...Object.values(BENCHMARK_DATASETS), TOPIC_BENCHMARK_DATASETS["t1-topics-v1"], TOPIC_BENCHMARK_DATASETS["t2-topics-v1"]];
    for (const path of others) {
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

describe("t3-topics-v1 gold taxonomy", () => {
  it("has 9 topics with keys, names and definitions of its own", () => {
    expect(dataset.taxonomy.map((t) => t.key)).toEqual(["rules", "difficulty", "components", "artwork", "playtime", "solo", "player_count", "replay", "theme"]);
    expect(new Set(dataset.taxonomy.map((t) => normalizeTopicName(t.name))).size).toBe(9);
    for (const t of dataset.taxonomy) {
      expect(definitionProblems(t.name, t.definition, comments.map((c) => c.text)), t.key).toEqual([]);
      expect(t.acceptedNames.length, t.key).toBeGreaterThan(0);
    }
    const refKeys = new Set(references.flatMap((r) => r.taxonomy.map((t) => t.key)));
    const refNames = new Set(references.flatMap((r) => r.taxonomy.flatMap((t) => [t.name, ...t.acceptedNames])).map(normalizeTopicName));
    for (const t of dataset.taxonomy) {
      expect(refKeys.has(t.key), t.key).toBe(false);
      for (const n of [t.name, ...t.acceptedNames]) expect(refNames.has(normalizeTopicName(n)), n).toBe(false);
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

describe("t3-topics-v1 gold assignment", () => {
  it("gives every non-spam comment exactly one gold disposition and spam none", () => {
    expect(gold.baseIds).toHaveLength(192);
    for (const c of comments) expect(c.topic === null, c.id).toBe(c.classification.type === "spam_irrelevant");
    const counts: Record<string, number> = {};
    for (const d of gold.dispositions.values()) counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;
    expect(counts).toEqual({ primary_topic: 144, other: 25, no_specific_topic: 23 });
    expect(tagged("spam")).toHaveLength(12);
    expect(tagged("off_topic")).toHaveLength(5);
  });

  it("has large and small named topics; one sits exactly at the production minimum topic size", () => {
    const sizes = Object.fromEntries(dataset.taxonomy.map((t) => [t.key, gold.members.get(t.key)!.length]));
    expect(sizes).toEqual({ rules: 22, difficulty: 18, components: 24, artwork: 16, playtime: 14, solo: 10, player_count: 12, replay: 15, theme: 13 });
    const min = minimumTopicSize(gold.baseIds.length, DEFAULT_TOPIC_PARAMETERS);
    expect(min).toBe(10);
    expect(Object.entries(sizes).filter(([, n]) => n === min).map(([k]) => k)).toEqual(["solo"]);
    expect(Object.values(sizes).every((n) => n >= min)).toBe(true);
    expect(tagged("boundary_size").every((c) => keyOf(c) === "solo")).toBe(true);
    // Gold OTHER (25) and NO_SPECIFIC_TOPIC (23) are meaningful but below the 35% warning together.
    expect(((25 + 23) / 192) * 100).toBeLessThan(DEFAULT_TOPIC_PARAMETERS.otherWarningThresholdPercent);
  });

  it("keeps tempting peripheral subjects in OTHER and comments that only mention the focus outside named topics", () => {
    expect(tagged("peripheral")).toHaveLength(13);
    for (const c of tagged("peripheral")) expect(keyOf(c), c.id).toBe("other");
    for (const c of tagged("incidental_mention")) expect(keyOf(c), c.id).toBe("other");
    expect(tagged("focus_mention_only").map(keyOf).sort()).toEqual(["no_specific_topic", "other"]);
    for (const c of tagged("focus_mention_only")) expect(c, c.id).toMatchObject({ focusMention: "explicit", classification: { targets: { focus: "not_addressed" } } });
  });

  it("groups related aspects into broad topics and keeps adjacent topics apart", () => {
    expect(new Set(tagged("broad_scope").map(keyOf))).toEqual(new Set(["components", "playtime"]));
    expect(tagged("adjacent").length).toBeGreaterThanOrEqual(10);
    expect(tagged("ambiguous")).toHaveLength(3);
    for (const c of tagged("ambiguous")) expect(keyOf(c), c.id).not.toMatch(/^(other|no_specific_topic|spam)$/);
  });

  it("varies topic sentiment within every topic and separates it from overall sentiment in both directions", () => {
    for (const t of dataset.taxonomy) {
      const labels = new Set(gold.members.get(t.key)!.map((id) => (gold.dispositions.get(id) as { topicSentiment: string }).topicSentiment));
      expect([...labels].sort(), t.key).toEqual(["negative", "neutral", "positive"]);
    }
    const pairs: Record<string, number> = {};
    for (const id of gold.baseIds) {
      const d = gold.dispositions.get(id)!;
      const overall = gold.overallSentiment.get(id)!;
      if (d.disposition === "primary_topic" && overall !== d.topicSentiment) pairs[`${overall}->${d.topicSentiment}`] = (pairs[`${overall}->${d.topicSentiment}`] ?? 0) + 1;
    }
    expect(pairs).toEqual({ "positive->negative": 8, "negative->positive": 8 });
    for (const c of tagged("sentiment_diverges")) expect((c.topic as { topicSentiment: string }).topicSentiment, c.id).not.toBe(c.classification.sentiment);
  });

  it("covers every required slice", () => {
    const counts: Record<string, number> = {};
    for (const c of comments) for (const t of c.tags) counts[t] = (counts[t] ?? 0) + 1;
    for (const tag of ["question", "request", "sarcasm", "slang", "prompt_injection", "fake_json", "fake_instruction", "html_script", "short", "generic", "focus_evaluation", "creator_content", "lexical_variant"]) {
      expect(counts[tag] ?? 0, tag).toBeGreaterThan(0);
    }
    for (const tag of ["prompt_injection", "fake_json", "fake_instruction", "generic", "focus_evaluation"]) for (const c of tagged(tag)) expect(keyOf(c), `${tag} ${c.id}`).toBe("no_specific_topic");
    for (const c of tagged("request")) expect(c.topic, c.id).toMatchObject({ disposition: "primary_topic", topicSentiment: "neutral" });
  });

  it("uses explicit and inferred focus mentions consistent with the engine's focus matcher", () => {
    const mentions: Record<string, number> = {};
    for (const c of comments) mentions[c.focusMention] = (mentions[c.focusMention] ?? 0) + 1;
    expect(mentions).toEqual({ explicit: 2, inferred: 146, none: 56 });
  });

  it("is checked by the same parser as t1 and t2", () => {
    const doc = JSON.parse(fileText);
    expect(() => parseTopicBenchmarkDataset(fileText, "t3-topics-v1")).not.toThrow();
    doc.comments.find((c: { topic: { disposition?: string } | null }) => c.topic?.disposition === "primary_topic").topic.topicKey = "not_a_t3_topic";
    expect(() => parseTopicBenchmarkDataset(JSON.stringify(doc), "t3-topics-v1")).toThrow(/unknown gold topic not_a_t3_topic/);
  });
});

describe("t3-topics-v1 oracle gate", () => {
  it("the oracle passes with every metric perfect, and every offline scenario meets its stated expectation", async () => {
    const report = await runTopicBenchmark(dataset);
    expect(report.oracleGate).toEqual({ passed: true, failures: [] });
    expect(report.scenarios[0]!.perfect).toBe(true);
    for (const s of report.scenarios) expect(s.expectationFailures, s.id).toEqual([]);
  });
});

describe("t3-topics-v1 independence and leakage audit", () => {
  const artifact = JSON.parse(readFileSync(T3_AUDIT_PATH, "utf8")) as {
    datasetId: string;
    datasetVersion: string;
    references: string[];
    thresholds: typeof T1_THRESHOLDS;
    summary: { comments: number; goldDefinitions: number; violations: number; independenceChecksFailed: number };
    independence: { passed: boolean }[];
    provenance: { t3ResultFiles: string[] };
    sourceSegments: Record<string, number>;
    comments: { id: string }[];
  };

  it("the stored audit belongs to this exact dataset version, covers t1 and t2, uses the same thresholds and reports no violations", () => {
    expect(artifact).toMatchObject({ datasetId: "t3-topics-v1", datasetVersion: T3_VERSION, references: ["t1-topics-v1", "t2-topics-v1"], thresholds: T1_THRESHOLDS });
    expect(artifact.summary).toMatchObject({ comments: 204, goldDefinitions: 9, violations: 0, independenceChecksFailed: 0 });
    expect(artifact.independence.map((c) => c.passed)).toEqual(Array(8).fill(true));
    expect(artifact.comments.map((c) => c.id)).toEqual(comments.map((c) => c.id));
    for (const kind of ["m2", "m2-heldout-v1", "guideline", "question", "prompt", "spec.md", "design", "test", "fake", "t1", "t1-gold", "t2", "t2-gold", "t1-replay", "model-output"]) {
      expect(artifact.sourceSegments[kind], kind).toBeGreaterThan(0);
    }
  });

  it("gold was authored before any provider run on this dataset version", () => {
    expect(artifact.provenance.t3ResultFiles).toEqual([]);
  });

  it("re-running the audit against its frozen sources finds no overlap with t1, t2, the prompts, earlier sources or stored model outputs", () => {
    // The comparison sources are the ones the completed audit used (tests/topics-benchmark/manifests/), so results
    // stored after the audit cannot change its meaning; see tests/unit/t3-audit-source-manifest.test.ts.
    const manifest = loadManifest();
    const sources = collectFrozenT3Sources(manifest);
    for (const prefix of ["t1:", "t2:", "t1-gold:", "t2-gold:", "t1-replay:", "model-output:", "prompt:discovery", "prompt:consolidation", "prompt:assignment", "m2:", "guideline:"]) {
      expect(sources.some((s) => s.source.startsWith(prefix)), prefix).toBe(true);
    }
    expect(sources.some((s) => /^test:tests\/(unit\/t3-|topics-benchmark\/)/.test(s.source))).toBe(false);
    const { comments: audited, gold: goldAudit } = auditT3Texts(JSON.parse(fileText), sources);
    expect([...audited, ...goldAudit].filter((r) => r.violations.length > 0)).toEqual([]);
    expect(frozenIndependenceChecks(manifest, fileText).filter((c) => !c.passed)).toEqual([]);
  }, 120_000);

  it("the structural checks catch IDs, text and gold labels of either reference, metadata, provider vocabulary and model output", () => {
    const [t1, t2] = loadReferences();
    const doc = JSON.parse(fileText);
    doc.comments[0].id = t2!.comments[0]!.id;
    doc.comments[1].text = t1!.comments[1]!.text;
    doc.taxonomy[0].acceptedNames.push(t2!.taxonomy[0]!.name);
    doc.comments[2].provider = "x";
    doc.description += " Labelled with help from Claude.";
    doc.taxonomy[1].definition = "Synthetic model wording for a probe topic.";
    const failed = checkT3Independence(JSON.stringify(doc), [t1!, t2!], [{ source: "probe", strings: ["Synthetic model wording for a probe topic."] }]).filter((c) => !c.passed).map((c) => c.check);
    expect(failed).toEqual([
      "no comment IDs of t1-topics-v1, t2-topics-v1; t3 IDs are t3-NNN",
      "no comment text of t1-topics-v1, t2-topics-v1 (exact normalised)",
      "no gold topic key, name or accepted name of t1-topics-v1, t2-topics-v1 in the t3 taxonomy",
      "only the shared dataset schema fields (no model, provider or prompt metadata)",
      "no provider, model or contract vocabulary in the fixture",
      "no stored model output embedded in the gold (exact or contained, either direction)",
    ]);
  });
});

describe("t3-topics-v1 with the frozen candidate pipeline (no calls)", () => {
  it("uses the frozen discovery and consolidation contracts", () => {
    expect(TOPIC_DISCOVERY_CONTRACT).toBe("topic-discovery-v2");
    expect(TOPIC_CONSOLIDATION_CONTRACT).toBe("topic-consolidation-v3");
  });

  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const RESULTS = join(ROOT, "benchmark-results");
  const cli = (args: string[]) => {
    const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
    const out = spawnSync(TSX, ["src/benchmark/topics-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []).toEqual(before);
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("real-consolidated accepts t3: without --live it prints the plan, makes no call and refuses to start", () => {
    const { status, text } = cli(["--suite", "real-consolidated", "--dataset", "t3-topics-v1", "--provider", "anthropic", "--model", "claude-sonnet-5-5", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("topic base 192");
    expect(text).toContain("--suite real-consolidated --dataset t3-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1");
    expect(text).not.toContain("WILL BE MADE");
  }, 60_000);
});
