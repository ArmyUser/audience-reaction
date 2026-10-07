import { ScriptedTaxonomyGenerator, type TopicPhaseGold } from "../adapters/fakes/topic-benchmark-phases";
import { MAX_TOPIC_ATTEMPTS } from "../application/analyze-topics";
import { ContractTopicTaxonomyGenerator, type RejectedDiscoveryOutput } from "../application/contract-topic-phases";
import { estimateCostUsd, InMemoryUsageRecorder, summarizeUsage, type AiCallRecord, type PriceTable, type UsageSummary } from "../core/cost/usage";
import type { TopicModelTransport } from "../core/ports";
import {
  buildTopicConsolidationRequest,
  consolidationExampleIds,
  consolidationMaxTopics,
  parseTopicConsolidationResponse,
  TOPIC_CONSOLIDATION_CONTRACT,
  type TopicConsolidationContract,
  type TopicConsolidationRequest,
} from "../core/topics/consolidation-contract";
import { minimumTopicSize } from "../core/topics/aggregate-topics";
import { TOPIC_DISCOVERY_CONTRACT, TopicProviderError, type TopicProviderFailure } from "../core/topics/provider-contracts";
import { validateTopicTaxonomy, type ValidatedTaxonomy } from "../core/topics/taxonomy";
import { sanitizeReportedIssues, toValidationFeedback } from "../core/topics/topic-result";
import type { TopicIssue, TopicValidationFeedback } from "../core/topics/types";
import { compareIds, TopicDiscoveryOutputError } from "../core/topics/validation";
import { TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED } from "./topic-benchmark";
import { goldOf, type TopicBenchmarkDataset } from "./topic-datasets";
import {
  buildDiscoveryBenchmarkPlan,
  discoveryOracleGate,
  discoveryRequestOf,
  evaluateDiscoveredTaxonomy,
  EXAMPLE_MATCHING,
  runDiscoveryAttempts,
  type DiscoveryAttemptRecord,
  type DiscoveryTaxonomyMetrics,
} from "./topic-discovery-only";
import { discoveryTransportFactory, sentDiscoverySchema, type DiscoveryClients, type TopicProviderConfig } from "./topic-real";

// EXPERIMENTAL discovery-consolidated suite: discovery (production topic-discovery request, sample, validation and
// retry, exactly as the discovery-only suite) → taxonomy consolidation (TOPIC_CONSOLIDATION_CONTRACT, same transport
// and provider configuration; it receives the validated candidate taxonomy and the SAME seeded discovery sample the
// discovery call received) → the frozen taxonomy validator → the discovery-only example-based evaluation of both
// taxonomies. No assignment, no Jev. Gold data is used only to score results afterwards, never in provider requests.
// Not part of the production pipeline; the discovery-only and real suites are unchanged.

export const CONSOLIDATED_NOTICE =
  `EXPERIMENTAL CONSOLIDATED RESULT: discovery → taxonomy consolidation (${TOPIC_CONSOLIDATION_CONTRACT}, experimental) → validation. Not part of the production pipeline; topic assignment (Jev) was NOT run. Metrics use the discovery-only example-based proxy and are NOT comparable with the real suite until the stage is integrated.`;

/** The consolidation role (experimental; no production port yet). */
export interface TaxonomyConsolidator {
  readonly label: string;
  consolidate(request: TopicConsolidationRequest): Promise<unknown>;
}

/** The consolidation contract (v3 by default; the experimental v4 only when asked for) over any TopicModelTransport. */
export class ContractTaxonomyConsolidator implements TaxonomyConsolidator {
  readonly label: string;
  constructor(
    private readonly transport: TopicModelTransport,
    private readonly contract: TopicConsolidationContract = TOPIC_CONSOLIDATION_CONTRACT,
  ) {
    this.label = `${transport.label} (${contract})`;
  }
  async consolidate(request: TopicConsolidationRequest): Promise<unknown> {
    return parseTopicConsolidationResponse(await this.transport.complete(buildTopicConsolidationRequest(request, this.contract)));
  }
}

