import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { FixtureTopicDiscoverer, type TopicFixture } from "../../src/adapters/fakes/fixture-topic-discoverer";
import { analyzeVideoSync, type AnalyzeVideoDeps, type AvailableTopicsView, type ReportViewModel } from "../../src/application/analyze-video-sync";
import type { TopicDiscoverer } from "../../src/core/ports";
import { Report } from "../../src/web/Report";
import { goldDeps, VALID_URL, reportProps } from "../helpers";

// Pipeline: classify (gold-label fake) → topics (fixture fake) → report. m2-synthetic has 56 non-spam comments, so the
// minimum topic size is max(10, ceil(0.56)) = 10.
const fixture: TopicFixture = {
  topics: [
    { key: "sponsor", name: "Sponsor segment", description: "The sponsor read, its placement and the sponsor's offer." },
    { key: "sponsor-raw", name: "SPONSOR  segment!!" },
    { key: "audio", name: "Audio quality" },
    { key: "testing", name: "Testing depth" },
    { key: "followups", name: "Follow-up content requests" },
    { key: "crypto", name: "Crypto signals" },
  ],
  unlisted: "no_specific_topic",
    decisions: {
    // Sponsor segment: exactly 10 comments → stays named.
    "m2-c05": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
    // Positive overall, negative toward the sponsor segment.
    "m2-c07": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
    "m2-c08": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
    "m2-c09": { disposition: "primary_topic", topicKey: "sponsor-raw", topicSentiment: "positive" },
    "m2-c10": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "neutral" },
    "m2-c12": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "positive" },
    "m2-c27": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
    "m2-c28": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "negative" },
    "m2-c53": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "positive" },
    "m2-c56": { disposition: "primary_topic", topicKey: "sponsor", topicSentiment: "neutral" },
    // Small topics (3 + 3 + 4) → OTHER.
    "m2-c03": { disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" },
    "m2-c30": { disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" },
    "m2-c14": { disposition: "primary_topic", topicKey: "audio", topicSentiment: "neutral" },
    "m2-c22": { disposition: "primary_topic", topicKey: "testing", topicSentiment: "negative" },
    "m2-c33": { disposition: "primary_topic", topicKey: "testing", topicSentiment: "negative" },
    "m2-c55": { disposition: "primary_topic", topicKey: "testing", topicSentiment: "negative" },
    "m2-c16": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
    "m2-c17": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
    "m2-c18": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
    "m2-c57": { disposition: "primary_topic", topicKey: "followups", topicSentiment: "neutral" },
    // Substantive, but no discovered topic fits → provider other.
    "m2-c31": { disposition: "other" },
    "m2-c54": { disposition: "other" },
    // Generic → no specific topic (stated explicitly; unlisted comments get the same disposition).
    "m2-c24": { disposition: "no_specific_topic" },
    // Spam: never sent to discovery, never counted.
    "m2-c35": { disposition: "primary_topic", topicKey: "crypto", topicSentiment: "positive" },
  },
};

async function report(deps: AnalyzeVideoDeps): Promise<ReportViewModel> {
  const result = await analyzeVideoSync({ url: VALID_URL }, deps);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result.report;
}
const params = { minAnalyzableForReport: 1, lowVolumeWarningThreshold: 1, smallSampleThreshold: 30 };
const withTopics = (discoverer: TopicDiscoverer, topicParams = {}) => goldDeps({ params, topics: { discoverer, params: topicParams } } as Partial<AnalyzeVideoDeps>);
const available = (r: ReportViewModel): AvailableTopicsView => {
  if (r.topics.status !== "available") throw new Error(`expected available topics, got ${r.topics.status}`);
  return r.topics;
};
/** Everything except the topics section and topic warnings. */
// Comment rows carry their topic label, which naturally differs with topics; everything else must not.
const nonTopic = (r: ReportViewModel) => ({
  ...r,
  topics: undefined,
  comments: r.comments?.map((c) => ({ ...c, topic: undefined })),
  warnings: r.warnings.filter((w) => !["HIGH_OTHER_SHARE", "TOPICS_UNAVAILABLE"].includes(w.code)),
});

