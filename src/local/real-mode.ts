import { createAnthropicClient } from "../adapters/ai/anthropic/anthropic-classifier";
import { AnthropicTopicTransport, type AnthropicEffort } from "../adapters/ai/anthropic/anthropic-topic-transport";
import { JevClassifier } from "../adapters/ai/typesafe/jev-classifier";
import { isJevQuestionSetVersion, type JevQuestionSetVersion } from "../adapters/ai/typesafe/jev-question-sets";
import { JevTopicAssigner } from "../adapters/ai/typesafe/jev-topic-assigner";
import { JEV_TOPIC_QUESTION_SET } from "../adapters/ai/typesafe/jev-topic-questions";
import { FakeClassifier } from "../adapters/fakes/fake-classifier";
import { DEFAULT_FIXTURE_DATASET, FIXTURE_DATASETS, FixtureDatasetSource, isFixtureDatasetId, type FixtureDatasetId } from "../adapters/fixtures/fixture-dataset-source";
import { SyntheticCommentSource } from "../adapters/fixtures/synthetic-comment-source";
import { YouTubeCommentSource } from "../adapters/youtube/youtube-comment-source";
import type { AnalyzeVideoDeps, AnalyzeVideoResult } from "../application/analyze-video-sync";
import { BatchingTopicAssigner } from "../application/batching-topic-assigner";
import { ContractTopicTaxonomyGenerator } from "../application/contract-topic-phases";
import { ConcurrentClassifier, CostGuardedClassifier, CostGuardedTopicAssigner, CostGuardedTopicTransport } from "../application/cost-guards";
import {
  ProgressClassifier,
  ProgressCommentSource,
  ProgressTaxonomyGenerator,
  ProgressTopicAssigner,
  ProgressTopicDiscoverer,
  ProgressTopicTransport,
  type ProgressTracker,
} from "../application/progress";
import type { AnalysisRunInfo, PipelineStage } from "../application/run-info";
import { ConsolidatingTopicTaxonomyGenerator, TopicBaseObserver } from "../application/topic-consolidation";
import { TwoPhaseTopicDiscoverer } from "../application/two-phase-topic-discoverer";
import { DEFAULT_ANALYSIS_PARAMETERS } from "../core/aggregation/aggregate";
import { CostBudget } from "../core/cost/budget";
import { estimateCostUsd, type PriceTable } from "../core/cost/usage";
import { createCompliancePolicy, STRICT_POLICY_CONFIG, type CompliancePolicy } from "../core/policy/compliance-policy";
import type { CommentSource } from "../core/ports";
import { DEFAULT_TOPIC_PARAMETERS } from "../core/topics/aggregate-topics";
import { isTopicConsolidationContract, type TopicConsolidationContract } from "../core/topics/consolidation-contract";
import { TOPIC_ASSIGNMENT_CONTRACT, TOPIC_DISCOVERY_CONTRACTS, type TopicDiscoveryContract } from "../core/topics/provider-contracts";
import cg1Exception from "../../config/compliance/cg1-internal-testing-exception.json";
import modelPrices from "../../config/model-prices.json";
import realModeConfig from "../../config/real-mode.json";
import topicProviders from "../../config/topic-providers.json";

// Mode selection for the local app (composition only; nothing here is reachable from the browser).
// - demo (default): synthetic comments + fake classifier, no topics: exactly the M2 wiring, no network.
// - real (ANALYSIS_MODE=real, EXPERIMENTAL, local only): official YouTube Data API source, Jev classification, then the
//   validated topic pipeline (Sonnet discovery v2 → Sonnet consolidation v3 → Jev assignment), every AI call behind a
//   fresh per-analysis cost cap.
// Selecting real mode does NOT change the compliance policy by itself: CG-1 blocks real YouTube comments (before any
// retrieval or AI call) unless the recorded, time-limited internal-testing exception holds, which needs its own
// conditions (active record, not expired, local development server). Demo mode is always strict.
// - real + ANALYSIS_SOURCE=fixture (development/testing only): the same real AI pipeline on a permitted synthetic
//   development dataset (FIXTURE_DATASET: m2 or t1-topics-v1, default t1-topics-v1) instead of YouTube. No YouTube
//   request is made, the CG-1 exception is not evaluated (the data is not YouTube data) and the strict policy
//   applies. Validation and hold-out sets (t2–t5, m2-heldout-v1) are refused.
// Secrets are passed to adapters only; they are never logged or returned.

export type AnalysisMode = "demo" | "real";

