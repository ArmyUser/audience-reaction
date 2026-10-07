import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL, JevClassifier, JevConfigurationError } from "../../src/adapters/ai/typesafe/jev-classifier";
import { buildJevQuestions, buildJevState, JEV_QUESTION_SET_VERSION } from "../../src/adapters/ai/typesafe/jev-questions";
import { runClassifierBenchmark } from "../../src/benchmark/classifier-benchmark";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import { classifyComments } from "../../src/core/classification/classify-comments";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { InMemoryUsageRecorder } from "../../src/core/cost/usage";
import { COMMENT_TYPES, type CommentInput } from "../../src/core/domain/types";
import { FIXTURE, FOCUS, goldDeps, VIDEO_ID } from "../helpers";
import { choice, goldJevResponder, JEV_PRICES, jevResponse, mockJevFetch, noul, TEST_JEV_KEY, type JevResponder } from "./jev-mock";

const schema = createClassificationSchema({ focusConfigured: true });
const noFocusSchema = createClassificationSchema({ focusConfigured: false });
const mixedSchema = createClassificationSchema({ focusConfigured: true, mixedEnabled: true });
const all: CommentInput[] = FIXTURE.comments.map((c) => ({ id: c.id, text: c.text }));
const one: CommentInput[] = [{ id: "c1", text: "anything" }];

function jev(responder: JevResponder, opts: { maxRetries?: number; timeoutMs?: number; noulThreshold?: number } = {}) {
  const { fetch, calls } = mockJevFetch(responder);
  const recorder = new InMemoryUsageRecorder();
  const sleep = vi.fn(async () => {});
  const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, questionSet: "jev-q1", prices: JEV_PRICES, recorder, fetch, sleep, maxRetries: opts.maxRetries ?? 2, timeoutMs: opts.timeoutMs ?? 5_000, ...(opts.noulThreshold !== undefined ? { noulThreshold: opts.noulThreshold } : {}) });
  return { classifier, calls, recorder, sleep };
}

/** Responder returning a fixed, complete answer set (overridable per key). */
function fixed(overrides: Record<string, unknown> = {}): JevResponder {
  return (call) =>
    jevResponse({
      type: choice("opinion"),
      sentiment: choice("negative"),
      is_question: noul(0.1),
      is_request: noul(0.1),
      target_creator: choice("not_addressed"),
      target_content: choice("negative"),
      ...("target_focus" in call.body.questions ? { target_focus: choice("not_addressed") } : {}),
      ...overrides,
    });
}

async function single(responder: JevResponder, s = schema, opts = {}) {
  const { classifier } = jev(responder, opts);
  return (await classifier.classify({ comments: one, schema: s, focus: FOCUS })) as { results: Record<string, unknown>[] };
}

