import { minimumTopicSize } from "../core/topics/aggregate-topics";
import { normalizeTopicName } from "../core/topics/normalize";
import type { ValidatedTaxonomy } from "../core/topics/taxonomy";
import type { TopicValidationFeedback } from "../core/topics/types";
import { compareIds } from "../core/topics/validation";
import { TOPIC_BENCHMARK_PARAMETERS, type TopicScenarioRun } from "./topic-benchmark";
import { goldOf, type TopicBenchmarkDataset } from "./topic-datasets";

// DIAGNOSTIC instrumentation for the experimental real-consolidated suite. Everything here observes stored data
// (validated taxonomies, the evaluator's run record, the dataset) after the fact; nothing feeds back into a provider
// request, a validator, the evaluator's scores or its pass/fail. Generic: no dataset-specific names or rules.
//   - consolidation provenance: which candidate topics each final topic's examples come from, and retain / merge /
//     drop per candidate, inferred only from shared example IDs (unknown when it cannot be inferred);
//   - reportOtherAccuracy: OTHER after the production minimum-topic-size fold (the evaluator's OTHER metric is
//     assignment-level and stays unchanged);
//   - evidence selection: why each evidence item was chosen (provider example or the deterministic fallback);
//   - label imitation: comments whose text looks like a topic label or an instruction (local regex only).

export const DIAGNOSTIC_NOTICE = "DIAGNOSTIC ONLY: not part of the evaluator and never used for pass/fail.";

/** Result artifact schema of the real-consolidated suite. v1 (no field) is the format before instrumentation. */
export const REAL_CONSOLIDATED_RESULT_SCHEMA = "real-consolidated-result-v2";

// ---------- taxonomy snapshots ----------

/** A validated taxonomy topic as persisted: the proposed name, never provider metadata. */
export interface TaxonomySnapshotTopic {
  key: string;
  name: string;
  definition: string;
  exampleCommentIds: string[];
}

export function snapshotTaxonomy(taxonomy: ValidatedTaxonomy): TaxonomySnapshotTopic[] {
  return taxonomy.topics.map((t) => ({ key: t.key, name: t.proposedName, definition: t.definition, exampleCommentIds: [...t.exampleCommentIds] }));
}

/** The validated discovery taxonomy handed to consolidation. */
export interface DiscoveryCandidateRecord {
  /** The analysis attempt that ran this discovery call (each discovery attempt is one analysis attempt). */
  attempt: number;
  provider: string;
  model: string;
  contract: string;
  topics: TaxonomySnapshotTopic[];
}

/** One consolidation attempt. Output is persisted only once validated; invalid output is described by issue codes. */
export interface ConsolidationAttemptDetail {
  attempt: number;
  provider: string;
  model: string;
  contract: string;
  inputCandidateKeys: string[];
  outcome: "valid" | "invalid_taxonomy" | "provider_error";
  issueCodes: string[];
  /** The sanitised retry feedback sent with this attempt (null on a first attempt). */
  feedbackIssues: TopicValidationFeedback["issues"] | null;
  /** The validated consolidation taxonomy (null unless this attempt was valid). */
  outputTopics: TaxonomySnapshotTopic[] | null;
  finalKeys: string[] | null;
}

// ---------- consolidation provenance ----------

export type CandidateFate = "retained" | "merged" | "dropped" | "split" | "unknown";

export interface CandidateMapping {
  candidateKey: string;
  /**
   * retained: its examples reappear in exactly one final topic, which no other candidate's examples reach;
   * merged: that final topic also holds another candidate's examples; split: examples in several final topics;
   * dropped: has examples, none reappears; unknown: no examples, so its fate cannot be inferred.
   */
  fate: CandidateFate;
  finalKeys: string[];
  /** exact: every linking example belongs to this candidate only; ambiguous: some are shared with other candidates. */
  confidence: "exact" | "ambiguous" | "none";
  ambiguousExampleIds: string[];
}

export interface FinalTopicProvenance {
  finalKey: string;
  exampleCommentIds: string[];
  /** Per example: the candidate topics that cited it (empty: untraceable). */
  examples: { id: string; sourceCandidateKeys: string[] }[];
  allExamplesFromCandidates: boolean;
  sourceCandidateKeys: string[];
  /** retained: one source candidate; merged: several; unanchored: no examples; untraceable: none traceable. */
  material: "retained" | "merged" | "unanchored" | "untraceable";
}