export interface ConsolidationResult {
  /** skipped: nothing to consolidate (no valid candidate taxonomy, or an empty one). */
  status: "valid" | "unavailable" | "skipped";
  attempts: DiscoveryAttemptRecord[];
  taxonomy: ValidatedTaxonomy | null;
}

/**
 * Consolidation with the discovery retry rule: at most MAX_TOPIC_ATTEMPTS attempts; an invalid taxonomy or provider
 * failure is retried once with sanitised structured feedback. Validation is the frozen taxonomy validator, with the
 * candidates' example IDs as the only allowed example IDs and at most as many topics as candidates.
 */
export async function runConsolidationAttempts(
  candidate: ValidatedTaxonomy,
  sample: TopicConsolidationRequest["sample"],
  context: TopicConsolidationRequest["context"],
  consolidator: TaxonomyConsolidator,
  options: { now?: () => number } = {},
): Promise<ConsolidationResult> {
  if (candidate.topics.length === 0) return { status: "skipped", attempts: [], taxonomy: null };
  const now = options.now ?? Date.now;
  const allowedExamples = consolidationExampleIds(candidate);
  const allowed = new Set(allowedExamples);
  const maxTopics = consolidationMaxTopics({ candidate, context });
  const attempts: DiscoveryAttemptRecord[] = [];
  let feedback: TopicValidationFeedback | undefined;
  for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
    const started = now();
    let issues: TopicIssue[];
    let outcome: DiscoveryAttemptRecord["outcome"] = "invalid_taxonomy";
    let providerFailure: TopicProviderFailure | undefined;
    try {
      const proposal = await consolidator.consolidate({ candidate, sample, context, ...(feedback ? { feedback } : {}) });
      const validation = validateTopicTaxonomy(proposal, { sampleCommentIds: allowedExamples, maxTopics });
      if (validation.status === "valid") {
        attempts.push({ attempt, outcome: "valid", issueCodes: [], feedbackSent: feedback !== undefined, topics: validation.taxonomy.topics.length, latencyMs: now() - started });
        return { status: "valid", attempts, taxonomy: validation.taxonomy };
      }
      issues = sanitizeReportedIssues(validation.issues, allowed);
    } catch (error) {
      if (error instanceof TopicDiscoveryOutputError) issues = sanitizeReportedIssues(error.issues, allowed);
      else {
        issues = [{ code: "provider_error" }];
        outcome = "provider_error";
        if (error instanceof TopicProviderError) providerFailure = error.failure;
      }
    }
    attempts.push({ attempt, outcome, issueCodes: [...new Set(issues.map((i) => i.code))].sort(compareIds), ...(providerFailure ? { providerFailure } : {}), feedbackSent: feedback !== undefined, latencyMs: now() - started });
    feedback = toValidationFeedback(attempt, issues, allowedExamples);
  }
  return { status: "unavailable", attempts, taxonomy: null };
}

/** Candidate topics with examples whose examples reappear in some consolidated topic (example-based coverage). */
export function candidateCoverage(candidate: ValidatedTaxonomy, consolidated: ValidatedTaxonomy): { covered: number; withExamples: number; uncoveredKeys: string[] } {
  const kept = new Set(consolidated.topics.flatMap((t) => t.exampleCommentIds));
  const withExamples = candidate.topics.filter((t) => t.exampleCommentIds.length > 0);
  const uncovered = withExamples.filter((t) => !t.exampleCommentIds.some((id) => kept.has(id)));
  return { covered: withExamples.length - uncovered.length, withExamples: withExamples.length, uncoveredKeys: uncovered.map((t) => t.key) };
}

/** Consolidation context for a dataset: the bound, the topic base and the production minimum topic size for that base. */
export function consolidationContextOf(dataset: TopicBenchmarkDataset): TopicConsolidationRequest["context"] {
  const topicBase = discoveryRequestOf(dataset).baseIds.length;
  return {
    ...(dataset.focus ? { focus: dataset.focus } : {}),
    maxTopics: TOPIC_BENCHMARK_PARAMETERS.maxTopics,
    topicBase,
    minTopicSize: minimumTopicSize(topicBase, TOPIC_BENCHMARK_PARAMETERS),
  };
}

