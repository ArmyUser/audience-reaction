import type { CommentClassification, CommentInput, FocusTarget } from "../domain/types";
import type { Classifier } from "../ports";
import type { ClassificationSchema } from "./schema";
import { validateClassifierOutput, type ConsistencyIssue, type RejectedClassification } from "./validation";

export interface ClassifyCommentsOptions {
  /** Extra rounds that re-request only the comments without a valid classification. */
  retryRounds: number;
}

export const DEFAULT_CLASSIFY_OPTIONS: Readonly<ClassifyCommentsOptions> = Object.freeze({ retryRounds: 2 });

export interface ClassifyCommentsResult {
  classifications: CommentClassification[];
  /** Comments that never received a valid classification. Surfaced, never defaulted to a label. */
  failures: RejectedClassification[];
  consistencyIssues: ConsistencyIssue[];
  responseIssues: string[];
  rounds: number;
  /** Comments that received a valid classification in each round (round 1 = first attempt). */
  validPerRound: number[];
}

/**
 * Provider-neutral per-comment fault tolerance: classify, validate each item, and retry only the rejected comments
 * for a bounded number of rounds. Errors thrown by the classifier (e.g. invalid credentials) propagate.
 */
export async function classifyComments(
  comments: readonly CommentInput[],
  classifier: Classifier,
  schema: ClassificationSchema,
  focus: FocusTarget | undefined,
  options: ClassifyCommentsOptions = DEFAULT_CLASSIFY_OPTIONS,
): Promise<ClassifyCommentsResult> {
  const classifications = new Map<string, CommentClassification>();
  const consistencyIssues: ConsistencyIssue[] = [];
  const responseIssues: string[] = [];
  let pending: readonly CommentInput[] = comments;
  let lastRejected: RejectedClassification[] = [];
  let rounds = 0;
  const validPerRound: number[] = [];

  while (pending.length > 0 && rounds <= options.retryRounds) {
    rounds += 1;
    const raw = await classifier.classify({ comments: pending, schema, ...(focus ? { focus } : {}) });
    const outcome = validateClassifierOutput(raw, pending, schema);
    validPerRound.push(outcome.valid.length);
    for (const c of outcome.valid) classifications.set(c.commentId, c);
    consistencyIssues.push(...outcome.consistencyIssues);
    responseIssues.push(...outcome.responseIssues);
    lastRejected = outcome.rejected;
    const retry = new Set(outcome.rejected.map((r) => r.commentId));
    pending = pending.filter((c) => retry.has(c.id));
  }

  return {
    classifications: comments.flatMap((c) => classifications.get(c.id) ?? []),
    failures: pending.length > 0 ? lastRejected : [],
    consistencyIssues,
    responseIssues,
    rounds,
    validPerRound,
  };
}
