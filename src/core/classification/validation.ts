import { z } from "zod";
import { COMMENT_TYPES, type CommentClassification, type CommentInput } from "../domain/types";
import type { ClassificationSchema } from "./schema";

export class ClassificationOutputError extends Error {
  override readonly name = "ClassificationOutputError";
  constructor(readonly issues: string[]) {
    super(`Invalid classifier output: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? " …" : ""}`);
  }
}

/**
 * Strict runtime schema for one classification. Nothing is coerced. Only combinations that are impossible by
 * definition are hard errors here; question/request type-flag agreement is a consistency rule (see below).
 */
export function classificationItemSchema(schema: ClassificationSchema) {
  const sentiment = z.enum(schema.sentimentLabels as [string, ...string[]]);
  const targetLabel = z.enum(["not_addressed", ...schema.sentimentLabels] as [string, ...string[]]);
  const targets = schema.focusConfigured
    ? z.strictObject({ creator: targetLabel, content: targetLabel, focus: targetLabel })
    : z.strictObject({ creator: targetLabel, content: targetLabel });

  return z
    .strictObject({
      commentId: z.string().min(1),
      type: z.enum(COMMENT_TYPES),
      isQuestion: z.boolean(),
      isRequest: z.boolean(),
      sentiment,
      targets,
    })
    .superRefine((item, ctx) => {
      if (item.type === "spam_irrelevant") {
        if (item.isQuestion || item.isRequest) {
          ctx.addIssue({ code: "custom", message: "spam/irrelevant comments cannot carry question/request flags" });
        }
        if (Object.values(item.targets).some((label) => label !== "not_addressed")) {
          ctx.addIssue({ code: "custom", message: "spam/irrelevant comments cannot address targets" });
        }
      }
    });
}

export type ConsistencyRule = "question_type_without_question_flag" | "request_type_without_request_flag";

export interface ConsistencyIssue {
  commentId: string;
  rule: ConsistencyRule;
}

/**
 * Consistency rules (M2 clarification): a primary type of question/request normally implies the matching flag.
 * Violations are reported, never auto-corrected, and do not invalidate an otherwise usable classification.
 */
export function consistencyIssuesOf(c: CommentClassification): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  if (c.type === "question" && !c.isQuestion) issues.push({ commentId: c.commentId, rule: "question_type_without_question_flag" });
  if (c.type === "request" && !c.isRequest) issues.push({ commentId: c.commentId, rule: "request_type_without_request_flag" });
  return issues;
}

export interface RejectedClassification {
  commentId: string;
  issues: string[];
}

export interface ValidationOutcome {
  /** Valid classifications for expected comments, one per id. */
  valid: CommentClassification[];
  /** Expected comments without a usable classification (invalid, duplicated, or missing). Never defaulted. */
  rejected: RejectedClassification[];
  /** Problems not attributable to an expected comment (wrong shape, unexpected ids, unattributable items). */
  responseIssues: string[];
  consistencyIssues: ConsistencyIssue[];
}

/**
 * Per-comment validation of raw classifier output against the schema and the exact set of input comments.
 * A malformed item rejects only its own comment, so isolated failures can be retried without failing everything.
 */
export function validateClassifierOutput(
  raw: unknown,
  comments: readonly CommentInput[],
  schema: ClassificationSchema,
): ValidationOutcome {
  const expected = new Set(comments.map((c) => c.id));
  const root = z.strictObject({ results: z.array(z.unknown()) }).safeParse(raw);
  if (!root.success) {
    const issue = `malformed response: ${root.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`;
    return { valid: [], rejected: comments.map((c) => ({ commentId: c.id, issues: [issue] })), responseIssues: [issue], consistencyIssues: [] };
  }

  const item = classificationItemSchema(schema);
  const byId = new Map<string, { valid?: CommentClassification; issues: string[]; count: number }>();
  const responseIssues: string[] = [];

  root.data.results.forEach((entry, index) => {
    const id = typeof entry === "object" && entry !== null && typeof (entry as { commentId?: unknown }).commentId === "string"
      ? (entry as { commentId: string }).commentId
      : undefined;
    if (id === undefined || !expected.has(id)) {
      responseIssues.push(id === undefined ? `results[${index}]: missing or invalid commentId` : `unexpected comment id ${id}`);
      return;
    }
    const slot = byId.get(id) ?? { issues: [], count: 0 };
    slot.count += 1;
    const parsed = item.safeParse(entry);
    if (parsed.success) slot.valid = parsed.data as CommentClassification;
    else slot.issues.push(...parsed.error.issues.map((i) => `${i.path.join(".") || "(item)"}: ${i.message}`));
    byId.set(id, slot);
  });

  const valid: CommentClassification[] = [];
  const rejected: RejectedClassification[] = [];
  for (const { id } of comments) {
    const slot = byId.get(id);
    if (!slot) rejected.push({ commentId: id, issues: ["missing classification"] });
    else if (slot.count > 1) rejected.push({ commentId: id, issues: ["duplicate classification"] });
    else if (!slot.valid) rejected.push({ commentId: id, issues: slot.issues });
    else valid.push(slot.valid);
  }
  return { valid, rejected, responseIssues, consistencyIssues: valid.flatMap(consistencyIssuesOf) };
}

/** Strict all-or-nothing variant: throws if any comment lacks a valid classification or the response has issues. */
export function parseClassifierOutput(
  raw: unknown,
  comments: readonly CommentInput[],
  schema: ClassificationSchema,
): CommentClassification[] {
  const outcome = validateClassifierOutput(raw, comments, schema);
  const issues = [
    ...outcome.responseIssues,
    ...outcome.rejected.map((r) => `${r.issues.join(", ")} (${r.commentId})`),
  ];
  if (issues.length > 0) throw new ClassificationOutputError(issues);
  return outcome.valid;
}
