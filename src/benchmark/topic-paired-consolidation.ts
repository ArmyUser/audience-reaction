import { createHash } from "node:crypto";
import { MAX_TOPIC_ATTEMPTS } from "../application/analyze-topics";
import { ContractTopicTaxonomyGenerator } from "../application/contract-topic-phases";
import { InMemoryUsageRecorder, summarizeUsage, type PriceTable, type UsageSummary } from "../core/cost/usage";
import type { TopicModelTransport, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../core/ports";
import { buildTopicConsolidationInstructions, TOPIC_CONSOLIDATION_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT_V4, isTopicConsolidationContract, type TopicConsolidationContract } from "../core/topics/consolidation-contract";
import { buildTopicDiscoveryRequest, TOPIC_DISCOVERY_CONTRACT, type TopicModelRequest } from "../core/topics/provider-contracts";
import { MATCH_JACCARD_THRESHOLD, MAX_DEFINITION_CHARS, MERGE_SPLIT_SHARE } from "./topic-benchmark";
import { snapshotTaxonomy, type TaxonomySnapshotTopic } from "./topic-consolidated-diagnostics";
import { armRunsOf, comparableSettings, statOf, type ArmRun, type CriterionResult } from "./topic-consolidation-experiment";
import type { TopicBenchmarkDataset } from "./topic-datasets";
import { consolidatedOracleGate } from "./topic-discovery-consolidated";
import { discoveryRequestOf, runDiscoveryAttempts, type DiscoveryAttemptRecord } from "./topic-discovery-only";
import { buildRealConsolidatedPlan, runRealConsolidatedBenchmark, type RealConsolidatedResult } from "./topic-real-consolidated";
import { discoveryTransportFactory, type DiscoveryClients, type TopicProviderConfig, type TopicRealKeys } from "./topic-real";

// EXPERIMENTAL paired consolidation comparison (docs/topic-consolidation-paired-experiment.md). It isolates the
// consolidation contract from discovery and provider failures:
//
//   DISCOVERY (once per pair, fixed retry policy, every attempt recorded with its raw rejected output)
//       ↓ validated taxonomy (fingerprinted)
//       ├── consolidation arm A → the unchanged real-consolidated path (Jev assignment, report, evaluator)
//       └── consolidation arm B → the unchanged real-consolidated path (Jev assignment, report, evaluator)
//
// Both arms consume the SAME validated discovery taxonomy; inside an arm the discovery provider is never called (the
// arm's discovery generator serves the frozen taxonomy and refuses a request for any other sample). If discovery is
// still invalid after the retry policy, the WHOLE PAIR is unavailable: no arm runs and the pair is never scored for
// either contract. Nothing here changes a prompt, a contract, Jev, the report or the evaluator metrics; the
// real-consolidated suite runs exactly as before when this module is not used.

export const PAIRED_CONSOLIDATION_KIND = "paired-consolidation";
export const PAIRED_RESULT_SCHEMA = "paired-consolidation-result-v1";

/**
 * The fixed discovery retry policy of the paired mode: the production rule, unchanged (runDiscoveryAttempts): at most
 * MAX_TOPIC_ATTEMPTS attempts; any rejected attempt (invalid output, invalid taxonomy or provider error) is retried
 * with the production structured feedback. Exhausted: the pair is unavailable. Changing it requires a new policy id.
 */
export const PAIRED_DISCOVERY_RETRY_POLICY = Object.freeze({
  id: "paired-discovery-retry-v1",
  maxAttempts: MAX_TOPIC_ATTEMPTS,
  retryOn: Object.freeze(["invalid_taxonomy", "provider_error"] as const),
  feedback: "production structured validation feedback (toValidationFeedback), as analyzeTopics sends it",
  exhausted: "pair unavailable: no consolidation arm runs; never scored for either contract",
});

/** Rejected raw output kept per attempt, at most this many characters (diagnostics only). */
export const MAX_RAW_OUTPUT_CHARS = 100_000;

/** The evaluator constants that must match between arms (recorded with each pair). */
export const PAIRED_EVALUATOR = Object.freeze({ matchJaccardThreshold: MATCH_JACCARD_THRESHOLD, mergeSplitShare: MERGE_SPLIT_SHARE, maxDefinitionChars: MAX_DEFINITION_CHARS });

export const PAIRED_NOTICE =
  "EXPERIMENTAL PAIRED CONSOLIDATION RESULT: one discovery per pair, validated before the pair is formed; the same validated taxonomy is consolidated by each contract and then run through the unchanged real-consolidated path (Jev assignment, topic sentiment, report, full evaluator). A pair whose discovery stays invalid after the fixed retry policy is unavailable as a whole and is never scored for either arm. NOT part of production.";

// ---------- fingerprints ----------

/** JSON with object keys sorted at every level, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Discovery settings that must be identical for every arm of a pair (and every pair of an experiment). */
export function discoverySettingsOf(config: TopicProviderConfig): Record<string, string | number> {
  const d = config.discovery;
  return {
    provider: d.provider,
    model: d.model,
    contract: TOPIC_DISCOVERY_CONTRACT,
    maxOutputTokens: d.maxOutputTokens,
    ...(d.provider === "google" ? { thinkingLevel: d.thinkingLevel } : { effort: d.effort, refusalFallback: d.refusalFallback }),
  };
}

/** Fingerprint of a model request's fixed part: contract, instructions and output schema (not the data). */
export function requestPromptFingerprint(request: Pick<TopicModelRequest, "contract" | "instructions" | "outputSchema">): string {
  return sha256(canonicalJson({ contract: request.contract, instructions: request.instructions, outputSchema: request.outputSchema }));
}

export interface DiscoveryInputFingerprints {
  /** Dataset id and content version. */
  dataset: string;
  /** The seeded discovery sample (ids and text) and the discovery context, exactly as the request carries them. */
  sample: string;
  /** The discovery prompt: first-attempt and retry instructions and the output schema (topic-discovery-v2). */
  prompt: string;
  /** First-attempt and retry prompt fingerprints separately (each attempt records which one it sent). */
  promptFirst: string;
  promptRetry: string;
}

function sampleFingerprintOf(request: Pick<TopicTaxonomyRequest, "sample" | "context">): string {
  return sha256(canonicalJson({ sample: request.sample.map((c) => ({ id: c.id, text: c.text })), context: request.context }));
}

/** Everything the discovery request depends on, computed offline from the dataset (no provider). */
export function discoveryInputFingerprints(dataset: TopicBenchmarkDataset): DiscoveryInputFingerprints {
  const { request } = discoveryRequestOf(dataset);
  const first = requestPromptFingerprint(buildTopicDiscoveryRequest(request));
  const retry = requestPromptFingerprint(buildTopicDiscoveryRequest({ ...request, feedback: { attempt: 1, issues: [] } }));
  return { dataset: `${dataset.id}@${dataset.version}`, sample: sampleFingerprintOf(request), prompt: sha256(`${first}\n${retry}`), promptFirst: first, promptRetry: retry };
}

export function taxonomyFingerprint(topics: readonly TaxonomySnapshotTopic[]): string {
  return sha256(canonicalJson(topics.map((t) => ({ key: t.key, name: t.name, definition: t.definition, exampleCommentIds: [...t.exampleCommentIds] }))));
}

/** The pair's discovery identity: dataset, sample, prompt, settings and the validated taxonomy. */
export function discoveryFingerprintOf(inputs: DiscoveryInputFingerprints, settings: Record<string, unknown>, taxonomy: string): string {
  return sha256(canonicalJson({ dataset: inputs.dataset, sample: inputs.sample, prompt: inputs.prompt, settings, taxonomy }));
}

export interface ConsolidationPromptFingerprints {
  contract: TopicConsolidationContract;
  /** The max_topics the instructions are rendered with: the discovery context's maximum, capped at the candidate count. */
  maxTopics: number;
  first: string;
  retry: string;
}

/**
 * The consolidation instructions an arm sends for a discovery taxonomy of `candidateTopics` topics (first attempt and
 * retry). The arm's request context is the pair's discovery context (the frozen discovery refuses any other), so this
 * is exactly what the arm renders.
 */
export function consolidationPromptFingerprints(dataset: TopicBenchmarkDataset, contract: TopicConsolidationContract, candidateTopics: number): ConsolidationPromptFingerprints {
  const maxTopics = Math.min(discoveryRequestOf(dataset).request.context.maxTopics, candidateTopics);
  return { contract, maxTopics, first: sha256(buildTopicConsolidationInstructions({ maxTopics, retry: false, contract })), retry: sha256(buildTopicConsolidationInstructions({ maxTopics, retry: true, contract })) };
}

// ---------- discovery with recorded raw output ----------

export interface PairedDiscoveryAttempt extends DiscoveryAttemptRecord {
  provider: string;
  model: string;
  datasetFingerprint: string;
  /** The prompt fingerprint of the request actually sent (first-attempt or retry instructions). */
  promptFingerprint: string;
  /** Fingerprint of the request's sample and context (must equal the pair's sample fingerprint). */
  sampleFingerprint: string;
  /** The raw model text of a REJECTED attempt (null when accepted, or when no text was received, e.g. a provider error). */
  rawOutput: string | null;
  rawOutputChars: number | null;
  rawOutputTruncated: boolean;
  /** Fingerprint of the validated taxonomy (accepted attempt only). */
  taxonomyFingerprint: string | null;
}

export interface PairedDiscovery {
  policy: typeof PAIRED_DISCOVERY_RETRY_POLICY;
  status: "valid" | "unavailable";
  attempts: PairedDiscoveryAttempt[];
  settings: Record<string, string | number>;
  inputs: DiscoveryInputFingerprints;
  /** The validated taxonomy both arms consume (null when unavailable). */
  taxonomy: TaxonomySnapshotTopic[] | null;
  taxonomyFingerprint: string | null;
  /** The pair's discovery identity (null when unavailable). */
  discoveryFingerprint: string | null;
  usage: UsageSummary;
}

interface TransportCall {
  promptFingerprint: string;
  raw: string | null;
}

/** Passes every request through unchanged and remembers the prompt sent and the raw text that came back. */
class RecordingTransport implements TopicModelTransport {
  readonly label: string;
  readonly calls: TransportCall[] = [];
  constructor(private readonly inner: TopicModelTransport) {
    this.label = inner.label;
  }
  async complete(request: TopicModelRequest): Promise<string> {
    const call: TransportCall = { promptFingerprint: requestPromptFingerprint(request), raw: null };
    this.calls.push(call);
    call.raw = await this.inner.complete(request);
    return call.raw;
  }
}

/** Removes every occurrence of the given secrets (defensive: model output never needs them). */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.filter((s) => s.length >= 8).reduce((t, s) => t.split(s).join("[REDACTED]"), text);
}