describe("analysis pipeline with topics", () => {
  it("without a topic discoverer the topics section stays not_run", async () => {
    const r = await report(goldDeps({ params }));
    expect(r.topics).toEqual({ status: "not_run", message: "Topic discovery is not available in this version." });
  });

  it("available topics flow into the report: named topics, OTHER (both origins) and NO_SPECIFIC_TOPIC", async () => {
    const r = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    const t = available(r);
    expect(t.topicBase).toBe(56);
    expect(t.minTopicSize).toBe(10);
    expect(t.topics).toEqual([
      {
        id: "topic:sponsor-segment",
        name: "Sponsor segment",
        description: "The sponsor read, its placement and the sponsor's offer.",
        count: { count: 10, base: 56, percent: 18 },
        topicSentiment: {
          base: 10,
          rows: [
            { key: "positive", label: "Positive", count: 3, percent: 30 },
            { key: "neutral", label: "Neutral", count: 2, percent: 20 },
            { key: "negative", label: "Negative", count: 5, percent: 50 },
          ],
        },
        showPercentages: false,
        evidenceCommentIds: ["m2-c05", "m2-c09", "m2-c10"],
        evidence: expect.any(Array),
      },
    ]);
    // Evidence detail: the same comments, with topic sentiment labels, and no comment text.
    expect(t.topics[0]!.evidence.map((e) => e.commentId)).toEqual(["m2-c05", "m2-c09", "m2-c10"]);
    for (const e of t.topics[0]!.evidence) expect(Object.keys(e).sort()).toEqual(["commentId", "providerExample", "rank", "sentiment", "sentimentKey"]);
    expect(t.other).toEqual({
      count: { count: 12, base: 56, percent: 21 },
      providerOther: { count: 2, base: 56, percent: 4 },
      smallTopics: { count: 10, base: 56, percent: 18 },
      smallTopicSentiment: {
        base: 10,
        rows: [
          { key: "positive", label: "Positive", count: 0, percent: 0 },
          { key: "neutral", label: "Neutral", count: 5, percent: 50 },
          { key: "negative", label: "Negative", count: 5, percent: 50 },
        ],
      },
      showPercentages: false,
      mergedTopicNames: ["Follow up content requests", "Audio quality", "Testing depth"],
    });
    expect(t.noSpecificTopic).toEqual({ count: 34, base: 56, percent: 61 });
    // AC-23: named + OTHER + NO_SPECIFIC_TOPIC = topic base; there is no rejected bucket.
    expect(t.topics[0]!.count.count + t.other.count.count + t.noSpecificTopic.count).toBe(56);
    expect(Object.keys(t)).not.toContain("assignmentRejected");
    expect(t.other.providerOther.count + t.other.smallTopics.count).toBe(t.other.count.count);
    expect(t.providerLabel).toBe("Fake topic discoverer (fixture mapping)");
  });

  it("topic sentiment differs from overall sentiment without changing the classification", async () => {
    const r = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    const c07 = r.comments!.find((c) => c.id === "m2-c07")!;
    expect(c07.sentiment).toBe("Positive");
    // m2-c07 is one of the five negative comments under the sponsor segment.
    expect(available(r).topics[0]!.topicSentiment.rows.find((x) => x.label === "Negative")!.count).toBe(5);
    expect(r.overallSentiment).toEqual((await report(goldDeps({ params }))).overallSentiment);
  });

  it("adds HIGH_OTHER_SHARE with the structured shares when OTHER + NO_SPECIFIC_TOPIC > 35%", async () => {
    const r = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    expect(r.warnings.filter((w) => w.code === "HIGH_OTHER_SHARE")).toEqual([
      { code: "HIGH_OTHER_SHARE", message: "Many comments did not fit the main topics (other 21%, no specific topic 61%, combined 82% of 56); topic findings may be incomplete." },
    ]);
  });

  it("keeps provider raw names, keys and comment text out of the topics section", async () => {
    const t = available(await report(withTopics(new FixtureTopicDiscoverer(fixture))));
    const json = JSON.stringify(t);
    for (const leaked of ["SPONSOR  segment!!", "sponsor-raw", "Crypto", "Acme VPN ad read", "assignmentRejected"]) expect(json).not.toContain(leaked);
  });

  it("leaves every non-topic part of the report unchanged", async () => {
    const without = await report(goldDeps({ params }));
    const withT = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    expect(nonTopic(withT)).toEqual(nonTopic(without));
  });

  it("is deterministic", async () => {
    const deps = withTopics(new FixtureTopicDiscoverer(fixture));
    expect(await report(deps)).toEqual(await report(deps));
  });
});