export const ANALYSIS_MODE_ENV = "ANALYSIS_MODE";
export const REAL_MODE_KEY_ENVS = ["YOUTUBE_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY"] as const;
/** Fixture-source analysis reads no YouTube data, so it needs only the AI keys. */
export const FIXTURE_SOURCE_KEY_ENVS = ["ANTHROPIC_API_KEY", "JEV_API_KEY"] as const;
export const ANALYSIS_SOURCE_ENV = "ANALYSIS_SOURCE";
export const FIXTURE_DATASET_ENV = "FIXTURE_DATASET";
/** Validation and hold-out sets: refused so they are never used to tune the analysis. */
export const EVALUATION_DATASETS = ["t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1", "m2-heldout-v1"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export type ModeSelection = { ok: true; mode: AnalysisMode } | { ok: false; message: string };

/** Unset or empty → demo. Anything other than demo/real is a configuration error, never a silent fallback. */
export function selectAnalysisMode(env: Env): ModeSelection {
  const raw = env[ANALYSIS_MODE_ENV]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "demo") return { ok: true, mode: "demo" };
  if (raw === "real") return { ok: true, mode: "real" };
  return { ok: false, message: `${ANALYSIS_MODE_ENV} must be "demo" or "real".` };
}

export type RealSource = { kind: "youtube" } | { kind: "fixture"; dataset: FixtureDatasetId };
export type SourceSelection = { ok: true; source: RealSource } | { ok: false; message: string };

/**
 * Real-mode comment source. ANALYSIS_SOURCE unset/empty/youtube → YouTube; fixture → FIXTURE_DATASET (default
 * t1-topics-v1; `m2` is short for m2-synthetic). Held-out and unknown datasets are configuration errors.
 */
export function selectAnalysisSource(env: Env): SourceSelection {
  const raw = env[ANALYSIS_SOURCE_ENV]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "youtube") return { ok: true, source: { kind: "youtube" } };
  if (raw !== "fixture") return { ok: false, message: `${ANALYSIS_SOURCE_ENV} must be "youtube" or "fixture".` };
  const requested = env[FIXTURE_DATASET_ENV]?.trim() || DEFAULT_FIXTURE_DATASET;
  const dataset = requested === "m2" ? "m2-synthetic" : requested;
  if ((EVALUATION_DATASETS as readonly string[]).includes(dataset)) {
    return { ok: false, message: `${FIXTURE_DATASET_ENV}=${dataset} is validation or hold-out evaluation data and is refused, so it is never used to tune the analysis.` };
  }
  if (!isFixtureDatasetId(dataset)) return { ok: false, message: `${FIXTURE_DATASET_ENV} must be one of: m2 (m2-synthetic), t1-topics-v1.` };
  return { ok: true, source: { kind: "fixture", dataset } };
}

/** The strict compliance policy: demo mode always, and real mode unless the CG-1 internal-testing exception holds. */
export function localCompliancePolicy(): CompliancePolicy {
  return createCompliancePolicy(STRICT_POLICY_CONFIG);
}

// ---------- CG-1 internal-testing exception (docs/compliance/cg1-internal-testing-exception.md) ----------

/** Longest an exception may run from its decision date; a longer record is treated as invalid. */
export const MAX_EXCEPTION_DAYS = 90;

