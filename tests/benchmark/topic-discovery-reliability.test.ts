import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { goldOf, loadTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import { runConsolidatedDiscoveryBenchmark } from "../../src/benchmark/topic-discovery-consolidated";
import { buildDiscoveryBenchmarkPlan, discoveryRequestOf, runDiscoveryBenchmark, type DiscoveryBenchmarkResult } from "../../src/benchmark/topic-discovery-only";
import {
  cellKey,
  DISCOVERY_RELIABILITY_EXPERIMENT as DEF,
  evaluateReliabilityExperiment,
  nextScheduledRun,
  RELIABILITY_RUN_KIND,
  reliabilityBudget,
  reliabilityExperimentFingerprint,
  reliabilityReservationFileName,
  reliabilityReservationOf,
  reliabilityRunFileName,
  reliabilitySchedule,
  reliabilityStampOf,
  type DiscoveryReliabilityExperiment,
  type ReliabilityRunFile,
} from "../../src/benchmark/topic-discovery-reliability";
import { runRealConsolidatedBenchmark } from "../../src/benchmark/topic-real-consolidated";
import { loadPrices, loadTopicProviderConfig, runRealTopicBenchmark, selectDiscoveryProvider } from "../../src/benchmark/topic-real";
import { TOPIC_DISCOVERY_CONTRACT, TOPIC_DISCOVERY_CONTRACT_V3 } from "../../src/core/topics/provider-contracts";
import type { TopicIssueCode } from "../../src/core/topics/types";

// PRE-REGISTRATION of the discovery-only reliability experiment topic-discovery-v2 vs topic-discovery-v3 on t4 and t5
// (docs/topic-discovery-v3-reliability-preregistration.md). Offline only: saved runs are synthetic, live paths use a
// fake Anthropic SDK client and a fake Jev endpoint, keys are dummies and the global fetch is trapped.

const ID = "discovery-v3-name-robustness-v1";
const DEFINITION_FINGERPRINT = "sha256:17aa3db369cc0ae836655e01132d2144f6f5f7cf4b19de88117b9075b2dda4fe";
const DOC = "docs/topic-discovery-v3-reliability-preregistration.md";
const ROOT = join(__dirname, "..", "..");
const V2 = TOPIC_DISCOVERY_CONTRACT;
const V3 = TOPIC_DISCOVERY_CONTRACT_V3;
const config = selectDiscoveryProvider(loadTopicProviderConfig(), "anthropic", "claude-sonnet-5-5");
const prices = loadPrices();
const SECRET = "fake-anthropic-key-do-not-use-4242";
const JEV = "fake-jev-key-do-not-use-8686";

let trapped = 0;
beforeEach(() => {
  trapped = 0;
  vi.stubGlobal("fetch", async () => {
    trapped += 1;
    throw new Error("network access is not allowed in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("registration", () => {
  it("registers the experiment, frozen, with a pinned definition fingerprint recorded in the pre-registration document", () => {
    expect(DEF.id).toBe(ID);
    expect(Object.isFrozen(DEF) && Object.isFrozen(DEF.criteria) && Object.isFrozen(DEF.budget) && Object.isFrozen(DEF.datasets)).toBe(true);
    expect(reliabilityExperimentFingerprint(DEF)).toBe(DEFINITION_FINGERPRINT);
    const doc = readFileSync(join(ROOT, DOC), "utf8");
    for (const text of [ID, DEFINITION_FINGERPRINT, "topic-discovery-v2", "topic-discovery-v3", "INCOMPLETE", "$14.00", "13.5908", "does not modify or reinterpret"]) expect(doc, text).toContain(text);
  });

  it("fixes contracts, provider, model, retry policy, datasets (by SHA-256) and 10 runs per dataset and contract, no replacement", () => {
    expect(DEF).toMatchObject({ design: "fixed-schedule", document: DOC, baseline: "topic-discovery-v2", candidate: "topic-discovery-v3", runsPerCell: 10, replacementRuns: 0 });
    expect(DEF.discovery).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", maxAttempts: 2 });
    expect(config.discovery).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    for (const d of DEF.datasets) {
      expect(createHash("sha256").update(readFileSync(join(ROOT, TOPIC_BENCHMARK_DATASETS[d.id as "t4-topics-v1"]))).digest("hex"), d.id).toBe(d.sha256);
      expect(loadTopicBenchmarkDataset(d.id as "t4-topics-v1").version).toBe(d.version);
    }
    expect(DEF.datasets.map((d) => d.id)).toEqual(["t4-topics-v1", "t5-topics-v1"]);
  });

  it("fixes the six criteria exactly as registered", () => {
    expect(DEF.criteria).toEqual({ minEventualValidity: 0.99, minFirstAttemptValidity: 0.95, maxInvalidTopicNameRate: 0.01, noProxyPrecisionRegression: true, noProxyRecallRegression: true, noNewSchemaFailureMode: true });
  });

  it("the budget is the exact conservative worst case of the 40 runs, rounded up to $14.00", () => {
    let total = 0;
    for (const d of DEF.datasets)
      for (const c of [V2, V3] as const) {
        const perRun = buildDiscoveryBenchmarkPlan("discovery-only", loadTopicBenchmarkDataset(d.id as "t4-topics-v1"), config, prices, {}, 1, undefined, c).maxCostUsd;
        expect(DEF.budget.worstCasePerRunUsd[cellKey(d.id, c)], cellKey(d.id, c)).toBe(perRun);
        total += perRun * DEF.runsPerCell;
      }
    expect(DEF.budget.worstCaseTotalUsd).toBeCloseTo(total, 9);
    expect(DEF.budget.totalUsd).toBe(14);
    expect(DEF.budget.totalUsd).toBeGreaterThanOrEqual(total);
  });
});

describe("schedule, stop rule and budget", () => {
  it("40 runs: 10 per dataset and contract, round by round, contract order alternating per round", () => {
    const s = reliabilitySchedule(DEF);
    expect(s).toHaveLength(40);
    for (const d of DEF.datasets) for (const c of [V2, V3]) expect(s.filter((r) => r.dataset === d.id && r.contract === c).map((r) => r.runNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.slice(0, 8).map((r) => `${r.dataset.slice(0, 2)}/${r.contract.slice(-2)}/${r.runNumber}`)).toEqual(["t4/v2/1", "t4/v3/1", "t5/v2/1", "t5/v3/1", "t4/v3/2", "t4/v2/2", "t5/v3/2", "t5/v2/2"]);
    expect(s.map((r) => r.index)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("numbers runs 1 … 40 and then none; a reserved (even aborted) run is never run again", () => {
    const res = (n: number) => ({ file: `r${n}`, reservation: reliabilityReservationOf(DEF, n, "2026-10-07T00:00:00.000Z") });
    expect(nextScheduledRun(DEF, [], [])?.index).toBe(1);
    expect(nextScheduledRun(DEF, [], [res(1), res(2)])?.index).toBe(3);
    expect(nextScheduledRun(DEF, [], [res(40)])).toBeNull();
    expect(reliabilityReservationFileName(res(7).reservation)).toBe("2026-10-07T00-00-00-000Z-discovery-reliability-discovery-v3-name-robustness-v1-run-07-reserved.json");
  });

  it("a run starts only within its registered worst case and the remaining budget; unpriced and aborted runs count at the worst case", () => {
    const s = reliabilitySchedule(DEF);
    const first = s[0]!;
    const worst = DEF.budget.worstCasePerRunUsd[cellKey(first.dataset, first.contract)]!;
    expect(reliabilityBudget(DEF, [], [], first, worst).allowed).toBe(true);
    expect(reliabilityBudget(DEF, [], [], first, worst + 0.01)).toMatchObject({ allowed: false, reason: expect.stringContaining("above the registered") });
    // Every run costing its full worst case still fits: the last run is allowed.
    const allButLast = s.slice(0, 39).map((r) => saved(r.index, { cost: DEF.budget.worstCasePerRunUsd[cellKey(r.dataset, r.contract)]! }));
    expect(reliabilityBudget(DEF, allButLast, [], s[39]!, DEF.budget.worstCasePerRunUsd[cellKey(s[39]!.dataset, s[39]!.contract)]!).allowed).toBe(true);
    // Overspending leaves less than a run's worst case: refused.
    expect(reliabilityBudget(DEF, s.slice(0, 39).map((r) => saved(r.index, { cost: 0.36 })), [], s[39]!, DEF.budget.worstCasePerRunUsd[cellKey(s[39]!.dataset, s[39]!.contract)]!)).toMatchObject({ allowed: false, reason: expect.stringContaining("exceeds the remaining registered budget") });
    expect(reliabilityBudget(DEF, [saved(1, { cost: undefined })], [], s[1]!, 0.1).spentUsd).toBe(worst);
    expect(reliabilityBudget(DEF, [], [{ file: "r", reservation: reliabilityReservationOf(DEF, 1, "t") }], s[1]!, 0.1).spentUsd).toBe(worst);
  });
});

// ---------- synthetic saved runs ----------

type Attempt = "valid" | "name" | `code:${string}` | `provider:${string}`;
interface RunSpec {
  attempts?: Attempt[];
  precision?: number;
  recall?: number;
  cost?: number | undefined;
  def?: DiscoveryReliabilityExperiment;
}

/** A saved scheduled run as the CLI writes it (discovery-only result of one repeat, stamped). */
function saved(index: number, spec: RunSpec = {}): { file: string; run: ReliabilityRunFile } {
  const def = spec.def ?? DEF;
  const s = reliabilitySchedule(DEF).find((r) => r.index === index)!;
  const d = DEF.datasets.find((x) => x.id === s.dataset)!;
  const attempts = (spec.attempts ?? ["valid"]).map((a, i) => {
    const base = { attempt: i + 1, feedbackSent: i > 0, latencyMs: 1 };
    if (a === "valid") return { ...base, outcome: "valid", issueCodes: [] };
    if (a === "name") return { ...base, outcome: "invalid_taxonomy", issueCodes: ["invalid_topic_name"] as TopicIssueCode[] };
    if (a.startsWith("code:")) return { ...base, outcome: "invalid_taxonomy", issueCodes: [a.slice(5)] as TopicIssueCode[] };
    return { ...base, outcome: "provider_error", issueCodes: ["provider_error"] as TopicIssueCode[], providerFailure: a.slice(9) };
  });
  const valid = attempts[attempts.length - 1]!.outcome === "valid";
  const result = {
    meta: { kind: "discovery-only", timestamp: `2026-10-07T00:00:${String(index).padStart(2, "0")}.000Z`, dataset: s.dataset, datasetVersion: d.version, repeats: 1, discovery: { provider: "anthropic", modelRequested: "claude-sonnet-5-5", contract: s.contract, settings: {} }, assignment: "not run" },
    oracleGate: { passed: true, failures: [] },
    runs: [{ repeat: 1, status: valid ? "valid" : "unavailable", attempts, taxonomy: valid ? { topicPrecision: spec.precision ?? 0.8, conceptRecall: spec.recall ?? 1 } : null }],
    totals: { estimatedCostUsd: "cost" in spec ? spec.cost : 0.03 },
  } as unknown as DiscoveryBenchmarkResult;
  const run: ReliabilityRunFile = { kind: RELIABILITY_RUN_KIND, stamp: reliabilityStampOf(def, s), result };
  return { file: reliabilityRunFileName(run), run };
}
const all = (spec: (index: number, contract: string) => RunSpec = () => ({})) => reliabilitySchedule(DEF).map((s) => saved(s.index, spec(s.index, s.contract)));
const crit = (e: { criteria: { criterion: string; passed: boolean; detail: string }[] }, n: number) => e.criteria.find((c) => c.criterion.startsWith(`${n}.`))!;
const firstV3 = () => reliabilitySchedule(DEF).find((s) => s.contract === V3)!.index;

describe("evaluation exactly as registered", () => {
  it("all 40 runs valid at the first attempt, no regression: PASS with the six criteria", () => {
    const e = evaluateReliabilityExperiment(DEF, all());
    expect(e.verdict).toBe("PASS");
    expect(e.criteria).toHaveLength(6);
    expect(e.pooled[V3]).toMatchObject({ runs: 20, evaluableRuns: 20, firstAttemptValidity: 1, eventualValidity: 1, invalidTopicNameRate: 0, otherSchemaFailureRate: 0 });
    expect(Object.keys(e.cells).sort()).toEqual(["t4-topics-v1/topic-discovery-v2", "t4-topics-v1/topic-discovery-v3", "t5-topics-v1/topic-discovery-v2", "t5-topics-v1/topic-discovery-v3"]);
  });

  it("criterion 3: a single v3 invalid_topic_name (1 of 21 responded attempts = 4.8%) exceeds 1% and fails; v2 failures do not matter", () => {
    const e = evaluateReliabilityExperiment(DEF, all((i, c) => (i === firstV3() ? { attempts: ["name", "valid"] } : c === V2 ? { attempts: ["name", "valid"] } : {})));
    expect(e.verdict).toBe("FAIL");
    expect(crit(e, 3)).toMatchObject({ passed: false, detail: expect.stringContaining("(1/21)") });
    expect([crit(e, 1).passed, crit(e, 2).passed]).toEqual([true, true]); // 20/20 eventual, 19/20 = 95% first attempt
    expect(evaluateReliabilityExperiment(DEF, all((_, c) => (c === V2 ? { attempts: ["name", "valid"] } : {}))).verdict).toBe("PASS");
  });

  it("criteria 1 and 2: eventual validity 99% (so every v3 run) and first-attempt validity 95% (at most one v3 first-attempt failure)", () => {
    const v3 = reliabilitySchedule(DEF).filter((s) => s.contract === V3).map((s) => s.index);
    const e1 = evaluateReliabilityExperiment(DEF, all((i) => (i === v3[0] ? { attempts: ["code:unknown_example_comment", "code:unknown_example_comment"] } : {})));
    expect([crit(e1, 1).passed, crit(e1, 1).detail]).toEqual([false, expect.stringMatching(/^topic-discovery-v3 95\.00%/)]);
    const two = evaluateReliabilityExperiment(DEF, all((i) => (i === v3[0] || i === v3[1] ? { attempts: ["code:missing_definition", "valid"] } : {})));
    expect([crit(two, 1).passed, crit(two, 2).passed]).toEqual([true, false]);
  });

  it("criteria 4 and 5: no regression in proxy precision or recall (v3 mean >= v2 mean, no tolerance)", () => {
    expect(crit(evaluateReliabilityExperiment(DEF, all((_, c) => ({ precision: c === V3 ? 0.8 : 0.8 }))), 4).passed).toBe(true);
    expect(crit(evaluateReliabilityExperiment(DEF, all((_, c) => ({ precision: c === V3 ? 0.799 : 0.8 }))), 4).passed).toBe(false);
    expect(crit(evaluateReliabilityExperiment(DEF, all((_, c) => ({ recall: c === V3 ? 0.99 : 1 }))), 5).passed).toBe(false);
  });

  it("criterion 6: a rejection code in v3 that v2 never showed is a new schema failure mode", () => {
    const v3 = firstV3();
    const v2 = reliabilitySchedule(DEF).find((s) => s.contract === V2)!.index;
    expect(crit(evaluateReliabilityExperiment(DEF, all((i) => (i === v3 ? { attempts: ["code:duplicate_topic_key", "valid"] } : {}))), 6)).toMatchObject({ passed: false, detail: "duplicate_topic_key" });
    expect(crit(evaluateReliabilityExperiment(DEF, all((i) => (i === v3 || i === v2 ? { attempts: ["code:duplicate_topic_key", "valid"] } : {}))), 6).passed).toBe(true);
  });

  it("provider/API failures and timeouts are reported separately and never count as format failures", () => {
    const e = evaluateReliabilityExperiment(DEF, all((i) => (i === firstV3() ? { attempts: ["provider:timeout", "valid"] } : {})));
    expect(e.pooled[V3]!.failures).toMatchObject({ topicNameFailures: 0, otherSchemaFailures: 0, providerFailures: { timeout: 1 }, respondedAttempts: 20 });
    expect(e.pooled[V3]!.firstAttemptValidity).toBe(1); // 19/19 runs whose first attempt received a response
    expect(e.verdict).toBe("PASS");
  });

  it("INCOMPLETE: a run not yet run, an aborted run, or a provider-unavailable run (never replaced, never a format failure)", () => {
    expect(evaluateReliabilityExperiment(DEF, all().slice(0, 39))).toMatchObject({ verdict: "INCOMPLETE", criteria: [] });
    const aborted = evaluateReliabilityExperiment(DEF, all().slice(0, 39), [{ file: "r40", reservation: reliabilityReservationOf(DEF, 40, "t") }]);
    expect([aborted.verdict, aborted.runs[39]!.status]).toEqual(["INCOMPLETE", "aborted"]);
    const down = evaluateReliabilityExperiment(DEF, all((i) => (i === 3 ? { attempts: ["provider:unavailable", "provider:unavailable"] } : {})));
    expect([down.verdict, down.runs[2]!.status]).toEqual(["INCOMPLETE", "provider_unavailable"]);
    expect(down.pooled[V2]!.failures).toMatchObject({ topicNameFailures: 0, otherSchemaFailures: 0, providerFailures: { unavailable: 2 } });
    expect(evaluateReliabilityExperiment(DEF, [])).toMatchObject({ verdict: "INCOMPLETE", reasons: expect.arrayContaining([expect.stringContaining("40 not run")]) });
  });

  it("INVALID: runs under an altered definition, a scheduled run run twice, or a run that is not the scheduled one", () => {
    const altered: DiscoveryReliabilityExperiment = { ...DEF, criteria: { ...DEF.criteria, maxInvalidTopicNameRate: 0.1 } };
    expect(evaluateReliabilityExperiment(altered, all()).reasons.join()).toMatch(/the definition was altered after runs existed/);
    expect(evaluateReliabilityExperiment(DEF, [...all(), saved(5)]).reasons.join()).toMatch(/scheduled run 5 was run more than once/);
    const wrong = saved(2);
    wrong.run.result.meta.discovery.contract = V2;
    expect(evaluateReliabilityExperiment(DEF, [wrong]).verdict).toBe("INVALID");
    const jev = saved(3);
    (jev.run.result.meta as { assignment: string }).assignment = "ran";
    expect(evaluateReliabilityExperiment(DEF, [jev]).reasons.join()).toMatch(/assignment ran/);
  });
});

// ---------- live paths, offline: raw rejected output on every discovery path ----------

const t5 = loadTopicBenchmarkDataset("t5-topics-v1");
const gold = goldOf(t5);
const concepts = t5.taxonomy.map((t) => t.key);
const sampleIds = new Set(discoveryRequestOf(t5).request.sample.map((c) => c.id));
const candidates = (firstName: string) =>
  concepts.map((k, i) => ({ key: `theme_${i}`, name: i === 0 ? firstName : `Theme number ${i}`, definition: `Synthetic theme number ${i}.`, exampleCommentIds: gold.members.get(k)!.filter((id) => sampleIds.has(id)).slice(0, 2) }));
const REJECTED = JSON.stringify({ topics: candidates("Theme Sign-In and Set-Up Steps") }).replace("Synthetic theme number 1.", `Synthetic theme number 1 ${SECRET}.`);
const ACCEPTED = JSON.stringify({ topics: candidates("Theme number 0") });
const isConsolidation = (params: Record<string, any>) => String(params.system).includes("topic-consolidation-");

function fakeAnthropic(discovery: string[]) {
  const requests: Record<string, any>[] = [];
  const anthropicClient = {
    beta: {
      messages: {
        create: async (params: Record<string, any>) => {
          requests.push(structuredClone(params));
          const n = requests.filter((r) => !isConsolidation(r)).length - 1;
          const text = isConsolidation(params) ? ACCEPTED : discovery[Math.min(n, discovery.length - 1)]!;
          return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 4_000, output_tokens: 1_000 } };
        },
      },
    },
  } as unknown as ReturnType<typeof createAnthropicClient>;
  return { anthropicClient, discoveryRequests: () => requests.filter((r) => !isConsolidation(r)) };
}

function fakeJev() {
  const byText = new Map(t5.comments.map((c) => [c.text, c.id]));
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { state: { comment: string }; questions: Record<string, unknown> };
    const g = gold.dispositions.get(byText.get(body.state.comment)!)!;
    const answers =
      "topic" in body.questions
        ? { topic: { type: "choice", choice: g.disposition === "primary_topic" ? `topic:theme_${concepts.indexOf(g.topicKey)}` : g.disposition } }
        : { topic_sentiment: { type: "choice", choice: g.disposition === "primary_topic" ? g.topicSentiment : "neutral" } };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const expectRedacted = (outputs: { issueCodes: string[]; rawOutput: string }[] | undefined) => {
  expect(outputs).toHaveLength(1);
  expect(outputs![0]!.issueCodes).toEqual(["invalid_topic_name"]);
  expect(outputs![0]!.rawOutput).toContain("Theme Sign-In and Set-Up Steps");
  expect(outputs![0]!.rawOutput).toContain("[REDACTED]");
  expect(outputs![0]!.rawOutput).not.toContain(SECRET);
};

describe("raw rejected discovery output is kept, secrets removed, on every discovery path (offline fakes)", () => {
  it("discovery-only (the reliability runner): v3 records its contract, sends the rejected name on retry and keeps the raw output", async () => {
    const anthropic = fakeAnthropic([REJECTED, ACCEPTED]);
    const result = await runDiscoveryBenchmark("discovery-only", t5, config, prices, SECRET, { repeats: 1, discoveryContract: V3, clients: { anthropicClient: anthropic.anthropicClient } });
    expect(trapped).toBe(0);
    expect(result.meta.discovery.contract).toBe("topic-discovery-v3");
    expect(result.runs[0]!.attempts.map((a) => a.outcome)).toEqual(["invalid_taxonomy", "valid"]);
    expectRedacted(result.runs[0]!.rejectedOutputs);
    const retry = JSON.stringify(anthropic.discoveryRequests()[1]);
    expect(retry).toContain("rejected_topic_names");
    expect(retry).toContain("counted_words");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The default stays v2.
    const v2 = await runDiscoveryBenchmark("discovery-only", t5, config, prices, SECRET, { repeats: 1, clients: { anthropicClient: fakeAnthropic([REJECTED, ACCEPTED]).anthropicClient } });
    expect(v2.meta.discovery.contract).toBe("topic-discovery-v2");
    expectRedacted(v2.runs[0]!.rejectedOutputs);
  });

  it("discovery-consolidated, real and real-consolidated keep the rejected raw output too", async () => {
    const dc = await runConsolidatedDiscoveryBenchmark(t5, config, prices, SECRET, { repeats: 1, clients: { anthropicClient: fakeAnthropic([REJECTED, ACCEPTED]).anthropicClient } });
    expectRedacted(dc.runs[0]!.discoveryRejectedOutputs);
    const keys = { discoveryApiKey: SECRET, jevApiKey: JEV };
    const real = await runRealTopicBenchmark(t5, config, prices, keys, 1, { anthropicClient: fakeAnthropic([REJECTED, ACCEPTED]).anthropicClient, fetch: fakeJev() });
    expectRedacted(real.discoveryRejectedOutputs![0]!.outputs);
    const rc = await runRealConsolidatedBenchmark(t5, config, prices, keys, 1, { anthropicClient: fakeAnthropic([REJECTED, ACCEPTED]).anthropicClient, fetch: fakeJev() });
    expectRedacted(rc.discoveryRejectedOutputs![0]!.outputs);
    for (const r of [dc, real, rc]) expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(trapped).toBe(0);
  }, 120_000);
});

describe("CLI (no API call)", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const run = (args: string[]) => {
    const out = spawnSync(TSX, ["src/benchmark/discovery-reliability-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("prints the registered plan, refuses to start without --live or without a key, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "reliability-"));
    try {
      const plan = run(["--results", dir]);
      expect(plan.status).toBe(2);
      expect(plan.text).toContain("NO API CALLS MADE");
      expect(plan.text).toContain(DEFINITION_FINGERPRINT);
      expect(plan.text).toContain("Schedule: 40 runs (10 per dataset and contract), no replacement; 0 started.");
      expect(plan.text).toContain("Next run: 1 (t4-topics-v1, topic-discovery-v2, run 1).");
      expect(plan.text).toContain("registered total $14.00");
      const noKey = run(["--live", "--next-run-only", "--results", dir]);
      expect(noKey.status).toBe(1);
      expect(noKey.text).toMatch(/Missing .*nothing was sent/);
      expect(run(["--next-run-only", "--results", dir]).text).toContain("--next-run-only is only valid with --live");
      const check = run(["--check", "--results", dir]);
      expect(check.status).toBe(2);
      expect(check.text).toContain("Verdict: INCOMPLETE");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses to start once every scheduled run has been started, and evaluates saved runs offline", () => {
    const dir = mkdtempSync(join(tmpdir(), "reliability-"));
    try {
      for (const s of all()) writeFileSync(join(dir, s.file), JSON.stringify(s.run));
      const check = run(["--check", "--results", dir]);
      expect(check.status).toBe(0);
      expect(check.text).toContain("Verdict: PASS");
      const full = run(["--live", "--results", dir]);
      expect(full.status).toBe(1);
      expect(full.text).toContain("Every scheduled run has been started; no additional or replacement run is allowed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
