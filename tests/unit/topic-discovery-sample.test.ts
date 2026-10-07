import { describe, expect, it } from "vitest";
import type { ClassifiedComment, CommentType, FocusMentionType, SentimentLabel } from "../../src/core/domain/types";
import { DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, discoveryCandidateOf, selectDiscoverySample as selectFromCandidates, type DiscoverySampleParameters } from "../../src/core/topics/discovery-sample";
import { spam } from "../topic-helpers";

const params = (overrides: Partial<DiscoverySampleParameters> = {}): DiscoverySampleParameters => ({ ...DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, seed: "seed-one", ...overrides });
/** The sampler works on candidates; tests build classified comments and convert them. */
const selectDiscoverySample = (base: ClassifiedComment[], p: DiscoverySampleParameters) => selectFromCandidates(base.map(discoveryCandidateOf), p);
const LONG = "this comment has enough words to be substantive";

function comment(id: string, sentiment: SentimentLabel, opts: { type?: CommentType; text?: string; focus?: FocusMentionType } = {}): ClassifiedComment {
  const c: ClassifiedComment = {
    comment: { id, text: opts.text ?? `${LONG} ${id}` },
    classification: {
      commentId: id,
      type: opts.type ?? "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment,
      targets: { creator: "not_addressed", content: "not_addressed" },
    },
  };
  if (opts.focus) c.focusMention = opts.focus;
  return c;
}
/** n comments with ids `${prefix}0000…`, all `sentiment`. */
const many = (n: number, prefix: string, sentiment: SentimentLabel, opts: Parameters<typeof comment>[2] = {}) =>
  Array.from({ length: n }, (_, i) => comment(`${prefix}${String(i).padStart(4, "0")}`, sentiment, opts));
const selectedIn = (ids: string[], prefix: string) => ids.filter((id) => id.startsWith(prefix)).length;

describe("discovery sample: small bases", () => {
  it("uses every non-spam comment when the base fits, in input order", () => {
    const base = [...many(5, "pos", "positive"), spam("sp1"), ...many(3, "neg", "negative")];
    const s = selectDiscoverySample(base, params());
    expect(s.usedAll).toBe(true);
    expect(s.commentIds).toEqual(base.filter((c) => c.classification.type !== "spam_irrelevant").map((c) => c.comment.id));
    expect(s.commentIds).not.toContain("sp1");
    expect(s.strata).toEqual([
      { key: "substantive:negative", available: 3, selected: 3 },
      { key: "substantive:positive", available: 5, selected: 5 },
    ]);
  });

  it("an exact fit uses everything", () => {
    expect(selectDiscoverySample(many(400, "pos", "positive"), params()).commentIds).toHaveLength(400);
  });
});

describe("discovery sample: large bases", () => {
  // 900 positive, 60 negative, 40 neutral substantive; 300 trivial positive; 50 spam.
  const base = [
    ...many(900, "pos", "positive"),
    ...many(60, "neg", "negative"),
    ...many(40, "neu", "neutral"),
    ...many(300, "tri", "positive", { type: "joke_reaction", text: "tiny reply" }),
    ...Array.from({ length: 50 }, (_, i) => spam(`sp${i}`)),
  ];
  const s = selectDiscoverySample(base, params());

  it("selects exactly maxSize comments, never spam", () => {
    expect(s.usedAll).toBe(false);
    expect(s.commentIds).toHaveLength(400);
    expect(selectedIn(s.commentIds, "sp")).toBe(0);
  });

  it("caps trivial comments at 10% and keeps minority sentiments represented", () => {
    expect(selectedIn(s.commentIds, "tri")).toBe(40);
    expect(selectedIn(s.commentIds, "neg")).toBeGreaterThanOrEqual(10);
    expect(selectedIn(s.commentIds, "neu")).toBeGreaterThanOrEqual(10);
    // D'Hondt keeps the substantive pool roughly proportional after the per-label floor.
    expect(selectedIn(s.commentIds, "pos")).toBeGreaterThan(selectedIn(s.commentIds, "neg"));
  });

  it("records the composition; availables sum to the non-spam base and selections to the sample", () => {
    expect(s.strata.reduce((sum, x) => sum + x.available, 0)).toBe(1300);
    expect(s.strata.reduce((sum, x) => sum + x.selected, 0)).toBe(400);
    expect(s.strata.find((x) => x.key === "trivial:positive")).toEqual({ key: "trivial:positive", available: 300, selected: 40 });
  });

  it("is deterministic for the same input and seed, and independent of input order", () => {
    expect(selectDiscoverySample(base, params())).toEqual(s);
    const shuffled = [...base].reverse();
    expect(new Set(selectDiscoverySample(shuffled, params()).commentIds)).toEqual(new Set(s.commentIds));
  });

  it("changes with the seed", () => {
    expect(selectDiscoverySample(base, params({ seed: "seed-two" })).commentIds).not.toEqual(s.commentIds);
  });

  it("gives unused trivial slots to substantive comments", () => {
    const fewTrivial = [...many(900, "pos", "positive"), ...many(5, "tri", "neutral", { text: "two words" })];
    const r = selectDiscoverySample(fewTrivial, params());
    expect(selectedIn(r.commentIds, "tri")).toBe(5);
    expect(r.commentIds).toHaveLength(400);
  });

  it("treats short comments as trivial by word count, whatever their type", () => {
    const shortOpinions = [...many(900, "pos", "positive"), ...many(100, "sho", "negative", { text: "so bad" })];
    expect(selectedIn(selectDiscoverySample(shortOpinions, params()).commentIds, "sho")).toBe(40);
  });
});

describe("discovery sample: focus reserve", () => {
  it("reserves up to 15% for focus-mentioning comments; the rest compete normally", () => {
    const base = [...many(900, "pos", "positive"), ...many(100, "foc", "negative", { focus: "explicit" })];
    const s = selectDiscoverySample(base, params());
    expect(selectedIn(s.commentIds, "foc")).toBeGreaterThanOrEqual(60);
    expect(s.strata.find((x) => x.key === "focus:negative")).toEqual({ key: "focus:negative", available: 60, selected: 60 });
    expect(s.strata.reduce((sum, x) => sum + x.available, 0)).toBe(1000);
  });

  it("ignores focus mention type `none` and does not reserve without focus comments", () => {
    const base = [...many(900, "pos", "positive", { focus: "none" }), ...many(100, "neg", "negative", { focus: "none" })];
    const s = selectDiscoverySample(base, params());
    expect(s.strata.some((x) => x.key.startsWith("focus:"))).toBe(false);
    expect(s.commentIds).toHaveLength(400);
  });
});

describe("discovery sample: parameters", () => {
  it("rejects an invalid size", () => {
    expect(() => selectDiscoverySample([], params({ maxSize: 0 }))).toThrow(RangeError);
  });

  it("returns an empty sample for an empty or all-spam base", () => {
    expect(selectDiscoverySample([spam("sp1")], params()).commentIds).toEqual([]);
  });
});