/**
 * Discovery for one pair under PAIRED_DISCOVERY_RETRY_POLICY: the production request, validation and retry
 * (runDiscoveryAttempts), with every attempt recorded, including the raw text of rejected attempts.
 */
export async function runPairedDiscovery(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  transport: TopicModelTransport,
  recorder: InMemoryUsageRecorder,
  options: { secrets?: readonly string[]; now?: () => number } = {},
): Promise<PairedDiscovery> {
  const inputs = discoveryInputFingerprints(dataset);
  const settings = discoverySettingsOf(config);
  // One generator call, and so one transport call, per attempt: attempt i is calls[i] and sent[i].
  const sent: string[] = [];
  const recording = new RecordingTransport(transport);
  const inner = new ContractTopicTaxonomyGenerator(recording);
  const generator: TopicTaxonomyGenerator = {
    label: inner.label,
    proposeTaxonomy: (r) => {
      sent.push(sampleFingerprintOf(r));
      return inner.proposeTaxonomy(r);
    },
  };
  const result = await runDiscoveryAttempts(dataset, generator, options.now ? { now: options.now } : {});
  const taxonomy = result.taxonomy ? snapshotTaxonomy(result.taxonomy) : null;
  const taxFp = taxonomy ? taxonomyFingerprint(taxonomy) : null;
  const attempts = result.attempts.map((a, i): PairedDiscoveryAttempt => {
    const call = recording.calls[i];
    const rejected = a.outcome !== "valid";
    const raw = rejected && call?.raw != null ? redactSecrets(call.raw, options.secrets ?? []) : null;
    return {
      ...a,
      provider: config.discovery.provider,
      model: config.discovery.model,
      datasetFingerprint: inputs.dataset,
      promptFingerprint: call?.promptFingerprint ?? "not_sent",
      sampleFingerprint: sent[i] ?? "not_sent",
      rawOutput: raw === null ? null : raw.slice(0, MAX_RAW_OUTPUT_CHARS),
      rawOutputChars: raw === null ? null : raw.length,
      rawOutputTruncated: raw !== null && raw.length > MAX_RAW_OUTPUT_CHARS,
      taxonomyFingerprint: a.outcome === "valid" ? taxFp : null,
    };
  });
  return {
    policy: PAIRED_DISCOVERY_RETRY_POLICY,
    status: result.status,
    attempts,
    settings,
    inputs,
    taxonomy,
    taxonomyFingerprint: taxFp,
    discoveryFingerprint: taxFp ? discoveryFingerprintOf(inputs, settings, taxFp) : null,
    usage: summarizeUsage(recorder.entries),
  };
}

/** Thrown when an arm asks for discovery on anything other than the pair's sample (never expected). */
export class PairedDiscoveryMismatchError extends Error {
  override readonly name = "PairedDiscoveryMismatchError";
}

/**
 * The discovery generator of one arm: serves the pair's validated taxonomy and never calls a provider. A request for
 * any other sample or context is refused, so an arm can only ever consume the pair's discovery.
 */
export class FrozenDiscoveryGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  calls = 0;
  constructor(private readonly discovery: PairedDiscovery) {
    if (discovery.status !== "valid" || !discovery.taxonomy) throw new PairedDiscoveryMismatchError("an unavailable discovery cannot be served to an arm");
    this.label = `frozen paired discovery (${discovery.discoveryFingerprint})`;
  }
  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    this.calls += 1;
    if (sampleFingerprintOf(request) !== this.discovery.inputs.sample) throw new PairedDiscoveryMismatchError("the arm requested discovery for a different sample or context than the pair's");
    return { topics: this.discovery.taxonomy!.map((t) => ({ key: t.key, name: t.name, definition: t.definition, exampleCommentIds: [...t.exampleCommentIds] })) };
  }
}

// ---------- one pair (live, or offline with fake clients) ----------

export interface PairedArm {
  contract: TopicConsolidationContract;
  /** Position in which the arm ran within the pair (1 or 2). */
  order: number;
  /** Fingerprint of the discovery taxonomy this arm actually consumed (from its own recorded candidates). */
  consumedTaxonomyFingerprint: string | null;
  /** How many times the arm asked for the (frozen) discovery taxonomy. */
  frozenDiscoveryCalls: number;
  /** Fingerprints of the consolidation instructions the arm sent (absent in pairs saved before they were recorded). */
  consolidationPrompt?: ConsolidationPromptFingerprints;
  result: RealConsolidatedResult;
}

/** Identity of a pair run under a pre-registered experiment (absent for ad-hoc pairs). */
export interface PairExperimentStamp {
  id: string;
  /** Fingerprint of the registered definition the pair was run under (pairedExperimentFingerprint). */
  definitionFingerprint: string;
  /** Scheduled pair number (1 … scheduledPairs); also the pair index that fixes the arm order. */
  scheduledPair: number;
  /** SHA-256 of the dataset file the pair was run on. */
  datasetSha256: string;
}

