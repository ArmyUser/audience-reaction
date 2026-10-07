import { renderTopicBenchmarkMarkdown, type TopicBenchmarkReport } from "./topic-benchmark";
import {
  consolidationProvenance,
  DIAGNOSTIC_NOTICE,
  REAL_CONSOLIDATED_RESULT_SCHEMA,
  runDiagnosticsOf,
  snapshotTaxonomy,
  type ConsolidationAttemptDetail,
  type ConsolidationDiagnostics,
  type DiscoveryCandidateRecord,
  type RunDiagnostics,
} from "./topic-consolidated-diagnostics";
import type { TopicBenchmarkDataset } from "./topic-datasets";
import { buildConsolidatedBenchmarkPlan, consolidationContextOf, consolidationDecisions, ContractTaxonomyConsolidator, runConsolidationAttempts, type ConsolidationDecisions, type ConsolidationResult } from "./topic-discovery-consolidated";
import type { DiscoveryAttemptRecord } from "./topic-discovery-only";
import { buildTopicRealPreflight, runRealTopicBenchmark, type DiscoveryClients, type TopicProviderConfig, type TopicRealKeys, type TopicRealResult } from "./topic-real";
import type { TaxonomyConsolidator } from "./topic-discovery-consolidated";
import { MAX_TOPIC_ATTEMPTS } from "../application/analyze-topics";
import { summarizeUsage, type AiCallRecord, type PriceTable, type UsageSummary } from "../core/cost/usage";
import type { TopicModelTransport, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../core/ports";
import { TOPIC_CONSOLIDATION_CONTRACT, type TopicConsolidationContract } from "../core/topics/consolidation-contract";
import { TOPIC_DISCOVERY_CONTRACT, TopicProviderError, type TopicProviderFailure } from "../core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../core/topics/taxonomy";
import type { TopicIssueCode, TopicValidationFeedback } from "../core/topics/types";
import { compareIds, TopicDiscoveryOutputError } from "../core/topics/validation";

// EXPERIMENTAL real-consolidated suite: the real suite with one change in how the taxonomy is produced:
//   discovery (topic-discovery-v2) → consolidation (TOPIC_CONSOLIDATION_CONTRACT) → the production pipeline unchanged
//   (TwoPhaseTopicDiscoverer validation → Jev assignment and topic sentiment → analyzeTopics → report) → the full t1
//   evaluator, exactly as in the real suite (runRealTopicBenchmark with its taxonomy-stage hook). Only the taxonomy
//   handed to the discoverer differs, so the full metrics are directly comparable with the real suite.
// Failure semantics: discovery keeps the production rule (an invalid taxonomy or provider error is retried once by
// analyzeTopics with feedback). Consolidation keeps its own rule (at most two attempts with feedback); if it still
// fails, the run ends as unavailable: the remaining analysis attempt fails without new provider calls. The
// unconsolidated taxonomy is never used as a fallback.

export function realConsolidatedNotice(contract: TopicConsolidationContract = TOPIC_CONSOLIDATION_CONTRACT): string {
  return `EXPERIMENTAL REAL-CONSOLIDATED RESULT: discovery → taxonomy consolidation (${contract}, experimental) → the unchanged production pipeline (Jev assignment, topic sentiment, report) → the full benchmark evaluator. NOT part of production yet. Scored by the same evaluator as the real suite, so the full metrics are comparable with it; only the taxonomy path differs.`;
}

export const REAL_CONSOLIDATED_NOTICE = realConsolidatedNotice();

export function realConsolidatedScenarioId(provider: string): string {
  return `real-consolidated-${provider}-discovery-jev-assignment`;
}

/** Consolidation failed after its own retry; the run ends as unavailable (analyzeTopics reports provider_error). */
export class ConsolidationUnavailableError extends Error {
  override readonly name = "ConsolidationUnavailableError";
  constructor() {
    super("taxonomy consolidation failed after its retry");
  }
}

export interface TaxonomyCallRecord {
  /** The analysis attempt (1 or 2) that asked for a taxonomy. */
  call: number;
  discovery: { outcome: "valid" | "invalid_taxonomy" | "provider_error" | "not_called"; issueCodes: TopicIssueCode[]; providerFailure?: TopicProviderFailure; topics: number | null };
  consolidation: { status: ConsolidationResult["status"] | "not_run"; attempts: DiscoveryAttemptRecord[]; topics: number | null; decisions: ConsolidationDecisions | null };
}

/**
 * Diagnostic instrumentation of one taxonomy call (result schema v2), kept apart from TaxonomyCallRecord so the
 * phase record stays exactly as before. Observes only; nothing here changes a request, a response or a decision.
 */
export interface TaxonomyCallInstrumentation {
  call: number;
  /** The validated discovery taxonomy before consolidation (null when discovery did not produce one). */
  candidate: DiscoveryCandidateRecord | null;
  consolidationAttempts: ConsolidationAttemptDetail[];
  /** Candidate-to-final provenance of the accepted consolidation (null when none was accepted). */
  provenance: ConsolidationDiagnostics | null;
}

/** Who answered the taxonomy calls (recorded in the instrumentation; never sent anywhere). */
export interface TaxonomySource {
  provider: string;
  model: string;
}

/** Passes every call through unchanged and remembers the retry feedback each consolidation request carried. */
class FeedbackRecordingConsolidator implements TaxonomyConsolidator {
  readonly label: string;
  readonly feedback: (TopicValidationFeedback | null)[] = [];
  constructor(private readonly inner: TaxonomyConsolidator) {
    this.label = inner.label;
  }
  consolidate(request: Parameters<TaxonomyConsolidator["consolidate"]>[0]): Promise<unknown> {
    this.feedback.push(request.feedback ? structuredClone(request.feedback) : null);
    return this.inner.consolidate(request);
  }
}

/**
 * The taxonomy generator of one real-consolidated run: discovery, the frozen taxonomy validator on the candidate
 * (a rejection is thrown exactly as TwoPhaseTopicDiscoverer would throw it), then consolidation with its own retry.
 * Returns the consolidated proposal in the discovery output format; TwoPhaseTopicDiscoverer validates it again and
 * assigns against it.
 */
export class ConsolidatingTaxonomyGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  readonly calls: TaxonomyCallRecord[] = [];
  readonly instrumentation: TaxonomyCallInstrumentation[] = [];
  private exhausted = false;

  constructor(
    private readonly discovery: TopicTaxonomyGenerator,
    private readonly transport: TopicModelTransport,
    private readonly evidence: { topicBase: number; minTopicSize: number },
    private readonly source: TaxonomySource = { provider: "unknown", model: "unknown" },
    private readonly contract: TopicConsolidationContract = TOPIC_CONSOLIDATION_CONTRACT,
  ) {
    this.label = `${discovery.label} → consolidation (${contract})`;
  }

  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    const record: TaxonomyCallRecord = { call: this.calls.length + 1, discovery: { outcome: "not_called", issueCodes: [], topics: null }, consolidation: { status: "not_run", attempts: [], topics: null, decisions: null } };
    this.calls.push(record);
    const instrumented: TaxonomyCallInstrumentation = { call: record.call, candidate: null, consolidationAttempts: [], provenance: null };
    this.instrumentation.push(instrumented);
    // Consolidation already failed after its retry in this run: end it as unavailable, without calling a provider.
    if (this.exhausted) throw new ConsolidationUnavailableError();

    let raw: unknown;
    try {
      raw = await this.discovery.proposeTaxonomy(request);
    } catch (error) {
      if (error instanceof TopicDiscoveryOutputError) record.discovery = { outcome: "invalid_taxonomy", issueCodes: codesOf(error.issues), topics: null };
      else record.discovery = { outcome: "provider_error", issueCodes: ["provider_error"], ...(error instanceof TopicProviderError ? { providerFailure: error.failure } : {}), topics: null };
      throw error;
    }
    const candidate = validateTopicTaxonomy(raw, { sampleCommentIds: request.sample.map((c) => c.id), maxTopics: request.context.maxTopics });
    if (candidate.status === "invalid") {
      record.discovery = { outcome: "invalid_taxonomy", issueCodes: codesOf(candidate.issues), topics: null };
      throw new TopicDiscoveryOutputError(candidate.issues);
    }
    record.discovery = { outcome: "valid", issueCodes: [], topics: candidate.taxonomy.topics.length };
    const candidateTopics = snapshotTaxonomy(candidate.taxonomy);
    instrumented.candidate = { attempt: record.call, ...this.source, contract: TOPIC_DISCOVERY_CONTRACT, topics: candidateTopics };

    const context = { ...(request.context.focus ? { focus: request.context.focus } : {}), maxTopics: request.context.maxTopics, ...this.evidence };
    const consolidator = new FeedbackRecordingConsolidator(new ContractTaxonomyConsolidator(this.transport, this.contract));
    const result = await runConsolidationAttempts(candidate.taxonomy, request.sample, context, consolidator);
    const finalTopics = result.status === "valid" ? snapshotTaxonomy(result.taxonomy!) : null;
    instrumented.consolidationAttempts = result.attempts.map((a) => ({
      attempt: a.attempt,
      ...this.source,
      contract: this.contract,
      inputCandidateKeys: candidateTopics.map((t) => t.key),
      outcome: a.outcome,
      issueCodes: [...a.issueCodes],
      feedbackIssues: consolidator.feedback[a.attempt - 1]?.issues ?? null,
      // Only the accepted (validated) output is persisted; invalid output is described by its issue codes.
      outputTopics: a.outcome === "valid" ? finalTopics : null,
      finalKeys: a.outcome === "valid" && finalTopics ? finalTopics.map((t) => t.key) : null,
    }));
    instrumented.provenance = finalTopics ? consolidationProvenance(candidateTopics, finalTopics) : null;
    record.consolidation = {
      status: result.status,
      attempts: result.attempts,
      topics: result.taxonomy?.topics.length ?? null,
      decisions: result.taxonomy ? consolidationDecisions(candidate.taxonomy, result.taxonomy) : null,
    };
    if (result.status === "valid") return { topics: result.taxonomy!.topics.map((t) => ({ key: t.key, name: t.proposedName, definition: t.definition, exampleCommentIds: [...t.exampleCommentIds] })) };
    // An empty candidate has nothing to consolidate: it is passed on unchanged (zero topics is a valid taxonomy).
    if (result.status === "skipped") return { topics: [] };
    this.exhausted = true;
    const configuration = result.attempts.find((a) => a.providerFailure === "configuration");
    if (configuration) throw new TopicProviderError("consolidation", "configuration");
    throw new ConsolidationUnavailableError();
  }
}

