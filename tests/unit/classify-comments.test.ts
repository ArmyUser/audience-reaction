import { describe, expect, it } from "vitest";
import { classifyComments } from "../../src/core/classification/classify-comments";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { validateClassifierOutput } from "../../src/core/classification/validation";
import type { CommentInput } from "../../src/core/domain/types";
import type { ClassificationRequest, Classifier } from "../../src/core/ports";

const schema = createClassificationSchema({ focusConfigured: false });
const comments: CommentInput[] = ["a", "b", "c"].map((id) => ({ id, text: id }));
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  commentId: id,
  type: "opinion",
  isQuestion: false,
  isRequest: false,
  sentiment: "positive",
  targets: { creator: "not_addressed", content: "positive" },
  ...extra,
});

/** Scripted classifier: returns the given raw response per call and records which ids were requested. */
function scripted(responses: ((req: ClassificationRequest) => unknown)[]): Classifier & { requested: string[][] } {
  const requested: string[][] = [];
  return {
    label: "scripted",
    requested,
    async classify(req) {
      requested.push(req.comments.map((c) => c.id));
      return responses[Math.min(requested.length - 1, responses.length - 1)]!(req);
    },
  };
}

describe("validateClassifierOutput — per-comment outcome", () => {
  it("accepts valid items and rejects only the broken ones", () => {
    const out = validateClassifierOutput({ results: [item("a"), item("b", { sentiment: "nope" })] }, comments, schema);
    expect(out.valid.map((v) => v.commentId)).toEqual(["a"]);
    expect(out.rejected.map((r) => r.commentId)).toEqual(["b", "c"]);
    expect(out.rejected[1]!.issues).toEqual(["missing classification"]);
  });

  it("reports question/request type-flag disagreement as a consistency issue without rejecting or correcting", () => {
    const out = validateClassifierOutput(
      { results: [item("a", { type: "question", isQuestion: false }), item("b", { type: "request", isRequest: false }), item("c")] },
      comments,
      schema,
    );
    expect(out.rejected).toEqual([]);
    expect(out.valid.find((v) => v.commentId === "a")).toMatchObject({ type: "question", isQuestion: false });
    expect(out.consistencyIssues).toEqual([
      { commentId: "a", rule: "question_type_without_question_flag" },
      { commentId: "b", rule: "request_type_without_request_flag" },
    ]);
  });

  it("rejects both copies of a duplicated id and reports unexpected ids", () => {
    const out = validateClassifierOutput({ results: [item("a"), item("a"), item("b"), item("c"), item("zzz")] }, comments, schema);
    expect(out.rejected).toEqual([{ commentId: "a", issues: ["duplicate classification"] }]);
    expect(out.responseIssues).toEqual(["unexpected comment id zzz"]);
  });

  it("rejects every comment when the response shape is wrong", () => {
    const out = validateClassifierOutput("I cannot do that", comments, schema);
    expect(out.valid).toEqual([]);
    expect(out.rejected).toHaveLength(3);
  });
});

describe("classifyComments — bounded per-comment retries", () => {
  it("re-requests only rejected comments", async () => {
    const c = scripted([() => ({ results: [item("a"), item("b", { type: "praise" })] }), (req) => ({ results: req.comments.map((x) => item(x.id)) })]);
    const result = await classifyComments(comments, c, schema, undefined, { retryRounds: 2 });
    expect(c.requested).toEqual([["a", "b", "c"], ["b", "c"]]);
    expect(result.classifications.map((x) => x.commentId)).toEqual(["a", "b", "c"]);
    expect(result.failures).toEqual([]);
    expect(result.validPerRound).toEqual([1, 2]);
  });

  it("stops after the retry budget and surfaces failures without labels", async () => {
    const c = scripted([() => ({ results: [item("a")] })]);
    const result = await classifyComments(comments, c, schema, undefined, { retryRounds: 1 });
    expect(c.requested).toHaveLength(2);
    expect(result.classifications.map((x) => x.commentId)).toEqual(["a"]);
    expect(result.failures.map((f) => f.commentId)).toEqual(["b", "c"]);
  });

  it("propagates classifier errors (e.g. invalid credentials)", async () => {
    const c: Classifier = { label: "x", classify: async () => { throw new Error("auth"); } };
    await expect(classifyComments(comments, c, schema, undefined)).rejects.toThrow("auth");
  });
});