export interface PairedConsolidationResult {
  meta: {
    kind: typeof PAIRED_CONSOLIDATION_KIND;
    experimental: true;
    resultSchema: typeof PAIRED_RESULT_SCHEMA;
    notice: string;
    pairId: string;
    pairIndex: number;
    timestamp: string;
    dataset: string;
    datasetVersion: string;
    contracts: { baseline: TopicConsolidationContract; candidate: TopicConsolidationContract };
    armOrder: TopicConsolidationContract[];
    discovery: Record<string, string | number>;
    assignment: RealConsolidatedResult["meta"]["assignment"];
    evaluator: typeof PAIRED_EVALUATOR;
    /** Present when the pair was run under a pre-registered experiment. */
    experiment?: PairExperimentStamp;
  };
  status: "available" | "unavailable_discovery" | "oracle_gate_failed";
  oracleGate: { passed: boolean; failures: string[] };
  discovery: PairedDiscovery | null;
  arms: PairedArm[];
  totals: { discovery: UsageSummary; arms: { contract: string; costUsd: number | undefined }[] };
  /** Pairing validation as computed when the pair was saved (experiment pairs; it is always recomputed when evaluated). */
  pairingValidation?: { valid: boolean; problems: string[] };
}

/** Pre-registerable arm order: odd pairs run the baseline first, even pairs the candidate first. */
export function armOrderOf(pairIndex: number, baseline: TopicConsolidationContract, candidate: TopicConsolidationContract): TopicConsolidationContract[] {
  return pairIndex % 2 === 1 ? [baseline, candidate] : [candidate, baseline];
}

/** The taxonomy fingerprint every recorded discovery candidate of an arm agrees on (null if none or they disagree). */
export function consumedTaxonomyFingerprintOf(result: RealConsolidatedResult): string | null {
  const fps = new Set((result.instrumentation?.repeats ?? []).flatMap((r) => r.taxonomyCalls.flatMap((c) => (c.candidate ? [taxonomyFingerprint(c.candidate.topics)] : []))));
  return fps.size === 1 ? [...fps][0]! : null;
}

/**
 * One pair: the offline gates, one discovery under the fixed retry policy, then (only if discovery is valid) each
 * contract through the unchanged real-consolidated path with that same discovery taxonomy. Repeats are always 1 per arm.
 */
export async function runPairedConsolidationPair(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  keys: TopicRealKeys,
  options: DiscoveryClients & {
    pairIndex?: number;
    baseline?: TopicConsolidationContract;
    candidate?: TopicConsolidationContract;
    fetch?: typeof fetch;
    onProgress?: (message: string) => void;
    now?: () => number;
    /** Run under a pre-registered experiment: stamped into the result; the scheduled pair number is the pair index. */
    experiment?: PairExperimentStamp;
  } = {},
): Promise<PairedConsolidationResult> {
  const pairIndex = options.pairIndex ?? 1;
  if (!Number.isInteger(pairIndex) || pairIndex < 1) throw new RangeError("pairIndex must be a positive integer");
  if (options.experiment && options.experiment.scheduledPair !== pairIndex) throw new RangeError("an experiment pair runs with its scheduled pair number as the pair index");
  const baseline = options.baseline ?? TOPIC_CONSOLIDATION_CONTRACT;
  const candidate = options.candidate ?? TOPIC_CONSOLIDATION_CONTRACT_V4;
  if (baseline === candidate) throw new Error("the two arms must use different consolidation contracts");
  const armOrder = armOrderOf(pairIndex, baseline, candidate);
  const timestamp = new Date().toISOString();
  const clients: DiscoveryClients = { ...(options.anthropicClient ? { anthropicClient: options.anthropicClient } : {}), ...(options.geminiClient ? { geminiClient: options.geminiClient } : {}) };
  const assignment = { provider: "typesafe", modelRequested: config.assignment.model, contract: config.assignment.contract, questionSet: config.assignment.questionSet, maxCommentsPerBatch: config.assignment.maxCommentsPerBatch };
  const meta = (discoveryFp: string | null): PairedConsolidationResult["meta"] => ({
    kind: PAIRED_CONSOLIDATION_KIND,
    experimental: true,
    resultSchema: PAIRED_RESULT_SCHEMA,
    notice: PAIRED_NOTICE,
    pairId: `${timestamp}-${dataset.id}-pair-${pairIndex}-${discoveryFp ? discoveryFp.slice(7, 19) : "unavailable"}`,
    pairIndex,
    timestamp,
    dataset: dataset.id,
    datasetVersion: dataset.version,
    contracts: { baseline, candidate },
    armOrder,
    discovery: discoverySettingsOf(config),
    assignment,
    evaluator: PAIRED_EVALUATOR,
    ...(options.experiment ? { experiment: { ...options.experiment } } : {}),
  });
  // Experiment pairs carry their pairing validation as computed when saved (it is recomputed whenever evaluated).
  const stamped = (r: PairedConsolidationResult): PairedConsolidationResult => {
    if (!options.experiment) return r;
    const problems = validatePairedResult(r, dataset);
    return { ...r, pairingValidation: { valid: problems.length === 0, problems } };
  };

  const oracleGate = await consolidatedOracleGate(dataset);
  if (!oracleGate.passed) return stamped({ meta: meta(null), status: "oracle_gate_failed", oracleGate, discovery: null, arms: [], totals: { discovery: summarizeUsage([]), arms: [] } });

  const recorder = new InMemoryUsageRecorder();
  const transport = discoveryTransportFactory(config.discovery, prices, keys.discoveryApiKey, clients)(recorder);
  const discovery = await runPairedDiscovery(dataset, config, transport, recorder, { secrets: [keys.discoveryApiKey, keys.jevApiKey], ...(options.now ? { now: options.now } : {}) });
  options.onProgress?.(`pair ${pairIndex}: discovery ${discovery.status} (${discovery.attempts.length} attempt(s))`);
  if (discovery.status !== "valid") return stamped({ meta: meta(null), status: "unavailable_discovery", oracleGate, discovery, arms: [], totals: { discovery: discovery.usage, arms: [] } });

  const arms: PairedArm[] = [];
  for (const [i, contract] of armOrder.entries()) {
    const frozen: FrozenDiscoveryGenerator[] = [];
    const result = await runRealConsolidatedBenchmark(dataset, config, prices, keys, 1, {
      ...clients,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      consolidationContract: contract,
      discoveryOverride: () => {
        const g = new FrozenDiscoveryGenerator(discovery);
        frozen.push(g);
        return g;
      },
    });
    arms.push({
      contract,
      order: i + 1,
      consumedTaxonomyFingerprint: consumedTaxonomyFingerprintOf(result),
      frozenDiscoveryCalls: frozen.reduce((s, g) => s + g.calls, 0),
      consolidationPrompt: consolidationPromptFingerprints(dataset, contract, discovery.taxonomy!.length),
      result,
    });
    options.onProgress?.(`pair ${pairIndex}: arm ${contract} done`);
  }
  return stamped({
    meta: meta(discovery.discoveryFingerprint),
    status: "available",
    oracleGate,
    discovery,
    arms,
    totals: { discovery: discovery.usage, arms: arms.map((a) => ({ contract: a.contract, costUsd: a.result.totals.all.estimatedCostUsd })) },
  });
}

// ---------- strict pairing validation (offline) ----------

/**
 * Problems that make a pair unusable for a comparison (empty: valid). Recomputes every fingerprint from the stored
 * data; with `dataset`, also checks the dataset, sample and prompt fingerprints against the dataset as it is now.
 */
