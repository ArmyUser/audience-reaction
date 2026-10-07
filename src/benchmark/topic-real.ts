import { readFileSync } from "node:fs";
import { createAnthropicClient } from "../adapters/ai/anthropic/anthropic-classifier";
import { AnthropicTopicTransport, toAnthropicOutputSchema, type AnthropicEffort } from "../adapters/ai/anthropic/anthropic-topic-transport";
import { createGeminiClient, GEMINI_THINKING_LEVELS, GeminiTopicTransport, toGeminiResponseSchema, type GeminiThinkingLevel } from "../adapters/ai/google/gemini-topic-transport";
import { JevTopicAssigner } from "../adapters/ai/typesafe/jev-topic-assigner";
import { JEV_TOPIC_QUESTION_SET } from "../adapters/ai/typesafe/jev-topic-questions";
import { BatchingTopicAssigner } from "../application/batching-topic-assigner";
import { ContractTopicTaxonomyGenerator, type RejectedDiscoveryOutput } from "../application/contract-topic-phases";
import { estimateCostUsd, InMemoryUsageRecorder, summarizeUsage, type AiCallRecord, type PriceTable, type UsageSummary } from "../core/cost/usage";
import type { TopicAssigner, TopicModelTransport, TopicTaxonomyGenerator } from "../core/ports";
import { DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, discoveryCandidateOf, selectDiscoverySample } from "../core/topics/discovery-sample";
import { buildTopicDiscoveryRequest, TOPIC_ASSIGNMENT_CONTRACT, TOPIC_DISCOVERY_CONTRACT, TopicProviderError, type TopicModelRequest } from "../core/topics/provider-contracts";
import { runTopicBenchmarkScenarios, TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED, type TopicBenchmarkReport } from "./topic-benchmark";
import { classifiedCommentsOf, type TopicBenchmarkDataset } from "./topic-datasets";
import { buildTopicScenario, type TopicScenario } from "./topic-scenarios";

// Real topic providers: configuration, the no-network preflight (prompt rendering, sizes, token and cost estimates)
// and the live benchmark run (Anthropic or Google Gemini discovery + TypeSafe Jev assignment through the frozen
// pipeline and the t1 harness). Live calls happen only through runRealTopicBenchmark, which the CLI reaches only with
// --live.

export const TOPIC_PROVIDER_CONFIG_PATH = "config/topic-providers.json";
export const PRICES_PATH = "config/model-prices.json";
export const REAL_SCENARIO_ID = "real-anthropic-discovery-jev-assignment";

/** Live scenario id for a discovery provider (the Anthropic one is REAL_SCENARIO_ID). */
export function realScenarioIdFor(provider: DiscoveryProviderConfig["provider"]): string {
  return `real-${provider}-discovery-jev-assignment`;
}

interface DiscoveryProviderBase {
  model: string;
  /** Other models of the same provider that may be selected with identical settings (e.g. --model gemini-3.7-flash). */
  alternativeModels?: string[];
  apiKeyEnv: string; contract: string; maxOutputTokens: number; expectedOutputTokens: number; timeoutMs: number; maxTransportRetries: number }
export interface AnthropicDiscoveryConfig extends DiscoveryProviderBase { provider: "anthropic"; effort: AnthropicEffort; refusalFallback: "default" | "off" }
export interface GoogleDiscoveryConfig extends DiscoveryProviderBase { provider: "google"; thinkingLevel: GeminiThinkingLevel }
export type DiscoveryProviderConfig = AnthropicDiscoveryConfig | GoogleDiscoveryConfig;

/** Provider name a CLI selects the default `discovery` entry with; other names select `discoveryProviders` entries. */
export const DEFAULT_DISCOVERY_PROVIDER = "anthropic";

