import { describe, expect, it, vi } from "vitest";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { SyntheticCommentSource } from "../../src/adapters/fixtures/synthetic-comment-source";
import { YouTubeCommentSource } from "../../src/adapters/youtube/youtube-comment-source";
import { analyzeVideoSync } from "../../src/application/analyze-video-sync";
import { DEFAULT_ANALYSIS_PARAMETERS } from "../../src/core/aggregation/aggregate";
import { createCompliancePolicy, STRICT_POLICY_CONFIG } from "../../src/core/policy/compliance-policy";
import { TOPIC_CONSOLIDATION_CONTRACT } from "../../src/core/topics/consolidation-contract";
import { TOPIC_DISCOVERY_CONTRACT } from "../../src/core/topics/provider-contracts";
import { analysisTelemetry, createRealAnalysis, demoDeps, realModeSettings, selectAnalysisMode } from "../../src/local/real-mode";
import topicProviders from "../../config/topic-providers.json";
import { VALID_URL, VIDEO_ID } from "../helpers";

// Offline only. Keys are fake; every network request goes to a fake fetch that fails the test if anything other than
// the expected YouTube request is attempted.

const ENV = {
  ANALYSIS_MODE: "real",
  YOUTUBE_API_KEY: "yt-fake-key-0123456789abcdef",
  ANTHROPIC_API_KEY: "sk-ant-fake-0123456789abcdef",
  JEV_API_KEY: "jev-fake-key-0123456789abcdef",
};
const SECRETS = [ENV.YOUTUBE_API_KEY, ENV.ANTHROPIC_API_KEY, ENV.JEV_API_KEY];

function youtubeOnlyFetch(commentCount: number) {
  const requested: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.hostname);
    if (url.hostname !== "www.googleapis.com") throw new Error(`unexpected request to ${url.hostname}`);
    const items = Array.from({ length: commentCount }, (_, i) => ({
      id: `t${i}`,
      snippet: { topLevelComment: { id: `yt-${i}`, snippet: { textDisplay: `secret comment text number ${i}, great video` } } },
    }));
    return new Response(JSON.stringify({ items }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requested };
}

describe("analysis mode selection", () => {
  it.each([
    [{}, "demo"],
    [{ ANALYSIS_MODE: "" }, "demo"],
    [{ ANALYSIS_MODE: "demo" }, "demo"],
    [{ ANALYSIS_MODE: " Real " }, "real"],
    [{ ANALYSIS_MODE: "real" }, "real"],
  ])("%j → %s", (env, mode) => {
    expect(selectAnalysisMode(env)).toEqual({ ok: true, mode });
  });

  it.each(["prod", "on", "1", "real-ish"])("rejects ANALYSIS_MODE=%s instead of falling back", (value) => {
    expect(selectAnalysisMode({ ANALYSIS_MODE: value })).toEqual({ ok: false, message: 'ANALYSIS_MODE must be "demo" or "real".' });
  });
});

describe("demo mode is unchanged", () => {
  it("uses synthetic comments, the fake classifier, the strict policy and no topics or cost cap", () => {
    const deps = demoDeps();
    expect(deps.source).toBeInstanceOf(SyntheticCommentSource);
    expect(deps.classifier).toBeInstanceOf(FakeClassifier);
    expect(deps.policy.config).toEqual(STRICT_POLICY_CONFIG);
    expect(deps.mixedSentimentEnabled).toBe(false);
    expect(deps.params).toBe(DEFAULT_ANALYSIS_PARAMETERS);
    expect(deps.topics).toBeUndefined();
    expect(deps.costLimit).toBeUndefined();
  });

  it("produces the same report as the M2 wiring", async () => {
    const m2 = { source: new SyntheticCommentSource(), classifier: new FakeClassifier(), policy: createCompliancePolicy(STRICT_POLICY_CONFIG), mixedSentimentEnabled: false, params: DEFAULT_ANALYSIS_PARAMETERS };
    expect(await analyzeVideoSync({ url: VALID_URL }, demoDeps())).toEqual(await analyzeVideoSync({ url: VALID_URL }, m2));
  });
});

