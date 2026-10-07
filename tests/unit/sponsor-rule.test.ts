import { describe, expect, it } from "vitest";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import { SPONSOR_SEGMENT_RULE } from "../../src/core/classification/guidelines";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseClassifierOutput } from "../../src/core/classification/validation";
import { comment, FIXTURE, FOCUS, goldDeps, VIDEO_ID } from "../helpers";

// spec.md §6.4.4 (guideline g1.1 wording): complaints about the presence, repetition, placement, duration, skipping,
// format or integration of a sponsored segment are NOT negative sentiment toward the sponsor/brand; they count toward
// content when about the viewing experience. Negative focus sentiment needs negativity aimed at the brand itself.

const CASES = [
  { id: "m2-c05", tag: "sponsor_ad_format_negative", focus: "not_addressed", content: "negative", what: "negative about the ad format, not the brand" },
  { id: "m2-c06", tag: "sponsor_brand_negative", focus: "negative", content: "not_addressed", what: "negative about the brand" },
  { id: "m2-c07", tag: "sponsor_brand_positive_ad_negative", focus: "positive", content: "negative", what: "positive toward the brand, negative about the ad format" },
  { id: "m2-c08", tag: "sponsor_ambiguous", focus: "not_addressed", content: "negative", what: "ambiguous wording (g1.1: recurring-ad annoyance counts toward content)" },
  { id: "m2-c09", tag: "sponsor_brand_positive", focus: "positive", content: "not_addressed", what: "positive sponsor mention" },
] as const;

describe("sponsor-segment rule", () => {
  it("is part of the provider-neutral guideline", () => {
    expect(SPONSOR_SEGMENT_RULE).toMatch(/presence, repetition, placement, duration, skipping, format, or integration/);
    expect(SPONSOR_SEGMENT_RULE).toMatch(/NOT negative sentiment toward the focus target/);
  });

  for (const c of CASES) {
    it(`gold labels encode the rule: ${c.what} (${c.id})`, () => {
      const entry = FIXTURE.comments.find((x) => x.id === c.id)!;
      expect(entry.tags).toContain(c.tag);
      expect(entry.gold.targets.focus).toBe(c.focus);
      expect(entry.gold.targets.content).toBe(c.content);
    });
  }

  it("the deterministic fake classifier applies the rule to every sponsor case", async () => {
    const schema = createClassificationSchema({ focusConfigured: true });
    const comments = CASES.map((c) => comment(c.id));
    const results = parseClassifierOutput(await new FakeClassifier().classify({ comments, schema, focus: FOCUS }), comments, schema);
    expect(results.map((r) => [r.commentId, r.targets.focus])).toEqual(CASES.map((c) => [c.id, c.focus]));
  });

  it("ad-format complaints never add to the focus target's negative count", async () => {
    const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    if (outcome.status !== "completed") throw new Error("expected completed");
    const focus = outcome.report.metrics.targets.find((t) => t.target === "focus")!;
    const negative = focus.sentiment.rows.find((r) => r.label === "negative")!.count;

    const brandDirectedNegatives = FIXTURE.comments.filter((c) => c.gold.targets.focus === "negative").map((c) => c.id);
    expect(brandDirectedNegatives).toEqual(["m2-c06", "m2-c11", "m2-c28"]);
    expect(negative).toBe(brandDirectedNegatives.length);
    const adFormat = FIXTURE.comments.filter((c) => c.tags.some((t) => t.startsWith("sponsor_ad_format")));
    expect(adFormat.every((c) => c.gold.targets.focus === "not_addressed")).toBe(true);
    // Negative ad-format complaints (m2-c05, m2-c27) count toward content, as before.
    const negativeAdFormat = FIXTURE.comments.filter((c) => c.tags.includes("sponsor_ad_format_negative")).map((c) => [c.id, c.gold.targets.content]);
    expect(negativeAdFormat).toEqual([["m2-c05", "negative"], ["m2-c27", "negative"]]);
  });
});
