import {
  FABRICATED_EXAMPLE_ID,
  MALFORMED_MARKER,
  ScriptedTaxonomyGenerator,
  ScriptedTopicAssigner,
  type TopicPhaseGold,
} from "../adapters/fakes/topic-benchmark-phases";
import { analyzeTopics, MAX_TOPIC_ATTEMPTS } from "../application/analyze-topics";
import { TwoPhaseTopicDiscoverer } from "../application/two-phase-topic-discoverer";
import { share } from "../core/aggregation/distribution";
import type { ClassifiedComment, SentimentLabel } from "../core/domain/types";
import type { TopicAssigner, TopicAssignmentRequest, TopicDiscoverer, TopicDiscoveryRequest, TopicDiscoveryRunInfo, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../core/ports";
import type { TopicsSection } from "../core/reporting/report-model";
import { DEFAULT_TOPIC_PARAMETERS, highOtherShareWarning, minimumTopicSize } from "../core/topics/aggregate-topics";
import { TOPIC_KEY_PATTERN, validateTopicTaxonomy } from "../core/topics/taxonomy";
import { sanitizeReportedIssues, toValidationFeedback, validateTopicAttempt } from "../core/topics/topic-result";
import { toTopicsSection } from "../core/topics/topics-section";
import type { TopicAnalysis, TopicDiscoveryResult, TopicIssue, TopicIssueCode, TopicParameters, TopicValidationFeedback } from "../core/topics/types";
import { compareIds, parseTopicDiscoveryOutput, TopicDiscoveryOutputError } from "../core/topics/validation";
import { classifiedCommentsOf, goldOf, type TopicBenchmarkDataset, type TopicGold } from "./topic-datasets";
import { buildTopicScenario, TOPIC_SCENARIO_IDS, type TopicScenario, type TopicScenarioExpectation, type TopicScenarioId } from "./topic-scenarios";

// Offline topic benchmark harness (design: m4-topic-provider-design.md §10). Runs the complete production workflow,
// analyzeTopics → TwoPhaseTopicDiscoverer (sample → taxonomy → AC-21 validation → assignment → attempt validation →
// at most one retry) → report section, with deterministic phase providers, and scores the result against gold.
// Nothing here is a benchmark-specific exception in production code: the harness only observes the providers'
// requests and responses. Predicted topics are matched to gold concepts by member-comment Jaccard (≥ 0.5, ties to the
// earlier gold topic), never by name similarity.

/** Production topic parameters (spec §2.6), unchanged for the benchmark. */
export const TOPIC_BENCHMARK_PARAMETERS: Readonly<TopicParameters> = DEFAULT_TOPIC_PARAMETERS;
export const TOPIC_BENCHMARK_SEED = "t1-topics-v1/ds1";
export const MATCH_JACCARD_THRESHOLD = 0.5;
/** Merge/split: a topic holds (or a concept is spread over topics holding) at least this share of a concept. */
export const MERGE_SPLIT_SHARE = 0.3;
export const MAX_DEFINITION_CHARS = 200;
/** Words that make a topic name sentiment-laden (spec §7.4: names are neutral). */
export const NAME_SENTIMENT_WORDS = [
  "amazing", "awful", "bad", "best", "broken", "complaint", "complaints", "disappointing", "excellent", "good", "great",
  "hate", "horrible", "issue", "issues", "love", "negative", "perfect", "poor", "positive", "praise", "problem", "problems",
  "terrible", "worst",
] as const;

export interface TopicMatch {
  topicId: string;
  name: string;
  members: number;
  goldKey: string | null;
  jaccard: number;
}

export interface TaxonomyMetrics {
  predictedTopics: number;
  matchedTopics: number;
  topicPrecision: number;
  conceptRecall: number;
  mergeErrors: number;
  splitErrors: number;
  /** Topics whose definition is non-empty, one sentence, ≤ 200 chars, copies no comment and whose name is neutral. */
  definitionValidity: number;
  definitionIssues: { topicId: string; issues: string[] }[];
  /** Topics whose example IDs are all in the discovery sample. */
  exampleIdValidity: number;
  /** Example IDs that are members of their own topic. */
  exampleSupport: number;
  matches: TopicMatch[];
}

export interface AssignmentMetrics {
  dispositionAccuracy: number;
  primaryTopicAccuracy: number;
  otherAccuracy: number;
  otherPrecision: number;
  noSpecificTopicAccuracy: number;
  noSpecificTopicPrecision: number;
  /** Among comments with the correct primary topic. Null when none. */
  topicSentimentAccuracy: number | null;
  topicSentimentScored: number;
  /** What copying the overall sentiment would score on the same comments (the dataset's built-in trap). */
  overallSentimentAgreement: number | null;
  /** Base comments with exactly one valid disposition in the accepted output. */
  fullValidity: number;
}

export interface ReportMetrics {
  /** Per gold topic, |reported named share − gold named share|, in percentage points of the topic base. */
  namedShareErrorPp: Record<string, number>;
  namedShareErrorMaxPp: number;
  /** Named share held by topics that match no gold concept. */
  unmatchedNamedSharePp: number;
  otherShareErrorPp: number;
  noSpecificTopicShareErrorPp: number;
  highOtherShareExpected: boolean;
  highOtherShareReported: boolean;
  highOtherShareCorrect: boolean;
  /** Named topics with at least one evidence ID. */
  evidenceCoverage: number;
  /** (topic, topic-sentiment label present) pairs with at least one evidence ID of that label. */
  evidenceSentimentCoverage: number;
  /** Evidence IDs whose gold topic is the topic's matched concept. */
  evidencePrecision: number;
  ac23Valid: boolean;
}

export interface RetryChecks {
  withinAttemptLimit: boolean;
  /** At most two calls per phase. */
  phaseCallsWithinLimit: boolean;
  /** A retry happened and some phase call on attempt 2 received feedback; null without a retry. */
  feedbackSent: boolean | null;
  /** Every feedback equals the structured feedback of attempt 1's issues (and attempt 1 received none). */
  feedbackCorrect: boolean | null;
  /** Feedback holds only codes, counts, analysed IDs and safe keys: no comment text, raw output or names. */
  feedbackSanitized: boolean;
  /** Nothing the report keeps contains comment text or raw provider output. */
  reportSanitized: boolean;
  /** Unavailable results carry no topics; null when available. */
  noPartialTopics: boolean | null;
  /** The analysis diagnostics equal the issues recomputed from each attempt's raw result. */
  diagnosticsMatch: boolean;
}

export interface PhaseCallRecord {
  phase: "taxonomy" | "assignment";
  attempt: number;
  comments: number;
  feedback?: TopicValidationFeedback;
  failed: boolean;
}

export interface TopicScenarioRun {
  repeat: number;
  status: TopicAnalysis["status"];
  attempts: number;
  generatorCalls: number;
  assignerCalls: number;
  phaseCalls: PhaseCallRecord[];
  failedAttemptCodes: TopicIssueCode[][];
  taxonomyProposals: { attempt: number; valid: boolean; issueCodes: TopicIssueCode[] }[];
  taxonomy: TaxonomyMetrics | null;
  assignment: AssignmentMetrics | null;
  report: ReportMetrics | null;
  retry: RetryChecks;
  /** Comment ID → final disposition (IDs only); null when unavailable. */
  predictions: Record<string, string> | null;
  section: TopicsSection;
  fingerprint: string;
}

export interface TopicScenarioResult {
  id: string;
  group: TopicScenario["group"];
  description: string;
  expected: TopicScenarioExpectation;
  runs: TopicScenarioRun[];
  /** All repeats produced identical taxonomy, assignments, report and retry behaviour. */
  repeatIdentical: boolean;
  /** Share of base comments with the same final disposition in every repeat (1 when every repeat is unavailable). */
  repeatConsistency: number;
  retryRate: number;
  persistentFailureRate: number;
  perfect: boolean;
  /** Differences from the expected outcome; empty when the scenario behaves as designed. */
  expectationFailures: string[];
}

export interface GoldSummary {
  topicBase: number;
  spamExcluded: number;
  minTopicSize: number;
  dispositions: { primary_topic: number; other: number; no_specific_topic: number };
  topicSizes: Record<string, number>;
  namedTopics: string[];
  smallTopics: string[];
  topicSentiment: Record<string, Record<SentimentLabel, number>>;
  topicSentimentDiffersFromOverall: number;
  shares: { named: number; other: number; noSpecificTopic: number };
  highOtherShare: boolean;
}

export interface TopicBenchmarkReport {
  meta: { datasetId: string; datasetVersion: string; comments: number; parameters: TopicParameters; sampleSeed: string; repeats: number; matching: string };
  gold: GoldSummary;
  oracleGate: { passed: boolean; failures: string[] };
  scenarios: TopicScenarioResult[];
}

export interface TopicBenchmarkOptions {
  /** Default 2; repeatability needs at least 2. */
  repeats?: number;
}

/**
 * Runs the oracle first (the mandatory sanity gate), then the requested scenarios. Deterministic: the same dataset
 * and scenarios always give the same report.
 */
export async function runTopicBenchmark(dataset: TopicBenchmarkDataset, scenarioIds: readonly TopicScenarioId[] = TOPIC_SCENARIO_IDS, options: TopicBenchmarkOptions = {}): Promise<TopicBenchmarkReport> {
  const ordered: TopicScenarioId[] = ["oracle", ...scenarioIds.filter((id) => id !== "oracle")];
  return runTopicBenchmarkScenarios(dataset, ordered.map((id) => buildTopicScenario(dataset, id)), options);
}

/** Runs prepared scenarios in order; the first must be the oracle (the sanity gate). */
export async function runTopicBenchmarkScenarios(dataset: TopicBenchmarkDataset, prepared: readonly TopicScenario[], options: TopicBenchmarkOptions = {}): Promise<TopicBenchmarkReport> {
  const repeats = options.repeats ?? 2;
  if (!Number.isInteger(repeats) || repeats < 1) throw new RangeError("repeats must be a positive integer");
  if (prepared[0]?.id !== "oracle") throw new RangeError("The oracle scenario must run first");
  const scenarios: TopicScenarioResult[] = [];
  for (const scenario of prepared) scenarios.push(await runTopicScenario(dataset, scenario, repeats));
  const failures = oracleGateFailures(scenarios[0]!);
  return {
    meta: {
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      comments: dataset.comments.length,
      parameters: { ...TOPIC_BENCHMARK_PARAMETERS },
      sampleSeed: TOPIC_BENCHMARK_SEED,
      repeats,
      matching: `member-comment Jaccard ≥ ${MATCH_JACCARD_THRESHOLD}, ties to the earlier gold topic; no name similarity`,
    },
    gold: goldSummary(dataset),
    oracleGate: { passed: failures.length === 0, failures },
    scenarios,
  };
}

export async function runTopicScenario(dataset: TopicBenchmarkDataset, scenario: TopicScenario, repeats = 2): Promise<TopicScenarioResult> {
  const runs: TopicScenarioRun[] = [];
  for (let r = 1; r <= repeats; r++) runs.push(await runOnce(dataset, scenario, r));
  const repeatIdentical = runs.every((run) => run.fingerprint === runs[0]!.fingerprint);
  const result: Omit<TopicScenarioResult, "perfect" | "expectationFailures"> = {
    id: scenario.id,
    group: scenario.group,
    description: scenario.description,
    expected: scenario.expected,
    runs,
    repeatIdentical,
    repeatConsistency: repeatConsistency(runs, goldOf(dataset).baseIds),
    retryRate: runs.filter((r) => r.attempts > 1).length / runs.length,
    persistentFailureRate: runs.filter((r) => r.status === "unavailable").length / runs.length,
  };
  const perfect = runs.every((r) => perfectionFailures(r).length === 0);
  return { ...result, perfect, expectationFailures: expectationFailures({ ...result, perfect, expectationFailures: [] }) };
}

// ---------- one run ----------

async function runOnce(dataset: TopicBenchmarkDataset, scenario: TopicScenario, repeat: number): Promise<TopicScenarioRun> {
  const gold = goldOf(dataset);
  const phaseGold: TopicPhaseGold = {
    taxonomy: dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition })),
    dispositions: gold.dispositions,
    members: gold.members,
    overallSentiment: gold.overallSentiment,
  };
  const classified = classifiedCommentsOf(dataset);
  const attempt = { current: 0 };
  const log: PhaseCallRecord[] = [];
  const proposals: { attempt: number; raw: unknown; sampleIds: string[] }[] = [];
  const phases = scenario.providers?.() ?? {
    generator: new ScriptedTaxonomyGenerator(phaseGold, scenario.taxonomySteps),
    assigner: new ScriptedTopicAssigner(phaseGold, scenario.assignmentSteps, scenario.keyOverride ? { keyOverride: scenario.keyOverride } : {}),
  };
  const generator = new RecordingGenerator(phases.generator, attempt, log, proposals);
  const assigner = new RecordingAssigner(phases.assigner, attempt, log);
  const discoverer = new RecordingDiscoverer(new TwoPhaseTopicDiscoverer({ generator, assigner, sample: { seed: TOPIC_BENCHMARK_SEED } }), attempt);

  const analysis = await analyzeTopics({ classified, schema: dataset.schema, focus: dataset.focus }, { discoverer, params: TOPIC_BENCHMARK_PARAMETERS });
  const section = toTopicsSection(analysis);
  const analysedIds = new Set(gold.baseIds);

  const attemptIssues = discoverer.calls.map((call) => ({ attempt: call.attempt, issues: issuesOf(call, classified, dataset, analysedIds) }));
  const failedAttemptCodes = attemptIssues.filter((a) => a.issues.length > 0).map((a) => distinctCodes(a.issues));
  const taxonomyProposals = proposals.map((p) => {
    const v = validateTopicTaxonomy(p.raw, { sampleCommentIds: p.sampleIds, maxTopics: TOPIC_BENCHMARK_PARAMETERS.maxTopics });
    return { attempt: p.attempt, valid: v.status === "valid", issueCodes: v.status === "valid" ? [] : distinctCodes(v.issues) };
  });

  let discovery: TopicDiscoveryResult | undefined;
  if (analysis.status === "available" && analysis.method.attempts > 0) {
    const accepted = discoverer.calls[discoverer.calls.length - 1]!;
    discovery = parseTopicDiscoveryOutput(accepted.raw, gold.baseIds, { maxTopics: TOPIC_BENCHMARK_PARAMETERS.maxTopics, sentimentLabels: dataset.schema.sentimentLabels });
  }
  const sampleIds = proposals.length > 0 ? proposals[proposals.length - 1]!.sampleIds : [];
  const taxonomy = discovery ? taxonomyMetrics(discovery, dataset, gold, sampleIds) : null;
  const assignment = discovery && taxonomy ? assignmentMetrics(discovery, gold, taxonomy.matches) : null;
  const report = discovery && taxonomy && section.status === "available" ? reportMetrics(section, discovery, dataset, gold, taxonomy.matches) : null;
  const predictions = discovery ? Object.fromEntries(discovery.assignments.map((a) => [a.commentId, a.disposition === "primary_topic" ? `primary_topic:${a.topicId}:${a.topicSentiment}` : a.disposition])) : null;

  const retry = retryChecks({ analysis, section, log, attemptIssues, gold, dataset, proposals });
  const run: Omit<TopicScenarioRun, "fingerprint"> = {
    repeat,
    status: analysis.status,
    attempts: analysis.method.attempts,
    generatorCalls: log.filter((c) => c.phase === "taxonomy").length,
    assignerCalls: log.filter((c) => c.phase === "assignment").length,
    phaseCalls: log,
    failedAttemptCodes,
    taxonomyProposals,
    taxonomy,
    assignment,
    report,
    retry,
    predictions,
    section,
  };
  const fingerprint = JSON.stringify({
    status: run.status,
    attempts: run.attempts,
    phaseCalls: log,
    failedAttemptCodes,
    topics: discovery?.topics ?? null,
    predictions,
    section,
  });
  return { ...run, fingerprint };
}

