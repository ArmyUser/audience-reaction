import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiClient, GeminiTopicTransport, toGeminiResponseSchema } from "../../src/adapters/ai/google/gemini-topic-transport";
import { ReplayTopicTransport } from "../../src/adapters/replay/replay-topic-transport";
import { analyzeTopics } from "../../src/application/analyze-topics";
import { ContractTopicAssigner, ContractTopicTaxonomyGenerator } from "../../src/application/contract-topic-phases";
import { TwoPhaseTopicDiscoverer } from "../../src/application/two-phase-topic-discoverer";
import { TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED } from "../../src/benchmark/topic-benchmark";
import { classifiedCommentsOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { loadTopicReplayResponses } from "../../src/benchmark/topic-replay";
import { InMemoryUsageRecorder, type PriceTable } from "../../src/core/cost/usage";
import { buildTopicDiscoveryRequest, TopicProviderError } from "../../src/core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { toTopicsSection } from "../../src/core/topics/topics-section";
import { TopicDiscoveryOutputError } from "../../src/core/topics/validation";

// Gemini transport for topic-discovery-v2, tested offline: the real @google/genai client runs against a fake fetch
// that records the wire request and replays scripted responses. The global fetch is trapped, so no request can leave
// the process, and the key is a dummy.

const PRICES: PriceTable = { "gemini-3.8-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75, source: "test" } };
const FAKE_KEY = "fake-gemini-key-do-not-use-73";
const RAW_PROVIDER_TEXT = "RAW-PROVIDER-TEXT-must-not-leak-0x52";
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const responses = loadTopicReplayResponses(dataset);
const raw = (id: string) => responses.get(id)!.raw;
const context = { focus: dataset.focus, sentimentLabels: dataset.schema.sentimentLabels, maxTopics: 12 };
const sample = dataset.comments.filter((c) => c.topic !== null).map((c) => ({ id: c.id, text: c.text }));
const sampleIds = sample.map((c) => c.id);

type Reply = { text: string; finishReason?: string; blockReason?: string; modelVersion?: string } | { status: number } | Error;
interface WireCall {
  url: string;
  headers: Headers;
  body: Record<string, any>;
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
  vi.unstubAllEnvs();
});

/** A fake Gemini API endpoint behind the real SDK client. */
function fakeGemini(replies: Reply[], maxRetries = 0) {
  const calls: WireCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const json = { "content-type": "application/json" };
    if ("status" in reply) return new Response(JSON.stringify({ error: { code: reply.status, message: RAW_PROVIDER_TEXT, status: "ERROR" } }), { status: reply.status, headers: json });
    const body = reply.blockReason
      ? { promptFeedback: { blockReason: reply.blockReason }, usageMetadata: { promptTokenCount: 4_400 }, modelVersion: "gemini-3.8-flash" }
      : {
          candidates: [{ content: { role: "model", parts: [{ text: "THOUGHT-SUMMARY-not-part-of-answer", thought: true }, { text: reply.text }] }, finishReason: reply.finishReason ?? "STOP" }],
          usageMetadata: { promptTokenCount: 4_400, candidatesTokenCount: 900, thoughtsTokenCount: 600, totalTokenCount: 5_900 },
          modelVersion: reply.modelVersion ?? "gemini-3.8-flash",
        };
    return new Response(JSON.stringify(body), { status: 200, headers: json });
  }) as unknown as typeof fetch;
  return { calls, client: createGeminiClient(FAKE_KEY, { maxRetries, fetch: fetchImpl }) };
}

function transport(replies: Reply[], options: { maxRetries?: number; recorder?: InMemoryUsageRecorder } = {}) {
  const fake = fakeGemini(replies, options.maxRetries ?? 0);
  const recorder = options.recorder ?? new InMemoryUsageRecorder();
  return { ...fake, recorder, transport: new GeminiTopicTransport({ client: fake.client, prices: PRICES, recorder }) };
}