function codesOf(issues: readonly { code: TopicIssueCode }[]): TopicIssueCode[] {
  return [...new Set(issues.map((i) => i.code))].sort(compareIds);
}

// ---------- plan (no network) ----------

export interface RealConsolidatedPlan {
  apiCalls: 0;
  real: ReturnType<typeof buildTopicRealPreflight>;
  consolidation: ReturnType<typeof buildConsolidatedBenchmarkPlan>["consolidation"];
  /** The real worst case plus every repeat using both consolidation attempts at the output ceiling. */
  maxCostUsd: number;
  maxRequests: number;
}

export function buildRealConsolidatedPlan(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  env: Readonly<Record<string, string | undefined>>,
  repeats: number,
  contract: TopicConsolidationContract = TOPIC_CONSOLIDATION_CONTRACT,
): RealConsolidatedPlan {
  const real = buildTopicRealPreflight(dataset, config, prices, env, repeats);
  const consolidation = buildConsolidatedBenchmarkPlan(dataset, config, prices, env, repeats, contract).consolidation;
  return {
    apiCalls: 0,
    real,
    consolidation,
    maxCostUsd: real.total.maxCostUsd + consolidation.maxCostUsdPerCall * MAX_TOPIC_ATTEMPTS * repeats,
    maxRequests: real.total.maxRequests + MAX_TOPIC_ATTEMPTS * repeats,
  };
}

