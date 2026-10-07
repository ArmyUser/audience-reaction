import { createHash } from "node:crypto";
import { TOPIC_DISCOVERY_CONTRACT, TOPIC_DISCOVERY_CONTRACT_V3, type TopicDiscoveryContract } from "../core/topics/provider-contracts";
import type { TopicIssueCode } from "../core/topics/types";
import type { DiscoveryBenchmarkResult } from "./topic-discovery-only";

// PRE-REGISTERED discovery-only reliability experiment (docs/topic-discovery-v3-reliability-preregistration.md):
// topic-discovery-v2 (baseline) versus topic-discovery-v3 (candidate, name-format robustness only) on the already
// observed t4 and t5 datasets. A robustness/regression experiment, not a hold-out benchmark: no consolidation, no Jev.
// Every run is one discovery-only run (the production retry policy: at most two attempts with structured feedback),
// scored by the unchanged discovery-only evaluator. The schedule, metrics, criteria and budget below were fixed before
// any live v3 result existed and must not change; every run records the definition fingerprint.

export const RELIABILITY_RUN_KIND = "discovery-reliability-run";
export const RELIABILITY_RESERVATION_KIND = "discovery-reliability-reservation";

export interface DiscoveryReliabilityExperiment {
  id: string;
  design: "fixed-schedule";
  document: string;
  baseline: TopicDiscoveryContract;
  candidate: TopicDiscoveryContract;
  discovery: { provider: string; model: string; retryPolicy: string; maxAttempts: number };
  datasets: readonly { id: string; sha256: string; version: string }[];
  /** Runs per dataset and contract; every scheduled run is run once (no replacement, no additional runs). */
  runsPerCell: number;
  replacementRuns: 0;
  budget: {
    totalUsd: number;
    /** Conservative worst case of one run (both attempts at the output ceiling) per dataset and contract, at registration. */
    worstCasePerRunUsd: Readonly<Record<string, number>>;
    worstCaseTotalUsd: number;
  };
  criteria: {
    /** 1. Candidate runs ending with a valid taxonomy, as a share of evaluable runs. */
    minEventualValidity: number;
    /** 2. Candidate runs whose first attempt is valid, as a share of runs whose first attempt received a model response. */
    minFirstAttemptValidity: number;
    /** 3. Candidate attempts rejected with invalid_topic_name, as a share of attempts that received a model response. */
    maxInvalidTopicNameRate: number;
    /** 4. Candidate mean proxy precision at least the baseline mean (no tolerance). */
    noProxyPrecisionRegression: true;
    /** 5. Candidate mean proxy recall at least the baseline mean (no tolerance). */
    noProxyRecallRegression: true;
    /** 6. No rejection code (other than invalid_topic_name) in candidate attempts that baseline attempts never showed. */
    noNewSchemaFailureMode: true;
  };
}

export const CRITERION_EPSILON = 1e-9;

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

export function reliabilityExperimentFingerprint(def: DiscoveryReliabilityExperiment): string {
  return `sha256:${createHash("sha256").update(canonicalJson(def)).digest("hex")}`;
}