export interface TopicProviderConfig {
  /** The default discovery provider. */
  discovery: DiscoveryProviderConfig;
  /** Optional alternative discovery providers, selectable by name (e.g. "gemini") without changing code. */
  discoveryProviders?: Record<string, DiscoveryProviderConfig>;
  assignment: { provider: "typesafe"; model: string; apiKeyEnv: string; contract: string; questionSet: string; baseUrl: string; maxCommentsPerBatch: number; concurrency: number; timeoutMs: number; maxTransportRetries: number };
  estimation: { charsPerToken: number; retryHeadroom: number; sentimentStepShare: number };
  limits: { maxCostUsd: number };
}

/** Reads and checks the provider configuration (no secrets in it; keys are named by environment variable only). */
export function loadTopicProviderConfig(text = readFileSync(TOPIC_PROVIDER_CONFIG_PATH, "utf8")): TopicProviderConfig {
  const c = JSON.parse(text) as TopicProviderConfig;
  const problems: string[] = [];
  const positive = (v: unknown, name: string) => (typeof v === "number" && v > 0 ? undefined : problems.push(`${name} must be a positive number`));
  const envName = (v: unknown) => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v);
  const checkDiscovery = (d: DiscoveryProviderConfig | undefined, path: string) => {
    if (typeof d?.model !== "string") problems.push(`${path} must name a model`);
    if (d?.contract !== TOPIC_DISCOVERY_CONTRACT) problems.push(`${path}.contract must be ${TOPIC_DISCOVERY_CONTRACT}`);
    if (d?.provider === "anthropic") {
      if (!["low", "medium", "high", "xhigh", "max"].includes(d.effort)) problems.push(`${path}.effort is invalid`);
      if (!["default", "off"].includes(d.refusalFallback)) problems.push(`${path}.refusalFallback must be default or off`);
    } else if (d?.provider === "google") {
      if (!(GEMINI_THINKING_LEVELS as readonly string[]).includes(d.thinkingLevel)) problems.push(`${path}.thinkingLevel must be one of ${GEMINI_THINKING_LEVELS.join(", ")} (minimal is not supported by gemini-3.8-flash or gemini-3.7-flash)`);
    } else problems.push(`${path}.provider must be anthropic or google`);
    if (!envName(d?.apiKeyEnv)) problems.push("apiKeyEnv must name an environment variable");
    positive(d?.maxOutputTokens, `${path}.maxOutputTokens`);
    positive(d?.expectedOutputTokens, `${path}.expectedOutputTokens`);
    positive(d?.timeoutMs, `${path}.timeoutMs`);
    const alternatives = d?.alternativeModels;
    if (alternatives !== undefined && (!Array.isArray(alternatives) || alternatives.some((m) => typeof m !== "string" || m.length === 0 || m === d?.model) || new Set(alternatives).size !== alternatives.length)) problems.push(`${path}.alternativeModels must list distinct model ids other than ${path}.model`);
  };
  checkDiscovery(c.discovery, "discovery");
  for (const [name, d] of Object.entries(c.discoveryProviders ?? {})) {
    if (name === DEFAULT_DISCOVERY_PROVIDER || !/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`discoveryProviders name "${name}" is reserved or invalid`);
    checkDiscovery(d, `discoveryProviders.${name}`);
  }
  if (c.assignment?.provider !== "typesafe" || typeof c.assignment.model !== "string") problems.push("assignment must be a typesafe provider with a model");
  if (c.assignment?.contract !== TOPIC_ASSIGNMENT_CONTRACT) problems.push(`assignment.contract must be ${TOPIC_ASSIGNMENT_CONTRACT}`);
  if (c.assignment?.questionSet !== JEV_TOPIC_QUESTION_SET) problems.push(`assignment.questionSet must be ${JEV_TOPIC_QUESTION_SET}`);
  if (!envName(c.assignment?.apiKeyEnv)) problems.push("apiKeyEnv must name an environment variable");
  positive(c.assignment?.maxCommentsPerBatch, "assignment.maxCommentsPerBatch");
  positive(c.assignment?.concurrency, "assignment.concurrency");
  positive(c.assignment?.timeoutMs, "assignment.timeoutMs");
  positive(c.estimation?.charsPerToken, "estimation.charsPerToken");
  positive(c.estimation?.retryHeadroom, "estimation.retryHeadroom");
  positive(c.limits?.maxCostUsd, "limits.maxCostUsd");
  if (problems.length > 0) throw new Error(`Invalid ${TOPIC_PROVIDER_CONFIG_PATH}:\n- ${problems.join("\n- ")}`);
  return c;
}