export type Cg1Gate =
  | { state: "blocked"; reason: "no_record" | "invalid_record" | "not_active" | "not_yet_valid" | "expired" | "not_local_development" }
  | { state: "internal_testing"; id: string; expiresOn: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Evaluates the recorded CG-1 exception. It applies only to the local development server (NODE_ENV=development, i.e.
 * `npm run dev`), only while `status` is active and `today` is within [decidedOn, expiresOn], and only for a record
 * of at most MAX_EXCEPTION_DAYS. Anything else, including a malformed record, leaves CG-1 blocked.
 */
export function evaluateCg1Exception(record: unknown, context: { nodeEnv: string | undefined; today: string }): Cg1Gate {
  if (record === undefined || record === null) return { state: "blocked", reason: "no_record" };
  const r = record as Record<string, unknown>;
  const dates = [r.decidedOn, r.expiresOn];
  if (
    typeof record !== "object" ||
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    r.scope !== "local_internal_testing" ||
    typeof r.decidedBy !== "string" ||
    r.decidedBy.trim().length === 0 ||
    !dates.every((d) => typeof d === "string" && ISO_DATE.test(d) && !Number.isNaN(Date.parse(d))) ||
    (Date.parse(r.expiresOn as string) - Date.parse(r.decidedOn as string)) / 86_400_000 > MAX_EXCEPTION_DAYS ||
    (r.expiresOn as string) < (r.decidedOn as string)
  ) {
    return { state: "blocked", reason: "invalid_record" };
  }
  if (r.status !== "active") return { state: "blocked", reason: "not_active" };
  if (context.today < (r.decidedOn as string)) return { state: "blocked", reason: "not_yet_valid" };
  if (context.today > (r.expiresOn as string)) return { state: "blocked", reason: "expired" };
  if (context.nodeEnv !== "development") return { state: "blocked", reason: "not_local_development" };
  return { state: "internal_testing", id: r.id, expiresOn: r.expiresOn as string };
}

/** Today's date (UTC) as YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The policy for a real-mode analysis: strict, except `internal_testing` while the exception holds. */
export function realModePolicy(gate: Cg1Gate): CompliancePolicy {
  return gate.state === "internal_testing" ? createCompliancePolicy({ ...STRICT_POLICY_CONFIG, youtubeDerivedAnalytics: "internal_testing" }) : localCompliancePolicy();
}

/** The CG-1 gate for real mode from the committed record and the server environment. */
export function realModeGate(env: Env, overrides: { record?: unknown; today?: string } = {}): Cg1Gate {
  const record = "record" in overrides ? overrides.record : cg1Exception;
  return evaluateCg1Exception(record, { nodeEnv: env.NODE_ENV, today: overrides.today ?? todayUtc() });
}

/** Demo wiring, unchanged from M2. */
export function demoDeps(): AnalyzeVideoDeps {
  return {
    source: new SyntheticCommentSource(),
    classifier: new FakeClassifier(),
    policy: localCompliancePolicy(),
    mixedSentimentEnabled: false,
    params: DEFAULT_ANALYSIS_PARAMETERS,
  };
}

export interface RealModeSettings {
  maxComments: number;
  youtubeTimeoutMs: number;
  maxCostUsd: number;
  discoveryContract: TopicDiscoveryContract;
  consolidationContract: TopicConsolidationContract;
  discoverySampleSeed: string;
  classifier: { model: string; questionSet: string; concurrency: number; timeoutMs: number; maxRetries: number; worstCaseInputTokensPerComment: number; worstCaseOutputTokensPerComment: number };
  assignment: { worstCaseInputTokensPerComment: number; worstCaseOutputTokensPerComment: number };
  discovery: { charsPerToken: number; inputHeadroom: number };
  discoveryProvider: { model: string; effort: AnthropicEffort; refusalFallback: "default" | "off"; maxOutputTokens: number; timeoutMs: number; maxTransportRetries: number };
  assignmentProvider: { model: string; baseUrl: string; maxCommentsPerBatch: number; concurrency: number; timeoutMs: number; maxTransportRetries: number };
  prices: PriceTable;
}

/** Settings from config/real-mode.json + config/topic-providers.json + config/model-prices.json, checked. */
export function realModeSettings(): RealModeSettings {
  const r = realModeConfig;
  const d = topicProviders.discovery;
  const a = topicProviders.assignment;
  const settings: RealModeSettings = {
    maxComments: r.youtube.maxComments,
    youtubeTimeoutMs: r.youtube.timeoutMs,
    maxCostUsd: r.maxCostUsd,
    discoveryContract: r.discoveryContract as TopicDiscoveryContract,
    consolidationContract: r.consolidationContract as TopicConsolidationContract,
    discoverySampleSeed: r.discoverySampleSeed,
    classifier: { ...r.classifier },
    assignment: { ...r.assignment },
    discovery: { ...r.discovery },
    discoveryProvider: {
      model: d.model,
      effort: d.effort as AnthropicEffort,
      refusalFallback: d.refusalFallback as "default" | "off",
      maxOutputTokens: d.maxOutputTokens,
      timeoutMs: d.timeoutMs,
      maxTransportRetries: d.maxTransportRetries,
    },
    assignmentProvider: { model: a.model, baseUrl: a.baseUrl, maxCommentsPerBatch: a.maxCommentsPerBatch, concurrency: a.concurrency, timeoutMs: a.timeoutMs, maxTransportRetries: a.maxTransportRetries },
    prices: modelPrices.prices,
  };
  const problems: string[] = [];
  if (!(TOPIC_DISCOVERY_CONTRACTS as readonly string[]).includes(settings.discoveryContract)) problems.push("discoveryContract");
  if (!isTopicConsolidationContract(settings.consolidationContract)) problems.push("consolidationContract");
  if (d.provider !== "anthropic") problems.push("topic-providers discovery.provider must be anthropic");
  if (a.provider !== "typesafe") problems.push("topic-providers assignment.provider must be typesafe");
  if (r.classifier.provider !== "typesafe" || !isJevQuestionSetVersion(settings.classifier.questionSet)) problems.push("classifier");
  if (!(settings.maxCostUsd > 0)) problems.push("maxCostUsd");
  if (!(Number.isInteger(settings.maxComments) && settings.maxComments >= 1)) problems.push("youtube.maxComments");
  for (const model of [settings.classifier.model, settings.discoveryProvider.model, settings.assignmentProvider.model]) {
    if (!settings.prices[model]) problems.push(`no price for ${model}`);
  }
  if (problems.length > 0) throw new Error(`Invalid real-mode configuration: ${problems.join(", ")}`);
  return settings;
}

export interface RealAnalysis {
  deps: AnalyzeVideoDeps;
  budget: CostBudget;
  /** YouTube input with the CG-1 gate it ran under, or a fixture dataset (no gate: not YouTube data). */
  input: { kind: "youtube"; gate: Cg1Gate } | { kind: "fixture"; dataset: FixtureDatasetId; comments: number };
}

export interface RealModeOverrides {
  /** Test hook: replaces the network for YouTube and Jev. */
  fetch?: typeof fetch;
  /** Test hook: replaces the YouTube source. */
  source?: CommentSource;
  settings?: RealModeSettings;
  /** Test hooks: the exception record (undefined = none) and today's date. */
  cg1Record?: unknown;
  today?: string;
  /** Stage-progress observer for the UI. Observes calls only; requests, results and errors pass through unchanged. */
  progress?: ProgressTracker;
}

/** What the local app is set up to analyse, for display (computed from configuration only; nothing is called). */
export type AnalysisSetup = { mode: "demo" } | { mode: "real"; input: RealAnalysis["input"] } | { mode: "misconfigured"; message: string };

export function analysisSetup(env: Env): AnalysisSetup {
  const mode = selectAnalysisMode(env);
  if (!mode.ok) return { mode: "misconfigured", message: mode.message };
  if (mode.mode === "demo") return { mode: "demo" };
  const source = selectAnalysisSource(env);
  if (!source.ok) return { mode: "misconfigured", message: source.message };
  if (source.source.kind === "fixture") {
    return { mode: "real", input: { kind: "fixture", dataset: source.source.dataset, comments: FIXTURE_DATASETS[source.source.dataset].length } };
  }
  return { mode: "real", input: { kind: "youtube", gate: realModeGate(env) } };
}

export type RealModeBuild = { ok: true; analysis: RealAnalysis } | { ok: false; message: string };

/**
 * Fresh real-mode dependencies for ONE analysis: a new cost budget and new adapters recording into it. Missing keys
 * are a configuration error (named by variable, never by value). Nothing is called here.
 */
export function createRealAnalysis(env: Env, overrides: RealModeOverrides = {}): RealModeBuild {
  const selection = selectAnalysisSource(env);
  if (!selection.ok) return { ok: false, message: selection.message };
  const fromFixture = selection.source.kind === "fixture";
  const required = fromFixture ? FIXTURE_SOURCE_KEY_ENVS : REAL_MODE_KEY_ENVS;
  const missing = required.filter((name) => (env[name] ?? "").trim().length === 0);
  if (missing.length > 0) return { ok: false, message: `Real mode needs ${missing.join(", ")} in the local .env file.` };
  const anthropicKey = env.ANTHROPIC_API_KEY!;
  const jevKey = env.JEV_API_KEY!;
  const s = overrides.settings ?? realModeSettings();
  const budget = new CostBudget(s.maxCostUsd);
  const fetchOverride = overrides.fetch ? { fetch: overrides.fetch } : {};

  // Fixture input: no YouTube source is even constructed, and the CG-1 exception is not evaluated.
  let source: CommentSource;
  let input: RealAnalysis["input"];
  if (selection.source.kind === "fixture") {
    const fixture = new FixtureDatasetSource(selection.source.dataset);
    source = fixture;
    input = { kind: "fixture", dataset: fixture.dataset, comments: fixture.size };
  } else {
    source = overrides.source ?? new YouTubeCommentSource({ apiKey: env.YOUTUBE_API_KEY!, maxComments: s.maxComments, timeoutMs: s.youtubeTimeoutMs, ...fetchOverride });
    input = { kind: "youtube", gate: realModeGate(env, { ...("cg1Record" in overrides ? { record: overrides.cg1Record } : {}), ...(overrides.today ? { today: overrides.today } : {}) }) };
  }

  const c = s.classifier;
  const perCommentClassification = estimateCostUsd(s.prices, c.model, c.worstCaseInputTokensPerComment, c.worstCaseOutputTokensPerComment) ?? Number.NaN;
  const jevClassifier = new JevClassifier({
    apiKey: jevKey,
    model: c.model,
    // Checked by realModeSettings.
    questionSet: c.questionSet as JevQuestionSetVersion,
    timeoutMs: c.timeoutMs,
    maxRetries: c.maxRetries,
    prices: s.prices,
    recorder: budget,
    ...fetchOverride,
  });
  const guardedClassifier = new ConcurrentClassifier(new CostGuardedClassifier(jevClassifier, budget, (req) => req.comments.length * perCommentClassification), c.concurrency);
  const progress = overrides.progress;
  const classifier = progress ? new ProgressClassifier(guardedClassifier, progress) : guardedClassifier;

  const dp = s.discoveryProvider;
  const client = createAnthropicClient(anthropicKey, { maxRetries: dp.maxTransportRetries, timeoutMs: dp.timeoutMs });
  const transport = new AnthropicTopicTransport({ client, model: dp.model, maxOutputTokens: dp.maxOutputTokens, effort: dp.effort, refusalFallback: dp.refusalFallback, prices: s.prices, recorder: budget });
  const discoveryWorstCase = (request: { instructions: string; data: string; outputSchema: Record<string, unknown> }): number => {
    const chars = request.instructions.length + request.data.length + JSON.stringify(request.outputSchema).length;
    const inputTokens = Math.ceil((chars / s.discovery.charsPerToken) * s.discovery.inputHeadroom);
    return estimateCostUsd(s.prices, dp.model, inputTokens, dp.maxOutputTokens) ?? Number.NaN;
  };
  // Discovery and consolidation use the same Anthropic model and settings, both behind the cost cap.
  const guardedTransport = new CostGuardedTopicTransport(transport, budget, discoveryWorstCase);
  const contractDiscovery = new ContractTopicTaxonomyGenerator(guardedTransport, {
    contract: s.discoveryContract,
    secrets: [env.YOUTUBE_API_KEY ?? "", anthropicKey, jevKey].filter((k) => k.length > 0),
  });
  const discovery = progress ? new ProgressTaxonomyGenerator(contractDiscovery, progress) : contractDiscovery;
  const consolidationTransport = progress ? new ProgressTopicTransport(guardedTransport, progress, "consolidating") : guardedTransport;
  let topicBase: TopicBaseObserver | undefined;
  const generator = new ConsolidatingTopicTaxonomyGenerator(discovery, consolidationTransport, () => topicBase!.evidence(), s.consolidationContract);

  const ap = s.assignmentProvider;
  const perCommentAssignment = estimateCostUsd(s.prices, ap.model, s.assignment.worstCaseInputTokensPerComment, s.assignment.worstCaseOutputTokensPerComment) ?? Number.NaN;
  const jevAssigner = new JevTopicAssigner({
    apiKey: jevKey,
    model: ap.model,
    baseUrl: ap.baseUrl,
    concurrency: ap.concurrency,
    timeoutMs: ap.timeoutMs,
    maxTransportRetries: ap.maxTransportRetries,
    prices: s.prices,
    recorder: budget,
    ...fetchOverride,
  });
  const batchingAssigner = new BatchingTopicAssigner(new CostGuardedTopicAssigner(jevAssigner, budget, (req) => req.comments.length * perCommentAssignment), {
    maxCommentsPerBatch: ap.maxCommentsPerBatch,
  });
  const assigner = progress ? new ProgressTopicAssigner(batchingAssigner, progress) : batchingAssigner;

  topicBase = new TopicBaseObserver(new TwoPhaseTopicDiscoverer({ generator, assigner, sample: { seed: s.discoverySampleSeed } }), DEFAULT_TOPIC_PARAMETERS);
  const deps: AnalyzeVideoDeps = {
    source: progress ? new ProgressCommentSource(source, progress) : source,
    classifier,
    policy: input.kind === "youtube" ? realModePolicy(input.gate) : localCompliancePolicy(),
    mixedSentimentEnabled: false,
    params: DEFAULT_ANALYSIS_PARAMETERS,
    topics: { discoverer: progress ? new ProgressTopicDiscoverer(topicBase, progress) : topicBase },
    costLimit: budget,
  };
  return { ok: true, analysis: { deps, budget, input } };
}

/**
 * One telemetry line per analysis: outcome, counts, AI requests and estimated cost. Built only from these fields, so
 * it can never carry comment text, URLs or keys.
 */
export interface AnalysisTelemetry {
  mode: AnalysisMode;
  /** "youtube", or "fixture:<dataset>". */
  input?: string;
  status: AnalyzeVideoResult["status"];
  sourceFailure?: string;
  commentsRetrieved?: number;
  commentsAnalysed?: number;
  topics?: string;
  topicCount?: number;
  aiRequests: number;
  aiFailedRequests: number;
  aiRequestsByProvider: Record<string, number>;
  estimatedCostUsd: number;
  costLimitUsd?: number;
  durationMs: number;
}

export function analysisTelemetry(mode: AnalysisMode, result: AnalyzeVideoResult, budget: CostBudget | undefined, durationMs: number, input?: RealAnalysis["input"]): AnalysisTelemetry {
  const entries = budget?.entries ?? [];
  const byProvider: Record<string, number> = {};
  for (const e of entries) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
  return {
    mode,
    ...(input ? { input: input.kind === "fixture" ? `fixture:${input.dataset}` : "youtube" } : {}),
    status: result.status,
    ...(result.status === "source_unavailable" ? { sourceFailure: result.reason } : {}),
    ...(result.status === "ok"
      ? {
          commentsRetrieved: result.report.commentsRetrieved,
          commentsAnalysed: result.report.commentsAnalysed,
          topics: result.report.topics.status,
          ...(result.report.topics.status === "available" ? { topicCount: result.report.topics.topics.length } : {}),
        }
      : {}),
    aiRequests: entries.length,
    aiFailedRequests: entries.filter((e) => e.outcome !== "ok").length,
    aiRequestsByProvider: byProvider,
    estimatedCostUsd: Math.round((budget?.spentUsd() ?? 0) * 1e6) / 1e6,
    ...(budget ? { costLimitUsd: budget.limitUsd } : {}),
    durationMs: Math.round(durationMs),
  };
}

export const PROVIDER_FAILURE_RESULT: AnalyzeVideoResult = {
  status: "analysis_failed",
  failed: 0,
  total: 0,
  message: "The analysis failed because a provider returned an error. No report was produced.",
};

// ---------- display: effective pipeline and run info ----------

export const DEMO_PIPELINE: readonly PipelineStage[] = Object.freeze([{ role: "Classification", component: "Fake classifier (keyword rules); no topics" }]);

/** The effective real-mode pipeline, stage by stage, from the same settings the analysis is built from. */
export function realPipeline(s: RealModeSettings = realModeSettings()): PipelineStage[] {
  const d = s.discoveryProvider;
  return [
    { role: "Classification", component: `Jev ${s.classifier.model} · ${s.classifier.questionSet}` },
    { role: "Topic discovery", component: `Sonnet ${d.model} · ${s.discoveryContract} · effort ${d.effort}` },
    { role: "Topic consolidation", component: `Sonnet ${d.model} · ${s.consolidationContract}` },
    { role: "Topic assignment", component: `Jev ${s.assignmentProvider.model} · ${JEV_TOPIC_QUESTION_SET} (${TOPIC_ASSIGNMENT_CONTRACT})` },
  ];
}

export function realRunInfo(analysis: RealAnalysis, durationMs: number, settings: RealModeSettings = realModeSettings()): AnalysisRunInfo {
  const entries = analysis.budget.entries;
  const requestsByProvider: Record<string, number> = {};
  for (const e of entries) requestsByProvider[e.provider] = (requestsByProvider[e.provider] ?? 0) + 1;
  return {
    mode: "real",
    input: analysis.input.kind === "fixture" ? { kind: "fixture", dataset: analysis.input.dataset, comments: analysis.input.comments } : { kind: "youtube" },
    durationMs: Math.round(durationMs),
    pipeline: realPipeline(settings),
    usage: {
      requests: entries.length,
      failedRequests: entries.filter((e) => e.outcome !== "ok").length,
      requestsByProvider,
      estimatedCostUsd: Math.round(analysis.budget.spentUsd() * 1e6) / 1e6,
      costLimitUsd: analysis.budget.limitUsd,
    },
  };
}
