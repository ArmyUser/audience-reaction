import { describe, expect, it } from "vitest";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { GoldLabelClassifier } from "../../src/adapters/fakes/gold-label-classifier";
import { renderBenchmarkMarkdown, runClassifierBenchmark, type BenchmarkDataset, type BenchmarkSubject } from "../../src/benchmark/classifier-benchmark";
import type { EvalTask } from "../../src/core/metrics/classification-eval";
import type { ClassificationRequest, Classifier } from "../../src/core/ports";
import { FIXTURE, FOCUS } from "../helpers";

const dataset: BenchmarkDataset = { name: "m2-synthetic", version: "sha256:test", focus: FOCUS, comments: FIXTURE.comments };
const options = { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 };

type RawResult = Record<string, unknown> & { commentId: string; targets: Record<string, string> };

/** Gold labels with per-comment edits; an edit returning undefined drops the comment from the output. */
class EditedGoldClassifier implements Classifier {
  readonly label = "edited gold";
  private readonly gold = new GoldLabelClassifier(FIXTURE.comments);
  constructor(private readonly edits: Record<string, (r: RawResult) => RawResult | undefined>) {}
  async classify(request: ClassificationRequest): Promise<unknown> {
    const raw = (await this.gold.classify(request)) as { results: RawResult[] };
    return { results: raw.results.flatMap((r) => { const edit = this.edits[r.commentId]; const out = edit ? edit(r) : r; return out ? [out] : []; }) };
  }
}

const subject = (classifier: Classifier): (() => BenchmarkSubject) => () => ({ classifier, provider: "fake", model: "n/a", promptVersion: "n/a", usage: () => [] });