export function renderRealConsolidatedPlanAddendum(p: RealConsolidatedPlan): string {
  const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "unpriced");
  return [
    "",
    "## Consolidation (EXPERIMENTAL, before assignment)",
    realConsolidatedNotice(p.consolidation.contract as TopicConsolidationContract),
    `- ${p.consolidation.contract}: input ≈ ${p.consolidation.estimatedInputTokens} tokens (${p.consolidation.candidateUsedForEstimate}); per call ≈ ${usd(p.consolidation.expectedCostUsdPerCall)} expected, ${usd(p.consolidation.maxCostUsdPerCall)} max; at most ${MAX_TOPIC_ATTEMPTS} calls per repeat`,
    `- with consolidation: at most ${p.maxRequests} requests, worst case ${usd(p.maxCostUsd)}`,
    "",
    "NO API CALLS MADE",
  ].join("\n");
}

// ---------- live run ----------

/** Diagnostic instrumentation of one repeat (schema v2). Never read by the evaluator or used for pass/fail. */
export interface RepeatInstrumentation {
  repeat: number;
  taxonomyCalls: TaxonomyCallInstrumentation[];
  /** Report-level OTHER, evidence-selection and label-imitation diagnostics (null when the run was unavailable). */
  run: RunDiagnostics | null;
}

