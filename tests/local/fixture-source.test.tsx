import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_DATASETS, FixtureDatasetSource } from "../../src/adapters/fixtures/fixture-dataset-source";
import { analyzeVideoSync } from "../../src/application/analyze-video-sync";
import { STRICT_POLICY_CONFIG } from "../../src/core/policy/compliance-policy";
import { analysisSetup, analysisTelemetry, createRealAnalysis, realModeSettings, selectAnalysisSource } from "../../src/local/real-mode";
import { Report } from "../../src/web/Report";
import t1 from "../../fixtures/t1-topics-v1/comments.json";
import { reportProps, VALID_URL } from "../helpers";

// Offline only: fake keys; a fetch that fails the test on any request; a cost cap too small for any AI call.

const ROOT = resolve(__dirname, "../..");
const AI_KEYS = { ANTHROPIC_API_KEY: "sk-ant-fake-0123456789", JEV_API_KEY: "jev-fake-key-0123456789" };
const FIXTURE_ENV = { ANALYSIS_MODE: "real", ANALYSIS_SOURCE: "fixture", ...AI_KEYS };
const noNetwork = () => vi.fn(async () => Promise.reject(new Error("no network expected"))) as unknown as typeof fetch;

describe("source selection", () => {
  it.each([
    [{}, { kind: "youtube" }],
    [{ ANALYSIS_SOURCE: "youtube" }, { kind: "youtube" }],
    [{ ANALYSIS_SOURCE: "fixture" }, { kind: "fixture", dataset: "t1-topics-v1" }],
    [{ ANALYSIS_SOURCE: " Fixture ", FIXTURE_DATASET: "t1-topics-v1" }, { kind: "fixture", dataset: "t1-topics-v1" }],
    [{ ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: "m2" }, { kind: "fixture", dataset: "m2-synthetic" }],
    [{ ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: "m2-synthetic" }, { kind: "fixture", dataset: "m2-synthetic" }],
  ])("%j → %j", (env, source) => {
    expect(selectAnalysisSource(env)).toEqual({ ok: true, source });
  });

  it.each(["t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1", "m2-heldout-v1"])("refuses validation or hold-out dataset %s", (dataset) => {
    const selection = selectAnalysisSource({ ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: dataset });
    expect(selection).toEqual({ ok: false, message: `FIXTURE_DATASET=${dataset} is validation or hold-out evaluation data and is refused, so it is never used to tune the analysis.` });
  });

  it("accepts exactly m2 and t1-topics-v1", () => {
    for (const dataset of ["m2", "m2-synthetic", "t1-topics-v1"]) expect(selectAnalysisSource({ ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: dataset }).ok).toBe(true);
    for (const dataset of ["t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1", "m2-heldout-v1", "t2", "t6-topics-v1"]) {
      expect(selectAnalysisSource({ ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: dataset }).ok).toBe(false);
    }
  });

  it("refuses unknown datasets and sources", () => {
    expect(selectAnalysisSource({ ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: "../t5-topics-v1" }).ok).toBe(false);
    expect(selectAnalysisSource({ ANALYSIS_SOURCE: "csv" }).ok).toBe(false);
  });

  it("no validation or hold-out dataset is even bundled into the fixture source", () => {
    expect(Object.keys(FIXTURE_DATASETS).sort()).toEqual(["m2-synthetic", "t1-topics-v1"]);
    const text = readFileSync(join(ROOT, "src", "adapters", "fixtures", "fixture-dataset-source.ts"), "utf8");
    const imports = [...text.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.filter((i) => i!.includes("fixtures/"))).toEqual(["../../../fixtures/m2/comments.json", "../../../fixtures/t1-topics-v1/comments.json"]);
  });
});

describe("FixtureDatasetSource", () => {
  it("returns only ID and text of the dataset's comments, whatever video ID is asked for", async () => {
    const source = new FixtureDatasetSource("t1-topics-v1");
    expect(source.origin).toBe("synthetic_fixture");
    const comments = await source.listComments("anyVideoId0");
    expect(comments).toHaveLength(t1.comments.length);
    expect(comments[0]).toEqual({ id: t1.comments[0]!.id, text: t1.comments[0]!.text });
    expect(await source.listComments("otherVideo1")).toEqual(comments);
    for (const c of comments) expect(Object.keys(c).sort()).toEqual(["id", "text"]);
  });
});

