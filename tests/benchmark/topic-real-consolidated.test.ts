import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { JevTopicAssigner } from "../../src/adapters/ai/typesafe/jev-topic-assigner";
import { goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { buildRealConsolidatedPlan, realConsolidatedResultFileName, realConsolidatedScenarioId, REAL_CONSOLIDATED_NOTICE, renderRealConsolidatedMarkdown, runRealConsolidatedBenchmark } from "../../src/benchmark/topic-real-consolidated";
import { loadPrices, loadTopicProviderConfig, REAL_SCENARIO_ID, runRealTopicBenchmark } from "../../src/benchmark/topic-real";
import { TOPIC_CONSOLIDATION_CONTRACT } from "../../src/core/topics/consolidation-contract";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";

// EXPERIMENTAL real-consolidated suite, offline: discovery and consolidation answer from a fake Anthropic SDK client,
// Jev from a fake endpoint answering with gold dispositions; keys are dummies and the global fetch is trapped. The t1
// dataset is used through IDs only (gold members by index); topic names are synthetic.

const ROOT = join(__dirname, "..", "..");
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const config = loadTopicProviderConfig();
const prices = loadPrices();
const FAKE_ANTHROPIC = "fake-anthropic-key-do-not-use-91";
const FAKE_JEV = "fake-jev-key-do-not-use-42";
const keys = { discoveryApiKey: FAKE_ANTHROPIC, jevApiKey: FAKE_JEV };
const scenarioId = realConsolidatedScenarioId("anthropic");

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

type Proposal = { key: string; name: string; definition: string; exampleCommentIds?: string[] };
const json = (topics: Proposal[]) => JSON.stringify({ topics });
const concepts = dataset.taxonomy.map((t) => t.key);
const membersOf = (i: number) => gold.members.get(concepts[i]!)!;
const otherIds = gold.baseIds.filter((id) => gold.dispositions.get(id)!.disposition === "other");

/** Discovery's fragmented answer: one synthetic topic per concept, concept 2 split in two, plus a peripheral topic. */
function fragmented(): Proposal[] {
  return concepts
    .flatMap((_, i): Proposal[] =>
      i === 2
        ? [
            { key: "theme_2a", name: "Theme two first aspect", definition: "One aspect of the second theme.", exampleCommentIds: membersOf(i).slice(0, 2) },
            { key: "theme_2b", name: "Theme two second aspect", definition: "Another aspect of the second theme.", exampleCommentIds: membersOf(i).slice(2, 4) },
          ]
        : [{ key: `theme_${i}`, name: `Theme number ${i}`, definition: `Synthetic theme number ${i}.`, exampleCommentIds: membersOf(i).slice(0, 2) }],
    )
    .concat([{ key: "side_theme", name: "Side theme", definition: "A small side discussion.", exampleCommentIds: otherIds.slice(0, 2) }]);
}

/** Consolidation's answer: the split concept merged back, the peripheral topic dropped. */
function compact(): Proposal[] {
  return concepts.map((_, i): Proposal =>
    i === 2
      ? { key: "theme_2a", name: "Theme two", definition: "Both aspects of the second theme.", exampleCommentIds: [...membersOf(i).slice(0, 2), membersOf(i)[2]!] }
      : { key: `theme_${i}`, name: `Theme number ${i}`, definition: `Synthetic theme number ${i}.`, exampleCommentIds: membersOf(i).slice(0, 2) },
  );
}
const keyFor = (goldKey: string) => (concepts.indexOf(goldKey) === 2 ? "theme_2a" : `theme_${concepts.indexOf(goldKey)}`);

/** Fake Anthropic SDK client answering discovery and consolidation from scripts (numbers are HTTP errors). */
function fakeAnthropic(discovery: (string | number)[], consolidation: (string | number)[]) {
  const requests: Record<string, any>[] = [];
  const anthropicClient = {
    beta: {
      messages: {
        create: async (params: Record<string, any>) => {
          requests.push(structuredClone(params));
          const isConsolidation = String(params.system).includes(TOPIC_CONSOLIDATION_CONTRACT);
          const script = isConsolidation ? consolidation : discovery;
          const n = requests.filter((r) => String(r.system).includes(TOPIC_CONSOLIDATION_CONTRACT) === isConsolidation).length - 1;
          const reply = script[Math.min(n, script.length - 1)]!;
          if (typeof reply === "number") {
            const { default: Anthropic } = await import("@anthropic-ai/sdk");
            throw Anthropic.APIError.generate(reply, { type: "error", error: { type: "x", message: "provider text" } }, "provider text", new Headers());
          }
          const usage = isConsolidation ? { input_tokens: 5_800, output_tokens: 1_500 } : { input_tokens: 4_600, output_tokens: 3_000 };
          return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_details: null, usage };
        },
      },
    },
  } as unknown as ReturnType<typeof createAnthropicClient>;
  return { requests, anthropicClient, consolidationRequests: () => requests.filter((r) => String(r.system).includes(TOPIC_CONSOLIDATION_CONTRACT)) };
}