/** The same fixture with one comment pointing at an undeclared topic: invalid as a whole (spec.md §7.8). */
const invalidFixture: TopicFixture = {
  ...fixture,
  decisions: { ...fixture.decisions, "m2-c60": { disposition: "primary_topic", topicKey: "missing-topic", topicSentiment: "negative" } },
};

describe("pipeline retry (spec.md §7.8)", () => {
  it("an invalid first attempt is retried once; a valid second attempt flows into the report", async () => {
    const discoverer = new FixtureTopicDiscoverer([invalidFixture, fixture]);
    const t = available(await report(withTopics(discoverer)));
    expect(discoverer.calls).toBe(2);
    expect(discoverer.feedbackReceived[1]).toEqual({ attempt: 1, issues: [{ code: "unknown_topic", count: 1, commentIds: ["m2-c60"], topicKeys: ["missing-topic"] }] });
    expect(t.noSpecificTopic.count).toBe(34);
  });

  it("two invalid attempts → topics unavailable; no partial topics; every other section unchanged", async () => {
    const discoverer = new FixtureTopicDiscoverer(invalidFixture);
    const without = await report(goldDeps({ params }));
    const r = await report(withTopics(discoverer));
    expect(discoverer.calls).toBe(2);
    expect(r.topics).toEqual({ status: "unavailable", message: "Topics could not be determined for this analysis. All other figures are unaffected." });
    expect(r.warnings.map((w) => w.code)).toContain("TOPICS_UNAVAILABLE");
    expect(r.warnings.map((w) => w.code)).not.toContain("HIGH_OTHER_SHARE");
    expect(nonTopic(r)).toEqual(nonTopic(without));
    expect(JSON.stringify(r.topics)).not.toContain("Sponsor");
  });
});