export const DISCOVERY_RELIABILITY_EXPERIMENT: DiscoveryReliabilityExperiment = Object.freeze({
  id: "discovery-v3-name-robustness-v1",
  design: "fixed-schedule",
  document: "docs/topic-discovery-v3-reliability-preregistration.md",
  baseline: TOPIC_DISCOVERY_CONTRACT,
  candidate: TOPIC_DISCOVERY_CONTRACT_V3,
  discovery: Object.freeze({ provider: "anthropic", model: "claude-sonnet-5-5", retryPolicy: "production discovery retry (MAX_TOPIC_ATTEMPTS, structured feedback)", maxAttempts: 2 }),
  datasets: Object.freeze([
    Object.freeze({ id: "t4-topics-v1", sha256: "58e225f986238591de8687faab59b9445e5d22088d1a3666382ba5e2043292fd", version: "sha256:58e225f986238591" }),
    Object.freeze({ id: "t5-topics-v1", sha256: "cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3", version: "sha256:cec6e6563d81a179" }),
  ]),
  runsPerCell: 10,
  replacementRuns: 0,
  budget: Object.freeze({
    totalUsd: 14,
    worstCasePerRunUsd: Object.freeze({
      "t4-topics-v1/topic-discovery-v2": 0.33932,
      "t4-topics-v1/topic-discovery-v3": 0.339796,
      "t5-topics-v1/topic-discovery-v2": 0.339744,
      "t5-topics-v1/topic-discovery-v3": 0.34022,
    }),
    worstCaseTotalUsd: 13.5908,
  }),
  criteria: Object.freeze({
    minEventualValidity: 0.99,
    minFirstAttemptValidity: 0.95,
    maxInvalidTopicNameRate: 0.01,
    noProxyPrecisionRegression: true,
    noProxyRecallRegression: true,
    noNewSchemaFailureMode: true,
  }),
}) as DiscoveryReliabilityExperiment;

export const cellKey = (dataset: string, contract: string): string => `${dataset}/${contract}`;

// ---------- schedule ----------

export interface ScheduledReliabilityRun {
  /** 1 … datasets × 2 × runsPerCell, the fixed run order. */
  index: number;
  dataset: string;
  contract: TopicDiscoveryContract;
  /** 1 … runsPerCell within its dataset and contract. */
  runNumber: number;
}

/**
 * The fixed run order: round by round (run number 1 … runsPerCell), each dataset in turn, both contracts back to back
 * with the order alternating by round (odd rounds baseline first), so time drift affects both contracts alike.
 */
export function reliabilitySchedule(def: DiscoveryReliabilityExperiment): ScheduledReliabilityRun[] {
  const runs: ScheduledReliabilityRun[] = [];
  for (let n = 1; n <= def.runsPerCell; n++)
    for (const d of def.datasets) for (const contract of n % 2 === 1 ? [def.baseline, def.candidate] : [def.candidate, def.baseline]) runs.push({ index: runs.length + 1, dataset: d.id, contract, runNumber: n });
  return runs;
}

// ---------- saved runs and reservations ----------

export interface ReliabilityStamp {
  experiment: string;
  definitionFingerprint: string;
  scheduledRun: number;
  dataset: string;
  datasetSha256: string;
  contract: TopicDiscoveryContract;
  runNumber: number;
}

/** One saved scheduled run: the unchanged discovery-only result (one repeat) with the experiment stamp. */
export interface ReliabilityRunFile {
  kind: typeof RELIABILITY_RUN_KIND;
  stamp: ReliabilityStamp;
  result: DiscoveryBenchmarkResult;
}

export interface ReliabilityReservation {
  kind: typeof RELIABILITY_RESERVATION_KIND;
  experiment: string;
  definitionFingerprint: string;
  scheduledRun: number;
  timestamp: string;
}

export function reliabilityStampOf(def: DiscoveryReliabilityExperiment, run: ScheduledReliabilityRun): ReliabilityStamp {
  const d = def.datasets.find((x) => x.id === run.dataset)!;
  return { experiment: def.id, definitionFingerprint: reliabilityExperimentFingerprint(def), scheduledRun: run.index, dataset: run.dataset, datasetSha256: d.sha256, contract: run.contract, runNumber: run.runNumber };
}

