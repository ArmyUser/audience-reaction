import type { PipelineStage } from "./run-info";

// Plain-data view of saved benchmark results for the internal evaluation page. Built by the composition root from
// committed result files; never part of the customer report. Rates are fractions in [0, 1].

export type DatasetRole = "development" | "validation" | "held-out";

export interface DatasetInfo {
  id: string;
  role: DatasetRole;
  kind: "classifier" | "topics";
  note: string;
}

/** Mean, min and max over `n` runs (repeats). */
export interface Spread {
  mean: number;
  min: number;
  max: number;
  n: number;
}

export interface ClassifierTaskEvaluation {
  task: string;
  n: number;
  accuracy: Spread;
  macroF1: Spread;
  /** Per-class precision / recall / F1, averaged over the repeats. */
  perClass: { label: string; support: number; precision: number; recall: number; f1: number }[];
}

export interface ClassifierEvaluation {
  dataset: DatasetInfo;
  file: string;
  timestamp: string;
  model: string;
  modelVersions: string[];
  questionSet: string;
  guidelineVersion: string;
  repeats: number;
  matchesCurrent: boolean;
  tasks: ClassifierTaskEvaluation[];
  costPerRunUsd: number | null;
  requestLatencyP50Ms: number | null;
  wallClockMs: Spread | null;
}

export type MetricUnit = "rate" | "count" | "pp" | "usd" | "ms";

export interface TopicMetric {
  key: string;
  label: string;
  unit: MetricUnit;
  /** True when lower is better (errors, cost, latency). */
  lowerIsBetter?: boolean;
  spread: Spread;
}

export interface TopicEvaluation {
  dataset: DatasetInfo;
  files: string[];
  configuration: string;
  matchesCurrent: boolean;
  metrics: TopicMetric[];
}

export interface EvaluationView {
  pipeline: PipelineStage[];
  datasets: DatasetInfo[];
  classifier: ClassifierEvaluation[];
  topics: TopicEvaluation[];
  /** Files that could not be read or parsed (shown, never hidden). */
  problems: string[];
}