export function validatePairedResult(pair: PairedConsolidationResult, dataset?: TopicBenchmarkDataset): string[] {
  const problems: string[] = [];
  const m = pair.meta;
  if (m?.kind !== PAIRED_CONSOLIDATION_KIND || m.resultSchema !== PAIRED_RESULT_SCHEMA) return ["not a paired-consolidation result of a known schema"];
  if (m.contracts.baseline === m.contracts.candidate) problems.push("baseline and candidate contracts are the same");
  for (const c of [m.contracts.baseline, m.contracts.candidate]) if (!isTopicConsolidationContract(c)) problems.push(`unknown consolidation contract ${c}`);
  if (dataset && (m.dataset !== dataset.id || m.datasetVersion !== dataset.version)) problems.push(`pair belongs to ${m.dataset}@${m.datasetVersion}, not ${dataset.id}@${dataset.version}`);
  if (pair.status === "oracle_gate_failed") return [...problems, "the offline oracle gate failed: the harness or dataset is broken"];

  const d = pair.discovery;
  if (!d) return [...problems, "discovery record missing"];
  if (d.policy?.id !== PAIRED_DISCOVERY_RETRY_POLICY.id || d.policy.maxAttempts !== PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts) problems.push(`discovery used another retry policy (${d.policy?.id})`);
  if (d.attempts.length === 0 || d.attempts.length > PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts) problems.push(`discovery made ${d.attempts.length} attempts (policy allows 1 to ${PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts})`);
  if (canonicalJson(d.settings) !== canonicalJson(m.discovery)) problems.push("discovery settings differ from the pair's");
  if (dataset) {
    const now = discoveryInputFingerprints(dataset);
    if (canonicalJson(now) !== canonicalJson(d.inputs)) problems.push("dataset, discovery sample or discovery prompt fingerprint differs from the current dataset and contract");
  }
  for (const a of d.attempts) {
    if (a.datasetFingerprint !== d.inputs.dataset) problems.push(`discovery attempt ${a.attempt}: dataset fingerprint differs`);
    if (a.sampleFingerprint !== d.inputs.sample) problems.push(`discovery attempt ${a.attempt}: sample fingerprint differs`);
    if (a.promptFingerprint !== (a.feedbackSent ? d.inputs.promptRetry : d.inputs.promptFirst) && a.promptFingerprint !== "not_sent") problems.push(`discovery attempt ${a.attempt}: prompt fingerprint differs`);
  }
  const last = d.attempts[d.attempts.length - 1];

  if (pair.status === "unavailable_discovery") {
    if (d.status !== "unavailable" || last?.outcome === "valid" || d.attempts.length !== PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts) problems.push("a pair marked unavailable must have exhausted the retry policy without a valid discovery");
    if (pair.arms.length > 0) problems.push("an unavailable pair must not contain arm results");
    return problems;
  }
  if (pair.status !== "available") return [...problems, `unknown pair status ${String(pair.status)}`];

  // Available: one valid discovery, recomputed fingerprints, and exactly the two contracts, each consuming it.
  if (d.status !== "valid" || !d.taxonomy || last?.outcome !== "valid") return [...problems, "an available pair needs a valid discovery taxonomy"];
  const taxFp = taxonomyFingerprint(d.taxonomy);
  if (taxFp !== d.taxonomyFingerprint) problems.push("the stored discovery taxonomy does not match its fingerprint");
  if (discoveryFingerprintOf(d.inputs, d.settings, taxFp) !== d.discoveryFingerprint) problems.push("the discovery fingerprint does not match its inputs, settings and taxonomy");
  if (last.taxonomyFingerprint !== taxFp) problems.push("the accepted discovery attempt does not carry the pair's taxonomy fingerprint");

  const contracts = pair.arms.map((a) => a.contract);
  if (pair.arms.length !== 2 || new Set(contracts).size !== 2 || !contracts.includes(m.contracts.baseline) || !contracts.includes(m.contracts.candidate)) return [...problems, `an available pair needs exactly one arm per contract (${m.contracts.baseline}, ${m.contracts.candidate}); found ${contracts.join(", ") || "none"}`];
  for (const arm of pair.arms) {
    const r = arm.result;
    const label = `arm ${arm.contract}`;
    if (r.meta.kind !== "real-consolidated" || r.meta.consolidation.contract !== arm.contract) problems.push(`${label}: result is not a real-consolidated run of that contract`);
    if (r.meta.dataset !== m.dataset || r.meta.datasetVersion !== m.datasetVersion) problems.push(`${label}: dataset differs from the pair's`);
    if (r.meta.repeats !== 1) problems.push(`${label}: ${r.meta.repeats} repeats (paired arms run exactly one)`);
    const consumed = consumedTaxonomyFingerprintOf(r);
    if (consumed !== taxFp || arm.consumedTaxonomyFingerprint !== taxFp) problems.push(`${label}: did not consume the pair's discovery taxonomy`);
    if (r.totals.discovery.requests !== 0) problems.push(`${label}: made ${r.totals.discovery.requests} discovery request(s); paired arms must not run discovery`);
    const rd = r.meta.discovery as Record<string, unknown>;
    if (rd.provider !== m.discovery.provider || rd.modelRequested !== m.discovery.model || rd.contract !== m.discovery.contract || ("effort" in m.discovery && rd.effort !== m.discovery.effort) || ("thinkingLevel" in m.discovery && rd.thinkingLevel !== m.discovery.thinkingLevel))
      problems.push(`${label}: discovery settings differ from the pair's`);
    if (canonicalJson(r.meta.assignment) !== canonicalJson(m.assignment)) problems.push(`${label}: assignment model or settings differ from the pair's`);
  }
  // Only the consolidation contract may differ: dataset, discovery, assignment, sample seed, parameters, matching.
  const [a, b] = pair.arms;
  if (canonicalJson(comparableSettings(a!.result)) !== canonicalJson(comparableSettings(b!.result))) problems.push("the arms differ in more than the consolidation contract (dataset, discovery, assignment, sample, parameters or evaluator matching)");
  return problems;
}

/** Settings that must be identical across all pairs of one experiment. */
function pairSettingsOf(pair: PairedConsolidationResult): string {
  const m = pair.meta;
  return canonicalJson({ dataset: m.dataset, datasetVersion: m.datasetVersion, contracts: m.contracts, discovery: m.discovery, assignment: m.assignment, evaluator: m.evaluator, inputs: pair.discovery?.inputs ?? null, policy: pair.discovery?.policy.id ?? null });
}

// ---------- paired experiment evaluation (offline) ----------

type NoRegressionMetric = "topicSentimentAccuracy" | "primaryTopicAccuracy";

/** A paired experiment as it must be pre-registered before any live pair is run. */
export interface PairedExperimentDefinition {
  id: string;
  dataset: string;
  datasetVersion: string;
  baseline: TopicConsolidationContract;
  candidate: TopicConsolidationContract;
  /** Available pairs scored: the FIRST this-many available pairs in timestamp order (never the best ones). */
  pairsRequired: number;
  /** Discovery-unavailable pairs tolerated before the required pairs are reached; more ends as DISCOVERY_UNRELIABLE. */
  maxUnavailablePairs: number;
  criteria: { minTopicPrecision: number; minConceptRecall: number; maxNewMergeErrors: number; noRegression: readonly NoRegressionMetric[] };
}

/**
 * A pre-registered paired experiment with a FIXED SCHEDULE: exactly `scheduledPairs` pairs, numbered 1 … N, each run
 * once. There are no replacement or additional pairs: a pair that ends unavailable (discovery exhausted, an arm failed,
 * or the run aborted) stays in the schedule as unavailable, is scored for neither arm and is never converted to zero,
 * and the experiment is then INCOMPLETE. Only when all scheduled pairs are available are the criteria evaluated
 * (PASS when every criterion passes, FAIL otherwise). Rates are fractions (0.01 = one percentage point).
 */
export interface ScheduledPairedExperiment {
  id: string;
  design: "fixed-schedule";
  /** The permanent pre-registration document. */
  document: string;
  dataset: string;
  /** SHA-256 of the dataset file. */
  datasetSha256: string;
  datasetVersion: string;
  baseline: TopicConsolidationContract;
  candidate: TopicConsolidationContract;
  discovery: { provider: string; model: string; contract: string; retryPolicy: string; maxAttempts: number };
  assignment: { provider: string; model: string; contract: string; questionSet: string };
  scheduledPairs: number;
  /** Always 0: an unavailable pair is never replaced and no pair is added after results are seen. */
  replacementPairs: 0;
  budget: {
    /** The whole experiment's spending limit; fixed at registration, never raised. */
    totalUsd: number;
    /** Conservative worst case of one pair at registration (buildPairedPlan, configured prices). */
    worstCasePerPairUsd: number;
    worstCaseTotalUsd: number;
  };
  criteria: {
    /** 1. Candidate mean topic precision at least this. */
    minCandidateTopicPrecision: number;
    /** 2. Candidate mean topic (concept) recall at least this. */
    minCandidateTopicRecall: number;
    /** 3. Candidate mean topic precision at least the baseline mean plus this. */
    minTopicPrecisionGain: number;
    /** 4. Candidate mean topic recall at most this below the baseline mean. */
    maxTopicRecallDrop: number;
    /** 5. Total candidate merge errors at most the total baseline merge errors plus this. */
    maxMergeErrorIncrease: number;
    /** 6. Candidate mean primary-topic accuracy at most this below the baseline mean. */
    maxPrimaryTopicAccuracyDrop: number;
    /** 7. Candidate mean topic sentiment accuracy at most this below the baseline mean. */
    maxTopicSentimentAccuracyDrop: number;
    /** 8. No pair with a candidate split error where the same pair's baseline has none. */
    noNewSplitWhereBaselineHasNone: true;
  };
}

