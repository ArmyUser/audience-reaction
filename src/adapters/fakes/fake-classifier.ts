import { createFocusMatcher } from "../../core/classification/focus-matcher";
import type { ClassificationSchema } from "../../core/classification/schema";
import type { CommentType, SentimentLabel, TargetLabel } from "../../core/domain/types";
import type { ClassificationRequest, Classifier } from "../../core/ports";

const POSITIVE = ["love", "great", "amazing", "helpful", "best", "awesome", "excellent", "useful", "clear", "perfectly", "fair", "informative", "slaps", "🔥"];
const NEGATIVE = ["hate", "terrible", "awful", "worst", "bad", "scam", "annoying", "too long", "too loud", "crashing", "never connects", "lazy", "mid"];
const CONTENT_CUES = /\b(video|audio|editing|explanations?|intro|music|review|ad read|ad|ads|sponsor segment|segment)\b/;
const CREATOR_CUES = /\b(creator|love you|you're|you are)\b/;
/** Wording about the sponsored segment itself (presence, length, placement, skipping, repetition). */
const AD_FORMAT_CUES = /\b(ad|ads|ad read|sponsor|sponsored|segment|skip|skipped|again|twice)\b/;
const CLAUSE_SPLIT = /[.!;]|\bbut\b|\bthough\b/;

/**
 * Deterministic keyword-rule classifier for tests and the local demo. It never interprets comment text as
 * instructions: text is only matched against fixed keyword lists. Imperfect by design (no sarcasm handling).
 * It implements the sponsor-segment rule: clauses about the ad format never count toward the focus target.
 */
export class FakeClassifier implements Classifier {
  readonly label = "Fake classifier (keyword rules)";

  async classify(request: ClassificationRequest): Promise<unknown> {
    const matchesFocus = request.focus ? createFocusMatcher(request.focus) : () => false;
    return {
      results: request.comments.map((comment) => classifyOne(comment.id, comment.text.toLowerCase(), request.schema, matchesFocus)),
    };
  }
}

function classifyOne(commentId: string, text: string, schema: ClassificationSchema, matchesFocus: (t: string) => boolean) {
  if (text.includes("http") || text.includes("subscribe to my channel")) {
    return {
      commentId,
      type: "spam_irrelevant" satisfies CommentType,
      isQuestion: false,
      isRequest: false,
      sentiment: "neutral" satisfies SentimentLabel,
      targets: emptyTargets(schema),
    };
  }

  const clauses = text.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
  const overall = polarity(clauses, schema);
  const isRequest = text.startsWith("please") || /\b(can you make|could you|would love a)\b/.test(text);
  const isQuestion = !isRequest && text.includes("?") && text.trim() !== "?";
  const opinionated = overall !== "neutral";

  let type: CommentType;
  if (isRequest && !opinionated) type = "request";
  else if (isQuestion && !opinionated) type = "question";
  else if (/\b(lol|lmao)\b|😂/.test(text) && !opinionated) type = "joke_reaction";
  else if (opinionated) type = "opinion";
  else type = "other";

  // Content: clauses about the video, plus ad-format clauses even when they name the brand (sponsor-segment rule).
  const contentClauses = clauses.filter((c) => (CONTENT_CUES.test(c) && !matchesFocus(c)) || (matchesFocus(c) && AD_FORMAT_CUES.test(c)));
  const targets: Record<string, TargetLabel> = {
    creator: targetLabel(clauses.filter((c) => CREATOR_CUES.test(c)), schema),
    content: targetLabel(contentClauses, schema),
  };
  if (schema.focusConfigured) {
    const brandClauses = clauses.filter((c) => matchesFocus(c) && !AD_FORMAT_CUES.test(c));
    targets.focus = brandClauses.length === 0 ? "not_addressed" : polarity(brandClauses, schema);
  }

  return { commentId, type, isQuestion, isRequest, sentiment: overall, targets };
}

function emptyTargets(schema: ClassificationSchema): Record<string, TargetLabel> {
  return Object.fromEntries(schema.targets.map((t) => [t, "not_addressed" as const]));
}

function targetLabel(clauses: string[], schema: ClassificationSchema): TargetLabel {
  if (clauses.length === 0) return "not_addressed";
  return polarity(clauses, schema);
}

/** Positive/negative by keyword count; both present → `mixed` if enabled, else the last polarised clause decides. */
function polarity(clauses: string[], schema: ClassificationSchema): SentimentLabel {
  const scored = clauses.map((c) => hits(c, POSITIVE) - hits(c, NEGATIVE));
  const hasPositive = scored.some((s) => s > 0);
  const hasNegative = scored.some((s) => s < 0);
  if (hasPositive && hasNegative) {
    if (schema.mixedEnabled) return "mixed";
    const last = [...scored].reverse().find((s) => s !== 0)!;
    return last > 0 ? "positive" : "negative";
  }
  if (hasPositive) return "positive";
  if (hasNegative) return "negative";
  return "neutral";
}

/** Whole-word (or whole-emoji) keyword hits, so "mid" does not match "middle". */
function hits(text: string, words: readonly string[]): number {
  return words.filter((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(text)).length;
}
