import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { createGeminiClient } from "../../src/adapters/ai/google/gemini-topic-transport";
import { analyzeTopics } from "../../src/application/analyze-topics";
import { TwoPhaseTopicDiscoverer } from "../../src/application/two-phase-topic-discoverer";
import { TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED } from "../../src/benchmark/topic-benchmark";
import { classifiedCommentsOf, goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import {
  buildDiscoveryBenchmarkPlan,
  DISCOVERY_ONLY_NOTICE,
  discoveryOracleGate,
  discoveryRequestOf,
  discoveryResultFileName,
  evaluateDiscoveredTaxonomy,
  renderDiscoveryBenchmarkMarkdown,
  runDiscoveryBenchmark,
  SMOKE_NOTICE,
  smokeCommentIds,
} from "../../src/benchmark/topic-discovery-only";
import { loadPrices, loadTopicProviderConfig, selectDiscoveryProvider } from "../../src/benchmark/topic-real";
import { loadTopicReplayResponses } from "../../src/benchmark/topic-replay";
import type { TopicTaxonomyRequest } from "../../src/core/ports";
import { buildTopicDiscoveryRequest } from "../../src/core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { toValidationFeedback } from "../../src/core/topics/topic-result";

// Discovery-only and smoke suites, offline: the real SDK clients run against fake endpoints, keys are dummies and the
// global fetch is trapped, so no request can leave the process and Jev can never be reached.

const ROOT = join(__dirname, "..", "..");
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const config = loadTopicProviderConfig();
const prices = loadPrices();
const gemini37 = selectDiscoveryProvider(config, "gemini", "gemini-3.7-flash");
const FAKE_GEMINI = "fake-gemini-key-do-not-use-73";
const FAKE_ANTHROPIC = "fake-anthropic-key-do-not-use-91";
const responses = loadTopicReplayResponses(dataset);
const raw = (id: string) => responses.get(id)!.raw;

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

type Reply = { text: string } | { status: number };

/** Fake Gemini endpoint behind the real SDK client; records each request body. */
function fakeGemini(replies: Reply[]) {
  const bodies: Record<string, any>[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init.body)));
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
    const json = { "content-type": "application/json" };
    if ("status" in reply) return new Response(JSON.stringify({ error: { code: reply.status, message: "provider text", status: "ERROR" } }), { status: reply.status, headers: json });
    const body = { candidates: [{ content: { role: "model", parts: [{ text: reply.text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4_400, candidatesTokenCount: 800, thoughtsTokenCount: 400 }, modelVersion: "gemini-3.7-flash" };
    return new Response(JSON.stringify(body), { status: 200, headers: json });
  }) as unknown as typeof fetch;
  return { bodies, urls, geminiClient: createGeminiClient(FAKE_GEMINI, { maxRetries: 0, fetch: fetchImpl }) };
}

const userData = (body: Record<string, any>) => body.contents[0].parts[0].text as string;

describe("discovery-only: the production discovery step without assignment", () => {
  it("sends exactly the request the production discoverer sends (same base, seeded sample and context)", async () => {
    let captured: TopicTaxonomyRequest | undefined;
    const generator = {
      label: "capture",
      proposeTaxonomy: async (request: TopicTaxonomyRequest) => {
        captured ??= structuredClone(request);
        throw new Error("stop after capture");
      },
    };
    const assigner = { label: "unused", assignTopics: async () => [] };
    await analyzeTopics({ classified: classifiedCommentsOf(dataset), schema: dataset.schema, focus: dataset.focus }, { discoverer: new TwoPhaseTopicDiscoverer({ generator, assigner, sample: { seed: TOPIC_BENCHMARK_SEED } }), params: TOPIC_BENCHMARK_PARAMETERS });
    const { request, baseIds, sampleIds } = discoveryRequestOf(dataset);
    expect(request).toEqual(captured);
    expect(baseIds).toEqual(gold.baseIds);
    expect(sampleIds).toHaveLength(188);
  });

  it("its evaluator passes its own oracle gate on the gold taxonomy", async () => {
    expect(await discoveryOracleGate(dataset)).toEqual({ passed: true, failures: [] });
  });

  it("a successful Gemini run is validated, scored against gold and never reaches Jev", async () => {
    const fake = fakeGemini([{ text: raw("taxonomy-perfect") }]);
    const result = await runDiscoveryBenchmark("discovery-only", dataset, gemini37, prices, FAKE_GEMINI, { repeats: 1, clients: { geminiClient: fake.geminiClient } });
    expect(trapped).toBe(0);
    expect(fake.urls).toHaveLength(1);
    expect(fake.urls[0]).toMatch(/\/models\/gemini-3\.7-flash:generateContent$/);
    expect(userData(fake.bodies[0]!)).toBe(buildTopicDiscoveryRequest(discoveryRequestOf(dataset).request).data);
    expect(result.oracleGate).toEqual({ passed: true, failures: [] });
    expect(result.meta).toMatchObject({ kind: "discovery-only", notice: DISCOVERY_ONLY_NOTICE, assignment: "not run", topicBase: 188, sampleSize: 188, repeats: 1, discovery: { provider: "google", modelRequested: "gemini-3.7-flash", contract: "topic-discovery-v2", settings: { thinkingLevel: "low" } } });
    const [run] = result.runs;
    expect(run).toMatchObject({ status: "valid", topics: 8, attempts: [{ attempt: 1, outcome: "valid", issueCodes: [], feedbackSent: false, topics: 8 }] });
    expect(run!.taxonomy).toMatchObject({ predictedTopics: 8, topicsWithExamples: 8, matchedTopics: 8, topicPrecision: 1, conceptRecall: 1, mergeErrors: 0, splitErrors: 0, definitionValidity: 1 });
    expect(run!.usage).toMatchObject({ requests: 1, modelsServed: ["gemini-3.7-flash"], inputTokens: 4_400, outputTokens: 1_200 });
    expect(result.totals.estimatedCostUsd).toBeCloseTo((4_400 * 0.75 + 1_200 * 3.75) / 1e6, 10);
    const text = renderDiscoveryBenchmarkMarkdown(result);
    expect(text).toContain(DISCOVERY_ONLY_NOTICE);
    expect(text).toContain("Assignment: not run.");
    expect(text).toContain("Oracle gate (discovery-only evaluator on the gold taxonomy, offline): PASSED");
    expect(text).not.toMatch(/disposition|topicSentiment|named share/i);
    expect(JSON.stringify(result)).not.toContain(FAKE_GEMINI);
    expect(JSON.stringify(result)).not.toContain(dataset.comments[0]!.text);
    expect(discoveryResultFileName(result)).toMatch(/-topics-t1-topics-v1-discovery-only-google-gemini-3-7-flash\.json$/);
  });

  it("works with the default Anthropic provider through the same factory", async () => {
    const requests: Record<string, unknown>[] = [];
    const anthropicClient = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            requests.push(params);
            return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: raw("taxonomy-perfect") }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 4_400, output_tokens: 2_000 } };
          },
        },
      },
    } as unknown as ReturnType<typeof createAnthropicClient>;
    const result = await runDiscoveryBenchmark("discovery-only", dataset, config, prices, FAKE_ANTHROPIC, { repeats: 2, clients: { anthropicClient } });
    expect(trapped).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(requests[0]).not.toHaveProperty("fallbacks");
    expect(result.meta.discovery).toEqual({ provider: "anthropic", modelRequested: "claude-sonnet-5-5", contract: "topic-discovery-v2", settings: { effort: "high", refusalFallback: "off" } });
    expect(result.runs.map((r) => [r.repeat, r.status, r.taxonomy?.conceptRecall])).toEqual([
      [1, "valid", 1],
      [2, "valid", 1],
    ]);
  });
});

