import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isTopicConsolidationContract, TOPIC_CONSOLIDATION_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT_V4, type TopicConsolidationContract } from "../core/topics/consolidation-contract";
import { isTopicBenchmarkDatasetId, loadTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "./topic-datasets";
import {
  buildPairedPlan,
  evaluateScheduledPairedExperiment,
  experimentBudget,
  nextScheduledPair,
  PAIR_RESERVATION_KIND,
  PAIRED_CONSOLIDATION_KIND,
  PAIRED_DISCOVERY_RETRY_POLICY,
  PAIRED_EXPERIMENTS,
  PAIRED_NOTICE,
  pairedExperimentFingerprint,
  pairedResultFileName,
  pairReservationFileName,
  pairReservationOf,
  renderPairedResultMarkdown,
  renderScheduledEvaluationMarkdown,
  runPairedConsolidationPair,
  validatePairedResult,
  type PairedConsolidationResult,
  type PairReservation,
  type ScheduledPairedExperiment,
} from "./topic-paired-consolidation";
import { DEFAULT_DISCOVERY_PROVIDER, loadPrices, loadTopicProviderConfig, selectDiscoveryProvider } from "./topic-real";

// EXPERIMENTAL paired consolidation comparison (docs/topic-consolidation-paired-experiment.md): one discovery per
// pair, the same validated taxonomy consolidated by both contracts. Separate from topics-cli; the real-consolidated
// suite is unchanged.
//   npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset <id> [--pairs 1]          plan; NO API CALLS
//   npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset <id> --pairs 1 --live     runs pairs (billed)
//   npx tsx src/benchmark/paired-consolidation-cli.ts --dataset <id> --check                                       validates saved pairs; NO API CALLS
//   npx tsx src/benchmark/paired-consolidation-cli.ts --dataset <id> --check --experiment <id>                     + evaluates a pre-registered experiment
// --baseline / --candidate: v3, v4 or a full contract name (default v3 vs v4). Pair files never overwrite anything:
// each has its own timestamped name containing "-paired-consolidation-".
// A PRE-REGISTERED experiment (PAIRED_EXPERIMENTS) runs only through its own mode, which fixes everything else:
//   npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset <id> --experiment <id>          plan; NO API CALLS
//   npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset <id> --experiment <id> --live   runs the remaining scheduled pairs (billed)
// --next-pair-only (experiment mode) stops after the next scheduled pair instead of running all remaining ones.
// Each scheduled pair is reserved (a file written before it starts) and run once; the registered budget is checked
// before every pair. Ad-hoc live pairs on a dataset reserved by a registered experiment are refused.

const RESULTS_DIR = "benchmark-results";

function contractOf(value: string | undefined, fallback: TopicConsolidationContract, flag: string): TopicConsolidationContract {
  if (value === undefined) return fallback;
  const contract = /^v\d+$/.test(value) ? `topic-consolidation-${value}` : value;
  if (!isTopicConsolidationContract(contract)) fail(`Unknown ${flag} "${value}". Use v3 or v4.`);
  return contract;
}

function readReservations(dir: string, experiment: string): { file: string; reservation: PairReservation }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes("-paired-experiment-"));
  } catch {
    files = [];
  }
  return files.map((file) => ({ file, reservation: JSON.parse(readFileSync(join(dir, file), "utf8")) as PairReservation })).filter((x) => x.reservation.kind === PAIR_RESERVATION_KIND && x.reservation.experiment === experiment);
}