export function reliabilityReservationOf(def: DiscoveryReliabilityExperiment, scheduledRun: number, timestamp: string): ReliabilityReservation {
  return { kind: RELIABILITY_RESERVATION_KIND, experiment: def.id, definitionFingerprint: reliabilityExperimentFingerprint(def), scheduledRun, timestamp };
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-");
export const reliabilityRunFileName = (f: ReliabilityRunFile) =>
  `${safe(f.result.meta.timestamp)}-topics-${f.stamp.dataset}-discovery-reliability-${f.stamp.experiment}-run-${String(f.stamp.scheduledRun).padStart(2, "0")}-${f.stamp.contract}.json`;
export const reliabilityReservationFileName = (r: ReliabilityReservation) => `${safe(r.timestamp)}-discovery-reliability-${r.experiment}-run-${String(r.scheduledRun).padStart(2, "0")}-reserved.json`;

type SavedRun = { file: string; run: ReliabilityRunFile };
type SavedReservation = { file: string; reservation: ReliabilityReservation };

/** The next scheduled run (every reserved or saved number is used up), or null when none is left. */
export function nextScheduledRun(def: DiscoveryReliabilityExperiment, runs: readonly SavedRun[], reservations: readonly SavedReservation[]): ScheduledReliabilityRun | null {
  const used = [...runs.filter((r) => r.run.stamp.experiment === def.id).map((r) => r.run.stamp.scheduledRun), ...reservations.filter((r) => r.reservation.experiment === def.id).map((r) => r.reservation.scheduledRun)];
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return reliabilitySchedule(def).find((s) => s.index === next) ?? null;
}

// ---------- budget and stop rule ----------

/**
 * Budget state before a run. Spent: the recorded cost of every saved run; an unpriced run and a reserved run without a
 * saved result count at their cell's registered worst case. A run may start only if its current worst case is within
 * the registered worst case of its cell and within the remaining budget.
 */
export function reliabilityBudget(def: DiscoveryReliabilityExperiment, runs: readonly SavedRun[], reservations: readonly SavedReservation[], next: ScheduledReliabilityRun, runWorstCaseUsd: number): { spentUsd: number; remainingUsd: number; allowed: boolean; reason: string } {
  const schedule = reliabilitySchedule(def);
  const worstOf = (index: number) => {
    const s = schedule.find((x) => x.index === index);
    return s ? def.budget.worstCasePerRunUsd[cellKey(s.dataset, s.contract)]! : Math.max(...Object.values(def.budget.worstCasePerRunUsd));
  };
  const own = runs.filter((r) => r.run.stamp.experiment === def.id);
  const saved = new Set(own.map((r) => r.run.stamp.scheduledRun));
  const aborted = reservations.filter((r) => r.reservation.experiment === def.id && !saved.has(r.reservation.scheduledRun));
  const spentUsd = own.reduce((s, r) => s + (r.run.result.totals.estimatedCostUsd ?? worstOf(r.run.stamp.scheduledRun)), 0) + aborted.reduce((s, r) => s + worstOf(r.reservation.scheduledRun), 0);
  const remainingUsd = def.budget.totalUsd - spentUsd;
  const registered = def.budget.worstCasePerRunUsd[cellKey(next.dataset, next.contract)]!;
  const usd = (x: number) => `$${x.toFixed(4)}`;
  if (!(runWorstCaseUsd <= registered + CRITERION_EPSILON)) return { spentUsd, remainingUsd, allowed: false, reason: `a run's worst case is now ${usd(runWorstCaseUsd)}, above the registered ${usd(registered)} (configuration or prices changed since registration)` };
  if (!(runWorstCaseUsd <= remainingUsd + CRITERION_EPSILON)) return { spentUsd, remainingUsd, allowed: false, reason: `a run's worst case ${usd(runWorstCaseUsd)} exceeds the remaining registered budget ${usd(remainingUsd)} of ${usd(def.budget.totalUsd)}` };
  return { spentUsd, remainingUsd, allowed: true, reason: `worst case ${usd(runWorstCaseUsd)} within the remaining ${usd(remainingUsd)} of ${usd(def.budget.totalUsd)}` };
}

// ---------- evaluation (offline) ----------

export type ReliabilityRunStatus = "valid" | "invalid" | "provider_unavailable" | "aborted" | "pending";

export interface ReliabilityRunOutcome {
  index: number;
  dataset: string;
  contract: string;
  runNumber: number;
  status: ReliabilityRunStatus;
  file: string | null;
  /** Attempt outcomes as recorded, e.g. ["invalid_taxonomy:invalid_topic_name", "valid"]. */
  attempts: string[];
}

/** Separated failure counts: model-format failures are never mixed with provider/API failures. */
export interface ReliabilityFailures {
  /** Attempts that received a model response. */
  respondedAttempts: number;
  /** Attempts rejected with invalid_topic_name (topic-name validation). */
  topicNameFailures: number;
  /** Attempts rejected with any other validation/schema code. */
  otherSchemaFailures: number;
  /** Other validation/schema codes seen, with counts. */
  otherSchemaCodes: Record<string, number>;
  /** Attempts that received no model response, by provider-neutral failure kind (timeouts separately). */
  providerFailures: Record<string, number>;
}

export interface ReliabilityMetrics {
  runs: number;
  evaluableRuns: number;
  providerUnavailableRuns: number;
  firstAttemptValidity: number | null;
  eventualValidity: number | null;
  invalidTopicNameRate: number | null;
  otherSchemaFailureRate: number | null;
  proxyPrecision: number | null;
  proxyRecall: number | null;
  failures: ReliabilityFailures;
}

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  detail: string;
}

