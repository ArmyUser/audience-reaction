import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicClassifier, createAnthropicClient, DEFAULT_ANTHROPIC_CLASSIFIER_MODEL } from "../adapters/ai/anthropic/anthropic-classifier";
import { DEFAULT_JEV_MODEL, JevClassifier, type JevTargetDiagnostic } from "../adapters/ai/typesafe/jev-classifier";
import { buildJevQuestionSet, DEFAULT_JEV_QUESTION_SET, isJevQuestionSetVersion, JEV_QUESTION_SETS, type JevQuestionSetVersion } from "../adapters/ai/typesafe/jev-question-sets";
import { buildJevState } from "../adapters/ai/typesafe/jev-questions";
import { FakeClassifier } from "../adapters/fakes/fake-classifier";
import { GoldLabelClassifier } from "../adapters/fakes/gold-label-classifier";
import { buildClassifierData, buildClassifierInstructions, PROMPT_VERSION } from "../core/classification/llm-prompt";
import { createClassificationSchema } from "../core/classification/schema";
import type { SpamAdjustment } from "../core/classification/spam-invariant";
import { estimateCostUsd, InMemoryUsageRecorder, type PriceTable } from "../core/cost/usage";
import { renderBenchmarkMarkdown, runClassifierBenchmark, type BenchmarkDataset, type BenchmarkSubject } from "./classifier-benchmark";
import { BENCHMARK_DATASETS, DEFAULT_BENCHMARK_DATASET, isBenchmarkDatasetId, loadBenchmarkDataset } from "./datasets";

// Manual benchmark command (never part of `npm test`). Real API calls happen only with --provider anthropic or jev.
// Usage: npm run benchmark -- --provider anthropic --repeats 2 [--batch-size 20] [--mixed] [--no-focus] [--max-cost-usd 1]
//        npm run benchmark -- --provider jev --repeats 2 [--jev-question-set jev-q2.2|jev-q2.1|jev-q2|jev-q1] (default jev-q2.2) [--jev-model jev-preview] [--mixed] [--no-focus] [--max-cost-usd 1]
// Any provider: [--dataset m2-synthetic|m2-heldout-v1] (default m2-synthetic).