describe("topic failure leaves the rest of the report intact", () => {
  const cases: [string, TopicDiscoverer, object][] = [
    ["provider error", { label: "failing", discoverTopics: async () => Promise.reject(new Error("upstream detail")) }, {}],
    ["malformed output", { label: "malformed", discoverTopics: async () => ({ results: [] }) }, {}],
    ["too many topics", new FixtureTopicDiscoverer(fixture), { maxTopics: 2 }],
    // Invalid parameters make aggregation throw: an unexpected error is contained as well.
    ["unexpected internal error", new FixtureTopicDiscoverer(fixture), { evidencePerTopic: -1 }],
  ];

  it.each(cases)("%s → topics unavailable, report still produced", async (_name, discoverer, topicParams) => {
    const without = await report(goldDeps({ params }));
    const r = await report(withTopics(discoverer, topicParams));
    expect(r.topics).toEqual({ status: "unavailable", message: "Topics could not be determined for this analysis. All other figures are unaffected." });
    expect(r.warnings.filter((w) => w.code === "TOPICS_UNAVAILABLE")).toHaveLength(1);
    expect(nonTopic(r)).toEqual(nonTopic(without));
    expect(JSON.stringify(r)).not.toContain("upstream detail");
    // The view model stays plain, serialisable data.
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("an unavailable topics section renders as a placeholder", async () => {
    const r = await report(withTopics({ label: "failing", discoverTopics: async () => Promise.reject(new Error("x")) }));
    const html = renderToStaticMarkup(createElement(Report, reportProps(r)));
    expect(html).toContain("Topics could not be determined for this analysis.");
    expect(html).toContain("TOPICS_UNAVAILABLE");
  });
});

describe("report rendering with topics", () => {
  it("renders named topics, OTHER with merged names, NO_SPECIFIC_TOPIC and the topic base", async () => {
    const html = renderToStaticMarkup(createElement(Report, reportProps(await report(withTopics(new FixtureTopicDiscoverer(fixture))))));
    expect(html).toContain("Sponsor segment");
    expect(html).toContain("base: 56 non-spam comments; one primary topic per comment");
    expect(html).toContain("merged: Follow up content requests, Audio quality, Testing depth");
    expect(html).toMatch(/substantive comments that fit no topic: (<!-- -->)?2;/);
    expect(html).toContain("No specific topic (generic comments)");
    expect(html).not.toContain("rejected");
    expect(html).toContain("HIGH_OTHER_SHARE");
  });
});

describe("redesigned report: findings → topics → evidence → comments", () => {
  it("labels every synthetic comment row with its topic disposition", async () => {
    const r = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    const row = (id: string) => r.comments!.find((c) => c.id === id)!.topic;
    expect(row("m2-c05")).toEqual({ kind: "topic", topicId: "topic:sponsor-segment", name: "Sponsor segment", sentiment: "Negative", sentimentKey: "negative" });
    expect(row("m2-c03")).toEqual({ kind: "other", mergedFrom: "Audio quality" });
    expect(row("m2-c31")).toEqual({ kind: "other" });
    expect(row("m2-c24")).toEqual({ kind: "no_specific_topic" });
    expect(row("m2-c35")).toEqual({ kind: "none" });
  });

  it("renders findings, the topic matrix, the drill-down with verbatim evidence, and the comment explorer", async () => {
    const r = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    const run = { mode: "real" as const, input: { kind: "fixture" as const, dataset: "t1-topics-v1", comments: 200 }, durationMs: 72_000, pipeline: [{ role: "Topic discovery", component: "Model X · contract-v2" }], usage: { requests: 12, failedRequests: 0, requestsByProvider: { a: 2, b: 10 }, estimatedCostUsd: 0.0823, costLimitUsd: 1 } };
    const html = renderToStaticMarkup(createElement(Report, { ...reportProps(r), run }));
    const order = ["What stands out", "What people are talking about", "Topic detail", "Sentiment of each comment as a whole", "Analysed comments (synthetic)", "Methodology and data notes", "Run diagnostics (internal)"].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("not AI-generated");
    // Drill-down: the first topic is selected; its evidence is shown as verbatim source comments, labelled as evidence.
    const evidenceText = r.comments!.find((c) => c.id === "m2-c05")!.text;
    const escaped = renderToStaticMarkup(createElement("p", null, evidenceText)).slice(3, -4);
    expect(html.slice(html.indexOf("Topic detail"))).toContain(escaped);
    expect(html).toContain("These are evidence, not AI-written text.");
    expect(html).toContain("1 min 12 s");
    expect(html).toContain("$0.0823");
    expect(html).toContain("Model X · contract-v2");
  });

  it("without synthetic comments, evidence shows IDs only and there is no comment explorer", async () => {
    const r = await report(withTopics(new FixtureTopicDiscoverer(fixture)));
    const { comments: _omitted, ...withoutComments } = r;
    const html = renderToStaticMarkup(createElement(Report, reportProps({ ...withoutComments, isSyntheticData: false })));
    expect(html).toContain("Comment text is not shown for this data source.");
    expect(html).not.toContain("Analysed comments (synthetic)");
  });
});

