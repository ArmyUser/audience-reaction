import { z } from "zod";
import { SENTIMENT_LABELS, type ClassifiedComment, type CommentType, type SentimentLabel } from "../domain/types";
import type { DiscoverySampleMethod } from "./types";
import { compareIds } from "./validation";

// Discovery sample (spec.md §7.2): a seeded, stratified subset of the non-spam topic base shown to topic discovery.
// Deterministic: the same comments and seed give the same sample, independent of input order. Uses only the
// classification already computed (type, overall sentiment, focus mention) and word count; never commenter identity,
// engagement or anything else.

export const DISCOVERY_SAMPLE_VERSION = "ds1";

export interface DiscoverySampleParameters {
  /** spec.md §2.6 `discovery_sample_size`. */
  maxSize: number;
  /** Recorded in the method record; any string. */
  seed: string;
  /** Focus-mentioning comments reserved first, up to this percentage of the sample (spec §7.2 "up to a share"). */
  focusReservePercent: number;
  /** Trivial comments (joke/reaction or shorter than `shortWordThreshold` words) are capped at this percentage. */
  trivialMaxPercent: number;
  shortWordThreshold: number;
  /** Each overall-sentiment label present gets at least min(available, this) slots per pool before proportional fill. */
  minPerSentimentLabel: number;
}

export const DEFAULT_DISCOVERY_SAMPLE_PARAMETERS: Readonly<Omit<DiscoverySampleParameters, "seed">> = Object.freeze({
  maxSize: 400,
  focusReservePercent: 15,
  trivialMaxPercent: 10,
  shortWordThreshold: 4,
  minPerSentimentLabel: 10,
});

export interface DiscoveryStratum {
  /** `<pool>:<overall sentiment>`, pool ∈ focus | substantive | trivial. */
  key: string;
  available: number;
  selected: number;
}

export interface DiscoverySample {
  version: string;
  seed: string;
  /** Sampled comment IDs in input order. */
  commentIds: string[];
  /** True when the topic base fits in the sample, so every eligible comment is used. */
  usedAll: boolean;
  /** Composition for the method record (spec §7.2), ordered by key. */
  strata: DiscoveryStratum[];
}

type Pool = "focus" | "substantive" | "trivial";

/** What the sampler sees per comment: ID, text (for word count only) and three classification facts. */
export interface DiscoveryCandidate {
  id: string;
  text: string;
  type: CommentType;
  sentiment: SentimentLabel;
  focusMentioned: boolean;
}

export function discoveryCandidateOf(c: ClassifiedComment): DiscoveryCandidate {
  return {
    id: c.comment.id,
    text: c.comment.text,
    type: c.classification.type,
    sentiment: c.classification.sentiment,
    focusMentioned: c.focusMention === "explicit" || c.focusMention === "inferred",
  };
}

/**
 * Selection rules:
 * 1. Base = non-spam comments. If |base| ≤ maxSize, every comment is used.
 * 2. Focus reserve: if a focus target is configured, comments with an explicit or inferred focus mention are taken
 *    first, up to ceil(focusReservePercent% × maxSize).
 * 3. The rest is split into substantive and trivial pools; trivial gets at most floor(trivialMaxPercent% × remaining)
 *    slots, unused slots go to the other pool.
 * 4. Within each pool, slots are allocated over overall-sentiment labels: first round-robin up to
 *    min(available, minPerSentimentLabel) per label, then by largest available/(allocated + 1) (D'Hondt), ties by
 *    label order.
 * 5. Within a label, comments are taken in order of a seeded hash of (seed, comment ID), ties by comment ID.
 */
