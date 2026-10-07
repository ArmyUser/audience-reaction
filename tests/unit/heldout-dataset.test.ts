import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GoldLabelClassifier } from "../../src/adapters/fakes/gold-label-classifier";
import { runClassifierBenchmark } from "../../src/benchmark/classifier-benchmark";
import { BENCHMARK_DATASETS, DEFAULT_BENCHMARK_DATASET, isBenchmarkDatasetId, loadBenchmarkDataset } from "../../src/benchmark/datasets";
import { GUIDELINE_VERSION } from "../../src/core/classification/guidelines";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseClassifierOutput } from "../../src/core/classification/validation";
import { AUDIT_PATH, auditComments, collectSources, normalize } from "../heldout/leakage-audit";

// Held-out benchmark set m2-heldout-v1: 100 synthetic comments that appear in no guideline example, no classifier
// question, the m2 fixture or other tests (see fixtures/m2-heldout-v1/leakage-audit.json).

const HELDOUT_VERSION = "sha256:b278ced3034dfe3a";
const M2_VERSION = "sha256:2ee5c7f4e8e678e5";
const dataset = loadBenchmarkDataset("m2-heldout-v1");
const m2 = loadBenchmarkDataset("m2-synthetic");
const comments = dataset.comments;
const tagged = (tag: string) => comments.filter((c) => c.tags.includes(tag));
const NONE = { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" };

describe("benchmark dataset registry", () => {
  it("registers both datasets; m2-synthetic stays the default and loads unchanged", () => {
    expect(Object.keys(BENCHMARK_DATASETS)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
    expect(DEFAULT_BENCHMARK_DATASET).toBe("m2-synthetic");
    expect(isBenchmarkDatasetId("m2-heldout-v1")).toBe(true);
    expect(isBenchmarkDatasetId("m3")).toBe(false);
    expect(m2).toMatchObject({ name: "m2-synthetic", version: M2_VERSION });
    expect(m2.comments).toHaveLength(60);
  });
});

describe("m2-heldout-v1 dataset", () => {
  it("loads with its own id, a stable content hash and its own focus target", () => {
    expect(dataset.name).toBe("m2-heldout-v1");
    expect(dataset.version).toBe(HELDOUT_VERSION);
    expect(dataset.focus).toEqual({ name: "Larkspur Meals", aliases: ["Larkspur"], isVideoSponsor: true });
    const raw = JSON.parse(readFileSync(BENCHMARK_DATASETS["m2-heldout-v1"], "utf8")) as { guidelineVersion: string; description: string };
    expect(raw.guidelineVersion).toBe(GUIDELINE_VERSION);
    expect(raw.description).toContain("guideline g1.4 ");
  });

  it("has exactly 100 comments with unique, sequential ids and unique texts", () => {
    expect(comments).toHaveLength(100);
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 100 }, (_, i) => `h1-${String(i + 1).padStart(3, "0")}`));
    expect(new Set(comments.map((c) => normalize(c.text) || c.text)).size).toBe(100);
  });

  it("shares no id or text with m2-synthetic", () => {
    const m2Ids = new Set(m2.comments.map((c) => c.id));
    const m2Texts = new Set(m2.comments.map((c) => normalize(c.text)));
    for (const c of comments) {
      expect(m2Ids.has(c.id), c.id).toBe(false);
      expect(m2Texts.has(normalize(c.text)), c.id).toBe(false);
    }
  });

  it.each([
    ["3 labels, focus", { focusConfigured: true }],
    ["3 labels, no focus", { focusConfigured: false }],
    ["4 labels (mixed candidate), focus", { focusConfigured: true, mixedEnabled: true }],
  ])("every gold label passes strict validation (%s)", async (_name, options) => {
    const schema = createClassificationSchema(options);
    const inputs = comments.map((c) => ({ id: c.id, text: c.text }));
    const raw = await new GoldLabelClassifier(comments).classify({ comments: inputs, schema });
    expect(parseClassifierOutput(raw, inputs, schema)).toHaveLength(100);
  });

  it("covers every requested category in the planned proportions", () => {
    const counts: Record<string, number> = {};
    for (const c of comments) counts[c.tags[0]!] = (counts[c.tags[0]!] ?? 0) + 1;
    expect(counts).toEqual({
      opinion: 15,
      info_question: 10,
      action_request: 10,
      opinion_plus_request: 10,
      creator_vs_content: 10,
      content_vs_focus: 10,
      sponsor_ad: 10,
      body_of_work: 5,
      short_reaction: 5,
      timestamp: 5,
      off_topic_spam: 5,
      adversarial: 5,
    });
  });

  it("covers the sponsor, question/request and target edge cases", () => {
    for (const tag of [
      "ad_length",
      "ad_frequency",
      "ad_placement",
      "ad_format",
      "sponsor_repeated",
      "product_eval",
      "product_question",
      "product_request",
      "incidental_brand",
      "generic_reference",
      "non_focus_subject",
      "request_imperative",
      "request_as_question",
      "request_as_wish",
      "both_question_request",
      "creator_question",
      "timestamp_navigation",
      "timestamp_reaction",
      "prompt_injection",
      "fake_json",
      "html_script",
      "sarcasm",
      "irony",
      "mixed",
      "emoji",
      "slang",
      "very_short",
    ])
      expect(tagged(tag).length, tag).toBeGreaterThan(0);
    for (const target of ["creator", "content", "focus"] as const)
      for (const label of ["not_addressed", "positive", "neutral", "negative"])
        expect(comments.some((c) => c.gold.targets[target] === label), `${target} ${label}`).toBe(true);
  });
});

