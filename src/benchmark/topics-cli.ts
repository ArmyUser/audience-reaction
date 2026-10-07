import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createAnthropicClient } from "../adapters/ai/anthropic/anthropic-classifier";
import { checkGeminiModel, createGeminiClient } from "../adapters/ai/google/gemini-topic-transport";
import { listJevModels } from "../adapters/ai/typesafe/jev-models";
import { renderTopicBenchmarkMarkdown, runTopicBenchmark, type TopicBenchmarkReport } from "./topic-benchmark";
import { isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "./topic-datasets";
import { isTopicConsolidationContract, TOPIC_CONSOLIDATION_CONTRACT, type TopicConsolidationContract } from "../core/topics/consolidation-contract";
import { buildRealConsolidatedPlan, realConsolidatedResultFileName, renderRealConsolidatedMarkdown, renderRealConsolidatedPlanAddendum, runRealConsolidatedBenchmark } from "./topic-real-consolidated";
import { buildConsolidatedBenchmarkPlan, consolidatedResultFileName, renderConsolidatedBenchmarkMarkdown, renderConsolidatedBenchmarkPlan, runConsolidatedDiscoveryBenchmark } from "./topic-discovery-consolidated";
import { buildDiscoveryBenchmarkPlan, DEFAULT_SMOKE_COMMENTS, discoveryResultFileName, renderDiscoveryBenchmarkMarkdown, renderDiscoveryBenchmarkPlan, runDiscoveryBenchmark, smokeCommentIds } from "./topic-discovery-only";
import { buildTopicRealPreflight, DEFAULT_DISCOVERY_PROVIDER, loadPrices, loadTopicProviderConfig, realResultFileName, renderTopicRealPreflight, runRealTopicBenchmark, selectDiscoveryProvider } from "./topic-real";
import { isTopicReplayScenarioId, runTopicReplayBenchmark, TOPIC_REPLAY_SCENARIO_IDS, type TopicReplayScenarioId } from "./topic-replay";
import { isTopicScenarioId, TOPIC_SCENARIO_IDS, type TopicScenarioId } from "./topic-scenarios";

// Topic benchmark command, separate from the classifier benchmark (cli.ts).
// Offline suites (no key, no network, no cost; the oracle always runs first as the harness sanity gate):
//   npm run benchmark-topics -- --dataset t1-topics-v1 --scenario oracle
//   npm run benchmark-topics -- --scenario all|<id>[,<id>…] [--repeats 2] [--save]
//   npm run benchmark-topics -- --suite replay [--scenario all|replay-<id>[,…]]
// Real providers (discovery + TypeSafe Jev assignment, config/topic-providers.json):
//   npm run benchmark-topics -- --suite real-preflight [--repeats 2] [--show-prompts]   renders and estimates; NO API CALLS
//   npm run benchmark-topics -- --suite real-preflight --check-models                   + read-only model listing (network)
//   npm run benchmark-topics -- --suite real --dataset t1-topics-v1 --live --repeats 2  the only command that runs inference
// --provider selects the discovery provider: anthropic (default, the `discovery` entry) or a `discoveryProviders` name
// such as gemini; --model, if given, must be that entry's model or one of its alternativeModels (same settings).
// Without --live the real suite only prints the preflight. Keys come from the environment (.env); never printed.
// Discovery provider comparison without assignment (no Jev, no Jev key; same sample, contract, validator and retry):
//   npm run benchmark-topics -- --suite discovery-only --dataset t1-topics-v1 [--provider gemini --model …] --live --repeats 1
//   npm run benchmark-topics -- --suite smoke --dataset t1-topics-v1 [--provider gemini --model …] --live [--comments 20]
// Without --live both only print their plan. discovery-only saves to benchmark-results/; smoke results are not saved.
// EXPERIMENTAL discovery → taxonomy consolidation (topic-consolidation-v1), same provider for both phases, no Jev:
//   npm run benchmark-topics -- --suite discovery-consolidated --dataset t1-topics-v1 [--provider … --model …] --live --repeats 1
// EXPERIMENTAL real suite with consolidation before Jev assignment, scored by the unchanged full evaluator:
//   npm run benchmark-topics -- --suite real-consolidated --dataset t1-topics-v1 [--provider … --model …] --live --repeats 1
// --consolidation v3|v4 (real-consolidated only; default v3, the frozen baseline) selects the consolidation contract;
// everything else is identical. v4 is the pre-registered experiment (docs/topic-consolidation-v4-experiment.md),
// evaluated offline with: npx tsx src/benchmark/consolidation-experiment-cli.ts --dataset t4-topics-v1
// --save writes offline reports to benchmark-results/topics/; a live run always saves to benchmark-results/.

const RESULTS_DIR = "benchmark-results";
const SUITES = ["core", "replay", "real-preflight", "real", "discovery-only", "smoke", "discovery-consolidated", "real-consolidated"] as const;
const PROVIDER_SUITES: readonly string[] = ["real-preflight", "real", "discovery-only", "smoke", "discovery-consolidated", "real-consolidated"];
const LIVE_SUITES: readonly string[] = ["real", "discovery-only", "smoke", "discovery-consolidated", "real-consolidated"];
/**
 * The frozen t5 hold-out is reserved for its pre-registered paired experiment (docs/topic-consolidation-paired-t5-
 * preregistration.md): no live call of this CLI (any --live suite, or --check-models) may run with it. Offline suites
 * and plans stay available. Other datasets are unaffected.
 */
const T5_HOLDOUT = Object.freeze({ dataset: "t5-topics-v1", experiment: "paired-consolidation-v3-v4-t5-v1" });

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "t1-topics-v1" },
      suite: { type: "string", default: "core" },
      scenario: { type: "string" },
      repeats: { type: "string" },
      save: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "check-models": { type: "boolean", default: false },
      "show-prompts": { type: "boolean", default: false },
      "max-cost-usd": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      comments: { type: "string" },
      consolidation: { type: "string" },
    },
  });
  if (!isTopicBenchmarkDatasetId(values.dataset)) fail(`Unknown topic dataset "${values.dataset}". Use one of: ${Object.keys(TOPIC_BENCHMARK_DATASETS).join(", ")}.`);
  if (!(SUITES as readonly string[]).includes(values.suite)) fail(`Unknown suite "${values.suite}". Use ${SUITES.join(", ")}.`);
  const suite = values.suite as (typeof SUITES)[number];
  if (values.live && !LIVE_SUITES.includes(suite)) fail("--live is only valid with --suite real, discovery-only, smoke, discovery-consolidated or real-consolidated.");
  if (values["check-models"] && suite !== "real-preflight") fail("--check-models is only valid with --suite real-preflight.");
  if ((values.provider !== undefined || values.model !== undefined) && !PROVIDER_SUITES.includes(suite)) fail("--provider and --model are only valid with --suite real-preflight, real, discovery-only, smoke, discovery-consolidated or real-consolidated.");
  if (values.comments !== undefined && suite !== "smoke") fail("--comments is only valid with --suite smoke.");
  if (values.consolidation !== undefined && suite !== "real-consolidated") fail("--consolidation is only valid with --suite real-consolidated.");
  if (values.repeats !== undefined && suite === "smoke") fail("--suite smoke makes a single run; use --comments to size it (no --repeats).");
  const repeats = Number(values.repeats ?? "2");
  if (!Number.isInteger(repeats) || repeats < 1) fail("--repeats must be a positive integer");
  if (values.dataset === T5_HOLDOUT.dataset && (values.live || values["check-models"]))
    fail(
      `${T5_HOLDOUT.dataset} is the frozen hold-out reserved for the pre-registered paired experiment ${T5_HOLDOUT.experiment}; ` +
        `this CLI makes no live call on it (nothing was sent, nothing was written). The only permitted live path is the paired CLI: ` +
        `npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset ${T5_HOLDOUT.dataset} --experiment ${T5_HOLDOUT.experiment} --live`,
    );
  const dataset = loadTopicBenchmarkDataset(values.dataset as keyof typeof TOPIC_BENCHMARK_DATASETS);

  if (suite === "real-preflight" || suite === "real") return realSuite(suite, dataset, repeats, values);
  if (suite === "discovery-only" || suite === "smoke") return discoverySuite(suite, dataset, repeats, values);
  if (suite === "discovery-consolidated") return consolidatedSuite(dataset, repeats, values);
  if (suite === "real-consolidated") return realConsolidatedSuite(dataset, repeats, values);

  const replay = suite === "replay";
  const scenario = values.scenario ?? (replay ? "all" : "oracle");
  const known: readonly string[] = replay ? TOPIC_REPLAY_SCENARIO_IDS : TOPIC_SCENARIO_IDS;
  const requested = scenario === "all" ? [...known] : scenario.split(",").map((s) => s.trim());
  const unknown = requested.filter((s) => !(replay ? isTopicReplayScenarioId(s) : isTopicScenarioId(s)));
  if (unknown.length > 0) fail(`Unknown scenario(s) ${unknown.join(", ")}. Use all or: ${known.join(", ")}.`);

  const report: TopicBenchmarkReport = replay
    ? await runTopicReplayBenchmark(dataset, requested as TopicReplayScenarioId[], { repeats })
    : await runTopicBenchmark(dataset, requested as TopicScenarioId[], { repeats });
  console.log(renderTopicBenchmarkMarkdown(report));
  if (values.save) {
    const dir = join(RESULTS_DIR, "topics");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "-");
    const file = join(dir, `${stamp}-${dataset.id}-${suite}-${scenario}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json");
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nSaved ${file}`);
  }
  const unmet = report.scenarios.filter((s) => s.expectationFailures.length > 0);
  if (!report.oracleGate.passed || unmet.length > 0) process.exit(1);
}

