import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS, type TopicBenchmarkDatasetId } from "./topic-datasets";
import { buildDiscoveryBenchmarkPlan, runDiscoveryBenchmark } from "./topic-discovery-only";
import {
  cellKey,
  DISCOVERY_RELIABILITY_EXPERIMENT,
  evaluateReliabilityExperiment,
  nextScheduledRun,
  RELIABILITY_RESERVATION_KIND,
  RELIABILITY_RUN_KIND,
  reliabilityBudget,
  reliabilityExperimentFingerprint,
  reliabilityReservationFileName,
  reliabilityReservationOf,
  reliabilityRunFileName,
  reliabilitySchedule,
  reliabilityStampOf,
  renderReliabilityEvaluationMarkdown,
  type ReliabilityReservation,
  type ReliabilityRunFile,
} from "./topic-discovery-reliability";
import { loadPrices, loadTopicProviderConfig, selectDiscoveryProvider } from "./topic-real";

// PRE-REGISTERED discovery-only reliability experiment, topic-discovery-v2 vs topic-discovery-v3 on t4 and t5
// (docs/topic-discovery-v3-reliability-preregistration.md). The registration fixes datasets, contracts, provider,
// model, schedule and budget; this CLI takes no override of any of them.
//   npx tsx --env-file-if-exists=.env src/benchmark/discovery-reliability-cli.ts                          plan; NO API CALLS
//   npx tsx --env-file-if-exists=.env src/benchmark/discovery-reliability-cli.ts --live [--next-run-only]  runs the remaining scheduled runs (billed)
//   npx tsx src/benchmark/discovery-reliability-cli.ts --check                                             evaluates saved runs; NO API CALLS
// Each scheduled run is reserved (a file written before it starts) and run once; the budget is checked before each run.

const def = DISCOVERY_RELIABILITY_EXPERIMENT;

function readRuns(dir: string): { file: string; run: ReliabilityRunFile }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes(`-discovery-reliability-${def.id}-run-`) && !f.endsWith("-reserved.json"));
  } catch {
    files = [];
  }
  return files.map((file) => ({ file, run: JSON.parse(readFileSync(join(dir, file), "utf8")) as ReliabilityRunFile })).filter((x) => x.run.kind === RELIABILITY_RUN_KIND);
}

