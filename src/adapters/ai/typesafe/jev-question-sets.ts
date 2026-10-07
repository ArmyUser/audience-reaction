import type { ClassificationSchema } from "../../../core/classification/schema";
import { buildJevQuestions, JEV_QUESTION_SET_VERSION, type JevQuestion } from "./jev-questions";
import { buildJevQ2Questions, JEV_Q2_VERSION } from "./jev-questions-q2";
import { buildJevQ21Questions, JEV_Q2_1_VERSION } from "./jev-questions-q2-1";
import { buildJevQ22Questions, JEV_Q2_2_VERSION } from "./jev-questions-q2-2";

// Registry of versioned Jev question sets. All stay runnable so benchmark results remain reproducible:
// - jev-q1: frozen (guideline g1.2 wording); one Choice per target including not_addressed.
// - jev-q2: guideline g1.3; per target an "addressed" Noul plus a sentiment Choice. Validated baseline.
// - jev-q2.1: jev-q2 plus the guideline g1.4 rules (sponsor/ad experience, question vs request).
// - jev-q2.2: jev-q2.1 without the sponsor/ad-experience rule on content_addressed. Default: best on m2-synthetic and
//   on the held-out m2-heldout-v1 set.

export const JEV_QUESTION_SETS = [JEV_QUESTION_SET_VERSION, JEV_Q2_VERSION, JEV_Q2_1_VERSION, JEV_Q2_2_VERSION] as const;
export type JevQuestionSetVersion = (typeof JEV_QUESTION_SETS)[number];
/** Validated on m2-synthetic and the held-out m2-heldout-v1; older sets stay selectable explicitly. */
export const DEFAULT_JEV_QUESTION_SET: JevQuestionSetVersion = JEV_Q2_2_VERSION;

export function isJevQuestionSetVersion(value: string): value is JevQuestionSetVersion {
  return (JEV_QUESTION_SETS as readonly string[]).includes(value);
}

export function buildJevQuestionSet(version: JevQuestionSetVersion, schema: ClassificationSchema): Record<string, JevQuestion> {
  switch (version) {
    case JEV_Q2_2_VERSION:
      return buildJevQ22Questions(schema);
    case JEV_Q2_1_VERSION:
      return buildJevQ21Questions(schema);
    case JEV_Q2_VERSION:
      return buildJevQ2Questions(schema);
    default:
      return buildJevQuestions(schema);
  }
}

/** Question sets that split each target into an "addressed" Noul and a sentiment Choice (jev-q2 key layout). */
export function usesAddressedTargets(version: JevQuestionSetVersion): boolean {
  return version === JEV_Q2_VERSION || version === JEV_Q2_1_VERSION || version === JEV_Q2_2_VERSION;
}
