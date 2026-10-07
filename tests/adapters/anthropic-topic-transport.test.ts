import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicTopicTransport, toAnthropicOutputSchema } from "../../src/adapters/ai/anthropic/anthropic-topic-transport";
import { ReplayTopicTransport } from "../../src/adapters/replay/replay-topic-transport";
import { analyzeTopics } from "../../src/application/analyze-topics";
import { ContractTopicAssigner, ContractTopicTaxonomyGenerator } from "../../src/application/contract-topic-phases";
import { TwoPhaseTopicDiscoverer } from "../../src/application/two-phase-topic-discoverer";
import { TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED } from "../../src/benchmark/topic-benchmark";
import { classifiedCommentsOf, goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { loadTopicReplayResponses } from "../../src/benchmark/topic-replay";
import { InMemoryUsageRecorder, type PriceTable } from "../../src/core/cost/usage";
import { buildTopicDiscoveryRequest, TopicProviderError } from "../../src/core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";
import { toTopicsSection } from "../../src/core/topics/topics-section";
import { TopicDiscoveryOutputError } from "../../src/core/topics/validation";

// Anthropic transport for topic-discovery-v2, tested offline with a fake SDK client that returns recorded raw text.
// No request ever leaves the process.

const PRICES: PriceTable = { "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, source: "test" } };
const RAW_PROVIDER_TEXT = "RAW-PROVIDER-TEXT-must-not-leak-0x51";
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const responses = loadTopicReplayResponses(dataset);
const raw = (id: string) => responses.get(id)!.raw;
const context = { focus: dataset.focus, sentimentLabels: dataset.schema.sentimentLabels, maxTopics: 12 };
const sample = dataset.comments.filter((c) => c.topic !== null).map((c) => ({ id: c.id, text: c.text }));
const sampleIds = sample.map((c) => c.id);

type Reply = { text: string; stop_reason?: string; model?: string } | Error;

/** A stand-in for the SDK client: records every request and replays scripted replies. */
function fakeClient(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(structuredClone(params));
          const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
          if (reply instanceof Error) throw reply;
          return {
            id: `msg_${requests.length}`,
            type: "message",
            role: "assistant",
            model: reply.model ?? "claude-sonnet-5-5",
            content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: reply.text }],
            stop_reason: reply.stop_reason ?? "end_turn",
            stop_details: null,
            usage: { input_tokens: 4_500, output_tokens: 3_000 },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

function transport(replies: Reply[], recorder = new InMemoryUsageRecorder()) {
  const fake = fakeClient(replies);
  return { ...fake, recorder, transport: new AnthropicTopicTransport({ client: fake.client, prices: PRICES, recorder }) };
}

const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: RAW_PROVIDER_TEXT } }, RAW_PROVIDER_TEXT, new Headers());

describe("Anthropic topic transport: request", () => {
  it("renders topic-discovery-v2 exactly for claude-sonnet-5-5, with no sampling parameters", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    await new ContractTopicTaxonomyGenerator(t.transport).proposeTaxonomy({ sample, context });
    const rendered = buildTopicDiscoveryRequest({ sample, context });
    const [request] = t.requests;
    expect(request).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 16_000,
      system: rendered.instructions,
      messages: [{ role: "user", content: rendered.data }],
      output_config: { effort: "high", format: { type: "json_schema", schema: toAnthropicOutputSchema(rendered.outputSchema) } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("tools");
    expect(t.transport.label).toBe("Anthropic claude-sonnet-5-5");
  });

  it("sends only sample ids and text: no classifier labels, overall sentiment, identity or engagement", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    const labelled = dataset.comments.filter((c) => c.topic !== null).map((c) => ({ id: c.id, text: c.text, classification: { type: c.classification.type, sentiment: c.classification.sentiment, focusMentioned: true } }));
    await new ContractTopicTaxonomyGenerator(t.transport).proposeTaxonomy({ sample: labelled, context });
    const body = JSON.stringify(t.requests[0]);
    expect(body).not.toMatch(/"sentiment"|classification|focusMentioned|"type":"opinion"|likes|author|channel_id/);
    const user = (t.requests[0]!.messages as { content: string }[])[0]!.content;
    const comments = (JSON.parse(user.split("\n")[2]!) as { comments: { id: string; text: string }[] }).comments;
    expect(comments).toEqual(sample);
  });

  it("keeps instruction-like comment text inside the user data, never in the system instructions", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }]);
    await new ContractTopicTaxonomyGenerator(t.transport).proposeTaxonomy({ sample, context });
    const hostile = dataset.comments.filter((c) => c.tags.some((tag) => ["prompt_injection", "html_script", "fake_json"].includes(tag)));
    const system = t.requests[0]!.system as string;
    for (const c of hostile) expect(system, c.id).not.toContain(c.text);
    expect(system).toBe(buildTopicDiscoveryRequest({ sample: sample.slice(0, 2), context }).instructions);
  });

  it("sends an output schema reduced to what structured outputs accept, without loosening anything else", () => {
    const full = buildTopicDiscoveryRequest({ sample, context }).outputSchema;
    const sent = toAnthropicOutputSchema(full);
    expect(JSON.stringify(sent)).not.toMatch(/minLength|maxLength|maxItems|minItems|pattern/);
    expect(sent).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["topics"],
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "name", "definition"],
            properties: { key: { type: "string" }, name: { type: "string" }, definition: { type: "string" }, exampleCommentIds: { type: "array", items: { type: "string" } } },
          },
        },
      },
    });
  });

  it("can switch the refusal fallback off and change effort and the output ceiling through options", () => {
    const fake = fakeClient([]);
    const request = new AnthropicTopicTransport({ client: fake.client, prices: PRICES, refusalFallback: "off", effort: "medium", maxOutputTokens: 8_000 }).buildRequest(buildTopicDiscoveryRequest({ sample, context }));
    expect(request).not.toHaveProperty("fallbacks");
    expect(request).not.toHaveProperty("betas");
    expect(request).toMatchObject({ max_tokens: 8_000, output_config: { effort: "medium" } });
  });
});