const PRICES_PATH = "config/model-prices.json";
const RESULTS_DIR = "benchmark-results";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "anthropic" },
      dataset: { type: "string", default: DEFAULT_BENCHMARK_DATASET },
      model: { type: "string", default: DEFAULT_ANTHROPIC_CLASSIFIER_MODEL },
      "jev-model": { type: "string", default: DEFAULT_JEV_MODEL },
      "jev-question-set": { type: "string", default: DEFAULT_JEV_QUESTION_SET },
      repeats: { type: "string", default: "1" },
      "batch-size": { type: "string", default: "20" },
      "retry-rounds": { type: "string", default: "2" },
      mixed: { type: "boolean", default: false },
      "no-focus": { type: "boolean", default: false },
      "max-cost-usd": { type: "string", default: "1" },
    },
  });

  const repeats = positiveInt(values.repeats, "repeats");
  const batchSize = positiveInt(values["batch-size"], "batch-size");
  const retryRounds = Number.parseInt(values["retry-rounds"], 10);
  const maxCostUsd = Number(values["max-cost-usd"]);
  if (!isBenchmarkDatasetId(values.dataset)) {
    console.error(`Unknown dataset "${values.dataset}". Use one of: ${Object.keys(BENCHMARK_DATASETS).join(", ")}.`);
    process.exit(1);
  }
  const dataset: BenchmarkDataset = loadBenchmarkDataset(values.dataset);
  console.log(`Dataset ${dataset.name} (${dataset.version}), ${dataset.comments.length} comments.`);
  const prices = (JSON.parse(readFileSync(PRICES_PATH, "utf8")) as { prices: PriceTable }).prices;

  let createSubject: () => BenchmarkSubject;
  if (values.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY is not set. Add it to a local .env file (never commit it) and re-run.");
      process.exit(1);
    }
    const estimate = estimateRunCost(dataset, values.model, batchSize, repeats, !values["no-focus"], values.mixed, prices);
    console.log(`Pre-run estimate: ~$${estimate.toFixed(4)} for ${repeats} run(s) (allowance $${maxCostUsd.toFixed(2)}).`);
    if (!(estimate <= maxCostUsd)) {
      console.error("Estimated cost exceeds --max-cost-usd; not running.");
      process.exit(1);
    }
    const client = createAnthropicClient(apiKey);
    createSubject = () => {
      const recorder = new InMemoryUsageRecorder();
      return {
        classifier: new AnthropicClassifier({ client, model: values.model, batchSize, prices, recorder }),
        provider: "anthropic",
        model: values.model,
        promptVersion: PROMPT_VERSION,
        batchSize,
        usage: () => recorder.entries,
      };
    };
  } else if (values.provider === "jev") {
    const apiKey = process.env.JEV_API_KEY;
    if (!apiKey) {
      console.error("JEV_API_KEY is not set. Add it to a local .env file (never commit it) and re-run.");
      process.exit(1);
    }
    const model = values["jev-model"];
    const questionSet = values["jev-question-set"];
    if (!isJevQuestionSetVersion(questionSet)) {
      console.error(`Unknown Jev question set "${questionSet}". Use one of: ${JEV_QUESTION_SETS.join(", ")}.`);
      process.exit(1);
    }
    const estimate = estimateJevRunCost(dataset, model, questionSet, repeats, !values["no-focus"], values.mixed, prices);
    console.log(`Jev question set ${questionSet}. Pre-run estimate: ~$${estimate.toFixed(4)} for ${repeats} run(s) (allowance $${maxCostUsd.toFixed(2)}).`);
    if (!(estimate <= maxCostUsd)) {
      console.error("Estimated cost exceeds --max-cost-usd; not running.");
      process.exit(1);
    }
    createSubject = () => {
      const recorder = new InMemoryUsageRecorder();
      const adjustments = new Map<string, SpamAdjustment[]>();
      const gates = new Map<string, JevTargetDiagnostic[]>();
      return {
        classifier: new JevClassifier({
          apiKey,
          model,
          questionSet,
          prices,
          recorder,
          onSpamInvariantApplied: (id, adjusted) => adjustments.set(id, adjusted),
          onTargetDiagnostics: (id, diagnostics) => gates.set(id, diagnostics),
        }),
        provider: "typesafe",
        model,
        promptVersion: questionSet,
        batchSize: 1,
        usage: () => recorder.entries,
        spamInvariantAdjustments: () => adjustments,
        targetDiagnostics: () => gates,
      };
    };
  } else if (values.provider === "fake-keyword" || values.provider === "fake-gold") {
    const classifier = values.provider === "fake-keyword" ? new FakeClassifier() : new GoldLabelClassifier(dataset.comments);
    createSubject = () => ({ classifier, provider: values.provider!, model: "n/a", promptVersion: "n/a", usage: () => [] });
  } else {
    console.error(`Unknown provider "${values.provider}". Use anthropic, jev, fake-keyword or fake-gold.`);
    process.exit(1);
  }

  const report = await runClassifierBenchmark(dataset, createSubject, {
    repeats,
    mixedEnabled: values.mixed,
    useFocus: !values["no-focus"],
    retryRounds,
    // Every registered dataset is a synthetic fixture, so its text may be stored for diagnosis.
    includeCommentText: true,
  });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const datasetSuffix = dataset.name === DEFAULT_BENCHMARK_DATASET ? "" : `-${dataset.name}`;
  const slug = `${report.meta.timestamp}-${report.meta.provider}-${report.meta.model}-${report.meta.promptVersion}${datasetSuffix}`.replace(/[^A-Za-z0-9_-]+/g, "-");
  const file = join(RESULTS_DIR, `${slug}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(renderBenchmarkMarkdown(report));
  console.log(`\nSaved ${file}`);
}

/** Rough upper-bound estimate: ~4 chars/token input, ~70 output tokens per comment, plus one retry round of headroom. */
function estimateRunCost(dataset: BenchmarkDataset, model: string, batchSize: number, repeats: number, focus: boolean, mixed: boolean, prices: PriceTable): number {
  const schema = createClassificationSchema({ focusConfigured: focus, mixedEnabled: mixed });
  const instructionsChars = buildClassifierInstructions(schema).length + 2_000; // + structured-output schema overhead
  const comments = dataset.comments.map((c) => ({ id: c.id, text: c.text }));
  let input = 0;
  for (let i = 0; i < comments.length; i += batchSize) {
    input += Math.ceil((instructionsChars + buildClassifierData(comments.slice(i, i + batchSize), focus ? dataset.focus : undefined).length) / 4);
  }
  const output = comments.length * 70;
  const perRun = estimateCostUsd(prices, model, input, output);
  if (perRun === undefined) throw new Error(`No price configured for ${model} in ${PRICES_PATH}`);
  return perRun * repeats * 1.5;
}

/** Rough upper-bound estimate for Jev: one request per comment, ~4 chars/token input, output unbilled, 1.5x headroom. */
function estimateJevRunCost(
  dataset: BenchmarkDataset,
  model: string,
  questionSet: JevQuestionSetVersion,
  repeats: number,
  focus: boolean,
  mixed: boolean,
  prices: PriceTable,
): number {
  const schema = createClassificationSchema({ focusConfigured: focus, mixedEnabled: mixed });
  const questionsChars = JSON.stringify(buildJevQuestionSet(questionSet, schema)).length;
  let input = 0;
  for (const c of dataset.comments) {
    input += Math.ceil((questionsChars + JSON.stringify(buildJevState({ id: c.id, text: c.text }, focus ? dataset.focus : undefined)).length) / 4);
  }
  const perRun = estimateCostUsd(prices, model, input, 0);
  if (perRun === undefined) throw new Error(`No price configured for ${model} in ${PRICES_PATH}`);
  return perRun * repeats * 1.5;
}

function positiveInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

main().catch((error: unknown) => {
  // Never print request details or credentials; the SDK error message does not contain the key.
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Benchmark failed");
  process.exit(1);
});
