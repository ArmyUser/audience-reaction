// Phase-0 benchmarking / cost records for AI calls. Deliberately separate from the long-lived product analytics
// model (report-model.ts): these records describe how a result was produced, not what the audience said.

export type AiCallOutcome = "ok" | "malformed_output" | "incomplete_output" | "refusal" | "provider_error";

export interface AiCallRecord {
  provider: string;
  /** Requested model alias as configured for the provider. */
  model: string;
  /** Model version reported by the provider response, when available. */
  modelVersion?: string;
  promptVersion: string;
  schemaVersion: string;
  batchSize: number;
  attempt: number;
  outcome: AiCallOutcome;
  errorType?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** USD, from the configured price table; undefined when tokens or prices are unknown (never guessed). */
  estimatedCostUsd?: number;
  latencyMs: number;
  timestamp: string;
}

export interface UsageRecorder {
  record(entry: AiCallRecord): void;
}

/** Prices in USD per million tokens. Configuration, not code: values must be checked against the provider. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Where/when the price was taken from. */
  source: string;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export function estimateCostUsd(prices: PriceTable, model: string, inputTokens?: number, outputTokens?: number): number | undefined {
  const price = prices[model];
  if (!price || inputTokens === undefined || outputTokens === undefined) return undefined;
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

export class InMemoryUsageRecorder implements UsageRecorder {
  readonly entries: AiCallRecord[] = [];
  record(entry: AiCallRecord): void {
    this.entries.push(entry);
  }
}

export interface UsageSummary {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined if any request lacked a cost estimate. */
  estimatedCostUsd: number | undefined;
  latencyMs: { total: number; mean: number; p50: number; p95: number; max: number };
}

export function summarizeUsage(entries: readonly AiCallRecord[]): UsageSummary {
  const latencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => (latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]!);
  const total = latencies.reduce((s, x) => s + x, 0);
  const costs = entries.map((e) => e.estimatedCostUsd);
  return {
    requests: entries.length,
    failedRequests: entries.filter((e) => e.outcome !== "ok").length,
    inputTokens: entries.reduce((s, e) => s + (e.inputTokens ?? 0), 0),
    outputTokens: entries.reduce((s, e) => s + (e.outputTokens ?? 0), 0),
    estimatedCostUsd: costs.every((c) => c !== undefined) ? costs.reduce((s, c) => s + (c ?? 0), 0) : undefined,
    latencyMs: { total, mean: entries.length ? total / entries.length : 0, p50: pct(50), p95: pct(95), max: latencies.at(-1) ?? 0 },
  };
}