export interface ReliabilityEvaluation {
  experiment: string;
  definitionFingerprint: string;
  verdict: "PASS" | "FAIL" | "INCOMPLETE" | "INVALID";
  reasons: string[];
  runs: ReliabilityRunOutcome[];
  /** Pooled over both datasets, per contract. */
  pooled: Record<string, ReliabilityMetrics>;
  /** Per dataset and contract (descriptive). */
  cells: Record<string, ReliabilityMetrics>;
  criteria: CriterionResult[];
}

const PROVIDER = "provider_error";
const NAME = "invalid_topic_name";

/** Model-format status of one saved run; a run that needed an attempt the provider never answered is provider_unavailable. */
function statusOf(result: DiscoveryBenchmarkResult): ReliabilityRunStatus {
  const run = result.runs[0];
  if (!run) return "provider_unavailable";
  if (run.status === "valid") return "valid";
  return run.attempts.some((a) => a.outcome === "provider_error") ? "provider_unavailable" : "invalid";
}

function metricsOf(items: readonly ReliabilityRunFile[]): ReliabilityMetrics {
  const failures: ReliabilityFailures = { respondedAttempts: 0, topicNameFailures: 0, otherSchemaFailures: 0, otherSchemaCodes: {}, providerFailures: {} };
  let firstResponded = 0;
  let firstValid = 0;
  let evaluable = 0;
  let valid = 0;
  let providerUnavailable = 0;
  const precision: number[] = [];
  const recall: number[] = [];
  for (const item of items) {
    const run = item.result.runs[0];
    const status = statusOf(item.result);
    if (status === "provider_unavailable") providerUnavailable += 1;
    else {
      evaluable += 1;
      if (status === "valid") valid += 1;
    }
    for (const a of run?.attempts ?? []) {
      if (a.outcome === "provider_error") {
        const kind = a.providerFailure ?? "unknown";
        failures.providerFailures[kind] = (failures.providerFailures[kind] ?? 0) + 1;
        continue;
      }
      failures.respondedAttempts += 1;
      if (a.issueCodes.includes(NAME)) failures.topicNameFailures += 1;
      const other = a.issueCodes.filter((c: TopicIssueCode) => c !== NAME && c !== PROVIDER);
      if (other.length > 0) failures.otherSchemaFailures += 1;
      for (const c of other) failures.otherSchemaCodes[c] = (failures.otherSchemaCodes[c] ?? 0) + 1;
    }
    const first = run?.attempts[0];
    if (first && first.outcome !== "provider_error") {
      firstResponded += 1;
      if (first.outcome === "valid") firstValid += 1;
    }
    if (run?.status === "valid" && run.taxonomy) {
      precision.push(run.taxonomy.topicPrecision);
      recall.push(run.taxonomy.conceptRecall);
    }
  }
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
  return {
    runs: items.length,
    evaluableRuns: evaluable,
    providerUnavailableRuns: providerUnavailable,
    firstAttemptValidity: ratio(firstValid, firstResponded),
    eventualValidity: ratio(valid, evaluable),
    invalidTopicNameRate: ratio(failures.topicNameFailures, failures.respondedAttempts),
    otherSchemaFailureRate: ratio(failures.otherSchemaFailures, failures.respondedAttempts),
    proxyPrecision: mean(precision),
    proxyRecall: mean(recall),
    failures,
  };
}