async function realSuite(
  suite: "real-preflight" | "real",
  dataset: ReturnType<typeof loadTopicBenchmarkDataset>,
  repeats: number,
  values: { live?: boolean; "check-models"?: boolean; "show-prompts"?: boolean; "max-cost-usd"?: string; provider?: string; model?: string },
): Promise<void> {
  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, values.provider ?? DEFAULT_DISCOVERY_PROVIDER, values.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const prices = loadPrices();
  const preflight = buildTopicRealPreflight(dataset, config, prices, process.env, repeats);
  const limit = values["max-cost-usd"] !== undefined ? Number(values["max-cost-usd"]) : config.limits.maxCostUsd;
  if (!(limit > 0)) fail("--max-cost-usd must be a positive number");

  if (values["check-models"]) {
    // Read-only model listing (no inference, no cost). Only on explicit request.
    console.log(renderTopicRealPreflight(preflight, { showPrompts: values["show-prompts"] === true }).replaceAll("NO API CALLS MADE", "NO INFERENCE CALLS MADE (read-only model listing requested with --check-models)"));
    await checkModels(config);
    return;
  }

  console.log(renderTopicRealPreflight(preflight, { showPrompts: values["show-prompts"] === true }));
  if (suite === "real-preflight") return;
  if (!values.live) {
    console.error(`\nLive run NOT started: add --live to make real API calls (e.g. npm run benchmark-topics -- --suite real --dataset ${dataset.id}${values.provider ? ` --provider ${values.provider}` : ""}${values.model ? ` --model ${values.model}` : ""} --live --repeats ${repeats}).`);
    process.exit(2);
  }

  const discoveryApiKey = process.env[config.discovery.apiKeyEnv];
  const jevApiKey = process.env[config.assignment.apiKeyEnv];
  if (!discoveryApiKey || !jevApiKey) fail(`Missing ${[!discoveryApiKey && config.discovery.apiKeyEnv, !jevApiKey && config.assignment.apiKeyEnv].filter(Boolean).join(" and ")}. Add it to a local .env file (never commit it); nothing was sent.`);
  if (!preflight.models.pricesConfigured.discovery || !preflight.models.pricesConfigured.assignment) fail("A configured model has no price in config/model-prices.json; nothing was sent.");
  if (!(preflight.total.maxCostUsd <= limit)) fail(`Worst-case cost $${preflight.total.maxCostUsd.toFixed(4)} exceeds the limit $${limit.toFixed(2)} (--max-cost-usd); nothing was sent.`);

  console.log(
    [
      "",
      "=".repeat(72),
      "LIVE RUN: API CALLS WILL BE MADE AND WILL BE BILLED",
      `Dataset:            ${dataset.id} (${dataset.comments.length} comments, topic base ${preflight.dataset.topicBase})`,
      `Discovery model:    ${config.discovery.model} (${config.discovery.provider === "google" ? `Google Gemini, thinking ${config.discovery.thinkingLevel}` : "Anthropic"}, ${config.discovery.contract})`,
      `Assignment model:   ${config.assignment.model} (TypeSafe, ${config.assignment.contract} / ${config.assignment.questionSet})`,
      `Repeats:            ${repeats}`,
      `Estimated cost:     $${preflight.total.estimatedCostUsd.toFixed(4)} (worst case $${preflight.total.maxCostUsd.toFixed(4)}, limit $${limit.toFixed(2)})`,
      `Estimated requests: ${preflight.total.requests} (at most ${preflight.total.maxRequests})`,
      ...(config.discovery.provider === "google" ? ["Gemini billing:     none on a free-tier key (estimates use paid-tier rates); free-tier data may be used by Google"] : []),
      "=".repeat(72),
    ].join("\n"),
  );
  const result = await runRealTopicBenchmark(dataset, config, prices, { discoveryApiKey, jevApiKey }, repeats, { onProgress: (m) => console.log(m) });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, realResultFileName(result));
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(renderTopicBenchmarkMarkdown(result.report));
  const cost = result.totals.estimatedCostUsd;
  console.log(`\nRequests ${result.totals.requests}; tokens in ${result.totals.inputTokens}, out ${result.totals.outputTokens}; cost ${cost === undefined ? "partly unpriced" : `$${cost.toFixed(4)}`}; attempts per repeat ${result.totals.attempts.join(", ")}; batches ${result.totals.batches}.`);
  console.log(`Models served: discovery ${[...new Set(result.usage.flatMap((u) => u.discovery.modelsServed))].join(", ") || "none"}; assignment ${[...new Set(result.usage.flatMap((u) => u.assignment.modelsServed))].join(", ") || "none"}.`);
  console.log(`Saved ${file}`);
  if (!result.report.oracleGate.passed) process.exit(1);
}