describe("Gemini topic transport: request", () => {
  it("sends topic-discovery-v2 to gemini-3.8-flash with structured JSON output, low thinking and no sampling parameters", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    await new ContractTopicTaxonomyGenerator(t.transport).proposeTaxonomy({ sample, context });
    const rendered = buildTopicDiscoveryRequest({ sample, context });
    expect(t.calls).toHaveLength(1);
    const [call] = t.calls;
    expect(call!.url).toMatch(/\/models\/gemini-3\.8-flash:generateContent$/);
    expect(call!.body).toEqual({
      contents: [{ role: "user", parts: [{ text: rendered.data }] }],
      systemInstruction: { role: "user", parts: [{ text: rendered.instructions }] },
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: toGeminiResponseSchema(rendered.outputSchema), thinkingConfig: { thinkingLevel: "LOW" }, maxOutputTokens: 16_000 },
    });
    expect(JSON.stringify(call!.body)).not.toMatch(/temperature|topP|topK|tools|candidateCount/);
    expect(t.transport.label).toBe("Google gemini-3.8-flash");
    expect(trapped).toBe(0);
  });

  it("sends the key only in the API-key header, never in the URL or the body", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    await t.transport.complete(buildTopicDiscoveryRequest({ sample, context }));
    const [call] = t.calls;
    expect(call!.headers.get("x-goog-api-key")).toBe(FAKE_KEY);
    expect(call!.url).not.toContain(FAKE_KEY);
    expect(JSON.stringify(call!.body)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(t.recorder.entries)).not.toContain(FAKE_KEY);
  });

  it("sends only sample ids and text: no classifier labels, overall sentiment, identity or engagement", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    const labelled = dataset.comments.filter((c) => c.topic !== null).map((c) => ({ id: c.id, text: c.text, classification: { type: c.classification.type, sentiment: c.classification.sentiment, focusMentioned: true } }));
    await new ContractTopicTaxonomyGenerator(t.transport).proposeTaxonomy({ sample: labelled, context });
    const body = JSON.stringify(t.calls[0]!.body);
    expect(body).not.toMatch(/"sentiment"|classification|focusMentioned|"type":"opinion"|likes|author|channel_id/);
    const user = t.calls[0]!.body.contents[0].parts[0].text as string;
    expect((JSON.parse(user.split("\n")[2]!) as { comments: unknown }).comments).toEqual(sample);
  });

  it("keeps instruction-like comment text inside the <comment_data> user turn, never in the system instruction", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    await new ContractTopicTaxonomyGenerator(t.transport).proposeTaxonomy({ sample, context });
    const hostile = dataset.comments.filter((c) => c.tags.some((tag) => ["prompt_injection", "html_script", "fake_json"].includes(tag)));
    expect(hostile.length).toBeGreaterThan(0);
    const system = t.calls[0]!.body.systemInstruction.parts[0].text as string;
    const user = t.calls[0]!.body.contents[0].parts[0].text as string;
    expect(user.startsWith("Find the topics in the comment sample.\n<comment_data>\n")).toBe(true);
    expect(user.endsWith("\n</comment_data>")).toBe(true);
    const sent = new Map((JSON.parse(user.split("\n")[2]!) as { comments: { id: string; text: string }[] }).comments.map((c) => [c.id, c.text]));
    for (const c of hostile) {
      expect(system, c.id).not.toContain(c.text);
      expect(sent.get(c.id), c.id).toBe(c.text);
    }
  });

  it("sends an output schema reduced to the keywords responseJsonSchema supports, without loosening anything else", () => {
    const full = buildTopicDiscoveryRequest({ sample, context }).outputSchema;
    const sent = toGeminiResponseSchema(full);
    expect(JSON.stringify(sent)).not.toMatch(/minLength|maxLength|pattern/);
    expect(sent).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["topics"],
      properties: {
        topics: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "name", "definition"],
            properties: { key: { type: "string" }, name: { type: "string" }, definition: { type: "string" }, exampleCommentIds: { type: "array", maxItems: 3, items: { type: "string" } } },
          },
        },
      },
    });
  });

  it("sends the same request to gemini-3.7-flash: only the model in the URL changes", async () => {
    const fake = fakeGemini([{ text: raw("taxonomy-perfect"), modelVersion: "gemini-3.7-flash" }]);
    const recorder = new InMemoryUsageRecorder();
    const t37 = new GeminiTopicTransport({ client: fake.client, model: "gemini-3.7-flash", thinkingLevel: "low", prices: { ...PRICES, "gemini-3.7-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75, source: "test" } }, recorder });
    const t38 = transport([{ text: raw("taxonomy-perfect") }]);
    const rendered = buildTopicDiscoveryRequest({ sample, context });
    expect(await t37.complete(rendered)).toBe(raw("taxonomy-perfect"));
    await t38.transport.complete(rendered);
    expect(fake.calls[0]!.url).toMatch(/\/models\/gemini-3\.7-flash:generateContent$/);
    expect(t38.calls[0]!.url).toMatch(/\/models\/gemini-3\.8-flash:generateContent$/);
    expect(fake.calls[0]!.body).toEqual(t38.calls[0]!.body);
    expect(fake.calls[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(t37.buildRequest(rendered)).toEqual({ ...t38.transport.buildRequest(rendered), model: "gemini-3.7-flash" });
    expect(t37.label).toBe("Google gemini-3.7-flash");
    expect(recorder.entries[0]).toMatchObject({ provider: "google", model: "gemini-3.7-flash", modelVersion: "gemini-3.7-flash", estimatedCostUsd: (4_400 * 0.75 + 1_500 * 3.75) / 1e6 });
  });

  it("changes the thinking level and the output ceiling through options", () => {
    const request = new GeminiTopicTransport({ client: fakeGemini([]).client, prices: PRICES, thinkingLevel: "medium", maxOutputTokens: 8_000 }).buildRequest(buildTopicDiscoveryRequest({ sample, context }));
    expect(request).toMatchObject({ model: "gemini-3.8-flash", config: { thinkingConfig: { thinkingLevel: "MEDIUM" }, maxOutputTokens: 8_000 } });
  });

  it("passes retry feedback exactly as the contract renders it, in the data turn", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    const feedback = { attempt: 1, issues: [{ code: "duplicate_topic_name" as const, count: 1, topicKeys: ["topic_a"] }] };
    const rendered = buildTopicDiscoveryRequest({ sample, context, feedback });
    await t.transport.complete(rendered);
    expect(t.calls[0]!.body.contents[0].parts[0].text).toBe(rendered.data);
    expect(t.calls[0]!.body.systemInstruction.parts[0].text).toBe(rendered.instructions);
    expect(rendered.data).toContain('"retry_feedback"');
    expect(t.recorder.entries[0]).toMatchObject({ attempt: 2 });
  });
});

describe("Gemini topic transport: raw responses through the contract parser and validator", () => {
  const propose = async (text: string, finishReason?: string) => new ContractTopicTaxonomyGenerator(transport([{ text, ...(finishReason ? { finishReason } : {}) }]).transport).proposeTaxonomy({ sample, context });
  const validate = (candidate: unknown) => validateTopicTaxonomy(candidate, { sampleCommentIds: sampleIds, maxTopics: 12 });

  it("structured JSON becomes a valid taxonomy; thought parts are not part of the answer", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    expect(await t.transport.complete(buildTopicDiscoveryRequest({ sample, context }))).toBe(raw("taxonomy-perfect"));
    expect(validate(await propose(raw("taxonomy-perfect"))).status).toBe("valid");
  });

  it.each([
    ["malformed JSON", '{"topics":[{"key":"a","name":"A"', undefined],
    ["fenced output", raw("taxonomy-malformed-prose"), undefined],
    ["MAX_TOKENS truncation", raw("taxonomy-perfect").slice(0, 700), "MAX_TOKENS"],
    ["an empty answer", "", undefined],
  ] as [string, string, string | undefined][])("%s is invalid_output, never repaired", async (_name, text, finish) => {
    await expect(propose(text, finish)).rejects.toSatisfy((e: unknown) => e instanceof TopicDiscoveryOutputError && e.issues[0]!.code === "invalid_output");
  });

  it("a topic with an unknown field fails taxonomy validation (invalid_topic); nothing is stripped", async () => {
    const parsed = JSON.parse(raw("taxonomy-perfect")) as { topics: Record<string, unknown>[] };
    parsed.topics[0]!.confidence = 0.9;
    const result = validate(await propose(JSON.stringify(parsed)));
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.issues.map((i) => i.code)).toContain("invalid_topic");
  });

  it.each([
    ["duplicate topics", raw("taxonomy-duplicate-name"), "duplicate_topic_name"],
    ["a missing definition", raw("taxonomy-missing-definition"), "missing_definition"],
  ])("%s parses but fails taxonomy validation (%s)", async (_name, text, code) => {
    const result = validate(await propose(text));
    expect(result.status === "invalid" && result.issues.map((i) => i.code)).toContain(code);
  });
});

