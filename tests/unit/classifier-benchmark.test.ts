import { describe, expect, it } from "vitest";
import { AnthropicClassifier } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { GoldLabelClassifier } from "../../src/adapters/fakes/gold-label-classifier";
import { renderBenchmarkMarkdown, runClassifierBenchmark, type BenchmarkDataset, type BenchmarkSubject } from "../../src/benchmark/classifier-benchmark";
import { PROMPT_VERSION } from "../../src/core/classification/llm-prompt";
import { InMemoryUsageRecorder } from "../../src/core/cost/usage";
import { FIXTURE, FOCUS } from "../helpers";
import { goldResponder, mockClient, PRICES } from "../adapters/anthropic-mock";

const dataset: BenchmarkDataset = { name: "m2-synthetic", version: "sha256:test", focus: FOCUS, comments: FIXTURE.comments };
const options = { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 };

function fakeSubject(classifier: BenchmarkSubject["classifier"]): () => BenchmarkSubject {
  return () => ({ classifier, provider: "fake", model: "n/a", promptVersion: "n/a", usage: () => [] });
}

describe("classifier benchmark harness", () => {
  it("scores the gold labels as perfect on every task", async () => {
    const report = await runClassifierBenchmark(dataset, fakeSubject(new GoldLabelClassifier(FIXTURE.comments)), options);
    const run = report.runs[0]!;
    expect(run.classified).toBe(60);
    expect(run.firstAttemptValidRate).toBe(1);
    expect(run.tasks.map((t) => t.task)).toEqual(["type", "isQuestion", "isRequest", "sentiment", "target_creator", "target_content", "target_focus"]);
    expect(run.tasks.every((t) => t.accuracy === 1 && t.n === 60)).toBe(true);
    expect(run.aggregateOverallSentiment.maxAbsDiffPctPoints).toBe(0);
  });

  it("measures an imperfect classifier without altering gold labels", async () => {
    const before = JSON.stringify(FIXTURE.comments);
    const report = await runClassifierBenchmark(dataset, fakeSubject(new FakeClassifier()), options);
    expect(report.runs[0]!.tasks.find((t) => t.task === "sentiment")!.accuracy).toBeLessThan(1);
    expect(JSON.stringify(FIXTURE.comments)).toBe(before);
  });

  it("reports consistency across repeats", async () => {
    const report = await runClassifierBenchmark(dataset, fakeSubject(new FakeClassifier()), { ...options, repeats: 3 });
    expect(report.runs).toHaveLength(3);
    expect(report.consistency.find((c) => c.task === "sentiment")).toEqual({ task: "sentiment", meanAgreement: 1, pairs: 3 });
  });

  it("records reproducibility metadata and cost/latency for a (mocked) LLM run", async () => {
    const { client } = mockClient(goldResponder(true));
    const report = await runClassifierBenchmark(
      dataset,
      () => {
        const recorder = new InMemoryUsageRecorder();
        return {
          classifier: new AnthropicClassifier({ client, prices: PRICES, recorder, batchSize: 20 }),
          provider: "anthropic",
          model: "claude-haiku-4-5",
          promptVersion: PROMPT_VERSION,
          batchSize: 20,
          usage: () => recorder.entries,
        };
      },
      options,
    );
    expect(report.meta).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      modelVersions: ["claude-haiku-4-5-20251001"],
      promptVersion: PROMPT_VERSION,
      schemaVersion: "v1-3label-focus",
      guidelineVersion: "g1.4",
      dataset: { name: "m2-synthetic", version: "sha256:test", size: 60 },
      batchSize: 20,
    });
    expect(report.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.usageTotal).toMatchObject({ requests: 3, inputTokens: 3000, outputTokens: 1200 });
    expect(report.usageTotal.estimatedCostUsd).toBeCloseTo(3 * (1000 + 400 * 5) / 1_000_000, 10);
    expect(renderBenchmarkMarkdown(report)).toContain("claude-haiku-4-5-20251001");
  });

  it("uses mixed gold labels when the candidate label is enabled", async () => {
    const report = await runClassifierBenchmark(dataset, fakeSubject(new GoldLabelClassifier(FIXTURE.comments)), { ...options, mixedEnabled: true });
    expect(report.meta.schemaVersion).toBe("v1-4label-focus");
    expect(report.runs[0]!.tasks.every((t) => t.accuracy === 1)).toBe(true);
  });
});