async function discoverySuite(
  suite: "discovery-only" | "smoke",
  dataset: ReturnType<typeof loadTopicBenchmarkDataset>,
  repeats: number,
  values: { live?: boolean; "max-cost-usd"?: string; provider?: string; model?: string; comments?: string },
): Promise<void> {
  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, values.provider ?? DEFAULT_DISCOVERY_PROVIDER, values.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const prices = loadPrices();
  const smokeComments = suite === "smoke" ? Number(values.comments ?? DEFAULT_SMOKE_COMMENTS) : undefined;
  let commentIds: string[] | undefined;
  try {
    commentIds = smokeComments !== undefined ? smokeCommentIds(dataset, smokeComments) : undefined;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const runs = suite === "smoke" ? 1 : repeats;
  const plan = buildDiscoveryBenchmarkPlan(suite, dataset, config, prices, process.env, runs, commentIds);
  const limit = values["max-cost-usd"] !== undefined ? Number(values["max-cost-usd"]) : config.limits.maxCostUsd;
  if (!(limit > 0)) fail("--max-cost-usd must be a positive number");
  console.log(renderDiscoveryBenchmarkPlan(plan));
  if (!values.live) {
    const command = [`--suite ${suite} --dataset ${dataset.id}`, values.provider ? `--provider ${values.provider}` : "", values.model ? `--model ${values.model}` : "", "--live", suite === "smoke" ? `--comments ${smokeComments}` : `--repeats ${repeats}`].filter(Boolean).join(" ");
    console.error(`\nRun NOT started: add --live to make real discovery API calls (e.g. npm run benchmark-topics -- ${command}).`);
    process.exit(2);
  }

  const apiKey = process.env[config.discovery.apiKeyEnv];
  if (!apiKey) fail(`Missing ${config.discovery.apiKeyEnv}. Add it to a local .env file (never commit it); nothing was sent.`);
  if (!plan.discovery.priceConfigured) fail("The discovery model has no price in config/model-prices.json; nothing was sent.");
  if (!(plan.maxCostUsd <= limit)) fail(`Worst-case cost $${plan.maxCostUsd.toFixed(4)} exceeds the limit $${limit.toFixed(2)} (--max-cost-usd); nothing was sent.`);
  console.log(
    [
      "",
      "=".repeat(72),
      `LIVE ${suite.toUpperCase()} RUN: DISCOVERY API CALLS WILL BE MADE (no Jev calls)`,
      `Dataset:            ${dataset.id} (topic base ${plan.topicBase}${suite === "smoke" ? ", smoke subset" : ""}, discovery sample ${plan.sampleSize})`,
      `Discovery model:    ${config.discovery.model} (${config.discovery.provider}, ${config.discovery.contract})`,
      `Runs:               ${runs}`,
      `Worst-case cost:    $${plan.maxCostUsd.toFixed(4)} (limit $${limit.toFixed(2)}); at most ${plan.maxRequests} requests`,
      "=".repeat(72),
    ].join("\n"),
  );
  const result = await runDiscoveryBenchmark(suite, dataset, config, prices, apiKey, { repeats: runs, ...(smokeComments !== undefined ? { smokeComments } : {}), onProgress: (m) => console.log(m) });
  console.log(`\n${renderDiscoveryBenchmarkMarkdown(result)}`);
  if (suite === "discovery-only") {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, discoveryResultFileName(result));
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Saved ${file}`);
  }
  if (result.oracleGate && !result.oracleGate.passed) process.exit(1);
}

async function consolidatedSuite(dataset: ReturnType<typeof loadTopicBenchmarkDataset>, repeats: number, values: { live?: boolean; "max-cost-usd"?: string; provider?: string; model?: string }): Promise<void> {
  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, values.provider ?? DEFAULT_DISCOVERY_PROVIDER, values.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const prices = loadPrices();
  const plan = buildConsolidatedBenchmarkPlan(dataset, config, prices, process.env, repeats);
  const limit = values["max-cost-usd"] !== undefined ? Number(values["max-cost-usd"]) : config.limits.maxCostUsd;
  if (!(limit > 0)) fail("--max-cost-usd must be a positive number");
  console.log(renderConsolidatedBenchmarkPlan(plan));
  if (!values.live) {
    const command = [`--suite discovery-consolidated --dataset ${dataset.id}`, values.provider ? `--provider ${values.provider}` : "", values.model ? `--model ${values.model}` : "", `--live --repeats ${repeats}`].filter(Boolean).join(" ");
    console.error(`\nRun NOT started: add --live to make real discovery and consolidation API calls (e.g. npm run benchmark-topics -- ${command}).`);
    process.exit(2);
  }

  const apiKey = process.env[config.discovery.apiKeyEnv];
  if (!apiKey) fail(`Missing ${config.discovery.apiKeyEnv}. Add it to a local .env file (never commit it); nothing was sent.`);
  if (!plan.discovery.discovery.priceConfigured) fail("The model has no price in config/model-prices.json; nothing was sent.");
  if (!(plan.maxCostUsd <= limit)) fail(`Worst-case cost $${plan.maxCostUsd.toFixed(4)} exceeds the limit $${limit.toFixed(2)} (--max-cost-usd); nothing was sent.`);
  console.log(
    [
      "",
      "=".repeat(72),
      "LIVE EXPERIMENTAL RUN: DISCOVERY + CONSOLIDATION API CALLS WILL BE MADE (no Jev calls)",
      `Dataset:            ${dataset.id} (topic base ${plan.discovery.topicBase}, discovery sample ${plan.discovery.sampleSize})`,
      `Model:              ${config.discovery.model} (${config.discovery.provider}), both phases`,
      `Repeats:            ${repeats}`,
      `Worst-case cost:    $${plan.maxCostUsd.toFixed(4)} (limit $${limit.toFixed(2)}); at most ${plan.maxRequests} requests`,
      "=".repeat(72),
    ].join("\n"),
  );
  const result = await runConsolidatedDiscoveryBenchmark(dataset, config, prices, apiKey, { repeats, onProgress: (m) => console.log(m) });
  console.log(`\n${renderConsolidatedBenchmarkMarkdown(result)}`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, consolidatedResultFileName(result));
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Saved ${file}`);
  if (!result.oracleGate.passed) process.exit(1);
}

