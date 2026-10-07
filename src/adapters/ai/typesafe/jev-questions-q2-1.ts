import { QUESTION_VS_REQUEST_RULE, SPONSOR_AD_EXPERIENCE_RULE } from "../../../core/classification/guidelines";
import type { ClassificationSchema } from "../../../core/classification/schema";
import type { JevQuestion } from "./jev-questions";
import { buildJevQ2Questions, JEV_Q2_KEYS } from "./jev-questions-q2";

// jev-q2.1: jev-q2 (frozen) plus the two guideline g1.4 rules, appended verbatim to the questions they govern.
// Same keys, question types, options and state as jev-q2; only these instructions get one more sentence block:
// - SPONSOR_AD_EXPERIENCE_RULE: content_addressed, content_sentiment, focus_addressed, focus_sentiment;
// - QUESTION_VS_REQUEST_RULE: is_question, is_request.
// Any change to this question set must bump JEV_Q2_1_VERSION to a new version.
export const JEV_Q2_1_VERSION = "jev-q2.1";

export function buildJevQ21Questions(schema: ClassificationSchema): Record<string, JevQuestion> {
  const questions = buildJevQ2Questions(schema);
  const append = (key: string, rule: string) => {
    const q = questions[key];
    if (q) questions[key] = { ...q, instructions: `${q.instructions} ${rule}` };
  };
  append(JEV_Q2_KEYS.isQuestion, QUESTION_VS_REQUEST_RULE);
  append(JEV_Q2_KEYS.isRequest, QUESTION_VS_REQUEST_RULE);
  for (const target of ["content", "focus"] as const) {
    append(JEV_Q2_KEYS.addressed(target), SPONSOR_AD_EXPERIENCE_RULE);
    append(JEV_Q2_KEYS.targetSentiment(target), SPONSOR_AD_EXPERIENCE_RULE);
  }
  return questions;
}