export interface ConsolidationDecisions {
  /** Inferred from example IDs: a candidate whose examples reappear alone in one topic was retained. */
  retained: string[];
  /** Candidates whose examples share a resulting topic with another candidate's examples. */
  merged: string[];
  /** Candidates with examples, none of which reappear. */
  dropped: string[];
  /** Candidates without examples: their fate cannot be inferred. */
  unknown: string[];
  /** Resulting topics that cite no example (not anchored to any candidate). */
  unanchoredTopics: string[];
  /** Candidates whose examples reappear in more than one resulting topic (a split, which the contract forbids). */
  split: string[];
}

/** Retain / merge / drop per candidate, inferred from where its example IDs reappear (the output has no decision fields). */
export function consolidationDecisions(candidate: ValidatedTaxonomy, consolidated: ValidatedTaxonomy): ConsolidationDecisions {
  const sourcesOf = consolidated.topics.map((t) => {
    const ids = new Set(t.exampleCommentIds);
    return candidate.topics.filter((c) => c.exampleCommentIds.some((id) => ids.has(id))).map((c) => c.key);
  });
  const out: ConsolidationDecisions = { retained: [], merged: [], dropped: [], unknown: [], unanchoredTopics: consolidated.topics.filter((t) => t.exampleCommentIds.length === 0).map((t) => t.key), split: [] };
  for (const c of candidate.topics) {
    if (c.exampleCommentIds.length === 0) out.unknown.push(c.key);
    else {
      const homes = sourcesOf.filter((sources) => sources.includes(c.key));
      if (homes.length > 1) out.split.push(c.key);
      if (homes.length === 0) out.dropped.push(c.key);
      else if (homes.some((sources) => sources.length > 1)) out.merged.push(c.key);
      else out.retained.push(c.key);
    }
  }
  return out;
}

/** Echoes the candidate taxonomy unchanged: the consolidation path must keep the gold taxonomy perfect. */
class IdentityConsolidator implements TaxonomyConsolidator {
  readonly label = "Identity consolidator (oracle)";
  async consolidate(request: TopicConsolidationRequest): Promise<unknown> {
    return { topics: request.candidate.topics.map((t) => ({ key: t.key, name: t.proposedName, definition: t.definition, exampleCommentIds: [...t.exampleCommentIds] })) };
  }
}

/** Offline gates: the discovery-only evaluator on gold, and gold through the consolidation validation path. */
export async function consolidatedOracleGate(dataset: TopicBenchmarkDataset): Promise<{ passed: boolean; failures: string[] }> {
  const discovery = await discoveryOracleGate(dataset);
  const failures = [...discovery.failures];
  const gold = goldOf(dataset);
  const phaseGold: TopicPhaseGold = {
    taxonomy: dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition })),
    dispositions: gold.dispositions,
    members: gold.members,
    overallSentiment: gold.overallSentiment,
  };
  const discovered = await runDiscoveryAttempts(dataset, new ScriptedTaxonomyGenerator(phaseGold));
  const consolidated = discovered.taxonomy ? await runConsolidationAttempts(discovered.taxonomy, discoveryRequestOf(dataset).request.sample, consolidationContextOf(dataset), new IdentityConsolidator()) : undefined;
  if (consolidated?.status !== "valid" || consolidated.attempts.length !== 1) failures.push("gold taxonomy not accepted unchanged by the consolidation validation");
  else {
    const m = evaluateDiscoveredTaxonomy(consolidated.taxonomy!, dataset);
    if (m.topicPrecision !== 1 || m.conceptRecall !== 1 || m.mergeErrors !== 0 || m.splitErrors !== 0) failures.push(`consolidated gold scores precision ${m.topicPrecision}, recall ${m.conceptRecall}, merge ${m.mergeErrors}, split ${m.splitErrors}`);
  }
  return { passed: failures.length === 0, failures };
}

