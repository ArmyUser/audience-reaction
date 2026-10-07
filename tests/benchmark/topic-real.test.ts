import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { createGeminiClient } from "../../src/adapters/ai/google/gemini-topic-transport";
import { goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { buildTopicRealPreflight, loadPrices, loadTopicProviderConfig, realResultFileName, realScenarioIdFor, REAL_SCENARIO_ID, renderTopicRealPreflight, runRealTopicBenchmark, selectDiscoveryProvider } from "../../src/benchmark/topic-real";
import { loadTopicReplayResponses } from "../../src/benchmark/topic-replay";
import { REPLAY_TAXONOMY } from "../topics-benchmark/replay-fixtures";

// Real-provider configuration, the no-network preflight, the live runner driven entirely by offline fakes, and the
// CLI safety gate. Nothing here can reach a provider: keys are dummies, the SDK client and fetch are fakes, and the
// global fetch is trapped.

const ROOT = join(__dirname, "..", "..");
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const config = loadTopicProviderConfig();
const prices = loadPrices();
const FAKE_ANTHROPIC = "fake-anthropic-key-do-not-use-91";
const FAKE_JEV = "fake-jev-key-do-not-use-42";
const FAKE_GEMINI = "fake-gemini-key-do-not-use-73";

/** A fake Jev endpoint answering every comment with its gold disposition (keys of the replay taxonomy). */
function fakeJevFetch(calls: string[]): typeof fetch {
  const byText = new Map(dataset.comments.map((c) => [c.text, c.id]));
  const replayKey = (goldKey: string) => REPLAY_TAXONOMY[goldKey]!.key;
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { state: { comment: string }; questions: Record<string, unknown> };
    calls.push((init.headers as Record<string, string>).authorization ?? "");
    const g = gold.dispositions.get(byText.get(body.state.comment)!)!;
    const answers = "topic" in body.questions
      ? { topic: { type: "choice", choice: g.disposition === "primary_topic" ? `topic:${replayKey(g.topicKey)}` : g.disposition } }
      : { topic_sentiment: { type: "choice", choice: g.disposition === "primary_topic" ? g.topicSentiment : "neutral" } };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

let trapped = 0;
beforeEach(() => {
  trapped = 0;
  vi.stubGlobal("fetch", async () => {
    trapped += 1;
    throw new Error("network access is not allowed in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider configuration", () => {
  it("names the target models, contracts and key variables; holds no secrets", () => {
    expect(config.discovery).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY", contract: "topic-discovery-v2", refusalFallback: "off" });
    expect(config.assignment).toMatchObject({ provider: "typesafe", model: "jev-latest", apiKeyEnv: "JEV_API_KEY", contract: "topic-assignment-v1", questionSet: "jev-topic-a1", maxCommentsPerBatch: 25 });
    expect(readFileSync("config/topic-providers.json", "utf8")).not.toMatch(/sk-|key"\s*:\s*"[^A-Z]/);
    expect(prices["claude-sonnet-5-5"]).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(prices["jev-latest"]).toMatchObject({ inputPerMTok: 0.042, outputPerMTok: 0 });
  });

  it.each([
    ["a non-contract discovery version", (c: Record<string, any>) => (c.discovery.contract = "topic-discovery-v1"), /discovery.contract/],
    ["the classifier question set", (c: Record<string, any>) => (c.assignment.questionSet = "jev-q2.2"), /questionSet must be jev-topic-a1/],
    ["a zero batch size", (c: Record<string, any>) => (c.assignment.maxCommentsPerBatch = 0), /maxCommentsPerBatch/],
    ["a key value instead of a variable name", (c: Record<string, any>) => (c.discovery.apiKeyEnv = "sk-123"), /apiKeyEnv/],
  ])("rejects %s", (_name, change, message) => {
    const c = JSON.parse(readFileSync("config/topic-providers.json", "utf8"));
    change(c);
    expect(() => loadTopicProviderConfig(JSON.stringify(c))).toThrow(message);
  });
});

describe("preflight (no network)", () => {
  const preflight = buildTopicRealPreflight(dataset, config, prices, { ANTHROPIC_API_KEY: FAKE_ANTHROPIC }, 2);
  const text = renderTopicRealPreflight(preflight);

  it("makes no API call and says so", () => {
    expect(preflight.apiCalls).toBe(0);
    expect(trapped).toBe(0);
    expect(text.split("NO API CALLS MADE")).toHaveLength(3);
  });

  it("checks key presence without printing values", () => {
    expect(preflight.environment).toEqual([
      { name: "ANTHROPIC_API_KEY", present: true },
      { name: "JEV_API_KEY", present: false },
    ]);
    expect(text).not.toContain(FAKE_ANTHROPIC);
    expect(text).toContain("JEV_API_KEY MISSING");
  });

  it("renders the exact discovery request and the assignment request shape", () => {
    expect(preflight.renderedDiscovery.contract).toBe("topic-discovery-v2");
    expect(preflight.renderedDiscovery.data).toContain('"max_topics":12');
    expect(text).toContain(preflight.renderedDiscovery.instructions);
    const shape = preflight.renderedAssignmentExample as { topicStep: { model: string; questions: Record<string, unknown> }; sentimentStep: { questions: Record<string, unknown> } };
    expect(shape.topicStep.model).toBe("jev-latest");
    expect(Object.keys(shape.topicStep.questions)).toEqual(["topic"]);
    expect(Object.keys(shape.sentimentStep.questions)).toEqual(["topic_sentiment"]);
  });

  it("estimates sizes, requests, batches and cost from configuration", () => {
    expect(preflight.discovery).toMatchObject({ sampleSize: 188, expectedOutputTokens: 8_000, maxOutputTokens: 16_000 });
    expect(preflight.discovery.estimatedInputTokens).toBe(Math.ceil((preflight.discovery.instructionsChars + preflight.discovery.dataChars + preflight.discovery.outputSchemaSentChars) / 4));
    expect(preflight.discovery.expectedCostUsdPerCall).toBeCloseTo((preflight.discovery.estimatedInputTokens * 2 + 8_000 * 10) / 1e6, 10);
    expect(preflight.assignment).toMatchObject({ comments: 188, batches: 8, maxCommentsPerBatch: 25, topicStepRequests: 188, sentimentStepRequests: 188 });
    expect(preflight.perRun.requests).toBe(377);
    expect(preflight.total).toMatchObject({ requests: Math.ceil(377 * 2 * 1.5), maxRequests: 377 * 2 * 2, limitUsd: 1 });
    expect(preflight.total.maxCostUsd).toBeLessThan(1);
    expect(preflight.total.withinLimit).toBe(true);
  });
});

describe("live runner, driven by offline fakes", () => {
  it("plugs the real adapters into the unchanged benchmark evaluator and records usage without keys", async () => {
    const responses = loadTopicReplayResponses(dataset);
    const anthropicRequests: unknown[] = [];
    const anthropicClient = {
      beta: {
        messages: {
          create: async (params: unknown) => {
            anthropicRequests.push(params);
            return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: responses.get("taxonomy-perfect")!.raw }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 4_400, output_tokens: 2_100 } };
          },
        },
      },
    } as unknown as ReturnType<typeof createAnthropicClient>;
    const jevCalls: string[] = [];
    const jevFetch = fakeJevFetch(jevCalls);

    const result = await runRealTopicBenchmark(dataset, config, prices, { discoveryApiKey: FAKE_ANTHROPIC, jevApiKey: FAKE_JEV }, 2, { anthropicClient, fetch: jevFetch });
    expect(trapped).toBe(0);
    expect(result.report.oracleGate.passed).toBe(true);
    const live = result.report.scenarios.find((s) => s.id === REAL_SCENARIO_ID)!;
    expect(live.runs.map((r) => r.status)).toEqual(["available", "available"]);
    expect(live.runs[0]!.taxonomy).toMatchObject({ topicPrecision: 1, conceptRecall: 1 });
    expect(live.runs[0]!.assignment).toMatchObject({ dispositionAccuracy: 1, topicSentimentAccuracy: 1 });
    expect(anthropicRequests).toHaveLength(2);
    // Refusal fallback is off in the configuration: Sonnet 5.5 itself is measured.
    for (const r of anthropicRequests) {
      expect(r).toMatchObject({ model: "claude-sonnet-5-5" });
      expect(r).not.toHaveProperty("fallbacks");
      expect(r).not.toHaveProperty("betas");
    }
    expect(jevCalls).toHaveLength(2 * (188 + 134));
    expect(result.meta).toMatchObject({ dataset: "t1-topics-v1", repeats: 2, discovery: { modelRequested: "claude-sonnet-5-5", contract: "topic-discovery-v2" }, assignment: { modelRequested: "jev-latest", questionSet: "jev-topic-a1", maxCommentsPerBatch: 25 } });
    expect(result.usage.map((u) => [u.discovery.requests, u.discovery.modelsServed, u.assignment.batches, u.assignment.modelsServed])).toEqual([
      [1, ["claude-sonnet-5-5"], 8, ["jev-1.13.0"]],
      [1, ["claude-sonnet-5-5"], 8, ["jev-1.13.0"]],
    ]);
    expect(result.totals).toMatchObject({ requests: 2 * (1 + 188 + 134), attempts: [1, 1], batches: 16 });
    expect(result.totals.estimatedCostUsd).toBeCloseTo(2 * ((4_400 * 2 + 2_100 * 10) / 1e6 + ((188 + 134) * 500 * 0.042) / 1e6), 10);
    const json = JSON.stringify(result);
    expect(json).not.toContain(FAKE_ANTHROPIC);
    expect(json).not.toContain(FAKE_JEV);
    expect(realResultFileName(result)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-topics-t1-topics-v1-anthropic-claude-sonnet-5-5-typesafe-jev-latest\.json$/);
  });
});

describe("Gemini discovery provider (optional, selected by name)", () => {
  const gemini = selectDiscoveryProvider(config, "gemini");

  it("is configured as an alternative discovery provider; the default stays Anthropic", () => {
    expect(config.discoveryProviders?.gemini).toEqual({ provider: "google", model: "gemini-3.8-flash", alternativeModels: ["gemini-3.7-flash"], apiKeyEnv: "GEMINI_API_KEY", contract: "topic-discovery-v2", thinkingLevel: "low", maxOutputTokens: 16_000, expectedOutputTokens: 4_000, timeoutMs: 180_000, maxTransportRetries: 2 });
    expect(selectDiscoveryProvider(config)).toBe(config);
    expect(selectDiscoveryProvider(config, "anthropic").discovery).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(gemini.discovery).toMatchObject({ provider: "google", model: "gemini-3.8-flash" });
    expect(gemini.assignment).toEqual(config.assignment);
    expect(() => selectDiscoveryProvider(config, "openai")).toThrow(/Unknown discovery provider "openai". Use anthropic, gemini/);
    expect(prices["gemini-3.8-flash"]).toMatchObject({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    expect(prices["gemini-3.7-flash"]).toMatchObject({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
  });

  it("--model selects gemini-3.7-flash with the gemini entry's settings; 3.8 stays the entry's default", () => {
    const g37 = selectDiscoveryProvider(config, "gemini", "gemini-3.7-flash");
    expect(g37.discovery).toEqual({ ...config.discoveryProviders!.gemini, model: "gemini-3.7-flash" });
    expect(g37.discovery).toMatchObject({ provider: "google", thinkingLevel: "low", apiKeyEnv: "GEMINI_API_KEY", contract: "topic-discovery-v2" });
    expect(g37.assignment).toEqual(config.assignment);
    expect(selectDiscoveryProvider(config, "gemini", "gemini-3.8-flash").discovery).toEqual(gemini.discovery);
    expect(gemini.discovery.model).toBe("gemini-3.8-flash");
    expect(config.discovery.model).toBe("claude-sonnet-5-5");
    expect(selectDiscoveryProvider(config, "anthropic", "claude-sonnet-5-5")).toBe(config);
    expect(() => selectDiscoveryProvider(config, "gemini", "gemini-2.5-pro")).toThrow(/Model "gemini-2.5-pro" is not configured for discovery provider "gemini". Use gemini-3.8-flash, gemini-3.7-flash/);
    expect(() => selectDiscoveryProvider(config, "anthropic", "gemini-3.7-flash")).toThrow(/not configured for discovery provider "anthropic". Use claude-sonnet-5-5/);
  });

  it.each([
    ["the unsupported minimal thinking level", (c: Record<string, any>) => (c.discoveryProviders.gemini.thinkingLevel = "minimal"), /thinkingLevel must be one of low, medium, high/],
    ["an unknown provider kind", (c: Record<string, any>) => (c.discoveryProviders.gemini.provider = "openai"), /discoveryProviders.gemini.provider must be anthropic or google/],
    ["a key value instead of a variable name", (c: Record<string, any>) => (c.discoveryProviders.gemini.apiKeyEnv = "AIza-123"), /apiKeyEnv/],
    ["a non-contract discovery version", (c: Record<string, any>) => (c.discoveryProviders.gemini.contract = "topic-discovery-v1"), /discoveryProviders.gemini.contract/],
    ["the reserved default name", (c: Record<string, any>) => (c.discoveryProviders.anthropic = c.discoveryProviders.gemini), /"anthropic" is reserved/],
    ["an alternative model equal to the entry's model", (c: Record<string, any>) => (c.discoveryProviders.gemini.alternativeModels = ["gemini-3.8-flash"]), /alternativeModels must list distinct model ids/],
    ["duplicate alternative models", (c: Record<string, any>) => (c.discoveryProviders.gemini.alternativeModels = ["gemini-3.7-flash", "gemini-3.7-flash"]), /alternativeModels must list distinct model ids/],
    ["a non-list of alternative models", (c: Record<string, any>) => (c.discoveryProviders.gemini.alternativeModels = "gemini-3.7-flash"), /alternativeModels must list distinct model ids/],
  ])("rejects %s", (_name, change, message) => {
    const c = JSON.parse(readFileSync("config/topic-providers.json", "utf8"));
    change(c);
    expect(() => loadTopicProviderConfig(JSON.stringify(c))).toThrow(message);
  });

  it("preflight renders the same contract request and prices it at the paid-tier rate, with no network", () => {
    const preflight = buildTopicRealPreflight(dataset, gemini, prices, { GEMINI_API_KEY: FAKE_GEMINI }, 1);
    const anthropicPreflight = buildTopicRealPreflight(dataset, config, prices, {}, 1);
    const text = renderTopicRealPreflight(preflight);
    expect(trapped).toBe(0);
    expect(text.split("NO API CALLS MADE")).toHaveLength(3);
    expect(preflight.environment).toEqual([
      { name: "GEMINI_API_KEY", present: true },
      { name: "JEV_API_KEY", present: false },
    ]);
    expect(text).not.toContain(FAKE_GEMINI);
    expect(preflight.models).toMatchObject({ discoveryProvider: "google", discovery: "gemini-3.8-flash", pricesConfigured: { discovery: true, assignment: true } });
    expect(preflight.renderedDiscovery).toEqual(anthropicPreflight.renderedDiscovery);
    expect(preflight.discovery.expectedCostUsdPerCall).toBeCloseTo((preflight.discovery.estimatedInputTokens * 0.75 + 4_000 * 3.75) / 1e6, 10);
    expect(preflight.discovery.maxCostUsdPerCall).toBeCloseTo((preflight.discovery.estimatedInputTokens * 0.75 + 16_000 * 3.75) / 1e6, 10);
    expect(preflight.assignment).toEqual(anthropicPreflight.assignment);
    expect(text).toContain("Discovery: gemini-3.8-flash (topic-discovery-v2); price configured.");
    expect(text).toContain("a free-tier key is not billed");
  });

  it("the live runner plugs Gemini into the unchanged evaluator, with Jev assignment unchanged", async () => {
    const responses = loadTopicReplayResponses(dataset);
    const geminiCalls: { url: string; key: string | null }[] = [];
    const geminiFetch = (async (url: string, init: RequestInit) => {
      geminiCalls.push({ url: String(url), key: new Headers(init.headers).get("x-goog-api-key") });
      const body = { candidates: [{ content: { role: "model", parts: [{ text: responses.get("taxonomy-perfect")!.raw }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4_400, candidatesTokenCount: 800, thoughtsTokenCount: 400 }, modelVersion: "gemini-3.8-flash" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const geminiClient = createGeminiClient(FAKE_GEMINI, { maxRetries: 0, fetch: geminiFetch });
    const jevCalls: string[] = [];

    const result = await runRealTopicBenchmark(dataset, gemini, prices, { discoveryApiKey: FAKE_GEMINI, jevApiKey: FAKE_JEV }, 1, { geminiClient, fetch: fakeJevFetch(jevCalls) });
    expect(trapped).toBe(0);
    expect(result.report.oracleGate.passed).toBe(true);
    const live = result.report.scenarios.find((s) => s.id === realScenarioIdFor("google"))!;
    expect(live.id).toBe("real-google-discovery-jev-assignment");
    expect(live.runs.map((r) => r.status)).toEqual(["available"]);
    expect(live.runs[0]!.taxonomy).toMatchObject({ topicPrecision: 1, conceptRecall: 1 });
    expect(live.runs[0]!.assignment).toMatchObject({ dispositionAccuracy: 1, topicSentimentAccuracy: 1 });
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]!.url).toMatch(/gemini-3\.8-flash:generateContent$/);
    expect(jevCalls).toHaveLength(188 + 134);
    expect(result.meta.discovery).toEqual({ provider: "google", modelRequested: "gemini-3.8-flash", contract: "topic-discovery-v2", thinkingLevel: "low" });
    expect(result.meta.assignment).toMatchObject({ provider: "typesafe", modelRequested: "jev-latest", questionSet: "jev-topic-a1" });
    expect(result.usage[0]!.discovery).toMatchObject({ requests: 1, modelsServed: ["gemini-3.8-flash"] });
    expect(result.totals.estimatedCostUsd).toBeCloseTo((4_400 * 0.75 + 1_200 * 3.75) / 1e6 + ((188 + 134) * 500 * 0.042) / 1e6, 10);
    const json = JSON.stringify(result);
    expect(json).not.toContain(FAKE_GEMINI);
    expect(json).not.toContain(FAKE_JEV);
    expect(realResultFileName(result)).toMatch(/-topics-t1-topics-v1-google-gemini-3-8-flash-typesafe-jev-latest\.json$/);
  });

  it("gemini-3.7-flash runs through the same transport, request and evaluator; preflight prices it", async () => {
    const g37 = selectDiscoveryProvider(config, "gemini", "gemini-3.7-flash");
    const preflight = buildTopicRealPreflight(dataset, g37, prices, {}, 1);
    expect(preflight.models).toMatchObject({ discoveryProvider: "google", discovery: "gemini-3.7-flash", pricesConfigured: { discovery: true, assignment: true } });
    expect(preflight.renderedDiscovery).toEqual(buildTopicRealPreflight(dataset, gemini, prices, {}, 1).renderedDiscovery);
    expect(trapped).toBe(0);

    const responses = loadTopicReplayResponses(dataset);
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const geminiFetch = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init.body)));
      const body = { candidates: [{ content: { role: "model", parts: [{ text: responses.get("taxonomy-perfect")!.raw }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4_400, candidatesTokenCount: 800, thoughtsTokenCount: 400 }, modelVersion: "gemini-3.7-flash" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await runRealTopicBenchmark(dataset, g37, prices, { discoveryApiKey: FAKE_GEMINI, jevApiKey: FAKE_JEV }, 1, { geminiClient: createGeminiClient(FAKE_GEMINI, { maxRetries: 0, fetch: geminiFetch }), fetch: fakeJevFetch([]) });
    expect(trapped).toBe(0);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/models\/gemini-3\.7-flash:generateContent$/);
    expect(bodies[0]).toMatchObject({ generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "LOW" }, maxOutputTokens: 16_000 } });
    expect(result.report.scenarios.find((s) => s.id === realScenarioIdFor("google"))!.runs[0]!.status).toBe("available");
    expect(result.meta.discovery).toEqual({ provider: "google", modelRequested: "gemini-3.7-flash", contract: "topic-discovery-v2", thinkingLevel: "low" });
    expect(result.usage[0]!.discovery).toMatchObject({ requests: 1, modelsServed: ["gemini-3.7-flash"] });
    expect(result.totals.estimatedCostUsd).toBeCloseTo((4_400 * 0.75 + 1_200 * 3.75) / 1e6 + ((188 + 134) * 500 * 0.042) / 1e6, 10);
    expect(realResultFileName(result)).toMatch(/-topics-t1-topics-v1-google-gemini-3-7-flash-typesafe-jev-latest\.json$/);
    expect(JSON.stringify(result)).not.toContain(FAKE_GEMINI);
  });

  it("a missing key fails locally for gemini-3.7-flash too", async () => {
    const jevCalls: string[] = [];
    await expect(runRealTopicBenchmark(dataset, selectDiscoveryProvider(config, "gemini", "gemini-3.7-flash"), prices, { discoveryApiKey: "", jevApiKey: FAKE_JEV }, 1, { fetch: fakeJevFetch(jevCalls) })).rejects.toThrow(/Gemini API key is missing; no request was made/);
    expect(trapped).toBe(0);
    expect(jevCalls).toHaveLength(0);
  });

  it("a missing Gemini key fails locally before any request", async () => {
    const jevCalls: string[] = [];
    await expect(runRealTopicBenchmark(dataset, gemini, prices, { discoveryApiKey: "", jevApiKey: FAKE_JEV }, 1, { fetch: fakeJevFetch(jevCalls) })).rejects.toThrow(/Gemini API key is missing; no request was made/);
    expect(trapped).toBe(0);
    expect(jevCalls).toHaveLength(0);
  });
});

describe("CLI safety gate (never with --live here)", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const RESULTS = join(ROOT, "benchmark-results");
  const cli = (args: string[]) => {
    const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
    // No keys in the environment and no --env-file: a live call is impossible even if the gate were broken.
    const out = spawnSync(TSX, ["src/benchmark/topics-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []).toEqual(before);
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("real-preflight renders and estimates, and states that no API call was made", () => {
    const { status, text } = cli(["--suite", "real-preflight", "--dataset", "t1-topics-v1", "--repeats", "2"]);
    expect(status).toBe(0);
    expect(text).toContain("NO API CALLS MADE");
    expect(text).toContain("ANTHROPIC_API_KEY MISSING, JEV_API_KEY MISSING");
    expect(text).toMatch(/2 repeats with retry headroom: ≈ \d+ requests/);
    expect(text).not.toContain("API CALLS WILL BE MADE");
  }, 60_000);

  it("the real suite without --live only prints the preflight and refuses to start", () => {
    const { status, text } = cli(["--suite", "real", "--dataset", "t1-topics-v1", "--repeats", "2"]);
    expect(status).toBe(2);
    expect(text).toContain("Live run NOT started: add --live");
    expect(text).not.toContain("API CALLS WILL BE MADE");
  }, 60_000);

  it("real-preflight selects Gemini by provider name and checks the model, with no API call", () => {
    const { status, text } = cli(["--suite", "real-preflight", "--dataset", "t1-topics-v1", "--provider", "gemini", "--model", "gemini-3.8-flash", "--repeats", "1"]);
    expect(status).toBe(0);
    expect(text).toContain("NO API CALLS MADE");
    expect(text).toContain("GEMINI_API_KEY MISSING, JEV_API_KEY MISSING");
    expect(text).toContain("Discovery: gemini-3.8-flash (topic-discovery-v2)");
    expect(text).not.toContain("API CALLS WILL BE MADE");
  }, 60_000);

  it("real-preflight selects gemini-3.7-flash with --model, with no API call", () => {
    const { status, text } = cli(["--suite", "real-preflight", "--dataset", "t1-topics-v1", "--provider", "gemini", "--model", "gemini-3.7-flash", "--repeats", "1"]);
    expect(status).toBe(0);
    expect(text).toContain("NO API CALLS MADE");
    expect(text).toContain("GEMINI_API_KEY MISSING, JEV_API_KEY MISSING");
    expect(text).toContain("Discovery: gemini-3.7-flash (topic-discovery-v2); price configured.");
    expect(text).not.toContain("API CALLS WILL BE MADE");
  }, 60_000);

  it("the real suite with gemini-3.7-flash but without --live refuses to start and shows the full command", () => {
    const { status, text } = cli(["--suite", "real", "--dataset", "t1-topics-v1", "--provider", "gemini", "--model", "gemini-3.7-flash", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("--suite real --dataset t1-topics-v1 --provider gemini --model gemini-3.7-flash --live --repeats 1");
    expect(text).not.toContain("API CALLS WILL BE MADE");
  }, 60_000);

  it("the real suite with Gemini but without --live refuses to start", () => {
    const { status, text } = cli(["--suite", "real", "--dataset", "t1-topics-v1", "--provider", "gemini", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("Live run NOT started: add --live");
    expect(text).toContain("--provider gemini --live --repeats 1");
    expect(text).not.toContain("API CALLS WILL BE MADE");
  }, 60_000);

  it.each([
    [["--suite", "real-preflight", "--provider", "openai"], 'Unknown discovery provider "openai"'],
    [["--suite", "real-preflight", "--provider", "gemini", "--model", "gemini-2.5-pro"], 'Model "gemini-2.5-pro" is not configured for discovery provider "gemini". Use gemini-3.8-flash, gemini-3.7-flash'],
    [["--suite", "core", "--provider", "gemini"], "--provider and --model are only valid with --suite real-preflight, real, discovery-only, smoke, discovery-consolidated or real-consolidated"],
  ])("rejects %j", (args, message) => {
    expect(cli(args)).toMatchObject({ status: 1, text: expect.stringContaining(message) });
  }, 60_000);

  it("rejects --check-models outside the preflight suite", () => {
    expect(cli(["--suite", "replay", "--check-models"])).toMatchObject({ status: 1, text: expect.stringContaining("--check-models is only valid with --suite real-preflight") });
  }, 60_000);
});
