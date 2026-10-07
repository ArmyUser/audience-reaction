// Technical facts about one analysis run, supplied by the composition root for display: what was analysed, how long
// it took, which pipeline produced it and what it cost. Never part of the report model; contains no comment text.

export interface PipelineStage {
  /** e.g. "Classification", "Topic discovery". */
  role: string;
  /** Provider model and contract/configuration, as configured. */
  component: string;
}

export type AnalysisInput =
  | { kind: "demo"; label: string }
  | { kind: "youtube" }
  | { kind: "fixture"; dataset: string; comments: number };

export interface AnalysisRunInfo {
  mode: "demo" | "real";
  input: AnalysisInput;
  durationMs: number;
  pipeline: PipelineStage[];
  /** AI-provider usage; absent in demo mode (no provider is called). */
  usage?: { requests: number; failedRequests: number; requestsByProvider: Record<string, number>; estimatedCostUsd: number; costLimitUsd: number };
}