/** Problems that make a saved run inadmissible: it must be exactly the scheduled discovery-only run, as registered. */
function runProblems(def: DiscoveryReliabilityExperiment, fingerprint: string, s: SavedRun): string[] {
  const x = s.run.stamp;
  const m = s.run.result.meta;
  const scheduled = reliabilitySchedule(def).find((r) => r.index === x.scheduledRun);
  const d = def.datasets.find((ds) => ds.id === x.dataset);
  const problems: string[] = [];
  if (x.definitionFingerprint !== fingerprint) problems.push(`run under definition ${x.definitionFingerprint}, registered ${fingerprint} (the definition was altered after runs existed)`);
  if (!scheduled) return [...problems, `scheduled run ${x.scheduledRun} is outside the schedule (no additional runs)`];
  if (scheduled.dataset !== x.dataset || scheduled.contract !== x.contract || scheduled.runNumber !== x.runNumber) problems.push(`stamp does not match scheduled run ${scheduled.index} (${scheduled.dataset}, ${scheduled.contract}, run ${scheduled.runNumber})`);
  if (!d || m.dataset !== x.dataset || m.datasetVersion !== d.version || x.datasetSha256 !== d.sha256) problems.push(`dataset ${m.dataset}@${m.datasetVersion} is not the registered one`);
  if (m.kind !== "discovery-only" || m.repeats !== 1 || s.run.result.runs.length > 1) problems.push("not a single discovery-only run");
  if (m.discovery.contract !== x.contract) problems.push(`discovery contract ${m.discovery.contract} is not the scheduled ${x.contract}`);
  if (m.discovery.provider !== def.discovery.provider || m.discovery.modelRequested !== def.discovery.model) problems.push("discovery provider or model is not the registered one");
  if (m.assignment !== "not run") problems.push("assignment ran (discovery-only runs never call Jev)");
  if (s.run.result.oracleGate && !s.run.result.oracleGate.passed) problems.push("the offline oracle gate failed");
  return problems;
}

/**
 * Evaluates the experiment from its saved runs and reservations (runs of other experiments are ignored). INVALID: a run
 * does not match the registration, or a scheduled run appears twice. INCOMPLETE: any scheduled run is pending, aborted
 * or provider-unavailable (never replaced; never counted as a format failure). Otherwise the six criteria decide PASS
 * (all pass) or FAIL. Metrics are pooled over t4 and t5 per contract; per-cell values are descriptive.
 */
