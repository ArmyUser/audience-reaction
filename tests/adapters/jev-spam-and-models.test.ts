import { describe, expect, it, vi } from "vitest";
import { JevClassifier } from "../../src/adapters/ai/typesafe/jev-classifier";
import { extractModelNames, JevModelsError, listJevModels } from "../../src/adapters/ai/typesafe/jev-models";
import { JEV_QUESTION_SET_VERSION } from "../../src/adapters/ai/typesafe/jev-questions";
import { runClassifierBenchmark } from "../../src/benchmark/classifier-benchmark";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import { classifyComments } from "../../src/core/classification/classify-comments";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { InMemoryUsageRecorder } from "../../src/core/cost/usage";
import type { SpamAdjustment } from "../../src/core/classification/spam-invariant";
import type { CommentInput } from "../../src/core/domain/types";
import { FIXTURE, FOCUS, goldDeps, VIDEO_ID } from "../helpers";
import { choice, goldJevResponder, JEV_PRICES, jevResponse, mockJevFetch, noul, TEST_JEV_KEY, type JevResponder } from "./jev-mock";

const schema = createClassificationSchema({ focusConfigured: true });
const one: CommentInput[] = [{ id: "c1", text: "Subscribe to my channel!!!" }];

function jev(responder: JevResponder) {
  const { fetch, calls } = mockJevFetch(responder);
  const adjustments: { commentId: string; adjusted: SpamAdjustment[] }[] = [];
  const classifier = new JevClassifier({
    apiKey: TEST_JEV_KEY,
    questionSet: "jev-q1",
    prices: JEV_PRICES,
    fetch,
    sleep: async () => {},
    onSpamInvariantApplied: (commentId, adjusted) => adjustments.push({ commentId, adjusted }),
  });
  return { classifier, calls, adjustments };
}

function spamAnswers(overrides: Record<string, unknown> = {}): JevResponder {
  return () =>
    jevResponse({
      type: choice("spam_irrelevant"),
      sentiment: choice("positive"),
      is_question: noul(0.02),
      is_request: noul(0.03),
      target_creator: choice("not_addressed"),
      target_content: choice("not_addressed"),
      target_focus: choice("not_addressed"),
      ...overrides,
    });
}

const SPAM_RESULT = { isQuestion: false, isRequest: false, targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" } };

describe("Jev spam invariant", () => {
  it("passes internally consistent spam through unchanged", async () => {
    const { classifier, adjustments } = jev(spamAnswers());
    const raw = (await classifier.classify({ comments: one, schema, focus: FOCUS })) as { results: unknown[] };
    expect(raw.results[0]).toEqual({ commentId: "c1", type: "spam_irrelevant", sentiment: "positive", ...SPAM_RESULT });
    expect(adjustments).toEqual([]);
  });

  it("normalizes contradictory question/request answers, keeps type and sentiment, and exposes the originals", async () => {
    const { classifier, adjustments } = jev(spamAnswers({ is_question: noul(0.9), is_request: noul(0.8) }));
    const raw = (await classifier.classify({ comments: one, schema, focus: FOCUS })) as { results: unknown[] };
    expect(raw.results[0]).toEqual({ commentId: "c1", type: "spam_irrelevant", sentiment: "positive", ...SPAM_RESULT });
    expect(adjustments).toEqual([{ commentId: "c1", adjusted: [{ field: "isQuestion", original: true }, { field: "isRequest", original: true }] }]);
  });

  it("normalizes contradictory target answers and exposes the originals", async () => {
    const { classifier, adjustments } = jev(spamAnswers({ target_creator: choice("negative"), target_focus: choice("positive") }));
    const raw = (await classifier.classify({ comments: one, schema, focus: FOCUS })) as { results: unknown[] };
    expect(raw.results[0]).toMatchObject(SPAM_RESULT);
    expect(adjustments[0]!.adjusted).toEqual([{ field: "targets.creator", original: "negative" }, { field: "targets.focus", original: "positive" }]);
  });

  it("is not a provider failure: no retry, one request, valid for the engine", async () => {
    const { classifier, calls } = jev(spamAnswers({ is_request: noul(0.99), target_content: choice("neutral") }));
    const result = await classifyComments(one, classifier, schema, FOCUS, { retryRounds: 2 });
    expect(calls).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.classifications[0]).toMatchObject({ type: "spam_irrelevant", ...SPAM_RESULT });
  });

  it("leaves non-spam comments unaffected", async () => {
    const { classifier, adjustments } = jev(
      spamAnswers({ type: choice("opinion"), is_question: noul(0.9), is_request: noul(0.9), target_creator: choice("negative") }),
    );
    const raw = (await classifier.classify({ comments: one, schema, focus: FOCUS })) as { results: unknown[] };
    expect(raw.results[0]).toMatchObject({ type: "opinion", isQuestion: true, isRequest: true, targets: { creator: "negative" } });
    expect(adjustments).toEqual([]);
  });

  it("a full 60-comment analysis no longer fails when Jev contradicts spam-dependent fields", async () => {
    const gold = goldJevResponder();
    const spamIds = new Set(FIXTURE.comments.filter((c) => c.gold.type === "spam_irrelevant").map((c) => c.text));
    expect(spamIds.size).toBe(4);
    // For every spam comment, Jev answers the dependent questions in contradiction with its own type answer.
    const contradictory: JevResponder = (call, i) =>
      spamIds.has(call.body.state.comment)
        ? spamAnswers({ sentiment: choice("neutral"), is_question: noul(0.7), target_content: choice("neutral"), target_creator: choice("positive") })(call, i)
        : gold(call, i);
    const { classifier, adjustments } = jev(contradictory);
    const viaJev = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps({ classifier }));
    const viaGold = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    if (viaJev.status !== "completed" || viaGold.status !== "completed") throw new Error("expected completed");
    expect(viaJev.report.metrics.classificationFailures).toBe(0);
    expect(viaJev.report.metrics).toEqual(viaGold.report.metrics);
    expect(adjustments).toHaveLength(4);
  });
});

