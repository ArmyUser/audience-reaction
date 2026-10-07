import type { ClassificationSchema } from "../../../core/classification/schema";
import type { JevQuestion } from "./jev-questions";
import { buildJevQ2Questions, JEV_Q2_KEYS } from "./jev-questions-q2";
import { buildJevQ21Questions } from "./jev-questions-q2-1";

// jev-q2.2: jev-q2.1 (frozen) with one change: content_addressed is jev-q2's question again, i.e. without
// SPONSOR_AD_EXPERIENCE_RULE. Every other question (including content_sentiment, focus_addressed, focus_sentiment
// with that rule, and both flag questions with QUESTION_VS_REQUEST_RULE) is identical to jev-q2.1.
// Any change to this question set must bump JEV_Q2_2_VERSION to a new version.
export const JEV_Q2_2_VERSION = "jev-q2.2";

export function buildJevQ22Questions(schema: ClassificationSchema): Record<string, JevQuestion> {
  const questions = buildJevQ21Questions(schema);
  const key = JEV_Q2_KEYS.addressed("content");
  const q2ContentAddressed = buildJevQ2Questions(schema)[key];
  if (q2ContentAddressed) questions[key] = q2ContentAddressed;
  return questions;
}