/**
 * The configuration with `discovery` replaced by the named provider ("anthropic" keeps the default entry) and, if
 * `model` is given, that model: the entry's own model or one of its alternativeModels, with the entry's settings.
 */
export function selectDiscoveryProvider(config: TopicProviderConfig, name: string = DEFAULT_DISCOVERY_PROVIDER, model?: string): TopicProviderConfig {
  const chosen = name === DEFAULT_DISCOVERY_PROVIDER ? config.discovery : config.discoveryProviders?.[name];
  if (!chosen) throw new Error(`Unknown discovery provider "${name}". Use ${[DEFAULT_DISCOVERY_PROVIDER, ...Object.keys(config.discoveryProviders ?? {})].join(", ")} (see ${TOPIC_PROVIDER_CONFIG_PATH}).`);
  if (model === undefined || model === chosen.model) return name === DEFAULT_DISCOVERY_PROVIDER ? config : { ...config, discovery: chosen };
  const allowed = [chosen.model, ...(chosen.alternativeModels ?? [])];
  if (!allowed.includes(model)) throw new Error(`Model "${model}" is not configured for discovery provider "${name}". Use ${allowed.join(", ")} (see ${TOPIC_PROVIDER_CONFIG_PATH}).`);
  return { ...config, discovery: { ...chosen, model } };
}

/** The output schema exactly as the configured discovery provider's request carries it. */
export function sentDiscoverySchema(config: TopicProviderConfig, schema: Record<string, unknown>): Record<string, unknown> {
  return config.discovery.provider === "google" ? toGeminiResponseSchema(schema) : toAnthropicOutputSchema(schema);
}

export function loadPrices(text = readFileSync(PRICES_PATH, "utf8")): PriceTable {
  return (JSON.parse(text) as { prices: PriceTable }).prices;
}

// ---------- preflight (no network) ----------

export interface TopicRealPreflight {
  apiCalls: 0;
  dataset: { id: string; version: string; comments: number; topicBase: number; spamExcluded: number };
  repeats: number;
  environment: { name: string; present: boolean }[];
  models: { discoveryProvider: DiscoveryProviderConfig["provider"]; discovery: string; assignment: string; pricesConfigured: { discovery: boolean; assignment: boolean } };
  discovery: {
    contract: string;
    sampleSize: number;
    instructionsChars: number;
    dataChars: number;
    outputSchemaSentChars: number;
    estimatedInputTokens: number;
    expectedOutputTokens: number;
    maxOutputTokens: number;
    expectedCostUsdPerCall: number;
    maxCostUsdPerCall: number;
  };
  assignment: {
    contract: string;
    questionSet: string;
    comments: number;
    batches: number;
    maxCommentsPerBatch: number;
    topicStepRequests: number;
    sentimentStepRequests: number;
    topicRequestChars: number;
    sentimentRequestChars: number;
    estimatedInputTokens: number;
    expectedCostUsd: number;
    taxonomyUsedForEstimate: string;
  };
  perRun: { requests: number; expectedCostUsd: number; maxCostUsd: number };
  total: { requests: number; maxRequests: number; estimatedCostUsd: number; maxCostUsd: number; withinLimit: boolean; limitUsd: number };
  renderedDiscovery: TopicModelRequest;
  renderedAssignmentExample: { topicStep: unknown; sentimentStep: unknown };
}

/**
 * Renders exactly what a live run sends and estimates its size and cost. Makes no network call. Token counts use the
 * repository's existing heuristic (characters / 4, as in the classifier benchmark); the assignment estimate uses the
 * gold taxonomy as a stand-in of the real taxonomy's size.
 */
