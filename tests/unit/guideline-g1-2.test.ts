import { describe, expect, it } from "vitest";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import {
  ADDRESSED_TARGET_RULE,
  CREATOR_VS_WORK_RULE,
  GUIDELINE_VERSION,
  NON_FOCUS_SUBJECT_RULE,
  REACTION_SHORTHAND_RULE,
  SPONSOR_REFERENCE_RULE,
  TIMESTAMP_RULE,
} from "../../src/core/classification/guidelines";
import { buildClassifierInstructions, PROMPT_VERSION } from "../../src/core/classification/llm-prompt";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { FIXTURE, FOCUS, goldDeps, VIDEO_ID } from "../helpers";

// Guideline g1.2: final amendment before freezing the annotation policy and the m2 gold set.

const gold = (id: string) => FIXTURE.comments.find((c) => c.id === id)!.gold;
const withFocus = buildClassifierInstructions(createClassificationSchema({ focusConfigured: true }));
const noFocus = buildClassifierInstructions(createClassificationSchema({ focusConfigured: false }));
const G12_RULES = [CREATOR_VS_WORK_RULE, REACTION_SHORTHAND_RULE, NON_FOCUS_SUBJECT_RULE, ADDRESSED_TARGET_RULE, SPONSOR_REFERENCE_RULE, TIMESTAMP_RULE];

async function classifiedById() {
  const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
  if (outcome.status !== "completed") throw new Error("expected completed");
  return { outcome, byId: new Map(outcome.classified.map((c) => [c.comment.id, c])) };
}

describe("guideline g1.2 — versions", () => {
  // g1.3 and g1.4 supersede g1.2 by adding rules; the g1.2 rule texts below are unchanged.
  it("guideline, prompt, fixture and report methodology agree", async () => {
    expect(GUIDELINE_VERSION).toBe("g1.4");
    expect(PROMPT_VERSION).toBe("clf-p4");
    expect(FIXTURE.guidelineVersion).toBe("g1.4");
    expect(withFocus).toContain("guideline g1.4, prompt clf-p4");
    const { outcome } = await classifiedById();
    expect(outcome.report.methodology.guidelineVersion).toBe("g1.4");
  });
});

describe("guideline g1.2 — prompt alignment", () => {
  it("states every g1.2 rule verbatim", () => {
    for (const rule of G12_RULES) expect(withFocus).toContain(rule);
  });

  it("takes sponsor-reference examples only from the guideline", () => {
    // Outside the guideline's own rule text, the prompt must not carry its own list of sponsor references.
    const withoutRule = withFocus.split(SPONSOR_REFERENCE_RULE).join("");
    for (const phrase of ["discount code", "their app", "'the sponsor'", "\"the sponsor\""]) expect(withoutRule).not.toContain(phrase);
  });

  it("states the sponsor-reference rule only when a focus target is configured", () => {
    expect(noFocus).not.toContain(SPONSOR_REFERENCE_RULE);
    for (const rule of G12_RULES.filter((r) => r !== SPONSOR_REFERENCE_RULE)) expect(noFocus).toContain(rule);
  });
});

describe("rule A — creator vs creator's work", () => {
  it("is worded as agreed", () => {
    expect(CREATOR_VS_WORK_RULE).toContain("Criticism of the creator's diligence, competence, honesty or credibility");
    expect(CREATOR_VS_WORK_RULE).toContain("Criticism of the resulting information, claims, arguments, demonstrations or tests is CONTENT.");
  });

  it("m2-c33 'He clearly didn't test it properly.' criticises the creator's diligence → creator (unchanged)", () => {
    expect(gold("m2-c33").targets).toEqual({ creator: "negative", content: "not_addressed", focus: "not_addressed" });
  });

  it("m2-c25 'L take' criticises an argument → content (relabelled in g1.2)", () => {
    expect(gold("m2-c25")).toEqual({
      type: "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment: "negative",
      targets: { creator: "not_addressed", content: "negative", focus: "not_addressed" },
    });
  });
});

