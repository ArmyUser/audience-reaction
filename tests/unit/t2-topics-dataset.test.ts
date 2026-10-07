import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BENCHMARK_DATASETS } from "../../src/benchmark/datasets";
import { definitionProblems, runTopicBenchmark } from "../../src/benchmark/topic-benchmark";
import { goldOf, isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, parseTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import { TOPIC_CONSOLIDATION_CONTRACT } from "../../src/core/topics/consolidation-contract";
import { DEFAULT_TOPIC_PARAMETERS, minimumTopicSize } from "../../src/core/topics/aggregate-topics";
import { normalizeTopicName } from "../../src/core/topics/normalize";
import { TOPIC_DISCOVERY_CONTRACT } from "../../src/core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { normalize } from "../heldout/leakage-audit";
import { T1_THRESHOLDS } from "../topics-benchmark/t1-leakage-audit";
import { collectFrozenSources, FROZEN_AUDITS, frozenIndependenceChecks, loadManifest } from "../topics-benchmark/audit-source-manifest";
import { auditT2Texts, checkT2Independence, loadT1, T2_AUDIT_PATH, T2_PATH, T2_THRESHOLDS } from "../topics-benchmark/t2-leakage-audit";

// Independent validation set t2-topics-v1: 201 synthetic comments for an independent creator's review of a fictional
// mirrorless camera, authored separately from t1-topics-v1 (different domain, comments, taxonomy and gold) with the
// same schema and gold semantics. Gold was written before any provider run on it.

const T2_VERSION = "sha256:c0087c94db1713b2";
const ROOT = join(__dirname, "..", "..");
const dataset = loadTopicBenchmarkDataset("t2-topics-v1");
const gold = goldOf(dataset);
const comments = dataset.comments;
const tagged = (tag: string) => comments.filter((c) => c.tags.includes(tag));
const fileText = readFileSync(T2_PATH, "utf8");
const t1 = loadTopicBenchmarkDataset("t1-topics-v1");

describe("t2-topics-v1 registry and identity", () => {
  it("is registered next to t1 in the topic registry; the classifier benchmark datasets are unchanged", () => {
    expect(Object.keys(TOPIC_BENCHMARK_DATASETS)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1"]);
    expect(isTopicBenchmarkDatasetId("t2-topics-v1")).toBe(true);
    expect(Object.keys(BENCHMARK_DATASETS)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
  });

  it("loads with its dataset ID, a stable content hash, the t1 schema and its own fictional, unsponsored focus", () => {
    expect(dataset.id).toBe("t2-topics-v1");
    expect(dataset.version).toBe(T2_VERSION);
    expect(dataset.schema).toEqual(t1.schema);
    expect(dataset.focus).toEqual({ name: "Lumora S9", aliases: ["Lumora", "S9"], isVideoSponsor: false });
    expect(dataset.focus.name).not.toBe(t1.focus.name);
  });

  it("has 201 comments with sequential t2 IDs and unique texts", () => {
    expect(comments).toHaveLength(201);
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 201 }, (_, i) => `t2-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(comments.map((c) => normalize(c.text) || c.text)).size).toBe(201);
  });

  it("shares no ID, text or focus target with t1, m2-synthetic or m2-heldout-v1", () => {
    const others = [...Object.values(BENCHMARK_DATASETS), TOPIC_BENCHMARK_DATASETS["t1-topics-v1"]];
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

describe("t2-topics-v1 gold taxonomy", () => {
  it("has 9 topics with keys, names and definitions of its own", () => {
    expect(dataset.taxonomy.map((t) => t.key)).toEqual(["autofocus", "image_quality", "video", "stabilization", "handling", "menus", "viewfinder", "lenses", "ruggedness"]);
    expect(new Set(dataset.taxonomy.map((t) => normalizeTopicName(t.name))).size).toBe(9);
    for (const t of dataset.taxonomy) {
      expect(definitionProblems(t.name, t.definition, comments.map((c) => c.text)), t.key).toEqual([]);
      expect(t.acceptedNames.length, t.key).toBeGreaterThan(0);
    }
    const t1Keys = new Set(t1.taxonomy.map((t) => t.key));
    const t1Names = new Set(t1.taxonomy.flatMap((t) => [t.name, ...t.acceptedNames]).map(normalizeTopicName));
    for (const t of dataset.taxonomy) {
      expect(t1Keys.has(t.key), t.key).toBe(false);
      for (const n of [t.name, ...t.acceptedNames]) expect(t1Names.has(normalizeTopicName(n)), n).toBe(false);
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

describe("t2-topics-v1 gold assignment", () => {
  it("gives every non-spam comment exactly one gold disposition and spam none", () => {
    expect(gold.baseIds).toHaveLength(190);
    for (const c of comments) expect(c.topic === null, c.id).toBe(c.classification.type === "spam_irrelevant");
    const counts: Record<string, number> = {};
    for (const d of gold.dispositions.values()) counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;
    expect(counts).toEqual({ primary_topic: 142, other: 25, no_specific_topic: 23 });
    expect(tagged("spam")).toHaveLength(11);
  });

  it("has large, medium and small named topics, all at or above the production minimum topic size", () => {
    const sizes = Object.fromEntries(dataset.taxonomy.map((t) => [t.key, gold.members.get(t.key)!.length]));
    expect(sizes).toEqual({ autofocus: 24, image_quality: 22, video: 20, stabilization: 12, handling: 16, menus: 12, viewfinder: 12, lenses: 14, ruggedness: 10 });
    const min = minimumTopicSize(gold.baseIds.length, DEFAULT_TOPIC_PARAMETERS);
    expect(min).toBe(10);
    expect(Object.values(sizes).every((n) => n >= min)).toBe(true);
    // Gold OTHER (25) and NO_SPECIFIC_TOPIC (23) are meaningful but below the 35% warning together.
    expect(((25 + 23) / 190) * 100).toBeLessThan(DEFAULT_TOPIC_PARAMETERS.otherWarningThresholdPercent);
  });

  it("keeps small peripheral subjects outside the named taxonomy, each below the minimum topic size", () => {
    expect(tagged("peripheral")).toHaveLength(17);
    for (const c of tagged("peripheral")) expect(c.topic?.disposition, c.id).toBe("other");
    for (const c of tagged("incidental_mention")) expect(c.topic?.disposition, c.id).toBe("other");
  });

  it("keeps broad topics broad and separates adjacent topics", () => {
    const keyOf = (tag: string) => tagged(tag).map((c) => (c.topic?.disposition === "primary_topic" ? c.topic.topicKey : c.topic?.disposition));
    expect(new Set(keyOf("broad_scope"))).toEqual(new Set(["image_quality", "video"]));
    expect(tagged("broad_scope")).toHaveLength(20);
    // Adjacent pairs that stay distinct: grip vs menus, video vs stabilization, autofocus vs viewfinder.
    expect(new Set(keyOf("adjacent"))).toEqual(new Set(["stabilization", "handling", "autofocus", "menus", "viewfinder", "ruggedness", "lenses"]));
    expect(tagged("ambiguous")).toHaveLength(5);
    for (const c of tagged("ambiguous")) expect(c.topic?.disposition, c.id).toBe("primary_topic");
  });

  it("varies topic sentiment within every topic", () => {
    for (const t of dataset.taxonomy) {
      const labels = new Set(gold.members.get(t.key)!.map((id) => (gold.dispositions.get(id) as { topicSentiment: string }).topicSentiment));
      expect([...labels].sort(), t.key).toEqual(["negative", "neutral", "positive"]);
    }
  });

  it("separates topic sentiment from overall sentiment in several directions", () => {
    const pairs = new Map<string, number>();
    for (const id of gold.baseIds) {
      const d = gold.dispositions.get(id)!;
      if (d.disposition !== "primary_topic") continue;
      const overall = gold.overallSentiment.get(id)!;
      if (overall !== d.topicSentiment) pairs.set(`${overall}->${d.topicSentiment}`, (pairs.get(`${overall}->${d.topicSentiment}`) ?? 0) + 1);
    }
    expect(Object.fromEntries(pairs)).toEqual({ "negative->positive": 7, "positive->negative": 6, "neutral->negative": 1 });
    expect(tagged("sentiment_diverges")).toHaveLength(14);
    for (const c of tagged("sentiment_diverges")) {
      expect(c.topic?.disposition, c.id).toBe("primary_topic");
      expect((c.topic as { topicSentiment: string }).topicSentiment, c.id).not.toBe(c.classification.sentiment);
    }
  });

  it("covers every required slice", () => {
    const counts: Record<string, number> = {};
    for (const c of comments) for (const t of c.tags) counts[t] = (counts[t] ?? 0) + 1;
    expect(counts).toEqual({
      strong: 46, short: 12, sentiment_diverges: 14, neutral_overall: 14, peripheral: 17, prompt_injection: 2, adjacent: 21, request: 6,
      generic: 19, broad_scope: 20, spam: 11, lexical_variant: 12, focus_evaluation: 5, creator_content: 5, ambiguous: 5, borderline: 2,
      off_topic: 4, sarcasm: 2, mixed: 2, question: 20, html_script: 2, incidental_mention: 2, fake_json: 1,
    });
    for (const tag of ["generic", "focus_evaluation", "prompt_injection"]) for (const c of tagged(tag)) expect(c.topic?.disposition, `${tag} ${c.id}`).toBe("no_specific_topic");
    for (const c of tagged("request")) expect(c.topic, c.id).toMatchObject({ disposition: "primary_topic", topicSentiment: "neutral" });
  });

  it("uses explicit and inferred focus mentions consistent with the engine's focus matcher", () => {
    const mentions: Record<string, number> = {};
    for (const c of comments) mentions[c.focusMention] = (mentions[c.focusMention] ?? 0) + 1;
    expect(mentions).toEqual({ explicit: 6, inferred: 147, none: 48 });
  });
});

describe("t2-topics-v1 dataset validation", () => {
  const mutate = (fn: (doc: { taxonomy: { key: string; name: string }[]; comments: Record<string, unknown>[] }) => void) => {
    const doc = JSON.parse(fileText);
    fn(doc);
    return () => parseTopicBenchmarkDataset(JSON.stringify(doc), "t2-topics-v1");
  };

  it("is checked by the same parser as t1", () => {
    expect(mutate(() => undefined)).not.toThrow();
    expect(mutate((d) => void ((d.comments.find((c) => (c.topic as { disposition?: string } | null)?.disposition === "primary_topic")!.topic as { topicKey: string }).topicKey = "not_a_t2_topic"))).toThrow(/unknown gold topic not_a_t2_topic/);
    expect(mutate((d) => void (d.taxonomy[1]!.name = d.taxonomy[0]!.name.toUpperCase()))).toThrow(/duplicate_topic_name/);
  });
});

describe("t2-topics-v1 oracle gate", () => {
  it("the oracle passes with every metric perfect, and every offline scenario meets its stated expectation", async () => {
    const report = await runTopicBenchmark(dataset);
    expect(report.meta.datasetId).toBe("t2-topics-v1");
    expect(report.oracleGate).toEqual({ passed: true, failures: [] });
    expect(report.scenarios[0]!.perfect).toBe(true);
    for (const s of report.scenarios) expect(s.expectationFailures, s.id).toEqual([]);
  });
});

describe("t2-topics-v1 independence and leakage audit", () => {
  const artifact = JSON.parse(readFileSync(T2_AUDIT_PATH, "utf8")) as {
    datasetId: string;
    datasetVersion: string;
    thresholds: typeof T2_THRESHOLDS;
    summary: { comments: number; goldDefinitions: number; violations: number; independenceChecksFailed: number };
    independence: { check: string; passed: boolean }[];
    provenance: { t2ResultFiles: string[] };
    sourceSegments: Record<string, number>;
    comments: { id: string; violations: string[] }[];
  };

  it("the stored audit belongs to this exact dataset version, uses the t1 thresholds and reports no violations", () => {
    expect(artifact.datasetId).toBe("t2-topics-v1");
    expect(artifact.datasetVersion).toBe(T2_VERSION);
    expect(artifact.thresholds).toEqual(T1_THRESHOLDS);
    expect(artifact.summary).toMatchObject({ comments: 201, goldDefinitions: 9, violations: 0, independenceChecksFailed: 0 });
    expect(artifact.independence.map((c) => c.passed)).toEqual(Array(8).fill(true));
    expect(artifact.comments.map((c) => c.id)).toEqual(comments.map((c) => c.id));
    for (const kind of ["m2", "m2-heldout-v1", "guideline", "question", "prompt", "spec.md", "design", "test", "fake", "t1", "t1-gold", "t1-replay", "model-output"]) {
      expect(artifact.sourceSegments[kind], kind).toBeGreaterThan(0);
    }
  });

  it("gold was authored before any provider run on this dataset version", () => {
    expect(artifact.provenance.t2ResultFiles).toEqual([]);
  });

  it("re-running the audit against its frozen sources finds no overlap with t1, the prompts, the earlier sources or stored model outputs", () => {
    // The comparison sources are the ones the completed audit used (tests/topics-benchmark/manifests/), so results
    // stored after the audit cannot change its meaning; see tests/unit/audit-source-manifests.test.ts.
    const manifest = loadManifest(FROZEN_AUDITS["t2-topics-v1"]!.manifestPath);
    const sources = collectFrozenSources(manifest);
    for (const prefix of ["t1:", "t1-gold:", "t1-replay:", "model-output:", "prompt:discovery", "prompt:consolidation", "prompt:assignment", "m2:", "guideline:", "question:"]) {
      expect(sources.some((s) => s.source.startsWith(prefix)), prefix).toBe(true);
    }
    expect(sources.some((s) => /^test:tests\/(unit\/t2-|topics-benchmark\/)/.test(s.source))).toBe(false);
    const t2 = JSON.parse(fileText);
    const { comments: audited, gold: goldAudit } = auditT2Texts(t2, sources);
    expect([...audited, ...goldAudit].filter((r) => r.violations.length > 0)).toEqual([]);
    expect(frozenIndependenceChecks(manifest, fileText).filter((c) => !c.passed)).toEqual([]);
  }, 120_000);

  it("the structural checks catch t1 IDs, t1 text, t1 gold names, model metadata, provider vocabulary and model output", () => {
    const t1Doc = loadT1();
    const doc = JSON.parse(fileText);
    doc.comments[0].id = t1Doc.comments[0]!.id;
    doc.comments[1].text = t1Doc.comments[1]!.text;
    doc.taxonomy[0].acceptedNames.push(t1Doc.taxonomy[0]!.name);
    doc.comments[2].model = "x";
    doc.description += " Labelled with help from Gemini.";
    doc.taxonomy[1].definition = "Synthetic model wording for probe topic.";
    const failed = checkT2Independence(JSON.stringify(doc), t1Doc, [{ source: "probe", strings: ["Synthetic model wording for probe topic."] }]).filter((c) => !c.passed).map((c) => c.check);
    expect(failed).toEqual([
      "no t1 comment IDs; t2 IDs are t2-NNN",
      "no t1 comment text (exact normalised)",
      "no t1 gold topic key, name or accepted name in the t2 taxonomy",
      "only the shared dataset schema fields (no model, provider or prompt metadata)",
      "no provider, model or contract vocabulary in the fixture",
      "no stored model output embedded in the gold (exact or contained, either direction)",
    ]);
  });
});

describe("t2-topics-v1 with the frozen candidate pipeline", () => {
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

  it("the real-consolidated suite accepts t2: without --live it prints the plan, makes no call and refuses to start", () => {
    const { status, text } = cli(["--suite", "real-consolidated", "--dataset", "t2-topics-v1", "--provider", "anthropic", "--model", "claude-sonnet-5-5", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("t2-topics-v1");
    expect(text).toContain("topic base 190");
    expect(text).toContain("--suite real-consolidated --dataset t2-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1");
    expect(text).not.toContain("WILL BE MADE");
  }, 60_000);

  it("the real preflight accepts t2 and makes no call", () => {
    const { status, text } = cli(["--suite", "real-preflight", "--dataset", "t2-topics-v1", "--provider", "anthropic", "--model", "claude-sonnet-5-5"]);
    expect(status).toBe(0);
    expect(text).toContain("t2-topics-v1");
    expect(text).toContain("NO API CALLS MADE");
  }, 60_000);
});