describe("discovery-only: retries, validation and provider failures", () => {
  it("an invalid first answer is retried once with the production feedback, then accepted", async () => {
    const fake = fakeGemini([{ text: '{"topics":[{"key":"a"' }, { text: raw("taxonomy-perfect") }]);
    const result = await runDiscoveryBenchmark("discovery-only", dataset, gemini37, prices, FAKE_GEMINI, { clients: { geminiClient: fake.geminiClient } });
    const [run] = result.runs;
    expect(run!.status).toBe("valid");
    expect(run!.attempts.map((a) => [a.attempt, a.outcome, a.issueCodes, a.feedbackSent])).toEqual([
      [1, "invalid_taxonomy", ["invalid_output"], false],
      [2, "valid", [], true],
    ]);
    const { request, baseIds } = discoveryRequestOf(dataset);
    const expected = buildTopicDiscoveryRequest({ ...request, feedback: toValidationFeedback(1, [{ code: "invalid_output" }], baseIds) });
    expect(userData(fake.bodies[1]!)).toBe(expected.data);
    expect(fake.bodies[1]!.systemInstruction.parts[0].text).toBe(expected.instructions);
  });

  it("a taxonomy failing validation twice is unavailable, with the validator's issue codes, and is not scored", async () => {
    const fake = fakeGemini([{ text: raw("taxonomy-duplicate-name") }, { text: raw("taxonomy-perfect").replace('"t1-009"', '"t9-999"') }]);
    const result = await runDiscoveryBenchmark("discovery-only", dataset, gemini37, prices, FAKE_GEMINI, { clients: { geminiClient: fake.geminiClient } });
    const [run] = result.runs;
    expect(run).toMatchObject({ status: "unavailable", topics: null, taxonomy: null, topicList: [] });
    expect(run!.attempts.map((a) => [a.outcome, a.issueCodes])).toEqual([
      ["invalid_taxonomy", ["duplicate_topic_name"]],
      ["invalid_taxonomy", ["unknown_example_comment"]],
    ]);
    expect(fake.urls).toHaveLength(2);
  });

  it("provider failures are retried once, reported by kind without provider text, and stop on configuration errors", async () => {
    const outage = fakeGemini([{ status: 500 }]);
    const failed = await runDiscoveryBenchmark("discovery-only", dataset, gemini37, prices, FAKE_GEMINI, { repeats: 2, clients: { geminiClient: outage.geminiClient } });
    expect(failed.runs).toHaveLength(2);
    expect(failed.runs[0]!.attempts.map((a) => [a.outcome, a.providerFailure, a.issueCodes, a.feedbackSent])).toEqual([
      ["provider_error", "unavailable", ["provider_error"], false],
      ["provider_error", "unavailable", ["provider_error"], true],
    ]);
    expect(JSON.stringify(failed)).not.toContain("provider text");
    expect(renderDiscoveryBenchmarkMarkdown(failed)).toContain("1: provider_error (unavailable) [provider_error]");

    const misconfigured = fakeGemini([{ status: 400 }]);
    const stopped = await runDiscoveryBenchmark("discovery-only", dataset, gemini37, prices, FAKE_GEMINI, { repeats: 3, clients: { geminiClient: misconfigured.geminiClient } });
    expect(stopped.runs).toHaveLength(1);
    expect(stopped.runs[0]!.attempts.map((a) => a.providerFailure)).toEqual(["configuration", "configuration"]);
    expect(misconfigured.urls).toHaveLength(2);
    expect(trapped).toBe(0);
  });

  it("a missing key fails locally before any request", async () => {
    await expect(runDiscoveryBenchmark("discovery-only", dataset, gemini37, prices, "")).rejects.toThrow(/Gemini API key is missing; no request was made/);
    await expect(runDiscoveryBenchmark("smoke", dataset, gemini37, prices, "")).rejects.toThrow(/Gemini API key is missing/);
    expect(trapped).toBe(0);
  });
});