export interface RealConsolidatedResult {
  meta: Omit<TopicRealResult["meta"], "validation"> & {
    kind: "real-consolidated";
    experimental: true;
    notice: string;
    consolidation: { contract: string; topicBase: number; minTopicSize: number };
    validation: string;
    /** Absent in files written before instrumentation (v1). */
    resultSchema?: string;
  };
  report: TopicBenchmarkReport;
  phases: { repeat: number; taxonomyCalls: TaxonomyCallRecord[] }[];
  /** Diagnostic instrumentation (schema v2; absent in v1 files). */
  instrumentation?: { notice: string; repeats: RepeatInstrumentation[] };
  usage: { repeat: number; discovery: UsageSummary; consolidation: UsageSummary; assignment: TopicRealResult["usage"][number]["assignment"]; records: AiCallRecord[] }[];
  totals: { discovery: UsageSummary; consolidation: UsageSummary; assignment: UsageSummary; all: UsageSummary; attempts: number[]; batches: number };
  /** Raw text of every rejected discovery response per repeat, secrets removed (diagnostics only; absent in older results). */
  discoveryRejectedOutputs?: TopicRealResult["discoveryRejectedOutputs"];
}

/** The real suite's live run with consolidation inserted before assignment; scored by the same full evaluator. */
export async function runRealConsolidatedBenchmark(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  keys: TopicRealKeys,
  repeats: number,
  deps: DiscoveryClients & {
    fetch?: typeof fetch;
    onProgress?: (message: string) => void;
    consolidationContract?: TopicConsolidationContract;
    /**
     * EXPERIMENTAL paired mode only (topic-paired-consolidation.ts): replaces the per-repeat discovery generator with
     * one that serves a discovery taxonomy validated before the arm started. Absent: the suite runs exactly as before.
     */
    discoveryOverride?: (repeat: number) => TopicTaxonomyGenerator;
  } = {},
): Promise<RealConsolidatedResult> {
  const evidence = consolidationContextOf(dataset);
  // Only the consolidation contract may differ between experiment arms; everything else is the same code path.
  const contract = deps.consolidationContract ?? TOPIC_CONSOLIDATION_CONTRACT;
  const stages: { repeat: number; generator: ConsolidatingTaxonomyGenerator }[] = [];
  const scenarioId = realConsolidatedScenarioId(config.discovery.provider);
  const real = await runRealTopicBenchmark(dataset, config, prices, keys, repeats, {
    ...deps,
    taxonomyStage: {
      scenarioId,
      description: `EXPERIMENTAL live: ${config.discovery.model} discovery → ${contract} consolidation → ${config.assignment.model} assignment.`,
      wrap: (discovery, transport, repeat) => {
        const generator = new ConsolidatingTaxonomyGenerator(deps.discoveryOverride?.(repeat) ?? discovery, transport, { topicBase: evidence.topicBase, minTopicSize: evidence.minTopicSize }, { provider: config.discovery.provider, model: config.discovery.model }, contract);
        stages.push({ repeat, generator });
        return generator;
      },
    },
  });
  const isConsolidation = (r: AiCallRecord) => r.promptVersion === contract;
  const usage = real.usage.map((u) => {
    const llm = u.records.filter((r) => r.provider !== "typesafe");
    return { repeat: u.repeat, discovery: summarizeUsage(llm.filter((r) => !isConsolidation(r))), consolidation: summarizeUsage(llm.filter(isConsolidation)), assignment: u.assignment, records: u.records };
  });
  const all = usage.flatMap((u) => u.records);
  const { validation: _validation, ...meta } = real.meta;
  const runs = real.report.scenarios.find((s) => s.id === scenarioId)?.runs ?? [];
  const instrumentation = {
    notice: DIAGNOSTIC_NOTICE,
    repeats: stages.map((s) => {
      const run = runs.find((r) => r.repeat === s.repeat);
      return { repeat: s.repeat, taxonomyCalls: s.generator.instrumentation, run: run && run.status === "available" ? runDiagnosticsOf(dataset, run) : null };
    }),
  };
  return {
    meta: {
      ...meta,
      kind: "real-consolidated",
      experimental: true,
      notice: realConsolidatedNotice(contract),
      consolidation: { contract, topicBase: evidence.topicBase, minTopicSize: evidence.minTopicSize },
      validation: "production (frozen M4 validators, two attempts); consolidation: at most two attempts, then unavailable (no fallback to the unconsolidated taxonomy)",
      resultSchema: REAL_CONSOLIDATED_RESULT_SCHEMA,
    },
    report: real.report,
    phases: stages.map((s) => ({ repeat: s.repeat, taxonomyCalls: s.generator.calls })),
    instrumentation,
    usage,
    totals: {
      discovery: summarizeUsage(all.filter((r) => r.provider !== "typesafe" && !isConsolidation(r))),
      consolidation: summarizeUsage(all.filter(isConsolidation)),
      assignment: summarizeUsage(all.filter((r) => r.provider === "typesafe")),
      all: summarizeUsage(all),
      attempts: real.totals.attempts,
      batches: real.totals.batches,
    },
    discoveryRejectedOutputs: real.discoveryRejectedOutputs ?? [],
  };
}

