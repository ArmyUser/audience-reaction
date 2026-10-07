import { describe, expect, it } from "vitest";
import { GUIDELINE_VERSION } from "../../src/core/classification/guidelines";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseClassifierOutput } from "../../src/core/classification/validation";
import { FIXTURE, goldClassifier } from "../helpers";

const comments = FIXTURE.comments.map((c) => ({ id: c.id, text: c.text }));

describe("synthetic fixture set m2", () => {
  it("declares the guideline version its gold labels follow", () => {
    expect(FIXTURE.guidelineVersion).toBe(GUIDELINE_VERSION);
    expect(FIXTURE.description).toContain(`guideline ${GUIDELINE_VERSION} `);
  });

  it("has unique ids and enough non-spam comments for a report", () => {
    expect(new Set(comments.map((c) => c.id)).size).toBe(comments.length);
    expect(FIXTURE.comments.filter((c) => c.gold.type !== "spam_irrelevant").length).toBeGreaterThanOrEqual(50);
  });

  it.each([
    ["3 labels, focus", { focusConfigured: true }],
    ["3 labels, no focus", { focusConfigured: false }],
    ["4 labels (mixed candidate), focus", { focusConfigured: true, mixedEnabled: true }],
  ])("every gold label passes strict validation (%s)", async (_name, options) => {
    const schema = createClassificationSchema(options);
    const raw = await goldClassifier().classify({ comments, schema });
    expect(parseClassifierOutput(raw, comments, schema)).toHaveLength(comments.length);
  });

  it.each([
    "prompt_injection",
    "html_script",
    "sarcasm",
    "irony",
    "emoji",
    "slang",
    "mixed",
    "implicit_target",
    "explicit_brand",
    "sponsor",
    "question",
    "request",
    "spam",
    "off_topic",
    "very_short",
    "multiple_targets",
    "flag_on_opinion",
  ])("covers the difficult case %s", (tag) => {
    expect(FIXTURE.comments.some((c) => c.tags.includes(tag))).toBe(true);
  });
});