/** Floating-point representation tolerance for the threshold comparisons (not a scientific tolerance). */
export const CRITERION_EPSILON = 1e-9;

/** Identity of a registered definition; every pair records it, so a definition edited after pairs exist is detected. */
export function pairedExperimentFingerprint(def: ScheduledPairedExperiment): string {
  return sha256(canonicalJson(def));
}

/**
 * Registered paired experiments, each fixed (here and in its pre-registration document) before its first live pair
 * and never edited afterwards: pairs record the definition fingerprint, and evaluation refuses pairs of another one.
 */
export const PAIRED_EXPERIMENTS: Readonly<Record<string, ScheduledPairedExperiment>> = Object.freeze({
  "paired-consolidation-v3-v4-t5-v1": Object.freeze({
    id: "paired-consolidation-v3-v4-t5-v1",
    design: "fixed-schedule",
    document: "docs/topic-consolidation-paired-t5-preregistration.md",
    dataset: "t5-topics-v1",
    datasetSha256: "cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3",
    datasetVersion: "sha256:cec6e6563d81a179",
    baseline: TOPIC_CONSOLIDATION_CONTRACT,
    candidate: TOPIC_CONSOLIDATION_CONTRACT_V4,
    discovery: Object.freeze({ provider: "anthropic", model: "claude-sonnet-5-5", contract: TOPIC_DISCOVERY_CONTRACT, retryPolicy: PAIRED_DISCOVERY_RETRY_POLICY.id, maxAttempts: PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts }),
    assignment: Object.freeze({ provider: "typesafe", model: "jev-latest", contract: "topic-assignment-v1", questionSet: "jev-topic-a1" }),
    scheduledPairs: 3,
    replacementPairs: 0,
    budget: Object.freeze({ totalUsd: 5.25, worstCasePerPairUsd: 1.749553584, worstCaseTotalUsd: 5.248660752 }),
    criteria: Object.freeze({
      minCandidateTopicPrecision: 0.88,
      minCandidateTopicRecall: 0.92,
      minTopicPrecisionGain: 0.05,
      maxTopicRecallDrop: 0.01,
      maxMergeErrorIncrease: 0,
      maxPrimaryTopicAccuracyDrop: 0.01,
      maxTopicSentimentAccuracyDrop: 0.01,
      noNewSplitWhereBaselineHasNone: true,
    }),
  }) as ScheduledPairedExperiment,
});

// ---------- fixed-schedule experiments: reservations, budget and evaluation (offline) ----------

export const PAIR_RESERVATION_KIND = "paired-experiment-reservation";

/**
 * Written (never overwritten) before a scheduled pair starts. A reservation without a saved pair is an aborted pair:
 * it stays in the schedule as unavailable and its number is never run again.
 */
export interface PairReservation {
  kind: typeof PAIR_RESERVATION_KIND;
  experiment: string;
  definitionFingerprint: string;
  dataset: string;
  scheduledPair: number;
  timestamp: string;
}

export function pairReservationOf(def: ScheduledPairedExperiment, scheduledPair: number, timestamp: string): PairReservation {
  return { kind: PAIR_RESERVATION_KIND, experiment: def.id, definitionFingerprint: pairedExperimentFingerprint(def), dataset: def.dataset, scheduledPair, timestamp };
}

export function pairReservationFileName(r: PairReservation): string {
  return `${r.timestamp}-topics-${r.dataset}-paired-experiment-${r.experiment}-pair-${r.scheduledPair}-reserved`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";
}

type SavedPair = { file: string; result: PairedConsolidationResult };
type SavedReservation = { file: string; reservation: PairReservation };

/** The next scheduled pair number (every reserved or saved number is used up), or null when none is left. */
export function nextScheduledPair(def: ScheduledPairedExperiment, pairs: readonly SavedPair[], reservations: readonly SavedReservation[]): number | null {
  const used = [...pairs.filter((p) => p.result.meta.experiment?.id === def.id).map((p) => p.result.meta.experiment!.scheduledPair), ...reservations.filter((r) => r.reservation.experiment === def.id).map((r) => r.reservation.scheduledPair)];
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return next <= def.scheduledPairs ? next : null;
}

const pairCostUsd = (r: PairedConsolidationResult): number | undefined => {
  const parts = [r.totals.discovery.estimatedCostUsd, ...r.totals.arms.map((a) => a.costUsd)];
  return parts.every((x) => x !== undefined) ? parts.reduce<number>((s, x) => s + x!, 0) : undefined;
};

/**
 * Budget state before the next pair. Spent: the recorded cost of every saved pair of the experiment; a pair whose
 * cost is not fully priced, and a reserved pair with no saved result, count at the registered worst case. A pair may
 * start only if its current worst case is within the registered per-pair worst case AND within the remaining budget.
 */
export function experimentBudget(def: ScheduledPairedExperiment, pairs: readonly SavedPair[], reservations: readonly SavedReservation[], pairWorstCaseUsd: number): { spentUsd: number; remainingUsd: number; allowed: boolean; reason: string } {
  const own = pairs.filter((p) => p.result.meta.experiment?.id === def.id);
  const saved = new Set(own.map((p) => p.result.meta.experiment!.scheduledPair));
  const aborted = reservations.filter((r) => r.reservation.experiment === def.id && !saved.has(r.reservation.scheduledPair));
  const spentUsd = own.reduce((s, p) => s + (pairCostUsd(p.result) ?? def.budget.worstCasePerPairUsd), 0) + aborted.length * def.budget.worstCasePerPairUsd;
  const remainingUsd = def.budget.totalUsd - spentUsd;
  const usd = (x: number) => `$${x.toFixed(4)}`;
  if (!(pairWorstCaseUsd <= def.budget.worstCasePerPairUsd + CRITERION_EPSILON))
    return { spentUsd, remainingUsd, allowed: false, reason: `a pair's worst case is now ${usd(pairWorstCaseUsd)}, above the registered ${usd(def.budget.worstCasePerPairUsd)} (configuration or prices changed since registration)` };
  if (!(pairWorstCaseUsd <= remainingUsd + CRITERION_EPSILON)) return { spentUsd, remainingUsd, allowed: false, reason: `a pair's worst case ${usd(pairWorstCaseUsd)} exceeds the remaining registered budget ${usd(remainingUsd)} of ${usd(def.budget.totalUsd)}` };
  return { spentUsd, remainingUsd, allowed: true, reason: `worst case ${usd(pairWorstCaseUsd)} within the remaining ${usd(remainingUsd)} of ${usd(def.budget.totalUsd)}` };
}

export interface ScheduledPairOutcome {
  scheduledPair: number;
  status: "available" | "unavailable_discovery" | "unavailable_arm" | "aborted" | "pending";
  file: string | null;
  detail: string;
}

export interface ScheduledPairedEvaluation {
  experiment: string;
  dataset: string;
  definitionFingerprint: string;
  verdict: "PASS" | "FAIL" | "INCOMPLETE" | "INVALID";
  reasons: string[];
  pairs: ScheduledPairOutcome[];
  /** Per-pair arm metrics of the available pairs (scored only when all scheduled pairs are available). */
  arms: { contract: string; runs: ArmRun[] }[];
  pairedDeltas: Record<string, number>;
  criteria: CriterionResult[];
}