describe("m2-heldout-v1 gold labels follow g1.4 consistently", () => {
  it("primary type question/request carries its flag; flags appear on other types too", () => {
    for (const c of comments) {
      if (c.gold.type === "question") expect(c.gold.isQuestion, c.id).toBe(true);
      if (c.gold.type === "request") expect(c.gold.isRequest, c.id).toBe(true);
    }
    expect(comments.some((c) => c.gold.type === "opinion" && c.gold.isRequest)).toBe(true);
    expect(comments.some((c) => c.gold.type === "opinion" && c.gold.isQuestion)).toBe(true);
    expect(tagged("both_question_request").every((c) => c.gold.isQuestion && c.gold.isRequest)).toBe(true);
  });

  it("requests phrased as questions or wishes are requests, not genuine questions (rule Q)", () => {
    for (const c of [...tagged("request_as_question"), ...tagged("request_as_wish")]) expect(c.gold, c.id).toMatchObject({ isRequest: true, isQuestion: false });
  });

  it("wishes without a recipient leave the creator not addressed; direct requests are creator-neutral (rules G, M)", () => {
    for (const c of tagged("request_as_wish")) expect(c.gold.targets.creator, c.id).toBe("not_addressed");
    for (const c of tagged("request_imperative")) expect(c.gold.targets.creator, c.id).toBe("neutral");
    for (const c of comments.filter((c) => c.gold.targets.creator === "neutral")) expect(c.gold.isQuestion || c.gold.isRequest, c.id).toBe(true);
  });

  it("ad-experience complaints are content, not focus; product evaluations, questions and requests are focus (rule P)", () => {
    for (const tag of ["ad_length", "ad_frequency", "ad_placement", "ad_format", "sponsor_repeated"])
      for (const c of tagged(tag)) expect(c.gold.targets.content, c.id).not.toBe("not_addressed");
    for (const c of tagged("sponsor_ad").filter((c) => !c.tags.includes("product_eval") && !c.tags.includes("product_question") && !c.tags.includes("product_request")))
      expect(c.gold.targets.focus, c.id).toBe("not_addressed");
    for (const c of [...tagged("product_eval"), ...tagged("product_question"), ...tagged("product_request")]) expect(c.gold.targets.focus, c.id).not.toBe("not_addressed");
    for (const c of tagged("incidental_brand")) expect(c.gold.targets.focus, c.id).toBe("not_addressed");
  });

  it("generic references and non-focus products never establish the focus target (rules C, O)", () => {
    for (const c of [...tagged("generic_reference"), ...tagged("non_focus_subject")]) expect(c.gold.targets.focus, c.id).toBe("not_addressed");
  });

  it("body-of-work praise addresses creator and content positively (rule N)", () => {
    for (const c of tagged("body_of_work")) expect(c.gold.targets, c.id).toMatchObject({ creator: "positive", content: "positive" });
  });

  it("system-directed text is other and neutral; spam is neutral; neither has flags or targets (rules H, L)", () => {
    for (const c of tagged("prompt_injection")) expect(c.gold, c.id).toEqual({ type: "other", isQuestion: false, isRequest: false, sentiment: "neutral", targets: NONE });
    for (const c of comments.filter((c) => c.gold.type === "spam_irrelevant"))
      expect(c.gold, c.id).toEqual({ type: "spam_irrelevant", isQuestion: false, isRequest: false, sentiment: "neutral", targets: NONE });
  });

  it("navigation timestamps are other; timestamp reactions are joke_reaction (TIMESTAMP_RULE)", () => {
    for (const c of tagged("timestamp_navigation")) expect(c.gold, c.id).toMatchObject({ type: "other", sentiment: "neutral", targets: NONE });
    for (const c of tagged("timestamp_reaction")) expect(c.gold.type, c.id).toBe("joke_reaction");
  });
});

