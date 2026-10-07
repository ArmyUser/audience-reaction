import { z } from "zod";
import { isValidNormalizedTopicName, normalizeTopicName, topicIdOf } from "./normalize";
import type { TopicId, TopicIssue, TopicIssueCode, TopicValidationFeedback } from "./types";

// Taxonomy stage of a two-phase topic provider (spec.md §S5, §7.3–7.5, AC-21): discovery proposes a taxonomy from the
// discovery sample; it is validated here, as a whole, before any assignment is requested. Nothing is repaired: any
// issue rejects the taxonomy. The final provider output still goes through validateTopicAttempt (topic-result.ts),
// which owns assignment validation; this module owns only the AC-21 rules that need the discovery sample or are
// stricter than the foundation's topic parsing.

/** Provider topic keys are echoed back in feedback and prompts, so they must be plain identifiers. */
export const TOPIC_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const proposalSchema = z.strictObject({ topics: z.array(z.unknown()) });
const topicSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  definition: z.string(),
  exampleCommentIds: z.array(z.string()).optional(),
});

export interface ValidatedTaxonomyTopic {
  key: string;
  id: TopicId;
  /** Normalised name; unique within the taxonomy. */
  name: string;
  /** The name as proposed (valid; normalises to `name`). */
  proposedName: string;
  /** Non-empty, trimmed. */
  definition: string;
  /** Distinct IDs from the discovery sample, in proposal order. */
  exampleCommentIds: string[];
}

export interface ValidatedTaxonomy {
  topics: ValidatedTaxonomyTopic[];
}

export type TaxonomyValidation = { status: "valid"; taxonomy: ValidatedTaxonomy } | { status: "invalid"; issues: TopicIssue[] };

/**
 * Validates a proposed taxonomy `{ topics: { key, name, definition, exampleCommentIds? }[] }` against AC-21:
 * at most `maxTopics` topics; plain, unique keys; valid names (1–5 words after tn1 normalisation) that stay unique
 * after normalisation; non-empty definitions; example IDs only from the discovery sample. Zero topics is valid
 * (spec §2.6 `min_topics` = 0). Any issue rejects the whole taxonomy.
 */
export function validateTopicTaxonomy(raw: unknown, options: { sampleCommentIds: readonly string[]; maxTopics: number }): TaxonomyValidation {
  const top = proposalSchema.safeParse(raw);
  if (!top.success) return { status: "invalid", issues: [{ code: "invalid_output" }] };

  const issues: TopicIssue[] = [];
  const sample = new Set(options.sampleCommentIds);
  const keys = new Set<string>();
  const names = new Map<string, string>();
  const topics: ValidatedTaxonomyTopic[] = [];
  if (top.data.topics.length > options.maxTopics) issues.push({ code: "too_many_topics", detail: `${top.data.topics.length} topics; maximum ${options.maxTopics}` });

  top.data.topics.forEach((item, index) => {
    const parsed = topicSchema.safeParse(item);
    if (!parsed.success) return void issues.push({ code: "invalid_topic", index });
    const { key, name, definition, exampleCommentIds = [] } = parsed.data;
    if (!TOPIC_KEY_PATTERN.test(key)) return void issues.push({ code: "invalid_topic_key", index });
    if (keys.has(key)) return void issues.push({ code: "duplicate_topic_key", index, topicKey: key });
    keys.add(key);

    const normalized = normalizeTopicName(name);
    const before = issues.length;
    if (!isValidNormalizedTopicName(normalized)) issues.push({ code: "invalid_topic_name", index, topicKey: key });
    else if (names.has(normalized)) issues.push({ code: "duplicate_topic_name", index, topicKey: key });
    // Registered even when this topic has other issues, so later collisions with it are still reported.
    else names.set(normalized, key);
    if (definition.trim() === "") issues.push({ code: "missing_definition", index, topicKey: key });
    const examples: string[] = [];
    for (const id of exampleCommentIds) {
      if (!sample.has(id)) issues.push({ code: "unknown_example_comment", index, topicKey: key });
      else if (!examples.includes(id)) examples.push(id);
    }
    if (issues.length > before) return;
    topics.push({ key, id: topicIdOf(normalized), name: normalized, proposedName: name, definition: definition.trim(), exampleCommentIds: examples });
  });

  return issues.length > 0 ? { status: "invalid", issues } : { status: "valid", taxonomy: { topics } };
}

/**
 * The frozen TopicDiscoverer output for a validated taxonomy and the assignment phase's entries. Entries are passed
 * through unchanged: the existing attempt validator (validateTopicAttempt) is the only assignment validator.
 */
export function toTopicDiscoveryOutput(taxonomy: ValidatedTaxonomy, assignments: readonly unknown[]): unknown {
  return {
    topics: taxonomy.topics.map((t) => ({
      key: t.key,
      name: t.proposedName,
      description: t.definition,
      ...(t.exampleCommentIds.length > 0 ? { exampleCommentIds: [...t.exampleCommentIds] } : {}),
    })),
    assignments: [...assignments],
  };
}

/** Codes found only at the taxonomy stage or in the topic part of the output. */
export const TAXONOMY_ISSUE_CODES: ReadonlySet<TopicIssueCode> = new Set<TopicIssueCode>([
  "invalid_topic",
  "invalid_topic_key",
  "duplicate_topic_key",
  "invalid_topic_name",
  "duplicate_topic_name",
  "missing_definition",
  "unknown_example_comment",
  "too_many_topics",
]);

/** Codes about per-comment dispositions. */
export const ASSIGNMENT_ISSUE_CODES: ReadonlySet<TopicIssueCode> = new Set<TopicIssueCode>([
  "invalid_assignment",
  "unknown_comment",
  "unknown_topic",
  "assignment_to_dropped_topic",
  "multiple_primary_topics",
  "missing_assignment",
  "excluded_comment",
]);

/**
 * Which phase a retry must redo, from the frozen feedback: taxonomy issues → rediscover (then reassign everything);
 * assignment issues only → keep the taxonomy and reassign; anything else (invalid output, provider error, invariant
 * violation) → redo the phase that produced it, which only the provider workflow knows, so it is reported as `unknown`.
 */
export function retryScope(feedback: TopicValidationFeedback): "taxonomy" | "assignment" | "unknown" {
  const codes = feedback.issues.map((i) => i.code);
  if (codes.some((c) => TAXONOMY_ISSUE_CODES.has(c))) return "taxonomy";
  if (codes.length > 0 && codes.every((c) => ASSIGNMENT_ISSUE_CODES.has(c))) return "assignment";
  return "unknown";
}