function issuesOf(call: DiscovererCall, classified: readonly ClassifiedComment[], dataset: TopicBenchmarkDataset, analysedIds: ReadonlySet<string>): TopicIssue[] {
  if (call.error !== undefined) return call.error instanceof TopicDiscoveryOutputError ? sanitizeReportedIssues(call.error.issues, analysedIds) : [{ code: "provider_error" }];
  const result = validateTopicAttempt(call.raw, classified, dataset.schema, TOPIC_BENCHMARK_PARAMETERS);
  return result.status === "valid" ? [] : result.issues;
}

const distinctCodes = (issues: readonly { code: TopicIssueCode }[]): TopicIssueCode[] => [...new Set(issues.map((i) => i.code))].sort(compareIds);

// ---------- recording wrappers (observe only; never change requests or responses) ----------

interface DiscovererCall {
  attempt: number;
  raw?: unknown;
  error?: unknown;
}

class RecordingDiscoverer implements TopicDiscoverer {
  readonly label: string;
  readonly calls: DiscovererCall[] = [];
  constructor(
    private readonly inner: TwoPhaseTopicDiscoverer,
    private readonly attempt: { current: number },
  ) {
    this.label = inner.label;
  }
  async discoverTopics(request: TopicDiscoveryRequest): Promise<unknown> {
    const attempt = request.run?.attempt ?? this.calls.length + 1;
    this.attempt.current = attempt;
    try {
      const raw = await this.inner.discoverTopics(request);
      this.calls.push({ attempt, raw });
      return raw;
    } catch (error) {
      this.calls.push({ attempt, error });
      throw error;
    }
  }
  finishRun(runId: string): TopicDiscoveryRunInfo | undefined {
    return this.inner.finishRun(runId);
  }
}

class RecordingGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  constructor(
    private readonly inner: TopicTaxonomyGenerator,
    private readonly attempt: { current: number },
    private readonly log: PhaseCallRecord[],
    private readonly proposals: { attempt: number; raw: unknown; sampleIds: string[] }[],
  ) {
    this.label = inner.label;
  }
  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    const record: PhaseCallRecord = { phase: "taxonomy", attempt: this.attempt.current, comments: request.sample.length, ...(request.feedback ? { feedback: structuredClone(request.feedback) } : {}), failed: false };
    this.log.push(record);
    try {
      const raw = await this.inner.proposeTaxonomy(request);
      this.proposals.push({ attempt: this.attempt.current, raw: structuredClone(raw), sampleIds: request.sample.map((c) => c.id) });
      return raw;
    } catch (error) {
      record.failed = true;
      throw error;
    }
  }
}

class RecordingAssigner implements TopicAssigner {
  readonly label: string;
  constructor(
    private readonly inner: TopicAssigner,
    private readonly attempt: { current: number },
    private readonly log: PhaseCallRecord[],
  ) {
    this.label = inner.label;
  }
  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    const record: PhaseCallRecord = { phase: "assignment", attempt: this.attempt.current, comments: request.comments.length, ...(request.feedback ? { feedback: structuredClone(request.feedback) } : {}), failed: false };
    this.log.push(record);
    try {
      return await this.inner.assignTopics(request);
    } catch (error) {
      record.failed = true;
      throw error;
    }
  }
}