describe("m2-heldout-v1 through the benchmark harness", () => {
  it("gold labels score perfectly, and results record the held-out dataset", async () => {
    const report = await runClassifierBenchmark(
      dataset,
      () => ({ classifier: new GoldLabelClassifier(comments), provider: "fake", model: "n/a", promptVersion: "n/a", usage: () => [] }),
      { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 },
    );
    expect(report.meta.dataset).toEqual({ name: "m2-heldout-v1", version: HELDOUT_VERSION, size: 100 });
    expect(report.runs[0]!.errorSummary).toMatchObject({ comments: 100, perfectComments: 100, totalFieldErrors: 0 });
    expect(report.runs[0]!.aggregateOverallSentiment.maxAbsDiffPctPoints).toBe(0);
  });
});

describe("m2-heldout-v1 leakage audit", () => {
  const artifact = JSON.parse(readFileSync(AUDIT_PATH, "utf8")) as {
    datasetVersion: string;
    summary: { comments: number; violations: number };
    comments: { id: string; violations: string[] }[];
  };

  it("the stored audit belongs to this exact dataset version and reports no violations", () => {
    expect(artifact.datasetVersion).toBe(HELDOUT_VERSION);
    expect(artifact.summary).toMatchObject({ comments: 100, violations: 0 });
    expect(artifact.comments.map((c) => c.id)).toEqual(comments.map((c) => c.id));
    expect(artifact.comments.every((c) => c.violations.length === 0)).toBe(true);
  });

  it("re-running the audit now still finds no exact, contained or near-duplicate overlap", () => {
    const sources = collectSources();
    expect(sources.some((s) => s.source.startsWith("m2:"))).toBe(true);
    expect(sources.some((s) => s.source.startsWith("guideline:"))).toBe(true);
    // Question texts are de-duplicated across versions, so jev-q2.2's shared texts are attributed to the first set using them.
    for (const version of ["jev-q1", "jev-q2", "jev-q2.1"]) expect(sources.some((s) => s.source.startsWith(`question:${version}:`)), version).toBe(true);
    expect(sources.some((s) => s.source.startsWith("test:"))).toBe(true);
    const result = auditComments(comments, sources);
    expect(result.filter((r) => r.violations.length > 0)).toEqual([]);
  });
});