/** Fake Jev endpoint: gold disposition per comment, topic keys mapped by `keyOf`; records every request body. */
function fakeJev(keyOf: (goldKey: string) => string) {
  const bodies: { state: { comment: string; taxonomy?: { key: string }[] }; questions: Record<string, unknown> }[] = [];
  const byText = new Map(dataset.comments.map((c) => [c.text, c.id]));
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as (typeof bodies)[number];
    bodies.push(body);
    const g = gold.dispositions.get(byText.get(body.state.comment)!)!;
    const answers =
      "topic" in body.questions
        ? { topic: { type: "choice", choice: g.disposition === "primary_topic" ? `topic:${keyOf(g.topicKey)}` : g.disposition } }
        : { topic_sentiment: { type: "choice", choice: g.disposition === "primary_topic" ? g.topicSentiment : "neutral" } };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, fetch: fetchImpl, taxonomyKeys: () => [...new Set(bodies.flatMap((b) => (b.state.taxonomy ? [JSON.stringify(b.state.taxonomy.map((t) => t.key))] : [])))] };
}

const liveOf = (report: { scenarios: { id: string; runs: any[] }[] }, id = scenarioId) => report.scenarios.find((s) => s.id === id)!;

describe("real-consolidated: discovery → consolidation → unchanged Jev path → unchanged evaluator", () => {
  it("assigns against the consolidated taxonomy and the full evaluator scores those assignments", async () => {
    const anthropic = fakeAnthropic([json(fragmented())], [json(compact())]);
    const jev = fakeJev(keyFor);
    const result = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: anthropic.anthropicClient, fetch: jev.fetch });
    expect(trapped).toBe(0);
    expect(result.report.oracleGate.passed).toBe(true);

    // The taxonomy Jev received is the consolidated one: 8 topics, no dropped or merged-away candidate.
    expect(jev.taxonomyKeys()).toEqual([JSON.stringify(compact().map((t) => t.key))]);
    expect(JSON.stringify(jev.bodies)).not.toMatch(/theme_2b|side_theme/);
    expect(jev.bodies.filter((b) => "topic" in b.questions)).toHaveLength(188);

    // The unchanged Jev path: request bodies are exactly what the production assigner builds for that taxonomy.
    // As in the real suite, the discoverer passes the validator's normalised names to the assigner.
    const validatedCompact = validateTopicTaxonomy({ topics: compact() }, { sampleCommentIds: gold.baseIds, maxTopics: 12 });
    if (validatedCompact.status !== "valid") throw new Error("compact() must validate");
    const consolidatedTaxonomy = validatedCompact.taxonomy.topics.map(({ key, name, definition }) => ({ key, name, definition }));
    const first = jev.bodies.find((b) => "topic" in b.questions)!;
    const jevAssigner = new JevTopicAssigner({ apiKey: "unused", model: config.assignment.model, prices });
    expect(first).toEqual(jevAssigner.buildTopicRequestBody(first.state.comment, dataset.focus, consolidatedTaxonomy));

    // The full evaluator, unchanged, scores the consolidated assignments.
    const live = liveOf(result.report);
    expect(live.runs[0]).toMatchObject({ status: "available", attempts: 1, generatorCalls: 1, assignerCalls: 1 });
    expect(live.runs[0].taxonomy).toMatchObject({ predictedTopics: 8, matchedTopics: 8, topicPrecision: 1, conceptRecall: 1, mergeErrors: 0, splitErrors: 0 });
    expect(live.runs[0].assignment).toMatchObject({ dispositionAccuracy: 1, primaryTopicAccuracy: 1, topicSentimentAccuracy: 1 });
    expect(live.runs[0].report).toMatchObject({ ac23Valid: true, highOtherShareCorrect: true });
    const predictions = JSON.stringify(live.runs[0].predictions);
    expect(predictions).not.toMatch(/theme_2b|side_theme/);

    // Phase-level record.
    expect(result.phases).toEqual([
      {
        repeat: 1,
        taxonomyCalls: [
          {
            call: 1,
            discovery: { outcome: "valid", issueCodes: [], topics: 10 },
            consolidation: { status: "valid", attempts: [expect.objectContaining({ attempt: 1, outcome: "valid", topics: 8 })], topics: 8, decisions: { retained: concepts.flatMap((_, i) => (i === 2 ? [] : [`theme_${i}`])), merged: ["theme_2a", "theme_2b"], dropped: ["side_theme"], unknown: [], unanchoredTopics: [], split: [] } },
          },
        ],
      },
    ]);
    // Consolidation receives the same seeded sample discovery received.
    const [discoveryRequest] = anthropic.requests;
    const [consolidationRequest] = anthropic.consolidationRequests();
    const commentsOf = (p: Record<string, any>) => JSON.parse(String(p.messages[0].content).split("\n")[2]!).comments;
    expect(commentsOf(consolidationRequest!)).toEqual(commentsOf(discoveryRequest!));

    // Usage split by phase.
    expect(result.usage[0]!.discovery).toMatchObject({ requests: 1, inputTokens: 4_600, outputTokens: 3_000 });
    expect(result.usage[0]!.consolidation).toMatchObject({ requests: 1, inputTokens: 5_800, outputTokens: 1_500 });
    expect(result.usage[0]!.assignment).toMatchObject({ requests: 188 + 134, batches: 8 });
    expect(result.totals.discovery.estimatedCostUsd).toBeCloseTo((4_600 * 2 + 3_000 * 10) / 1e6, 10);
    expect(result.totals.consolidation.estimatedCostUsd).toBeCloseTo((5_800 * 2 + 1_500 * 10) / 1e6, 10);
    expect(result.totals.assignment.estimatedCostUsd).toBeCloseTo(((188 + 134) * 500 * 0.042) / 1e6, 10);
    expect(result.meta).toMatchObject({ kind: "real-consolidated", experimental: true, notice: REAL_CONSOLIDATED_NOTICE, consolidation: { contract: "topic-consolidation-v3", topicBase: 188, minTopicSize: 10 }, discovery: { provider: "anthropic", modelRequested: "claude-sonnet-5-5", contract: "topic-discovery-v2" }, assignment: { modelRequested: "jev-latest", questionSet: "jev-topic-a1" } });

    const text = renderRealConsolidatedMarkdown(result);
    expect(text).toContain("EXPERIMENTAL");
    expect(text).toContain("NOT part of production yet");
    expect(text).toContain("discovery valid, 10 topics → consolidation valid (1: valid), 8 topics; decisions: retained 7");
    expect(text).toContain("merged 2 (theme_2a, theme_2b), dropped 1 (side_theme)");
    expect(text).toContain("## Full benchmark (existing evaluator, unchanged)");
    expect(text).toContain(`| ${scenarioId} |`);
    expect(text).toMatch(/repeat 1: discovery 1 requests, \d+ ms, tokens 4600 \/ 3000, \$0\.0392; consolidation 1 requests, \d+ ms, tokens 5800 \/ 1500, \$0\.0266; Jev assignment 322 requests/);
    expect(JSON.stringify(result)).not.toContain(FAKE_ANTHROPIC);
    expect(JSON.stringify(result)).not.toContain(FAKE_JEV);
    expect(realConsolidatedResultFileName(result)).toMatch(/-topics-t1-topics-v1-real-consolidated-anthropic-claude-sonnet-5-5-typesafe-jev-latest\.json$/);
  });

  it("is comparable with real: the same evaluator scores the unconsolidated taxonomy lower", async () => {
    const plain = await runRealTopicBenchmark(dataset, config, prices, keys, 1, { anthropicClient: fakeAnthropic([json(fragmented())], []).anthropicClient, fetch: fakeJev(keyFor).fetch });
    const consolidated = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: fakeAnthropic([json(fragmented())], [json(compact())]).anthropicClient, fetch: fakeJev(keyFor).fetch });
    const before = liveOf(plain.report, REAL_SCENARIO_ID).runs[0].taxonomy;
    const after = liveOf(consolidated.report).runs[0].taxonomy;
    expect(before.predictedTopics).toBe(10);
    expect(after.predictedTopics).toBe(8);
    expect(after.topicPrecision).toBeGreaterThan(before.topicPrecision);
    expect(Object.keys(plain.report.scenarios[1]!.runs[0]!)).toEqual(Object.keys(consolidated.report.scenarios[1]!.runs[0]!));
  });

  it("an invalid discovery is retried by the production rule (feedback), then consolidated and assigned", async () => {
    const anthropic = fakeAnthropic(["not json", json(fragmented())], [json(compact())]);
    const jev = fakeJev(keyFor);
    const result = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: anthropic.anthropicClient, fetch: jev.fetch });
    const live = liveOf(result.report);
    expect(live.runs[0]).toMatchObject({ status: "available", attempts: 2, failedAttemptCodes: [["invalid_output"]] });
    expect(result.phases[0]!.taxonomyCalls.map((c) => [c.discovery.outcome, c.consolidation.status])).toEqual([
      ["invalid_taxonomy", "not_run"],
      ["valid", "valid"],
    ]);
    expect(String(anthropic.requests[1]!.messages[0].content)).toContain('"retry_feedback"');
    expect(jev.taxonomyKeys()).toEqual([JSON.stringify(compact().map((t) => t.key))]);
  });

  it("discovery failing after retry ends unavailable: no consolidation, no Jev call", async () => {
    const anthropic = fakeAnthropic([500], [json(compact())]);
    const jev = fakeJev(keyFor);
    const result = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: anthropic.anthropicClient, fetch: jev.fetch });
    expect(liveOf(result.report).runs[0]).toMatchObject({ status: "unavailable", attempts: 2, failedAttemptCodes: [["provider_error"], ["provider_error"]], taxonomy: null, assignment: null });
    expect(result.phases[0]!.taxonomyCalls.map((c) => [c.discovery.outcome, c.discovery.providerFailure, c.consolidation.status])).toEqual([
      ["provider_error", "unavailable", "not_run"],
      ["provider_error", "unavailable", "not_run"],
    ]);
    expect(anthropic.consolidationRequests()).toHaveLength(0);
    expect(jev.bodies).toHaveLength(0);
    expect(trapped).toBe(0);
  });

  it("consolidation failing after its retry ends unavailable, with no fallback and no further provider calls", async () => {
    const anthropic = fakeAnthropic([json(fragmented())], [500]);
    const jev = fakeJev(keyFor);
    const result = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: anthropic.anthropicClient, fetch: jev.fetch });
    expect(liveOf(result.report).runs[0]).toMatchObject({ status: "unavailable", attempts: 2, failedAttemptCodes: [["provider_error"], ["provider_error"]], taxonomy: null, assignment: null });
    // One discovery and two consolidation attempts, then the second analysis attempt ends without any call.
    expect(anthropic.requests).toHaveLength(3);
    expect(anthropic.consolidationRequests()).toHaveLength(2);
    expect(result.phases[0]!.taxonomyCalls).toEqual([
      expect.objectContaining({ call: 1, discovery: { outcome: "valid", issueCodes: [], topics: 10 }, consolidation: expect.objectContaining({ status: "unavailable", topics: null, decisions: null }) }),
      expect.objectContaining({ call: 2, discovery: { outcome: "not_called", issueCodes: [], topics: null }, consolidation: expect.objectContaining({ status: "not_run" }) }),
    ]);
    // No fallback: the unconsolidated taxonomy never reached Jev (Jev was not called at all).
    expect(jev.bodies).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("provider text");
    expect(renderRealConsolidatedMarkdown(result)).toContain("consolidation unavailable (1: provider_error (unavailable) [provider_error]; 2: provider_error (unavailable) [provider_error])");
  });

  it("invalid consolidation output is retried once with feedback; invalid twice ends unavailable", async () => {
    const tooMany = json([...fragmented(), { key: "extra", name: "Extra theme", definition: "Something new." }]);
    const recovered = fakeAnthropic([json(fragmented())], [tooMany, json(compact())]);
    const jev = fakeJev(keyFor);
    const ok = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: recovered.anthropicClient, fetch: jev.fetch });
    expect(liveOf(ok.report).runs[0]).toMatchObject({ status: "available", attempts: 1 });
    expect(ok.phases[0]!.taxonomyCalls[0]!.consolidation.attempts.map((a) => [a.outcome, a.issueCodes, a.feedbackSent])).toEqual([
      ["invalid_taxonomy", ["too_many_topics"], false],
      ["valid", [], true],
    ]);
    expect(String(recovered.consolidationRequests()[1]!.messages[0].content)).toContain('"retry_feedback"');
    expect(jev.taxonomyKeys()).toEqual([JSON.stringify(compact().map((t) => t.key))]);

    const invented = json(compact().map((t, i) => (i === 0 ? { ...t, exampleCommentIds: [gold.baseIds.find((id) => !fragmented().some((f) => f.exampleCommentIds!.includes(id)))!] } : t)));
    const failing = fakeAnthropic([json(fragmented())], [invented]);
    const jev2 = fakeJev(keyFor);
    const bad = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: failing.anthropicClient, fetch: jev2.fetch });
    expect(liveOf(bad.report).runs[0]).toMatchObject({ status: "unavailable" });
    expect(bad.phases[0]!.taxonomyCalls[0]!.consolidation.attempts.map((a) => a.issueCodes)).toEqual([["unknown_example_comment"], ["unknown_example_comment"]]);
    expect(jev2.bodies).toHaveLength(0);
  });

  it("a missing key fails locally before any request", async () => {
    await expect(runRealConsolidatedBenchmark(dataset, config, prices, { discoveryApiKey: "", jevApiKey: FAKE_JEV }, 1, { fetch: fakeJev(keyFor).fetch })).rejects.toThrow(/Anthropic API key is missing; no request was made/);
    expect(trapped).toBe(0);
  });
});

