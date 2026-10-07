// Core domain types. Framework- and infrastructure-independent.

/** Primary comment type (spec.md §6.2). Exactly one per comment. */
export const COMMENT_TYPES = ["opinion", "question", "request", "joke_reaction", "spam_irrelevant", "other"] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];

/**
 * Sentiment labels (spec.md §6.3). `mixed` is a candidate label only: it is part of the label vocabulary but is
 * enabled per classification schema (see classification/schema.ts), never by default.
 */
export const SENTIMENT_LABELS = ["positive", "neutral", "negative", "mixed"] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

/** Bounded sentiment targets (spec.md §6.4.1). Other/general is not a target: overall sentiment covers it. */
export const TARGETS = ["creator", "content", "focus"] as const;
export type Target = (typeof TARGETS)[number];

export type TargetLabel = "not_addressed" | SentimentLabel;

/** How the focus target is referenced. Derived by the engine, never supplied by a classifier (spec.md §6.4.4). */
export type FocusMentionType = "explicit" | "inferred" | "none";

/** Where analysed comments come from. Compliance policy decisions depend on this. */
export type SourceOrigin = "youtube" | "synthetic_fixture" | "human_written" | "licensed" | "owner_authorized";

/** A top-level comment as handed to the engine. Text is untrusted input. */
export interface CommentInput {
  id: string;
  text: string;
}

/** User-specified focus brand/product/sponsor/company (spec.md F4). */
export interface FocusTarget {
  name: string;
  aliases: string[];
  /**
   * Known relationship to the analysed video: true = the focus target sponsors the video, false = it does not,
   * undefined = unknown. Supplied by the user/dataset; never inferred from names, comments or other text.
   */
  isVideoSponsor?: boolean;
}

/** One validated classification. `targets.focus` exists if and only if a focus target was configured. */
export interface CommentClassification {
  commentId: string;
  type: CommentType;
  isQuestion: boolean;
  isRequest: boolean;
  sentiment: SentimentLabel;
  targets: { creator: TargetLabel; content: TargetLabel; focus?: TargetLabel };
}

export interface ClassifiedComment {
  comment: CommentInput;
  classification: CommentClassification;
  /** Present only when a focus target was configured. */
  focusMention?: FocusMentionType;
}