export interface ConsolidationDiagnostics {
  notice: string;
  basis: string;
  discoveredTopics: number;
  consolidatedTopics: number;
  retained: number;
  merged: number;
  dropped: number;
  split: number;
  unknown: number;
  /** Candidates with examples whose examples reappear in some final topic. */
  candidateCoverage: { covered: number; withExamples: number };
  candidatesWithoutSurvivor: string[];
  candidatesInMultipleFinals: string[];
  finalTopicsWithUntraceableExamples: string[];
  candidates: CandidateMapping[];
  finalTopics: FinalTopicProvenance[];
}

/** Provenance of a consolidation, inferred only from the example IDs the output actually cites. */
export function consolidationProvenance(candidates: readonly TaxonomySnapshotTopic[], finals: readonly TaxonomySnapshotTopic[]): ConsolidationDiagnostics {
  const owners = new Map<string, string[]>();
  for (const c of candidates) for (const id of c.exampleCommentIds) owners.set(id, [...(owners.get(id) ?? []), c.key]);

  const finalTopics: FinalTopicProvenance[] = finals.map((f) => {
    const examples = f.exampleCommentIds.map((id) => ({ id, sourceCandidateKeys: [...(owners.get(id) ?? [])] }));
    const sources = [...new Set(examples.flatMap((e) => e.sourceCandidateKeys))];
    const material = f.exampleCommentIds.length === 0 ? "unanchored" : sources.length === 0 ? "untraceable" : sources.length === 1 ? "retained" : "merged";
    return { finalKey: f.key, exampleCommentIds: [...f.exampleCommentIds], examples, allExamplesFromCandidates: examples.every((e) => e.sourceCandidateKeys.length > 0), sourceCandidateKeys: sources, material };
  });

  const mapping: CandidateMapping[] = candidates.map((c) => {
    if (c.exampleCommentIds.length === 0) return { candidateKey: c.key, fate: "unknown", finalKeys: [], confidence: "none", ambiguousExampleIds: [] };
    const own = new Set(c.exampleCommentIds);
    const homes = finalTopics.filter((f) => f.exampleCommentIds.some((id) => own.has(id)));
    const linking = homes.flatMap((f) => f.examples.filter((e) => own.has(e.id)));
    const ambiguous = [...new Set(linking.filter((e) => e.sourceCandidateKeys.length > 1).map((e) => e.id))];
    const fate: CandidateFate = homes.length === 0 ? "dropped" : homes.length > 1 ? "split" : homes[0]!.sourceCandidateKeys.length > 1 ? "merged" : "retained";
    return {
      candidateKey: c.key,
      fate,
      finalKeys: homes.map((f) => f.finalKey),
      confidence: homes.length === 0 ? "none" : ambiguous.length > 0 ? "ambiguous" : "exact",
      ambiguousExampleIds: ambiguous,
    };
  });

  const count = (fate: CandidateFate) => mapping.filter((m) => m.fate === fate).length;
  const withExamples = mapping.filter((m) => m.fate !== "unknown");
  return {
    notice: DIAGNOSTIC_NOTICE,
    basis: "inferred from example IDs cited by the validated consolidation output; never from names",
    discoveredTopics: candidates.length,
    consolidatedTopics: finals.length,
    retained: count("retained"),
    merged: count("merged"),
    dropped: count("dropped"),
    split: count("split"),
    unknown: count("unknown"),
    candidateCoverage: { covered: withExamples.filter((m) => m.fate !== "dropped").length, withExamples: withExamples.length },
    candidatesWithoutSurvivor: mapping.filter((m) => m.fate === "dropped").map((m) => m.candidateKey),
    candidatesInMultipleFinals: mapping.filter((m) => m.fate === "split").map((m) => m.candidateKey),
    finalTopicsWithUntraceableExamples: finalTopics.filter((f) => !f.allExamplesFromCandidates).map((f) => f.finalKey),
    candidates: mapping,
    finalTopics,
  };
}

// ---------- run-level views (work on stored runs, old result files included) ----------

type RunRecord = Pick<TopicScenarioRun, "predictions" | "section" | "fingerprint"> & { taxonomy?: TopicScenarioRun["taxonomy"] };