function readReservations(dir: string): { file: string; reservation: ReliabilityReservation }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith("-reserved.json") && f.includes(`-discovery-reliability-${def.id}-run-`));
  } catch {
    files = [];
  }
  return files.map((file) => ({ file, reservation: JSON.parse(readFileSync(join(dir, file), "utf8")) as ReliabilityReservation })).filter((x) => x.reservation.kind === RELIABILITY_RESERVATION_KIND);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "next-run-only": { type: "boolean", default: false },
      results: { type: "string", default: "benchmark-results" },
    },
  });
  const results = values.results;
  if (values.check && (values.live || values["next-run-only"])) fail("--check is offline; it cannot be combined with --live or --next-run-only.");
  if (values["next-run-only"] && !values.live) fail("--next-run-only is only valid with --live.");

  // The registered datasets must be exactly the registered files.
  for (const d of def.datasets) {
    const sha = createHash("sha256").update(readFileSync(TOPIC_BENCHMARK_DATASETS[d.id as TopicBenchmarkDatasetId])).digest("hex");
    if (sha !== d.sha256 || loadTopicBenchmarkDataset(d.id as TopicBenchmarkDatasetId).version !== d.version) fail(`${d.id} is not the registered file (SHA-256 ${sha}, registered ${d.sha256}). Nothing was sent.`);
  }
  const runs = readRuns(results);
  const reservations = readReservations(results);
  const state = evaluateReliabilityExperiment(def, runs, reservations);

  if (values.check) {
    console.log("NO API CALLS MADE (offline evaluation of saved runs)\n");
    console.log(renderReliabilityEvaluationMarkdown(state));
    process.exit(state.verdict === "PASS" ? 0 : state.verdict === "INCOMPLETE" ? 2 : 1);
  }
  if (state.verdict === "INVALID") fail(`${renderReliabilityEvaluationMarkdown(state)}\n\nThe saved runs do not match the registration; nothing was sent.`);

  let config = loadTopicProviderConfig();
  try {
    config = selectDiscoveryProvider(config, def.discovery.provider, def.discovery.model);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const prices = loadPrices();
  const worstCaseOf = (dataset: string, contract: (typeof def)["baseline"]) =>
    buildDiscoveryBenchmarkPlan("discovery-only", loadTopicBenchmarkDataset(dataset as TopicBenchmarkDatasetId), config, prices, process.env, 1, undefined, contract).maxCostUsd;
  const next = nextScheduledRun(def, runs, reservations);
  const schedule = reliabilitySchedule(def);
  const done = schedule.length - (next ? schedule.length - next.index + 1 : 0);
  const budget = next ? reliabilityBudget(def, runs, reservations, next, worstCaseOf(next.dataset, next.contract)) : null;
  console.log(
    [
      `# Pre-registered discovery reliability experiment ${def.id}: plan`,
      "",
      "NO API CALLS MADE",
      "",
      `Registration: ${def.document}; definition ${reliabilityExperimentFingerprint(def)}.`,
      `${def.baseline} (baseline) vs ${def.candidate} (candidate); ${def.discovery.provider} / ${def.discovery.model}; ${def.discovery.retryPolicy}, at most ${def.discovery.maxAttempts} attempts per run; discovery only (no consolidation, no Jev).`,
      `Datasets: ${def.datasets.map((d) => `${d.id} (SHA-256 ${d.sha256})`).join(", ")}.`,
      `Schedule: ${schedule.length} runs (${def.runsPerCell} per dataset and contract), no replacement; ${done} started.`,
      `Next run: ${next ? `${next.index} (${next.dataset}, ${next.contract}, run ${next.runNumber})` : "none (every scheduled run has been started)"}.`,
      `This run: ${next === null ? "nothing to run" : values["next-run-only"] ? `run ${next.index} only (--next-run-only)` : `every remaining scheduled run (${next.index} … ${schedule.length})`}.`,
      `Budget: ${budget ? budget.reason : "nothing left to run"}; registered total $${def.budget.totalUsd.toFixed(2)}.`,
      "",
      "NO API CALLS MADE",
    ].join("\n"),
  );
  if (!values.live) {
    console.error("\nRun NOT started: add --live to run the remaining scheduled runs (npx tsx --env-file-if-exists=.env src/benchmark/discovery-reliability-cli.ts --live [--next-run-only]).");
    process.exit(2);
  }
  if (next === null) fail("Every scheduled run has been started; no additional or replacement run is allowed. Nothing was sent.");

  const apiKey = process.env[config.discovery.apiKeyEnv];
  if (!apiKey) fail(`Missing ${config.discovery.apiKeyEnv}. Add it to a local .env file (never commit it); nothing was sent.`);
  mkdirSync(results, { recursive: true });
  const maxRuns = values["next-run-only"] ? 1 : schedule.length;
  let started = 0;
  for (let n = nextScheduledRun(def, runs, reservations); n !== null && started < maxRuns; n = nextScheduledRun(def, runs, reservations)) {
    started += 1;
    const gate = reliabilityBudget(def, runs, reservations, n, worstCaseOf(n.dataset, n.contract));
    if (!gate.allowed) fail(`Run ${n.index} NOT started: ${gate.reason}. No spending increase is allowed after the experiment started.`);
    console.log(`\nLIVE PRE-REGISTERED RELIABILITY RUN ${n.index} of ${schedule.length} (${n.dataset}, ${n.contract}, run ${n.runNumber}): API CALLS WILL BE MADE AND WILL BE BILLED`);
    const reservation = reliabilityReservationOf(def, n.index, new Date().toISOString());
    const reservationFile = reliabilityReservationFileName(reservation);
    writeFileSync(join(results, reservationFile), `${JSON.stringify(reservation, null, 2)}\n`, { flag: "wx" });
    reservations.push({ file: reservationFile, reservation });
    const result = await runDiscoveryBenchmark("discovery-only", loadTopicBenchmarkDataset(n.dataset as TopicBenchmarkDatasetId), config, prices, apiKey, { repeats: 1, discoveryContract: n.contract, onProgress: (m) => console.log(m) });
    const file: ReliabilityRunFile = { kind: RELIABILITY_RUN_KIND, stamp: reliabilityStampOf(def, n), result };
    const name = reliabilityRunFileName(file);
    writeFileSync(join(results, name), `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
    runs.push({ file: name, run: file });
    const r = result.runs[0];
    console.log(`run ${n.index} (${cellKey(n.dataset, n.contract)}): ${r ? `${r.status}; attempts ${r.attempts.map((a) => (a.outcome === "valid" ? "valid" : `${a.outcome}[${a.providerFailure ?? a.issueCodes.join(",")}]`)).join(", ")}` : "no run (oracle gate failed)"}. Saved ${join(results, name)}`);
    if (result.oracleGate && !result.oracleGate.passed) process.exit(1);
  }
  console.log(`\n${renderReliabilityEvaluationMarkdown(evaluateReliabilityExperiment(def, runs, reservations))}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

await main();
