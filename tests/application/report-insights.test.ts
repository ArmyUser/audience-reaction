import { describe, expect, it } from "vitest";
import type { AvailableTopicsView, ReportViewModel, TopicView } from "../../src/application/analyze-video-sync";
import { analyzeVideoSync } from "../../src/application/analyze-video-sync";
import { keyFindings, reportOverview, strongestTopic } from "../../src/application/report-insights";
import { goldDeps, VALID_URL } from "../helpers";

function topic(id: string, counts: { positive: number; neutral: number; negative: number }, showPercentages = true): TopicView {
  const total = counts.positive + counts.neutral + counts.negative;
  const pct = (n: number) => Math.round((n * 100) / total);
  return {
    id,
    name: id,
    count: { count: total, base: 100, percent: total },
    topicSentiment: {
      base: total,
      rows: (["positive", "neutral", "negative"] as const).map((k) => ({ key: k, label: k, count: counts[k], percent: pct(counts[k]) })),
    },
    showPercentages,
    evidenceCommentIds: [],
    evidence: [],
  };
}

async function baseReport(): Promise<ReportViewModel> {
  const result = await analyzeVideoSync({ url: VALID_URL }, goldDeps());
  if (result.status !== "ok") throw new Error("expected ok");
  return result.report;
}

function withTopics(report: ReportViewModel, topics: TopicView[], other = 5, nst = 5): ReportViewModel {
  const section: AvailableTopicsView = {
    status: "available",
    topicBase: 100,
    minTopicSize: 10,
    topics,
    other: {
      count: { count: other, base: 100, percent: other },
      providerOther: { count: other, base: 100, percent: other },
      smallTopics: { count: 0, base: 100, percent: 0 },
      smallTopicSentiment: { base: 0, rows: [] },
      showPercentages: false,
      mergedTopicNames: [],
    },
    noSpecificTopic: { count: nst, base: 100, percent: nst },
    providerLabel: "test",
  };
  return { ...report, topics: section };
}

describe("strongestTopic", () => {
  it("ranks by count of the sentiment, then by its share of the topic", () => {
    const topics = [topic("big", { positive: 10, neutral: 20, negative: 30 }), topic("small", { positive: 10, neutral: 2, negative: 3 }), topic("none", { positive: 0, neutral: 5, negative: 1 })];
    expect(strongestTopic(topics, "positive")).toMatchObject({ topicId: "small", count: 10, percentOfTopic: 67 });
    expect(strongestTopic(topics, "negative")).toMatchObject({ topicId: "big", count: 30 });
    expect(strongestTopic([topic("x", { positive: 0, neutral: 3, negative: 0 })], "negative")).toBeNull();
  });
});

describe("reportOverview", () => {
  it("computes net sentiment and the strongest topics from the report's own numbers", async () => {
    const report = withTopics(await baseReport(), [topic("battery", { positive: 5, neutral: 5, negative: 20 }), topic("design", { positive: 15, neutral: 5, negative: 0 })]);
    const o = reportOverview(report);
    const pct = (k: string) => report.overallSentiment.rows.find((r) => r.key === k)!.percent;
    expect(o.netSentiment).toBe(pct("positive") - pct("negative"));
    expect(o.topicCount).toBe(2);
    expect(o.strongestPositive?.topicId).toBe("design");
    expect(o.strongestNegative?.topicId).toBe("battery");
  });

  it("reports no topic count when topics did not run", async () => {
    expect(reportOverview(await baseReport()).topicCount).toBeNull();
  });
});

describe("keyFindings", () => {
  it("gives at most five findings, each tied to an existing topic or metric", async () => {
    const report = withTopics(await baseReport(), [topic("battery", { positive: 5, neutral: 5, negative: 20 }), topic("design", { positive: 15, neutral: 5, negative: 0 })], 30, 20);
    const findings = keyFindings(report);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.length).toBeLessThanOrEqual(5);
    const ids = new Set(["battery", "design"]);
    for (const f of findings) if (f.ref.kind === "topic") expect(ids.has(f.ref.topicId)).toBe(true);
    expect(findings[1]).toEqual({
      text: "battery is the most discussed topic: 30 comments (30%) of the topic base; 17% positive, 67% negative. It also draws the most negative reaction.",
      ref: { kind: "topic", topicId: "battery" },
    });
    // No second finding for the same topic.
    expect(findings.filter((f) => f.ref.kind === "topic" && f.ref.topicId === "battery")).toHaveLength(1);
    expect(findings.some((f) => f.text.startsWith("design draws the most positive reaction"))).toBe(true);
    expect(findings.some((f) => f.ref.kind === "metric" && f.ref.metric === "other")).toBe(true);
  });

  it("states small samples as counts, never percentages", async () => {
    const report = withTopics(await baseReport(), [topic("tiny", { positive: 2, neutral: 1, negative: 3 }, false)]);
    const text = keyFindings(report).find((f) => f.ref.kind === "topic" && f.text.includes("most discussed"))!.text;
    expect(text).toBe("tiny is the most discussed topic: 6 comments of the topic base; 2 positive, 3 negative. It also draws the most negative reaction.");
    expect(text).not.toMatch(/%/);
  });

  it("without topics, only sentiment and question/request findings", async () => {
    const findings = keyFindings(await baseReport());
    expect(findings.map((f) => f.ref)).toEqual([
      { kind: "metric", metric: "sentiment" },
      { kind: "metric", metric: "questions_requests" },
    ]);
  });
});