interface Assigned {
  disposition: "primary_topic" | "other" | "no_specific_topic";
  topicId?: string;
  topicSentiment?: string;
}

/** Parses an evaluator prediction (`primary_topic:<topicId>:<sentiment>`, `other`, `no_specific_topic`). */
export function parsePrediction(p: string): Assigned {
  if (!p.startsWith("primary_topic:")) return { disposition: p as Assigned["disposition"] };
  const rest = p.slice("primary_topic:".length);
  const cut = rest.lastIndexOf(":");
  return { disposition: "primary_topic", topicId: rest.slice(0, cut), topicSentiment: rest.slice(cut + 1) };
}

/** Final topics as the evaluator recorded them (ID, name, provider keys and example IDs), from the run fingerprint. */
export function finalTopicsOf(run: Pick<TopicScenarioRun, "fingerprint">): { id: string; name: string; providerKeys: string[]; providerExampleIds: string[] }[] | null {
  try {
    const parsed = JSON.parse(run.fingerprint) as { topics?: { id: string; name: string; formation?: { providerKeys?: string[]; providerExampleIds?: string[] } }[] | null };
    if (!Array.isArray(parsed.topics)) return null;
    return parsed.topics.map((t) => ({ id: t.id, name: t.name, providerKeys: [...(t.formation?.providerKeys ?? [])], providerExampleIds: [...(t.formation?.providerExampleIds ?? [])] }));
  } catch {
    return null;
  }
}

export interface ReportOtherDiagnostic {
  notice: string;
  /** Share of gold report-level OTHER comments that the report shows as OTHER. Null when gold has none. */
  reportOtherAccuracy: number | null;
  /** Share of report-level OTHER comments that are gold report-level OTHER. Null when the report shows none. */
  reportOtherPrecision: number | null;
  goldReportOther: number;
  predictedReportOther: number;
  hits: number;
  /** Gold topics below the minimum topic size (their comments are OTHER in a gold report). */
  goldFoldedTopics: string[];
  /** Predicted topics below the minimum topic size, folded into OTHER by the report. */
  predictedFoldedTopicIds: string[];
}

/**
 * OTHER with report semantics: on both sides, OTHER is explicit OTHER plus every comment of a topic below the
 * production minimum topic size. Diagnostic only; the evaluator's assignment-level OTHER metric is unchanged.
 */
export function reportOtherDiagnostic(dataset: TopicBenchmarkDataset, run: RunRecord): ReportOtherDiagnostic | null {
  if (run.predictions === null || run.section.status !== "available") return null;
  const gold = goldOf(dataset);
  const min = minimumTopicSize(gold.baseIds.length, TOPIC_BENCHMARK_PARAMETERS);
  const goldFolded = new Set([...gold.members].filter(([, ids]) => ids.length < min).map(([key]) => key));
  const reported = new Set(run.section.topics.map((t) => t.id));
  const predictedFolded = new Set<string>();
  let goldOther = 0;
  let predOther = 0;
  let hits = 0;
  for (const id of gold.baseIds) {
    const g = gold.dispositions.get(id)!;
    const goldIsOther = g.disposition === "other" || (g.disposition === "primary_topic" && goldFolded.has(g.topicKey));
    const p = run.predictions[id] === undefined ? null : parsePrediction(run.predictions[id]!);
    if (p?.topicId && !reported.has(p.topicId)) predictedFolded.add(p.topicId);
    const predIsOther = p !== null && (p.disposition === "other" || (p.disposition === "primary_topic" && !reported.has(p.topicId!)));
    if (goldIsOther) goldOther += 1;
    if (predIsOther) predOther += 1;
    if (goldIsOther && predIsOther) hits += 1;
  }
  return {
    notice: DIAGNOSTIC_NOTICE,
    reportOtherAccuracy: goldOther === 0 ? null : hits / goldOther,
    reportOtherPrecision: predOther === 0 ? null : hits / predOther,
    goldReportOther: goldOther,
    predictedReportOther: predOther,
    hits,
    goldFoldedTopics: [...goldFolded].sort(compareIds),
    predictedFoldedTopicIds: [...predictedFolded].sort(compareIds),
  };
}