// ---------- taxonomy ----------

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter;
}

/**
 * Maps each predicted topic to the gold concept with the highest member-comment Jaccard when it is ≥ 0.5 (design §10).
 * Ties go to the gold concept listed first; names are never compared. Output is ordered by topic ID.
 */
export function matchPredictedTopics(
  predicted: readonly { id: string; name: string; members: ReadonlySet<string> }[],
  gold: readonly { key: string; members: ReadonlySet<string> }[],
): TopicMatch[] {
  return [...predicted]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((t) => {
      let best: { key: string; j: number } | undefined;
      for (const g of gold) {
        const j = jaccard(t.members, g.members);
        if (!best || j > best.j) best = { key: g.key, j };
      }
      const j = best?.j ?? 0;
      return { topicId: t.id, name: t.name, members: t.members.size, goldKey: best && j >= MATCH_JACCARD_THRESHOLD ? best.key : null, jaccard: round(j) };
    });
}

function predictedMembers(discovery: TopicDiscoveryResult): Map<string, Set<string>> {
  const members = new Map<string, Set<string>>(discovery.topics.map((t) => [t.id, new Set<string>()]));
  for (const a of discovery.assignments) if (a.disposition === "primary_topic") members.get(a.topicId)?.add(a.commentId);
  return members;
}