describe("discovery-only: example-based evaluation", () => {
  const validated = (topics: { key: string; name: string; definition: string; exampleCommentIds?: string[] }[]) => {
    const v = validateTopicTaxonomy({ topics }, { sampleCommentIds: gold.baseIds, maxTopics: 12 });
    if (v.status !== "valid") throw new Error(JSON.stringify(v.issues));
    return v.taxonomy;
  };
  const m = (key: string, n: number) => gold.members.get(key)!.slice(0, n);

  it("scores merges, splits, unmatched topics and topics without examples", () => {
    const metrics = evaluateDiscoveredTaxonomy(
      validated([
        { key: "a", name: "Battery and motor", definition: "Range and assist together.", exampleCommentIds: [...m("range", 1), ...m("motor", 1)] },
        { key: "b", name: "Folding mechanism", definition: "The fold itself.", exampleCommentIds: m("folding", 2) },
        { key: "c", name: "Folded size", definition: "How small it folds.", exampleCommentIds: m("folding", 3).slice(2) },
        { key: "d", name: "Brakes", definition: "Stopping.", exampleCommentIds: m("brakes", 3) },
        { key: "e", name: "Accessories", definition: "Extras.", exampleCommentIds: [] },
      ]),
      dataset,
    );
    expect(metrics).toMatchObject({ predictedTopics: 5, topicsWithExamples: 4, matchedTopics: 3, topicPrecision: 3 / 5, conceptRecall: 2 / 8, mergeErrors: 1, splitErrors: 1 });
    expect(metrics.matches.map((x) => [x.key, x.goldKey])).toEqual([
      ["a", null],
      ["b", "folding"],
      ["c", "folding"],
      ["d", "brakes"],
      ["e", null],
    ]);
  });
});