export function buildTopicRealPreflight(dataset: TopicBenchmarkDataset, config: TopicProviderConfig, prices: PriceTable, env: Readonly<Record<string, string | undefined>>, repeats: number): TopicRealPreflight {
  const tokens = (chars: number) => Math.ceil(chars / config.estimation.charsPerToken);
  const classified = classifiedCommentsOf(dataset);
  const base = classified.filter((c) => c.classification.type !== "spam_irrelevant");
  const sample = selectDiscoverySample(base.map(discoveryCandidateOf), { ...DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, seed: TOPIC_BENCHMARK_SEED });
  const sampled = new Set(sample.commentIds);
  const context = { focus: dataset.focus, sentimentLabels: dataset.schema.sentimentLabels, maxTopics: TOPIC_BENCHMARK_PARAMETERS.maxTopics };
  const renderedDiscovery = buildTopicDiscoveryRequest({ sample: base.filter((c) => sampled.has(c.comment.id)).map((c) => ({ id: c.comment.id, text: c.comment.text })), context });
  const sentSchema = JSON.stringify(sentDiscoverySchema(config, renderedDiscovery.outputSchema));
  const discoveryInput = tokens(renderedDiscovery.instructions.length + renderedDiscovery.data.length + sentSchema.length);
  const dPrice = (out: number) => estimateCostUsd(prices, config.discovery.model, discoveryInput, out) ?? Number.NaN;

  // Assignment: one topic-step request per comment, one sentiment-step request per primary-topic comment.
  const jev = new JevTopicAssigner({ apiKey: "preflight-no-key", model: config.assignment.model, prices });
  const taxonomy = dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition }));
  let topicChars = 0;
  let sentimentChars = 0;
  for (const c of base) {
    topicChars += JSON.stringify(jev.buildTopicRequestBody(c.comment.text, dataset.focus, taxonomy)).length;
    sentimentChars += JSON.stringify(jev.buildSentimentRequestBody(c.comment.text, dataset.focus, taxonomy[0]!, dataset.schema.sentimentLabels)).length;
  }
  const share = config.estimation.sentimentStepShare;
  const topicStepRequests = base.length;
  const sentimentStepRequests = Math.ceil(base.length * share);
  const assignmentInput = tokens(topicChars) + Math.ceil(tokens(sentimentChars) * share);
  const assignmentCost = estimateCostUsd(prices, config.assignment.model, assignmentInput, 0) ?? Number.NaN;
  const example = base[0]!;

  const perRunRequests = 1 + topicStepRequests + sentimentStepRequests;
  const perRunExpected = dPrice(config.discovery.expectedOutputTokens) + assignmentCost;
  const perRunMax = dPrice(config.discovery.maxOutputTokens) + assignmentCost;
  const headroom = config.estimation.retryHeadroom;
  const total = perRunExpected * repeats * headroom;
  const totalMax = perRunMax * repeats * 2; // every attempt failing and retried in full
  return {
    apiCalls: 0,
    dataset: { id: dataset.id, version: dataset.version, comments: dataset.comments.length, topicBase: base.length, spamExcluded: dataset.comments.length - base.length },
    repeats,
    environment: [config.discovery.apiKeyEnv, config.assignment.apiKeyEnv].map((name) => ({ name, present: typeof env[name] === "string" && env[name]!.length > 0 })),
    models: { discoveryProvider: config.discovery.provider, discovery: config.discovery.model, assignment: config.assignment.model, pricesConfigured: { discovery: prices[config.discovery.model] !== undefined, assignment: prices[config.assignment.model] !== undefined } },
    discovery: {
      contract: renderedDiscovery.contract,
      sampleSize: sample.commentIds.length,
      instructionsChars: renderedDiscovery.instructions.length,
      dataChars: renderedDiscovery.data.length,
      outputSchemaSentChars: sentSchema.length,
      estimatedInputTokens: discoveryInput,
      expectedOutputTokens: config.discovery.expectedOutputTokens,
      maxOutputTokens: config.discovery.maxOutputTokens,
      expectedCostUsdPerCall: dPrice(config.discovery.expectedOutputTokens),
      maxCostUsdPerCall: dPrice(config.discovery.maxOutputTokens),
    },
    assignment: {
      contract: TOPIC_ASSIGNMENT_CONTRACT,
      questionSet: JEV_TOPIC_QUESTION_SET,
      comments: base.length,
      batches: BatchingTopicAssigner.batchesOf(base, config.assignment.maxCommentsPerBatch).length,
      maxCommentsPerBatch: config.assignment.maxCommentsPerBatch,
      topicStepRequests,
      sentimentStepRequests,
      topicRequestChars: topicChars,
      sentimentRequestChars: sentimentChars,
      estimatedInputTokens: assignmentInput,
      expectedCostUsd: assignmentCost,
      taxonomyUsedForEstimate: "gold taxonomy (stand-in for the size of the discovered taxonomy)",
    },
    perRun: { requests: perRunRequests, expectedCostUsd: perRunExpected, maxCostUsd: perRunMax },
    total: {
      requests: Math.ceil(perRunRequests * repeats * headroom),
      maxRequests: perRunRequests * repeats * 2,
      estimatedCostUsd: total,
      maxCostUsd: totalMax,
      withinLimit: Number.isFinite(totalMax) && totalMax <= config.limits.maxCostUsd,
      limitUsd: config.limits.maxCostUsd,
    },
    renderedDiscovery,
    renderedAssignmentExample: {
      topicStep: jev.buildTopicRequestBody(example.comment.text, dataset.focus, taxonomy),
      sentimentStep: jev.buildSentimentRequestBody(example.comment.text, dataset.focus, taxonomy[0]!, dataset.schema.sentimentLabels),
    },
  };
}

