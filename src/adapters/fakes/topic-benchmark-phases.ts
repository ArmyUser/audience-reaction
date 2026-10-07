import type { SentimentLabel } from "../../core/domain/types";
import type { TopicAssigner, TopicAssignmentRequest, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../../core/ports";

// Test-only phase providers for the offline topic benchmark (t1-topics-v1). They answer from gold labels, never from
// comment text, and are fully deterministic: no randomness, no clock, no external calls. The oracle returns the gold
// taxonomy and gold dispositions; the degraded providers apply one named, scripted failure mode per call (call n uses
// step n; the last step repeats), modelled on realistic provider mistakes.

/** Gold the providers answer from (built by the benchmark from the dataset). */
export interface TopicPhaseGold {
  taxonomy: readonly { key: string; name: string; definition: string }[];
  /** Non-spam comment ID → gold disposition. */
  dispositions: ReadonlyMap<string, BenchmarkDisposition>;
  /** Gold key → member comment IDs, in dataset order. */
  members: ReadonlyMap<string, readonly string[]>;
  /** Non-spam comment ID → overall (classifier) sentiment. */
  overallSentiment: ReadonlyMap<string, SentimentLabel>;
}

export type BenchmarkDisposition =
  | { disposition: "primary_topic"; topicKey: string; topicSentiment: SentimentLabel }
  | { disposition: "other" }
  | { disposition: "no_specific_topic" };

/** Example IDs offered per topic by the oracle (from the discovery sample only). */
export const ORACLE_EXAMPLES_PER_TOPIC = 3;

export type TaxonomyStep =
  /** The gold taxonomy with up to three example IDs per topic taken from the sample. */
  | { kind: "oracle" }
  /** AC-21: the second topic's name differs only in case and punctuation from the first's. */
  | { kind: "duplicate_name" }
  /** AC-21: the last topic's definition is blank. */
  | { kind: "missing_definition" }
  /** AC-21: extra plausible topics until there is one more than `maxTopics`. */
  | { kind: "too_many_topics" }
  /** AC-21: the first topic cites a comment ID that is not in the discovery sample. */
  | { kind: "invalid_example" }
  /** A valid but different taxonomy (e.g. merged or split concepts), without examples. */
  | { kind: "fixed"; topics: readonly { key: string; name: string; definition: string }[] }
  /** The provider call fails. */
  | { kind: "error" };

/** The ID the `invalid_example` step cites; never an ID of any dataset comment. */
export const FABRICATED_EXAMPLE_ID = "not-in-sample-0001";

export class ScriptedTaxonomyGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  readonly requests: TopicTaxonomyRequest[] = [];

  constructor(
    private readonly gold: TopicPhaseGold,
    private readonly steps: readonly TaxonomyStep[] = [{ kind: "oracle" }],
  ) {
    if (steps.length === 0) throw new RangeError("At least one taxonomy step is required");
    this.label = steps.every((s) => s.kind === "oracle") ? "Oracle taxonomy generator (gold)" : "Degraded taxonomy generator (scripted)";
  }

  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    const step = this.steps[Math.min(this.requests.length, this.steps.length - 1)]!;
    this.requests.push(structuredClone(request));
    if (step.kind === "error") throw new Error("scripted taxonomy provider failure");
    if (step.kind === "fixed") return { topics: step.topics.map((t) => ({ ...t })) };

    const sampled = new Set(request.sample.map((c) => c.id));
    const topics = this.gold.taxonomy.map((t) => ({
      key: t.key,
      name: t.name,
      definition: t.definition,
      exampleCommentIds: (this.gold.members.get(t.key) ?? []).filter((id) => sampled.has(id)).slice(0, ORACLE_EXAMPLES_PER_TOPIC),
    }));
    switch (step.kind) {
      case "duplicate_name":
        if (topics.length > 1) topics[1]!.name = `${topics[0]!.name.toUpperCase()}!`;
        break;
      case "missing_definition":
        topics[topics.length - 1]!.definition = "   ";
        break;
      case "too_many_topics":
        for (let n = 1; topics.length <= request.context.maxTopics; n++) {
          topics.push({ key: `extra_${n}`, name: `Extra theme ${n}`, definition: `A further theme proposed as number ${n}.`, exampleCommentIds: [] });
        }
        break;
      case "invalid_example":
        topics[0]!.exampleCommentIds.push(FABRICATED_EXAMPLE_ID);
        break;
    }
    return { topics };
  }
}

