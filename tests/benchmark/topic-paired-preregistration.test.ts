import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { goldOf, loadTopicBenchmarkDataset, TOPIC_BENCHMARK_DATASETS } from "../../src/benchmark/topic-datasets";
import {
  buildPairedPlan,
  evaluateScheduledPairedExperiment,
  experimentBudget,
  nextScheduledPair,
  PAIRED_DISCOVERY_RETRY_POLICY,
  PAIRED_EXPERIMENTS,
  pairedExperimentFingerprint,
  pairedResultFileName,
  pairReservationFileName,
  pairReservationOf,
  runPairedConsolidationPair,
  validatePairedResult,
  type PairedConsolidationResult,
  type PairReservation,
  type ScheduledPairedExperiment,
} from "../../src/benchmark/topic-paired-consolidation";
import { realConsolidatedScenarioId, type RealConsolidatedResult } from "../../src/benchmark/topic-real-consolidated";
import { loadPrices, loadTopicProviderConfig } from "../../src/benchmark/topic-real";
import { TOPIC_CONSOLIDATION_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT_V4 } from "../../src/core/topics/consolidation-contract";
import { TOPIC_DISCOVERY_CONTRACT } from "../../src/core/topics/provider-contracts";

// PRE-REGISTRATION of the paired v3-vs-v4 consolidation experiment on the frozen t5 hold-out
// (docs/topic-consolidation-paired-t5-preregistration.md). Offline only: pairs come from a fake Anthropic SDK client
// and a fake Jev endpoint, keys are dummies and the global fetch is trapped. Metric values are set on copies of the
// fake pairs to probe each registered criterion at its exact boundary.

const ID = "paired-consolidation-v3-v4-t5-v1";
/** The registered definition's fingerprint. Changing the definition changes it, and pairs run under it are refused. */
const DEFINITION_FINGERPRINT = "sha256:697e2e73965540c5e2e47f4406ffc8c0007e9de6958c37105ee326d0aa0a0d51";
const T5_SHA256 = "cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3";
const DOC = "docs/topic-consolidation-paired-t5-preregistration.md";

const ROOT = join(__dirname, "..", "..");
const RESULTS = join(ROOT, "benchmark-results");
const dataset = loadTopicBenchmarkDataset("t5-topics-v1");
const gold = goldOf(dataset);
const config = loadTopicProviderConfig();
const prices = loadPrices();
const keys = { discoveryApiKey: "fake-anthropic-key-do-not-use-58", jevApiKey: "fake-jev-key-do-not-use-64" };
const V3 = TOPIC_CONSOLIDATION_CONTRACT;
const V4 = TOPIC_CONSOLIDATION_CONTRACT_V4;
const DEF = PAIRED_EXPERIMENTS[ID]!;

/** Every file in benchmark-results with its SHA-256, taken when this file loads (before any of its tests run). */
const resultsSnapshot = (): Record<string, string> =>
  existsSync(RESULTS)
    ? Object.fromEntries(
        readdirSync(RESULTS, { recursive: true })
          .map(String)
          .filter((f) => statSync(join(RESULTS, f)).isFile())
          .sort()
          .map((f) => [f, createHash("sha256").update(readFileSync(join(RESULTS, f))).digest("hex")]),
      )
    : {};
const RESULTS_AT_START = resultsSnapshot();