export function renderTopicRealPreflight(p: TopicRealPreflight, options: { showPrompts?: boolean } = {}): string {
  const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "unpriced");
  const lines = [
    "# Real topic providers: preflight",
    "",
    "NO API CALLS MADE",
    "",
    `Dataset ${p.dataset.id} (${p.dataset.version}): ${p.dataset.comments} comments, topic base ${p.dataset.topicBase}, spam excluded ${p.dataset.spamExcluded}. Repeats: ${p.repeats}.`,
    `Environment: ${p.environment.map((e) => `${e.name} ${e.present ? "present" : "MISSING"}`).join(", ")} (values never printed).`,
    `Discovery: ${p.models.discovery} (${p.discovery.contract}); price ${p.models.pricesConfigured.discovery ? "configured" : "MISSING"}.`,
    `Assignment: ${p.models.assignment} (${p.assignment.contract} as ${p.assignment.questionSet}); price ${p.models.pricesConfigured.assignment ? "configured" : "MISSING"}.`,
    "",
    "## Discovery (one call per attempt)",
    `- sample ${p.discovery.sampleSize} comments; instructions ${p.discovery.instructionsChars} chars, data ${p.discovery.dataChars} chars, output schema ${p.discovery.outputSchemaSentChars} chars`,
    `- input ≈ ${p.discovery.estimatedInputTokens} tokens; output ≈ ${p.discovery.expectedOutputTokens} expected (incl. ${p.models.discoveryProvider === "google" ? "thinking" : "adaptive thinking"}), ${p.discovery.maxOutputTokens} max`,
    `- cost per call ≈ ${usd(p.discovery.expectedCostUsdPerCall)} expected, ${usd(p.discovery.maxCostUsdPerCall)} max`,
    ...(p.models.discoveryProvider === "google" ? ["- Gemini prices are the paid-tier rates; a free-tier key is not billed, so these figures are an upper bound for it"] : []),
    "",
    "## Assignment (one logical call per attempt, batched)",
    `- ${p.assignment.comments} comments in ${p.assignment.batches} batches of ≤ ${p.assignment.maxCommentsPerBatch}; Jev requests: ${p.assignment.topicStepRequests} topic + up to ${p.assignment.sentimentStepRequests} sentiment`,
    `- input ≈ ${p.assignment.estimatedInputTokens} tokens (${p.assignment.taxonomyUsedForEstimate}); output unbilled`,
    `- cost ≈ ${usd(p.assignment.expectedCostUsd)} per run`,
    "",
    "## Totals",
    `- per run: ${p.perRun.requests} requests, ≈ ${usd(p.perRun.expectedCostUsd)} expected (${usd(p.perRun.maxCostUsd)} if discovery uses all output tokens)`,
    `- ${p.repeats} repeats with retry headroom: ≈ ${p.total.requests} requests (≤ ${p.total.maxRequests}), ≈ ${usd(p.total.estimatedCostUsd)} (worst case ${usd(p.total.maxCostUsd)})`,
    `- cost limit ${usd(p.total.limitUsd)}: ${p.total.withinLimit ? "worst case within limit" : "WORST CASE EXCEEDS LIMIT"}`,
    "",
    "## Rendered discovery instructions (system)",
    p.renderedDiscovery.instructions,
    "",
    "## Rendered discovery data (user)",
    options.showPrompts ? p.renderedDiscovery.data : `${p.renderedDiscovery.data.slice(0, 600)}… (${p.renderedDiscovery.data.length} chars; --show-prompts prints all)`,
    "",
    "## Rendered assignment request shape (one comment)",
    JSON.stringify(p.renderedAssignmentExample, null, options.showPrompts ? 2 : undefined).slice(0, options.showPrompts ? undefined : 1200),
    "",
    "NO API CALLS MADE",
  ];
  return lines.join("\n");
}