describe("Jev question schema (mapping from the domain schema)", () => {
  const q = buildJevQuestions(schema);

  it("asks exactly the seven questions, with focus only when configured", () => {
    expect(Object.keys(q).sort()).toEqual(["is_question", "is_request", "sentiment", "target_content", "target_creator", "target_focus", "type"]);
    expect(Object.keys(buildJevQuestions(noFocusSchema))).not.toContain("target_focus");
  });

  it("maps type to a Choice over exactly the existing taxonomy (no added fallback)", () => {
    expect(q.type).toMatchObject({ type: "choice" });
    expect(Object.keys((q.type as { criteria: object }).criteria)).toEqual([...COMMENT_TYPES]);
  });

  it("maps overall sentiment to a Choice over exactly the schema labels", () => {
    expect(Object.keys((q.sentiment as { criteria: object }).criteria)).toEqual(["positive", "neutral", "negative"]);
    expect(Object.keys((buildJevQuestions(mixedSchema).sentiment as { criteria: object }).criteria)).toEqual(["positive", "neutral", "negative", "mixed"]);
  });

  it("maps each target to a Choice over not_addressed + sentiment labels", () => {
    for (const key of ["target_creator", "target_content", "target_focus"]) {
      expect(q[key]).toMatchObject({ type: "choice" });
      expect(Object.keys((q[key] as { criteria: object }).criteria)).toEqual(["not_addressed", "positive", "neutral", "negative"]);
    }
  });

  it("maps is_question / is_request to Noul statements without criteria", () => {
    expect(q.is_question).toEqual({ type: "noul", instructions: expect.stringContaining("asks a genuine question") });
    expect(q.is_request).toEqual({ type: "noul", instructions: expect.stringContaining("asks the creator or brand to do something") });
  });

  it("keeps comment text and focus target out of the instructions; they live in state", async () => {
    // The question set is identical for every comment: only state varies between requests.
    const { classifier, calls } = jev(goldJevResponder());
    await classifier.classify({ comments: all, schema, focus: FOCUS });
    expect(calls).toHaveLength(60);
    const first = JSON.stringify(calls[0]!.body.questions);
    expect(calls.every((c) => JSON.stringify(c.body.questions) === first)).toBe(true);
    expect(first).toBe(JSON.stringify(q));
    expect(first).not.toContain("Acme");
    expect(buildJevState({ id: "x", text: "hello" }, FOCUS)).toEqual({ comment: "hello", focus_target: { name: "Acme VPN", aliases: ["Acme"], is_video_sponsor: true } });
    expect(buildJevState({ id: "x", text: "hello" }, { name: "B", aliases: [] })).toEqual({ comment: "hello", focus_target: { name: "B", aliases: [], is_video_sponsor: null } });
    expect(buildJevState({ id: "x", text: "hello" }, { name: "B", aliases: [], isVideoSponsor: false }).focus_target).toMatchObject({ is_video_sponsor: false });
    expect(buildJevState({ id: "x", text: "hello" }, undefined).focus_target).toBeNull();
  });

  it("keeps the sponsor-reference rule conditional on is_video_sponsor", () => {
    expect((q.target_focus as { instructions: string }).instructions).toContain("Apply the following rule ONLY when focus_target.is_video_sponsor is true");
  });
});

