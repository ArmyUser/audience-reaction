import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXTURE_DATASETS } from "../../src/adapters/fixtures/fixture-dataset-source";
import { loadEvaluation, spreadOf } from "../../src/local/evaluation";
import { realModeSettings } from "../../src/local/real-mode";
import { EvaluationView } from "../../src/web/EvaluationView";
import manifest from "../../config/evaluation-manifest.json";

// Offline: reads only the committed result files named in the manifest. No provider is called.

describe("evaluation view from the committed manifest", () => {
  const view = loadEvaluation();

  it("reads every listed result file", () => {
    expect(view.problems).toEqual([]);
    expect(view.topics.map((t) => t.dataset.id)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1"]);
    expect(view.classifier.map((c) => c.dataset.id)).toEqual(["m2-synthetic", "m2-heldout-v1"]);
  });

  it("labels every dataset with its role", () => {
    const role = (id: string) => view.datasets.find((d) => d.id === id)?.role;
    expect([role("m2-synthetic"), role("t1-topics-v1")]).toEqual(["development", "development"]);
    expect(role("t2-topics-v1")).toBe("validation");
    expect([role("t3-topics-v1"), role("t4-topics-v1"), role("t5-topics-v1"), role("m2-heldout-v1")]).toEqual(["held-out", "held-out", "held-out", "held-out"]);
  });

  it("the web app's fixture datasets are exactly the development sets", () => {
    const development = view.datasets.filter((d) => d.role === "development").map((d) => d.id).sort();
    expect(Object.keys(FIXTURE_DATASETS).sort()).toEqual(development);
  });

  it("every shown result matches the effective pipeline", () => {
    for (const t of view.topics) expect(t.matchesCurrent, t.dataset.id).toBe(true);
    for (const c of view.classifier) expect(c.matchesCurrent, c.dataset.id).toBe(true);
    expect(view.pipeline.map((p) => p.component)).toEqual([
      "Jev jev-latest · jev-q2.2",
      "Sonnet claude-sonnet-5-5 · topic-discovery-v2 · effort high",
      "Sonnet claude-sonnet-5-5 · topic-consolidation-v3",
      "Jev jev-latest · jev-topic-a1 (topic-assignment-v1)",
    ]);
  });

  it("reproduces the documented topic precision (docs/topic-validation-t1-t2-t3-sonnet-v3.md)", () => {
    const precision = (id: string) => view.topics.find((t) => t.dataset.id === id)!.metrics.find((m) => m.key === "topicPrecision")!.spread.mean;
    expect(precision("t1-topics-v1")).toBeCloseTo(0.921, 3);
    expect(precision("t2-topics-v1")).toBeCloseTo(0.839, 3);
    expect(precision("t3-topics-v1")).toBeCloseTo(0.745, 3);
  });

  it("includes Other rate, coverage, latency, cost and per-class classifier metrics", () => {
    const keys = view.topics[0]!.metrics.map((m) => m.key);
    for (const k of ["otherRate", "topicCoverage", "costUsd", "discoveryMs", "consolidationMs", "assignmentMs", "otherAccuracy"]) expect(keys).toContain(k);
    const sentiment = view.classifier[1]!.tasks.find((t) => t.task === "sentiment")!;
    expect(sentiment.perClass.map((c) => c.label).sort()).toEqual(["negative", "neutral", "positive"]);
    for (const c of sentiment.perClass) for (const v of [c.precision, c.recall, c.f1]) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("renders role badges and keeps benchmark metrics out of customer wording", () => {
    const html = renderToStaticMarkup(<EvaluationView view={view} />);
    expect(html).toContain("Internal · not customer-facing");
    expect(html).toContain("Effective pipeline");
    expect(html).toContain("role-held-out");
    expect(html).toContain("Validation");
    expect(html).toContain("Topic precision");
  });
});

describe("evaluation loader safety", () => {
  const settings = realModeSettings();
  const base = { datasets: manifest.datasets, classifier: [], topics: [] };

  it("refuses paths and reports unreadable files instead of dropping them", () => {
    const view = loadEvaluation({
      settings,
      manifest: { ...base, topics: [{ dataset: "t1-topics-v1", files: ["../.env", "missing.json"] }] },
      readResult: (file) => {
        throw new Error(`no ${file}`);
      },
    });
    expect(view.problems).toEqual(["../.env: not a plain result file name", "missing.json: could not be read or parsed"]);
    expect(view.topics).toEqual([]);
  });

  it("flags a result whose configuration differs from the current pipeline", () => {
    const result = JSON.stringify({
      meta: { discovery: { contract: "topic-discovery-v3", modelRequested: "claude-sonnet-5-5", effort: "high" }, consolidation: {}, assignment: { questionSet: "jev-topic-a1", modelRequested: "jev-latest" } },
      report: { scenarios: [{ group: "live", runs: [{ taxonomy: { topicPrecision: 0.5 } }] }] },
    });
    const view = loadEvaluation({ settings, manifest: { ...base, topics: [{ dataset: "t1-topics-v1", files: ["x.json"] }] }, readResult: () => result });
    expect(view.topics[0]!.matchesCurrent).toBe(false);
    expect(view.topics[0]!.configuration).toContain("no consolidation");
  });

  it("spreadOf summarises repeats", () => {
    expect(spreadOf([0.5, 1, 0.75])).toEqual({ mean: 0.75, min: 0.5, max: 1, n: 3 });
    expect(spreadOf([])).toBeNull();
  });
});