export function renderRealConsolidatedMarkdown(result: RealConsolidatedResult): string {
  const usd = (u: UsageSummary) => (u.estimatedCostUsd === undefined ? (u.requests === 0 ? "$0.0000" : "partly unpriced") : `$${u.estimatedCostUsd.toFixed(4)}`);
  const phase = (u: UsageSummary) => `${u.requests} requests, ${u.latencyMs.total} ms, tokens ${u.inputTokens} / ${u.outputTokens}, ${usd(u)}`;
  const attempts = (list: DiscoveryAttemptRecord[]) => list.map((a) => (a.outcome === "valid" ? `${a.attempt}: valid` : `${a.attempt}: ${a.outcome}${a.providerFailure ? ` (${a.providerFailure})` : ""} [${a.issueCodes.join(", ")}]`)).join("; ") || "–";
  const lines = [
    "# Topic benchmark: real-consolidated (EXPERIMENTAL)",
    "",
    result.meta.notice,
    "",
    `Consolidation: ${result.meta.consolidation.contract}, production min_topic_size ${result.meta.consolidation.minTopicSize} for topic base ${result.meta.consolidation.topicBase}.`,
    "",
    "## Taxonomy phases",
  ];
  for (const p of result.phases) {
    for (const c of p.taxonomyCalls) {
      const d = c.discovery;
      const k = c.consolidation;
      const decisions = k.decisions ? `retained ${k.decisions.retained.length}${k.decisions.retained.length ? ` (${k.decisions.retained.join(", ")})` : ""}, merged ${k.decisions.merged.length}${k.decisions.merged.length ? ` (${k.decisions.merged.join(", ")})` : ""}, dropped ${k.decisions.dropped.length}${k.decisions.dropped.length ? ` (${k.decisions.dropped.join(", ")})` : ""}${k.decisions.split.length ? `, SPLIT ${k.decisions.split.join(", ")}` : ""}` : "–";
      lines.push(
        `- repeat ${p.repeat}, taxonomy call ${c.call}: discovery ${d.outcome}${d.providerFailure ? ` (${d.providerFailure})` : ""}${d.issueCodes.length ? ` [${d.issueCodes.join(", ")}]` : ""}, ${d.topics ?? "–"} topics → consolidation ${k.status} (${attempts(k.attempts)}), ${k.topics ?? "–"} topics; decisions: ${decisions}`,
      );
    }
  }
  lines.push("", "## Full benchmark (existing evaluator, unchanged)", "", renderTopicBenchmarkMarkdown(result.report), "", "## Cost and latency by phase");
  for (const u of result.usage) lines.push(`- repeat ${u.repeat}: discovery ${phase(u.discovery)}; consolidation ${phase(u.consolidation)}; Jev assignment ${phase(u.assignment)}, ${u.assignment.batches} batches (${u.assignment.failedBatches} failed)`);
  const t = result.totals;
  lines.push(`- totals: discovery ${phase(t.discovery)}; consolidation ${phase(t.consolidation)}; Jev assignment ${phase(t.assignment)}; all ${usd(t.all)}; analysis attempts per repeat ${t.attempts.join(", ")}`);
  if (result.instrumentation) lines.push("", ...renderInstrumentation(result.instrumentation));
  return lines.join("\n");
}

