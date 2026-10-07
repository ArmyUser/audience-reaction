import { TOPIC_CONSOLIDATION_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT_V4 } from "../core/topics/consolidation-contract";
import type { RealConsolidatedResult } from "./topic-real-consolidated";

// PRE-REGISTERED consolidation experiment (docs/topic-consolidation-v4-experiment.md): frozen topic-consolidation-v3
// (arm A) versus the experimental topic-consolidation-v4 (arm B) on the same hold-out dataset, through the same
// real-consolidated code path, scored by the unchanged evaluator. Offline: this module only reads saved result files;
// it never calls a provider. The criteria, the run-selection rule and the aggregation below were fixed before any live
// v4 result existed and must not be changed after results are seen.

export const V4_EXPERIMENT = Object.freeze({
  id: "consolidation-v4-subject-coherence",
  dataset: "t4-topics-v1",
  baseline: TOPIC_CONSOLIDATION_CONTRACT,
  candidate: TOPIC_CONSOLIDATION_CONTRACT_V4,
  /** Runs per arm. Selection: the FIRST this-many saved runs of the arm, in timestamp order (never the best ones). */
  repeatsPerArm: 3,
  criteria: Object.freeze({
    /** Mean topic precision of the v4 runs. */
    minTopicPrecision: 0.88,
    /** Mean concept recall of the v4 runs. */
    minConceptRecall: 0.92,
    /** Sum of merge errors over the v4 runs minus the sum over the v3 runs ("zero new merge errors relative to v3"). */
    maxNewMergeErrors: 0,
    /** "No regression": the v4 mean must be at least the v3 mean (no tolerance). */
    noRegression: ["topicSentimentAccuracy", "primaryTopicAccuracy"] as const,
  }),
  /**
   * An unavailable run (no taxonomy or no assignment) is kept, never skipped, and scores 0 on every rate metric and
   * contributes no merge errors.
   */
  unavailableRunScore: 0,
});

export interface ArmRun {
  file: string;
  timestamp: string;
  available: boolean;
  topicPrecision: number;
  conceptRecall: number;
  mergeErrors: number;
  splitErrors: number;
  dispositionAccuracy: number;
  primaryTopicAccuracy: number;
  otherAccuracy: number;
  noSpecificTopicAccuracy: number;
  topicSentimentAccuracy: number;
  evidencePrecision: number;
  /** Diagnostic only (instrumented results); null when not recorded. */
  reportOtherAccuracy: number | null;
  discoveredTopics: number | null;
  consolidatedTopics: number | null;
  retained: number | null;
  merged: number | null;
  dropped: number | null;
  costUsd: number | null;
  latencyMs: { discovery: number; consolidation: number; assignment: number; all: number };
}

/** The settings that must be identical between the arms: everything except the consolidation contract. */
export function comparableSettings(r: RealConsolidatedResult): Record<string, unknown> {
  const p = r.report.meta.parameters;
  return {
    dataset: r.meta.dataset,
    datasetVersion: r.meta.datasetVersion,
    discovery: { provider: r.meta.discovery.provider, model: r.meta.discovery.modelRequested, contract: r.meta.discovery.contract, effort: (r.meta.discovery as { effort?: string }).effort ?? null },
    assignment: { provider: r.meta.assignment.provider, model: r.meta.assignment.modelRequested, contract: r.meta.assignment.contract, questionSet: (r.meta.assignment as { questionSet?: string }).questionSet ?? null, maxCommentsPerBatch: (r.meta.assignment as { maxCommentsPerBatch?: number }).maxCommentsPerBatch ?? null },
    sampleSeed: r.report.meta.sampleSeed,
    parameters: p,
    minTopicSize: r.meta.consolidation.minTopicSize,
    matching: r.report.meta.matching,
  };
}