export function evaluateReliabilityExperiment(def: DiscoveryReliabilityExperiment, saved: readonly SavedRun[], reservations: readonly SavedReservation[] = []): ReliabilityEvaluation {
  const fingerprint = reliabilityExperimentFingerprint(def);
  const schedule = reliabilitySchedule(def);
  const own = saved.filter((s) => s.run.kind === RELIABILITY_RUN_KIND && s.run.stamp.experiment === def.id);
  const reserved = reservations.filter((r) => r.reservation.kind === RELIABILITY_RESERVATION_KIND && r.reservation.experiment === def.id);
  const outcomes: ReliabilityRunOutcome[] = schedule.map((s) => ({ index: s.index, dataset: s.dataset, contract: s.contract, runNumber: s.runNumber, status: "pending", file: null, attempts: [] }));
  const base = { experiment: def.id, definitionFingerprint: fingerprint, pooled: {}, cells: {}, criteria: [] as CriterionResult[] };

  const invalid: string[] = [];
  for (const r of reserved) {
    if (r.reservation.definitionFingerprint !== fingerprint) invalid.push(`${r.file}: reserved under definition ${r.reservation.definitionFingerprint}, registered ${fingerprint} (the definition was altered after runs existed)`);
    if (!schedule.some((s) => s.index === r.reservation.scheduledRun)) invalid.push(`${r.file}: reservation for run ${r.reservation.scheduledRun} outside the schedule (no additional runs)`);
  }
  for (const s of own) invalid.push(...runProblems(def, fingerprint, s).map((p) => `${s.file}: ${p}`));
  const numbers = own.map((s) => s.run.stamp.scheduledRun);
  for (const n of new Set(numbers)) if (numbers.filter((x) => x === n).length > 1) invalid.push(`scheduled run ${n} was run more than once (replacement runs are not allowed)`);
  if (invalid.length > 0) return { ...base, verdict: "INVALID", reasons: invalid, runs: outcomes };

  for (const r of reserved) Object.assign(outcomes[r.reservation.scheduledRun - 1]!, { status: "aborted", file: r.file });
  for (const s of own) {
    const run = s.run.result.runs[0];
    Object.assign(outcomes[s.run.stamp.scheduledRun - 1]!, { status: statusOf(s.run.result), file: s.file, attempts: (run?.attempts ?? []).map((a) => (a.outcome === "valid" ? "valid" : `${a.outcome}:${a.providerFailure ?? a.issueCodes.join("+")}`)) });
  }

  const items = (filter: (s: SavedRun) => boolean) => own.filter(filter).map((s) => s.run);
  const pooled = Object.fromEntries([def.baseline, def.candidate].map((c) => [c, metricsOf(items((s) => s.run.stamp.contract === c))]));
  const cells = Object.fromEntries(def.datasets.flatMap((d) => [def.baseline, def.candidate].map((c) => [cellKey(d.id, c), metricsOf(items((s) => s.run.stamp.dataset === d.id && s.run.stamp.contract === c))])));

  const missing = outcomes.filter((o) => o.status === "pending" || o.status === "aborted" || o.status === "provider_unavailable");
  if (missing.length > 0) {
    const count = (st: ReliabilityRunStatus) => outcomes.filter((o) => o.status === st).length;
    return {
      ...base,
      pooled,
      cells,
      verdict: "INCOMPLETE",
      reasons: [`${outcomes.length - missing.length} of ${outcomes.length} scheduled runs evaluable`, `${count("pending")} not run, ${count("aborted")} aborted, ${count("provider_unavailable")} provider-unavailable; none is replaced and none counts as a format failure`],
      runs: outcomes,
    };
  }

  const v2 = pooled[def.baseline]!;
  const v3 = pooled[def.candidate]!;
  const c = def.criteria;
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
  const atLeast = (x: number | null, min: number) => x !== null && x >= min - CRITERION_EPSILON;
  const atMost = (x: number | null, max: number) => x !== null && x <= max + CRITERION_EPSILON;
  const v2Codes = new Set(Object.keys(v2.failures.otherSchemaCodes));
  const newCodes = Object.keys(v3.failures.otherSchemaCodes).filter((k) => !v2Codes.has(k));
  const criteria: CriterionResult[] = [
    { criterion: `1. eventual validity (${def.candidate}) >= ${pct(c.minEventualValidity)}`, passed: atLeast(v3.eventualValidity, c.minEventualValidity), detail: `${def.candidate} ${pct(v3.eventualValidity)}, ${def.baseline} ${pct(v2.eventualValidity)}` },
    { criterion: `2. first-attempt validity (${def.candidate}) >= ${pct(c.minFirstAttemptValidity)}`, passed: atLeast(v3.firstAttemptValidity, c.minFirstAttemptValidity), detail: `${def.candidate} ${pct(v3.firstAttemptValidity)}, ${def.baseline} ${pct(v2.firstAttemptValidity)}` },
    { criterion: `3. invalid_topic_name rate (${def.candidate}, per responded attempt) <= ${pct(c.maxInvalidTopicNameRate)}`, passed: atMost(v3.invalidTopicNameRate, c.maxInvalidTopicNameRate), detail: `${def.candidate} ${pct(v3.invalidTopicNameRate)} (${v3.failures.topicNameFailures}/${v3.failures.respondedAttempts}), ${def.baseline} ${pct(v2.invalidTopicNameRate)} (${v2.failures.topicNameFailures}/${v2.failures.respondedAttempts})` },
    { criterion: `4. no regression in proxy precision (${def.candidate} mean >= ${def.baseline} mean)`, passed: v3.proxyPrecision !== null && v2.proxyPrecision !== null && v3.proxyPrecision >= v2.proxyPrecision - CRITERION_EPSILON, detail: `${pct(v3.proxyPrecision)} vs ${pct(v2.proxyPrecision)}` },
    { criterion: `5. no regression in proxy recall (${def.candidate} mean >= ${def.baseline} mean)`, passed: v3.proxyRecall !== null && v2.proxyRecall !== null && v3.proxyRecall >= v2.proxyRecall - CRITERION_EPSILON, detail: `${pct(v3.proxyRecall)} vs ${pct(v2.proxyRecall)}` },
    { criterion: `6. no new schema failure mode (${def.candidate} rejection codes other than ${NAME} all seen in ${def.baseline})`, passed: newCodes.length === 0, detail: newCodes.length === 0 ? "none" : newCodes.join(", ") },
  ];
  return { ...base, pooled, cells, criteria, verdict: criteria.every((x) => x.passed) ? "PASS" : "FAIL", reasons: [`all ${outcomes.length} scheduled runs evaluable`], runs: outcomes };
}

