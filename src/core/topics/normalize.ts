import type { TopicId } from "./types";

// Lexical topic-name normalisation (no synonyms or semantics: "battery duration" and "battery life" stay distinct).
// Rules, in order:
// 1. Unicode NFKC (full-width and compatibility forms become their plain equivalents);
// 2. lower case (locale-independent);
// 3. apostrophes are removed ("creator's" → "creators");
// 4. every run of characters that are not letters, combining marks or digits (spaces, punctuation, symbols, emoji)
//    becomes one space;
// 5. leading and trailing spaces are trimmed.

export const TOPIC_NORMALIZATION_VERSION = "tn1";

/** spec.md §7.4: topic names are 1–5 words. */
export const MAX_TOPIC_NAME_WORDS = 5;

const APOSTROPHES = /['‘’ʼ`´]/gu;
const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/gu;

export function normalizeTopicName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(APOSTROPHES, "").replace(SEPARATORS, " ").trim();
}

/** A usable normalised name has 1 to MAX_TOPIC_NAME_WORDS words. */
export function isValidNormalizedTopicName(normalized: string): boolean {
  if (normalized === "") return false;
  return normalized.split(" ").length <= MAX_TOPIC_NAME_WORDS;
}

/**
 * Stable ID from a normalised name. Normalised names contain only letters, marks, digits and single spaces, so
 * replacing spaces with hyphens is one-to-one: equal IDs mean equal normalised names.
 */
export function topicIdOf(normalized: string): TopicId {
  if (!isValidNormalizedTopicName(normalized) || normalizeTopicName(normalized) !== normalized) {
    throw new RangeError("Topic IDs are derived from valid normalised names only");
  }
  return `topic:${normalized.replaceAll(" ", "-")}`;
}