function taxonomyMetrics(discovery: TopicDiscoveryResult, dataset: TopicBenchmarkDataset, gold: TopicGold, sampleIds: readonly string[]): TaxonomyMetrics {
  const pred = predictedMembers(discovery);
  const goldSets = dataset.taxonomy.map((t) => ({ key: t.key, members: new Set(gold.members.get(t.key) ?? []) }));
  const matches = matchPredictedTopics(
    discovery.topics.map((t) => ({ id: t.id, name: t.name, members: pred.get(t.id)! })),
    goldSets,
  );
  const matched = matches.filter((m) => m.goldKey !== null);
  const recalled = new Set(matched.map((m) => m.goldKey));

  let mergeErrors = 0;
  for (const members of pred.values()) {
    if (goldSets.filter((g) => g.members.size > 0 && overlap(members, g.members) >= MERGE_SPLIT_SHARE * g.members.size).length >= 2) mergeErrors += 1;
  }
  let splitErrors = 0;
  for (const g of goldSets) {
    if (g.members.size > 0 && [...pred.values()].filter((members) => overlap(members, g.members) >= MERGE_SPLIT_SHARE * g.members.size).length >= 2) splitErrors += 1;
  }

  const texts = dataset.comments.map((c) => c.text);
  const definitionIssues = discovery.topics.map((t) => ({ topicId: t.id, issues: definitionProblems(t.name, t.description ?? "", texts) })).filter((d) => d.issues.length > 0);
  const sample = new Set(sampleIds);
  const examples = discovery.topics.flatMap((t) => t.formation.providerExampleIds.map((id) => ({ topic: t.id, id })));
  const n = discovery.topics.length;
  return {
    predictedTopics: n,
    matchedTopics: matched.length,
    topicPrecision: n === 0 ? 0 : matched.length / n,
    conceptRecall: recalled.size / dataset.taxonomy.length,
    mergeErrors,
    splitErrors,
    definitionValidity: n === 0 ? 0 : (n - definitionIssues.length) / n,
    definitionIssues,
    exampleIdValidity: n === 0 ? 0 : discovery.topics.filter((t) => t.formation.providerExampleIds.every((id) => sample.has(id))).length / n,
    exampleSupport: examples.length === 0 ? 1 : examples.filter((e) => pred.get(e.topic)!.has(e.id)).length / examples.length,
    matches,
  };
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Structural definition checks (design §10): content quality is out of scope for an offline harness. */
export function definitionProblems(name: string, definition: string, commentTexts: readonly string[]): string[] {
  const problems: string[] = [];
  const d = definition.trim();
  if (d === "") problems.push("empty_definition");
  if (d.length > MAX_DEFINITION_CHARS) problems.push("definition_too_long");
  if (/[.!?]\s+\S/.test(d)) problems.push("more_than_one_sentence");
  const nd = normalizeText(d);
  // Same rule as the leakage audits: a whole comment of at least 10 normalised characters inside the definition.
  if (nd !== "" && commentTexts.map(normalizeText).some((t) => t.length >= 10 && nd.includes(t))) problems.push("copies_a_comment");
  const words = new Set(normalizeText(name).split(" "));
  if (NAME_SENTIMENT_WORDS.some((w) => words.has(w))) problems.push("sentiment_word_in_name");
  return problems;
}

// ---------- assignment ----------

function assignmentMetrics(discovery: TopicDiscoveryResult, gold: TopicGold, matches: readonly TopicMatch[]): AssignmentMetrics {
  const goldKeyOf = new Map(matches.map((m) => [m.topicId, m.goldKey]));
  const predicted = new Map(discovery.assignments.map((a) => [a.commentId, a]));
  let dispositionCorrect = 0;
  let primaryTotal = 0;
  let primaryCorrect = 0;
  let sentimentScored = 0;
  let sentimentCorrect = 0;
  let overallAgree = 0;
  const counts = { otherGold: 0, otherHit: 0, otherPred: 0, nstGold: 0, nstHit: 0, nstPred: 0 };
  for (const id of gold.baseIds) {
    const g = gold.dispositions.get(id)!;
    const p = predicted.get(id);
    if (p?.disposition === "other") counts.otherPred += 1;
    if (p?.disposition === "no_specific_topic") counts.nstPred += 1;
    if (p?.disposition === g.disposition) dispositionCorrect += 1;
    if (g.disposition === "other") {
      counts.otherGold += 1;
      if (p?.disposition === "other") counts.otherHit += 1;
    } else if (g.disposition === "no_specific_topic") {
      counts.nstGold += 1;
      if (p?.disposition === "no_specific_topic") counts.nstHit += 1;
    } else {
      primaryTotal += 1;
      if (p?.disposition === "primary_topic" && goldKeyOf.get(p.topicId) === g.topicKey) {
        primaryCorrect += 1;
        sentimentScored += 1;
        if (p.topicSentiment === g.topicSentiment) sentimentCorrect += 1;
        if (gold.overallSentiment.get(id) === g.topicSentiment) overallAgree += 1;
      }
    }
  }
  const B = gold.baseIds.length;
  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  return {
    dispositionAccuracy: ratio(dispositionCorrect, B),
    primaryTopicAccuracy: ratio(primaryCorrect, primaryTotal),
    otherAccuracy: ratio(counts.otherHit, counts.otherGold),
    otherPrecision: ratio(counts.otherHit, counts.otherPred),
    noSpecificTopicAccuracy: ratio(counts.nstHit, counts.nstGold),
    noSpecificTopicPrecision: ratio(counts.nstHit, counts.nstPred),
    topicSentimentAccuracy: sentimentScored === 0 ? null : sentimentCorrect / sentimentScored,
    topicSentimentScored: sentimentScored,
    overallSentimentAgreement: sentimentScored === 0 ? null : overallAgree / sentimentScored,
    // Rejected comments (invalid, duplicated, missing, unknown topic) have no validated assignment.
    fullValidity: ratio(gold.baseIds.filter((id) => predicted.has(id)).length, B),
  };
}

// ---------- reportability ----------

interface GoldReport {
  B: number;
  minTopicSize: number;
  named: Map<string, number>;
  other: number;
  noSpecificTopic: number;
  highOtherShare: boolean;
}

function goldReport(dataset: TopicBenchmarkDataset, gold: TopicGold): GoldReport {
  const B = gold.baseIds.length;
  const min = minimumTopicSize(B, TOPIC_BENCHMARK_PARAMETERS);
  const named = new Map<string, number>();
  let other = 0;
  let nst = 0;
  for (const t of dataset.taxonomy) {
    const n = gold.members.get(t.key)?.length ?? 0;
    if (n >= min) named.set(t.key, n);
    else other += n;
  }
  for (const d of gold.dispositions.values()) {
    if (d.disposition === "other") other += 1;
    if (d.disposition === "no_specific_topic") nst += 1;
  }
  const namedCount = [...named.values()].reduce((s, n) => s + n, 0);
  const coverage = { sentimentBase: B, spamExcluded: dataset.comments.length - B, namedTopics: share(namedCount, B), other: share(other, B), noSpecificTopic: share(nst, B) };
  return { B, minTopicSize: min, named, other, noSpecificTopic: nst, highOtherShare: highOtherShareWarning(coverage, TOPIC_BENCHMARK_PARAMETERS.otherWarningThresholdPercent).length > 0 };
}

function reportMetrics(section: Extract<TopicsSection, { status: "available" }>, discovery: TopicDiscoveryResult, dataset: TopicBenchmarkDataset, gold: TopicGold, matches: readonly TopicMatch[]): ReportMetrics {
  const expected = goldReport(dataset, gold);
  const B = expected.B;
  const pp = (count: number) => (B === 0 ? 0 : (count / B) * 100);
  const goldKeyOf = new Map(matches.map((m) => [m.topicId, m.goldKey]));
  const reportedNamed = new Map<string, number>();
  let unmatched = 0;
  for (const t of section.topics) {
    const key = goldKeyOf.get(t.id) ?? null;
    if (key === null) unmatched += t.count.count;
    else reportedNamed.set(key, (reportedNamed.get(key) ?? 0) + t.count.count);
  }
  const namedShareErrorPp: Record<string, number> = {};
  for (const t of dataset.taxonomy) namedShareErrorPp[t.key] = round(Math.abs(pp(reportedNamed.get(t.key) ?? 0) - pp(expected.named.get(t.key) ?? 0)));

  let topicsWithEvidence = 0;
  let labelPairs = 0;
  let labelPairsCovered = 0;
  let evidenceTotal = 0;
  let evidenceCorrect = 0;
  for (const t of section.topics) {
    if (t.evidence.length > 0) topicsWithEvidence += 1;
    for (const row of t.topicSentiment.rows) {
      if (row.count === 0) continue;
      labelPairs += 1;
      if (t.evidence.some((e) => e.topicSentiment === row.label)) labelPairsCovered += 1;
    }
    const key = goldKeyOf.get(t.id) ?? null;
    for (const e of t.evidence) {
      evidenceTotal += 1;
      const g = gold.dispositions.get(e.commentId);
      if (key !== null && g?.disposition === "primary_topic" && g.topicKey === key) evidenceCorrect += 1;
    }
  }
  const { namedTopics, other, noSpecificTopic } = section.coverage;
  const everyCommentOnce = discovery.assignments.length === B && discovery.rejectedCommentIds.length === 0 && new Set(discovery.assignments.map((a) => a.commentId)).size === B;
  const ac23Valid = everyCommentOnce && namedTopics.count + other.count + noSpecificTopic.count === B && section.topics.reduce((s, t) => s + t.count.count, 0) === namedTopics.count;
  const reported = section.warnings.some((w) => w.code === "HIGH_OTHER_SHARE");
  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  return {
    namedShareErrorPp,
    namedShareErrorMaxPp: Math.max(0, ...Object.values(namedShareErrorPp)),
    unmatchedNamedSharePp: round(pp(unmatched)),
    otherShareErrorPp: round(Math.abs(pp(other.count) - pp(expected.other))),
    noSpecificTopicShareErrorPp: round(Math.abs(pp(noSpecificTopic.count) - pp(expected.noSpecificTopic))),
    highOtherShareExpected: expected.highOtherShare,
    highOtherShareReported: reported,
    highOtherShareCorrect: reported === expected.highOtherShare,
    evidenceCoverage: ratio(topicsWithEvidence, section.topics.length),
    evidenceSentimentCoverage: ratio(labelPairsCovered, labelPairs),
    evidencePrecision: ratio(evidenceCorrect, evidenceTotal),
    ac23Valid,
  };
}

// ---------- retry ----------

function retryChecks(input: {
  analysis: TopicAnalysis;
  section: TopicsSection;
  log: readonly PhaseCallRecord[];
  attemptIssues: readonly { attempt: number; issues: TopicIssue[] }[];
  gold: TopicGold;
  dataset: TopicBenchmarkDataset;
  proposals: readonly { raw: unknown }[];
}): RetryChecks {
  const { analysis, section, log, attemptIssues, gold, dataset } = input;
  const attempts = analysis.method.attempts;
  const first = attemptIssues.find((a) => a.attempt === 1);
  const expectedFeedback = first && first.issues.length > 0 ? toValidationFeedback(1, first.issues, gold.baseIds) : undefined;
  const retried = attempts > 1;
  const feedbacks = log.filter((c) => c.feedback !== undefined).map((c) => c.feedback!);
  const retryCalls = log.filter((c) => c.attempt === 2);

  // Feedback may carry neither comment text, raw output nor proposed names/definitions; the report may carry the
  // accepted (normalised) names and definitions, but never comment text or raw output.
  const feedbackForbidden = forbiddenStrings(dataset, input.proposals);
  const reportForbidden = forbiddenStrings(dataset, []);
  const leaks = (value: unknown, forbidden: readonly string[]) => {
    const text = JSON.stringify(value);
    return forbidden.some((s) => text.includes(s));
  };
  const base = new Set(gold.baseIds);
  const feedbackShapeOk = feedbacks.every(
    (f) =>
      Object.keys(f).every((k) => k === "attempt" || k === "issues") &&
      f.issues.every(
        (i) =>
          Object.keys(i).every((k) => ["code", "count", "commentIds", "topicKeys"].includes(k)) &&
          (i.commentIds ?? []).every((id) => base.has(id)) &&
          (i.topicKeys ?? []).every((k) => TOPIC_KEY_PATTERN.test(k)),
      ),
  );

  let diagnosticsMatch: boolean;
  if (analysis.status === "unavailable") {
    const recomputed = attemptIssues.flatMap((a) => a.issues.map((i) => `${a.attempt}:${i.code}`)).sort(compareIds);
    diagnosticsMatch = JSON.stringify(analysis.issues.map((i) => `${i.attempt}:${i.code}`).sort(compareIds)) === JSON.stringify(recomputed);
  } else {
    const last = attemptIssues[attemptIssues.length - 1];
    diagnosticsMatch = attemptIssues.length === attempts && (last === undefined || last.issues.length === 0);
  }

  return {
    withinAttemptLimit: attempts <= MAX_TOPIC_ATTEMPTS,
    phaseCallsWithinLimit: log.filter((c) => c.phase === "taxonomy").length <= MAX_TOPIC_ATTEMPTS && log.filter((c) => c.phase === "assignment").length <= MAX_TOPIC_ATTEMPTS,
    feedbackSent: retried ? retryCalls.some((c) => c.feedback !== undefined) : null,
    feedbackCorrect: retried
      ? expectedFeedback !== undefined &&
        log.filter((c) => c.attempt === 1).every((c) => c.feedback === undefined) &&
        retryCalls.filter((c) => c.feedback !== undefined).every((c) => JSON.stringify(c.feedback) === JSON.stringify(expectedFeedback))
      : null,
    feedbackSanitized: feedbackShapeOk && !feedbacks.some((f) => leaks(f, feedbackForbidden)),
    reportSanitized: !leaks(section, reportForbidden),
    noPartialTopics: analysis.status === "unavailable" ? !("topics" in analysis) && !("topics" in section) : null,
    diagnosticsMatch,
  };
}

/** Strings that must never travel in feedback or the report: comment texts, raw provider markers, proposed names and definitions. */
function forbiddenStrings(dataset: TopicBenchmarkDataset, proposals: readonly { raw: unknown }[]): string[] {
  const out = new Set<string>([MALFORMED_MARKER, FABRICATED_EXAMPLE_ID]);
  for (const c of dataset.comments) if (c.text.length >= 12) out.add(JSON.stringify(c.text).slice(1, -1));
  for (const p of proposals) {
    const topics = (p.raw as { topics?: unknown }).topics;
    if (!Array.isArray(topics)) continue;
    for (const t of topics) {
      const { name, definition } = (t ?? {}) as { name?: unknown; definition?: unknown };
      if (typeof definition === "string" && definition.trim().length >= 12) out.add(JSON.stringify(definition).slice(1, -1));
      if (typeof name === "string" && name.trim().length >= 4) out.add(JSON.stringify(name).slice(1, -1));
    }
  }
  return [...out];
}

// ---------- scenario summary ----------

function repeatConsistency(runs: readonly TopicScenarioRun[], baseIds: readonly string[]): number {
  if (runs.every((r) => r.predictions === null)) return 1;
  if (runs.some((r) => r.predictions === null)) return 0;
  if (baseIds.length === 0) return 1;
  const agree = baseIds.filter((id) => runs.every((r) => r.predictions![id] === runs[0]!.predictions![id])).length;
  return agree / baseIds.length;
}

/** Why a run is not perfect (empty when every metric is perfect). */
export function perfectionFailures(run: TopicScenarioRun): string[] {
  const out: string[] = [];
  const { taxonomy: t, assignment: a, report: r } = run;
  if (run.status !== "available" || !t || !a || !r) return ["topics unavailable"];
  if (t.topicPrecision !== 1) out.push(`topic precision ${t.topicPrecision}`);
  if (t.conceptRecall !== 1) out.push(`concept recall ${t.conceptRecall}`);
  if (t.mergeErrors !== 0) out.push(`${t.mergeErrors} merge errors`);
  if (t.splitErrors !== 0) out.push(`${t.splitErrors} split errors`);
  if (t.definitionValidity !== 1) out.push(`definition validity ${t.definitionValidity}`);
  if (t.exampleIdValidity !== 1 || t.exampleSupport !== 1) out.push("example IDs not valid and supporting");
  if (a.dispositionAccuracy !== 1) out.push(`disposition accuracy ${a.dispositionAccuracy}`);
  if (a.primaryTopicAccuracy !== 1) out.push(`primary-topic accuracy ${a.primaryTopicAccuracy}`);
  if (a.otherAccuracy !== 1 || a.otherPrecision !== 1) out.push("OTHER not exact");
  if (a.noSpecificTopicAccuracy !== 1 || a.noSpecificTopicPrecision !== 1) out.push("NO_SPECIFIC_TOPIC not exact");
  if (a.topicSentimentAccuracy !== 1) out.push(`topic-sentiment accuracy ${a.topicSentimentAccuracy}`);
  if (a.fullValidity !== 1) out.push(`per-comment validity ${a.fullValidity}`);
  if (r.namedShareErrorMaxPp !== 0 || r.unmatchedNamedSharePp !== 0) out.push("named topic shares differ from gold");
  if (r.otherShareErrorPp !== 0 || r.noSpecificTopicShareErrorPp !== 0) out.push("OTHER / NO_SPECIFIC_TOPIC shares differ from gold");
  if (!r.highOtherShareCorrect) out.push("HIGH_OTHER_SHARE differs from gold");
  if (r.evidenceCoverage !== 1 || r.evidenceSentimentCoverage !== 1 || r.evidencePrecision !== 1) out.push("evidence incomplete or off-topic");
  if (!r.ac23Valid) out.push("AC-23 violated");
  return out;
}

function expectationFailures(result: TopicScenarioResult): string[] {
  const e = result.expected;
  const out: string[] = [];
  for (const run of result.runs) {
    const tag = `repeat ${run.repeat}`;
    if (run.status !== e.status) out.push(`${tag}: status ${run.status}, expected ${e.status}`);
    if (run.attempts !== e.attempts) out.push(`${tag}: ${run.attempts} attempts, expected ${e.attempts}`);
    if (run.generatorCalls !== e.generatorCalls) out.push(`${tag}: ${run.generatorCalls} taxonomy calls, expected ${e.generatorCalls}`);
    if (run.assignerCalls !== e.assignerCalls) out.push(`${tag}: ${run.assignerCalls} assignment calls, expected ${e.assignerCalls}`);
    if (JSON.stringify(run.failedAttemptCodes) !== JSON.stringify(e.failedAttemptCodes)) out.push(`${tag}: failed-attempt codes ${JSON.stringify(run.failedAttemptCodes)}, expected ${JSON.stringify(e.failedAttemptCodes)}`);
    const failures = perfectionFailures(run);
    if (e.perfect && failures.length > 0) out.push(`${tag}: not perfect (${failures.join("; ")})`);
    if (!e.perfect && failures.length === 0) out.push(`${tag}: perfect, but a degradation was expected`);
    const r = run.retry;
    if (!r.withinAttemptLimit || !r.phaseCallsWithinLimit) out.push(`${tag}: more than two attempts or phase calls`);
    if (r.feedbackSent === false || r.feedbackCorrect === false) out.push(`${tag}: retry feedback missing or wrong`);
    if (!r.feedbackSanitized || !r.reportSanitized) out.push(`${tag}: raw content in feedback or report`);
    if (r.noPartialTopics === false) out.push(`${tag}: unavailable result carries topics`);
    if (!r.diagnosticsMatch) out.push(`${tag}: diagnostics differ from the recomputed attempt issues`);
    if (run.status === "available" && run.report && !run.report.ac23Valid) out.push(`${tag}: AC-23 violated`);
  }
  if (!result.repeatIdentical) out.push("repeats differ");
  return out;
}

/** The oracle must be perfect, never retry, never fail validation, satisfy AC-23 and repeat identically. */
export function oracleGateFailures(oracle: TopicScenarioResult): string[] {
  if (oracle.id !== "oracle") return ["the oracle did not run first"];
  const out = oracle.runs.flatMap((r) => perfectionFailures(r).map((f) => `repeat ${r.repeat}: ${f}`));
  if (oracle.retryRate !== 0) out.push(`retry rate ${oracle.retryRate}`);
  if (oracle.runs.some((r) => r.failedAttemptCodes.length > 0 || r.taxonomyProposals.some((p) => !p.valid))) out.push("validation failures");
  out.push(...oracle.expectationFailures);
  return [...new Set(out)];
}

// ---------- gold summary and rendering ----------

export function goldSummary(dataset: TopicBenchmarkDataset): GoldSummary {
  const gold = goldOf(dataset);
  const expected = goldReport(dataset, gold);
  const dispositions = { primary_topic: 0, other: 0, no_specific_topic: 0 };
  const topicSentiment: Record<string, Record<SentimentLabel, number>> = {};
  let differs = 0;
  for (const t of dataset.taxonomy) topicSentiment[t.key] = Object.fromEntries(dataset.schema.sentimentLabels.map((l) => [l, 0])) as Record<SentimentLabel, number>;
  for (const [id, d] of gold.dispositions) {
    dispositions[d.disposition] += 1;
    if (d.disposition !== "primary_topic") continue;
    topicSentiment[d.topicKey]![d.topicSentiment] += 1;
    if (gold.overallSentiment.get(id) !== d.topicSentiment) differs += 1;
  }
  const B = expected.B;
  const namedCount = [...expected.named.values()].reduce((s, n) => s + n, 0);
  return {
    topicBase: B,
    spamExcluded: dataset.comments.length - B,
    minTopicSize: expected.minTopicSize,
    dispositions,
    topicSizes: Object.fromEntries(dataset.taxonomy.map((t) => [t.key, gold.members.get(t.key)!.length])),
    namedTopics: dataset.taxonomy.filter((t) => expected.named.has(t.key)).map((t) => t.key),
    smallTopics: dataset.taxonomy.filter((t) => !expected.named.has(t.key)).map((t) => t.key),
    topicSentiment,
    topicSentimentDiffersFromOverall: differs,
    shares: { named: share(namedCount, B).percent, other: share(expected.other, B).percent, noSpecificTopic: share(expected.noSpecificTopic, B).percent },
    highOtherShare: expected.highOtherShare,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${round(x * 100)}%`);

export function renderTopicBenchmarkMarkdown(report: TopicBenchmarkReport): string {
  const lines: string[] = [];
  const g = report.gold;
  lines.push(`# Topic benchmark ${report.meta.datasetId} (${report.meta.datasetVersion})`);
  lines.push("");
  lines.push(`${report.meta.comments} comments; topic base ${g.topicBase}, spam excluded ${g.spamExcluded}; minimum topic size ${g.minTopicSize}; sample seed ${report.meta.sampleSeed}; repeats ${report.meta.repeats}.`);
  lines.push(`Gold: ${g.dispositions.primary_topic} primary topic, ${g.dispositions.other} OTHER, ${g.dispositions.no_specific_topic} NO_SPECIFIC_TOPIC; named ${g.namedTopics.join(", ")}; below minimum ${g.smallTopics.join(", ") || "none"}.`);
  lines.push(`Oracle gate: ${report.oracleGate.passed ? "PASSED" : `FAILED (${report.oracleGate.failures.join("; ")})`}`);
  lines.push("");
  lines.push("| Scenario | Status | Attempts | Calls (tax/asg) | Precision | Recall | Merge/Split | Disposition | Primary | OTHER | NST | Topic sentiment | Max share err (pp) | HIGH_OTHER ok | AC-23 | Repeat | Expected |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.scenarios) {
    const r = s.runs[0]!;
    const t = r.taxonomy;
    const a = r.assignment;
    const m = r.report;
    lines.push(
      `| ${s.id} | ${r.status} | ${r.attempts} | ${r.generatorCalls}/${r.assignerCalls} | ${pct(t?.topicPrecision)} | ${pct(t?.conceptRecall)} | ${t ? `${t.mergeErrors}/${t.splitErrors}` : "–"} | ${pct(a?.dispositionAccuracy)} | ${pct(a?.primaryTopicAccuracy)} | ${pct(a?.otherAccuracy)} | ${pct(a?.noSpecificTopicAccuracy)} | ${pct(a?.topicSentimentAccuracy)} | ${m ? Math.max(m.namedShareErrorMaxPp, m.otherShareErrorPp, m.noSpecificTopicShareErrorPp) : "–"} | ${m ? (m.highOtherShareCorrect ? "yes" : "no") : "–"} | ${m ? (m.ac23Valid ? "yes" : "no") : "–"} | ${s.repeatIdentical ? "identical" : "DIFFERS"} | ${s.expectationFailures.length === 0 ? "met" : "NOT MET"} |`,
    );
  }
  const unmet = report.scenarios.filter((s) => s.expectationFailures.length > 0);
  if (unmet.length > 0) {
    lines.push("");
    for (const s of unmet) lines.push(`- ${s.id}: ${s.expectationFailures.join("; ")}`);
  }
  return lines.join("\n");
}