describe("Jev spam invariant in benchmark records", () => {
  it("records adjustments on classified comments, distinguishable from provider failures", async () => {
    const gold = goldJevResponder();
    const spamTexts = new Set(FIXTURE.comments.filter((c) => c.gold.type === "spam_irrelevant").map((c) => c.text));
    const brokenText = FIXTURE.comments.find((c) => c.id === "m2-c01")!.text;
    const responder: JevResponder = (call, i) =>
      spamTexts.has(call.body.state.comment)
        ? spamAnswers({ sentiment: choice("neutral"), is_question: noul(0.7), target_creator: choice("positive") })(call, i)
        : call.body.state.comment === brokenText
          ? new Response("not json", { status: 200 })
          : gold(call, i);
    const report = await runClassifierBenchmark(
      { name: "m2-synthetic", version: "sha256:test", focus: FOCUS, comments: FIXTURE.comments },
      () => {
        // Same wiring as the benchmark CLI's Jev subject.
        const { fetch } = mockJevFetch(responder);
        const recorder = new InMemoryUsageRecorder();
        const adjustments = new Map<string, SpamAdjustment[]>();
        const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, questionSet: "jev-q1", prices: JEV_PRICES, recorder, fetch, sleep: async () => {}, onSpamInvariantApplied: (id, a) => adjustments.set(id, a) });
        return { classifier, provider: "typesafe", model: "jev-latest", promptVersion: JEV_QUESTION_SET_VERSION, batchSize: 1, usage: () => recorder.entries, spamInvariantAdjustments: () => adjustments };
      },
      { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 },
    );
    const run = report.runs[0]!;
    const adjusted = run.comments.filter((c) => c.spamInvariantAdjustments);
    expect(adjusted).toHaveLength(4);
    for (const record of adjusted) {
      expect(record.status).toBe("correct");
      expect(record.predicted).toMatchObject({ type: "spam_irrelevant", isQuestion: false, targets: { creator: "not_addressed" } });
      expect(record.spamInvariantAdjustments).toEqual([{ field: "isQuestion", original: true }, { field: "targets.creator", original: "positive" }]);
      expect(record.failureIssues).toBeUndefined();
    }
    const failed = run.comments.find((c) => c.commentId === "m2-c01")!;
    expect(failed).toMatchObject({ status: "failed", predicted: null });
    expect(failed.spamInvariantAdjustments).toBeUndefined();
    expect(run.errorSummary).toMatchObject({ spamInvariantAdjustedComments: 4, failedComments: 1, perfectComments: 59, commentsWithErrors: 0 });
  });
});

describe("Jev models preflight", () => {
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("calls GET /v1/models with Bearer auth and never the inference endpoint", async () => {
    const fetchSpy = vi.fn(ok({ data: [{ id: "jev-1.13.0" }, { id: "jev-latest" }] }));
    expect(await listJevModels({ apiKey: TEST_JEV_KEY, fetch: fetchSpy as unknown as typeof fetch })).toEqual(["jev-1.13.0", "jev-latest"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/models");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TEST_JEV_KEY}`);
    expect(init.body).toBeUndefined();
  });

  it.each<[string, unknown, string[] | undefined]>([
    ["{ data: [{ id }] }", { data: [{ id: "jev-1.13.0" }] }, ["jev-1.13.0"]],
    ["{ models: [{ name }] }", { models: [{ name: "jev-latest" }] }, ["jev-latest"]],
    ["bare array of strings", ["jev-preview"], ["jev-preview"]],
    ["unrecognised object", { result: "ok" }, undefined],
    ["items without names", { data: [{ owner: "typesafe" }] }, undefined],
  ])("reads model names from %s without guessing", (_name, payload, expected) => {
    expect(extractModelNames(payload)).toEqual(expected);
  });

  it("does not report a model the API did not list", async () => {
    const names = await listJevModels({ apiKey: TEST_JEV_KEY, fetch: ok({ data: [{ id: "jev-latest" }] }) as unknown as typeof fetch });
    expect(names).not.toContain("jev-1.13.0");
  });

  it.each<[string, () => Promise<Response>, RegExp]>([
    ["401", async () => new Response("", { status: 401 }), /rejected the credentials \(HTTP 401\)/],
    ["500", async () => new Response("", { status: 500 }), /failed with HTTP 500/],
    ["non-JSON", async () => new Response("<html>", { status: 200 }), /not JSON/],
    ["unrecognised shape", ok({ hello: "world" }), /unrecognised shape/],
    ["network error", async () => { throw new TypeError("fetch failed"); }, /could not connect/],
  ])("fails clearly on %s", async (_name, impl, message) => {
    await expect(listJevModels({ apiKey: TEST_JEV_KEY, fetch: impl as unknown as typeof fetch })).rejects.toThrow(message);
    await expect(listJevModels({ apiKey: TEST_JEV_KEY, fetch: impl as unknown as typeof fetch })).rejects.toBeInstanceOf(JevModelsError);
  });

  it("fails clearly on timeout", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    await expect(listJevModels({ apiKey: TEST_JEV_KEY, fetch: hang, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  it("never includes the API key in error messages", async () => {
    await expect(listJevModels({ apiKey: TEST_JEV_KEY, fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch })).rejects.not.toThrow(TEST_JEV_KEY);
  });
});