// ---------- plan (no network) ----------

export interface ConsolidatedBenchmarkPlan {
  apiCalls: 0;
  discovery: ReturnType<typeof buildDiscoveryBenchmarkPlan>;
  consolidation: { contract: string; estimatedInputTokens: number; expectedCostUsdPerCall: number; maxCostUsdPerCall: number; candidateUsedForEstimate: string };
  maxCostUsd: number;
  maxRequests: number;
}

export function buildConsolidatedBenchmarkPlan(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  env: Readonly<Record<string, string | undefined>>,
  repeats: number,
  contract: TopicConsolidationContract = TOPIC_CONSOLIDATION_CONTRACT,
): ConsolidatedBenchmarkPlan {
  const discovery = buildDiscoveryBenchmarkPlan("discovery-only", dataset, config, prices, env, repeats);
  // Stand-in candidate: the gold taxonomy with sample examples (only its size matters for the estimate).
  const { request, sampleIds } = discoveryRequestOf(dataset);
  const gold = goldOf(dataset);
  const sampled = new Set(sampleIds);
  const standIn = validateTopicTaxonomy(
    { topics: dataset.taxonomy.map((t) => ({ key: t.key, name: t.name, definition: t.definition, exampleCommentIds: (gold.members.get(t.key) ?? []).filter((id) => sampled.has(id)).slice(0, 3) })) },
    { sampleCommentIds: sampleIds, maxTopics: TOPIC_BENCHMARK_PARAMETERS.maxTopics },
  );
  if (standIn.status !== "valid") throw new Error("The gold taxonomy must validate");
  const rendered = buildTopicConsolidationRequest({ candidate: standIn.taxonomy, sample: request.sample, context: consolidationContextOf(dataset) }, contract);
  const input = Math.ceil((rendered.instructions.length + rendered.data.length + JSON.stringify(sentDiscoverySchema(config, rendered.outputSchema)).length) / config.estimation.charsPerToken);
  const price = (out: number) => estimateCostUsd(prices, config.discovery.model, input, out) ?? Number.NaN;
  const consolidation = { contract, estimatedInputTokens: input, expectedCostUsdPerCall: price(config.discovery.expectedOutputTokens), maxCostUsdPerCall: price(config.discovery.maxOutputTokens), candidateUsedForEstimate: "gold taxonomy (stand-in for the size of the discovered taxonomy)" };
  return { apiCalls: 0, discovery, consolidation, maxCostUsd: discovery.maxCostUsd + consolidation.maxCostUsdPerCall * MAX_TOPIC_ATTEMPTS * repeats, maxRequests: discovery.maxRequests * 2 };
}

export function renderConsolidatedBenchmarkPlan(p: ConsolidatedBenchmarkPlan): string {
  const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "unpriced");
  const d = p.discovery;
  return [
    "# Topic discovery + consolidation (experimental): plan",
    "",
    "NO API CALLS MADE",
    "",
    CONSOLIDATED_NOTICE,
    `Dataset ${d.dataset.id} (${d.dataset.version}): topic base ${d.topicBase}, discovery sample ${d.sampleSize}. Repeats: ${d.repeats}.`,
    `Environment: ${d.environment.name} ${d.environment.present ? "present" : "MISSING"} (value never printed). No Jev key is needed.`,
    `Model (both phases): ${d.discovery.model} (${d.discovery.provider}); price ${d.discovery.priceConfigured ? "configured" : "MISSING"}.`,
    `- discovery (${d.discovery.contract}): input ≈ ${d.estimatedInputTokens} tokens; per call ≈ ${usd(d.expectedCostUsdPerCall)} expected, ${usd(d.maxCostUsdPerCall)} max`,
    `- consolidation (${p.consolidation.contract}): input ≈ ${p.consolidation.estimatedInputTokens} tokens (${p.consolidation.candidateUsedForEstimate}); per call ≈ ${usd(p.consolidation.expectedCostUsdPerCall)} expected, ${usd(p.consolidation.maxCostUsdPerCall)} max`,
    `- at most ${p.maxRequests} requests (${MAX_TOPIC_ATTEMPTS} attempts per phase × ${d.repeats} repeats), worst case ${usd(p.maxCostUsd)}`,
    "",
    "NO API CALLS MADE",
  ].join("\n");
}