describe("smoke", () => {
  it("sends only the first N topic-base comments and reports status, topics, validation and latency", async () => {
    const fake = fakeGemini([{ text: JSON.stringify({ topics: [{ key: "ride", name: "Riding experience", definition: "How riding the bike feels." }] }) }]);
    let t = 0;
    const result = await runDiscoveryBenchmark("smoke", dataset, gemini37, prices, FAKE_GEMINI, { smokeComments: 20, repeats: 5, clients: { geminiClient: fake.geminiClient }, now: () => (t += 250) });
    expect(trapped).toBe(0);
    const sent = (JSON.parse(userData(fake.bodies[0]!).split("\n")[2]!) as { comments: { id: string }[] }).comments.map((c) => c.id);
    expect(sent.length).toBeLessThanOrEqual(20);
    expect(sent.every((id) => gold.baseIds.slice(0, 20).includes(id))).toBe(true);
    expect(result.meta).toMatchObject({ kind: "smoke", notice: SMOKE_NOTICE, smokeComments: 20, topicBase: 20, repeats: 1, assignment: "not run", matching: null });
    expect(result.oracleGate).toBeNull();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ status: "valid", topics: 1, taxonomy: null, latencyMs: 250 });
    const text = renderDiscoveryBenchmarkMarkdown(result);
    expect(text).toContain(SMOKE_NOTICE);
    expect(text).toContain("| 1 | ok | valid (1: valid) | 1 | 1 | 250 ms |");
    expect(dataset.comments).toHaveLength(200);
  });

  it("validates the comment limit", () => {
    expect(smokeCommentIds(dataset, 20)).toEqual(gold.baseIds.slice(0, 20));
    expect(smokeCommentIds(dataset, 188)).toEqual(gold.baseIds);
    for (const n of [0, 189, 2.5]) expect(() => smokeCommentIds(dataset, n)).toThrow(/--comments must be an integer from 1 to 188/);
  });

  it("plans need only the discovery key and price the smaller request", () => {
    const smoke = buildDiscoveryBenchmarkPlan("smoke", dataset, gemini37, prices, { GEMINI_API_KEY: FAKE_GEMINI }, 1, smokeCommentIds(dataset, 20));
    const full = buildDiscoveryBenchmarkPlan("discovery-only", dataset, gemini37, prices, {}, 1);
    expect(smoke).toMatchObject({ apiCalls: 0, topicBase: 20, environment: { name: "GEMINI_API_KEY", present: true }, discovery: { model: "gemini-3.7-flash", priceConfigured: true }, maxRequests: 2 });
    expect(full).toMatchObject({ topicBase: 188, sampleSize: 188, environment: { name: "GEMINI_API_KEY", present: false } });
    expect(smoke.estimatedInputTokens).toBeLessThan(full.estimatedInputTokens);
    expect(full.maxCostUsd).toBeCloseTo(full.maxCostUsdPerCall * 2, 10);
    expect(trapped).toBe(0);
  });
});

describe("CLI (never with --live here)", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const RESULTS = join(ROOT, "benchmark-results");
  const cli = (args: string[]) => {
    const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
    const out = spawnSync(TSX, ["src/benchmark/topics-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []).toEqual(before);
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("discovery-only without --live prints its plan and refuses to start", () => {
    const { status, text } = cli(["--suite", "discovery-only", "--dataset", "t1-topics-v1", "--provider", "gemini", "--model", "gemini-3.7-flash", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("NO API CALLS MADE");
    expect(text).toContain(DISCOVERY_ONLY_NOTICE);
    expect(text).toContain("GEMINI_API_KEY MISSING (value never printed). No Jev key is needed.");
    expect(text).toContain("--suite discovery-only --dataset t1-topics-v1 --provider gemini --model gemini-3.7-flash --live --repeats 1");
    expect(text).not.toContain("WILL BE MADE");
  }, 60_000);

  it("smoke without --live prints its plan and refuses to start", () => {
    const { status, text } = cli(["--suite", "smoke", "--dataset", "t1-topics-v1", "--provider", "gemini", "--model", "gemini-3.7-flash", "--comments", "20"]);
    expect(status).toBe(2);
    expect(text).toContain(SMOKE_NOTICE);
    expect(text).toContain("topic base 20 (smoke subset)");
    expect(text).toContain("--suite smoke --dataset t1-topics-v1 --provider gemini --model gemini-3.7-flash --live --comments 20");
    expect(text).not.toContain("WILL BE MADE");
  }, 60_000);

  it.each([
    [["--suite", "real", "--comments", "20"], "--comments is only valid with --suite smoke"],
    [["--suite", "smoke", "--repeats", "2"], "--suite smoke makes a single run"],
    [["--suite", "smoke", "--comments", "0"], "--comments must be an integer from 1 to 188"],
    [["--suite", "discovery-only", "--provider", "gemini", "--model", "gemini-2.5-pro"], 'Model "gemini-2.5-pro" is not configured'],
    [["--suite", "replay", "--live"], "--live is only valid with --suite real, discovery-only, smoke, discovery-consolidated or real-consolidated"],
  ])("rejects %j", (args, message) => {
    expect(cli(args)).toMatchObject({ status: 1, text: expect.stringContaining(message) });
  }, 60_000);
});