describe("Gemini topic transport: failures, retries and usage", () => {
  it.each([
    [400, "configuration"],
    [401, "configuration"],
    [403, "configuration"],
    [404, "configuration"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [503, "unavailable"],
    [504, "timeout"],
  ])("HTTP %i becomes a provider-neutral %s failure without provider text", async (status, failure) => {
    const t = transport([{ status }]);
    const error = await t.transport.complete(buildTopicDiscoveryRequest({ sample, context })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TopicProviderError);
    expect(error).toMatchObject({ provider: "google", failure, status });
    expect(String((error as Error).message)).not.toContain(RAW_PROVIDER_TEXT);
    expect(JSON.stringify(t.recorder.entries)).not.toContain(RAW_PROVIDER_TEXT);
    expect(t.recorder.entries[0]).toMatchObject({ outcome: "provider_error", errorType: failure === "configuration" ? `configuration:HTTP${status}` : `HTTP${status}` });
  });

  it("network errors and aborted requests are transport and timeout failures", async () => {
    const network = await transport([new TypeError("fetch failed")]).transport.complete(buildTopicDiscoveryRequest({ sample, context })).catch((e: unknown) => e);
    expect(network).toMatchObject({ provider: "google", failure: "transport" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const timeout = await transport([abort]).transport.complete(buildTopicDiscoveryRequest({ sample, context })).catch((e: unknown) => e);
    expect(timeout).toMatchObject({ provider: "google", failure: "timeout" });
  });

  it.each([
    ["a blocked prompt", { text: "", blockReason: "SAFETY" }],
    ["a SAFETY finish", { text: "", finishReason: "SAFETY" }],
    ["a PROHIBITED_CONTENT finish", { text: "", finishReason: "PROHIBITED_CONTENT" }],
  ])("%s is a refusal", async (_name, reply) => {
    const t = transport([reply]);
    await expect(t.transport.complete(buildTopicDiscoveryRequest({ sample, context }))).rejects.toMatchObject({ provider: "google", failure: "refusal" });
    expect(t.recorder.entries[0]!.outcome).toBe("refusal");
  });

  it("the SDK retries a transient 503 within the call (configured transport retries)", async () => {
    const t = transport([{ status: 503 }, { text: raw("taxonomy-perfect") }], { maxRetries: 1 });
    expect(await t.transport.complete(buildTopicDiscoveryRequest({ sample, context }))).toBe(raw("taxonomy-perfect"));
    expect(t.calls).toHaveLength(2);
    expect(t.recorder.entries).toHaveLength(1);
  }, 15_000);

  it("never retries a configuration failure inside the call", async () => {
    const t = transport([{ status: 400 }, { text: raw("taxonomy-perfect") }], { maxRetries: 2 });
    await expect(t.transport.complete(buildTopicDiscoveryRequest({ sample, context }))).rejects.toMatchObject({ failure: "configuration" });
    expect(t.calls).toHaveLength(1);
  });

  it("records requested and served model, tokens (thinking billed as output), cost and latency, never content", async () => {
    const t = transport([{ text: raw("taxonomy-perfect"), modelVersion: "gemini-3.8-flash-001" }]);
    await t.transport.complete(buildTopicDiscoveryRequest({ sample, context }));
    expect(t.recorder.entries[0]).toMatchObject({ provider: "google", model: "gemini-3.8-flash", modelVersion: "gemini-3.8-flash-001", promptVersion: "topic-discovery-v2", batchSize: 188, inputTokens: 4_400, outputTokens: 1_500, estimatedCostUsd: (4_400 * 0.75 + 1_500 * 3.75) / 1e6, outcome: "ok", attempt: 1 });
    expect(JSON.stringify(t.recorder.entries)).not.toContain(sample[0]!.text);
    expect(JSON.stringify(t.recorder.entries)).not.toContain("THOUGHT-SUMMARY");
  });

  it("a MAX_TOKENS stop is recorded as incomplete output", async () => {
    const t = transport([{ text: raw("taxonomy-perfect").slice(0, 700), finishReason: "MAX_TOKENS" }]);
    await t.transport.complete(buildTopicDiscoveryRequest({ sample, context }));
    expect(t.recorder.entries[0]!.outcome).toBe("incomplete_output");
  });
});

describe("Gemini topic transport: the existing validation and retry path (analyzeTopics)", () => {
  const discoverer = (t: ReturnType<typeof transport>, assignments: string[]) =>
    new TwoPhaseTopicDiscoverer({ generator: new ContractTopicTaxonomyGenerator(t.transport), assigner: new ContractTopicAssigner(new ReplayTopicTransport({ taxonomy_discovery: [], comment_assignment: assignments })), sample: { seed: TOPIC_BENCHMARK_SEED } });
  const run = (t: ReturnType<typeof transport>, assignments: string[]) => analyzeTopics({ classified: classifiedCommentsOf(dataset), schema: dataset.schema, focus: dataset.focus }, { discoverer: discoverer(t, assignments), params: TOPIC_BENCHMARK_PARAMETERS });

  it("an invalid first answer is retried once with structured feedback, then the valid taxonomy is used", async () => {
    const t = transport([{ text: '{"topics":[{"key":"a"' }, { text: raw("taxonomy-perfect") }]);
    const analysis = await run(t, [raw("assignment-perfect")]);
    expect(analysis.status).toBe("available");
    expect(t.calls).toHaveLength(2);
    const retryData = t.calls[1]!.body.contents[0].parts[0].text as string;
    expect(retryData).toContain('"retry_feedback"');
    expect(retryData).toContain("invalid_output");
    expect(retryData).not.toContain('{"topics":[{"key":"a"');
    expect(t.calls[1]!.body.systemInstruction.parts[0].text).toContain("RETRY:");
    expect(t.recorder.entries.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("a provider failure becomes provider_error with no raw text in the analysis or report", async () => {
    const t = transport([{ status: 500 }]);
    const analysis = await run(t, []);
    expect(analysis).toMatchObject({ status: "unavailable", issues: [{ code: "provider_error", attempt: 1 }, { code: "provider_error", attempt: 2 }] });
    expect(JSON.stringify(analysis)).not.toContain(RAW_PROVIDER_TEXT);
    expect(JSON.stringify(toTopicsSection(analysis))).not.toContain(RAW_PROVIDER_TEXT);
  });
});

describe("Gemini client: missing key", () => {
  it.each([[""], ["   "]])("rejects an empty key %j locally, before any request, even when the SDK could read one from the environment", (key) => {
    vi.stubEnv("GEMINI_API_KEY", "env-key-must-not-be-used");
    vi.stubEnv("GOOGLE_API_KEY", "env-key-must-not-be-used");
    const fetchImpl = vi.fn();
    expect(() => createGeminiClient(key, { fetch: fetchImpl as unknown as typeof fetch })).toThrow(/Gemini API key is missing; no request was made/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(trapped).toBe(0);
  });

  it("uses the explicit key, not one from the environment", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "env-key-must-not-be-used");
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    await t.transport.complete(buildTopicDiscoveryRequest({ sample, context }));
    expect(t.calls[0]!.headers.get("x-goog-api-key")).toBe(FAKE_KEY);
  });
});
