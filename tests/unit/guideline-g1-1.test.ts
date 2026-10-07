import { describe, expect, it } from "vitest";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import {
  AMBIGUOUS_TARGET_RULE,
  COMMENT_TYPE_DEFINITIONS,
  GUIDELINE_VERSION,
  HUMOR_RULE,
  IMPLICIT_CONTENT_TARGET_RULE,
  SPONSOR_SEGMENT_RULE,
  TARGET_DEFINITIONS,
} from "../../src/core/classification/guidelines";
import { buildClassifierInstructions, PROMPT_VERSION } from "../../src/core/classification/llm-prompt";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { FIXTURE, FOCUS, goldDeps, VIDEO_ID } from "../helpers";

// Guideline g1.1: explicit rules for the three previously implicit annotation decisions. These rules remain in force
// in later guideline versions; exact version identifiers are asserted in guideline-g1-2.test.ts.

const gold = (id: string) => FIXTURE.comments.find((c) => c.id === id)!.gold;

describe("guideline g1.1 — versioning", () => {
  it("its rules are carried into the prompt together with the current versions", () => {
    const prompt = buildClassifierInstructions(createClassificationSchema({ focusConfigured: true }));
    expect(prompt).toContain(`guideline ${GUIDELINE_VERSION}, prompt ${PROMPT_VERSION}`);
    for (const rule of [HUMOR_RULE, IMPLICIT_CONTENT_TARGET_RULE, AMBIGUOUS_TARGET_RULE, SPONSOR_SEGMENT_RULE]) expect(prompt).toContain(rule);
  });

  it("is recorded in report methodology", async () => {
    const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    if (outcome.status !== "completed") throw new Error("expected completed");
    expect(outcome.report.methodology.guidelineVersion).toBe(GUIDELINE_VERSION);
  });
});

describe("rule 1 — humour / meme format vs substantive evaluation", () => {
  it("states that humour alone does not imply joke_reaction", () => {
    expect(HUMOR_RULE).toMatch(/Humour alone does not\s+make a comment joke_reaction/);
    expect(COMMENT_TYPE_DEFINITIONS.joke_reaction).toMatch(/little or no substantive evaluative content/);
  });

  it("m2-c22 (meme format with a substantive negative evaluation) is an opinion, negative, about the content", () => {
    expect(gold("m2-c22")).toEqual({
      type: "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment: "negative",
      targets: { creator: "not_addressed", content: "negative", focus: "not_addressed" },
    });
  });

  it("pure reactions without an evaluative proposition stay joke_reaction", () => {
    expect(gold("m2-c20")).toMatchObject({ type: "joke_reaction", sentiment: "neutral" }); // "😂😂😂"
  });
});

describe("rule 2 — implicit content target for standalone evaluations", () => {
  it("m2-c58 'Meh.' targets content", () => {
    expect(gold("m2-c58")).toEqual({
      type: "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment: "negative",
      targets: { creator: "not_addressed", content: "negative", focus: "not_addressed" },
    });
  });

  it("does not apply when the evaluation clearly targets the focus brand", () => {
    expect(IMPLICIT_CONTENT_TARGET_RULE).toMatch(/Do not apply this when the comment clearly refers to the focus/);
    expect(gold("m2-c06").targets).toEqual({ creator: "not_addressed", content: "not_addressed", focus: "negative" }); // "Acme VPN is a scam…"
  });
});

describe("rule 3 — sponsor/ad complaints count toward content, never the brand", () => {
  it("m2-c08 'Acme again? ugh.' keeps focus not_addressed and counts toward content", () => {
    expect(gold("m2-c08")).toEqual({
      type: "opinion",
      isQuestion: false,
      isRequest: false,
      sentiment: "negative",
      targets: { creator: "not_addressed", content: "negative", focus: "not_addressed" },
    });
  });

  it("covers repetition, duration and integration, and routes experience complaints to content", () => {
    for (const word of ["presence", "repetition", "placement", "duration", "skipping", "format", "integration"]) expect(SPONSOR_SEGMENT_RULE).toContain(word);
    expect(SPONSOR_SEGMENT_RULE).toMatch(/count it as CONTENT sentiment/);
    expect(TARGET_DEFINITIONS.content).toMatch(/ad placement and repetition/);
  });

  it("explicit mention detection stays separate from focus sentiment (m2-c08)", async () => {
    const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    if (outcome.status !== "completed") throw new Error("expected completed");
    const c08 = outcome.classified.find((c) => c.comment.id === "m2-c08")!;
    expect(c08.focusMention).toBe("explicit");
    expect(c08.classification.targets.focus).toBe("not_addressed");
    const focus = outcome.report.metrics.targets.find((t) => t.target === "focus")!;
    expect(focus.mentions.count).toBe(8); // unchanged: an explicit name match alone is not a focus mention
    expect(focus.focusReferences).toEqual({ explicit: 6, inferred: 2 });
  });
});

describe("rule 4 — ambiguous targets", () => {
  it("states that brand mentions and generic pronouns do not create targets by themselves", () => {
    expect(AMBIGUOUS_TARGET_RULE).toMatch(/brand mention alone does not make the focus target addressed/);
    expect(AMBIGUOUS_TARGET_RULE).toMatch(/"he", "bro", or "they" does not make the creator the target/);
  });

  it("m2-c22 uses 'bro' but does not target the creator", () => {
    expect(gold("m2-c22").targets.creator).toBe("not_addressed");
  });
});