describe("real mode with fixture input", () => {
  it("needs only the AI keys, and builds no YouTube source", () => {
    const build = createRealAnalysis(FIXTURE_ENV);
    if (!build.ok) throw new Error(build.message);
    expect(build.analysis.input).toEqual({ kind: "fixture", dataset: "t1-topics-v1", comments: t1.comments.length });
    expect(build.analysis.deps.source).toBeInstanceOf(FixtureDatasetSource);
    expect(build.analysis.deps.source.origin).toBe("synthetic_fixture");
  });

  it("uses the same real pipeline as YouTube real mode, with the cost cap", () => {
    const fixture = createRealAnalysis(FIXTURE_ENV);
    const youtube = createRealAnalysis({ ANALYSIS_MODE: "real", YOUTUBE_API_KEY: "yt-fake-key-0123456789", ...AI_KEYS });
    if (!fixture.ok || !youtube.ok) throw new Error("expected builds");
    expect(fixture.analysis.deps.classifier.label).toBe(youtube.analysis.deps.classifier.label);
    expect(fixture.analysis.deps.topics!.discoverer.label).toBe(youtube.analysis.deps.topics!.discoverer.label);
    expect(fixture.analysis.deps.topics!.discoverer.label).toContain("(topic-discovery-v2) → consolidation (topic-consolidation-v3)");
    expect(fixture.analysis.deps.costLimit).toBe(fixture.analysis.budget);
    expect(fixture.analysis.budget.limitUsd).toBe(1);
  });

  it("does not evaluate CG-1: strict policy, no exception needed, and the analysis is not blocked", async () => {
    // NODE_ENV is not development and no exception record applies: a YouTube analysis would be blocked here.
    const fetchImpl = noNetwork();
    const build = createRealAnalysis({ ...FIXTURE_ENV, NODE_ENV: "test" }, { fetch: fetchImpl, settings: { ...realModeSettings(), maxCostUsd: 0.000001 }, cg1Record: undefined });
    if (!build.ok) throw new Error(build.message);
    expect(build.analysis.input.kind).toBe("fixture");
    expect(build.analysis.deps.policy.config).toEqual(STRICT_POLICY_CONFIG);
    const result = await analyzeVideoSync({ url: VALID_URL }, build.analysis.deps);
    // Past the policy gate and the source; stopped by the tiny cost cap before the first AI call.
    expect(result.status).toBe("cost_limit_reached");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(build.analysis.budget.entries).toHaveLength(0);
  });

  it("makes no YouTube request even with a YouTube key present", async () => {
    const fetchImpl = noNetwork();
    const build = createRealAnalysis({ ...FIXTURE_ENV, YOUTUBE_API_KEY: "yt-fake-key-0123456789" }, { fetch: fetchImpl, settings: { ...realModeSettings(), maxCostUsd: 0.000001 } });
    if (!build.ok) throw new Error(build.message);
    await analyzeVideoSync({ url: VALID_URL }, build.analysis.deps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a validation or hold-out dataset as a configuration error before anything is built", () => {
    expect(createRealAnalysis({ ...FIXTURE_ENV, FIXTURE_DATASET: "t5-topics-v1" })).toEqual({
      ok: false,
      message: "FIXTURE_DATASET=t5-topics-v1 is validation or hold-out evaluation data and is refused, so it is never used to tune the analysis.",
    });
  });

  it("names missing AI keys only", () => {
    expect(createRealAnalysis({ ANALYSIS_MODE: "real", ANALYSIS_SOURCE: "fixture" })).toEqual({ ok: false, message: "Real mode needs ANTHROPIC_API_KEY, JEV_API_KEY in the local .env file." });
  });

  it("records the input in telemetry", () => {
    const build = createRealAnalysis(FIXTURE_ENV);
    if (!build.ok) throw new Error(build.message);
    const t = analysisTelemetry("real", { status: "cost_limit_reached", limitUsd: 1, spentUsd: 0, message: "x" }, build.analysis.budget, 5, build.analysis.input);
    expect(t.input).toBe("fixture:t1-topics-v1");
  });
});

describe("analysis setup for display", () => {
  it.each([
    [{}, { mode: "demo" }],
    [{ ANALYSIS_SOURCE: "fixture" }, { mode: "demo" }],
    [FIXTURE_ENV, { mode: "real", input: { kind: "fixture", dataset: "t1-topics-v1", comments: t1.comments.length } }],
    [{ ...FIXTURE_ENV, FIXTURE_DATASET: "t4-topics-v1" }, { mode: "misconfigured", message: "FIXTURE_DATASET=t4-topics-v1 is validation or hold-out evaluation data and is refused, so it is never used to tune the analysis." }],
  ])("%j → %j", (env, setup) => {
    expect(analysisSetup(env)).toEqual(setup);
  });

  it("YouTube real mode shows its CG-1 gate", () => {
    const setup = analysisSetup({ ANALYSIS_MODE: "real", NODE_ENV: "test" });
    expect(setup).toEqual({ mode: "real", input: { kind: "youtube", gate: { state: "blocked", reason: "not_local_development" } } });
  });
});

describe("fixture report rendering", () => {
  it("shows the fixture banner and dataset, and never presents the URL as the comment source", async () => {
    const source = new FixtureDatasetSource("m2-synthetic");
    const { FakeClassifier } = await import("../../src/adapters/fakes/fake-classifier");
    const { createCompliancePolicy } = await import("../../src/core/policy/compliance-policy");
    const result = await analyzeVideoSync({ url: VALID_URL }, { source, classifier: new FakeClassifier(), policy: createCompliancePolicy() });
    if (result.status !== "ok") throw new Error("expected ok");
    const html = renderToStaticMarkup(<Report {...reportProps(result.report)} fixture={{ dataset: "m2-synthetic", comments: source.size }} />);
    expect(html).toContain("REAL AI · FIXTURE DATA · NO YOUTUBE COMMENTS ANALYZED");
    expect(html).toContain("Synthetic fixture dataset <strong>m2-synthetic</strong>");
    // One source banner, not two: dataset, comment count and classifier are stated once.
    expect(html.split("REAL AI · FIXTURE DATA · NO YOUTUBE COMMENTS ANALYZED")).toHaveLength(2);
    expect(html.split(`(${source.size} synthetic comments)`)).toHaveLength(2);
    expect(html).toContain("test data; not a YouTube video");
    expect(html).not.toContain("Video ID:");
    expect(html).not.toContain("No YouTube or AI calls were made");

    const demo = renderToStaticMarkup(<Report {...reportProps(result.report)} />);
    expect(demo).toContain("Demo dataset (synthetic comments; not a YouTube video)");
    expect(demo).not.toContain("Video ID:");
    const real = renderToStaticMarkup(<Report {...reportProps({ ...result.report, isSyntheticData: false, comments: undefined })} />);
    expect(real).toContain("YouTube video ID:");
    expect(demo).not.toContain("FIXTURE DATA");
  });
});