function readPairs(dir: string, datasetId: string): { file: string; result: PairedConsolidationResult }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes(`-${datasetId}-paired-consolidation-`));
  } catch {
    files = [];
  }
  return files.map((file) => ({ file, result: JSON.parse(readFileSync(join(dir, file), "utf8")) as PairedConsolidationResult })).filter((x) => x.result.meta?.kind === PAIRED_CONSOLIDATION_KIND);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      pairs: { type: "string" },
      live: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      experiment: { type: "string" },
      baseline: { type: "string" },
      candidate: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      results: { type: "string", default: RESULTS_DIR },
      "max-cost-usd": { type: "string" },
      "next-pair-only": { type: "boolean", default: false },
    },
  });
  if (values.dataset === undefined || !isTopicBenchmarkDatasetId(values.dataset)) fail(`--dataset is required: one of ${Object.keys(TOPIC_BENCHMARK_DATASETS).join(", ")}.`);
  const dataset = loadTopicBenchmarkDataset(values.dataset);
  if (values["next-pair-only"] && (values.experiment === undefined || values.check)) fail("--next-pair-only is only valid with --experiment (and without --check).");
  // A pre-registered experiment fixes contracts, models, pairs and budget: its own mode, before any other option.
  if (values.experiment !== undefined && !values.check) return experimentRun(experimentOf(values.experiment), dataset, values);
  const baseline = contractOf(values.baseline, TOPIC_CONSOLIDATION_CONTRACT, "--baseline");
  const candidate = contractOf(values.candidate, TOPIC_CONSOLIDATION_CONTRACT_V4, "--candidate");
  if (baseline === candidate) fail("--baseline and --candidate must differ.");
  if (values.check && values.live) fail("--check is offline; it cannot be combined with --live.");

  if (values.check) {
    console.log("NO API CALLS MADE (offline validation of saved pairs)\n");
    const pairs = readPairs(values.results, dataset.id);
    console.log(`${pairs.length} saved pair(s) for ${dataset.id} in ${values.results}/`);
    let invalid = 0;
    for (const p of pairs) {
      const problems = validatePairedResult(p.result, dataset);
      if (problems.length > 0) invalid += 1;
      console.log(`- ${p.file}: ${p.result.status}; ${problems.length === 0 ? "valid" : `INVALID: ${problems.join("; ")}`}`);
    }
    if (values.experiment === undefined) process.exit(invalid > 0 ? 1 : 0);
    const def = experimentOf(values.experiment);
    const evaluation = evaluateScheduledPairedExperiment(def, pairs, readReservations(values.results, def.id), dataset);
    console.log(`\n${renderScheduledEvaluationMarkdown(evaluation)}`);
    process.exit(evaluation.verdict === "PASS" ? 0 : evaluation.verdict === "FAIL" || evaluation.verdict === "INVALID" ? 1 : 2);
  }

  const pairs = Number(values.pairs ?? "1");
  if (!Number.isInteger(pairs) || pairs < 1) fail("--pairs must be a positive integer");
  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, values.provider ?? DEFAULT_DISCOVERY_PROVIDER, values.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const prices = loadPrices();
  const plan = buildPairedPlan(dataset, config, prices, process.env, pairs, [baseline, candidate]);
  const limit = values["max-cost-usd"] !== undefined ? Number(values["max-cost-usd"]) : config.limits.maxCostUsd;
  if (!(limit > 0)) fail("--max-cost-usd must be a positive number");
  const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "unpriced");
  // Arm order alternates by pair index; the index continues from the pairs already saved for these contracts.
  const firstIndex = readPairs(values.results, dataset.id).filter((p) => p.result.meta.contracts.baseline === baseline && p.result.meta.contracts.candidate === candidate).length + 1;
  console.log(
    [
      "# Paired consolidation comparison (EXPERIMENTAL): plan",
      "",
      "NO API CALLS MADE",
      "",
      PAIRED_NOTICE,
      `Dataset ${dataset.id} (${dataset.version}); contracts ${baseline} (baseline) vs ${candidate} (candidate); pairs ${pairs}, starting at pair index ${firstIndex}.`,
      `Discovery: ${config.discovery.model} (${config.discovery.provider}); retry policy ${PAIRED_DISCOVERY_RETRY_POLICY.id} (at most ${PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts} attempts; exhausted = whole pair unavailable).`,
      `Assignment: ${config.assignment.model} (TypeSafe, ${config.assignment.contract} / ${config.assignment.questionSet}).`,
      `Worst case per pair: discovery ${usd(plan.discoveryMaxCostUsd)} + arms ${usd(plan.armMaxCostUsd)} (conservative); total ${usd(plan.maxCostUsd)}, at most ${plan.maxRequests} requests; limit $${limit.toFixed(2)}.`,
      "",
      "NO API CALLS MADE",
    ].join("\n"),
  );
  if (!values.live) {
    const command = [`--dataset ${dataset.id}`, values.baseline ? `--baseline ${values.baseline}` : "", values.candidate ? `--candidate ${values.candidate}` : "", values.provider ? `--provider ${values.provider}` : "", values.model ? `--model ${values.model}` : "", `--pairs ${pairs} --live`].filter(Boolean).join(" ");
    console.error(`\nRun NOT started: add --live to make real API calls (e.g. npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts ${command}).`);
    process.exit(2);
  }

  const reservedBy = Object.values(PAIRED_EXPERIMENTS).find((d) => d.dataset === dataset.id);
  if (reservedBy) fail(`${dataset.id} is the pre-registered hold-out of ${reservedBy.id}; live pairs on it run only with --experiment ${reservedBy.id}. Nothing was sent.`);
  const discoveryApiKey = process.env[config.discovery.apiKeyEnv];
  const jevApiKey = process.env[config.assignment.apiKeyEnv];
  if (!discoveryApiKey || !jevApiKey) fail(`Missing ${[!discoveryApiKey && config.discovery.apiKeyEnv, !jevApiKey && config.assignment.apiKeyEnv].filter(Boolean).join(" and ")}. Add it to a local .env file (never commit it); nothing was sent.`);
  if (!(plan.maxCostUsd <= limit)) fail(`Worst-case cost ${usd(plan.maxCostUsd)} exceeds the limit $${limit.toFixed(2)} (--max-cost-usd); nothing was sent.`);
  console.log(["", "=".repeat(72), "LIVE PAIRED RUN: API CALLS WILL BE MADE AND WILL BE BILLED", "=".repeat(72)].join("\n"));
  mkdirSync(values.results, { recursive: true });
  for (let i = 0; i < pairs; i++) {
    const result = await runPairedConsolidationPair(dataset, config, prices, { discoveryApiKey, jevApiKey }, { pairIndex: firstIndex + i, baseline, candidate, onProgress: (m) => console.log(m) });
    const file = join(values.results, pairedResultFileName(result));
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    console.log(`\n${renderPairedResultMarkdown(result)}\nSaved ${file}`);
    if (result.status === "oracle_gate_failed") process.exit(1);
  }
}

