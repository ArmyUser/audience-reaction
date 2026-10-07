import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BenchmarkDataset } from "./classifier-benchmark";

// Registry of benchmark datasets. Both are synthetic fixtures written for this project (never YouTube data), so their
// comment text may be stored in benchmark results for diagnosis.
// - m2-synthetic: the original 60-comment set (its texts partly appear as guideline examples).
// - m2-heldout-v1: 100 held-out comments, lexically audited against guideline, questions, m2 and tests.

export const BENCHMARK_DATASETS = {
  "m2-synthetic": "fixtures/m2/comments.json",
  "m2-heldout-v1": "fixtures/m2-heldout-v1/comments.json",
} as const;

export type BenchmarkDatasetId = keyof typeof BENCHMARK_DATASETS;
export const DEFAULT_BENCHMARK_DATASET: BenchmarkDatasetId = "m2-synthetic";

export function isBenchmarkDatasetId(value: string): value is BenchmarkDatasetId {
  return Object.hasOwn(BENCHMARK_DATASETS, value);
}

/** Content hash of the dataset file, so results are tied to the exact labels used. */
export function datasetVersion(fileText: string): string {
  return `sha256:${createHash("sha256").update(fileText).digest("hex").slice(0, 16)}`;
}

/** Loads a dataset relative to the working directory (the repository root for the CLI and tests). */
export function loadBenchmarkDataset(id: BenchmarkDatasetId): BenchmarkDataset {
  const text = readFileSync(BENCHMARK_DATASETS[id], "utf8");
  const raw = JSON.parse(text) as Omit<BenchmarkDataset, "name" | "version">;
  return { name: id, version: datasetVersion(text), focus: raw.focus, comments: raw.comments };
}