/** One saved result as experiment runs (one per repeat), scored by the evaluator's own per-run values. */
export function armRunsOf(file: string, r: RealConsolidatedResult): ArmRun[] {
  const scenario = r.report.scenarios.find((s) => s.id !== "oracle");
  if (!scenario) return [];
  const z = V4_EXPERIMENT.unavailableRunScore;
  return scenario.runs.map((run) => {
    const call = r.phases.find((p) => p.repeat === run.repeat)?.taxonomyCalls.find((c) => c.consolidation.status === "valid");
    const usage = r.usage.find((u) => u.repeat === run.repeat);
    const inst = r.instrumentation?.repeats.find((x) => x.repeat === run.repeat)?.run ?? null;
    const t = run.taxonomy;
    const a = run.assignment;
    const available = run.status === "available" && t !== null && a !== null && run.report !== null;
    return {
      file,
      timestamp: r.meta.timestamp,
      available,
      topicPrecision: available ? t!.topicPrecision : z,
      conceptRecall: available ? t!.conceptRecall : z,
      mergeErrors: available ? t!.mergeErrors : 0,
      splitErrors: available ? t!.splitErrors : 0,
      dispositionAccuracy: available ? a!.dispositionAccuracy : z,
      primaryTopicAccuracy: available ? a!.primaryTopicAccuracy : z,
      otherAccuracy: available ? a!.otherAccuracy : z,
      noSpecificTopicAccuracy: available ? a!.noSpecificTopicAccuracy : z,
      topicSentimentAccuracy: available ? (a!.topicSentimentAccuracy ?? z) : z,
      evidencePrecision: available ? run.report!.evidencePrecision : z,
      reportOtherAccuracy: inst?.reportOther?.reportOtherAccuracy ?? null,
      discoveredTopics: call?.discovery.topics ?? null,
      consolidatedTopics: call?.consolidation.topics ?? null,
      retained: call?.consolidation.decisions?.retained.length ?? null,
      merged: call?.consolidation.decisions?.merged.length ?? null,
      dropped: call?.consolidation.decisions?.dropped.length ?? null,
      costUsd: usage ? sumCost([usage.discovery.estimatedCostUsd, usage.consolidation.estimatedCostUsd, usage.assignment.estimatedCostUsd]) : null,
      latencyMs: {
        discovery: usage?.discovery.latencyMs.total ?? 0,
        consolidation: usage?.consolidation.latencyMs.total ?? 0,
        assignment: usage?.assignment.latencyMs.total ?? 0,
        all: (usage?.discovery.latencyMs.total ?? 0) + (usage?.consolidation.latencyMs.total ?? 0) + (usage?.assignment.latencyMs.total ?? 0),
      },
    };
  });
}

function sumCost(xs: (number | undefined)[]): number | null {
  return xs.every((x) => x !== undefined) ? xs.reduce<number>((s, x) => s + x!, 0) : null;
}

export interface Stat {
  mean: number;
  min: number;
  max: number;
  sd: number;
}

export function statOf(xs: readonly number[]): Stat | null {
  if (xs.length === 0) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { mean, min: Math.min(...xs), max: Math.max(...xs), sd: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) };
}

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  detail: string;
}

export interface ExperimentEvaluation {
  experiment: typeof V4_EXPERIMENT.id;
  dataset: string;
  /** Only the pre-registered dataset yields a binding verdict; any other dataset is exploratory (regression check). */
  preRegistered: boolean;
  verdict: "PASS" | "FAIL" | "INCOMPLETE" | "INVALID";
  reasons: string[];
  arms: { contract: string; runs: ArmRun[] }[];
  criteria: CriterionResult[];
}

const METRICS = ["topicPrecision", "conceptRecall", "dispositionAccuracy", "primaryTopicAccuracy", "otherAccuracy", "noSpecificTopicAccuracy", "topicSentimentAccuracy", "evidencePrecision"] as const;

/**
 * Evaluates saved results against the fixed criteria. `results` are all saved real-consolidated results (any order);
 * arms are picked by consolidation contract and dataset, then the first `repeatsPerArm` runs of each arm by timestamp.
 */
