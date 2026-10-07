import { describe, expect, it } from "vitest";
import { buildJevQuestionSet, JEV_QUESTION_SETS } from "../../src/adapters/ai/typesafe/jev-question-sets";
import { JevTopicAssigner } from "../../src/adapters/ai/typesafe/jev-topic-assigner";
import { JEV_TOPIC_KEYS, JEV_TOPIC_QUESTION_SET } from "../../src/adapters/ai/typesafe/jev-topic-questions";
import { analyzeTopics } from "../../src/application/analyze-topics";
import { BatchingTopicAssigner } from "../../src/application/batching-topic-assigner";
import { TwoPhaseTopicDiscoverer } from "../../src/application/two-phase-topic-discoverer";
import { ScriptedTaxonomyGenerator } from "../../src/adapters/fakes/topic-benchmark-phases";
import { TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED } from "../../src/benchmark/topic-benchmark";
import { classifiedCommentsOf, goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { InMemoryUsageRecorder, type PriceTable } from "../../src/core/cost/usage";
import type { TopicAssigner, TopicAssignmentRequest } from "../../src/core/ports";
import { TOPIC_ASSIGNMENT_SEMANTICS, TopicProviderError } from "../../src/core/topics/provider-contracts";
import { parseTopicDiscoveryOutput, TopicDiscoveryOutputError } from "../../src/core/topics/validation";

// TypeSafe Jev behind TopicAssigner (topic-assignment-v1 as jev-topic-a1), tested offline with a fake fetch that
// answers from gold. No request leaves the process; the key is a dummy.

const KEY = "test-jev-key-not-real-7c1";
const PRICES: PriceTable = { "jev-latest": { inputPerMTok: 0.042, outputPerMTok: 0, source: "test" } };
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const byText = new Map(dataset.comments.map((c) => [c.text, c.id]));
const taxonomy = dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition }));
const context = { focus: dataset.focus, sentimentLabels: dataset.schema.sentimentLabels, maxTopics: 12 };
const base = dataset.comments.filter((c) => c.topic !== null);
const request = (comments = base.map((c) => ({ id: c.id, text: c.text }))): TopicAssignmentRequest => ({ comments, taxonomy, context });

interface Call {
  url: string;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
  auth: string;
}
type Responder = (call: Call, n: number) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | "network";

/** Answers from gold: step 1 the gold disposition, step 2 the gold topic sentiment. */
const goldResponder: Responder = (call) => {
  const id = byText.get(call.body.state.comment as string)!;
  const g = gold.dispositions.get(id)!;
  if (JEV_TOPIC_KEYS.topic in call.body.questions) {
    return { json: { model: "jev-1.13.0", answers: { topic: { type: "choice", choice: g.disposition === "primary_topic" ? `topic:${g.topicKey}` : g.disposition } }, usage: { input_tokens: 600, output_tokens: 1 } } };
  }
  return { json: { model: "jev-1.13.0", answers: { topic_sentiment: { type: "choice", choice: g.disposition === "primary_topic" ? g.topicSentiment : "neutral" } }, usage: { input_tokens: 300, output_tokens: 1 } } };
};

function fakeFetch(responder: Responder) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call: Call = { url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization ?? "" };
    calls.push(call);
    // Out-of-order completion: concurrency must never change the output order.
    await new Promise((r) => setTimeout(r, (calls.length * 7) % 5));
    const reply = responder(call, calls.length);
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: reply.headers ?? {} });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function assigner(responder: Responder, extra: Partial<ConstructorParameters<typeof JevTopicAssigner>[0]> = {}) {
  const fetch = fakeFetch(responder);
  const recorder = new InMemoryUsageRecorder();
  return { ...fetch, recorder, assigner: new JevTopicAssigner({ apiKey: KEY, prices: PRICES, recorder, fetch: fetch.impl, sleep: async () => {}, ...extra }) };
}

const validate = (entries: unknown[], ids = gold.baseIds) => parseTopicDiscoveryOutput({ topics: taxonomy.map((t) => ({ key: t.key, name: t.name, description: t.definition })), assignments: entries }, ids, { maxTopics: 12, sentimentLabels: dataset.schema.sentimentLabels });

