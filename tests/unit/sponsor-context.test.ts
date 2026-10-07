import { describe, expect, it } from "vitest";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import { ADDRESSED_TARGET_RULE, GUIDELINE_VERSION, SPONSOR_REFERENCE_RULE, TARGET_DEFINITIONS } from "../../src/core/classification/guidelines";
import { buildClassifierData, buildClassifierInstructions, PROMPT_VERSION } from "../../src/core/classification/llm-prompt";
import { createClassificationSchema } from "../../src/core/classification/schema";
import type { FocusTarget } from "../../src/core/domain/types";
import type { ClassificationRequest, Classifier } from "../../src/core/ports";
import { FIXTURE, FOCUS, goldClassifier, goldDeps, VIDEO_ID } from "../helpers";

// Explicit sponsor context: FocusTarget.isVideoSponsor → engine → classification request → prompt payload.

const comments = [{ id: "a", text: "Is the discount code still working?" }];

function payloadFocus(focus: FocusTarget | undefined): unknown {
  const data = buildClassifierData(comments, focus);
  const json = data.slice(data.indexOf("<comment_data>") + "<comment_data>".length, data.indexOf("</comment_data>"));
  return (JSON.parse(json) as { focus_target: unknown }).focus_target;
}

/** Wraps the gold fake and records the focus object the engine hands to the classifier. */
function recordingClassifier(): Classifier & { seen: (FocusTarget | undefined)[] } {
  const inner = goldClassifier();
  const seen: (FocusTarget | undefined)[] = [];
  return {
    label: "recording",
    seen,
    classify(request: ClassificationRequest) {
      seen.push(request.focus);
      return inner.classify(request);
    },
  };
}

describe("sponsor context in the prompt payload", () => {
  it("serializes isVideoSponsor: true", () => {
    expect(payloadFocus({ name: "Acme VPN", aliases: ["Acme"], isVideoSponsor: true })).toEqual({ name: "Acme VPN", aliases: ["Acme"], is_video_sponsor: true });
  });

  it("serializes isVideoSponsor: false", () => {
    expect(payloadFocus({ name: "Acme VPN", aliases: [], isVideoSponsor: false })).toEqual({ name: "Acme VPN", aliases: [], is_video_sponsor: false });
  });

  it("serializes unknown sponsorship as null", () => {
    expect(payloadFocus({ name: "Acme VPN", aliases: [] })).toEqual({ name: "Acme VPN", aliases: [], is_video_sponsor: null });
  });

  it("sends no focus object when no focus target is configured", () => {
    expect(payloadFocus(undefined)).toBeNull();
  });
});

describe("sponsor context through the engine (normalizeFocus)", () => {
  it.each<[string, boolean | undefined]>([
    ["true", true],
    ["false", false],
    ["unknown", undefined],
  ])("preserves isVideoSponsor = %s while normalizing name and aliases", async (_name, isVideoSponsor) => {
    const classifier = recordingClassifier();
    const focus: FocusTarget = { name: "  Acme VPN ", aliases: [" Acme ", ""], ...(isVideoSponsor === undefined ? {} : { isVideoSponsor }) };
    await runAnalysis({ videoId: VIDEO_ID, focus }, goldDeps({ classifier }));
    const expected: FocusTarget = { name: "Acme VPN", aliases: ["Acme"], ...(isVideoSponsor === undefined ? {} : { isVideoSponsor }) };
    expect(classifier.seen[0]).toEqual(expected);
  });

  it("never infers sponsorship: a focus named 'Sponsor Inc' with no flag stays unknown", async () => {
    const classifier = recordingClassifier();
    await runAnalysis({ videoId: VIDEO_ID, focus: { name: "Sponsor Inc", aliases: ["the sponsor"] } }, goldDeps({ classifier }));
    expect(classifier.seen[0]).not.toHaveProperty("isVideoSponsor");
  });
});

describe("rule E is conditional on is_video_sponsor", () => {
  const prompt = buildClassifierInstructions(createClassificationSchema({ focusConfigured: true }));

  it("states the sponsor-reference rule only under an explicit is_video_sponsor === true condition", () => {
    expect(prompt).toContain(`Apply the following rule ONLY when is_video_sponsor is true: ${SPONSOR_REFERENCE_RULE}`);
    expect(prompt).toContain("When is_video_sponsor is false or null, do not treat the indirect references described in that rule as referring to the focus target.");
    expect(prompt).toContain("Never infer it from the name, aliases or comments.");
    // The rule text appears exactly once, always behind the condition.
    expect(prompt.split(SPONSOR_REFERENCE_RULE)).toHaveLength(2);
  });

  it("does not mention sponsorship context when no focus target is configured", () => {
    const noFocus = buildClassifierInstructions(createClassificationSchema({ focusConfigured: false }));
    expect(noFocus).not.toContain("is_video_sponsor");
    expect(noFocus).not.toContain(SPONSOR_REFERENCE_RULE);
  });
});

describe("benchmark fixture sponsor context", () => {
  it("declares the dataset-level sponsorship fact explicitly", () => {
    expect(FIXTURE.focus).toEqual({ name: "Acme VPN", aliases: ["Acme"], isVideoSponsor: true });
    expect(FOCUS.isVideoSponsor).toBe(true);
  });

  it("existing sponsor gold labels are unchanged", () => {
    const gold = (id: string) => FIXTURE.comments.find((c) => c.id === id)!.gold;
    expect(gold("m2-c56")).toMatchObject({ type: "question", sentiment: "neutral", targets: { focus: "neutral" } });
    expect(gold("m2-c11")).toMatchObject({ type: "opinion", sentiment: "negative", targets: { focus: "negative" } });
    expect(gold("m2-c08")).toMatchObject({ type: "opinion", sentiment: "negative", targets: { focus: "not_addressed", content: "negative" } });
  });
});

describe("guideline g1.2 consistency after the final fix", () => {
  it("the focus definition defers to ADDRESSED_TARGET_RULE instead of contradicting it", () => {
    expect(TARGET_DEFINITIONS.focus).toBe("The user-specified brand/product/sponsor/company, as addressed under ADDRESSED_TARGET_RULE.");
    expect(TARGET_DEFINITIONS.focus).not.toMatch(/only sentiment/);
    expect(ADDRESSED_TARGET_RULE).toContain("asks about it");
  });

  it("versions: guideline and fixture are g1.4 (superseding g1.2), prompt is clf-p4", () => {
    expect(GUIDELINE_VERSION).toBe("g1.4");
    expect(FIXTURE.guidelineVersion).toBe("g1.4");
    expect(PROMPT_VERSION).toBe("clf-p4");
  });
});
