import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { evaluateConsolidationExperiment, renderConsolidationExperimentMarkdown, V4_EXPERIMENT } from "./topic-consolidation-experiment";
import { isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset } from "./topic-datasets";
import type { RealConsolidatedResult } from "./topic-real-consolidated";

// OFFLINE evaluation of the pre-registered consolidation experiment (v3 vs v4) from saved real-consolidated results.
// Never calls a provider and never writes a result file. Exit code: 0 PASS, 1 FAIL or INVALID, 2 INCOMPLETE.
//   npx tsx src/benchmark/consolidation-experiment-cli.ts --dataset t4-topics-v1 [--results benchmark-results]
// Any dataset other than the pre-registered one gives an exploratory (non-binding) comparison.

const { values } = parseArgs({ options: { dataset: { type: "string", default: V4_EXPERIMENT.dataset }, results: { type: "string", default: "benchmark-results" } } });
if (!isTopicBenchmarkDatasetId(values.dataset)) {
  console.error(`Unknown topic dataset "${values.dataset}".`);
  process.exit(1);
}
const dataset = loadTopicBenchmarkDataset(values.dataset);
let files: string[] = [];
try {
  files = readdirSync(values.results).filter((f) => f.endsWith(".json") && f.includes(`-${dataset.id}-real-consolidated-`));
} catch {
  files = [];
}
const results = files.map((f) => ({ file: f, result: JSON.parse(readFileSync(join(values.results, f), "utf8")) as RealConsolidatedResult }));
const evaluation = evaluateConsolidationExperiment(dataset.id, dataset.version, results);
console.log("NO API CALLS MADE (offline evaluation of saved results)\n");
console.log(renderConsolidationExperimentMarkdown(evaluation));
process.exit(evaluation.verdict === "PASS" ? 0 : evaluation.verdict === "INCOMPLETE" ? 2 : 1);