let trapped = 0;
beforeEach(() => {
  trapped = 0;
  vi.stubGlobal("fetch", async () => {
    trapped += 1;
    throw new Error("network access is not allowed in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Proposal = { key: string; name: string; definition: string; exampleCommentIds?: string[] };
const json = (topics: Proposal[]) => JSON.stringify({ topics });
const concepts = dataset.taxonomy.map((t) => t.key);
const candidates = (): Proposal[] => concepts.map((_, i) => ({ key: `theme_${i}`, name: `Theme number ${i}`, definition: `Synthetic theme number ${i}.`, exampleCommentIds: gold.members.get(concepts[i]!)!.slice(0, 2) }));
const LONG_NAME = json(candidates().map((t, i) => (i === 0 ? { ...t, name: "Theme number zero with far too many words" } : t)));
const isConsolidation = (params: Record<string, any>) => String(params.system).includes("topic-consolidation-");

function fakeAnthropic(discovery: string[], consolidation: string[] = [json(candidates())]) {
  const requests: Record<string, any>[] = [];
  const anthropicClient = {
    beta: {
      messages: {
        create: async (params: Record<string, any>) => {
          requests.push(structuredClone(params));
          const c = isConsolidation(params);
          const script = c ? consolidation : discovery;
          const reply = script[Math.min(requests.filter((r) => isConsolidation(r) === c).length - 1, script.length - 1)]!;
          return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 4_000, output_tokens: 1_000 } };
        },
      },
    },
  } as unknown as ReturnType<typeof createAnthropicClient>;
  return { anthropicClient, discoveryRequests: () => requests.filter((r) => !isConsolidation(r)), consolidationRequests: () => requests.filter(isConsolidation) };
}

function fakeJev() {
  const byText = new Map(dataset.comments.map((c) => [c.text, c.id]));
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

const stampFor = (n: number, def: ScheduledPairedExperiment = DEF) => ({ id: def.id, definitionFingerprint: pairedExperimentFingerprint(def), scheduledPair: n, datasetSha256: def.datasetSha256 });

async function experimentPair(n: number, discovery: string[] = [json(candidates())], consolidation?: string[]) {
  const anthropic = fakeAnthropic(discovery, consolidation);
  const result = await runPairedConsolidationPair(dataset, config, prices, keys, { anthropicClient: anthropic.anthropicClient, fetch: fakeJev(), pairIndex: n, baseline: V3, candidate: V4, experiment: stampFor(n) });
  return { result, anthropic };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const live = (r: RealConsolidatedResult) => r.report.scenarios.find((s) => s.id === realConsolidatedScenarioId("anthropic"))!.runs[0]!;

type Metrics = { precision: number; recall: number; merges: number; splits: number; primary: number; sentiment: number };
const GOOD_V3: Metrics = { precision: 0.8, recall: 0.95, merges: 1, splits: 0, primary: 0.9, sentiment: 0.85 };
const GOOD_V4: Metrics = { precision: 0.9, recall: 0.95, merges: 1, splits: 0, primary: 0.9, sentiment: 0.85 };

/** A copy of a pair with the evaluator's per-run metrics of each arm set (fingerprints and pairing stay valid). */
function withMetrics(pair: PairedConsolidationResult, v3: Metrics, v4: Metrics): PairedConsolidationResult {
  const p = clone(pair);
  for (const arm of p.arms) {
    const m = arm.contract === V3 ? v3 : v4;
    const run = live(arm.result);
    Object.assign(run.taxonomy!, { topicPrecision: m.precision, conceptRecall: m.recall, mergeErrors: m.merges, splitErrors: m.splits });
    Object.assign(run.assignment!, { primaryTopicAccuracy: m.primary, topicSentimentAccuracy: m.sentiment });
  }
  return p;
}

// Three scheduled pairs from the fakes (computed once): pair 1 and 3 run v3 first, pair 2 runs v4 first.
let shared: PairedConsolidationResult[] | undefined;
async function threePairs(): Promise<PairedConsolidationResult[]> {
  shared ??= [(await experimentPair(1)).result, (await experimentPair(2)).result, (await experimentPair(3)).result];
  return shared;
}
const files = (pairs: PairedConsolidationResult[]) => pairs.map((result) => ({ file: pairedResultFileName(result), result }));
const scored = async (v3: Metrics | Metrics[], v4: Metrics | Metrics[]) => {
  const ps = await threePairs();
  return evaluateScheduledPairedExperiment(DEF, files(ps.map((p, i) => withMetrics(p, Array.isArray(v3) ? v3[i]! : v3, Array.isArray(v4) ? v4[i]! : v4))), [], dataset);
};
const criterion = (e: { criteria: { criterion: string; passed: boolean; detail: string }[] }, n: number) => e.criteria.find((c) => c.criterion.startsWith(`${n}.`))!;

describe("registration", () => {
  it("registers exactly this experiment, frozen, on the frozen t5 file", () => {
    expect(Object.keys(PAIRED_EXPERIMENTS)).toEqual([ID]);
    expect(Object.isFrozen(DEF) && Object.isFrozen(DEF.criteria) && Object.isFrozen(DEF.budget)).toBe(true);
    expect(DEF).toMatchObject({ id: ID, design: "fixed-schedule", document: DOC, dataset: "t5-topics-v1", datasetSha256: T5_SHA256, datasetVersion: dataset.version, baseline: "topic-consolidation-v3", candidate: "topic-consolidation-v4" });
    expect(createHash("sha256").update(readFileSync(join(ROOT, TOPIC_BENCHMARK_DATASETS["t5-topics-v1"]))).digest("hex")).toBe(T5_SHA256);
  });

  it("fixes discovery and assignment to the configured, frozen path", () => {
    expect(DEF.discovery).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", contract: TOPIC_DISCOVERY_CONTRACT, retryPolicy: "paired-discovery-retry-v1", maxAttempts: 2 });
    expect(TOPIC_DISCOVERY_CONTRACT).toBe("topic-discovery-v2");
    expect(PAIRED_DISCOVERY_RETRY_POLICY).toMatchObject({ id: "paired-discovery-retry-v1", maxAttempts: 2 });
    expect(DEF.assignment).toEqual({ provider: "typesafe", model: "jev-latest", contract: "topic-assignment-v1", questionSet: "jev-topic-a1" });
    expect(config.discovery).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", contract: "topic-discovery-v2" });
    expect(config.assignment).toMatchObject({ model: "jev-latest", contract: "topic-assignment-v1", questionSet: "jev-topic-a1" });
  });

  it("schedules exactly 3 pairs with no replacement pairs", () => {
    expect(DEF.scheduledPairs).toBe(3);
    expect(DEF.replacementPairs).toBe(0);
  });

  it("fixes the eight success criteria exactly as registered", () => {
    expect(DEF.criteria).toEqual({
      minCandidateTopicPrecision: 0.88,
      minCandidateTopicRecall: 0.92,
      minTopicPrecisionGain: 0.05,
      maxTopicRecallDrop: 0.01,
      maxMergeErrorIncrease: 0,
      maxPrimaryTopicAccuracyDrop: 0.01,
      maxTopicSentimentAccuracyDrop: 0.01,
      noNewSplitWhereBaselineHasNone: true,
    });
  });

  it("cannot be altered silently: the definition fingerprint is pinned and recorded in the pre-registration document", () => {
    expect(pairedExperimentFingerprint(DEF)).toBe(DEFINITION_FINGERPRINT);
    const doc = readFileSync(join(ROOT, DOC), "utf8");
    for (const text of [ID, DEFINITION_FINGERPRINT, T5_SHA256, "3 pairs", "INCOMPLETE", "$5.25", "1.749553584", "5.248660752"]) expect(doc, text).toContain(text);
  });

  it("the only t5 files are the archived experiment: its 3 scheduled pairs and their 3 reservations, under this definition", () => {
    // The discovery-v3 reliability experiment (a separate registration) also archived t5 results; they are not pairs.
    const t5 = Object.keys(RESULTS_AT_START).filter((f) => f.includes("t5-topics-v1") && !f.includes("-discovery-reliability-"));
    const reservations = t5.filter((f) => f.endsWith("-reserved.json")).map((f) => JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as PairReservation);
    const pairs = t5.filter((f) => !f.endsWith("-reserved.json")).map((f) => JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as PairedConsolidationResult);
    expect(t5).toHaveLength(6);
    expect(reservations.map((r) => [r.experiment, r.definitionFingerprint, r.scheduledPair]).sort()).toEqual([1, 2, 3].map((n) => [ID, DEFINITION_FINGERPRINT, n]));
    expect(pairs.map((p) => [p.meta.experiment?.id, p.meta.experiment?.definitionFingerprint, p.meta.experiment?.scheduledPair]).sort()).toEqual([1, 2, 3].map((n) => [ID, DEFINITION_FINGERPRINT, n]));
    // The schedule is used up: no further (or replacement) pair can be reserved.
    expect(nextScheduledPair(DEF, pairs.map((result, i) => ({ file: String(i), result })), reservations.map((reservation, i) => ({ file: String(i), reservation })))).toBeNull();
  });
});

describe("budget and stop rule", () => {
  it("the registered budget is the exact conservative worst case of 3 pairs, rounded up to $5.25", () => {
    const one = buildPairedPlan(dataset, config, prices, {}, 1, [V3, V4]).maxCostUsd;
    const three = buildPairedPlan(dataset, config, prices, {}, 3, [V3, V4]).maxCostUsd;
    expect(DEF.budget).toEqual({ totalUsd: 5.25, worstCasePerPairUsd: one, worstCaseTotalUsd: three });
    expect(one).toBe(1.749553584);
    expect(three).toBeCloseTo(5.248660752, 9);
    expect(DEF.budget.totalUsd).toBeGreaterThanOrEqual(three);
  });

  it("a pair starts only within the registered per-pair worst case and the remaining budget", async () => {
    const worst = DEF.budget.worstCasePerPairUsd;
    expect(experimentBudget(DEF, [], [], worst).allowed).toBe(true);
    // Configuration or prices changed so that a pair could cost more than registered: refused.
    expect(experimentBudget(DEF, [], [], worst + 0.01)).toMatchObject({ allowed: false, reason: expect.stringContaining("above the registered") });
    // Two pairs that each cost the full worst case still leave room for the third (the budget covers 3 worst cases).
    const [p1, p2] = await threePairs();
    const costly = (p: PairedConsolidationResult, usd: number) => {
      const c = clone(p);
      c.totals = { discovery: { ...c.totals.discovery, estimatedCostUsd: usd }, arms: c.totals.arms.map((a) => ({ ...a, costUsd: 0 })) };
      return c;
    };
    expect(experimentBudget(DEF, files([costly(p1!, worst), costly(p2!, worst)]), [], worst).allowed).toBe(true);
    // Spending above the worst case leaves less than a pair's worst case: the next pair is refused.
    expect(experimentBudget(DEF, files([costly(p1!, 2), costly(p2!, 2)]), [], worst)).toMatchObject({ allowed: false, reason: expect.stringContaining("exceeds the remaining registered budget") });
    // An unpriced pair and an aborted reservation both count at the registered worst case.
    const unpriced = clone(p1!);
    unpriced.totals.arms[0]!.costUsd = undefined;
    expect(experimentBudget(DEF, files([unpriced]), [], worst).spentUsd).toBe(worst);
    const r = pairReservationOf(DEF, 2, "2026-10-07T00:00:00.000Z");
    expect(experimentBudget(DEF, [], [{ file: pairReservationFileName(r), reservation: r }], worst).spentUsd).toBe(worst);
  });
});

describe("fixed schedule: no replacement, no additional pairs", () => {
  const reservation = (n: number): { file: string; reservation: PairReservation } => {
    const r = pairReservationOf(DEF, n, `2026-10-07T00:00:0${n}.000Z`);
    return { file: pairReservationFileName(r), reservation: r };
  };

  it("numbers pairs 1, 2, 3 and then none; a reserved (even aborted) number is never run again", () => {
    expect(nextScheduledPair(DEF, [], [])).toBe(1);
    expect(nextScheduledPair(DEF, [], [reservation(1)])).toBe(2);
    expect(nextScheduledPair(DEF, [], [reservation(1), reservation(2), reservation(3)])).toBeNull();
    expect(reservation(2).file).toContain("-paired-experiment-paired-consolidation-v3-v4-t5-v1-pair-2-reserved");
  });

  it("a scheduled pair run twice (a replacement) or a fourth pair makes the experiment INVALID", async () => {
    const ps = await threePairs();
    const again = { ...clone(ps[1]!), meta: { ...clone(ps[1]!).meta, timestamp: "2099-01-01T00:00:00.000Z" } };
    expect(evaluateScheduledPairedExperiment(DEF, files([...ps, again]), [], dataset)).toMatchObject({ verdict: "INVALID", reasons: expect.arrayContaining([expect.stringMatching(/pair 2 was run more than once/)]) });
    const fourth = clone(ps[0]!);
    fourth.meta = { ...fourth.meta, pairIndex: 4, experiment: stampFor(4) };
    expect(evaluateScheduledPairedExperiment(DEF, files([...ps, fourth]), [], dataset).reasons.join()).toMatch(/outside 1 … 3 \(no additional pairs\)/);
  });

  it("pairs run under an altered definition are refused: the experiment cannot be changed after results exist", async () => {
    const ps = await threePairs();
    const altered: ScheduledPairedExperiment = { ...DEF, criteria: { ...DEF.criteria, minCandidateTopicPrecision: 0.8 } };
    const e = evaluateScheduledPairedExperiment(altered, files(ps), [], dataset);
    expect(e.verdict).toBe("INVALID");
    expect(e.reasons.join()).toMatch(/the definition was altered after pairs existed/);
    const r = pairReservationOf(DEF, 1, "2026-10-07T00:00:00.000Z");
    expect(evaluateScheduledPairedExperiment(altered, [], [{ file: "r.json", reservation: r }], dataset).verdict).toBe("INVALID");
  });

  it("ad-hoc pairs (no experiment stamp) are ignored", async () => {
    const ps = await threePairs();
    const adhoc = clone(ps[0]!);
    delete adhoc.meta.experiment;
    expect(evaluateScheduledPairedExperiment(DEF, files([adhoc]), [], dataset).pairs.map((p) => p.status)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("pair availability: unavailable pairs are INCOMPLETE, never zero, never replaced", () => {
  it("fewer than 3 pairs run: INCOMPLETE", async () => {
    const ps = await threePairs();
    const e = evaluateScheduledPairedExperiment(DEF, files(ps.slice(0, 2)), [], dataset);
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.pairs.map((p) => p.status)).toEqual(["available", "available", "pending"]);
    expect(e.criteria).toEqual([]);
  });

  it("a discovery-unavailable pair makes the experiment INCOMPLETE and is scored for neither arm (not as zero)", async () => {
    const ps = await threePairs();
    const { result: down, anthropic } = await experimentPair(2, [LONG_NAME]);
    expect(down.status).toBe("unavailable_discovery");
    expect(anthropic.discoveryRequests()).toHaveLength(2);
    expect(anthropic.consolidationRequests()).toHaveLength(0);
    const e = evaluateScheduledPairedExperiment(DEF, files([ps[0]!, down, ps[2]!]), [], dataset);
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.pairs.map((p) => p.status)).toEqual(["available", "unavailable_discovery", "available"]);
    expect(e.criteria).toEqual([]);
    for (const arm of e.arms) expect(arm.runs.map((r) => r.available)).toEqual([true, true]);
    expect(e.reasons.join()).toMatch(/2 of 3 scheduled pairs available[\s\S]*pair 2 unavailable_discovery[\s\S]*not scored for either arm, not replaced/);
    expect(nextScheduledPair(DEF, files([ps[0]!, down, ps[2]!]), [])).toBeNull();
  });

  it("an arm that fails after the shared discovery makes its pair unavailable (recorded), and the experiment INCOMPLETE", async () => {
    const ps = await threePairs();
    const { result: broken } = await experimentPair(3, [json(candidates())], ["not json"]);
    expect(broken.status).toBe("available");
    expect(broken.pairingValidation).toEqual({ valid: true, problems: [] });
    const e = evaluateScheduledPairedExperiment(DEF, files([ps[0]!, ps[1]!, broken]), [], dataset);
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.pairs[2]).toMatchObject({ status: "unavailable_arm", detail: expect.stringContaining("arm(s) failed after the shared discovery") });
    for (const arm of e.arms) expect(arm.runs).toHaveLength(2);
  });

  it("a reserved pair without a saved result is aborted: unavailable, INCOMPLETE", async () => {
    const ps = await threePairs();
    const r = pairReservationOf(DEF, 3, "2026-10-07T00:00:03.000Z");
    const e = evaluateScheduledPairedExperiment(DEF, files(ps.slice(0, 2)), [{ file: pairReservationFileName(r), reservation: r }], dataset);
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.pairs[2]).toMatchObject({ status: "aborted" });
  });
});

describe("PASS / FAIL exactly as registered", () => {
  it("all three pairs available and every criterion met: PASS; all eight criteria evaluated", async () => {
    const e = await scored(GOOD_V3, GOOD_V4);
    expect(e.verdict).toBe("PASS");
    expect(e.criteria).toHaveLength(8);
    expect(e.criteria.every((c) => c.passed)).toBe(true);
  });

  it("criteria 1 and 2: absolute floors for v4 precision (88%) and recall (92%)", async () => {
    expect(criterion(await scored({ ...GOOD_V3, precision: 0.83 }, { ...GOOD_V4, precision: 0.88 }), 1).passed).toBe(true);
    const low = await scored({ ...GOOD_V3, precision: 0.8 }, { ...GOOD_V4, precision: 0.8799 });
    expect([low.verdict, criterion(low, 1).passed]).toEqual(["FAIL", false]);
    expect(criterion(await scored({ ...GOOD_V3, recall: 0.92 }, { ...GOOD_V4, recall: 0.92 }), 2).passed).toBe(true);
    expect(criterion(await scored({ ...GOOD_V3, recall: 0.92 }, { ...GOOD_V4, recall: 0.9199 }), 2).passed).toBe(false);
  });

  it("criterion 3: v4 precision must be at least 5 percentage points above v3", async () => {
    expect(criterion(await scored({ ...GOOD_V3, precision: 0.85 }, { ...GOOD_V4, precision: 0.9 }), 3).passed).toBe(true);
    const short = await scored({ ...GOOD_V3, precision: 0.8501 }, { ...GOOD_V4, precision: 0.9 });
    expect([short.verdict, criterion(short, 3).passed]).toEqual(["FAIL", false]);
  });

  it("criteria 4, 6 and 7: at most 1 percentage point below v3 (recall, primary-topic and topic sentiment accuracy)", async () => {
    expect(criterion(await scored({ ...GOOD_V3, recall: 0.96 }, { ...GOOD_V4, recall: 0.95 }), 4).passed).toBe(true);
    expect(criterion(await scored({ ...GOOD_V3, recall: 0.9601 }, { ...GOOD_V4, recall: 0.95 }), 4).passed).toBe(false);
    expect(criterion(await scored({ ...GOOD_V3, primary: 0.91 }, { ...GOOD_V4, primary: 0.9 }), 6).passed).toBe(true);
    expect(criterion(await scored({ ...GOOD_V3, primary: 0.9101 }, { ...GOOD_V4, primary: 0.9 }), 6).passed).toBe(false);
    expect(criterion(await scored({ ...GOOD_V3, sentiment: 0.86 }, { ...GOOD_V4, sentiment: 0.85 }), 7).passed).toBe(true);
    const drop = await scored({ ...GOOD_V3, sentiment: 0.8601 }, { ...GOOD_V4, sentiment: 0.85 });
    expect([drop.verdict, criterion(drop, 7).passed]).toEqual(["FAIL", false]);
  });

  it("criterion 5: total v4 merge errors at most total v3 merge errors", async () => {
    expect(criterion(await scored({ ...GOOD_V3, merges: 1 }, { ...GOOD_V4, merges: 1 }), 5).passed).toBe(true);
    expect(criterion(await scored([GOOD_V3, GOOD_V3, GOOD_V3], [GOOD_V4, { ...GOOD_V4, merges: 2 }, GOOD_V4]), 5).passed).toBe(false);
  });

  it("criterion 8: no v4 split error in a pair whose v3 has none (pairwise, not pooled)", async () => {
    const newSplit = await scored([GOOD_V3, GOOD_V3, GOOD_V3], [GOOD_V4, { ...GOOD_V4, splits: 1 }, GOOD_V4]);
    expect([newSplit.verdict, criterion(newSplit, 8).passed, criterion(newSplit, 8).detail]).toEqual(["FAIL", false, "pair(s) 2"]);
    expect(criterion(await scored([GOOD_V3, { ...GOOD_V3, splits: 1 }, GOOD_V3], [GOOD_V4, { ...GOOD_V4, splits: 2 }, GOOD_V4]), 8).passed).toBe(true);
  });
});

describe("each pair records what reproduces it (offline fakes)", () => {
  it("experiment id, pair number, dataset SHA-256, fingerprints, prompts, settings, validation, metrics, cost and requests", async () => {
    const { result, anthropic } = await experimentPair(1);
    expect(trapped).toBe(0);
    expect(result.meta.experiment).toEqual({ id: ID, definitionFingerprint: DEFINITION_FINGERPRINT, scheduledPair: 1, datasetSha256: T5_SHA256 });
    expect(result.meta).toMatchObject({ pairIndex: 1, dataset: "t5-topics-v1", datasetVersion: dataset.version, armOrder: [V3, V4], discovery: { provider: "anthropic", model: "claude-sonnet-5-5", contract: "topic-discovery-v2" }, assignment: { modelRequested: "jev-latest", contract: "topic-assignment-v1", questionSet: "jev-topic-a1" } });
    expect(result.discovery).toMatchObject({ status: "valid", policy: { id: "paired-discovery-retry-v1" }, inputs: { promptFirst: expect.stringMatching(/^sha256:/), promptRetry: expect.stringMatching(/^sha256:/) } });
    expect(result.discovery!.attempts).toHaveLength(1);
    expect(result.discovery!.discoveryFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.pairingValidation).toEqual({ valid: true, problems: [] });
    expect(validatePairedResult(result, dataset)).toEqual([]);
    // The consolidation prompt fingerprints are those of the instructions each arm actually sent.
    const sent = anthropic.consolidationRequests().map((r) => `sha256:${createHash("sha256").update(String(r.system)).digest("hex")}`);
    expect(result.arms.map((a) => a.consolidationPrompt!.first)).toEqual(sent);
    for (const arm of result.arms) {
      expect(arm.consumedTaxonomyFingerprint).toBe(result.discovery!.taxonomyFingerprint);
      expect(arm.result.meta.consolidation.contract).toBe(arm.contract);
      expect(arm.result.totals.discovery.requests).toBe(0);
      expect(arm.result.totals.consolidation.requests).toBe(1);
      expect(arm.result.totals.assignment.requests).toBeGreaterThan(0);
      expect(live(arm.result)).toMatchObject({ status: "available", taxonomy: { topicPrecision: expect.any(Number) }, assignment: { topicSentimentAccuracy: expect.any(Number) } });
    }
    expect(result.totals.discovery).toMatchObject({ requests: 1, estimatedCostUsd: expect.any(Number) });
    expect(result.totals.arms.every((a) => typeof a.costUsd === "number")).toBe(true);
    const text = JSON.stringify(result);
    for (const k of Object.values(keys)) expect(text).not.toContain(k);
  });

  it("an experiment pair always runs with its scheduled number as the pair index", async () => {
    await expect(runPairedConsolidationPair(dataset, config, prices, keys, { pairIndex: 2, experiment: stampFor(1) })).rejects.toThrow(/scheduled pair number/);
  });
});

/**
 * Preloaded into a CLI child process for an offline rehearsal: the global fetch answers the Anthropic messages API and
 * the Jev endpoint from the t5 gold (one synthetic topic per gold concept) and logs every request; any other socket
 * connection ends the process at once, so nothing can leave it.
 */
const FAKE_PROVIDERS = `
import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";
const log = (what) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(what) + "\\n");
const ds = JSON.parse(readFileSync("fixtures/t5-topics-v1/comments.json", "utf8"));
const keys = ds.taxonomy.map((t) => t.key);
const membersOf = (k) => ds.comments.filter((c) => c.topic?.disposition === "primary_topic" && c.topic.topicKey === k).map((c) => c.id);
const topics = keys.map((k, i) => ({ key: "theme_" + i, name: "Theme number " + i, definition: "Synthetic theme number " + i + ".", exampleCommentIds: membersOf(k).slice(0, 2) }));
const byText = new Map(ds.comments.map((c) => [c.text, c]));
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.startsWith("https://api.anthropic.com/")) {
    const kind = JSON.stringify(body.system ?? "").includes("topic-consolidation-") ? "consolidation" : "discovery";
    log({ kind });
    return reply({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify({ topics }) }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 4000, output_tokens: 1000 } });
  }
  if (url.startsWith("https://api.typesafe.ai/")) {
    log({ kind: "jev" });
    const g = byText.get(body.state.comment).topic;
    const answers = "topic" in body.questions
      ? { topic: { type: "choice", choice: g.disposition === "primary_topic" ? "topic:theme_" + keys.indexOf(g.topicKey) : g.disposition } }
      : { topic_sentiment: { type: "choice", choice: g.disposition === "primary_topic" ? g.topicSentiment : "neutral" } };
    return reply({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 1 } });
  }
  log({ kind: "unexpected", url });
  process.exit(97);
};
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipc = typeof o === "string" ? Number.isNaN(Number(o)) : Boolean(o && typeof o === "object" && o.path !== undefined && o.host === undefined && o.port === undefined);
  if (!ipc) { log({ kind: "socket", host: String(o?.host ?? o) }); process.exit(97); }
  return original.apply(this, args);
};
`;

describe("CLI (no API call)", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const out = spawnSync(TSX, ["src/benchmark/paired-consolidation-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env }, encoding: "utf8" });
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("prints the registered plan: schedule, next pair and budget; nothing is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "prereg-"));
    try {
      const plan = run(["--dataset", "t5-topics-v1", "--experiment", ID, "--results", dir]);
      expect(plan.status).toBe(2);
      expect(plan.text).toContain("NO API CALLS MADE");
      expect(plan.text).toContain(DEFINITION_FINGERPRINT);
      expect(plan.text).toContain("Schedule: 3 pairs, no replacement. pair 1: pending; pair 2: pending; pair 3: pending.");
      expect(plan.text).toContain("Next pair: 1.");
      expect(plan.text).toContain("worst case $1.7496 within the remaining $5.2500 of $5.2500");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses anything the registration fixes, ad-hoc live pairs on t5, and a live run without keys", () => {
    for (const extra of [["--pairs", "2"], ["--max-cost-usd", "9"], ["--model", "claude-sonnet-5-5"], ["--candidate", "v3"]]) {
      expect(run(["--dataset", "t5-topics-v1", "--experiment", ID, ...extra]).text).toContain("cannot be combined with --experiment");
    }
    expect(run(["--dataset", "t4-topics-v1", "--experiment", ID]).text).toContain(`${ID} is registered on t5-topics-v1`);
    const adhoc = run(["--dataset", "t5-topics-v1", "--pairs", "1", "--live"]);
    expect(adhoc.status).toBe(1);
    expect(adhoc.text).toContain(`live pairs on it run only with --experiment ${ID}`);
    const dir = mkdtempSync(join(tmpdir(), "prereg-"));
    try {
      const noKeys = run(["--dataset", "t5-topics-v1", "--experiment", ID, "--live", "--results", dir]);
      expect(noKeys.status).toBe(1);
      expect(noKeys.text).toMatch(/Missing .*nothing was sent/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("--next-pair-only runs exactly the next scheduled pair (full offline rehearsal of the live command, fake providers)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prereg-"));
    const preload = join(dir, "fake-providers.mjs");
    writeFileSync(preload, FAKE_PROVIDERS);
    const results = join(dir, "results");
    const fakeLog = join(dir, "calls.log");
    const env = { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, FAKE_LOG: fakeLog, ANTHROPIC_API_KEY: keys.discoveryApiKey, JEV_API_KEY: keys.jevApiKey };
    const calls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind) : []);
    try {
      const first = run(["--dataset", "t5-topics-v1", "--experiment", ID, "--live", "--next-pair-only", "--results", results], env);
      expect(first.status, first.text).toBe(0);
      expect(first.text).toContain("This run: pair 1 only (--next-pair-only).");
      expect(first.text).toContain(`LIVE PRE-REGISTERED PAIR 1 of 3 (${ID})`);
      expect(first.text).not.toContain("PAIR 2 of 3");
      const saved = readdirSync(results).sort();
      expect(saved.map((f) => f.replace(/^.*-pair-/, "pair-"))).toEqual(["pair-1-reserved.json", "pair-1.json"]);
      const pair = JSON.parse(readFileSync(join(results, saved.find((f) => f.endsWith("-pair-1.json"))!), "utf8")) as PairedConsolidationResult;
      expect(pair.meta.experiment).toEqual({ id: ID, definitionFingerprint: DEFINITION_FINGERPRINT, scheduledPair: 1, datasetSha256: T5_SHA256 });
      expect(pair).toMatchObject({ status: "available", pairingValidation: { valid: true, problems: [] } });
      // One shared discovery, one consolidation per arm, then Jev; nothing else.
      const kinds = calls();
      expect(kinds.filter((k) => k === "discovery")).toHaveLength(1);
      expect(kinds.filter((k) => k === "consolidation")).toHaveLength(2);
      expect(kinds.filter((k) => k !== "discovery" && k !== "consolidation" && k !== "jev")).toEqual([]);
      for (const k of Object.values(keys)) expect(JSON.stringify(pair)).not.toContain(k);
      // The evaluation sees pair 1 available and pairs 2 and 3 not run; the next invocation would run pair 2 only.
      const check = run(["--dataset", "t5-topics-v1", "--check", "--experiment", ID, "--results", results]);
      expect(check.text).toContain("Verdict: INCOMPLETE");
      expect(check.text).toMatch(/\| 1 \| available \|[\s\S]*\| 2 \| pending \|[\s\S]*\| 3 \| pending \|/);
      expect(run(["--dataset", "t5-topics-v1", "--experiment", ID, "--next-pair-only", "--results", results]).text).toContain("This run: pair 2 only (--next-pair-only).");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("--next-pair-only exists only in experiment mode", () => {
    expect(run(["--dataset", "t4-topics-v1", "--pairs", "1", "--next-pair-only"]).text).toContain("--next-pair-only is only valid with --experiment");
    expect(run(["--dataset", "t5-topics-v1", "--check", "--experiment", ID, "--next-pair-only"]).text).toContain("--next-pair-only is only valid with --experiment");
  });

  it("refuses to start once every scheduled pair has been started, and evaluates saved pairs offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prereg-"));
    try {
      for (const n of [1, 2, 3]) {
        const r = pairReservationOf(DEF, n, `2026-10-07T00:00:0${n}.000Z`);
        writeFileSync(join(dir, pairReservationFileName(r)), JSON.stringify(r));
      }
      const full = run(["--dataset", "t5-topics-v1", "--experiment", ID, "--live", "--results", dir]);
      expect(full.status).toBe(1);
      expect(full.text).toContain("Every scheduled pair has been started; no additional or replacement pair is allowed");
      const check = run(["--dataset", "t5-topics-v1", "--check", "--experiment", ID, "--results", dir]);
      expect(check.status).toBe(2);
      expect(check.text).toContain("Verdict: INCOMPLETE");
      expect(check.text).toContain("| 1 | aborted |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("this test file leaves benchmark-results untouched", () => {
  it("no result or reservation was added, removed or changed by any test above", () => {
    expect(resultsSnapshot()).toEqual(RESULTS_AT_START);
  });
});
