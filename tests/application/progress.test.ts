import { describe, expect, it } from "vitest";
import { ANALYSIS_STAGES, ProgressClassifier, ProgressCommentSource, ProgressTopicDiscoverer, ProgressTracker, stagesFor, type AnalysisStage } from "../../src/application/progress";
import type { Classifier, CommentSource, TopicDiscoverer } from "../../src/core/ports";

// Stage ids from the source (a long literal here could collide with dataset text in the leakage audits).
const CLASSIFY = ANALYSIS_STAGES[1];

describe("stage-based progress", () => {
  it("lists the stages of each source in order", () => {
    expect(stagesFor("demo").map((s) => s.id)).toEqual(["fetching", CLASSIFY, "building"]);
    expect(stagesFor("fixture").map((s) => s.id)).toEqual(["fetching", CLASSIFY, "discovering", "consolidating", "assigning", "building"]);
    expect(stagesFor("youtube")[0]!.label).toBe("Fetching YouTube comments");
  });

  it("reports each stage once and never moves backwards (retries)", () => {
    const seen: AnalysisStage[] = [];
    const t = new ProgressTracker(stagesFor("fixture"), (s) => seen.push(s));
    for (const s of ["fetching", CLASSIFY, CLASSIFY, "discovering", "consolidating", "discovering", "assigning", "building", "fetching"] as const) t.advance(s);
    expect(seen).toEqual(["fetching", CLASSIFY, "discovering", "consolidating", "assigning", "building"]);
  });

  it("ignores stages the source does not have", () => {
    const seen: AnalysisStage[] = [];
    const t = new ProgressTracker(stagesFor("demo"), (s) => seen.push(s));
    t.advance("discovering");
    t.advance(CLASSIFY);
    expect(seen).toEqual([CLASSIFY]);
  });
});

describe("progress observers pass everything through unchanged", () => {
  const tracker = () => {
    const seen: AnalysisStage[] = [];
    return { seen, t: new ProgressTracker(stagesFor("demo"), (s) => seen.push(s)) };
  };

  it("source: same label, origin, comments and errors", async () => {
    const { seen, t } = tracker();
    const inner: CommentSource = { label: "L", origin: "youtube", listComments: async (id) => [{ id, text: "x" }] };
    const source = new ProgressCommentSource(inner, t);
    expect([source.label, source.origin]).toEqual(["L", "youtube"]);
    expect(await source.listComments("v")).toEqual([{ id: "v", text: "x" }]);
    expect(seen).toEqual(["fetching"]);
    const failing = new ProgressCommentSource({ ...inner, listComments: async () => Promise.reject(new RangeError("boom")) }, t);
    await expect(failing.listComments("v")).rejects.toThrow(RangeError);
  });

  it("classifier: same result object; the optional next stage only after it returns", async () => {
    const { seen, t } = tracker();
    const result = { results: [] };
    const classifier = new ProgressClassifier({ label: "C", classify: async () => result } satisfies Classifier, t, "building");
    expect(await classifier.classify({ comments: [], schema: {} as never })).toBe(result);
    expect(seen).toEqual([CLASSIFY, "building"]);
  });

  it("discoverer: delegates finishRun and marks building after topics return", async () => {
    const { seen, t } = tracker();
    const inner: TopicDiscoverer = { label: "D", discoverTopics: async () => "raw", finishRun: (id) => ({ discoverySample: { id } as never }) };
    const d = new ProgressTopicDiscoverer(inner, t);
    expect(await d.discoverTopics({} as never)).toBe("raw");
    expect(d.finishRun("r1")).toEqual({ discoverySample: { id: "r1" } });
    expect(new ProgressTopicDiscoverer({ label: "D", discoverTopics: async () => null }, t).finishRun("r")).toBeUndefined();
    expect(seen).toEqual(["building"]);
  });
});