// ---------- live run (network; reached only with --live) ----------

export interface TopicRealUsage {
  repeat: number;
  discovery: UsageSummary & { modelsServed: string[] };
  assignment: UsageSummary & { modelsServed: string[]; batches: number; failedBatches: number };
  records: AiCallRecord[];
}

export interface TopicRealResult {
  meta: {
    timestamp: string;
    dataset: string;
    datasetVersion: string;
    repeats: number;
    discovery: { provider: "anthropic"; modelRequested: string; contract: string; effort: string; refusalFallback: string } | { provider: "google"; modelRequested: string; contract: string; thinkingLevel: string };
    assignment: { provider: string; modelRequested: string; contract: string; questionSet: string; maxCommentsPerBatch: number };
    validation: "production (frozen M4 validators, two attempts)";
  };
  report: TopicBenchmarkReport;
  usage: TopicRealUsage[];
  totals: { requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number | undefined; latencyMs: number; attempts: number[]; batches: number };
  /** Raw text of every rejected discovery response per repeat, secrets removed (diagnostics only; absent in older results). */
  discoveryRejectedOutputs?: { repeat: number; outputs: RejectedDiscoveryOutput[] }[];
}

export interface DiscoveryClients {
  anthropicClient?: ReturnType<typeof createAnthropicClient>;
  geminiClient?: ReturnType<typeof createGeminiClient>;
}

/**
 * Transport factory for the configured discovery provider (one transport per run, recording into its recorder).
 * The client is created here, before the first request, so a missing key fails locally. Shared by the real,
 * discovery-only and smoke suites.
 */
export function discoveryTransportFactory(d: DiscoveryProviderConfig, prices: PriceTable, apiKey: string, clients: DiscoveryClients = {}): (recorder: InMemoryUsageRecorder) => TopicModelTransport {
  if (d.provider === "google") {
    const client = clients.geminiClient ?? createGeminiClient(apiKey, { maxRetries: d.maxTransportRetries, timeoutMs: d.timeoutMs });
    return (recorder) => new GeminiTopicTransport({ client, model: d.model, maxOutputTokens: d.maxOutputTokens, thinkingLevel: d.thinkingLevel, prices, recorder });
  }
  if (!clients.anthropicClient && apiKey.trim().length === 0) throw new Error("Anthropic API key is missing; no request was made.");
  const client = clients.anthropicClient ?? createAnthropicClient(apiKey, { maxRetries: d.maxTransportRetries, timeoutMs: d.timeoutMs });
  return (recorder) => new AnthropicTopicTransport({ client, model: d.model, maxOutputTokens: d.maxOutputTokens, effort: d.effort, refusalFallback: d.refusalFallback, prices, recorder });
}

