import { describe, expect, it } from "vitest";
import { agreementRate, evaluateTask } from "../../src/core/metrics/classification-eval";
import type { CommentClassification } from "../../src/core/domain/types";
import { estimateCostUsd, summarizeUsage, type AiCallRecord } from "../../src/core/cost/usage";

describe("evaluateTask", () => {
  // gold: pos pos neg neu ; predicted: pos neg neg neu
  const pairs = [
    { gold: "positive", predicted: "positive" },
    { gold: "positive", predicted: "negative" },
    { gold: "negative", predicted: "negative" },
    { gold: "neutral", predicted: "neutral" },
  ];
  const m = evaluateTask("sentiment", pairs);

  it("computes accuracy", () => {
    expect([m.n, m.correct, m.accuracy]).toEqual([4, 3, 0.75]);
  });

  it("computes per-class precision, recall and F1 by hand", () => {
    const by = Object.fromEntries(m.perClass.map((c) => [c.label, c]));
    expect(by.positive).toMatchObject({ support: 2, predicted: 1, precision: 1, recall: 0.5 });
    expect(by.positive!.f1).toBeCloseTo(2 / 3, 10);
    expect(by.negative).toMatchObject({ support: 1, predicted: 2, precision: 0.5, recall: 1 });
    expect(by.neutral).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(m.macroF1).toBeCloseTo((2 / 3 + 2 / 3 + 1) / 3, 10);
  });

  it("builds a gold × predicted confusion matrix", () => {
    expect(m.confusion.labels).toEqual(["negative", "neutral", "positive"]);
    expect(m.confusion.matrix).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 1],
    ]);
  });

  it("handles an empty input", () => {
    expect(evaluateTask("x", [])).toMatchObject({ n: 0, accuracy: 0, macroF1: 0 });
  });
});

describe("agreementRate", () => {
  const c = (id: string, sentiment: "positive" | "negative"): CommentClassification => ({
    commentId: id,
    type: "opinion",
    isQuestion: false,
    isRequest: false,
    sentiment,
    targets: { creator: "not_addressed", content: "not_addressed" },
  });
  it("compares comments classified in both runs", () => {
    const a = new Map([["1", c("1", "positive")], ["2", c("2", "positive")], ["3", c("3", "negative")]]);
    const b = new Map([["1", c("1", "positive")], ["2", c("2", "negative")]]);
    expect(agreementRate(a, b, "sentiment")).toEqual({ n: 2, agreement: 0.5 });
    expect(agreementRate(a, b, "type")).toEqual({ n: 2, agreement: 1 });
  });
});

describe("cost helpers", () => {
  const prices = { m: { inputPerMTok: 1, outputPerMTok: 5, source: "test" } };
  it("estimates cost from tokens and never guesses unknown values", () => {
    expect(estimateCostUsd(prices, "m", 1_000_000, 100_000)).toBeCloseTo(1.5, 10);
    expect(estimateCostUsd(prices, "unknown", 10, 10)).toBeUndefined();
    expect(estimateCostUsd(prices, "m", undefined, 10)).toBeUndefined();
  });

  it("summarizes usage with latency percentiles", () => {
    const base: Omit<AiCallRecord, "latencyMs" | "outcome"> = { provider: "p", model: "m", promptVersion: "v", schemaVersion: "s", batchSize: 1, attempt: 1, timestamp: "t", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 };
    const s = summarizeUsage([100, 200, 300, 400].map((latencyMs, i) => ({ ...base, latencyMs, outcome: i === 3 ? "provider_error" : "ok" })));
    expect(s).toMatchObject({ requests: 4, failedRequests: 1, inputTokens: 40, outputTokens: 20 });
    expect(s.estimatedCostUsd).toBeCloseTo(0.004, 10);
    expect(s.latencyMs).toMatchObject({ total: 1000, mean: 250, p50: 200, p95: 400, max: 400 });
  });
});