// ---------- live run ----------

export interface ConsolidatedPhase {
  status: "valid" | "unavailable" | "skipped";
  attempts: DiscoveryAttemptRecord[];
  retried: boolean;
  topics: number | null;
  latencyMs: number;
  taxonomy: DiscoveryTaxonomyMetrics | null;
  topicList: { key: string; name: string }[];
  usage: UsageSummary & { modelsServed: string[] };
}

export interface ConsolidatedRun {
  repeat: number;
  discovery: ConsolidatedPhase;
  consolidation: ConsolidatedPhase & { coverage: ReturnType<typeof candidateCoverage> | null; decisions: ConsolidationDecisions | null };
  /** Raw text of every rejected discovery response, secrets removed (diagnostics only; absent in older results). */
  discoveryRejectedOutputs?: RejectedDiscoveryOutput[];
  records: AiCallRecord[];
}

export interface ConsolidatedBenchmarkResult {
  meta: {
    kind: "discovery-consolidated";
    experimental: true;
    notice: string;
    timestamp: string;
    dataset: string;
    datasetVersion: string;
    topicBase: number;
    sampleSize: number;
    sampleSeed: string;
    repeats: number;
    provider: string;
    modelRequested: string;
    settings: Record<string, string>;
    contracts: { discovery: string; consolidation: string };
    /** The production minimum topic size for this topic base, given to consolidation as evidence. */
    minTopicSize: number;
    assignment: "not run";
    validation: string;
    matching: string;
  };
  oracleGate: { passed: boolean; failures: string[] };
  runs: ConsolidatedRun[];
  totals: { discovery: UsageSummary; consolidation: UsageSummary; all: UsageSummary };
}

function phaseOf(status: ConsolidatedPhase["status"], attempts: DiscoveryAttemptRecord[], taxonomy: ValidatedTaxonomy | null, dataset: TopicBenchmarkDataset, records: AiCallRecord[]): ConsolidatedPhase {
  return {
    status,
    attempts,
    retried: attempts.length > 1,
    topics: taxonomy?.topics.length ?? null,
    latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
    taxonomy: taxonomy ? evaluateDiscoveredTaxonomy(taxonomy, dataset) : null,
    topicList: taxonomy?.topics.map((t) => ({ key: t.key, name: t.proposedName })) ?? [],
    usage: { ...summarizeUsage(records), modelsServed: [...new Set(records.flatMap((r) => (r.modelVersion ? [r.modelVersion] : [])))] },
  };
}

/**
 * Live experimental run with the configured discovery provider for both phases. The offline gates run first; no
 * provider is called if they fail. A configuration failure stops later repeats. No Jev call is ever made.
 */