export function renderReliabilityEvaluationMarkdown(e: ReliabilityEvaluation): string {
  const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
  const lines = [`# Discovery reliability experiment ${e.experiment}`, "", `Definition: ${e.definitionFingerprint}`, `Verdict: ${e.verdict}`, ...e.reasons.map((r) => `- ${r}`)];
  const table = (title: string, rows: Record<string, ReliabilityMetrics>) => {
    if (Object.keys(rows).length === 0) return;
    lines.push("", `## ${title}`, "", "| | runs | evaluable | provider-unavailable | first-attempt valid | eventually valid | invalid_topic_name rate | other schema rate | proxy precision | proxy recall | provider failures |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [k, m] of Object.entries(rows))
      lines.push(`| ${k} | ${m.runs} | ${m.evaluableRuns} | ${m.providerUnavailableRuns} | ${pct(m.firstAttemptValidity)} | ${pct(m.eventualValidity)} | ${pct(m.invalidTopicNameRate)} | ${pct(m.otherSchemaFailureRate)} | ${pct(m.proxyPrecision)} | ${pct(m.proxyRecall)} | ${JSON.stringify(m.failures.providerFailures)} |`);
  };
  table("Pooled (t4 + t5)", e.pooled);
  table("Per dataset (descriptive)", e.cells);
  if (e.criteria.length > 0) lines.push("", "| Criterion | Result | Values |", "|---|---|---|", ...e.criteria.map((c) => `| ${c.criterion} | ${c.passed ? "pass" : "FAIL"} | ${c.detail} |`));
  lines.push("", "| Run | Dataset | Contract | # | Status | Attempts |", "|---|---|---|---|---|---|", ...e.runs.map((r) => `| ${r.index} | ${r.dataset} | ${r.contract} | ${r.runNumber} | ${r.status} | ${r.attempts.join("; ") || "–"} |`));
  return lines.join("\n");
}
