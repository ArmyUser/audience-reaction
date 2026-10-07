import {
  ADDRESSED_TARGET_RULE,
  AMBIGUOUS_TARGET_RULE,
  COMMENT_TYPE_DEFINITIONS,
  CREATOR_VS_WORK_RULE,
  FLAG_DEFINITIONS,
  HUMOR_RULE,
  IMPLICIT_CONTENT_TARGET_RULE,
  MIXED_FALLBACK_RULE_CANDIDATE,
  NON_FOCUS_SUBJECT_RULE,
  REACTION_SHORTHAND_RULE,
  SARCASM_RULE,
  SPONSOR_REFERENCE_RULE,
  SPONSOR_SEGMENT_RULE,
  TARGET_DEFINITIONS,
  TIMESTAMP_RULE,
} from "../../../core/classification/guidelines";
import type { ClassificationSchema } from "../../../core/classification/schema";
import { COMMENT_TYPES, type CommentInput, type FocusTarget, type SentimentLabel, type Target } from "../../../core/domain/types";

// Mapping of the provider-neutral classification schema (guideline g1.2) to Jev question primitives.
// All definitions come from the guideline constants; only the phrasing of the question frame is Jev-specific.
// Any change to the question set must bump JEV_QUESTION_SET_VERSION.
export const JEV_QUESTION_SET_VERSION = "jev-q1";

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option key → description. Jev answers with exactly one of these keys. */
  criteria: Record<string, string>;
}

export interface JevNoulQuestion {
  type: "noul";
  /** A statement; Jev returns the probability that it is true. Noul takes no criteria. */
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

/** Question keys. Choice keys map 1:1 onto domain fields; noul keys map onto the two flags. */
export const JEV_KEYS = {
  type: "type",
  sentiment: "sentiment",
  isQuestion: "is_question",
  isRequest: "is_request",
  target: (t: Target) => `target_${t}`,
} as const;

const SPAM_TARGET_NOTE = 'If the comment is spam, irrelevant or off-topic, answer "not_addressed".';

const SENTIMENT_CRITERIA: Record<SentimentLabel, string> = {
  positive: "Overall favourable evaluation or emotion.",
  neutral: "No evaluative stance: informational, factual questions, neutral statements.",
  negative: "Overall unfavourable evaluation or emotion.",
  mixed: "Substantive positive and negative evaluations, neither dominant.",
};

const TARGET_RULES: Record<Target, readonly string[]> = {
  creator: [CREATOR_VS_WORK_RULE, AMBIGUOUS_TARGET_RULE],
  content: [CREATOR_VS_WORK_RULE, IMPLICIT_CONTENT_TARGET_RULE, AMBIGUOUS_TARGET_RULE, NON_FOCUS_SUBJECT_RULE, SPONSOR_SEGMENT_RULE],
  focus: [
    AMBIGUOUS_TARGET_RULE,
    SPONSOR_SEGMENT_RULE,
    `Apply the following rule ONLY when focus_target.is_video_sponsor is true: ${SPONSOR_REFERENCE_RULE}`,
    "When focus_target.is_video_sponsor is false or null, do not treat the indirect references described in that rule as referring to the focus target.",
  ],
};

/** The question set for one comment under the given classification schema (identical for every comment). */
export function buildJevQuestions(schema: ClassificationSchema): Record<string, JevQuestion> {
  const sentimentCriteria = Object.fromEntries(schema.sentimentLabels.map((l) => [l, SENTIMENT_CRITERIA[l]]));
  const targetCriteria = { not_addressed: "The comment does not address this target.", ...sentimentCriteria };
  const mixedNote = schema.mixedEnabled ? "" : ` There is no "mixed" option. Provisional benchmark guideline: ${MIXED_FALLBACK_RULE_CANDIDATE}`;

  const questions: Record<string, JevQuestion> = {
    [JEV_KEYS.type]: {
      type: "choice",
      instructions: [
        "What is the primary type of the comment in state.comment? Exactly one type.",
        HUMOR_RULE,
        REACTION_SHORTHAND_RULE,
        TIMESTAMP_RULE,
      ].join(" "),
      criteria: Object.fromEntries(COMMENT_TYPES.map((t) => [t, COMMENT_TYPE_DEFINITIONS[t]])),
    },
    [JEV_KEYS.sentiment]: {
      type: "choice",
      instructions: [
        "What is the overall sentiment of the whole comment in state.comment?",
        SARCASM_RULE,
        HUMOR_RULE,
        "Evaluative questions carry their polarity. If the comment is spam, irrelevant or off-topic, answer \"neutral\".",
      ].join(" ") + mixedNote,
      criteria: sentimentCriteria,
    },
    [JEV_KEYS.isQuestion]: {
      type: "noul",
      instructions: `The comment in state.comment asks a genuine question. (${FLAG_DEFINITIONS.isQuestion} Rhetorical questions do not count. Spam, irrelevant or off-topic comments do not count.)`,
    },
    [JEV_KEYS.isRequest]: {
      type: "noul",
      instructions: `The comment in state.comment asks the creator or brand to do something. (${FLAG_DEFINITIONS.isRequest} Instructions to other viewers do not count. Spam, irrelevant or off-topic comments do not count.)`,
    },
  };

  for (const target of schema.targets) {
    questions[JEV_KEYS.target(target)] = {
      type: "choice",
      instructions: [
        `What sentiment does the comment in state.comment direct at the ${target === "focus" ? "focus target (described in state.focus_target)" : `${target} target`}?`,
        `Target definition: ${TARGET_DEFINITIONS[target]}`,
        ADDRESSED_TARGET_RULE,
        ...TARGET_RULES[target],
        SPAM_TARGET_NOTE,
      ].join(" ") + (schema.mixedEnabled ? "" : ' There is no "mixed" option.'),
      criteria: targetCriteria,
    };
  }
  return questions;
}

/**
 * Per-comment state. Comment text and focus target are untrusted user data; they go only into `state`, never into
 * question instructions. Unknown sponsorship is null; it is never inferred.
 */
export function buildJevState(comment: CommentInput, focus: FocusTarget | undefined): Record<string, unknown> {
  return {
    comment: comment.text,
    focus_target: focus ? { name: focus.name, aliases: focus.aliases, is_video_sponsor: focus.isVideoSponsor ?? null } : null,
  };
}