export interface EvidenceDiagnostic {
  commentId: string;
  finalTopicId: string;
  finalTopicKeys: string[];
  /** The topic the evaluator matched to this final topic (null: unmatched). */
  matchedGoldTopic: string | null;
  /** The comment's gold disposition: a gold topic key, `other` or `no_specific_topic` (null: not in gold). */
  expected: string | null;
  /** The assignment that put the comment in this topic (`primary_topic:<id>:<sentiment>`). */
  assigned: string | null;
  topicSentiment: string;
  rank: number;
  selection: "provider_example" | "fallback";
  /**
   * Why a non-example was chosen: no provider example in this sentiment group, or the group's provider examples were
   * already used; null for provider examples or when the examples are not recorded.
   */
  fallbackReason: "no_provider_example_with_label" | "provider_examples_exhausted_for_label" | "examples_not_recorded" | null;
  /** The ordering that decided within the sentiment group (the selector ranks by confidence, example, then ID). */
  tieBreak: "confidence" | "provider_example" | "lowest_comment_id";
  labelGroupSize: number;
  providerExamplesInLabelGroup: number | null;
}

/** One entry per selected evidence item of each reported topic, explaining the selection. Diagnostic only. */
export function evidenceDiagnostics(dataset: TopicBenchmarkDataset, run: RunRecord): EvidenceDiagnostic[] {
  if (run.predictions === null || run.section.status !== "available") return [];
  const gold = goldOf(dataset);
  const finals = finalTopicsOf(run);
  const examplesOf = new Map(finals?.map((t) => [t.id, new Set(t.providerExampleIds)]) ?? []);
  const keysOf = new Map(finals?.map((t) => [t.id, t.providerKeys]) ?? []);
  const matched = new Map(run.taxonomy?.matches.map((m) => [m.topicId, m.goldKey]) ?? []);
  const members = new Map<string, string[]>();
  for (const [id, p] of Object.entries(run.predictions)) {
    const a = parsePrediction(p);
    if (a.disposition === "primary_topic") members.set(`${a.topicId}\u0000${a.topicSentiment}`, [...(members.get(`${a.topicId}\u0000${a.topicSentiment}`) ?? []), id]);
  }
  const out: EvidenceDiagnostic[] = [];
  for (const topic of run.section.topics) {
    const examples = examplesOf.get(topic.id);
    for (const e of topic.evidence) {
      const group = members.get(`${topic.id}\u0000${e.topicSentiment}`) ?? [];
      const groupExamples = examples ? group.filter((id) => examples.has(id)) : null;
      const g = gold.dispositions.get(e.commentId);
      const fallbackReason = e.providerExample ? null : groupExamples === null ? "examples_not_recorded" : groupExamples.length === 0 ? "no_provider_example_with_label" : "provider_examples_exhausted_for_label";
      out.push({
        commentId: e.commentId,
        finalTopicId: topic.id,
        finalTopicKeys: keysOf.get(topic.id) ?? [],
        matchedGoldTopic: matched.get(topic.id) ?? null,
        expected: g === undefined ? null : g.disposition === "primary_topic" ? g.topicKey : g.disposition,
        assigned: run.predictions[e.commentId] ?? null,
        topicSentiment: e.topicSentiment,
        rank: e.rank,
        selection: e.providerExample ? "provider_example" : "fallback",
        fallbackReason,
        tieBreak: e.confidence !== undefined ? "confidence" : e.providerExample ? "provider_example" : "lowest_comment_id",
        labelGroupSize: group.length,
        providerExamplesInLabelGroup: groupExamples === null ? null : groupExamples.length,
      });
    }
  }
  return out;
}

// ---------- label imitation (local, deterministic; never sent to a model) ----------

export type LabelImitationSignal = "structured_label" | "instruction_phrase" | "names_topic_label";

export interface LabelImitationDiagnostic {
  commentId: string;
  signals: LabelImitationSignal[];
  /** Final topics whose key, name or a name part the comment names in a label-like context. */
  namedTopicIds: string[];
  /** Where the comment was assigned (null when unknown). */
  assigned: string | null;
  /** True when it was assigned to a topic it names. */
  assignedToNamedTopic: boolean;
}

