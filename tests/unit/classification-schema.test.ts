import { describe, expect, it } from "vitest";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { ClassificationOutputError, parseClassifierOutput } from "../../src/core/classification/validation";
import type { CommentInput } from "../../src/core/domain/types";

const comments: CommentInput[] = [
  { id: "a", text: "x" },
  { id: "b", text: "y" },
];
const noFocus = createClassificationSchema({ focusConfigured: false });
const withFocus = createClassificationSchema({ focusConfigured: true });
const withMixed = createClassificationSchema({ focusConfigured: true, mixedEnabled: true });

const valid = (id: string, extra: Record<string, unknown> = {}) => ({
  commentId: id,
  type: "opinion",
  isQuestion: false,
  isRequest: false,
  sentiment: "positive",
  targets: { creator: "not_addressed", content: "positive" },
  ...extra,
});
const validFocus = (id: string, extra: Record<string, unknown> = {}) =>
  valid(id, { targets: { creator: "not_addressed", content: "positive", focus: "negative" }, ...extra });

function rejects(raw: unknown, schema = noFocus, pattern?: RegExp) {
  let error: unknown;
  try {
    parseClassifierOutput(raw, comments, schema);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ClassificationOutputError);
  if (pattern) expect((error as ClassificationOutputError).issues.join("\n")).toMatch(pattern);
}

describe("classification schema", () => {
  it("defaults to the three confirmed sentiment labels; mixed is opt-in", () => {
    expect(noFocus.sentimentLabels).toEqual(["positive", "neutral", "negative"]);
    expect(noFocus.mixedEnabled).toBe(false);
    expect(withMixed.sentimentLabels).toEqual(["positive", "neutral", "negative", "mixed"]);
  });

  it("includes the focus target only when a focus is configured", () => {
    expect(noFocus.targets).toEqual(["creator", "content"]);
    expect(withFocus.targets).toEqual(["creator", "content", "focus"]);
  });

  it("encodes the schema options in its version and is immutable", () => {
    expect(noFocus.version).not.toBe(withFocus.version);
    expect(withFocus.version).not.toBe(withMixed.version);
    expect(Object.isFrozen(withFocus)).toBe(true);
  });
});

describe("parseClassifierOutput — accepts valid output", () => {
  it("accepts a complete valid result set", () => {
    expect(parseClassifierOutput({ results: [valid("a"), valid("b")] }, comments, noFocus)).toHaveLength(2);
  });

  it("accepts question/request flags on a non-question primary type", () => {
    const out = parseClassifierOutput({ results: [valid("a", { isRequest: true }), valid("b", { isQuestion: true })] }, comments, noFocus);
    expect(out[0]).toMatchObject({ type: "opinion", isRequest: true });
  });

  it("accepts focus targets when a focus is configured, and mixed when enabled", () => {
    expect(parseClassifierOutput({ results: [validFocus("a"), validFocus("b")] }, comments, withFocus)).toHaveLength(2);
    const mixed = validFocus("b", { sentiment: "mixed", targets: { creator: "mixed", content: "positive", focus: "not_addressed" } });
    expect(parseClassifierOutput({ results: [validFocus("a"), mixed] }, comments, withMixed)).toHaveLength(2);
  });
});

describe("parseClassifierOutput — rejects malformed output (never coerces)", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["a string", "results"],
    ["results not an array", { results: "a,b" }],
    ["extra root field", { results: [valid("a"), valid("b")], note: "x" }],
  ])("rejects %s as output shape", (_name, raw) => rejects(raw));

  it.each<[string, Record<string, unknown>]>([
    ["missing type", { type: undefined }],
    ["missing sentiment", { sentiment: undefined }],
    ["missing targets", { targets: undefined }],
    ["unknown type label", { type: "praise" }],
    ["unknown sentiment label", { sentiment: "ecstatic" }],
    ["boolean as string", { isQuestion: "false" }],
    ["number as sentiment", { sentiment: 1 }],
    ["empty comment id", { commentId: "" }],
    ["extra field", { confidence: 0.9 }],
    ["unknown target key", { targets: { creator: "not_addressed", content: "positive", product: "positive" } }],
    ["unknown target label", { targets: { creator: "loves", content: "positive" } }],
    ["missing target", { targets: { creator: "not_addressed" } }],
  ])("rejects %s", (_name, patch) => {
    const bad = Object.fromEntries(Object.entries(valid("b", patch)).filter(([, v]) => v !== undefined));
    rejects({ results: [valid("a"), bad] });
  });

  it("rejects mixed when the candidate label is disabled", () => {
    rejects({ results: [valid("a"), valid("b", { sentiment: "mixed" })] }, noFocus);
    rejects({ results: [validFocus("a"), validFocus("b", { targets: { creator: "mixed", content: "positive", focus: "neutral" } })] }, withFocus);
  });

  it("rejects a focus target when none is configured, and a missing one when it is", () => {
    rejects({ results: [validFocus("a"), validFocus("b")] }, noFocus);
    rejects({ results: [valid("a"), valid("b")] }, withFocus);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["spam with a question flag", { type: "spam_irrelevant", sentiment: "neutral", isQuestion: true, targets: { creator: "not_addressed", content: "not_addressed" } }, /cannot carry/],
    ["spam addressing a target", { type: "spam_irrelevant", sentiment: "neutral", targets: { creator: "positive", content: "not_addressed" } }, /cannot address targets/],
  ])("rejects impossible combination: %s", (_name, patch, pattern) => rejects({ results: [valid("a"), valid("b", patch)] }, noFocus, pattern));

  it("does not reject question/request type-flag disagreement (reported as a consistency issue instead)", () => {
    const out = parseClassifierOutput({ results: [valid("a", { type: "question", isQuestion: false }), valid("b", { type: "request", isRequest: false })] }, comments, noFocus);
    expect(out.map((c) => [c.type, c.isQuestion, c.isRequest])).toEqual([["question", false, false], ["request", false, false]]);
  });

  it("rejects duplicate, unexpected, and missing classifications", () => {
    rejects({ results: [valid("a"), valid("a"), valid("b")] }, noFocus, /duplicate/);
    rejects({ results: [valid("a"), valid("b"), valid("zzz")] }, noFocus, /unexpected comment id/);
    rejects({ results: [valid("a")] }, noFocus, /missing classification \(b\)/);
    rejects({ results: [] }, noFocus, /missing classification/);
  });
});
