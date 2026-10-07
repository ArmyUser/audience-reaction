import { describe, expect, it } from "vitest";
import { enforceSpamInvariant } from "../../src/core/classification/spam-invariant";
import { COMMENT_TYPES } from "../../src/core/domain/types";

const base = { isQuestion: false, isRequest: false, sentiment: "negative", targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" } };

describe("enforceSpamInvariant", () => {
  it("leaves internally consistent spam unchanged", () => {
    const c = { ...base, type: "spam_irrelevant" };
    expect(enforceSpamInvariant(c)).toEqual({ value: c, adjusted: [] });
  });

  it("clears contradictory question/request flags and reports the originals", () => {
    const out = enforceSpamInvariant({ ...base, type: "spam_irrelevant", isQuestion: true, isRequest: true });
    expect(out.value).toMatchObject({ isQuestion: false, isRequest: false });
    expect(out.adjusted).toEqual([{ field: "isQuestion", original: true }, { field: "isRequest", original: true }]);
  });

  it("clears contradictory targets and reports the originals", () => {
    const out = enforceSpamInvariant({ ...base, type: "spam_irrelevant", targets: { creator: "positive", content: "neutral", focus: "not_addressed" } });
    expect(out.value.targets).toEqual({ creator: "not_addressed", content: "not_addressed", focus: "not_addressed" });
    expect(out.adjusted).toEqual([{ field: "targets.creator", original: "positive" }, { field: "targets.content", original: "neutral" }]);
  });

  it("never changes the type or the overall sentiment, and keeps the target set", () => {
    const out = enforceSpamInvariant({ ...base, type: "spam_irrelevant", sentiment: "positive", isQuestion: true, targets: { creator: "negative", content: "positive" } });
    expect(out.value.type).toBe("spam_irrelevant");
    expect(out.value.sentiment).toBe("positive");
    expect(Object.keys(out.value.targets)).toEqual(["creator", "content"]);
  });

  it("always yields a result satisfying the invariant (exhaustive over flags and target labels)", () => {
    const labels = ["not_addressed", "positive", "neutral", "negative", "mixed"];
    for (const isQuestion of [true, false])
      for (const isRequest of [true, false])
        for (const creator of labels)
          for (const content of labels) {
            const { value } = enforceSpamInvariant({ ...base, type: "spam_irrelevant", isQuestion, isRequest, targets: { creator, content } });
            expect(value.isQuestion || value.isRequest).toBe(false);
            expect(Object.values(value.targets).every((t) => t === "not_addressed")).toBe(true);
          }
  });

  it.each(COMMENT_TYPES.filter((t) => t !== "spam_irrelevant"))("does not affect non-spam type %s", (type) => {
    const c = { ...base, type, isQuestion: true, isRequest: true, targets: { creator: "positive", content: "negative" } };
    expect(enforceSpamInvariant(c)).toEqual({ value: c, adjusted: [] });
  });
});