/** `v3` / `v4` or a full contract name; v3 (the frozen baseline) when absent. */
function consolidationContractOf(value: string | undefined): TopicConsolidationContract {
  if (value === undefined) return TOPIC_CONSOLIDATION_CONTRACT;
  const contract = /^v\d+$/.test(value) ? `topic-consolidation-${value}` : value;
  if (!isTopicConsolidationContract(contract)) fail(`Unknown --consolidation "${value}". Use v3 (frozen baseline) or v4 (experiment).`);
  return contract;
}

async function realConsolidatedSuite(
  dataset: ReturnType<typeof loadTopicBenchmarkDataset>,
  repeats: number,
  values: { live?: boolean; "max-cost-usd"?: string; provider?: string; model?: string; consolidation?: string },
): Promise<void> {
  const contract = consolidationContractOf(values.consolidation);
  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, values.provider ?? DEFAULT_DISCOVERY_PROVIDER, values.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const prices = loadPrices();
  const plan = buildRealConsolidatedPlan(dataset, config, prices, process.env, repeats, contract);
  const limit = values["max-cost-usd"] !== undefined ? Number(values["max-cost-usd"]) : config.limits.maxCostUsd;
  if (!(limit > 0)) fail("--max-cost-usd must be a positive number");
  console.log(renderTopicRealPreflight(plan.real));
  console.log(renderRealConsolidatedPlanAddendum(plan));
  if (!values.live) {
    const command = [`--suite real-consolidated --dataset ${dataset.id}`, values.provider ? `--provider ${values.provider}` : "", values.model ? `--model ${values.model}` : "", values.consolidation !== undefined ? `--consolidation ${values.consolidation}` : "", `--live --repeats ${repeats}`].filter(Boolean).join(" ");
    console.error(`\nRun NOT started: add --live to make real API calls (e.g. npm run benchmark-topics -- ${command}).`);
    process.exit(2);
  }

  const discoveryApiKey = process.env[config.discovery.apiKeyEnv];
  const jevApiKey = process.env[config.assignment.apiKeyEnv];
  if (!discoveryApiKey || !jevApiKey) fail(`Missing ${[!discoveryApiKey && config.discovery.apiKeyEnv, !jevApiKey && config.assignment.apiKeyEnv].filter(Boolean).join(" and ")}. Add it to a local .env file (never commit it); nothing was sent.`);
  if (!plan.real.models.pricesConfigured.discovery || !plan.real.models.pricesConfigured.assignment) fail("A configured model has no price in config/model-prices.json; nothing was sent.");
  if (!(plan.maxCostUsd <= limit)) fail(`Worst-case cost $${plan.maxCostUsd.toFixed(4)} exceeds the limit $${limit.toFixed(2)} (--max-cost-usd); nothing was sent.`);
  console.log(
    [
      "",
      "=".repeat(72),
      "LIVE EXPERIMENTAL RUN (real-consolidated): API CALLS WILL BE MADE AND WILL BE BILLED",
      `Dataset:            ${dataset.id} (${dataset.comments.length} comments, topic base ${plan.real.dataset.topicBase})`,
      `Discovery model:    ${config.discovery.model} (${config.discovery.provider}, ${config.discovery.contract}), then consolidation (${plan.consolidation.contract})`,
      `Assignment model:   ${config.assignment.model} (TypeSafe, ${config.assignment.contract} / ${config.assignment.questionSet})`,
      `Repeats:            ${repeats}`,
      `Worst-case cost:    $${plan.maxCostUsd.toFixed(4)} (limit $${limit.toFixed(2)}); at most ${plan.maxRequests} requests`,
      "=".repeat(72),
    ].join("\n"),
  );
  const result = await runRealConsolidatedBenchmark(dataset, config, prices, { discoveryApiKey, jevApiKey }, repeats, { onProgress: (m) => console.log(m), consolidationContract: contract });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, realConsolidatedResultFileName(result));
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n${renderRealConsolidatedMarkdown(result)}`);
  console.log(`Saved ${file}`);
  if (!result.report.oracleGate.passed) process.exit(1);
}

async function checkModels(config: ReturnType<typeof loadTopicProviderConfig>): Promise<void> {
  const discoveryKey = process.env[config.discovery.apiKeyEnv];
  const jevKey = process.env[config.assignment.apiKeyEnv];
  console.log("\n## Model check (read-only)");
  if (!discoveryKey) console.log(`- ${config.discovery.model}: not checked (${config.discovery.apiKeyEnv} missing)`);
  else {
    try {
      const id =
        config.discovery.provider === "google"
          ? await checkGeminiModel(createGeminiClient(discoveryKey, { maxRetries: 1, timeoutMs: 15_000 }), config.discovery.model)
          : (await createAnthropicClient(discoveryKey, { maxRetries: 1, timeoutMs: 15_000 }).models.retrieve(config.discovery.model)).id;
      console.log(`- ${config.discovery.model}: available (id ${id})`);
    } catch (error) {
      console.log(`- ${config.discovery.model}: NOT available or not reachable (${error instanceof Error ? error.constructor.name : "Error"})`);
    }
  }
  if (!jevKey) console.log(`- ${config.assignment.model}: not checked (${config.assignment.apiKeyEnv} missing)`);
  else {
    try {
      const models = await listJevModels({ apiKey: jevKey, baseUrl: config.assignment.baseUrl });
      console.log(`- ${config.assignment.model}: ${models.includes(config.assignment.model) ? "reported" : "NOT reported"} by the TypeSafe account (models: ${models.join(", ")})`);
    } catch (error) {
      console.log(`- ${config.assignment.model}: not reachable (${error instanceof Error ? error.name : "Error"})`);
    }
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

await main();