describe("real mode wiring", () => {
  it("names missing keys by variable only", () => {
    const build = createRealAnalysis({ ANALYSIS_MODE: "real", YOUTUBE_API_KEY: ENV.YOUTUBE_API_KEY, ANTHROPIC_API_KEY: " " });
    expect(build).toEqual({ ok: false, message: "Real mode needs ANTHROPIC_API_KEY, JEV_API_KEY in the local .env file." });
    expect(JSON.stringify(build)).not.toContain(ENV.YOUTUBE_API_KEY);
  });

  it("selects the YouTube source, real adapters, topics and a fresh cost cap per analysis", () => {
    const first = createRealAnalysis(ENV);
    const second = createRealAnalysis(ENV);
    if (!first.ok || !second.ok) throw new Error("expected a build");
    const deps = first.analysis.deps;
    expect(deps.source).toBeInstanceOf(YouTubeCommentSource);
    expect(deps.source.origin).toBe("youtube");
    expect(deps.classifier.label).toContain("jev-q2.2");
    expect(deps.topics?.discoverer).toBeDefined();
    expect(deps.costLimit).toBe(first.analysis.budget);
    expect(first.analysis.budget.limitUsd).toBe(1);
    expect(second.analysis.budget).not.toBe(first.analysis.budget);
  });

  it("uses the validated topic pipeline: discovery v2 → consolidation v3 → Jev assignment, with the benchmark seed", () => {
    const settings = realModeSettings();
    expect(settings.discoveryContract).toBe(TOPIC_DISCOVERY_CONTRACT);
    expect(TOPIC_DISCOVERY_CONTRACT).toBe("topic-discovery-v2");
    expect(settings.consolidationContract).toBe(TOPIC_CONSOLIDATION_CONTRACT);
    expect(TOPIC_CONSOLIDATION_CONTRACT).toBe("topic-consolidation-v3");
    expect(settings.discoverySampleSeed).toBe("t1-topics-v1/ds1");
    expect(topicProviders.discovery.contract).toBe("topic-discovery-v2");
    const build = createRealAnalysis(ENV);
    if (!build.ok) throw new Error("expected a build");
    expect(build.analysis.deps.topics!.discoverer.label).toBe(
      "Two-phase topics (Anthropic claude-sonnet-5-5 (topic-discovery-v2) → consolidation (topic-consolidation-v3) + TypeSafe jev-latest (jev-topic-a1), batches of ≤ 25)",
    );
  });

  it("caps comments at 500, relevance order", () => {
    const build = createRealAnalysis(ENV);
    if (!build.ok) throw new Error("expected a build");
    const source = build.analysis.deps.source as YouTubeCommentSource;
    expect(source.maxComments).toBe(500);
    expect(new URL(source.requestUrl(VIDEO_ID)).searchParams.get("order")).toBe("relevance");
  });
});

describe("real mode keeps the compliance gate", () => {
  it("uses the same strict policy as demo mode", () => {
    const build = createRealAnalysis(ENV);
    if (!build.ok) throw new Error("expected a build");
    expect(build.analysis.deps.policy.config).toEqual(STRICT_POLICY_CONFIG);
    expect(build.analysis.deps.policy.derivedAnalyticsAllowed("youtube")).toBe(false);
  });

  it("is blocked by CG-1 before any YouTube or AI request", async () => {
    const { fetchImpl } = youtubeOnlyFetch(10);
    const build = createRealAnalysis(ENV, { fetch: fetchImpl });
    if (!build.ok) throw new Error("expected a build");
    const result = await analyzeVideoSync({ url: VALID_URL }, build.analysis.deps);
    expect(result.status).toBe("blocked_by_policy");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(build.analysis.budget.entries).toHaveLength(0);
  });
});

describe("real mode cost cap (test-only gate override, fake network)", () => {
  it("stops before the first AI call when the cap cannot cover it, with a structured error", async () => {
    const { fetchImpl, requested } = youtubeOnlyFetch(120);
    const settings = { ...realModeSettings(), maxCostUsd: 0.001 };
    const build = createRealAnalysis(ENV, { fetch: fetchImpl, settings });
    if (!build.ok) throw new Error("expected a build");
    // The gate is satisfied here only to reach the cost cap in a test; the app never does this.
    const deps = { ...build.analysis.deps, policy: createCompliancePolicy({ ...STRICT_POLICY_CONFIG, youtubeDerivedAnalytics: "allowed" }) };
    const result = await analyzeVideoSync({ url: VALID_URL }, deps);
    expect(result).toMatchObject({ status: "cost_limit_reached", limitUsd: 0.001, spentUsd: 0 });
    expect(requested).toEqual(["www.googleapis.com"]);
    expect(build.analysis.budget.entries).toHaveLength(0);
  });
});

describe("analysis telemetry", () => {
  it("contains counts and costs only: no keys, URLs or comment text", async () => {
    const { fetchImpl } = youtubeOnlyFetch(120);
    const build = createRealAnalysis(ENV, { fetch: fetchImpl, settings: { ...realModeSettings(), maxCostUsd: 0.001 } });
    if (!build.ok) throw new Error("expected a build");
    const deps = { ...build.analysis.deps, policy: createCompliancePolicy({ ...STRICT_POLICY_CONFIG, youtubeDerivedAnalytics: "allowed" }) };
    const result = await analyzeVideoSync({ url: VALID_URL }, deps);
    const line = JSON.stringify(analysisTelemetry("real", result, build.analysis.budget, 1234.5));
    expect(JSON.parse(line)).toEqual({ mode: "real", status: "cost_limit_reached", aiRequests: 0, aiFailedRequests: 0, aiRequestsByProvider: {}, estimatedCostUsd: 0, costLimitUsd: 0.001, durationMs: 1235 });
    for (const secret of SECRETS) expect(line).not.toContain(secret);
    expect(line).not.toMatch(/secret comment text|googleapis|key=/);
  });

  it("reports the source failure reason, not upstream text", () => {
    const line = analysisTelemetry("real", { status: "source_unavailable", reason: "quota_exceeded", message: "The YouTube API quota is used up. Try again later." }, undefined, 10);
    expect(line).toEqual({ mode: "real", status: "source_unavailable", sourceFailure: "quota_exceeded", aiRequests: 0, aiFailedRequests: 0, aiRequestsByProvider: {}, estimatedCostUsd: 0, durationMs: 10 });
  });
});