describe("Jev topic assigner: requests", () => {
  it("requests jev-latest at /v1/systemone with the bearer key, and records the served version", async () => {
    const a = assigner(goldResponder);
    await a.assigner.assignTopics(request(base.slice(0, 3).map((c) => ({ id: c.id, text: c.text }))));
    expect(new Set(a.calls.map((c) => c.body.model))).toEqual(new Set(["jev-latest"]));
    expect(new Set(a.calls.map((c) => c.url))).toEqual(new Set(["https://api.typesafe.ai/v1/systemone"]));
    expect(a.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    expect(a.recorder.entries.every((e) => e.model === "jev-latest" && e.modelVersion === "jev-1.13.0" && e.promptVersion === JEV_TOPIC_QUESTION_SET)).toBe(true);
    expect(a.assigner.label).toBe("TypeSafe jev-latest (jev-topic-a1)");
  });

  it("uses a new question set that shares no key or wording with any classifier question set", () => {
    const a = assigner(goldResponder);
    const step1 = a.assigner.buildTopicRequestBody("x", dataset.focus, taxonomy).questions;
    const step2 = a.assigner.buildSentimentRequestBody("x", dataset.focus, taxonomy[0]!, dataset.schema.sentimentLabels).questions;
    const topicTexts = [...Object.values(step1), ...Object.values(step2)].map((q) => q.instructions);
    for (const version of JEV_QUESTION_SETS) {
      const classifier = buildJevQuestionSet(version, createClassificationSchema({ focusConfigured: true }));
      for (const key of [...Object.keys(step1), ...Object.keys(step2)]) expect(classifier, `${version}:${key}`).not.toHaveProperty([key]);
      for (const q of Object.values(classifier)) for (const t of topicTexts) expect(t).not.toBe(q.instructions);
    }
    expect(JEV_TOPIC_QUESTION_SET).not.toMatch(/^jev-q/);
  });

  it("states the contract's disposition and topic-sentiment semantics and includes the validated taxonomy", () => {
    const a = assigner(goldResponder);
    const body = a.assigner.buildTopicRequestBody("x", dataset.focus, taxonomy);
    const q = body.questions.topic;
    expect(Object.keys(q.criteria)).toEqual([...taxonomy.map((t) => `topic:${t.key}`), "other", "no_specific_topic"]);
    expect(q.criteria["topic:range"]).toBe(`${taxonomy[0]!.name}: ${taxonomy[0]!.definition}`);
    expect(q.criteria.other).toContain("the comment discusses something substantive that no taxonomy topic covers.");
    expect(q.instructions).toContain(TOPIC_ASSIGNMENT_SEMANTICS.vocabulary);
    expect(body.state.taxonomy).toEqual(taxonomy);
    const s = a.assigner.buildSentimentRequestBody("x", dataset.focus, taxonomy[1]!, dataset.schema.sentimentLabels);
    expect(s.state.topic).toEqual(taxonomy[1]);
    expect(Object.keys(s.questions.topic_sentiment.criteria)).toEqual(["positive", "neutral", "negative"]);
    expect(s.questions.topic_sentiment.instructions).toContain("It is not the comment's overall mood");
  });

  it("never sends classifier labels, overall sentiment, identity or engagement; comment text only in state", async () => {
    const a = assigner(goldResponder);
    const labelled = base.slice(0, 5).map((c) => ({ id: c.id, text: c.text, classification: { type: c.classification.type, sentiment: c.classification.sentiment, focusMentioned: true } }));
    await a.assigner.assignTopics(request(labelled));
    for (const call of a.calls) {
      expect(Object.keys(call.body.state).sort()).toEqual(JEV_TOPIC_KEYS.topic in call.body.questions ? ["comment", "focus_target", "taxonomy"] : ["comment", "focus_target", "topic"]);
      expect(JSON.stringify(call.body)).not.toMatch(/classification|focusMentioned|likes|author|"sentiment"/);
      for (const q of Object.values(call.body.questions)) expect(q.instructions).not.toContain(call.body.state.comment as string);
    }
    expect(JSON.stringify(a.calls)).not.toContain(labelled[0]!.id);
  });

  it("asks the sentiment step only for primary-topic comments, about exactly the assigned topic", async () => {
    const a = assigner(goldResponder);
    await a.assigner.assignTopics(request());
    const sentimentCalls = a.calls.filter((c) => JEV_TOPIC_KEYS.topicSentiment in c.body.questions);
    expect(a.calls.length - sentimentCalls.length).toBe(188);
    expect(sentimentCalls).toHaveLength(134);
    for (const c of sentimentCalls) {
      const id = byText.get(c.body.state.comment as string)!;
      expect((c.body.state.topic as { key: string }).key).toBe((gold.dispositions.get(id) as { topicKey: string }).topicKey);
    }
  });
});

describe("Jev topic assigner: mapping into the frozen assignment candidate", () => {
  it("maps gold answers to a fully valid candidate in request order, whatever the completion order", async () => {
    const a = assigner(goldResponder, { concurrency: 6 });
    const entries = await a.assigner.assignTopics(request());
    expect(entries.map((e) => (e as { commentId: string }).commentId)).toEqual(gold.baseIds);
    const result = validate(entries);
    expect(result.issues).toEqual([]);
    expect(result.assignments).toHaveLength(188);
  });

  it.each([
    ["an option outside the taxonomy", () => ({ json: { answers: { topic: { type: "choice", choice: "topic:battery_life" } } } }), "invalid_assignment"],
    ["an option that is no disposition", () => ({ json: { answers: { topic: { type: "choice", choice: "spam" } } } }), "invalid_assignment"],
    ["a malformed body", () => ({ text: "<html>gateway</html>" }), "missing_assignment"],
    ["a missing answer", () => ({ json: { answers: {} } }), "missing_assignment"],
    ["a persistent server error", () => ({ status: 503 }), "missing_assignment"],
    ["a network failure", () => "network" as const, "missing_assignment"],
  ])("%s fails validation instead of being repaired (%s)", async (_name, step1, code) => {
    const a = assigner((call, n) => (JEV_TOPIC_KEYS.topic in call.body.questions ? (step1() as ReturnType<Responder>) : goldResponder(call, n)));
    const one = [{ id: base[0]!.id, text: base[0]!.text }];
    const result = validate(await a.assigner.assignTopics(request(one)), [one[0]!.id]);
    expect(result.issues.map((i) => i.code)).toEqual([code]);
  });

  it("a topic sentiment outside the schema labels fails validation", async () => {
    const primary = base.find((c) => c.topic?.disposition === "primary_topic")!;
    const a = assigner((call, n) => (JEV_TOPIC_KEYS.topicSentiment in call.body.questions ? { json: { answers: { topic_sentiment: { type: "choice", choice: "mixed" } } } } : goldResponder(call, n)));
    const result = validate(await a.assigner.assignTopics(request([{ id: primary.id, text: primary.text }])), [primary.id]);
    expect(result.issues.map((i) => i.code)).toEqual(["invalid_assignment"]);
  });

  it("retries transient HTTP failures within one request (transport only), then succeeds", async () => {
    const a = assigner((call, n) => (n === 1 ? { status: 429, headers: { "retry-after": "0" } } : goldResponder(call, n)));
    const entries = await a.assigner.assignTopics(request([{ id: base[0]!.id, text: base[0]!.text }]));
    expect(validate(entries, [base[0]!.id]).issues).toEqual([]);
    expect(a.recorder.entries.map((e) => e.outcome)).toContain("provider_error");
  });

  it("configuration failures throw a provider-neutral error without the key or provider text", async () => {
    const a = assigner(() => ({ status: 401, text: "invalid key test-jev-key-not-real-7c1" }));
    const error = await a.assigner.assignTopics(request(base.slice(0, 2).map((c) => ({ id: c.id, text: c.text })))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TopicProviderError);
    expect(error).toMatchObject({ provider: "typesafe", failure: "configuration", status: 401 });
    expect(String(error)).not.toContain(KEY);
    expect(JSON.stringify(a.recorder.entries)).not.toContain(KEY);
  });
});

describe("batching", () => {
  it("splits deterministically into consecutive batches of at most N, preserving order", () => {
    const batches = BatchingTopicAssigner.batchesOf(gold.baseIds, 25);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 25, 25, 25, 25, 25, 13]);
    expect(batches.flat()).toEqual(gold.baseIds);
    expect(() => new BatchingTopicAssigner({ label: "x", assignTopics: async () => [] }, { maxCommentsPerBatch: 0 })).toThrow(RangeError);
  });

  it("calls the provider once per batch and concatenates entries in order", async () => {
    const a = assigner(goldResponder);
    const seen: number[] = [];
    const batching = new BatchingTopicAssigner(a.assigner, { maxCommentsPerBatch: 25, onBatch: (b) => seen.push(b.comments) });
    const entries = await batching.assignTopics(request());
    expect(seen).toEqual([25, 25, 25, 25, 25, 25, 25, 13]);
    expect(entries.map((e) => (e as { commentId: string }).commentId)).toEqual(gold.baseIds);
  });

  it("a transient batch failure leaves exactly that batch unassigned; configuration and invalid-output errors propagate", async () => {
    const failing = (error: Error): TopicAssigner => ({
      label: "flaky",
      assignTopics: async (r) => {
        if (r.comments[0]!.id === gold.baseIds[25]) throw error;
        return r.comments.map((c) => ({ commentId: c.id, disposition: "other" }));
      },
    });
    const entries = await new BatchingTopicAssigner(failing(new TopicProviderError("x", "unavailable", 503)), { maxCommentsPerBatch: 25 }).assignTopics(request());
    expect(entries.map((e) => (e as { commentId: string }).commentId)).toEqual([...gold.baseIds.slice(0, 25), ...gold.baseIds.slice(50)]);
    await expect(new BatchingTopicAssigner(failing(new TopicProviderError("x", "configuration", 401)), { maxCommentsPerBatch: 25 }).assignTopics(request())).rejects.toMatchObject({ failure: "configuration" });
    await expect(new BatchingTopicAssigner(failing(new TopicDiscoveryOutputError([{ code: "invalid_output" }])), { maxCommentsPerBatch: 25 }).assignTopics(request())).rejects.toBeInstanceOf(TopicDiscoveryOutputError);
  });

  it("all batches are one outer attempt; the outer retry reassigns only a failed batch's comments", async () => {
    let failOnce = true;
    const a = assigner((call, n) => {
      const id = byText.get(call.body.state.comment as string)!;
      if (failOnce && gold.baseIds.indexOf(id) >= 25 && gold.baseIds.indexOf(id) < 50) return { status: 500 };
      return goldResponder(call, n);
    }, { maxTransportRetries: 0 });
    const assignCalls: number[] = [];
    const batching = new BatchingTopicAssigner(a.assigner, { maxCommentsPerBatch: 25 });
    const counting: TopicAssigner = {
      label: batching.label,
      assignTopics: async (r) => {
        assignCalls.push(r.comments.length);
        const out = await batching.assignTopics(r);
        failOnce = false;
        return out;
      },
    };
    const discoverer = new TwoPhaseTopicDiscoverer({ generator: new ScriptedTaxonomyGenerator({ taxonomy, dispositions: gold.dispositions, members: gold.members, overallSentiment: gold.overallSentiment }), assigner: counting, sample: { seed: TOPIC_BENCHMARK_SEED } });
    const analysis = await analyzeTopics({ classified: classifiedCommentsOf(dataset), schema: dataset.schema, focus: dataset.focus }, { discoverer, params: TOPIC_BENCHMARK_PARAMETERS });
    expect(analysis.status).toBe("available");
    expect(analysis.method.attempts).toBe(2);
    expect(assignCalls).toEqual([188, 25]);
  });
});