describe("the real suite is unchanged", () => {
  it("without the hook it runs discovery only (no consolidation request) under its own scenario id", async () => {
    const anthropic = fakeAnthropic([json(fragmented())], [json(compact())]);
    const jev = fakeJev((goldKey) => (concepts.indexOf(goldKey) === 2 ? "theme_2a" : `theme_${concepts.indexOf(goldKey)}`));
    const result = await runRealTopicBenchmark(dataset, config, prices, keys, 1, { anthropicClient: anthropic.anthropicClient, fetch: jev.fetch });
    expect(anthropic.requests).toHaveLength(1);
    expect(anthropic.consolidationRequests()).toHaveLength(0);
    expect(result.report.scenarios.map((s) => s.id)).toEqual(["oracle", REAL_SCENARIO_ID]);
    expect(result.meta.validation).toBe("production (frozen M4 validators, two attempts)");
    expect(jev.taxonomyKeys()).toEqual([JSON.stringify(fragmented().map((t) => t.key))]);
    expect(JSON.stringify(result)).not.toMatch(/consolidat/);
  });
});

describe("plan and CLI (never with --live here)", () => {
  it("adds consolidation to the real preflight; the worst case stays within the default limit", () => {
    const plan = buildRealConsolidatedPlan(dataset, config, prices, {}, 1);
    expect(plan.apiCalls).toBe(0);
    expect(plan.consolidation.contract).toBe("topic-consolidation-v3");
    expect(plan.maxCostUsd).toBeCloseTo(plan.real.total.maxCostUsd + plan.consolidation.maxCostUsdPerCall * 2, 10);
    expect(plan.maxRequests).toBe(plan.real.total.maxRequests + 2);
    expect(plan.maxCostUsd).toBeLessThan(config.limits.maxCostUsd);
  });

  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const RESULTS = join(ROOT, "benchmark-results");
  const cli = (args: string[]) => {
    const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
    const out = spawnSync(TSX, ["src/benchmark/topics-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []).toEqual(before);
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("without --live prints the real preflight plus consolidation and refuses to start", () => {
    const { status, text } = cli(["--suite", "real-consolidated", "--dataset", "t1-topics-v1", "--provider", "anthropic", "--model", "claude-sonnet-5-5", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("# Real topic providers: preflight");
    expect(text).toContain("## Consolidation (EXPERIMENTAL, before assignment)");
    expect(text).toContain(REAL_CONSOLIDATED_NOTICE);
    expect(text).toContain("ANTHROPIC_API_KEY MISSING, JEV_API_KEY MISSING");
    expect(text).toContain("--suite real-consolidated --dataset t1-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1");
    expect(text).not.toContain("WILL BE MADE");
  }, 60_000);
});