export type AssignmentStep =
  /** Gold disposition and gold topic sentiment for every requested comment. */
  | { kind: "oracle" }
  /** No entry for the first `count` requested comments. */
  | { kind: "missing_comment"; count: number }
  /** A second, identical entry for the first requested comment. */
  | { kind: "duplicate_assignment" }
  /** The first `count` requested primary-topic comments cite a key that is not in the taxonomy. */
  | { kind: "unknown_topic"; count: number }
  /** Valid output, but each primary topic carries the comment's overall sentiment instead of the topic sentiment. */
  | { kind: "overall_sentiment" }
  /** Valid output, but `other` and `no_specific_topic` are swapped. */
  | { kind: "swap_other_nst" }
  /** Valid output, but comments of the given gold topics are put under `other`. */
  | { kind: "collapse_to_other"; topicKeys: readonly string[] }
  /** Not an array of entries. */
  | { kind: "malformed" }
  /** The provider call fails. */
  | { kind: "error" };

/** Marker in the malformed response, so tests can prove raw output never travels in feedback or reports. */
export const MALFORMED_MARKER = "RAW-PROVIDER-PAYLOAD-7f3a";
/** The key the `unknown_topic` step cites. */
export const UNLISTED_TOPIC_KEY = "unlisted_topic";

export interface ScriptedAssignerOptions {
  /** Comment ID → taxonomy key to use instead of its gold key (for merged or split taxonomies). */
  keyOverride?: ReadonlyMap<string, string>;
}

export class ScriptedTopicAssigner implements TopicAssigner {
  readonly label: string;
  readonly requests: TopicAssignmentRequest[] = [];

  constructor(
    private readonly gold: TopicPhaseGold,
    private readonly steps: readonly AssignmentStep[] = [{ kind: "oracle" }],
    private readonly options: ScriptedAssignerOptions = {},
  ) {
    if (steps.length === 0) throw new RangeError("At least one assignment step is required");
    this.label = steps.every((s) => s.kind === "oracle") && !options.keyOverride ? "Oracle topic assigner (gold)" : "Degraded topic assigner (scripted)";
  }

  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    const step = this.steps[Math.min(this.requests.length, this.steps.length - 1)]!;
    this.requests.push(structuredClone(request));
    if (step.kind === "error") throw new Error("scripted assignment provider failure");
    if (step.kind === "malformed") return { payload: MALFORMED_MARKER } as unknown as unknown[];

    const entries: Record<string, unknown>[] = request.comments.map((c) => {
      const gold = this.gold.dispositions.get(c.id);
      // The oracle can only label comments it has gold for; anything else is a harness error.
      if (!gold) throw new RangeError("Requested comment has no gold disposition");
      if (gold.disposition !== "primary_topic") return { commentId: c.id, disposition: gold.disposition };
      return { commentId: c.id, disposition: "primary_topic", topicKey: this.options.keyOverride?.get(c.id) ?? gold.topicKey, topicSentiment: gold.topicSentiment };
    });

    switch (step.kind) {
      case "missing_comment":
        return entries.slice(step.count);
      case "duplicate_assignment":
        return entries.length > 0 ? [...entries, { ...entries[0]! }] : entries;
      case "unknown_topic": {
        const targets = new Set(entries.filter((e) => e.disposition === "primary_topic").slice(0, step.count).map((e) => e.commentId));
        return entries.map((e) => (targets.has(e.commentId) ? { ...e, topicKey: UNLISTED_TOPIC_KEY } : e));
      }
      case "overall_sentiment":
        return entries.map((e) => (e.disposition === "primary_topic" ? { ...e, topicSentiment: this.gold.overallSentiment.get(e.commentId as string)! } : e));
      case "swap_other_nst":
        return entries.map((e) => (e.disposition === "other" ? { ...e, disposition: "no_specific_topic" } : e.disposition === "no_specific_topic" ? { ...e, disposition: "other" } : e));
      case "collapse_to_other": {
        const keys = new Set(step.topicKeys);
        return entries.map((e) => {
          const gold = this.gold.dispositions.get(e.commentId as string)!;
          return gold.disposition === "primary_topic" && keys.has(gold.topicKey) ? { commentId: e.commentId, disposition: "other" } : e;
        });
      }
      default:
        return entries;
    }
  }
}

/** The mandatory harness sanity check: the exact gold taxonomy, with valid definitions and sample example IDs. */
export class OracleTaxonomyGenerator extends ScriptedTaxonomyGenerator {
  constructor(gold: TopicPhaseGold) {
    super(gold, [{ kind: "oracle" }]);
  }
}

/** The mandatory harness sanity check: the exact gold disposition and topic sentiment for every requested comment. */
export class OracleTopicAssigner extends ScriptedTopicAssigner {
  constructor(gold: TopicPhaseGold) {
    super(gold, [{ kind: "oracle" }]);
  }
}