/** Problems that make an experiment pair inadmissible beyond pairing validation: it must match the registration. */
function registrationProblems(def: ScheduledPairedExperiment, fingerprint: string, p: SavedPair): string[] {
  const m = p.result.meta;
  const x = m.experiment!;
  const problems: string[] = [];
  if (x.definitionFingerprint !== fingerprint) problems.push(`run under definition ${x.definitionFingerprint}, registered ${fingerprint} (the definition was altered after pairs existed)`);
  if (!Number.isInteger(x.scheduledPair) || x.scheduledPair < 1 || x.scheduledPair > def.scheduledPairs) problems.push(`scheduled pair ${x.scheduledPair} outside 1 … ${def.scheduledPairs} (no additional pairs)`);
  if (m.pairIndex !== x.scheduledPair) problems.push(`pair index ${m.pairIndex} is not the scheduled pair number ${x.scheduledPair}`);
  if (m.dataset !== def.dataset || m.datasetVersion !== def.datasetVersion || x.datasetSha256 !== def.datasetSha256) problems.push(`dataset ${m.dataset}@${m.datasetVersion} is not the registered ${def.dataset}@${def.datasetVersion}`);
  if (m.contracts.baseline !== def.baseline || m.contracts.candidate !== def.candidate) problems.push(`contracts ${m.contracts.baseline} vs ${m.contracts.candidate} are not the registered ones`);
  if (m.discovery.provider !== def.discovery.provider || m.discovery.model !== def.discovery.model || m.discovery.contract !== def.discovery.contract) problems.push("discovery provider, model or contract is not the registered one");
  if (p.result.discovery && (p.result.discovery.policy.id !== def.discovery.retryPolicy || p.result.discovery.policy.maxAttempts !== def.discovery.maxAttempts)) problems.push("discovery retry policy is not the registered one");
  if (m.assignment.provider !== def.assignment.provider || m.assignment.modelRequested !== def.assignment.model || m.assignment.contract !== def.assignment.contract || (m.assignment as { questionSet?: string }).questionSet !== def.assignment.questionSet)
    problems.push("assignment provider, model, contract or question set is not the registered one");
  return problems;
}

/**
 * Evaluates a fixed-schedule experiment from its saved pairs and reservations. Pairs of other experiments, and ad-hoc
 * pairs, are ignored. INVALID: a pair fails pairing validation or does not match the registration (including a
 * definition altered after pairs existed), or a scheduled number appears twice (a replacement). INCOMPLETE: a scheduled
 * pair has not run yet, or any scheduled pair is unavailable (no replacement; never scored as zero). Otherwise every
 * registered criterion is evaluated over the scheduled pairs: PASS if all pass, FAIL if any fails.
 */
export function evaluateScheduledPairedExperiment(def: ScheduledPairedExperiment, pairs: readonly SavedPair[], reservations: readonly SavedReservation[] = [], dataset?: TopicBenchmarkDataset): ScheduledPairedEvaluation {
  const fingerprint = pairedExperimentFingerprint(def);
  const base = { experiment: def.id, dataset: def.dataset, definitionFingerprint: fingerprint, arms: [{ contract: def.baseline, runs: [] as ArmRun[] }, { contract: def.candidate, runs: [] as ArmRun[] }], pairedDeltas: {}, criteria: [] as CriterionResult[] };
  const own = pairs.filter((p) => p.result.meta?.kind === PAIRED_CONSOLIDATION_KIND && p.result.meta.experiment?.id === def.id).sort((x, y) => x.result.meta.experiment!.scheduledPair - y.result.meta.experiment!.scheduledPair || x.file.localeCompare(y.file));
  const reserved = reservations.filter((r) => r.reservation.kind === PAIR_RESERVATION_KIND && r.reservation.experiment === def.id);
  const pending = (n: number): ScheduledPairOutcome => ({ scheduledPair: n, status: "pending", file: null, detail: "not run yet" });
  const schedule = Array.from({ length: def.scheduledPairs }, (_, i) => pending(i + 1));

  const invalid: string[] = [];
  for (const r of reserved) {
    if (r.reservation.definitionFingerprint !== fingerprint) invalid.push(`${r.file}: reserved under definition ${r.reservation.definitionFingerprint}, registered ${fingerprint} (the definition was altered after pairs existed)`);
    if (!Number.isInteger(r.reservation.scheduledPair) || r.reservation.scheduledPair < 1 || r.reservation.scheduledPair > def.scheduledPairs) invalid.push(`${r.file}: reservation for pair ${r.reservation.scheduledPair} outside 1 … ${def.scheduledPairs} (no additional pairs)`);
  }
  for (const p of own) {
    invalid.push(...[...registrationProblems(def, fingerprint, p), ...validatePairedResult(p.result, dataset)].map((x) => `${p.file}: ${x}`));
  }
  const numbers = own.map((p) => p.result.meta.experiment!.scheduledPair);
  for (const n of new Set(numbers)) if (numbers.filter((x) => x === n).length > 1) invalid.push(`scheduled pair ${n} was run more than once (replacement pairs are not allowed)`);
  if (invalid.length > 0) return { ...base, verdict: "INVALID", reasons: invalid, pairs: schedule };

  for (const r of reserved) schedule[r.reservation.scheduledPair - 1] = { scheduledPair: r.reservation.scheduledPair, status: "aborted", file: r.file, detail: "reserved but no pair result was saved: unavailable, never re-run" };
  for (const p of own) {
    const n = p.result.meta.experiment!.scheduledPair;
    if (p.result.status === "unavailable_discovery") {
      schedule[n - 1] = { scheduledPair: n, status: "unavailable_discovery", file: p.file, detail: `discovery invalid after ${p.result.discovery?.attempts.length ?? 0} attempt(s) (${p.result.discovery?.attempts.map((a) => a.outcome).join(", ")})` };
      continue;
    }
    // An arm is complete when its single run is available (taxonomy, assignment and report present).
    const failed = p.result.arms.filter((a) => {
      const runs = armRunsOf(p.file, a.result);
      return runs.length !== 1 || !runs[0]!.available;
    });
    schedule[n - 1] = failed.length > 0
      ? { scheduledPair: n, status: "unavailable_arm", file: p.file, detail: `arm(s) failed after the shared discovery: ${failed.map((a) => `${a.contract} (${a.result.report.scenarios.find((s) => s.id !== "oracle")?.runs[0]?.failedAttemptCodes?.flat().join(", ") || "unavailable"})`).join("; ")}` }
      : { scheduledPair: n, status: "available", file: p.file, detail: "both arms complete on the shared discovery" };
  }

  const availablePairs = own.filter((p) => schedule[p.result.meta.experiment!.scheduledPair - 1]!.status === "available");
  const runsOf = (contract: string) => availablePairs.flatMap((p) => armRunsOf(p.file, p.result.arms.find((a) => a.contract === contract)!.result));
  const arms = [
    { contract: def.baseline, runs: runsOf(def.baseline) },
    { contract: def.candidate, runs: runsOf(def.candidate) },
  ];
  const unavailable = schedule.filter((s) => s.status !== "available" && s.status !== "pending");
  const notRun = schedule.filter((s) => s.status === "pending");
  if (unavailable.length > 0 || notRun.length > 0) {
    const reasons = [
      `${availablePairs.length} of ${def.scheduledPairs} scheduled pairs available`,
      ...unavailable.map((s) => `pair ${s.scheduledPair} ${s.status}: ${s.detail}; not scored for either arm, not replaced`),
      ...(notRun.length > 0 ? [`pair(s) ${notRun.map((s) => s.scheduledPair).join(", ")} not run yet`] : []),
    ];
    return { ...base, arms, verdict: "INCOMPLETE", reasons, pairs: schedule };
  }

  const a = arms[0]!.runs;
  const b = arms[1]!.runs;
  const mean = (runs: readonly ArmRun[], k: (typeof PAIRED_METRICS)[number]) => statOf(runs.map((r) => r[k]))!.mean;
  const sum = (runs: readonly ArmRun[], k: "mergeErrors") => runs.reduce((s, r) => s + r[k], 0);
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const pp = (x: number) => `${(x * 100).toFixed(2)} pp`;
  const c = def.criteria;
  const at = (x: number, min: number) => x >= min - CRITERION_EPSILON;
  const P = { a: mean(a, "topicPrecision"), b: mean(b, "topicPrecision") };
  const R = { a: mean(a, "conceptRecall"), b: mean(b, "conceptRecall") };
  const PT = { a: mean(a, "primaryTopicAccuracy"), b: mean(b, "primaryTopicAccuracy") };
  const TS = { a: mean(a, "topicSentimentAccuracy"), b: mean(b, "topicSentimentAccuracy") };
  const newSplits = availablePairs.filter((_, i) => a[i]!.splitErrors === 0 && b[i]!.splitErrors > 0).map((p) => p.result.meta.experiment!.scheduledPair);
  const criteria: CriterionResult[] = [
    { criterion: `1. topic precision: ${def.candidate} mean >= ${pct(c.minCandidateTopicPrecision)}`, passed: at(P.b, c.minCandidateTopicPrecision), detail: `${def.candidate} ${pct(P.b)}` },
    { criterion: `2. topic recall: ${def.candidate} mean >= ${pct(c.minCandidateTopicRecall)}`, passed: at(R.b, c.minCandidateTopicRecall), detail: `${def.candidate} ${pct(R.b)}` },
    { criterion: `3. precision improvement: ${def.candidate} mean >= ${def.baseline} mean + ${pp(c.minTopicPrecisionGain)}`, passed: at(P.b, P.a + c.minTopicPrecisionGain), detail: `${pct(P.b)} vs ${pct(P.a)} (difference ${pp(P.b - P.a)})` },
    { criterion: `4. recall regression: ${def.candidate} mean at most ${pp(c.maxTopicRecallDrop)} below ${def.baseline} mean`, passed: at(R.b, R.a - c.maxTopicRecallDrop), detail: `${pct(R.b)} vs ${pct(R.a)} (difference ${pp(R.b - R.a)})` },
    { criterion: `5. merge errors: ${def.candidate} total <= ${def.baseline} total${c.maxMergeErrorIncrease ? ` + ${c.maxMergeErrorIncrease}` : ""}`, passed: sum(b, "mergeErrors") <= sum(a, "mergeErrors") + c.maxMergeErrorIncrease, detail: `${sum(b, "mergeErrors")} vs ${sum(a, "mergeErrors")}` },
    { criterion: `6. primary-topic accuracy: ${def.candidate} mean at most ${pp(c.maxPrimaryTopicAccuracyDrop)} below ${def.baseline} mean`, passed: at(PT.b, PT.a - c.maxPrimaryTopicAccuracyDrop), detail: `${pct(PT.b)} vs ${pct(PT.a)} (difference ${pp(PT.b - PT.a)})` },
    { criterion: `7. topic sentiment accuracy: ${def.candidate} mean at most ${pp(c.maxTopicSentimentAccuracyDrop)} below ${def.baseline} mean`, passed: at(TS.b, TS.a - c.maxTopicSentimentAccuracyDrop), detail: `${pct(TS.b)} vs ${pct(TS.a)} (difference ${pp(TS.b - TS.a)})` },
    { criterion: `8. no pair with a ${def.candidate} split error where the same pair's ${def.baseline} has none`, passed: newSplits.length === 0, detail: newSplits.length === 0 ? "none" : `pair(s) ${newSplits.join(", ")}` },
  ];
  const pairedDeltas = Object.fromEntries(PAIRED_METRICS.map((k) => [k, statOf(b.map((r, i) => r[k] - a[i]![k]))!.mean]));
  return { ...base, arms, pairedDeltas, criteria, verdict: criteria.every((x) => x.passed) ? "PASS" : "FAIL", reasons: [`all ${def.scheduledPairs} scheduled pairs available`], pairs: schedule };
}