function experimentOf(id: string): ScheduledPairedExperiment {
  const def = PAIRED_EXPERIMENTS[id];
  if (!def) fail(`No pre-registered paired experiment "${id}" (registered: ${Object.keys(PAIRED_EXPERIMENTS).join(", ") || "none"}). Register it in PAIRED_EXPERIMENTS before its first live pair.`);
  return def;
}

/** Runs the remaining scheduled pairs of a pre-registered experiment, exactly as registered (or prints its plan). */
async function experimentRun(def: ScheduledPairedExperiment, dataset: ReturnType<typeof loadTopicBenchmarkDataset>, values: Record<string, string | boolean | undefined>): Promise<void> {
  for (const flag of ["pairs", "baseline", "candidate", "provider", "model", "max-cost-usd"]) if (values[flag] !== undefined) fail(`--${flag} cannot be combined with --experiment: the registration fixes it.`);
  if (dataset.id !== def.dataset) fail(`${def.id} is registered on ${def.dataset}, not ${dataset.id}.`);
  const fileSha = createHash("sha256").update(readFileSync(TOPIC_BENCHMARK_DATASETS[dataset.id as keyof typeof TOPIC_BENCHMARK_DATASETS])).digest("hex");
  if (fileSha !== def.datasetSha256 || dataset.version !== def.datasetVersion) fail(`${dataset.id} is not the registered file (SHA-256 ${fileSha}, registered ${def.datasetSha256}). Nothing was sent.`);
  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, def.discovery.provider, def.discovery.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const a = config.assignment;
  if (config.discovery.contract !== def.discovery.contract || a.model !== def.assignment.model || a.contract !== def.assignment.contract || a.questionSet !== def.assignment.questionSet) fail("The configured discovery or assignment differs from the registration. Nothing was sent.");
  const prices = loadPrices();
  const results = String(values.results);
  const pairWorstCase = buildPairedPlan(dataset, config, prices, process.env, 1, [def.baseline, def.candidate]).maxCostUsd;
  const pairs = readPairs(results, dataset.id);
  const reservations = readReservations(results, def.id);
  const state = evaluateScheduledPairedExperiment(def, pairs, reservations, dataset);
  if (state.verdict === "INVALID") fail(`${renderScheduledEvaluationMarkdown(state)}\n\nThe saved pairs do not match the registration; nothing was sent.`);
  const next = nextScheduledPair(def, pairs, reservations);
  const budget = experimentBudget(def, pairs, reservations, pairWorstCase);
  console.log(
    [
      `# Pre-registered paired experiment ${def.id}: plan`,
      "",
      "NO API CALLS MADE",
      "",
      `Registration: ${def.document}; definition ${pairedExperimentFingerprint(def)}.`,
      `Dataset ${def.dataset} (SHA-256 ${def.datasetSha256}); ${def.baseline} (baseline) vs ${def.candidate} (candidate).`,
      `Discovery ${def.discovery.provider} / ${def.discovery.model} (${def.discovery.contract}, ${def.discovery.retryPolicy}, at most ${def.discovery.maxAttempts} attempts); assignment ${def.assignment.provider} / ${def.assignment.model} (${def.assignment.contract} / ${def.assignment.questionSet}).`,
      `Schedule: ${def.scheduledPairs} pairs, no replacement. ${state.pairs.map((p) => `pair ${p.scheduledPair}: ${p.status}`).join("; ")}.`,
      `Next pair: ${next ?? "none (every scheduled pair has been started)"}.`,
      `This run: ${next === null ? "nothing to run" : values["next-pair-only"] ? `pair ${next} only (--next-pair-only)` : `every remaining scheduled pair (${next} … ${def.scheduledPairs})`}.`,
      `Budget: ${budget.reason}; registered total $${def.budget.totalUsd.toFixed(2)}, spent (worst case where unpriced) $${budget.spentUsd.toFixed(4)}.`,
      "",
      "NO API CALLS MADE",
    ].join("\n"),
  );
  if (!values.live) {
    console.error(`\nRun NOT started: add --live to run the remaining scheduled pairs (npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset ${def.dataset} --experiment ${def.id} --live).`);
    process.exit(2);
  }
  if (next === null) fail("Every scheduled pair has been started; no additional or replacement pair is allowed. Nothing was sent.");

  const discoveryApiKey = process.env[config.discovery.apiKeyEnv];
  const jevApiKey = process.env[config.assignment.apiKeyEnv];
  if (!discoveryApiKey || !jevApiKey) fail(`Missing ${[!discoveryApiKey && config.discovery.apiKeyEnv, !jevApiKey && config.assignment.apiKeyEnv].filter(Boolean).join(" and ")}. Add it to a local .env file (never commit it); nothing was sent.`);
  mkdirSync(results, { recursive: true });
  const maxPairsThisRun = values["next-pair-only"] ? 1 : def.scheduledPairs;
  let started = 0;
  for (let n = nextScheduledPair(def, pairs, reservations); n !== null && started < maxPairsThisRun; n = nextScheduledPair(def, pairs, reservations)) {
    started += 1;
    const gate = experimentBudget(def, pairs, reservations, pairWorstCase);
    if (!gate.allowed) fail(`Pair ${n} NOT started: ${gate.reason}. No spending increase is allowed after the experiment started.`);
    console.log(["", "=".repeat(72), `LIVE PRE-REGISTERED PAIR ${n} of ${def.scheduledPairs} (${def.id}): API CALLS WILL BE MADE AND WILL BE BILLED`, "=".repeat(72)].join("\n"));
    const reservation = pairReservationOf(def, n, new Date().toISOString());
    const reservationFile = pairReservationFileName(reservation);
    writeFileSync(join(results, reservationFile), `${JSON.stringify(reservation, null, 2)}\n`, { flag: "wx" });
    reservations.push({ file: reservationFile, reservation });
    const result = await runPairedConsolidationPair(dataset, config, prices, { discoveryApiKey, jevApiKey }, {
      pairIndex: n,
      baseline: def.baseline,
      candidate: def.candidate,
      experiment: { id: def.id, definitionFingerprint: pairedExperimentFingerprint(def), scheduledPair: n, datasetSha256: def.datasetSha256 },
      onProgress: (m) => console.log(m),
    });
    const file = pairedResultFileName(result);
    writeFileSync(join(results, file), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    pairs.push({ file, result });
    console.log(`\n${renderPairedResultMarkdown(result)}\nSaved ${join(results, file)}`);
    if (result.status === "oracle_gate_failed") process.exit(1);
  }
  const evaluation = evaluateScheduledPairedExperiment(def, pairs, reservations, dataset);
  console.log(`\n${renderScheduledEvaluationMarkdown(evaluation)}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

await main();
