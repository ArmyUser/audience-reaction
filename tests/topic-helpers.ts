import type { ClassifiedComment, CommentType, SentimentLabel } from "../src/core/domain/types";

/** A validly classified comment for topic tests (no focus target). Spam gets neutral sentiment, as the policy requires. */
export function classified(id: string, sentiment: SentimentLabel, type: CommentType = "opinion"): ClassifiedComment {
  return {
    comment: { id, text: `synthetic comment ${id}` },
    classification: {
      commentId: id,
      type,
      isQuestion: false,
      isRequest: false,
      sentiment: type === "spam_irrelevant" ? "neutral" : sentiment,
      targets: { creator: "not_addressed", content: "not_addressed" },
    },
  };
}

export const spam = (id: string) => classified(id, "neutral", "spam_irrelevant");
