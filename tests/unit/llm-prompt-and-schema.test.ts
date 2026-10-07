import { describe, expect, it } from "vitest";
import { classificationJsonSchema } from "../../src/core/classification/json-schema";
import { SPONSOR_SEGMENT_RULE } from "../../src/core/classification/guidelines";
import { buildClassifierData, buildClassifierInstructions, PROMPT_VERSION } from "../../src/core/classification/llm-prompt";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { FOCUS } from "../helpers";

const focus3 = createClassificationSchema({ focusConfigured: true });
const noFocus = createClassificationSchema({ focusConfigured: false });
const focus4 = createClassificationSchema({ focusConfigured: true, mixedEnabled: true });

describe("classifier prompt (versioned)", () => {
  it("defines every part of the schema and the rules", () => {
    const text = buildClassifierInstructions(focus3);
    expect(text).toContain(PROMPT_VERSION);
    for (const type of ["opinion", "question", "request", "joke_reaction", "spam_irrelevant", "other"]) expect(text).toContain(`- ${type}:`);
    for (const t of ["creator", "content", "focus"]) expect(text).toContain(`- ${t}:`);
    expect(text).toContain("isQuestion");
    expect(text).toContain("isRequest");
    expect(text).toContain(SPONSOR_SEGMENT_RULE);
    expect(text).toMatch(/SPAM \/ IRRELEVANT/);
    expect(text).toMatch(/untrusted DATA/);
  });

  it("describes mixed only when enabled; otherwise states the provisional benchmark guideline", () => {
    expect(buildClassifierInstructions(focus4)).toMatch(/Use "mixed" only for/);
    expect(buildClassifierInstructions(focus3)).toMatch(/There is no "mixed" label\. Provisional benchmark guideline/);
  });

  it("omits the focus target when none is configured", () => {
    expect(buildClassifierInstructions(noFocus)).not.toContain("- focus:");
    expect(buildClassifierData([{ id: "a", text: "x" }], undefined)).toContain('"focus_target":null');
  });

  it("puts the focus target in the data block as data", () => {
    const data = buildClassifierData([{ id: "a", text: "x" }], FOCUS);
    expect(data).toContain('"name":"Acme VPN"');
    expect(buildClassifierInstructions(focus3)).not.toContain("Acme");
  });
});

describe("classification JSON schema for structured output", () => {
  function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
    if (node && typeof node === "object") {
      visit(node as Record<string, unknown>);
      for (const v of Object.values(node)) walk(v, visit);
    }
  }

  it.each([
    ["3 labels + focus", focus3],
    ["no focus", noFocus],
    ["mixed candidate", focus4],
  ])("closes every object and uses only supported keywords (%s)", (_name, schema) => {
    walk(classificationJsonSchema(schema), (n) => {
      if (n.type === "object") expect(n.additionalProperties).toBe(false);
      for (const unsupported of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern"]) expect(n).not.toHaveProperty(unsupported);
    });
  });

  it("mirrors the label sets of the classification schema", () => {
    const s = classificationJsonSchema(focus4) as { properties: { results: { items: { properties: Record<string, { enum?: string[]; required?: string[] }> } } } };
    const item = s.properties.results.items.properties;
    expect(item.sentiment!.enum).toEqual(["positive", "neutral", "negative", "mixed"]);
    expect(item.targets!.required).toEqual(["creator", "content", "focus"]);
    const s3 = classificationJsonSchema(noFocus) as typeof s;
    expect(s3.properties.results.items.properties.sentiment!.enum).toEqual(["positive", "neutral", "negative"]);
    expect(s3.properties.results.items.properties.targets!.required).toEqual(["creator", "content"]);
  });
});
