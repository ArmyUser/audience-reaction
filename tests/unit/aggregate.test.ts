import { describe, expect, it } from "vitest";
import { runAnalysis, type AnalysisOutcome } from "../../src/core/analysis/run-analysis";
import { FOCUS, goldDeps, VIDEO_ID } from "../helpers";

// Expected values are hand-computed from the gold labels in fixtures/m2/comments.json (60 comments, 4 spam;
// guideline g1.1: m2-c22 and m2-c08 relabelled from g1; guideline g1.2: m2-c25 relabelled from g1.1;
// guideline g1.3: m2-c14, m2-c16, m2-c17, m2-c18 creator neutral and m2-c40, m2-c41
// joke_reaction, relabelled from g1.2).

async function completed(withFocus: boolean, mixedSentimentEnabled = false) {
  const outcome: AnalysisOutcome = await runAnalysis(
    { videoId: VIDEO_ID, ...(withFocus ? { focus: FOCUS } : {}) },
    goldDeps({ mixedSentimentEnabled }),
  );
  if (outcome.status !== "completed") throw new Error("expected completed");
  return outcome.report.metrics;
}

const counts = (rows: { label: string; count: number }[]) => Object.fromEntries(rows.map((r) => [r.label, r.count]));
const percents = (rows: { label: string; percent: number }[]) => Object.fromEntries(rows.map((r) => [r.label, r.percent]));

describe("aggregate — volume and bases", () => {
  it("counts A, S and B = A − S", async () => {
    const m = await completed(true);
    expect([m.commentsAnalysed, m.spamExcluded, m.sentimentBase]).toEqual([60, 4, 56]);
  });
});

describe("aggregate — overall sentiment (base B)", () => {
  it("counts and rounds over the sentiment base with largest remainders", async () => {
    const m = await completed(true);
    expect(m.overallSentiment.base).toBe(56);
    expect(counts(m.overallSentiment.rows)).toEqual({ positive: 17, neutral: 19, negative: 20 });
    // 30.36 / 33.93 / 35.71 → floors 30+33+35 = 98; the two largest remainders (neutral, negative) get +1.
    expect(percents(m.overallSentiment.rows)).toEqual({ positive: 30, neutral: 34, negative: 36 });
  });

  it("adds a mixed row only when the candidate label is enabled", async () => {
    const m = await completed(true, true);
    expect(counts(m.overallSentiment.rows)).toEqual({ positive: 15, neutral: 19, negative: 18, mixed: 4 });
    expect(m.overallSentiment.rows.reduce((s, r) => s + r.percent, 0)).toBe(100);
  });
});

describe("aggregate — comment types and flags", () => {
  it("distributes primary types over all analysed comments (base A)", async () => {
    const m = await completed(true);
    expect(m.commentTypes.base).toBe(60);
    expect(counts(m.commentTypes.rows)).toEqual({ opinion: 35, question: 4, request: 3, joke_reaction: 4, spam_irrelevant: 4, other: 10 });
    expect(m.commentTypes.rows.reduce((s, r) => s + r.percent, 0)).toBe(100);
  });

  it("counts question/request flags over B, including flags on other primary types", async () => {
    const m = await completed(true);
    expect(m.questions).toEqual({ count: 5, base: 56, percent: 9 });
    expect(m.requests).toEqual({ count: 4, base: 56, percent: 7 });
  });
});

describe("aggregate — target × sentiment", () => {
  it("computes mentions over B and sentiment over mentions for each target", async () => {
    const m = await completed(true);
    const [creator, content, focus] = m.targets;
    expect(m.targets.map((t) => t.target)).toEqual(["creator", "content", "focus"]);

    expect(creator!.mentions).toEqual({ count: 8, base: 56, percent: 14 });
    expect(counts(creator!.sentiment.rows)).toEqual({ positive: 3, neutral: 4, negative: 1 });
    expect(creator!.sentiment.base).toBe(8);

    expect(content!.mentions.count).toBe(28);
    expect(counts(content!.sentiment.rows)).toEqual({ positive: 12, neutral: 0, negative: 16 });

    expect(focus!.mentions.count).toBe(8);
    expect(counts(focus!.sentiment.rows)).toEqual({ positive: 3, neutral: 2, negative: 3 });
    expect(focus!.focusReferences).toEqual({ explicit: 6, inferred: 2 });
  });

  it("omits the focus target when no focus is configured", async () => {
    const m = await completed(false);
    expect(m.targets.map((t) => t.target)).toEqual(["creator", "content"]);
  });

  it("flags small target samples and warns", async () => {
    const m = await completed(true);
    expect(m.targets.every((t) => t.smallSample)).toBe(true);
    expect(m.warnings).toEqual([
      { code: "LOW_VOLUME" },
      { code: "TARGET_SMALL_SAMPLE", target: "creator" },
      { code: "TARGET_SMALL_SAMPLE", target: "content" },
      { code: "TARGET_SMALL_SAMPLE", target: "focus" },
    ]);
  });

  it("respects configured thresholds", async () => {
    const outcome = await runAnalysis(
      { videoId: VIDEO_ID, focus: FOCUS },
      // smallSampleThreshold 4 is at most the smallest target mention count in the fixture (creator: 8 after g1.3).
      goldDeps({ params: { minAnalyzableForReport: 10, lowVolumeWarningThreshold: 20, smallSampleThreshold: 4 } }),
    );
    if (outcome.status !== "completed") throw new Error("expected completed");
    const m = outcome.report.metrics;
    expect(m.warnings).toEqual([]);
    expect(m.targets.map((t) => t.smallSample)).toEqual([false, false, false]);
  });
});

describe("aggregate — insufficient data", () => {
  it("does not produce a report below the minimum sentiment base", async () => {
    const outcome = await runAnalysis({ videoId: VIDEO_ID }, goldDeps({ params: { minAnalyzableForReport: 57, lowVolumeWarningThreshold: 200, smallSampleThreshold: 30 } }));
    expect(outcome.status).toBe("insufficient_data");
    if (outcome.status === "insufficient_data") {
      expect(outcome.metrics.sentimentBase).toBe(56);
      expect(outcome.metrics.warnings[0]).toEqual({ code: "INSUFFICIENT_DATA" });
    }
  });
});