describe("benchmark per-comment records", () => {
  it("produces exactly one record per dataset comment, with gold and predicted classifications", async () => {
    const run = (await runClassifierBenchmark(dataset, subject(new GoldLabelClassifier(FIXTURE.comments)), options)).runs[0]!;
    expect(run.comments.map((c) => c.commentId)).toEqual(FIXTURE.comments.map((c) => c.id));
    for (const record of run.comments) {
      expect(record.gold.commentId).toBe(record.commentId);
      expect(record.predicted).toEqual(record.gold);
    }
  });

  it("a perfect prediction has no mismatched fields", async () => {
    const run = (await runClassifierBenchmark(dataset, subject(new GoldLabelClassifier(FIXTURE.comments)), options)).runs[0]!;
    expect(run.comments.every((c) => c.status === "correct" && c.mismatches.length === 0 && c.errorCount === 0)).toBe(true);
    expect(run.errorSummary).toMatchObject({ comments: 60, perfectComments: 60, commentsWithErrors: 0, failedComments: 0, totalFieldErrors: 0, errors: [] });
    expect(Object.values(run.errorSummary.fieldErrorCounts).every((n) => n === 0)).toBe(true);
  });

  it("identifies single and multi-field errors exactly, in scoring-field order", async () => {
    const classifier = new EditedGoldClassifier({
      // m2-c01 gold: opinion / positive / content positive.
      "m2-c01": (r) => ({ ...r, sentiment: "neutral" }),
      // m2-c44 gold: other / neutral / nothing addressed.
      "m2-c44": (r) => ({ ...r, type: "request", isRequest: true, sentiment: "positive", targets: { ...r.targets, creator: "neutral", focus: "positive" } }),
    });
    const run = (await runClassifierBenchmark(dataset, subject(classifier), options)).runs[0]!;
    const byId = new Map(run.comments.map((c) => [c.commentId, c]));
    expect(byId.get("m2-c01")).toMatchObject({ status: "incorrect", mismatches: ["sentiment"], errorCount: 1 });
    expect(byId.get("m2-c44")).toMatchObject({
      status: "incorrect",
      mismatches: ["type", "isRequest", "sentiment", "target_creator", "target_focus"],
      errorCount: 5,
      gold: { type: "other", sentiment: "neutral" },
      predicted: { type: "request", isRequest: true, sentiment: "positive" },
    });
    expect(run.errorSummary).toMatchObject({
      perfectComments: 58,
      commentsWithErrors: 2,
      commentsWithOneError: 1,
      commentsWithMultipleErrors: 1,
      totalFieldErrors: 6,
      fieldErrorCounts: { type: 1, isQuestion: 0, isRequest: 1, sentiment: 2, target_creator: 1, target_content: 0, target_focus: 1 },
      errors: [
        { commentId: "m2-c01", fields: ["sentiment"] },
        { commentId: "m2-c44", fields: ["type", "isRequest", "sentiment", "target_creator", "target_focus"] },
      ],
    });
  });

  it("per-field error counts agree with the unchanged aggregate task metrics", async () => {
    const run = (await runClassifierBenchmark(dataset, subject(new FakeClassifier()), options)).runs[0]!;
    expect(run.errorSummary.totalFieldErrors).toBeGreaterThan(0);
    for (const task of run.tasks) expect(run.errorSummary.fieldErrorCounts[task.task as EvalTask]).toBe(task.n - task.correct);
    expect(run.errorSummary.perfectComments + run.errorSummary.commentsWithErrors + run.errorSummary.failedComments).toBe(60);
  });

  it("keeps provider/validation failures separate from prediction errors", async () => {
    const run = (await runClassifierBenchmark(dataset, subject(new EditedGoldClassifier({ "m2-c03": () => undefined })), options)).runs[0]!;
    const record = run.comments.find((c) => c.commentId === "m2-c03")!;
    expect(record).toMatchObject({ status: "failed", predicted: null, mismatches: [], errorCount: 0 });
    expect(record.failureIssues!.length).toBeGreaterThan(0);
    expect(run.errorSummary).toMatchObject({ failedComments: 1, perfectComments: 59, commentsWithErrors: 0, totalFieldErrors: 0 });
    expect(run.tasks.every((t) => t.n === 59)).toBe(true);
  });

  it("attaches consistency issues to the comment they belong to", async () => {
    // m2-c42 "?" — the issue seen in the first real Jev run: type question without the question flag.
    const run = (await runClassifierBenchmark(dataset, subject(new EditedGoldClassifier({ "m2-c42": (r) => ({ ...r, type: "question" }) })), options)).runs[0]!;
    const record = run.comments.find((c) => c.commentId === "m2-c42")!;
    expect(record).toMatchObject({ status: "incorrect", mismatches: ["type"], consistencyIssues: ["question_type_without_question_flag"] });
    expect(run.comments.filter((c) => c.consistencyIssues.length > 0)).toHaveLength(1);
  });

  it("omits comment text unless explicitly enabled", async () => {
    const without = (await runClassifierBenchmark(dataset, subject(new GoldLabelClassifier(FIXTURE.comments)), options)).runs[0]!;
    expect(without.comments.some((c) => "text" in c)).toBe(false);
    const withText = (await runClassifierBenchmark(dataset, subject(new GoldLabelClassifier(FIXTURE.comments)), { ...options, includeCommentText: true })).runs[0]!;
    expect(withText.comments[0]!.text).toBe(FIXTURE.comments[0]!.text);
  });

  it("scores without the focus target when focus is disabled", async () => {
    const run = (await runClassifierBenchmark(dataset, subject(new GoldLabelClassifier(FIXTURE.comments)), { ...options, useFocus: false })).runs[0]!;
    expect(Object.keys(run.errorSummary.fieldErrorCounts)).not.toContain("target_focus");
  });

  it("summarizes per-comment results in the markdown report", async () => {
    const report = await runClassifierBenchmark(dataset, subject(new EditedGoldClassifier({ "m2-c01": (r) => ({ ...r, sentiment: "neutral" }) })), options);
    expect(renderBenchmarkMarkdown(report)).toContain("Per comment: 59 perfect, 1 with errors (1 single, 0 multiple), 0 failed; 1 field errors");
  });
});