export function evaluateConsolidationExperiment(datasetId: string, datasetVersion: string, results: readonly { file: string; result: RealConsolidatedResult }[]): ExperimentEvaluation {
  const reasons: string[] = [];
  const armOf = (contract: string) => {
    const matching = results
      .filter((x) => x.result.meta.kind === "real-consolidated" && x.result.meta.dataset === datasetId && x.result.meta.consolidation.contract === contract)
      .sort((a, b) => a.result.meta.timestamp.localeCompare(b.result.meta.timestamp) || a.file.localeCompare(b.file));
    const stale = matching.filter((x) => x.result.meta.datasetVersion !== datasetVersion);
    if (stale.length > 0) reasons.push(`${stale.length} ${contract} result(s) for another version of ${datasetId} ignored`);
    const current = matching.filter((x) => x.result.meta.datasetVersion === datasetVersion);
    return { contract, results: current, runs: current.flatMap((x) => armRunsOf(x.file, x.result)).slice(0, V4_EXPERIMENT.repeatsPerArm) };
  };
  const a = armOf(V4_EXPERIMENT.baseline);
  const b = armOf(V4_EXPERIMENT.candidate);
  const arms = [
    { contract: a.contract, runs: a.runs },
    { contract: b.contract, runs: b.runs },
  ];
  const base = { experiment: V4_EXPERIMENT.id, dataset: datasetId, preRegistered: datasetId === V4_EXPERIMENT.dataset, arms } as const;

  for (const arm of [a, b]) if (arm.runs.length < V4_EXPERIMENT.repeatsPerArm) reasons.push(`${arm.contract}: ${arm.runs.length} of ${V4_EXPERIMENT.repeatsPerArm} runs saved`);
  if (a.runs.length < V4_EXPERIMENT.repeatsPerArm || b.runs.length < V4_EXPERIMENT.repeatsPerArm) return { ...base, verdict: "INCOMPLETE", reasons, criteria: [] };

  // Comparable arms: only the consolidation contract may differ.
  const used = new Set([...a.runs, ...b.runs].map((r) => r.file));
  const settings = results.filter((x) => used.has(x.file)).map((x) => JSON.stringify(comparableSettings(x.result)));
  if (new Set(settings).size !== 1) return { ...base, verdict: "INVALID", reasons: [...reasons, "the arms differ in more than the consolidation contract (discovery, assignment, sample, parameters or dataset version)"], criteria: [] };

  const mean = (runs: readonly ArmRun[], k: (typeof METRICS)[number]) => statOf(runs.map((r) => r[k]))!.mean;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const c = V4_EXPERIMENT.criteria;
  const v4Merges = b.runs.reduce((s, r) => s + r.mergeErrors, 0);
  const v3Merges = a.runs.reduce((s, r) => s + r.mergeErrors, 0);
  const criteria: CriterionResult[] = [
    { criterion: `topic precision (v4 mean) >= ${pct(c.minTopicPrecision)}`, passed: mean(b.runs, "topicPrecision") >= c.minTopicPrecision, detail: `v4 ${pct(mean(b.runs, "topicPrecision"))}, v3 ${pct(mean(a.runs, "topicPrecision"))}` },
    { criterion: `topic recall (v4 mean) >= ${pct(c.minConceptRecall)}`, passed: mean(b.runs, "conceptRecall") >= c.minConceptRecall, detail: `v4 ${pct(mean(b.runs, "conceptRecall"))}, v3 ${pct(mean(a.runs, "conceptRecall"))}` },
    { criterion: "zero new merge errors relative to v3 (sum over runs)", passed: v4Merges - v3Merges <= c.maxNewMergeErrors, detail: `v4 ${v4Merges}, v3 ${v3Merges}` },
    ...c.noRegression.map((k) => ({
      criterion: `no regression in ${k === "topicSentimentAccuracy" ? "topic sentiment" : "primary-topic"} accuracy (v4 mean >= v3 mean)`,
      passed: mean(b.runs, k) >= mean(a.runs, k),
      detail: `v4 ${pct(mean(b.runs, k))}, v3 ${pct(mean(a.runs, k))}`,
    })),
  ];
  return { ...base, verdict: criteria.every((x) => x.passed) ? "PASS" : "FAIL", reasons, criteria };
}