describe("rule B — reaction-only shorthand", () => {
  it("is worded as agreed", () => {
    expect(REACTION_SHORTHAND_RULE).toContain("with no stated object is joke_reaction");
    expect(REACTION_SHORTHAND_RULE).toContain("A shorthand with a stated object (for example 'W video' or 'L take') is an opinion.");
  });

  it("m2-c43 '🔥' (no object) is joke_reaction carrying its valence to overall and content", () => {
    expect(gold("m2-c43")).toMatchObject({ type: "joke_reaction", sentiment: "positive", targets: { content: "positive" } });
  });

  it("shorthand with a stated object is an opinion: m2-c24 'W video', m2-c25 'L take'", () => {
    expect(gold("m2-c24")).toMatchObject({ type: "opinion", sentiment: "positive" });
    expect(gold("m2-c25")).toMatchObject({ type: "opinion", sentiment: "negative" });
  });
});

describe("rule C — non-focus subject matter", () => {
  it("is worded as agreed", () => {
    expect(NON_FOCUS_SUBJECT_RULE).toContain("that are not the focus target address no target");
  });

  it("m2-c29 (price of the reviewed laptop) addresses no target but keeps its overall sentiment", () => {
    expect(gold("m2-c29")).toMatchObject({ type: "opinion", sentiment: "negative", targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" } });
  });
});

describe("rule D — meaning of 'target addressed'", () => {
  it("is worded as agreed", () => {
    expect(ADDRESSED_TARGET_RULE).toContain("it evaluates it, asks about it, or reports experience with it");
    expect(ADDRESSED_TARGET_RULE).toContain("A name that appears only incidentally is not addressed.");
  });

  it("asking about the brand addresses it without evaluation: m2-c13 focus neutral", () => {
    expect(gold("m2-c13")).toMatchObject({ type: "question", isQuestion: true, sentiment: "neutral", targets: { focus: "neutral" } });
  });

  it("an incidental name is not addressed: m2-c08 names Acme but focus stays not_addressed", async () => {
    expect(gold("m2-c08").targets.focus).toBe("not_addressed");
    const { byId } = await classifiedById();
    expect(byId.get("m2-c08")!.focusMention).toBe("explicit"); // mention detection is separate from addressing
  });
});

describe("rule E — indirect references to a sponsored focus target", () => {
  it("is worded as agreed", () => {
    expect(SPONSOR_REFERENCE_RULE).toContain("When the focus target is the video's sponsor");
    expect(SPONSOR_REFERENCE_RULE).toContain("'the discount code'");
  });

  it("m2-c56 'Is the discount code still working?' addresses the focus target through an inferred reference", async () => {
    expect(gold("m2-c56")).toMatchObject({ type: "question", isQuestion: true, sentiment: "neutral", targets: { focus: "neutral" } });
    const { byId } = await classifiedById();
    expect(byId.get("m2-c56")!.focusMention).toBe("inferred");
  });
});

describe("rule F — timestamp navigation vs timestamp reaction", () => {
  it("is worded as agreed", () => {
    expect(TIMESTAMP_RULE).toContain("Timestamps used as a reaction ('3:12 lmao') are joke_reaction.");
    expect(TIMESTAMP_RULE).toContain("Timestamps used to navigate ('skip to 4:30') are other");
  });

  it("m2-c10 'skip to 4:30 to get past the ad' is other, neutral, with no target", () => {
    expect(gold("m2-c10")).toEqual({
      type: "other",
      isQuestion: false,
      isRequest: false,
      sentiment: "neutral",
      targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" },
    });
  });

  it("a timestamp inside an explicit evaluation keeps that evaluation: m2-c54", () => {
    expect(gold("m2-c54")).toMatchObject({ type: "opinion", sentiment: "positive", targets: { content: "positive" } });
  });
});

describe("g1.2 changes only m2-c25", () => {
  it("leaves the audited and previously relabelled cases unchanged", () => {
    const unchanged: Record<string, string> = {
      "m2-c22": "opinion/negative/na/negative/na",
      "m2-c58": "opinion/negative/na/negative/na",
      "m2-c08": "opinion/negative/na/negative/na",
      "m2-c33": "opinion/negative/negative/na/na",
      "m2-c43": "joke_reaction/positive/na/positive/na",
      "m2-c29": "opinion/negative/na/na/na",
      "m2-c13": "question/neutral/na/na/neutral",
      "m2-c56": "question/neutral/na/na/neutral",
      "m2-c10": "other/neutral/na/na/na",
    };
    const short = (l: string) => (l === "not_addressed" ? "na" : l);
    for (const [id, expected] of Object.entries(unchanged)) {
      const g = gold(id);
      expect(`${g.type}/${g.sentiment}/${short(g.targets.creator)}/${short(g.targets.content)}/${short(g.targets.focus)}`, id).toBe(expected);
    }
  });
});
