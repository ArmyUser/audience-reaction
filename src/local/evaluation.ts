import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JEV_TOPIC_QUESTION_SET } from "../adapters/ai/typesafe/jev-topic-questions";
import type { ClassifierEvaluation, ClassifierTaskEvaluation, DatasetInfo, DatasetRole, EvaluationView, Spread, TopicEvaluation, TopicMetric } from "../application/evaluation-view";
import manifestJson from "../../config/evaluation-manifest.json";
import { realModeSettings, realPipeline, type RealModeSettings } from "./real-mode";

// Builds the internal evaluation view from saved benchmark results (server-only). Only files named in
// config/evaluation-manifest.json are read, by plain file name from benchmark-results/; anything unreadable is
// reported as a problem, never silently dropped. Results are parsed defensively: they are data, not code.

export const RESULTS_DIR = "benchmark-results";
const FILE_NAME = /^[A-Za-z0-9._-]+\.json$/;
const ROLES: readonly DatasetRole[] = ["development", "validation", "held-out"];

interface Manifest {
  datasets: { id: string; role: string; kind: string; note: string }[];
  classifier: { dataset: string; file: string }[];
  topics: { dataset: string; files: string[] }[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function spreadOf(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  return { mean: values.reduce((s, v) => s + v, 0) / values.length, min: Math.min(...values), max: Math.max(...values), n: values.length };
}

export interface EvaluationSources {
  manifest?: Manifest;
  readResult?: (file: string) => string;
  settings?: RealModeSettings;
}

export function loadEvaluation(sources: EvaluationSources = {}): EvaluationView {
  const manifest = sources.manifest ?? (manifestJson as Manifest);
  const read = sources.readResult ?? ((file: string) => readFileSync(join(process.cwd(), RESULTS_DIR, file), "utf8"));
  const settings = sources.settings ?? realModeSettings();
  const problems: string[] = [];
  const datasets: DatasetInfo[] = manifest.datasets.map((d) => ({
    id: d.id,
    role: (ROLES as readonly string[]).includes(d.role) ? (d.role as DatasetRole) : "held-out",
    kind: d.kind === "classifier" ? "classifier" : "topics",
    note: d.note,
  }));
  const datasetOf = (id: string): DatasetInfo => datasets.find((d) => d.id === id) ?? { id, role: "held-out", kind: "topics", note: "Not in the manifest's dataset list." };
  const parse = (file: string): Json | null => {
    if (!FILE_NAME.test(file)) {
      problems.push(`${file}: not a plain result file name`);
      return null;
    }
    try {
      return obj(JSON.parse(read(file)));
    } catch {
      problems.push(`${file}: could not be read or parsed`);
      return null;
    }
  };

  const classifier = manifest.classifier.flatMap((entry): ClassifierEvaluation[] => {
    const r = parse(entry.file);
    return r ? [classifierEvaluation(r, entry.file, datasetOf(entry.dataset), settings)] : [];
  });
  const topics = manifest.topics.flatMap((entry): TopicEvaluation[] => {
    const runs = entry.files.flatMap((f) => {
      const r = parse(f);
      return r ? [r] : [];
    });
    return runs.length > 0 ? [topicEvaluation(runs, entry.files, datasetOf(entry.dataset), settings)] : [];
  });
  return { pipeline: realPipeline(settings), datasets, classifier, topics, problems };
}

function classifierEvaluation(r: Json, file: string, dataset: DatasetInfo, s: RealModeSettings): ClassifierEvaluation {
  const meta = obj(r.meta);
  const runs = arr(r.runs).map(obj);
  const byTask = new Map<string, Json[]>();
  for (const run of runs) for (const t of arr(run.tasks).map(obj)) byTask.set(str(t.task), [...(byTask.get(str(t.task)) ?? []), t]);
  const tasks: ClassifierTaskEvaluation[] = [...byTask.entries()].map(([task, reps]) => {
    const classes = new Map<string, { support: number; p: number[]; r: number[]; f: number[] }>();
    for (const rep of reps) {
      for (const c of arr(rep.perClass).map(obj)) {
        const entry = classes.get(str(c.label)) ?? { support: num(c.support) ?? 0, p: [], r: [], f: [] };
        entry.p.push(num(c.precision) ?? 0);
        entry.r.push(num(c.recall) ?? 0);
        entry.f.push(num(c.f1) ?? 0);
        classes.set(str(c.label), entry);
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return {
      task,
      n: num(reps[0]?.n) ?? 0,
      accuracy: spreadOf(reps.flatMap((x) => num(x.accuracy) ?? [])) ?? { mean: 0, min: 0, max: 0, n: 0 },
      macroF1: spreadOf(reps.flatMap((x) => num(x.macroF1) ?? [])) ?? { mean: 0, min: 0, max: 0, n: 0 },
      perClass: [...classes.entries()].map(([label, c]) => ({ label, support: c.support, precision: mean(c.p), recall: mean(c.r), f1: mean(c.f) })),
    };
  });
  const usage = obj(r.usageTotal);
  const repeats = num(meta.repeats) ?? runs.length;
  const cost = num(usage.estimatedCostUsd);
  const model = str(meta.model);
  const questionSet = str(meta.promptVersion);
  return {
    dataset,
    file,
    timestamp: str(meta.timestamp),
    model,
    modelVersions: arr(meta.modelVersions).map(str),
    questionSet,
    guidelineVersion: str(meta.guidelineVersion),
    repeats,
    matchesCurrent: model === s.classifier.model && questionSet === s.classifier.questionSet,
    tasks,
    costPerRunUsd: cost !== undefined && repeats > 0 ? cost / repeats : null,
    requestLatencyP50Ms: num(obj(usage.latencyMs).p50) ?? null,
    wallClockMs: spreadOf(runs.flatMap((run) => num(run.wallClockMs) ?? [])),
  };
}

const TOPIC_METRICS: { key: string; label: string; unit: TopicMetric["unit"]; lowerIsBetter?: boolean; pick: (run: Json, result: Json) => number | undefined }[] = [
  { key: "topicPrecision", label: "Topic precision", unit: "rate", pick: (run) => num(obj(run.taxonomy).topicPrecision) },
  { key: "conceptRecall", label: "Concept recall", unit: "rate", pick: (run) => num(obj(run.taxonomy).conceptRecall) },
  { key: "mergeErrors", label: "Merge errors", unit: "count", lowerIsBetter: true, pick: (run) => num(obj(run.taxonomy).mergeErrors) },
  { key: "splitErrors", label: "Split errors", unit: "count", lowerIsBetter: true, pick: (run) => num(obj(run.taxonomy).splitErrors) },
  { key: "dispositionAccuracy", label: "Disposition accuracy", unit: "rate", pick: (run) => num(obj(run.assignment).dispositionAccuracy) },
  { key: "primaryTopicAccuracy", label: "Primary-topic accuracy", unit: "rate", pick: (run) => num(obj(run.assignment).primaryTopicAccuracy) },
  { key: "topicSentimentAccuracy", label: "Topic sentiment accuracy", unit: "rate", pick: (run) => num(obj(run.assignment).topicSentimentAccuracy) },
  { key: "otherAccuracy", label: "Other accuracy", unit: "rate", pick: (run) => num(obj(run.assignment).otherAccuracy) },
  { key: "noSpecificTopicAccuracy", label: "No-specific-topic accuracy", unit: "rate", pick: (run) => num(obj(run.assignment).noSpecificTopicAccuracy) },
  { key: "otherRate", label: "Other rate (reported)", unit: "rate", pick: (run) => pct(obj(obj(run.section).other).count) },
  { key: "topicCoverage", label: "Topic coverage (in a named topic)", unit: "rate", pick: (run) => pct(obj(obj(run.section).coverage).namedTopics) },
  { key: "evidencePrecision", label: "Evidence precision", unit: "rate", pick: (run) => num(obj(run.report).evidencePrecision) },
  { key: "costUsd", label: "Cost per run", unit: "usd", lowerIsBetter: true, pick: (_run, r) => num(obj(obj(r.totals).all).estimatedCostUsd) },
  { key: "discoveryMs", label: "Discovery latency", unit: "ms", lowerIsBetter: true, pick: (_run, r) => num(obj(obj(obj(r.totals).discovery).latencyMs).total) },
  { key: "consolidationMs", label: "Consolidation latency", unit: "ms", lowerIsBetter: true, pick: (_run, r) => num(obj(obj(obj(r.totals).consolidation).latencyMs).total) },
  { key: "assignmentMs", label: "Assignment latency (summed over concurrent requests)", unit: "ms", lowerIsBetter: true, pick: (_run, r) => num(obj(obj(obj(r.totals).assignment).latencyMs).total) },
];

function pct(share: unknown): number | undefined {
  const s = obj(share);
  const count = num(s.count);
  const base = num(s.base);
  return count !== undefined && base !== undefined && base > 0 ? count / base : undefined;
}

/** The scored live run of a real(-consolidated) result: the scenario other than the oracle gate. */
function liveRun(r: Json): Json {
  const scenarios = arr(obj(r.report).scenarios).map(obj);
  const live = scenarios.find((s) => s.group === "live") ?? scenarios.find((s) => !str(s.id).includes("oracle")) ?? {};
  return obj(arr(live.runs)[0]);
}

function topicEvaluation(results: Json[], files: string[], dataset: DatasetInfo, s: RealModeSettings): TopicEvaluation {
  const meta = obj(results[0]!.meta);
  const discovery = obj(meta.discovery);
  const consolidation = obj(meta.consolidation);
  const assignment = obj(meta.assignment);
  const matchesCurrent = results.every((r) => {
    const m = obj(r.meta);
    return (
      str(obj(m.discovery).contract) === s.discoveryContract &&
      str(obj(m.discovery).modelRequested) === s.discoveryProvider.model &&
      str(obj(m.discovery).effort) === s.discoveryProvider.effort &&
      str(obj(m.consolidation).contract) === s.consolidationContract &&
      str(obj(m.assignment).questionSet) === JEV_TOPIC_QUESTION_SET &&
      str(obj(m.assignment).modelRequested) === s.assignmentProvider.model
    );
  });
  const metrics = TOPIC_METRICS.flatMap((m): TopicMetric[] => {
    const spread = spreadOf(results.flatMap((r) => m.pick(liveRun(r), r) ?? []));
    return spread ? [{ key: m.key, label: m.label, unit: m.unit, ...(m.lowerIsBetter ? { lowerIsBetter: true } : {}), spread }] : [];
  });
  return {
    dataset,
    files,
    configuration: `${str(discovery.modelRequested)} · ${str(discovery.contract)} → ${str(consolidation.contract) || "no consolidation"} → ${str(assignment.modelRequested)} · ${str(assignment.questionSet)}`,
    matchesCurrent,
    metrics,
  };
}