export async function runConsolidatedDiscoveryBenchmark(
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  apiKey: string,
  options: { repeats?: number; clients?: DiscoveryClients; onProgress?: (message: string) => void; now?: () => number } = {},
): Promise<ConsolidatedBenchmarkResult> {
  const repeats = options.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) throw new RangeError("repeats must be a positive integer");
  const d = config.discovery;
  // The same seeded sample (ids and text) the discovery request carries; the consolidation request reuses it as is.
  const { request: discoveryRequest, baseIds, sampleIds } = discoveryRequestOf(dataset);
  const context = consolidationContextOf(dataset);
  const oracleGate = await consolidatedOracleGate(dataset);
  const runs: ConsolidatedRun[] = [];
  if (oracleGate.passed) {
    const newTransport = discoveryTransportFactory(d, prices, apiKey, options.clients ?? {});
    const now = options.now ? { now: options.now } : {};
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const recorder = new InMemoryUsageRecorder();
      const transport = newTransport(recorder);
      const discoveryGenerator = new ContractTopicTaxonomyGenerator(transport, { secrets: [apiKey] });
      const discovered = await runDiscoveryAttempts(dataset, discoveryGenerator, now);
      const consolidated = discovered.taxonomy ? await runConsolidationAttempts(discovered.taxonomy, discoveryRequest.sample, context, new ContractTaxonomyConsolidator(transport), now) : ({ status: "skipped", attempts: [], taxonomy: null } satisfies ConsolidationResult);
      const records = [...recorder.entries];
      const isConsolidation = (r: AiCallRecord) => r.promptVersion === TOPIC_CONSOLIDATION_CONTRACT;
      runs.push({
        repeat,
        discovery: phaseOf(discovered.status, discovered.attempts, discovered.taxonomy, dataset, records.filter((r) => !isConsolidation(r))),
        consolidation: {
          ...phaseOf(consolidated.status, consolidated.attempts, consolidated.taxonomy, dataset, records.filter(isConsolidation)),
          coverage: discovered.taxonomy && consolidated.taxonomy ? candidateCoverage(discovered.taxonomy, consolidated.taxonomy) : null,
          decisions: discovered.taxonomy && consolidated.taxonomy ? consolidationDecisions(discovered.taxonomy, consolidated.taxonomy) : null,
        },
        discoveryRejectedOutputs: [...discoveryGenerator.rejectedOutputs],
        records,
      });
      options.onProgress?.(`repeat ${repeat}: discovery ${discovered.status} (${discovered.attempts.length} attempt(s)), consolidation ${consolidated.status} (${consolidated.attempts.length} attempt(s))`);
      if ([...discovered.attempts, ...consolidated.attempts].some((a) => a.providerFailure === "configuration")) break;
    }
  }
  const all = runs.flatMap((r) => r.records);
  return {
    meta: {
      kind: "discovery-consolidated",
      experimental: true,
      notice: CONSOLIDATED_NOTICE,
      timestamp: new Date().toISOString(),
      dataset: dataset.id,
      datasetVersion: dataset.version,
      topicBase: baseIds.length,
      sampleSize: sampleIds.length,
      sampleSeed: TOPIC_BENCHMARK_SEED,
      repeats,
      provider: d.provider,
      modelRequested: d.model,
      settings: d.provider === "google" ? { thinkingLevel: d.thinkingLevel } : { effort: d.effort, refusalFallback: d.refusalFallback },
      contracts: { discovery: TOPIC_DISCOVERY_CONTRACT, consolidation: TOPIC_CONSOLIDATION_CONTRACT },
      minTopicSize: context.minTopicSize,
      assignment: "not run",
      validation: `frozen taxonomy validator (validateTopicTaxonomy) for both phases, at most ${MAX_TOPIC_ATTEMPTS} attempts each with structured feedback; consolidation may cite only the candidates' example IDs and has at most as many topics as candidates`,
      matching: EXAMPLE_MATCHING,
    },
    oracleGate,
    runs,
    totals: { discovery: summarizeUsage(all.filter((r) => r.promptVersion !== TOPIC_CONSOLIDATION_CONTRACT)), consolidation: summarizeUsage(all.filter((r) => r.promptVersion === TOPIC_CONSOLIDATION_CONTRACT)), all: summarizeUsage(all) },
  };
}