describe("Jev requests and batching", () => {
  it("sends one default-model request per comment, each with that comment alone in state", async () => {
    const { classifier, calls } = jev(goldJevResponder());
    const raw = (await classifier.classify({ comments: all.slice(0, 3), schema, focus: FOCUS })) as { results: { commentId: string }[] };
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.body.state.comment)).toEqual(all.slice(0, 3).map((c) => c.text));
    expect(calls.every((c) => c.url === "https://api.typesafe.ai/v1/systemone")).toBe(true);
    expect(calls.every((c) => c.body.model === DEFAULT_JEV_MODEL && DEFAULT_JEV_MODEL === "jev-latest")).toBe(true);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_JEV_KEY}`);
    expect(raw.results.map((r) => r.commentId)).toEqual(["m2-c01", "m2-c02", "m2-c03"]);
  });

  it("honours an explicit model override (jev-preview) in every request and usage record", async () => {
    const { fetch, calls } = mockJevFetch(goldJevResponder());
    const recorder = new InMemoryUsageRecorder();
    const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, questionSet: "jev-q1", model: "jev-preview", prices: JEV_PRICES, recorder, fetch, sleep: async () => {} });
    await classifier.classify({ comments: all.slice(0, 2), schema, focus: FOCUS });
    expect(calls.map((c) => c.body.model)).toEqual(["jev-preview", "jev-preview"]);
    expect(recorder.entries.every((e) => e.model === "jev-preview" && e.estimatedCostUsd !== undefined)).toBe(true);
  });

  it("ships a configured price for the default model and the jev-preview override", () => {
    const { prices } = JSON.parse(readFileSync("config/model-prices.json", "utf8")) as { prices: Record<string, unknown> };
    expect(prices).toHaveProperty([DEFAULT_JEV_MODEL]);
    expect(prices).toHaveProperty(["jev-preview"]);
    expect(prices).not.toHaveProperty(["jev-1.13.0"]);
  });

  it("never puts the API key in the body or usage records", async () => {
    const { classifier, calls, recorder } = jev(goldJevResponder());
    await classifier.classify({ comments: all.slice(0, 2), schema, focus: FOCUS });
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(TEST_JEV_KEY);
    expect(JSON.stringify(recorder.entries)).not.toContain(TEST_JEV_KEY);
  });
});

describe("Jev answer mapping", () => {
  it.each(COMMENT_TYPES)("maps type choice %s", async (type) => {
    expect((await single(fixed({ type: choice(type) }))).results[0]).toMatchObject({ type });
  });

  it.each(["positive", "neutral", "negative"])("maps sentiment choice %s", async (sentiment) => {
    expect((await single(fixed({ sentiment: choice(sentiment) }))).results[0]).toMatchObject({ sentiment });
  });

  it("maps mixed only when the schema enables it", async () => {
    expect((await single(fixed({ sentiment: choice("mixed") }), mixedSchema)).results[0]).toMatchObject({ sentiment: "mixed" });
    expect((await single(fixed({ sentiment: choice("mixed") }), schema)).results).toEqual([]);
  });

  it.each(["target_creator", "target_content", "target_focus"])("maps every option of %s, including not_addressed", async (key) => {
    const field = key.replace("target_", "");
    for (const option of ["not_addressed", "positive", "neutral", "negative"]) {
      const r = (await single(fixed({ [key]: choice(option) }))).results[0] as { targets: Record<string, string> };
      expect(r.targets[field]).toBe(option);
    }
  });

  it.each(["is_question", "is_request"])("maps Noul %s by the 0.5 threshold", async (key) => {
    const field = key === "is_question" ? "isQuestion" : "isRequest";
    expect((await single(fixed({ [key]: noul(0.49) }))).results[0]).toMatchObject({ [field]: false });
    expect((await single(fixed({ [key]: noul(0.5) }))).results[0]).toMatchObject({ [field]: true });
    expect((await single(fixed({ [key]: noul(0.97) }))).results[0]).toMatchObject({ [field]: true });
  });

  it("respects a configured Noul threshold", async () => {
    expect((await single(fixed({ is_question: noul(0.6) }), schema, { noulThreshold: 0.7 })).results[0]).toMatchObject({ isQuestion: false });
  });

  it("produces exactly the provider-neutral result shape (no Jev metadata leaks into it)", async () => {
    expect((await single(fixed())).results[0]).toEqual({
      commentId: "c1",
      type: "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment: "negative",
      targets: { creator: "not_addressed", content: "negative", focus: "not_addressed" },
    });
    const noFocus = (await single(fixed(), noFocusSchema)).results[0] as { targets: object };
    expect(noFocus.targets).toEqual({ creator: "not_addressed", content: "negative" });
  });
});

describe("Jev malformed or unknown responses (comment dropped, never defaulted)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["unknown choice key", { type: choice("praise") }],
    ["unknown target option", { target_creator: choice("loves") }],
    ["missing answer", { is_request: undefined }],
    ["Noul probability out of range", { is_question: noul(1.4) }],
    ["Noul answer for a Choice question", { sentiment: noul(0.9) }],
    ["Choice answer for a Noul question", { is_question: choice("yes") }],
  ])("%s", async (_name, overrides) => {
    const responder: JevResponder = (call) => {
      const r = fixed(overrides)(call, 0) as Response;
      return r;
    };
    expect((await single(responder)).results).toEqual([]);
  });

  it.each<[string, () => Response]>([
    ["non-JSON body", () => new Response("<html>oops</html>", { status: 200 })],
    ["response without answers", () => new Response(JSON.stringify({ model: "jev-latest" }), { status: 200 })],
  ])("%s", async (_name, response) => {
    const { classifier, recorder } = jev(() => response());
    expect(((await classifier.classify({ comments: one, schema, focus: FOCUS })) as { results: unknown[] }).results).toEqual([]);
    expect(recorder.entries[0]!.outcome).toBe("malformed_output");
  });

  it("the engine surfaces dropped comments as failures, not neutral labels", async () => {
    const { classifier } = jev(fixed({ type: choice("praise") }));
    const result = await classifyComments(all.slice(0, 2), classifier, schema, FOCUS, { retryRounds: 1 });
    expect(result.classifications).toEqual([]);
    expect(result.failures.map((f) => f.commentId)).toEqual(["m2-c01", "m2-c02"]);
  });
});

describe("Jev transport errors and retries", () => {
  it("retries 429 honoring retry-after, then succeeds", async () => {
    const gold = goldJevResponder();
    const { classifier, calls, sleep, recorder } = jev((call, i) => (i === 0 ? jevResponse({}, 429, { "retry-after": "2" }) : gold(call, i)));
    const raw = (await classifier.classify({ comments: all.slice(0, 1), schema, focus: FOCUS })) as { results: unknown[] };
    expect(calls).toHaveLength(2);
    expect(raw.results).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(recorder.entries.map((e) => [e.outcome, e.errorType ?? null])).toEqual([["provider_error", "HTTP429"], ["ok", null]]);
  });

  it.each([529, 500, 503])("gives up on persistent HTTP %i after bounded retries and continues with other comments", async (status) => {
    const gold = goldJevResponder();
    const { classifier, calls } = jev((call) => (call.body.state.comment === all[0]!.text ? jevResponse({}, status) : gold(call, 0)), { maxRetries: 2 });
    const result = await classifyComments(all.slice(0, 2), classifier, schema, FOCUS, { retryRounds: 0 });
    expect(calls.filter((c) => c.body.state.comment === all[0]!.text)).toHaveLength(3);
    expect(result.failures.map((f) => f.commentId)).toEqual(["m2-c01"]);
    expect(result.classifications.map((c) => c.commentId)).toEqual(["m2-c02"]);
  });

  it("retries network errors and timeouts", async () => {
    const gold = goldJevResponder();
    let n = 0;
    const { classifier, recorder } = jev(
      (call, i) => {
        n += 1;
        if (n === 1) throw new TypeError("fetch failed");
        if (n === 2) return new Promise<Response>(() => {}); // hangs → timeout
        return gold(call, i);
      },
      { timeoutMs: 30 },
    );
    const raw = (await classifier.classify({ comments: all.slice(0, 1), schema, focus: FOCUS })) as { results: unknown[] };
    expect(raw.results).toHaveLength(1);
    expect(recorder.entries.map((e) => e.errorType ?? e.outcome)).toEqual(["TypeError", "AbortError", "ok"]);
  });

  it.each([401, 422])("fails fast on HTTP %i (configuration error)", async (status) => {
    const { classifier, calls } = jev(() => jevResponse({}, status));
    await expect(classifier.classify({ comments: one, schema, focus: FOCUS })).rejects.toBeInstanceOf(JevConfigurationError);
    expect(calls).toHaveLength(1);
  });
});

describe("Jev usage and cost records", () => {
  it("records provider, model, model version, tokens, cost, latency and batch size per request", async () => {
    const { classifier, recorder } = jev(goldJevResponder());
    await classifier.classify({ comments: all.slice(0, 2), schema, focus: FOCUS });
    expect(recorder.entries).toHaveLength(2);
    expect(recorder.entries[0]).toMatchObject({
      provider: "typesafe",
      model: "jev-latest",
      modelVersion: "jev-latest",
      promptVersion: JEV_QUESTION_SET_VERSION,
      schemaVersion: schema.version,
      batchSize: 1,
      attempt: 1,
      outcome: "ok",
      inputTokens: 900,
      outputTokens: 60,
    });
    expect(recorder.entries[0]!.estimatedCostUsd).toBeCloseTo((900 * 0.042) / 1_000_000, 12);
  });
});

describe("Jev through the unchanged engine and benchmark harness", () => {
  it("yields the same deterministic aggregation as the gold fake when Jev returns the gold labels", async () => {
    const { classifier } = jev(goldJevResponder());
    const viaJev = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps({ classifier }));
    const viaGold = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    if (viaJev.status !== "completed" || viaGold.status !== "completed") throw new Error("expected completed");
    expect(viaJev.report.metrics).toEqual(viaGold.report.metrics);
    expect(viaJev.report.methodology.classifierLabel).toContain("jev-latest");
  });

  it("runs the existing 60-comment benchmark harness without changes", async () => {
    const report = await runClassifierBenchmark(
      { name: "m2-synthetic", version: "sha256:test", focus: FOCUS, comments: FIXTURE.comments },
      () => {
        const { classifier, recorder } = jev(goldJevResponder());
        return { classifier, provider: "typesafe", model: "jev-latest", promptVersion: JEV_QUESTION_SET_VERSION, batchSize: 1, usage: () => recorder.entries };
      },
      { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 },
    );
    expect(report.runs[0]!.classified).toBe(60);
    expect(report.runs[0]!.tasks.every((t) => t.accuracy === 1)).toBe(true);
    expect(report.usageTotal.requests).toBe(60);
    expect(report.meta).toMatchObject({ provider: "typesafe", model: "jev-latest", modelVersions: ["jev-latest"], promptVersion: "jev-q1" });
  });
});