function renderInstrumentation(instrumentation: NonNullable<RealConsolidatedResult["instrumentation"]>): string[] {
  const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 1000) / 10}%`);
  const list = (xs: readonly string[]) => (xs.length ? xs.join(", ") : "none");
  const lines = ["## Diagnostics (not part of the evaluator; never pass/fail)", "", instrumentation.notice];
  for (const r of instrumentation.repeats) {
    for (const c of r.taxonomyCalls) {
      const p = c.provenance;
      const attempts = c.consolidationAttempts.map((a) => `${a.attempt}: ${a.outcome}${a.feedbackIssues ? ` (feedback: ${a.feedbackIssues.map((i) => i.code).join(", ")})` : ""}`).join("; ") || "none";
      lines.push(
        p
          ? `- repeat ${r.repeat}, call ${c.call}: ${p.discoveredTopics} candidates → ${p.consolidatedTopics} topics; retained ${p.retained}, merged ${p.merged}, dropped ${p.dropped}, split ${p.split}, unknown ${p.unknown}; coverage ${p.candidateCoverage.covered}/${p.candidateCoverage.withExamples}; no survivor: ${list(p.candidatesWithoutSurvivor)}; in several finals: ${list(p.candidatesInMultipleFinals)}; untraceable examples: ${list(p.finalTopicsWithUntraceableExamples)}; attempts ${attempts}`
          : `- repeat ${r.repeat}, call ${c.call}: ${c.candidate ? `${c.candidate.topics.length} candidates` : "no candidate"}; no accepted consolidation; attempts ${attempts}`,
      );
    }
    if (r.run) {
      const o = r.run.reportOther;
      const fallback = r.run.evidence.filter((e) => e.selection === "fallback");
      const reasons = [...new Set(fallback.map((e) => e.fallbackReason ?? "–"))];
      const flagged = r.run.labelImitation;
      lines.push(
        `- repeat ${r.repeat} report: reportOtherAccuracy ${pct(o?.reportOtherAccuracy ?? null)} (${o?.hits ?? 0}/${o?.goldReportOther ?? 0}), reportOtherPrecision ${pct(o?.reportOtherPrecision ?? null)}; evidence ${r.run.evidence.length} items, ${fallback.length} by fallback (${list(reasons)}), ${r.run.evidence.filter((e) => e.tieBreak === "lowest_comment_id").length} decided by lowest comment ID; label-like comments ${flagged.length}, assigned to a topic they name ${flagged.filter((f) => f.assignedToNamedTopic).length}`,
      );
    }
  }
  return lines;
}

/** v3 keeps its original file name; any other consolidation contract is appended, so experiment arms never collide. */
export function realConsolidatedResultFileName(result: RealConsolidatedResult): string {
  const contract = result.meta.consolidation.contract === TOPIC_CONSOLIDATION_CONTRACT ? "" : `-${result.meta.consolidation.contract}`;
  return `${result.meta.timestamp}-topics-${result.meta.dataset}-real-consolidated-${result.meta.discovery.provider}-${result.meta.discovery.modelRequested}-typesafe-${result.meta.assignment.modelRequested}${contract}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";
}