export function renderConsolidatedBenchmarkMarkdown(result: ConsolidatedBenchmarkResult): string {
  const m = result.meta;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const usd = (u: UsageSummary) => (u.estimatedCostUsd === undefined ? (u.requests === 0 ? "$0.0000" : "partly unpriced") : `$${u.estimatedCostUsd.toFixed(4)}`);
  const attempts = (p: ConsolidatedPhase) =>
    p.attempts.length === 0 ? "–" : p.attempts.map((a) => (a.outcome === "valid" ? `${a.attempt}: valid` : `${a.attempt}: ${a.outcome}${a.providerFailure ? ` (${a.providerFailure})` : ""} [${a.issueCodes.join(", ")}]`)).join("; ");
  const row = (repeat: number, phase: string, p: ConsolidatedPhase) => {
    const t = p.taxonomy;
    return `| ${repeat} | ${phase} | ${p.status} | ${attempts(p)} | ${p.retried ? "yes" : "no"} | ${p.topics ?? "–"} | ${t ? pct(t.topicPrecision) : "–"} | ${t ? pct(t.conceptRecall) : "–"} | ${t?.mergeErrors ?? "–"} | ${t?.splitErrors ?? "–"} | ${t ? pct(t.definitionValidity) : "–"} | ${p.latencyMs} ms | ${p.usage.inputTokens} / ${p.usage.outputTokens} | ${usd(p.usage)} |`;
  };
  const lines = [
    "# Topic discovery + consolidation (EXPERIMENTAL)",
    "",
    m.notice,
    "",
    `Dataset ${m.dataset} (${m.datasetVersion}): topic base ${m.topicBase}, discovery sample ${m.sampleSize} (seed ${m.sampleSeed}). Repeats: ${m.repeats}.`,
    `Model (both phases): ${m.modelRequested} (${m.provider}; ${Object.entries(m.settings).map(([k, v]) => `${k} ${v}`).join(", ")}). Contracts: ${m.contracts.discovery} → ${m.contracts.consolidation}. Assignment: not run.`,
    `Consolidation evidence: production min_topic_size ${m.minTopicSize} for topic base ${m.topicBase}.`,
    `Validation: ${m.validation}.`,
    `Offline gates (discovery-only evaluator on gold; gold through consolidation validation): ${result.oracleGate.passed ? "PASSED" : `FAILED: ${result.oracleGate.failures.join("; ")}`}`,
    `Matching (experimental proxy): ${m.matching}`,
    "",
    "| repeat | phase | status | attempts | retry | topics | precision (proxy) | concept recall (proxy) | merge | split | definition validity | latency | tokens in / out | cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of result.runs) lines.push(row(r.repeat, "discovery", r.discovery), row(r.repeat, "consolidated", r.consolidation));
  for (const r of result.runs) {
    const c = r.consolidation;
    lines.push("", `Repeat ${r.repeat}: ${r.discovery.topics ?? "–"} discovered → ${c.topics ?? "–"} consolidated topics; candidate coverage ${c.coverage ? `${c.coverage.covered}/${c.coverage.withExamples}${c.coverage.uncoveredKeys.length > 0 ? ` (not covered: ${c.coverage.uncoveredKeys.join(", ")})` : ""}` : "–"}.`);
    if (c.decisions) {
      const d = c.decisions;
      const list = (keys: string[]) => (keys.length > 0 ? ` (${keys.join(", ")})` : "");
      lines.push(`Decisions inferred from example IDs: retained ${d.retained.length}${list(d.retained)}; merged ${d.merged.length}${list(d.merged)}; dropped ${d.dropped.length}${list(d.dropped)}${d.unknown.length > 0 ? `; unknown ${d.unknown.length}${list(d.unknown)}` : ""}${d.split.length > 0 ? `; SPLIT ${d.split.length}${list(d.split)}` : ""}${d.unanchoredTopics.length > 0 ? `; topics citing no example ${list(d.unanchoredTopics)}` : ""}.`);
    }
    if (c.taxonomy) for (const t of c.taxonomy.matches) lines.push(`- ${t.key} "${t.name}" → ${t.goldKey ?? "no match"} (${t.exampleGold.join(", ") || "no examples"})`);
  }
  const t = result.totals;
  lines.push("", `Totals: discovery ${t.discovery.requests} requests, tokens ${t.discovery.inputTokens} / ${t.discovery.outputTokens}, ${usd(t.discovery)}; consolidation ${t.consolidation.requests} requests, tokens ${t.consolidation.inputTokens} / ${t.consolidation.outputTokens}, ${usd(t.consolidation)}; all ${usd(t.all)}.`);
  return lines.join("\n");
}

export function consolidatedResultFileName(result: ConsolidatedBenchmarkResult): string {
  return `${result.meta.timestamp}-topics-${result.meta.dataset}-discovery-consolidated-${result.meta.provider}-${result.meta.modelRequested}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";
}