/** JSON- or key/value-like label fields (e.g. `{"label": ...`), including the topic contracts' own output field names. */
const STRUCTURED_LABEL =
  /[{,[]\s*["']?(topics?|topic_?key|topic_?id|label|category|class|classification|disposition|sentiment|topic_?sentiment|name|key|definition|example_?comment_?ids|assignments?)["']?\s*:/i;
/** Text addressed to whoever or whatever processes the comments. */
const INSTRUCTION_PHRASE = new RegExp(
  [
    String.raw`\bignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)\b`,
    String.raw`(^|\s)(system|assistant|developer)\s*:`,
    String.raw`\bnew (rule|instruction)s?\b`,
    String.raw`\binstructions? for (whoever|the (model|ai|assistant|system|classifier))\b`,
    String.raw`\b(mark|label|classify|file|assign|tag|categori[sz]e|put|move) (this|these|it|every|all|each|the) (comment|comments|thread|video|topic|ones?)?\b.*\b(as|under|into|to)\b`,
    String.raw`\b(output|return|respond with) (an? |the )?(empty|json|list|label)\b`,
    String.raw`\b(topic|analysis|classification|moderation|comment|sentiment) (engine|model|system|bot|ai|classifier|pipeline)\b`,
    String.raw`\b(merge|drop|delete|skip|discard) (all|every|everything|the rest)\b`,
  ].join("|"),
  "i",
);

function labelPhrases(topic: { name: string; providerKeys: string[] }): string[] {
  const phrases = new Set<string>();
  const add = (p: string) => {
    const n = normalizeTopicName(p);
    if (n.length >= 3) phrases.add(n);
  };
  add(topic.name);
  for (const k of topic.providerKeys) add(k.replace(/[_-]+/g, " "));
  for (const part of topic.name.split(/\s*(?:,|\band\b|&|\/)\s*/i)) add(part);
  return [...phrases];
}

/** Comments that look like a topic label or an instruction. Pure text heuristics; never changes any decision. */
export function labelImitationDiagnostics(
  comments: readonly { id: string; text: string }[],
  topics: readonly { id: string; name: string; providerKeys: string[] }[],
  predictions: Readonly<Record<string, string>> | null,
): LabelImitationDiagnostic[] {
  const labels = topics.map((t) => ({ id: t.id, phrases: labelPhrases(t) }));
  const out: LabelImitationDiagnostic[] = [];
  for (const c of comments) {
    const signals: LabelImitationSignal[] = [];
    if (STRUCTURED_LABEL.test(c.text)) signals.push("structured_label");
    if (INSTRUCTION_PHRASE.test(c.text)) signals.push("instruction_phrase");
    const quoted = [...c.text.matchAll(/["'“‘]([^"'”’]{2,60})["'”’]/g)].map((m) => normalizeTopicName(m[1]!));
    const text = ` ${normalizeTopicName(c.text)} `;
    const named = labels.filter((l) => l.phrases.some((p) => (signals.length > 0 && text.includes(` ${p} `)) || quoted.includes(p))).map((l) => l.id);
    if (named.length > 0) signals.push("names_topic_label");
    if (signals.length === 0) continue;
    const assigned = predictions?.[c.id] ?? null;
    const topicId = assigned ? parsePrediction(assigned).topicId : undefined;
    out.push({ commentId: c.id, signals, namedTopicIds: named, assigned, assignedToNamedTopic: topicId !== undefined && named.includes(topicId) });
  }
  return out;
}

// ---------- per-run bundle ----------

export interface RunDiagnostics {
  notice: string;
  repeat: number;
  reportOther: ReportOtherDiagnostic | null;
  evidence: EvidenceDiagnostic[];
  labelImitation: LabelImitationDiagnostic[];
}

/** The run-level diagnostics; computable from any stored run, including result files written before v2. */
export function runDiagnosticsOf(dataset: TopicBenchmarkDataset, run: RunRecord & { repeat: number }): RunDiagnostics {
  const base = dataset.comments.filter((c) => c.classification.type !== "spam_irrelevant").map((c) => ({ id: c.id, text: c.text }));
  return {
    notice: DIAGNOSTIC_NOTICE,
    repeat: run.repeat,
    reportOther: reportOtherDiagnostic(dataset, run),
    evidence: evidenceDiagnostics(dataset, run),
    labelImitation: labelImitationDiagnostics(base, finalTopicsOf(run) ?? [], run.predictions),
  };
}
