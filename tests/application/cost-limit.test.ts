import { describe, expect, it, vi } from "vitest";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { SyntheticCommentSource } from "../../src/adapters/fixtures/synthetic-comment-source";
import { analyzeVideoSync, type AnalyzeVideoDeps } from "../../src/application/analyze-video-sync";
import { ConcurrentClassifier, CostGuardedClassifier, CostGuardedTopicAssigner, CostGuardedTopicTransport } from "../../src/application/cost-guards";
import { COMMENT_SOURCE_FAILURES, CommentSourceError } from "../../src/core/analysis/comment-source-error";
import { CostBudget, CostLimitReachedError } from "../../src/core/cost/budget";
import type { AiCallRecord } from "../../src/core/cost/usage";
import { createCompliancePolicy } from "../../src/core/policy/compliance-policy";
import type { ClassificationRequest, Classifier, CommentSource, TopicDiscoverer } from "../../src/core/ports";
import { FIXTURE, VALID_URL } from "../helpers";

function call(cost: number | undefined): AiCallRecord {
  return { provider: "test", model: "m", promptVersion: "p", schemaVersion: "s", batchSize: 1, attempt: 1, outcome: "ok", latencyMs: 1, timestamp: "2026-10-07T00:00:00Z", ...(cost === undefined ? {} : { estimatedCostUsd: cost }) };
}

/** Classifies with the fake keyword classifier and records `costPerCall` into the budget, like a real adapter. */
function costlyClassifier(budget: CostBudget, costPerCall: number): Classifier & { calls: number } {
  const inner = new FakeClassifier();
  const c = {
    label: "costly",
    calls: 0,
    async classify(request: ClassificationRequest) {
      c.calls += 1;
      budget.record(call(costPerCall));
      return inner.classify(request);
    },
  };
  return c;
}

const demoDeps = (overrides: Partial<AnalyzeVideoDeps> = {}): AnalyzeVideoDeps => ({
  source: new SyntheticCommentSource(),
  classifier: new FakeClassifier(),
  policy: createCompliancePolicy(),
  ...overrides,
});

describe("CostBudget", () => {
  it("allows reservations within the limit and adds recorded costs", () => {
    const budget = new CostBudget(1);
    const release = budget.reserve(0.6);
    budget.record(call(0.25));
    release();
    expect(budget.spentUsd()).toBeCloseTo(0.25);
    expect(budget.reached()).toBe(false);
    expect(() => budget.reserve(0.75)).not.toThrow();
  });

  it("counts calls still in flight against the limit", () => {
    const budget = new CostBudget(1);
    budget.reserve(0.6);
    expect(() => budget.reserve(0.5)).toThrow(CostLimitReachedError);
    expect(budget.reached()).toBe(true);
  });

  it("stays reached: later reservations are refused even if they would fit", () => {
    const budget = new CostBudget(1);
    expect(() => budget.reserve(2)).toThrow(CostLimitReachedError);
    expect(() => budget.reserve(0.01)).toThrow(CostLimitReachedError);
  });

  it("stops when recorded spend passes the limit", () => {
    const budget = new CostBudget(0.5);
    budget.record(call(0.4));
    expect(budget.reached()).toBe(false);
    budget.record(call(0.2));
    expect(budget.reached()).toBe(true);
  });

  it("fails closed on a call without a cost estimate or an unbounded reservation", () => {
    const unknown = new CostBudget(1);
    unknown.record(call(undefined));
    expect(unknown.reached()).toBe(true);
    const nan = new CostBudget(1);
    expect(() => nan.reserve(Number.NaN)).toThrow(CostLimitReachedError);
  });

  it("rejects a non-positive limit", () => {
    expect(() => new CostBudget(0)).toThrow(RangeError);
  });
});