// ---------- reading stored results (v1 and v2) ----------

export interface StoredRealConsolidatedResult {
  /** `real-consolidated-result-v1` for files written before instrumentation. */
  schema: string;
  result: RealConsolidatedResult;
  /**
   * The instrumentation: as stored (v2), or for v1 files rebuilt from the stored report where possible. Discovery
   * candidates, consolidation attempts and provenance were not recorded in v1 and stay null / empty, never guessed.
   */
  instrumentation: NonNullable<RealConsolidatedResult["instrumentation"]>;
  recorded: { candidates: boolean; consolidationAttempts: boolean };
}

/** Reads a saved real-consolidated result of any schema version; new fields are optional. */
export function readRealConsolidatedResult(fileText: string, dataset: TopicBenchmarkDataset): StoredRealConsolidatedResult {
  const result = JSON.parse(fileText) as RealConsolidatedResult;
  if (result.meta?.kind !== "real-consolidated") throw new Error("not a real-consolidated result");
  if (result.meta.dataset !== dataset.id) throw new Error(`result belongs to ${result.meta.dataset}, not ${dataset.id}`);
  const schema = result.meta.resultSchema ?? "real-consolidated-result-v1";
  if (result.instrumentation) return { schema, result, instrumentation: result.instrumentation, recorded: { candidates: true, consolidationAttempts: true } };
  const runs = result.report.scenarios.find((s) => s.id !== "oracle")?.runs ?? [];
  return {
    schema,
    result,
    instrumentation: {
      notice: `${DIAGNOSTIC_NOTICE} Rebuilt from a ${schema} file: discovery candidates and consolidation attempts were not recorded.`,
      repeats: (result.phases ?? []).map((p) => {
        const run = runs.find((r) => r.repeat === p.repeat);
        return {
          repeat: p.repeat,
          taxonomyCalls: p.taxonomyCalls.map((c) => ({ call: c.call, candidate: null, consolidationAttempts: [], provenance: null })),
          run: run && run.status === "available" ? runDiagnosticsOf(dataset, run) : null,
        };
      }),
    },
    recorded: { candidates: false, consolidationAttempts: false },
  };
}
