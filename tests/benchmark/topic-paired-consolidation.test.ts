import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { MAX_TOPIC_ATTEMPTS } from "../../src/application/analyze-topics";
import { evaluateConsolidationExperiment } from "../../src/benchmark/topic-consolidation-experiment";
import { goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import {
  discoveryInputFingerprints,
  evaluatePairedExperiment,
  FrozenDiscoveryGenerator,
  PAIRED_DISCOVERY_RETRY_POLICY,
  PAIRED_EXPERIMENTS,
  pairedResultFileName,
  PairedDiscoveryMismatchError,
  renderPairedResultMarkdown,
  runPairedConsolidationPair,
  validatePairedResult,
  type PairedConsolidationResult,
  type PairedExperimentDefinition,
} from "../../src/benchmark/topic-paired-consolidation";
import { realConsolidatedScenarioId, runRealConsolidatedBenchmark, type RealConsolidatedResult } from "../../src/benchmark/topic-real-consolidated";
import { loadPrices, loadTopicProviderConfig } from "../../src/benchmark/topic-real";
import { discoveryRequestOf } from "../../src/benchmark/topic-discovery-only";
import { buildTopicConsolidationInstructions, TOPIC_CONSOLIDATION_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT_V4 } from "../../src/core/topics/consolidation-contract";

// EXPERIMENTAL paired consolidation mode, offline: discovery and consolidation answer from a fake Anthropic SDK client,
// Jev from a fake endpoint answering with gold dispositions; keys are dummies and the global fetch is trapped. The t1
// dataset is used through IDs only; topic names are synthetic.

const ROOT = join(__dirname, "..", "..");
const RESULTS = join(ROOT, "benchmark-results");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const config = loadTopicProviderConfig();
const prices = loadPrices();
const FAKE_ANTHROPIC = "fake-anthropic-key-do-not-use-77";
const FAKE_JEV = "fake-jev-key-do-not-use-31";
const keys = { discoveryApiKey: FAKE_ANTHROPIC, jevApiKey: FAKE_JEV };
const V3 = TOPIC_CONSOLIDATION_CONTRACT;
const V4 = TOPIC_CONSOLIDATION_CONTRACT_V4;

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
const membersOf = (i: number) => gold.members.get(concepts[i]!)!;
const otherIds = gold.baseIds.filter((id) => gold.dispositions.get(id)!.disposition === "other");

/** Discovery's answer: one synthetic topic per concept plus a peripheral topic. */
const candidates = (): Proposal[] =>
  concepts.map((_, i) => ({ key: `theme_${i}`, name: `Theme number ${i}`, definition: `Synthetic theme number ${i}.`, exampleCommentIds: membersOf(i).slice(0, 2) })).concat([{ key: "side_theme", name: "Side theme", definition: "A small side discussion.", exampleCommentIds: otherIds.slice(0, 2) }]);
/** Consolidation's answer: the peripheral topic dropped. */
const compact = (): Proposal[] => candidates().slice(0, -1);
/** A rejected discovery answer: one name longer than five words (invalid_topic_name). */
const LONG_NAME = json(candidates().map((t, i) => (i === 0 ? { ...t, name: "Theme number zero with far too many words" } : t)));
const isConsolidation = (params: Record<string, any>) => String(params.system).includes("topic-consolidation-");

/** Fake Anthropic SDK client answering discovery and consolidation from scripts (numbers are HTTP errors). */
function fakeAnthropic(discovery: (string | number)[], consolidation: (string | number)[] = [json(compact())]) {
  const requests: Record<string, any>[] = [];
  const anthropicClient = {
    beta: {
      messages: {
        create: async (params: Record<string, any>) => {
          requests.push(structuredClone(params));
          const c = isConsolidation(params);
          const script = c ? consolidation : discovery;
          const n = requests.filter((r) => isConsolidation(r) === c).length - 1;
          const reply = script[Math.min(n, script.length - 1)]!;
          if (typeof reply === "number") {
            const { default: Anthropic } = await import("@anthropic-ai/sdk");
            throw Anthropic.APIError.generate(reply, { type: "error", error: { type: "x", message: "provider text" } }, "provider text", new Headers());
          }
          return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 4_000, output_tokens: 1_000 } };
        },
      },
    },
  } as unknown as ReturnType<typeof createAnthropicClient>;
  return {
    anthropicClient,
    requests,
    discoveryRequests: () => requests.filter((r) => !isConsolidation(r)),
    consolidationRequests: () => requests.filter(isConsolidation),
  };
}

