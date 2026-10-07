import { describe, expect, it } from "vitest";
import { GoldLabelClassifier } from "../../src/adapters/fakes/gold-label-classifier";
import { aggregate } from "../../src/core/aggregation/aggregate";
import { share } from "../../src/core/aggregation/distribution";
import { ClassificationFailedError, runAnalysis } from "../../src/core/analysis/run-analysis";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { ClassificationOutputError } from "../../src/core/classification/validation";
import type { ClassifiedComment, CommentClassification } from "../../src/core/domain/types";
import type { ClassificationRequest, Classifier } from "../../src/core/ports";
import { FIXTURE, FOCUS, goldDeps, rawClassifier, sourceOf, VIDEO_ID } from "../helpers";

const schema = createClassificationSchema({ focusConfigured: false });

function classified(id: string, overrides: Partial<CommentClassification> = {}): ClassifiedComment {
  return {
    comment: { id, text: id },
    classification: {
      commentId: id,
      type: "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment: "positive",
      targets: { creator: "not_addressed", content: "positive" },
      ...overrides,
    },
  };
}

async function goldMetrics() {
  const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
  if (outcome.status !== "completed") throw new Error("expected completed");
  return outcome.report.metrics;
}

describe("domain invariants", () => {
  it("counts and percentages are never negative", async () => {
    const m = await goldMetrics();
    const rows = [...m.overallSentiment.rows, ...m.commentTypes.rows, ...m.targets.flatMap((t) => t.sentiment.rows)];
    expect(rows.every((r) => r.count >= 0 && r.percent >= 0 && r.percent <= 100)).toBe(true);
    expect(() => share(-1, 10)).toThrow(RangeError);
    expect(() => share(11, 10)).toThrow(RangeError);
    expect(() => share(1.5, 10)).toThrow(RangeError);
  });

  it("produces identical results on repeated runs", async () => {
    expect(JSON.stringify(await goldMetrics())).toBe(JSON.stringify(await goldMetrics()));
  });

  it("uses the correct denominator for each figure", async () => {
    const m = await goldMetrics();
    expect(m.commentTypes.base).toBe(m.commentsAnalysed); // A
    expect(m.overallSentiment.base).toBe(m.sentimentBase); // B
    expect(m.questions.base).toBe(m.sentimentBase);
    expect(m.requests.base).toBe(m.sentimentBase);
    for (const t of m.targets) {
      expect(t.mentions.base).toBe(m.sentimentBase);
      expect(t.sentiment.base).toBe(t.mentions.count);
    }
  });

  it("excludes spam from the sentiment base, flags and targets but keeps it in the type distribution", () => {
    const spam = classified("s", { type: "spam_irrelevant", sentiment: "neutral", targets: { creator: "not_addressed", content: "not_addressed" } });
    const m = aggregate([classified("a"), spam], schema);
    expect(m.commentsAnalysed).toBe(2);
    expect(m.sentimentBase).toBe(1);
    expect(m.overallSentiment.rows.find((r) => r.label === "neutral")!.count).toBe(0);
    expect(m.commentTypes.rows.find((r) => r.label === "spam_irrelevant")!.count).toBe(1);
  });

  it("question/request flags do not distort the primary-type denominator", () => {
    const plain = aggregate([classified("a"), classified("b")], schema);
    const flagged = aggregate([classified("a", { isRequest: true }), classified("b", { isQuestion: true })], schema);
    expect(flagged.commentTypes).toEqual(plain.commentTypes);
    expect(flagged.commentTypes.rows.reduce((s, r) => s + r.count, 0)).toBe(2);
    expect([flagged.questions.count, flagged.requests.count]).toEqual([1, 1]);
  });

  it("a missing classification is never treated as neutral", async () => {
    const comments = [{ id: "a", text: "x" }, { id: "b", text: "y" }];
    const onlyA = { results: [{ commentId: "a", type: "opinion", isQuestion: false, isRequest: false, sentiment: "positive", targets: { creator: "not_addressed", content: "positive" } }] };
    // 1 of 2 comments can never be classified → above the failure limit → the analysis fails instead of guessing.
    await expect(runAnalysis({ videoId: VIDEO_ID }, goldDeps({ source: sourceOf(comments), classifier: rawClassifier(onlyA) }))).rejects.toBeInstanceOf(ClassificationFailedError);
  });

  it("an isolated unclassifiable comment is excluded and disclosed, not labelled", async () => {
    const all = FIXTURE.comments.map((c) => ({ id: c.id, text: c.text }));
    const source = sourceOf([...all, { id: "unknown-1", text: "no gold label for this one" }]);
    const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps({ source }));
    if (outcome.status !== "completed") throw new Error("expected completed");
    const m = outcome.report.metrics;
    expect(m.commentsRetrieved).toBe(61);
    expect(m.classificationFailures).toBe(1);
    expect(m.commentsAnalysed).toBe(60);
    expect(outcome.classified.some((c) => c.comment.id === "unknown-1")).toBe(false);
    expect(m.warnings).toContainEqual({ code: "CLASSIFICATION_FAILURES" });
    expect(outcome.classification.failures).toEqual([{ commentId: "unknown-1", issues: ["missing classification"] }]);
  });

  it("aggregation rejects invalid or inconsistent input instead of guessing", () => {
    const broken = classified("a", { sentiment: undefined as never });
    expect(() => aggregate([broken], schema)).toThrow(ClassificationOutputError);
    expect(() => aggregate([classified("a"), classified("a")], schema)).toThrow(/duplicate/);
    const mismatched: ClassifiedComment = { ...classified("a"), classification: { ...classified("b").classification } };
    expect(() => aggregate([mismatched], schema)).toThrow(/does not belong/);
    const focusSchema = createClassificationSchema({ focusConfigured: true });
    const noMention = classified("a", { targets: { creator: "not_addressed", content: "positive", focus: "positive" } });
    expect(() => aggregate([noMention], focusSchema)).toThrow(/mention type missing/);
    expect(() => aggregate([{ ...noMention, focusMention: "none" }], focusSchema)).toThrow(/mention type is none/);
  });

  it("changing the classifier provider does not change aggregation logic", async () => {
    // Same labels delivered by a differently named provider → identical metrics.
    class OtherProvider implements Classifier {
      readonly label = "Another provider";
      private readonly inner = new GoldLabelClassifier(FIXTURE.comments);
      classify(request: ClassificationRequest) {
        return this.inner.classify(request);
      }
    }
    const a = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    const b = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps({ classifier: new OtherProvider() }));
    if (a.status !== "completed" || b.status !== "completed") throw new Error("expected completed");
    expect(b.report.metrics).toEqual(a.report.metrics);
    expect(b.report.methodology.classifierLabel).not.toBe(a.report.methodology.classifierLabel);
  });
});