export interface TopicRealKeys {
  /** Key of the configured discovery provider (config.discovery.apiKeyEnv). */
  discoveryApiKey: string;
  jevApiKey: string;
}

/** Live benchmark: the oracle gate, then the configured discovery provider + Jev assignment on the dataset, `repeats` times. */
export async function runRealTopicBenchmark(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  keys: TopicRealKeys,
  repeats: number,
  deps: DiscoveryClients & {
    fetch?: typeof fetch;
    onProgress?: (message: string) => void;
    /**
     * EXPERIMENTAL hook (real-consolidated only): wraps the per-repeat discovery generator, e.g. to consolidate its
     * taxonomy before assignment. Absent for the real suite, which then runs exactly as before.
     */
    taxonomyStage?: { scenarioId: string; description: string; wrap: (discovery: TopicTaxonomyGenerator, transport: TopicModelTransport, repeat: number) => TopicTaxonomyGenerator };
  } = {},
): Promise<TopicRealResult> {
  const d = config.discovery;
  const newTransport = discoveryTransportFactory(d, prices, keys.discoveryApiKey, deps);
  const scenarioId = deps.taxonomyStage?.scenarioId ?? (d.provider === "anthropic" ? REAL_SCENARIO_ID : realScenarioIdFor(d.provider));
  const usage: TopicRealUsage[] = [];
  const pending: { repeat: number; discoveryRecorder: InMemoryUsageRecorder; assignmentRecorder: InMemoryUsageRecorder; batches: number; failedBatches: number; rejected: RejectedDiscoveryOutput[] }[] = [];
  let stopped = false;
  const scenario: TopicScenario = {
    id: scenarioId,
    group: "live",
    description: deps.taxonomyStage?.description ?? `Live: ${config.discovery.model} discovery (${TOPIC_DISCOVERY_CONTRACT}) + ${config.assignment.model} assignment (${JEV_TOPIC_QUESTION_SET}).`,
    taxonomySteps: [],
    assignmentSteps: [],
    providers: () => {
      if (stopped) throw new Error("Stopped after a provider configuration failure (see usage records).");
      const discoveryRecorder = new InMemoryUsageRecorder();
      const assignmentRecorder = new InMemoryUsageRecorder();
      const entry = { repeat: pending.length + 1, discoveryRecorder, assignmentRecorder, batches: 0, failedBatches: 0, rejected: [] as RejectedDiscoveryOutput[] };
      const transport = newTransport(discoveryRecorder);
      const jev = new JevTopicAssigner({
        apiKey: keys.jevApiKey,
        model: config.assignment.model,
        baseUrl: config.assignment.baseUrl,
        concurrency: config.assignment.concurrency,
        timeoutMs: config.assignment.timeoutMs,
        maxTransportRetries: config.assignment.maxTransportRetries,
        prices,
        recorder: assignmentRecorder,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      const assigner = new BatchingTopicAssigner(jev, {
        maxCommentsPerBatch: config.assignment.maxCommentsPerBatch,
        onBatch: (b) => {
          entry.batches += 1;
          if (b.failed) entry.failedBatches += 1;
          deps.onProgress?.(`repeat ${entry.repeat}: assignment batch ${b.index + 1} (${b.comments} comments)${b.failed ? " failed" : ""}`);
        },
      });
      pending.push(entry);
      const stop = () => {
        stopped = true;
      };
      const discovery = new ContractTopicTaxonomyGenerator(transport, { secrets: [keys.discoveryApiKey, keys.jevApiKey] });
      entry.rejected = discovery.rejectedOutputs;
      const generator = deps.taxonomyStage ? deps.taxonomyStage.wrap(discovery, transport, entry.repeat) : discovery;
      return { generator: new StoppingGenerator(generator, stop), assigner: new StoppingAssigner(assigner, stop) };
    },
    expected: { status: "available", attempts: 1, generatorCalls: 1, assignerCalls: 1, failedAttemptCodes: [], perfect: true, outcome: "ideal; any deviation is a measurement of the real providers, not a harness failure" },
  };
  const report = await runTopicBenchmarkScenarios(dataset, [buildTopicScenario(dataset, "oracle"), scenario], { repeats });
  for (const p of pending) {
    const served = (records: readonly AiCallRecord[]) => [...new Set(records.flatMap((r) => (r.modelVersion ? [r.modelVersion] : [])))];
    usage.push({
      repeat: p.repeat,
      discovery: { ...summarizeUsage(p.discoveryRecorder.entries), modelsServed: served(p.discoveryRecorder.entries) },
      assignment: { ...summarizeUsage(p.assignmentRecorder.entries), modelsServed: served(p.assignmentRecorder.entries), batches: p.batches, failedBatches: p.failedBatches },
      records: [...p.discoveryRecorder.entries, ...p.assignmentRecorder.entries],
    });
  }
  const all = usage.flatMap((u) => u.records);
  const summary = summarizeUsage(all);
  const live = report.scenarios.find((s) => s.id === scenarioId);
  return {
    meta: {
      timestamp: new Date().toISOString(),
      dataset: dataset.id,
      datasetVersion: dataset.version,
      repeats,
      discovery:
        d.provider === "google"
          ? { provider: "google", modelRequested: d.model, contract: TOPIC_DISCOVERY_CONTRACT, thinkingLevel: d.thinkingLevel }
          : { provider: "anthropic", modelRequested: d.model, contract: TOPIC_DISCOVERY_CONTRACT, effort: d.effort, refusalFallback: d.refusalFallback },
      assignment: { provider: "typesafe", modelRequested: config.assignment.model, contract: TOPIC_ASSIGNMENT_CONTRACT, questionSet: JEV_TOPIC_QUESTION_SET, maxCommentsPerBatch: config.assignment.maxCommentsPerBatch },
      validation: "production (frozen M4 validators, two attempts)",
    },
    report,
    usage,
    totals: {
      requests: summary.requests,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      estimatedCostUsd: summary.estimatedCostUsd,
      latencyMs: summary.latencyMs.total,
      attempts: live?.runs.map((r) => r.attempts) ?? [],
      batches: usage.reduce((s, u) => s + u.assignment.batches, 0),
    },
    discoveryRejectedOutputs: pending.map((p) => ({ repeat: p.repeat, outputs: [...p.rejected] })),
  };
}

/** Marks the run stopped when a provider reports a configuration failure, so later repeats do not call it again. */
class StoppingGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  constructor(
    private readonly inner: TopicTaxonomyGenerator,
    private readonly stop: () => void,
  ) {
    this.label = inner.label;
  }
  async proposeTaxonomy(request: Parameters<TopicTaxonomyGenerator["proposeTaxonomy"]>[0]): Promise<unknown> {
    try {
      return await this.inner.proposeTaxonomy(request);
    } catch (error) {
      if (error instanceof TopicProviderError && error.failure === "configuration") this.stop();
      throw error;
    }
  }
}

class StoppingAssigner implements TopicAssigner {
  readonly label: string;
  constructor(
    private readonly inner: TopicAssigner,
    private readonly stop: () => void,
  ) {
    this.label = inner.label;
  }
  async assignTopics(request: Parameters<TopicAssigner["assignTopics"]>[0]): Promise<unknown[]> {
    try {
      return await this.inner.assignTopics(request);
    } catch (error) {
      if (error instanceof TopicProviderError && error.failure === "configuration") this.stop();
      throw error;
    }
  }
}

/** Topic-specific result filename in the existing benchmark-results convention. */
export function realResultFileName(result: TopicRealResult): string {
  return `${result.meta.timestamp}-topics-${result.meta.dataset}-${result.meta.discovery.provider}-${result.meta.discovery.modelRequested}-typesafe-${result.meta.assignment.modelRequested}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";
}