export function renderScheduledEvaluationMarkdown(e: ScheduledPairedEvaluation): string {
  const lines = [`# Paired consolidation experiment ${e.experiment} on ${e.dataset}`, "", `Definition: ${e.definitionFingerprint}`, `Verdict: ${e.verdict}`, ...e.reasons.map((r) => `- ${r}`), "", "| Pair | Status | File | Detail |", "|---|---|---|---|", ...e.pairs.map((p) => `| ${p.scheduledPair} | ${p.status} | ${p.file ?? "–"} | ${p.detail} |`)];
  if (e.criteria.length > 0) lines.push("", "| Criterion | Result | Values |", "|---|---|---|", ...e.criteria.map((c) => `| ${c.criterion} | ${c.passed ? "pass" : "FAIL"} | ${c.detail} |`));
  return lines.join("\n");
}

export interface PairedEvaluation {
  experiment: string;
  dataset: string;
  verdict: "PASS" | "FAIL" | "INCOMPLETE" | "INVALID" | "DISCOVERY_UNRELIABLE";
  reasons: string[];
  /** Discovery-unavailable pairs met before the selection was complete (reported, never scored). */
  unavailablePairs: string[];
  selectedPairs: string[];
  arms: { contract: string; runs: ArmRun[] }[];
  /** Mean per-pair difference (candidate − baseline) of each metric over the selected pairs. */
  pairedDeltas: Record<string, number>;
  criteria: CriterionResult[];
}

const PAIRED_METRICS = ["topicPrecision", "conceptRecall", "mergeErrors", "dispositionAccuracy", "primaryTopicAccuracy", "otherAccuracy", "noSpecificTopicAccuracy", "topicSentimentAccuracy", "evidencePrecision"] as const;

/**
 * Evaluates saved pairs against a pre-registered definition. Unavailable pairs are counted and listed, never scored for
 * either arm. A pair that fails validatePairedResult makes the whole comparison INVALID (it is refused, not skipped).
 * An arm that is unavailable AFTER the shared discovery (its consolidation or assignment failed) is a treatment
 * outcome and is scored with the existing evaluator convention (0 on every rate metric).
 */