export function selectDiscoverySample(candidates: readonly DiscoveryCandidate[], params: DiscoverySampleParameters): DiscoverySample {
  if (!Number.isInteger(params.maxSize) || params.maxSize < 1) throw new RangeError(`Invalid discovery sample size ${params.maxSize}`);
  const base = candidates.filter((c) => c.type !== "spam_irrelevant");
  const isFocus = (c: DiscoveryCandidate) => c.focusMentioned;
  const pools = new Map<Pool, DiscoveryCandidate[]>([
    ["focus", []],
    ["substantive", []],
    ["trivial", []],
  ]);

  const selected = new Set<string>();
  const reserved = new Set<string>();
  const take = (pool: Pool, members: DiscoveryCandidate[], n: number) => {
    const byLabel = groupBySentiment(members);
    const allocation = allocate(byLabel, n, params.minPerSentimentLabel);
    for (const [label, list] of byLabel) {
      const chosen = [...list].sort((a, b) => seededRank(params.seed, a) - seededRank(params.seed, b) || compareIds(a.id, b.id)).slice(0, allocation.get(label) ?? 0);
      for (const c of chosen) {
        selected.add(c.id);
        if (pool === "focus") reserved.add(c.id);
      }
    }
  };
  const textPool = (c: DiscoveryCandidate): Pool =>
    c.type === "joke_reaction" || wordCount(c.text) < params.shortWordThreshold ? "trivial" : "substantive";
  for (const c of base) pools.get(isFocus(c) ? "focus" : textPool(c))!.push(c);

  if (base.length <= params.maxSize) {
    for (const [pool, members] of pools) take(pool, members, members.length);
  } else {
    // A focus comment not reserved competes in the substantive or trivial pool like any other comment.
    const focus = pools.get("focus")!;
    const reserve = Math.min(focus.length, Math.ceil((params.maxSize * params.focusReservePercent) / 100));
    take("focus", focus, reserve);
    const rest = focus.filter((c) => !selected.has(c.id));
    for (const c of rest) pools.get(textPool(c))!.push(c);
    const remaining = params.maxSize - selected.size;
    const substantive = pools.get("substantive")!;
    const trivial = pools.get("trivial")!;
    let nTrivial = Math.min(trivial.length, Math.floor((remaining * params.trivialMaxPercent) / 100));
    const nSubstantive = Math.min(substantive.length, remaining - nTrivial);
    nTrivial = Math.min(trivial.length, remaining - nSubstantive);
    take("substantive", substantive, nSubstantive);
    take("trivial", trivial, nTrivial);
  }

  // Strata by final pool: reserved focus comments, then everything else by its text pool. Availables sum to |base|.
  const strata = new Map<string, DiscoveryStratum>();
  for (const c of base) {
    const key = `${reserved.has(c.id) ? "focus" : textPool(c)}:${c.sentiment}`;
    const s = strata.get(key) ?? { key, available: 0, selected: 0 };
    s.available += 1;
    if (selected.has(c.id)) s.selected += 1;
    strata.set(key, s);
  }

  return {
    version: DISCOVERY_SAMPLE_VERSION,
    seed: params.seed,
    commentIds: base.filter((c) => selected.has(c.id)).map((c) => c.id),
    usedAll: base.length <= params.maxSize,
    strata: [...strata.values()].sort((a, b) => compareIds(a.key, b.key)),
  };
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

function groupBySentiment(members: readonly DiscoveryCandidate[]): Map<SentimentLabel, DiscoveryCandidate[]> {
  const groups = new Map<SentimentLabel, DiscoveryCandidate[]>();
  for (const label of SENTIMENT_LABELS) {
    const list = members.filter((c) => c.sentiment === label);
    if (list.length > 0) groups.set(label, list);
  }
  return groups;
}

/** Round-robin floor up to min(available, floor) per label, then D'Hondt on availability. Requires n ≤ total available. */
function allocate(groups: Map<SentimentLabel, DiscoveryCandidate[]>, n: number, floor: number): Map<SentimentLabel, number> {
  const labels = [...groups.keys()];
  const available = (l: SentimentLabel) => groups.get(l)!.length;
  const alloc = new Map(labels.map((l) => [l, 0]));
  let left = n;
  for (let round = 0; round < floor && left > 0; round++) {
    for (const l of labels) {
      if (left === 0) break;
      if (alloc.get(l)! < Math.min(available(l), floor)) {
        alloc.set(l, alloc.get(l)! + 1);
        left -= 1;
      }
    }
  }
  while (left > 0) {
    let best: SentimentLabel | undefined;
    for (const l of labels) {
      if (alloc.get(l)! >= available(l)) continue;
      if (best === undefined || available(l) / (alloc.get(l)! + 1) > available(best) / (alloc.get(best)! + 1)) best = l;
    }
    if (best === undefined) break;
    alloc.set(best, alloc.get(best)! + 1);
    left -= 1;
  }
  return alloc;
}

/** FNV-1a (32-bit) over the seed and comment ID: a fixed, platform-independent order with no randomness source. */
function seededRank(seed: string, c: DiscoveryCandidate): number {
  const input = `${seed}\u0000${c.id}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The methodology record of a sample (spec §8.3): counts, strategy and parameters; the comment IDs are left out. */
export function toDiscoverySampleMethod(sample: DiscoverySample, params: DiscoverySampleParameters): DiscoverySampleMethod {
  return {
    version: sample.version,
    strategy: "seeded_stratified",
    population: "non_spam_topic_base",
    seed: sample.seed,
    eligible: sample.strata.reduce((sum, s) => sum + s.available, 0),
    size: sample.commentIds.length,
    usedAll: sample.usedAll,
    strata: sample.strata.map((s) => ({ ...s })),
    parameters: {
      maxSize: params.maxSize,
      focusReservePercent: params.focusReservePercent,
      trivialMaxPercent: params.trivialMaxPercent,
      shortWordThreshold: params.shortWordThreshold,
      minPerSentimentLabel: params.minPerSentimentLabel,
    },
  };
}

const count = z.number().int().min(0);
const methodSchema = z.strictObject({
  version: z.string().regex(/^[a-z0-9.-]{1,16}$/),
  strategy: z.literal("seeded_stratified"),
  population: z.literal("non_spam_topic_base"),
  seed: z.string().min(1).max(128),
  eligible: count,
  size: count,
  usedAll: z.boolean(),
  strata: z.array(z.strictObject({ key: z.string().regex(/^(focus|substantive|trivial):(positive|neutral|negative|mixed)$/), available: count, selected: count })).max(12),
  parameters: z.strictObject({ maxSize: count, focusReservePercent: count, trivialMaxPercent: count, shortWordThreshold: count, minPerSentimentLabel: count }),
});

/**
 * Sample methodology reported by a discoverer (any implementation), accepted only if it is exactly this
 * structure and internally consistent; otherwise it is left out of the method record.
 */
export function parseDiscoverySampleMethod(value: unknown): DiscoverySampleMethod | undefined {
  const parsed = methodSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const m = parsed.data;
  const available = m.strata.reduce((sum, s) => sum + s.available, 0);
  const selected = m.strata.reduce((sum, s) => sum + s.selected, 0);
  if (available !== m.eligible || selected !== m.size || m.strata.some((s) => s.selected > s.available) || m.size > m.eligible) return undefined;
  return m;
}