export function renderConsolidationExperimentMarkdown(e: ExperimentEvaluation): string {
  const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
  const stat = (runs: readonly ArmRun[], k: keyof ArmRun, f: (x: number) => string) => {
    const xs = runs.map((r) => r[k]).filter((x): x is number => typeof x === "number");
    const s = statOf(xs);
    return s === null ? "–" : `${f(s.mean)} (${f(s.min)} – ${f(s.max)}, sd ${f(s.sd)})`;
  };
  const p = (x: number) => pct(x);
  const n = (x: number) => (Math.round(x * 100) / 100).toString();
  const usd = (x: number) => `$${x.toFixed(4)}`;
  const s = (x: number) => `${(x / 1000).toFixed(1)} s`;
  const lines = [
    `# Consolidation experiment ${e.experiment}: ${e.arms[0]!.contract} (A) vs ${e.arms[1]!.contract} (B) on ${e.dataset}`,
    "",
    e.preRegistered ? "Pre-registered dataset: the verdict below is binding." : `EXPLORATORY: ${e.dataset} is not the pre-registered dataset (${V4_EXPERIMENT.dataset}); no binding verdict.`,
    "",
    `Verdict: ${e.preRegistered ? e.verdict : `${e.verdict} (exploratory)`}`,
    ...e.reasons.map((r) => `- ${r}`),
  ];
  if (e.criteria.length > 0) lines.push("", "## Fixed success criteria", "", "| Criterion | Result | Values |", "|---|---|---|", ...e.criteria.map((c) => `| ${c.criterion} | ${c.passed ? "pass" : "FAIL"} | ${c.detail} |`));
  const rows: [string, keyof ArmRun, (x: number) => string][] = [
    ["Topic precision", "topicPrecision", p],
    ["Concept recall", "conceptRecall", p],
    ["Merge errors", "mergeErrors", n],
    ["Split errors", "splitErrors", n],
    ["Disposition accuracy", "dispositionAccuracy", p],
    ["Primary-topic accuracy", "primaryTopicAccuracy", p],
    ["OTHER accuracy", "otherAccuracy", p],
    ["NO_SPECIFIC_TOPIC accuracy", "noSpecificTopicAccuracy", p],
    ["Topic sentiment accuracy", "topicSentimentAccuracy", p],
    ["Evidence precision", "evidencePrecision", p],
    ["reportOtherAccuracy (diagnostic)", "reportOtherAccuracy", p],
    ["Topics before consolidation", "discoveredTopics", n],
    ["Topics after consolidation", "consolidatedTopics", n],
    ["Retained", "retained", n],
    ["Merged", "merged", n],
    ["Dropped", "dropped", n],
    ["Cost per run", "costUsd", usd],
  ];
  lines.push("", "## Metrics per arm (mean (min – max, sd) over the selected runs)", "", `| Metric | A: ${e.arms[0]!.contract} | B: ${e.arms[1]!.contract} |`, "|---|---|---|");
  for (const [label, k, f] of rows) lines.push(`| ${label} | ${stat(e.arms[0]!.runs, k, f)} | ${stat(e.arms[1]!.runs, k, f)} |`);
  for (const phase of ["discovery", "consolidation", "assignment", "all"] as const) {
    const lat = (runs: readonly ArmRun[]) => {
      const st = statOf(runs.map((r) => r.latencyMs[phase]));
      return st ? `${s(st.mean)} (${s(st.min)} – ${s(st.max)})` : "–";
    };
    lines.push(`| Summed request latency: ${phase} | ${lat(e.arms[0]!.runs)} | ${lat(e.arms[1]!.runs)} |`);
  }
  lines.push("", "## Selected runs", "", ...e.arms.flatMap((arm) => arm.runs.map((r) => `- ${arm.contract}: ${r.file}${r.available ? "" : " (unavailable: scored 0)"}`)));
  return lines.join("\n");
}