describe("Anthropic topic transport: raw responses through the contract parser and validator", () => {
  const propose = async (text: string, stop_reason?: string) => new ContractTopicTaxonomyGenerator(transport([{ text, ...(stop_reason ? { stop_reason } : {}) }]).transport).proposeTaxonomy({ sample, context });
  const validate = (candidate: unknown) => validateTopicTaxonomy(candidate, { sampleCommentIds: sampleIds, maxTopics: 12 });

  it("perfect JSON becomes a valid taxonomy", async () => {
    expect(validate(await propose(raw("taxonomy-perfect"))).status).toBe("valid");
  });

  it.each([
    ["malformed JSON", '{"topics":[{"key":"a","name":"A"', undefined],
    ["fenced output", raw("taxonomy-malformed-prose"), undefined],
    ["max_tokens truncation", raw("taxonomy-perfect").slice(0, 700), "max_tokens"],
  ] as [string, string, string | undefined][])("%s is invalid_output, never repaired", async (_name, text, stop) => {
    await expect(propose(text, stop)).rejects.toSatisfy((e: unknown) => e instanceof TopicDiscoveryOutputError && e.issues[0]!.code === "invalid_output");
  });

  it.each([
    ["duplicate topics", raw("taxonomy-duplicate-name"), "duplicate_topic_name"],
    ["a missing definition", raw("taxonomy-missing-definition"), "missing_definition"],
    ["an invalid example id", raw("taxonomy-perfect").replace('"t1-009"', '"t9-999"'), "unknown_example_comment"],
  ])("%s parses but fails taxonomy validation (%s)", async (_name, text, code) => {
    const result = validate(await propose(text));
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.issues.map((i) => i.code)).toContain(code);
  });
});

describe("Anthropic topic transport: failures and usage", () => {
  it.each([
    [401, "configuration"],
    [403, "configuration"],
    [404, "configuration"],
    [400, "configuration"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("HTTP %i becomes a provider-neutral %s failure without provider text", async (status, failure) => {
    const t = transport([apiError(status)]);
    const error = await t.transport.complete(buildTopicDiscoveryRequest({ sample, context })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TopicProviderError);
    expect(error).toMatchObject({ provider: "anthropic", failure, status });
    expect(String((error as Error).message)).not.toContain(RAW_PROVIDER_TEXT);
    expect(JSON.stringify(t.recorder.entries)).not.toContain(RAW_PROVIDER_TEXT);
    expect(t.recorder.entries[0]).toMatchObject({ outcome: "provider_error", errorType: failure === "configuration" ? expect.stringMatching(/^configuration:/) : expect.any(String) });
  });

  it("timeouts and refusals are provider failures too", async () => {
    const timeout = await transport([new Anthropic.APIConnectionTimeoutError()]).transport.complete(buildTopicDiscoveryRequest({ sample, context })).catch((e: unknown) => e);
    expect(timeout).toMatchObject({ failure: "timeout" });
    const t = transport([{ text: "", stop_reason: "refusal" }]);
    await expect(t.transport.complete(buildTopicDiscoveryRequest({ sample, context }))).rejects.toMatchObject({ failure: "refusal" });
    expect(t.recorder.entries[0]!.outcome).toBe("refusal");
  });

  it("records requested and served model, tokens, cost and latency, never the request content", async () => {
    const t = transport([{ text: raw("taxonomy-perfect") }, { text: raw("taxonomy-perfect"), model: "claude-opus-5-5" }]);
    const request = buildTopicDiscoveryRequest({ sample, context });
    expect(await t.transport.complete(request)).toBe(raw("taxonomy-perfect"));
    await t.transport.complete(request);
    expect(t.recorder.entries[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", modelVersion: "claude-sonnet-5-5", promptVersion: "topic-discovery-v2", batchSize: 188, inputTokens: 4_500, outputTokens: 3_000, estimatedCostUsd: (4_500 * 2 + 3_000 * 10) / 1e6, outcome: "ok" });
    // A refusal fallback that answered from another model is visible and stays unpriced unless configured.
    expect(t.recorder.entries[1]).toMatchObject({ modelVersion: "claude-opus-5-5" });
    expect(t.recorder.entries[1]).not.toHaveProperty("estimatedCostUsd");
    expect(JSON.stringify(t.recorder.entries)).not.toContain(sample[0]!.text);
  });

  it("through analyzeTopics, a provider failure becomes provider_error with no raw text in the analysis or report", async () => {
    const t = transport([apiError(500)]);
    const discoverer = new TwoPhaseTopicDiscoverer({ generator: new ContractTopicTaxonomyGenerator(t.transport), assigner: new ContractTopicAssigner(new ReplayTopicTransport({ taxonomy_discovery: [], comment_assignment: [] })), sample: { seed: TOPIC_BENCHMARK_SEED } });
    const analysis = await analyzeTopics({ classified: classifiedCommentsOf(dataset), schema: dataset.schema, focus: dataset.focus }, { discoverer, params: TOPIC_BENCHMARK_PARAMETERS });
    expect(analysis).toMatchObject({ status: "unavailable", issues: [{ code: "provider_error", attempt: 1 }, { code: "provider_error", attempt: 2 }] });
    expect(JSON.stringify(analysis)).not.toContain(RAW_PROVIDER_TEXT);
    expect(JSON.stringify(toTopicsSection(analysis))).not.toContain(RAW_PROVIDER_TEXT);
    expect(gold.baseIds).toHaveLength(188);
  });
});