/** Fake Jev endpoint answering with gold dispositions (topic keys theme_<i>). */
function fakeJev() {
  const byText = new Map(dataset.comments.map((c) => [c.text, c.id]));
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls += 1;
    const body = JSON.parse(init.body as string) as { state: { comment: string }; questions: Record<string, unknown> };
    const g = gold.dispositions.get(byText.get(body.state.comment)!)!;
    const answers =
      "topic" in body.questions
        ? { topic: { type: "choice", choice: g.disposition === "primary_topic" ? `topic:theme_${concepts.indexOf(g.topicKey)}` : g.disposition } }
        : { topic_sentiment: { type: "choice", choice: g.disposition === "primary_topic" ? g.topicSentiment : "neutral" } };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

async function pair(discovery: (string | number)[], options: { consolidation?: (string | number)[]; pairIndex?: number } = {}) {
  const anthropic = fakeAnthropic(discovery, options.consolidation);
  const jev = fakeJev();
  const result = await runPairedConsolidationPair(dataset, config, prices, keys, { anthropicClient: anthropic.anthropicClient, fetch: jev.fetch, pairIndex: options.pairIndex ?? 1 });
  return { result, anthropic, jev };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const live = (r: RealConsolidatedResult) => r.report.scenarios.find((s) => s.id === realConsolidatedScenarioId("anthropic"))!.runs[0]!;

// One valid pair, shared by the validation tests (computed once).
let validPair: Awaited<ReturnType<typeof pair>> | undefined;
async function sharedValidPair() {
  validPair ??= await pair([json(candidates())]);
  return validPair;
}

describe("paired mode: one discovery, the same validated taxonomy for both contracts", () => {
  it("runs discovery once and both arms consume that exact taxonomy; only consolidation differs", async () => {
    const { result, anthropic, jev } = await sharedValidPair();
    expect(trapped).toBe(0);
    expect(result.status).toBe("available");
    expect(anthropic.discoveryRequests()).toHaveLength(1);
    expect(result.discovery!.attempts).toHaveLength(1);
    expect(result.discovery!.discoveryFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Both arms, one per contract, each consumed the pair's taxonomy and made no discovery request of its own.
    expect(result.arms.map((a) => a.contract)).toEqual([V3, V4]); // pair 1: baseline first
    for (const arm of result.arms) {
      expect(arm.consumedTaxonomyFingerprint).toBe(result.discovery!.taxonomyFingerprint);
      expect(arm.frozenDiscoveryCalls).toBe(1);
      expect(arm.result.totals.discovery.requests).toBe(0);
      expect(arm.result.meta.consolidation.contract).toBe(arm.contract);
      expect(live(arm.result)).toMatchObject({ status: "available", attempts: 1 });
    }

    // The two consolidation requests carry the same candidate data; only the contract (system prompt) differs.
    const [c3, c4] = anthropic.consolidationRequests();
    expect(String(c3!.system)).toContain(V3);
    expect(String(c4!.system)).toContain(V4);
    expect(c3!.messages).toEqual(c4!.messages);
    expect(c3!.system).toEqual(buildTopicConsolidationInstructions({ maxTopics: candidates().length, retry: false }));
    expect(c4!.system).toEqual(buildTopicConsolidationInstructions({ maxTopics: candidates().length, retry: false, contract: V4 }));

    // Identical assignment and evaluation path: both arms sent the same Jev requests and score identically here.
    expect(jev.calls() % 2).toBe(0);
    expect(live(result.arms[0]!.result).assignment).toEqual(live(result.arms[1]!.result).assignment);
    expect(validatePairedResult(result, dataset)).toEqual([]);
  });

  it("a frozen arm reproduces the normal real-consolidated run when given the same discovery output", async () => {
    const { result } = await sharedValidPair();
    const anthropic = fakeAnthropic([json(candidates())]);
    const normal = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, { anthropicClient: anthropic.anthropicClient, fetch: fakeJev().fetch });
    const arm = result.arms.find((a) => a.contract === V3)!.result;
    // Only the discovery generator's label differs (it names the frozen discovery); everything else is identical.
    const frozenLabel = `frozen paired discovery (${result.discovery!.discoveryFingerprint})`;
    const normalLabel = `${config.discovery.provider === "anthropic" ? "Anthropic" : ""} ${config.discovery.model} (topic-discovery-v2)`.trim();
    const relabel = <T>(x: T): T => JSON.parse(JSON.stringify(x).split(frozenLabel).join(normalLabel)) as T;
    expect(JSON.stringify(arm.report)).toContain(frozenLabel);
    expect(relabel(arm.report)).toEqual(normal.report);
    const noLatency = <T>(x: T): T => JSON.parse(JSON.stringify(x, (k, v: unknown) => (k === "latencyMs" ? 0 : v))) as T;
    expect(noLatency(arm.phases)).toEqual(noLatency(normal.phases));
    expect(arm.instrumentation).toEqual(normal.instrumentation);
  });

  it("alternates the arm order by pair index", async () => {
    const { result } = await pair([json(candidates())], { pairIndex: 2 });
    expect(result.meta.armOrder).toEqual([V4, V3]);
    expect(result.arms.map((a) => [a.contract, a.order])).toEqual([[V4, 1], [V3, 2]]);
    expect(validatePairedResult(result, dataset)).toEqual([]);
  });

  it("the frozen discovery generator refuses any other sample and never serves an unavailable discovery", async () => {
    const { result } = await sharedValidPair();
    const frozen = new FrozenDiscoveryGenerator(result.discovery!);
    const { request } = discoveryRequestOf(dataset);
    await expect(frozen.proposeTaxonomy(request)).resolves.toMatchObject({ topics: expect.any(Array) });
    await expect(frozen.proposeTaxonomy({ ...request, sample: request.sample.slice(1) })).rejects.toBeInstanceOf(PairedDiscoveryMismatchError);
    expect(() => new FrozenDiscoveryGenerator({ ...result.discovery!, status: "unavailable", taxonomy: null })).toThrow(PairedDiscoveryMismatchError);
  });
});

describe("strict pairing validation", () => {
  it("requires the identical discovery fingerprint in both arms and rejects any mismatch", async () => {
    const { result } = await sharedValidPair();
    const tamper = (f: (p: PairedConsolidationResult) => void) => {
      const p = clone(result);
      f(p);
      return validatePairedResult(p, dataset);
    };
    // An arm that consumed a different discovery taxonomy.
    expect(tamper((p) => (p.arms[1]!.result.instrumentation!.repeats[0]!.taxonomyCalls[0]!.candidate!.topics[0]!.name = "Another name")).join()).toMatch(/did not consume the pair's discovery taxonomy/);
    // A stored taxonomy that no longer matches its fingerprint.
    expect(tamper((p) => (p.discovery!.taxonomy![0]!.definition = "changed")).join()).toMatch(/does not match its fingerprint/);
    // A discovery fingerprint that does not match its inputs.
    expect(tamper((p) => (p.discovery!.discoveryFingerprint = "sha256:other")).join()).toMatch(/discovery fingerprint does not match/);
    // Mismatched dataset, sample or discovery prompt.
    expect(tamper((p) => (p.discovery!.inputs.prompt = "sha256:other-prompt")).join()).toMatch(/discovery prompt fingerprint differs/);
    expect(tamper((p) => (p.discovery!.inputs.sample = "sha256:other-sample")).join()).toMatch(/sample fingerprint/);
    expect(tamper((p) => (p.meta.datasetVersion = "sha256:old")).join()).toMatch(/pair belongs to/);
    // Discovery settings, assignment settings, evaluator settings.
    expect(tamper((p) => ((p.arms[0]!.result.meta.discovery as { effort: string }).effort = "low")).join()).toMatch(/discovery settings differ/);
    expect(tamper((p) => (p.arms[1]!.result.meta.assignment.maxCommentsPerBatch = 10)).join()).toMatch(/assignment model or settings differ/);
    expect(tamper((p) => (p.arms[1]!.result.report.meta.matching = "another rule")).join()).toMatch(/differ in more than the consolidation contract/);
    // An arm that ran discovery itself, or two arms of the same contract.
    expect(tamper((p) => (p.arms[0]!.result.totals.discovery.requests = 1)).join()).toMatch(/must not run discovery/);
    expect(tamper((p) => (p.arms[1]!.contract = p.arms[0]!.contract)).join()).toMatch(/exactly one arm per contract/);
    // Another retry policy.
    expect(tamper((p) => ((p.discovery!.policy as { id: string }).id = "paired-discovery-retry-v0")).join()).toMatch(/another retry policy/);
  });

  it("the experiment evaluation refuses (INVALID) any pair that fails validation", async () => {
    const { result } = await sharedValidPair();
    const bad = clone(result);
    bad.arms[1]!.consumedTaxonomyFingerprint = "sha256:other";
    const e = evaluatePairedExperiment(DEF, [{ file: "a.json", result }, { file: "b.json", result: bad }], dataset);
    expect(e.verdict).toBe("INVALID");
    expect(e.reasons.join()).toMatch(/b\.json: arm .* did not consume/);
  });
});

describe("fixed discovery retry policy and unavailable pairs", () => {
  it("is the production rule: at most two attempts with structured feedback", () => {
    expect(PAIRED_DISCOVERY_RETRY_POLICY).toMatchObject({ id: "paired-discovery-retry-v1", maxAttempts: 2 });
    expect(PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts).toBe(MAX_TOPIC_ATTEMPTS);
    expect(Object.isFrozen(PAIRED_DISCOVERY_RETRY_POLICY)).toBe(true);
  });

  it("retries an invalid discovery once with feedback, then forms the pair from the accepted taxonomy", async () => {
    const { result, anthropic } = await pair([LONG_NAME, json(candidates())]);
    const inputs = discoveryInputFingerprints(dataset);
    expect(result.status).toBe("available");
    expect(anthropic.discoveryRequests()).toHaveLength(2);
    const [first, second] = result.discovery!.attempts;
    expect(first).toMatchObject({ attempt: 1, outcome: "invalid_taxonomy", issueCodes: ["invalid_topic_name"], feedbackSent: false, promptFingerprint: inputs.promptFirst, taxonomyFingerprint: null });
    expect(second).toMatchObject({ attempt: 2, outcome: "valid", feedbackSent: true, promptFingerprint: inputs.promptRetry, rawOutput: null, taxonomyFingerprint: result.discovery!.taxonomyFingerprint });
    for (const a of result.discovery!.attempts) expect(a).toMatchObject({ provider: "anthropic", model: config.discovery.model, datasetFingerprint: inputs.dataset, sampleFingerprint: inputs.sample });
    for (const arm of result.arms) expect(arm.consumedTaxonomyFingerprint).toBe(result.discovery!.taxonomyFingerprint);
    expect(validatePairedResult(result, dataset)).toEqual([]);
  });

  it("exhausted retries make the WHOLE pair unavailable: no arm, no consolidation, no Jev call", async () => {
    const { result, anthropic, jev } = await pair([LONG_NAME]);
    expect(result.status).toBe("unavailable_discovery");
    expect(result.discovery!.attempts.map((a) => a.outcome)).toEqual(["invalid_taxonomy", "invalid_taxonomy"]);
    expect(result.arms).toEqual([]);
    expect(anthropic.discoveryRequests()).toHaveLength(PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts);
    expect(anthropic.consolidationRequests()).toHaveLength(0);
    expect(jev.calls()).toBe(0);
    expect(result.discovery!.discoveryFingerprint).toBeNull();
    expect(validatePairedResult(result, dataset)).toEqual([]);
    const md = renderPairedResultMarkdown(result);
    expect(md).toContain("Status: unavailable_discovery");
    expect(md).toContain("raw rejected output kept");
  });

  it("an unavailable pair is never scored for either arm; too many end the comparison without a verdict", async () => {
    const { result: ok } = await sharedValidPair();
    const { result: down } = await pair([LONG_NAME]);
    const at = (r: PairedConsolidationResult, t: string) => ({ ...clone(r), meta: { ...clone(r).meta, timestamp: t } });
    const pairs = [
      { file: "1.json", result: at(down, "2026-01-01T00:00:01Z") },
      { file: "2.json", result: at(ok, "2026-01-01T00:00:02Z") },
      { file: "3.json", result: at(ok, "2026-01-01T00:00:03Z") },
    ];
    const e = evaluatePairedExperiment({ ...DEF, pairsRequired: 2, maxUnavailablePairs: 1 }, pairs, dataset);
    expect(e.verdict).toBe("PASS");
    expect(e.unavailablePairs).toEqual(["1.json"]);
    expect(e.selectedPairs).toEqual(["2.json", "3.json"]);
    // Both arms have exactly the two available pairs; nothing was scored 0 for the unavailable one.
    for (const arm of e.arms) expect(arm.runs.map((r) => r.available)).toEqual([true, true]);
    expect(e.pairedDeltas.topicPrecision).toBe(0);

    expect(evaluatePairedExperiment({ ...DEF, pairsRequired: 2, maxUnavailablePairs: 0 }, pairs, dataset).verdict).toBe("DISCOVERY_UNRELIABLE");
    expect(evaluatePairedExperiment({ ...DEF, pairsRequired: 3, maxUnavailablePairs: 1 }, pairs, dataset).verdict).toBe("INCOMPLETE");
    // Selection is the first available pairs by timestamp, never re-selected.
    const later = evaluatePairedExperiment({ ...DEF, pairsRequired: 1, maxUnavailablePairs: 1 }, pairs, dataset);
    expect(later.selectedPairs).toEqual(["2.json"]);
  });

  it("an arm that fails after the shared discovery is a treatment outcome and is scored as unavailable", async () => {
    const { result } = await pair([json(candidates())], { consolidation: ["not json"] });
    expect(result.status).toBe("available");
    const states = result.arms.map((a) => live(a.result).status);
    expect(states).toEqual(["unavailable", "unavailable"]);
    expect(validatePairedResult(result, dataset)).toEqual([]);
    const e = evaluatePairedExperiment({ ...DEF, pairsRequired: 1 }, [{ file: "x.json", result }], dataset);
    expect(e.verdict).toBe("FAIL");
    expect(e.arms[1]!.runs[0]).toMatchObject({ available: false, topicPrecision: 0 });
  });
});

describe("raw rejected discovery output is retained in the diagnostics", () => {
  it("keeps the exact rejected text of invalid taxonomies and unparseable output; none for accepted or failed requests", async () => {
    const garbage = "Here are the topics: [not valid json";
    const { result } = await pair([LONG_NAME, garbage]);
    const [first, second] = result.discovery!.attempts;
    expect(first).toMatchObject({ outcome: "invalid_taxonomy", rawOutput: LONG_NAME, rawOutputChars: LONG_NAME.length, rawOutputTruncated: false });
    expect(second).toMatchObject({ outcome: "invalid_taxonomy", issueCodes: ["invalid_output"], rawOutput: garbage });

    const http = await pair([500, json(candidates())]);
    expect(http.result.discovery!.attempts[0]).toMatchObject({ outcome: "provider_error", rawOutput: null, rawOutputChars: null });
    expect(http.result.status).toBe("available");
  });

  it("never stores a secret, even if the model output contained one", async () => {
    const leaked = JSON.stringify({ topics: [{ key: "k", name: `echo ${FAKE_ANTHROPIC} ${FAKE_JEV} and more words`, definition: "d" }] });
    const { result } = await pair([leaked]);
    const text = JSON.stringify(result);
    expect(result.discovery!.attempts[0]!.rawOutput).toContain("[REDACTED]");
    expect(text).not.toContain(FAKE_ANTHROPIC);
    expect(text).not.toContain(FAKE_JEV);
  });
});

describe("frozen contracts and historical results", () => {
  /** SHA-256 of the frozen v3 instructions (recorded before v4 existed) and of v4 as used in the v4 experiment. */
  const V3_FINGERPRINTS: Record<string, string> = {
    "3:false": "55b41ddb31647f59c2dd968ab6ed5d96484a1c8f4a6e9ec185d749fa6a864056",
    "3:true": "e74b1d158a6ed45a3e1cef17d2905e60971ff3e3769578b1e2661e3c8e8f9f93",
    "8:false": "e8cca57e97fc3b4bfae7e764be1e20abe2ecdc990ff8f368c37759ad31e3c8ca",
    "8:true": "5bb1126a9447924fc9550cd23f8f02aeec3b380722a2bc964cdcd2090d5552b0",
    "12:false": "cc6956d20176f69e35e72ff5580b620bccf728510c548b69ee98a1e3eb7f19ea",
    "12:true": "50e5cf59939489f26a427c2775aefea1a14ddabb1fc0005d847d20a448c1c14e",
  };
  const V4_FINGERPRINTS: Record<string, string> = {
    "3:false": "8a1f3640582c6a22e097ed780789f91bec0ecc122e91b030e8b287972114e514",
    "3:true": "59b8a07c49e474a971761507841b676cbfa8824cc9054faf2f74f9a26e75a1a0",
    "8:false": "29015a9671a48d26c3e1a204cc21409f02356ec15370503982d76b45cc2820d9",
    "8:true": "54cfef5929829feca227c3db5148a262cdc822708b0dad85a7be2337c2a6781d",
    "12:false": "7932f8bf5c7c267acec17ebbc6babd307df02bc0a55bb4ec113e2b6250feb14c",
    "12:true": "8e49476cc9c7a9ab6f6c5a4dacc964a3bcd0d5ecbc8e525cc7667f239ae2ae06",
  };

  it("v3 stays byte-identical and the default", () => {
    expect(TOPIC_CONSOLIDATION_CONTRACT).toBe("topic-consolidation-v3");
    for (const [k, h] of Object.entries(V3_FINGERPRINTS)) {
      const [m, retry] = k.split(":");
      expect(sha(buildTopicConsolidationInstructions({ maxTopics: Number(m), retry: retry === "true" })), k).toBe(h);
    }
  });

  it("v4 is exactly the rule used in the v4 experiment", () => {
    for (const [k, h] of Object.entries(V4_FINGERPRINTS)) {
      const [m, retry] = k.split(":");
      expect(sha(buildTopicConsolidationInstructions({ maxTopics: Number(m), retry: retry === "true", contract: V4 })), k).toBe(h);
    }
  });

  it("the topic-discovery-v2 prompt is unchanged (pinned) and identical for every dataset", () => {
    for (const id of ["t1-topics-v1", "t4-topics-v1"] as const) {
      const f = discoveryInputFingerprints(loadTopicBenchmarkDataset(id));
      expect(f.promptFirst).toBe("sha256:7f01e2f9fdf31f5659f0f01823746f42c05d66d964caf251e45ed93e3f685af1");
      expect(f.promptRetry).toBe("sha256:3b4a0ffb463ac0921327b1d92def71ec8a745626c5008e19c6bd353aff75002a");
    }
  });

  it("exactly one paired experiment is pre-registered (the t5 v3-vs-v4 experiment; see topic-paired-preregistration.test.ts)", () => {
    expect(Object.keys(PAIRED_EXPERIMENTS)).toEqual(["paired-consolidation-v3-v4-t5-v1"]);
    expect(Object.isFrozen(PAIRED_EXPERIMENTS)).toBe(true);
  });

  it("pair files never collide with, and are ignored by, the existing real-consolidated evaluation", async () => {
    const { result } = await sharedValidPair();
    const name = pairedResultFileName(result);
    expect(name).toContain("-t1-topics-v1-paired-consolidation-");
    expect(name).not.toContain("-real-consolidated-");
    const e = evaluateConsolidationExperiment("t1-topics-v1", dataset.version, [{ file: name, result: result as unknown as RealConsolidatedResult }]);
    expect(e.verdict).toBe("INCOMPLETE");
    expect(e.arms.every((a) => a.runs.length === 0)).toBe(true);
  });

  it("running the paired mode and its CLI leaves every historical benchmark result byte-for-byte untouched", async () => {
    const snapshot = () =>
      existsSync(RESULTS)
        ? Object.fromEntries(
            readdirSync(RESULTS, { recursive: true })
              .map(String)
              .filter((f) => statSync(join(RESULTS, f)).isFile())
              .sort()
              .map((f) => [f, sha(readFileSync(join(RESULTS, f)))]),
          )
        : {};
    const before = snapshot();
    await pair([LONG_NAME, json(candidates())]);
    const TSX = join(ROOT, "node_modules", ".bin", "tsx");
    const cli = (args: string[]) => spawnSync(TSX, ["src/benchmark/paired-consolidation-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(cli(["--dataset", "t4-topics-v1"]).status).toBe(2);
    expect(cli(["--dataset", "t4-topics-v1", "--check"]).status).toBe(0);
    expect(snapshot()).toEqual(before);
  });
});

describe("paired CLI (no API call)", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const run = (args: string[]) => {
    const out = spawnSync(TSX, ["src/benchmark/paired-consolidation-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("prints the plan and refuses to start without --live; refuses --live without keys", () => {
    const plan = run(["--dataset", "t4-topics-v1", "--pairs", "3"]);
    expect(plan.status).toBe(2);
    expect(plan.text).toContain("NO API CALLS MADE");
    expect(plan.text).toContain("topic-consolidation-v3 (baseline) vs topic-consolidation-v4 (candidate)");
    expect(plan.text).toContain("paired-discovery-retry-v1");
    expect(plan.text).toContain("Run NOT started");
    const noKeys = run(["--dataset", "t4-topics-v1", "--pairs", "1", "--live"]);
    expect(noKeys.status).toBe(1);
    expect(noKeys.text).toMatch(/Missing .*nothing was sent/);
  });

  it("validates saved pairs offline and refuses an experiment that is not pre-registered", async () => {
    const { result } = await sharedValidPair();
    const dir = mkdtempSync(join(tmpdir(), "paired-"));
    try {
      writeFileSync(join(dir, pairedResultFileName(result)), JSON.stringify(result));
      const ok = run(["--dataset", "t1-topics-v1", "--check", "--results", dir]);
      expect(ok.status).toBe(0);
      expect(ok.text).toContain("NO API CALLS MADE");
      expect(ok.text).toMatch(/: available; valid/);
      const bad = clone(result);
      bad.arms[0]!.result.totals.discovery.requests = 2;
      writeFileSync(join(dir, pairedResultFileName({ ...bad, meta: { ...bad.meta, pairIndex: 9 } })), JSON.stringify(bad));
      expect(run(["--dataset", "t1-topics-v1", "--check", "--results", dir]).status).toBe(1);
      const unregistered = run(["--dataset", "t1-topics-v1", "--check", "--experiment", "t5-something", "--results", dir]);
      expect(unregistered.status).toBe(1);
      expect(unregistered.text).toContain('No pre-registered paired experiment "t5-something"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects equal or unknown contracts", () => {
    expect(run(["--dataset", "t4-topics-v1", "--baseline", "v4"]).text).toContain("must differ");
    expect(run(["--dataset", "t4-topics-v1", "--candidate", "v9"]).text).toContain('Unknown --candidate "v9"');
  });
});

/** A test-only definition for the generic first-available evaluator (not a registered experiment). */
const DEF: PairedExperimentDefinition = {
  id: "test-only",
  dataset: "t1-topics-v1",
  datasetVersion: dataset.version,
  baseline: V3,
  candidate: V4,
  pairsRequired: 1,
  maxUnavailablePairs: 1,
  criteria: { minTopicPrecision: 0.88, minConceptRecall: 0.92, maxNewMergeErrors: 0, noRegression: ["topicSentimentAccuracy", "primaryTopicAccuracy"] },
};