describe("cost guards", () => {
  it("refuse before calling the provider when the reservation does not fit", async () => {
    const budget = new CostBudget(0.1);
    const inner = { label: "x", classify: vi.fn(async () => ({ results: [] })) };
    const guarded = new CostGuardedClassifier(inner, budget, () => 0.2);
    await expect(guarded.classify({ comments: [], schema: {} as never })).rejects.toBeInstanceOf(CostLimitReachedError);
    expect(inner.classify).not.toHaveBeenCalled();
  });

  it("release the reservation when the provider call fails", async () => {
    const budget = new CostBudget(1);
    const transport = new CostGuardedTopicTransport({ label: "t", complete: async () => Promise.reject(new Error("boom")) }, budget, () => 0.9);
    await expect(transport.complete({} as never)).rejects.toThrow("boom");
    expect(() => budget.reserve(0.9)).not.toThrow();
  });

  it("guard topic assignment per request", async () => {
    const budget = new CostBudget(1);
    const assign = vi.fn(async () => []);
    const assigner = new CostGuardedTopicAssigner({ label: "a", assignTopics: assign }, budget, (req) => req.comments.length * 0.5);
    await assigner.assignTopics({ comments: [{ id: "1", text: "" }], taxonomy: [], context: {} as never });
    await expect(assigner.assignTopics({ comments: [{ id: "1", text: "" }, { id: "2", text: "" }, { id: "3", text: "" }], taxonomy: [], context: {} as never })).rejects.toBeInstanceOf(CostLimitReachedError);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("ConcurrentClassifier", () => {
  it("classifies slices concurrently and concatenates results in request order", async () => {
    const seen: string[][] = [];
    const inner: Classifier = {
      label: "inner",
      classify: async (req) => {
        seen.push(req.comments.map((c) => c.id));
        return { results: req.comments.map((c) => ({ commentId: c.id })) };
      },
    };
    const comments = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: "t" }));
    const out = (await new ConcurrentClassifier(inner, 3).classify({ comments, schema: {} as never })) as { results: { commentId: string }[] };
    expect(seen).toHaveLength(3);
    expect(out.results.map((r) => r.commentId)).toEqual(comments.map((c) => c.id));
  });

  it("drops a slice with malformed output and rethrows a slice error after all slices settle", async () => {
    let settled = 0;
    const malformed: Classifier = { label: "m", classify: async (req) => (req.comments[0]!.id === "c0" ? "garbage" : { results: [{ commentId: req.comments[0]!.id }] }) };
    expect(await new ConcurrentClassifier(malformed, 2).classify({ comments: [{ id: "c0", text: "" }, { id: "c1", text: "" }], schema: {} as never })).toEqual({ results: [{ commentId: "c1" }] });

    const failing: Classifier = {
      label: "f",
      classify: async (req) => {
        if (req.comments[0]!.id === "c0") throw new CostLimitReachedError(1, 1);
        await new Promise((r) => setTimeout(r, 5));
        settled += 1;
        return { results: [] };
      },
    };
    await expect(new ConcurrentClassifier(failing, 2).classify({ comments: [{ id: "c0", text: "" }, { id: "c1", text: "" }], schema: {} as never })).rejects.toBeInstanceOf(CostLimitReachedError);
    expect(settled).toBe(1);
  });
});

describe("analyzeVideoSync with a cost cap", () => {
  it("stops during classification and returns cost_limit_reached instead of continuing", async () => {
    const budget = new CostBudget(1);
    const costly = costlyClassifier(budget, 0.4);
    const classifier = new ConcurrentClassifier(new CostGuardedClassifier(costly, budget, () => 0.4), 4);
    const result = await analyzeVideoSync({ url: VALID_URL }, demoDeps({ classifier, costLimit: budget }));
    expect(result).toMatchObject({ status: "cost_limit_reached", limitUsd: 1 });
    if (result.status !== "cost_limit_reached") throw new Error("unreachable");
    expect(result.spentUsd).toBeCloseTo(0.4);
    expect(result.message).toContain("cost limit reached");
    // The first slice recorded $0.40 while its $0.40 reservation was still held, so the second reservation
    // ($0.40 + $0.40 + $0.40 > $1) was refused (conservative): no further provider call was made.
    expect(costly.calls).toBe(1);
  });

  it("does not turn a cost stop during topics into a partial report", async () => {
    const budget = new CostBudget(1);
    let topicCalls = 0;
    const discoverer: TopicDiscoverer = {
      label: "costly topics",
      discoverTopics: async () => {
        topicCalls += 1;
        budget.reserve(5);
        return { topics: [], assignments: [] };
      },
    };
    const result = await analyzeVideoSync({ url: VALID_URL }, demoDeps({ topics: { discoverer }, costLimit: budget }));
    expect(result.status).toBe("cost_limit_reached");
    expect(topicCalls).toBeLessThanOrEqual(2);
  });

  it("returns the report when the analysis stays within the cap", async () => {
    const budget = new CostBudget(1);
    const classifier = new CostGuardedClassifier(costlyClassifier(budget, 0.1), budget, () => 0.2);
    const result = await analyzeVideoSync({ url: VALID_URL }, demoDeps({ classifier, costLimit: budget }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.report.commentsAnalysed).toBe(FIXTURE.comments.length);
  });
});

describe("analyzeVideoSync with a failing comment source", () => {
  it.each(COMMENT_SOURCE_FAILURES)("%s → source_unavailable with a fixed message", async (reason) => {
    const source: CommentSource = { label: "failing", origin: "synthetic_fixture", listComments: async () => Promise.reject(new CommentSourceError(reason, 403)) };
    const classifier = { label: "never", classify: vi.fn() };
    const result = await analyzeVideoSync({ url: VALID_URL }, demoDeps({ source, classifier }));
    expect(result).toMatchObject({ status: "source_unavailable", reason });
    if (result.status === "source_unavailable") expect(result.message.length).toBeGreaterThan(10);
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