export function evaluatePairedExperiment(def: PairedExperimentDefinition, pairs: readonly { file: string; result: PairedConsolidationResult }[], dataset?: TopicBenchmarkDataset): PairedEvaluation {
  const reasons: string[] = [];
  const base = { experiment: def.id, dataset: def.dataset };
  const empty = { unavailablePairs: [], selectedPairs: [], arms: [{ contract: def.baseline, runs: [] }, { contract: def.candidate, runs: [] }], pairedDeltas: {}, criteria: [] };
  const relevant = pairs
    .filter((p) => p.result.meta?.kind === PAIRED_CONSOLIDATION_KIND && p.result.meta.dataset === def.dataset)
    .sort((x, y) => x.result.meta.timestamp.localeCompare(y.result.meta.timestamp) || x.file.localeCompare(y.file));
  const stale = relevant.filter((p) => p.result.meta.datasetVersion !== def.datasetVersion);
  if (stale.length > 0) reasons.push(`${stale.length} pair(s) for another version of ${def.dataset} ignored`);
  const other = relevant.filter((p) => p.result.meta.datasetVersion === def.datasetVersion && (p.result.meta.contracts.baseline !== def.baseline || p.result.meta.contracts.candidate !== def.candidate));
  if (other.length > 0) reasons.push(`${other.length} pair(s) comparing other contracts ignored`);
  const current = relevant.filter((p) => p.result.meta.datasetVersion === def.datasetVersion && p.result.meta.contracts.baseline === def.baseline && p.result.meta.contracts.candidate === def.candidate);

  const invalid = current.flatMap((p) => validatePairedResult(p.result, dataset).map((problem) => `${p.file}: ${problem}`));
  if (invalid.length > 0) return { ...base, ...empty, verdict: "INVALID", reasons: [...reasons, ...invalid] };
  if (new Set(current.map((p) => pairSettingsOf(p.result))).size > 1) return { ...base, ...empty, verdict: "INVALID", reasons: [...reasons, "pairs differ in dataset, discovery, assignment, evaluator or retry policy"] };

  const selected: typeof current = [];
  const unavailable: string[] = [];
  for (const p of current) {
    if (selected.length >= def.pairsRequired) break;
    if (p.result.status === "available") selected.push(p);
    else unavailable.push(p.file);
  }
  const armRuns = (contract: string) => selected.flatMap((p) => armRunsOf(p.file, p.result.arms.find((a) => a.contract === contract)!.result));
  const arms = [
    { contract: def.baseline, runs: armRuns(def.baseline) },
    { contract: def.candidate, runs: armRuns(def.candidate) },
  ];
  const partial = { unavailablePairs: unavailable, selectedPairs: selected.map((p) => p.file), arms };
  if (unavailable.length > def.maxUnavailablePairs) return { ...base, ...partial, pairedDeltas: {}, criteria: [], verdict: "DISCOVERY_UNRELIABLE", reasons: [...reasons, `${unavailable.length} discovery-unavailable pair(s) before ${def.pairsRequired} available pairs (at most ${def.maxUnavailablePairs} pre-registered): no conclusion about consolidation`] };
  if (selected.length < def.pairsRequired) return { ...base, ...partial, pairedDeltas: {}, criteria: [], verdict: "INCOMPLETE", reasons: [...reasons, `${selected.length} of ${def.pairsRequired} available pairs saved`] };

  const a = arms[0]!;
  const b = arms[1]!;
  const mean = (runs: readonly ArmRun[], k: (typeof PAIRED_METRICS)[number]) => statOf(runs.map((r) => r[k]))!.mean;
  const pairedDeltas = Object.fromEntries(PAIRED_METRICS.map((k) => [k, statOf(b.runs.map((r, i) => r[k] - a.runs[i]![k]))!.mean]));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const c = def.criteria;
  const merges = (runs: readonly ArmRun[]) => runs.reduce((s, r) => s + r.mergeErrors, 0);
  const criteria: CriterionResult[] = [
    { criterion: `topic precision (candidate mean) >= ${pct(c.minTopicPrecision)}`, passed: mean(b.runs, "topicPrecision") >= c.minTopicPrecision, detail: `candidate ${pct(mean(b.runs, "topicPrecision"))}, baseline ${pct(mean(a.runs, "topicPrecision"))}` },
    { criterion: `topic recall (candidate mean) >= ${pct(c.minConceptRecall)}`, passed: mean(b.runs, "conceptRecall") >= c.minConceptRecall, detail: `candidate ${pct(mean(b.runs, "conceptRecall"))}, baseline ${pct(mean(a.runs, "conceptRecall"))}` },
    { criterion: `new merge errors relative to the baseline <= ${c.maxNewMergeErrors} (sum over pairs)`, passed: merges(b.runs) - merges(a.runs) <= c.maxNewMergeErrors, detail: `candidate ${merges(b.runs)}, baseline ${merges(a.runs)}` },
    ...c.noRegression.map((k) => ({ criterion: `no regression in ${k} (candidate mean >= baseline mean)`, passed: mean(b.runs, k) >= mean(a.runs, k), detail: `candidate ${pct(mean(b.runs, k))}, baseline ${pct(mean(a.runs, k))}` })),
  ];
  return { ...base, ...partial, pairedDeltas, criteria, verdict: criteria.every((x) => x.passed) ? "PASS" : "FAIL", reasons };
}

// ---------- plan, rendering and file names ----------

export interface PairedPlan {
  apiCalls: 0;
  pairs: number;
  /** Conservative: each arm's estimate includes the real-consolidated discovery cost although arms make no discovery call. */
  maxCostUsd: number;
  maxRequests: number;
  discoveryMaxCostUsd: number;
  armMaxCostUsd: number;
}

export function buildPairedPlan(dataset: TopicBenchmarkDataset, config: TopicProviderConfig, prices: PriceTable, env: Readonly<Record<string, string | undefined>>, pairs: number, contracts: readonly TopicConsolidationContract[] = [TOPIC_CONSOLIDATION_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT_V4]): PairedPlan {
  const arms = contracts.map((c) => buildRealConsolidatedPlan(dataset, config, prices, env, 1, c));
  const discoveryMaxCostUsd = arms[0]!.real.discovery.maxCostUsdPerCall * PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts;
  const armMaxCostUsd = arms.reduce((s, p) => s + p.maxCostUsd, 0);
  return { apiCalls: 0, pairs, discoveryMaxCostUsd, armMaxCostUsd, maxCostUsd: (discoveryMaxCostUsd + armMaxCostUsd) * pairs, maxRequests: (PAIRED_DISCOVERY_RETRY_POLICY.maxAttempts + arms.reduce((s, p) => s + p.maxRequests, 0)) * pairs };
}

export function pairedResultFileName(result: PairedConsolidationResult): string {
  const m = result.meta;
  return `${m.timestamp}-topics-${m.dataset}-paired-consolidation-${m.discovery.provider}-${m.discovery.model}-typesafe-${m.assignment.modelRequested}-${m.contracts.baseline}-vs-${m.contracts.candidate}-pair-${m.pairIndex}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";
}

export function renderPairedResultMarkdown(result: PairedConsolidationResult): string {
  const m = result.meta;
  const usd = (x: number | undefined) => (x === undefined ? "partly unpriced" : `$${x.toFixed(4)}`);
  const lines = [`# Paired consolidation pair ${m.pairIndex} on ${m.dataset} (EXPERIMENTAL)`, "", m.notice, "", `Status: ${result.status}`, `Pair: ${m.pairId}`, `Contracts: ${m.contracts.baseline} (baseline) vs ${m.contracts.candidate} (candidate); arm order ${m.armOrder.join(" → ")}`];
  const d = result.discovery;
  if (d) {
    lines.push("", `## Discovery (${d.policy.id}: at most ${d.policy.maxAttempts} attempts)`, `Discovery fingerprint: ${d.discoveryFingerprint ?? "none (unavailable)"}`);
    for (const a of d.attempts) lines.push(`- attempt ${a.attempt}: ${a.outcome}${a.providerFailure ? ` (${a.providerFailure})` : ""}${a.issueCodes.length ? ` [${a.issueCodes.join(", ")}]` : ""}${a.rawOutput !== null ? `; raw rejected output kept (${a.rawOutputChars} chars${a.rawOutputTruncated ? ", truncated" : ""})` : ""}`);
    lines.push(`Discovery cost: ${usd(d.usage.estimatedCostUsd)}`);
  }
  for (const arm of result.arms) {
    const live = arm.result.report.scenarios.find((s) => s.id !== "oracle")?.runs[0];
    lines.push("", `## Arm ${arm.order}: ${arm.contract}`, `Consumed discovery taxonomy: ${arm.consumedTaxonomyFingerprint ?? "none"}; status ${live?.status ?? "–"}; precision ${live?.taxonomy?.topicPrecision ?? "–"}, recall ${live?.taxonomy?.conceptRecall ?? "–"}, primary ${live?.assignment?.primaryTopicAccuracy ?? "–"}, topic sentiment ${live?.assignment?.topicSentimentAccuracy ?? "–"}; cost ${usd(arm.result.totals.all.estimatedCostUsd)}`);
  }
  const problems = validatePairedResult(result);
  lines.push("", `Pairing validation: ${problems.length === 0 ? "valid" : `INVALID: ${problems.join("; ")}`}`);
  return lines.join("\n");
}

export function renderPairedEvaluationMarkdown(e: PairedEvaluation): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [`# Paired consolidation experiment ${e.experiment} on ${e.dataset}`, "", `Verdict: ${e.verdict}`, ...e.reasons.map((r) => `- ${r}`), "", `Selected available pairs: ${e.selectedPairs.length}; discovery-unavailable pairs (not scored): ${e.unavailablePairs.length}`];
  if (e.criteria.length > 0) lines.push("", "| Criterion | Result | Values |", "|---|---|---|", ...e.criteria.map((c) => `| ${c.criterion} | ${c.passed ? "pass" : "FAIL"} | ${c.detail} |`));
  if (Object.keys(e.pairedDeltas).length > 0) lines.push("", "Mean paired difference (candidate − baseline):", ...Object.entries(e.pairedDeltas).map(([k, v]) => `- ${k}: ${k === "mergeErrors" ? v.toFixed(2) : pct(v)}`));
  return lines.join("\n");
}
