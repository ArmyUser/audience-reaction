import { describe, expect, it } from "vitest";
import {
  FLAG_DEFINITIONS,
  GUIDELINE_VERSION,
  QUESTION_VS_REQUEST_RULE,
  REQUEST_TARGET_INDEPENDENCE_RULE,
  SPONSOR_AD_EXPERIENCE_RULE,
  SPONSOR_SEGMENT_RULE,
  TYPE_VS_FLAGS_RULE,
} from "../../src/core/classification/guidelines";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseClassifierOutput } from "../../src/core/classification/validation";
import { FIXTURE } from "../helpers";

// Guideline g1.4: two general rules added after three jev-q2 runs showed the same systematic errors. They make
// existing policy explicit (spec §6.4.4; the question/request flag definitions); no gold label changes.

const gold = (id: string) => FIXTURE.comments.find((c) => c.id === id)!.gold;
const NONE = { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" };

describe("guideline g1.4 — versions", () => {
  it("guideline and fixture are g1.4", () => {
    expect(GUIDELINE_VERSION).toBe("g1.4");
    expect(FIXTURE.guidelineVersion).toBe("g1.4");
    expect(FIXTURE.description).toContain("guideline g1.4 ");
  });
});

// Rule examples with their full g1.4 labels (focus = Acme VPN, the video's sponsor). Not part of the m2 gold set.
const AD_EXAMPLES = [
  { id: "g14-p1", text: "the ad was way too long", sentiment: "negative", targets: { ...NONE, content: "negative" } },
  { id: "g14-p2", text: "ugh another Acme ad", sentiment: "negative", targets: { ...NONE, content: "negative" } },
  { id: "g14-p3", text: "Acme VPN is terrible", sentiment: "negative", targets: { ...NONE, focus: "negative" } },
  { id: "g14-p4", text: "Acme VPN is buggy and overpriced", sentiment: "negative", targets: { ...NONE, focus: "negative" } },
] as const;

const QUESTION_REQUEST_EXAMPLES = [
  { id: "g14-q1", text: "What mic are you using?", type: "question", isQuestion: true, isRequest: false },
  { id: "g14-q2", text: "Is the discount code still working?", type: "question", isQuestion: true, isRequest: false },
  { id: "g14-q3", text: "Does it support Linux?", type: "question", isQuestion: true, isRequest: false },
  { id: "g14-q4", text: "Please make a full review", type: "request", isQuestion: false, isRequest: true },
  { id: "g14-q5", text: "Could you cover battery life next time?", type: "request", isQuestion: false, isRequest: true },
  { id: "g14-q6", text: "Would love a follow-up in six months", type: "request", isQuestion: false, isRequest: true },
] as const;

describe("rule P — sponsor/ad experience vs the focus target", () => {
  it("states the general rule, not only examples", () => {
    for (const clause of [
      "A complaint about the presence, duration, frequency, placement, intrusiveness or format of a sponsored segment or advertisement is a complaint about the viewing experience",
      "it addresses the content, usually with negative content sentiment, and does not address the focus target, even when it names the sponsor brand",
      "A reference to the sponsor brand, or to the fact that it sponsors the video or channel, does not by itself make the focus target addressed",
      "The focus target is addressed only when the comment evaluates, asks about, reports an experience with, or explicitly requests an action concerning the brand or product itself",
      "A comment that does both is labelled for each part separately.",
    ])
      expect(SPONSOR_AD_EXPERIENCE_RULE).toContain(clause);
    // Consistent with the existing sponsor-segment rule, which stays unchanged.
    expect(SPONSOR_SEGMENT_RULE).toContain("is NOT negative sentiment toward the focus target");
  });

  it.each(AD_EXAMPLES)("example $text is in the rule text", ({ text }) => {
    expect(SPONSOR_AD_EXPERIENCE_RULE).toContain(`'${text}'`);
  });

  it("names the sponsorship-only example as not addressing the focus target", () => {
    expect(SPONSOR_AD_EXPERIENCE_RULE).toContain("'Acme VPN keeps sponsoring this channel' does not address the focus target unless it also evaluates the brand or product");
  });

  it("example labels are valid classifications: ad complaints are content-only, brand evaluations focus-only", () => {
    const schema = createClassificationSchema({ focusConfigured: true });
    const comments = AD_EXAMPLES.map((e) => ({ id: e.id, text: e.text }));
    const raw = { results: AD_EXAMPLES.map((e) => ({ commentId: e.id, type: "opinion", isQuestion: false, isRequest: false, sentiment: e.sentiment, targets: e.targets })) };
    expect(parseClassifierOutput(raw, comments, schema)).toHaveLength(AD_EXAMPLES.length);
    for (const e of AD_EXAMPLES.slice(0, 2)) expect(e.targets).toEqual({ creator: "not_addressed", content: "negative", focus: "not_addressed" });
    for (const e of AD_EXAMPLES.slice(2)) expect(e.targets).toEqual({ creator: "not_addressed", content: "not_addressed", focus: "negative" });
  });

  it("the m2 gold labels already follow the rule (no gold change needed)", () => {
    // Ad-format complaints, including those naming the brand: content negative, focus not addressed.
    for (const id of ["m2-c05", "m2-c08", "m2-c27"]) expect(gold(id).targets).toEqual({ ...NONE, content: "negative" });
    // A comment that does both: the ad part is content, the brand experience is focus.
    expect(gold("m2-c07").targets).toEqual({ creator: "not_addressed", content: "negative", focus: "positive" });
    // Brand evaluations and questions about the product itself address the focus target.
    expect(gold("m2-c06").targets.focus).toBe("negative");
    expect(gold("m2-c56").targets.focus).toBe("neutral");
    // Mentioning sponsorship while evaluating the creator does not address the focus target.
    expect(gold("m2-c53").targets).toEqual({ creator: "positive", content: "not_addressed", focus: "not_addressed" });
  });

  it("every gold comment tagged as an ad-format complaint leaves the focus target not addressed", () => {
    const adFormat = FIXTURE.comments.filter((c) => c.tags.some((t) => t === "sponsor_ad_format_negative" || t === "sponsor_ad_format_neutral" || t === "sponsor_ambiguous"));
    expect(adFormat.map((c) => c.id)).toEqual(["m2-c05", "m2-c08", "m2-c10", "m2-c27"]);
    for (const c of adFormat) expect(c.gold.targets.focus, c.id).toBe("not_addressed");
  });
});

describe("rule Q — question vs request", () => {
  it("states the general rule, not only examples", () => {
    for (const clause of [
      "isQuestion and isRequest are independent decisions.",
      "A question that seeks information is not a request",
      "isRequest is false unless the comment also asks, wishes or calls for an action, change, follow-up, production or future behaviour",
      "A comment that asks, wishes or calls for such an action is a request, whether it is phrased as an imperative, a question or a wish",
      "A request phrased as a question ('Can you…?', 'Could you…?') does not by itself seek information, so it is not a genuine question.",
    ])
      expect(QUESTION_VS_REQUEST_RULE).toContain(clause);
    // Consistent with the unchanged flag definitions and g1.3 rules.
    expect(FLAG_DEFINITIONS.isRequest).toContain("asks the creator/brand to do something");
    expect(TYPE_VS_FLAGS_RULE).toContain("independent attributes");
    expect(REQUEST_TARGET_INDEPENDENCE_RULE).toContain("isRequest is independent of target addressing");
  });

  it.each(QUESTION_REQUEST_EXAMPLES)("example $text → isQuestion $isQuestion, isRequest $isRequest is in the rule text", ({ text }) => {
    expect(QUESTION_VS_REQUEST_RULE).toContain(`'${text}`);
  });

  it("example labels are valid classifications that never collapse question and request into one decision", () => {
    const schema = createClassificationSchema({ focusConfigured: false });
    const comments = QUESTION_REQUEST_EXAMPLES.map((e) => ({ id: e.id, text: e.text }));
    const raw = {
      results: QUESTION_REQUEST_EXAMPLES.map((e) => ({
        commentId: e.id,
        type: e.type,
        isQuestion: e.isQuestion,
        isRequest: e.isRequest,
        sentiment: "neutral",
        targets: { creator: "not_addressed", content: "not_addressed" },
      })),
    };
    expect(parseClassifierOutput(raw, comments, schema)).toHaveLength(QUESTION_REQUEST_EXAMPLES.length);
    for (const e of QUESTION_REQUEST_EXAMPLES) expect(e.isQuestion && e.isRequest).toBe(false);
  });

  it("the m2 gold labels already follow the rule (no gold change needed)", () => {
    for (const id of ["m2-c13", "m2-c14", "m2-c15", "m2-c19", "m2-c56"]) expect(gold(id), id).toMatchObject({ isQuestion: true, isRequest: false });
    for (const id of ["m2-c16", "m2-c17", "m2-c18", "m2-c57"]) expect(gold(id), id).toMatchObject({ isQuestion: false, isRequest: true });
  });

  it("no gold comment is both a question and a request", () => {
    for (const c of FIXTURE.comments) expect(c.gold.isQuestion && c.gold.isRequest, c.id).toBe(false);
  });
});
