import { ScriptedTaxonomyGenerator, type TopicPhaseGold } from "../adapters/fakes/topic-benchmark-phases";
import { MAX_TOPIC_ATTEMPTS } from "../application/analyze-topics";
import { ContractTopicTaxonomyGenerator, type RejectedDiscoveryOutput } from "../application/contract-topic-phases";
import { estimateCostUsd, InMemoryUsageRecorder, summarizeUsage, type AiCallRecord, type PriceTable, type UsageSummary } from "../core/cost/usage";
import type { TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../core/ports";
import { DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, discoveryCandidateOf, selectDiscoverySample } from "../core/topics/discovery-sample";
import { buildTopicDiscoveryRequest, TOPIC_DISCOVERY_CONTRACT, TopicProviderError, type TopicDiscoveryContract, type TopicProviderFailure } from "../core/topics/provider-contracts";
import { validateTopicTaxonomy, type ValidatedTaxonomy } from "../core/topics/taxonomy";
import { sanitizeReportedIssues, toValidationFeedback } from "../core/topics/topic-result";
import type { TopicIssue, TopicIssueCode, TopicValidationFeedback } from "../core/topics/types";
import { compareIds, TopicDiscoveryOutputError } from "../core/topics/validation";
import { definitionProblems, TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED } from "./topic-benchmark";
import { classifiedCommentsOf, goldOf, type TopicBenchmarkDataset } from "./topic-datasets";
import { discoveryTransportFactory, sentDiscoverySchema, type DiscoveryClients, type TopicProviderConfig } from "./topic-real";

// Discovery-only and smoke suites: taxonomy discovery providers measured without topic assignment (no Jev).
// The discovery step is the production one: the same topic base, the same seeded discovery sample
// (selectDiscoverySample with the benchmark seed, as TwoPhaseTopicDiscoverer draws it), the same topic-discovery-v1
// request through ContractTopicTaxonomyGenerator, the same AC-21 validator (validateTopicTaxonomy), and the same retry
// rule as analyzeTopics: at most MAX_TOPIC_ATTEMPTS attempts, an invalid taxonomy or provider failure retried once with
// the sanitised structured feedback (sanitizeReportedIssues + toValidationFeedback). Nothing is assigned, so there are
// no member comments: topics are scored against gold through their own example comments (a proxy; see EXAMPLE_MATCHING).
// The real suite (topic-real.ts) is unchanged and remains the full benchmark.

export type DiscoveryBenchmarkKind = "discovery-only" | "smoke";
export const DEFAULT_SMOKE_COMMENTS = 20;
export const DISCOVERY_ONLY_NOTICE = "DISCOVERY-ONLY RESULT: taxonomy discovery and validation only. Topic assignment (Jev) was NOT run; this is not a full topic benchmark report.";
export const SMOKE_NOTICE = "SMOKE TEST: a small subset, one run, no assignment and no gold evaluation. NOT benchmark-quality evidence.";
export const EXAMPLE_MATCHING =
  "example-based proxy: a topic matches the gold concept that holds a strict majority of its exampleCommentIds; topics without examples match nothing. Not comparable with the real suite's member-comment Jaccard.";

export interface DiscoveryAttemptRecord {
  attempt: number;
  outcome: "valid" | "invalid_taxonomy" | "provider_error";
  /** Sanitised issue codes (empty when valid). */
  issueCodes: TopicIssueCode[];
  /** Provider-neutral failure kind of a provider error, when the transport reported one. */
  providerFailure?: TopicProviderFailure;
  feedbackSent: boolean;
  topics?: number;
  latencyMs: number;
}

export interface DiscoveryAttemptsResult {
  status: "valid" | "unavailable";
  attempts: DiscoveryAttemptRecord[];
  taxonomy: ValidatedTaxonomy | null;
  topicBase: number;
  sampleIds: string[];
}

/** The taxonomy request exactly as the production discoverer builds it for this topic base (sample ids and text only). */
export function discoveryRequestOf(dataset: TopicBenchmarkDataset, commentIds?: readonly string[]): { request: TopicTaxonomyRequest; baseIds: string[]; sampleIds: string[] } {
  const allowed = commentIds ? new Set(commentIds) : undefined;
  const base = classifiedCommentsOf(dataset).filter((c) => c.classification.type !== "spam_irrelevant" && (!allowed || allowed.has(c.comment.id)));
  const sample = selectDiscoverySample(base.map(discoveryCandidateOf), { ...DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, seed: TOPIC_BENCHMARK_SEED });
  const sampled = new Set(sample.commentIds);
  return {
    request: {
      sample: base.filter((c) => sampled.has(c.comment.id)).map((c) => ({ id: c.comment.id, text: c.comment.text })),
      context: { ...(dataset.focus ? { focus: dataset.focus } : {}), sentimentLabels: dataset.schema.sentimentLabels, maxTopics: TOPIC_BENCHMARK_PARAMETERS.maxTopics },
    },
    baseIds: base.map((c) => c.comment.id),
    sampleIds: sample.commentIds,
  };
}

/** Discovery with production validation and the production retry rule; never assigns. */
export async function runDiscoveryAttempts(dataset: TopicBenchmarkDataset, generator: TopicTaxonomyGenerator, options: { commentIds?: readonly string[]; now?: () => number } = {}): Promise<DiscoveryAttemptsResult> {
  const now = options.now ?? Date.now;
  const { request, baseIds, sampleIds } = discoveryRequestOf(dataset, options.commentIds);
  const analysed = new Set(baseIds);
  const attempts: DiscoveryAttemptRecord[] = [];
  let feedback: TopicValidationFeedback | undefined;
  for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
    const started = now();
    let issues: TopicIssue[];
    let outcome: DiscoveryAttemptRecord["outcome"] = "invalid_taxonomy";
    let providerFailure: TopicProviderFailure | undefined;
    try {
      const proposal = await generator.proposeTaxonomy({ ...request, ...(feedback ? { feedback } : {}) });
      const validation = validateTopicTaxonomy(proposal, { sampleCommentIds: sampleIds, maxTopics: request.context.maxTopics });
      if (validation.status === "valid") {
        attempts.push({ attempt, outcome: "valid", issueCodes: [], feedbackSent: feedback !== undefined, topics: validation.taxonomy.topics.length, latencyMs: now() - started });
        return { status: "valid", attempts, taxonomy: validation.taxonomy, topicBase: baseIds.length, sampleIds };
      }
      // The production discoverer rejects an invalid taxonomy with these issues; analyzeTopics sanitises them.
      issues = sanitizeReportedIssues(validation.issues, analysed);
    } catch (error) {
      if (error instanceof TopicDiscoveryOutputError) issues = sanitizeReportedIssues(error.issues, analysed);
      else {
        issues = [{ code: "provider_error" }];
        outcome = "provider_error";
        if (error instanceof TopicProviderError) providerFailure = error.failure;
      }
    }
    attempts.push({ attempt, outcome, issueCodes: [...new Set(issues.map((i) => i.code))].sort(compareIds), ...(providerFailure ? { providerFailure } : {}), feedbackSent: feedback !== undefined, latencyMs: now() - started });
    feedback = toValidationFeedback(attempt, issues, baseIds);
  }
  return { status: "unavailable", attempts, taxonomy: null, topicBase: baseIds.length, sampleIds };
}

// ---------- evaluation against gold (example-based) ----------

export interface DiscoveryTopicMatch {
  key: string;
  name: string;
  examples: number;
  /** Gold label of each example: a gold topic key, "other" or "no_specific_topic". */
  exampleGold: string[];
  goldKey: string | null;
}

export interface DiscoveryTaxonomyMetrics {
  matching: string;
  predictedTopics: number;
  topicsWithExamples: number;
  matchedTopics: number;
  topicPrecision: number;
  conceptRecall: number;
  /** Topics whose examples include members of two or more gold concepts. */
  mergeErrors: number;
  /** Gold concepts matched by two or more topics. */
  splitErrors: number;
  definitionValidity: number;
  definitionIssues: { key: string; issues: string[] }[];
  matches: DiscoveryTopicMatch[];
}

export function evaluateDiscoveredTaxonomy(taxonomy: ValidatedTaxonomy, dataset: TopicBenchmarkDataset): DiscoveryTaxonomyMetrics {
  const gold = goldOf(dataset);
  const concepts = new Set(dataset.taxonomy.map((t) => t.key));
  const goldLabel = (id: string) => {
    const g = gold.dispositions.get(id);
    return g === undefined ? "unknown" : g.disposition === "primary_topic" ? g.topicKey : g.disposition;
  };
  const matches = taxonomy.topics.map((t): DiscoveryTopicMatch => {
    const exampleGold = t.exampleCommentIds.map(goldLabel);
    const counts = new Map<string, number>();
    for (const label of exampleGold) counts.set(label, (counts.get(label) ?? 0) + 1);
    const majority = [...counts].find(([label, n]) => concepts.has(label) && n * 2 > exampleGold.length);
    return { key: t.key, name: t.proposedName, examples: exampleGold.length, exampleGold, goldKey: majority ? majority[0] : null };
  });
  const matched = matches.filter((m) => m.goldKey !== null);
  const perConcept = new Map<string, number>();
  for (const m of matched) perConcept.set(m.goldKey!, (perConcept.get(m.goldKey!) ?? 0) + 1);
  const texts = dataset.comments.map((c) => c.text);
  const definitionIssues = taxonomy.topics.map((t) => ({ key: t.key, issues: definitionProblems(t.proposedName, t.definition, texts) })).filter((d) => d.issues.length > 0);
  const n = taxonomy.topics.length;
  return {
    matching: EXAMPLE_MATCHING,
    predictedTopics: n,
    topicsWithExamples: matches.filter((m) => m.examples > 0).length,
    matchedTopics: matched.length,
    topicPrecision: n === 0 ? 0 : matched.length / n,
    conceptRecall: perConcept.size / dataset.taxonomy.length,
    mergeErrors: matches.filter((m) => new Set(m.exampleGold.filter((g) => concepts.has(g))).size >= 2).length,
    splitErrors: [...perConcept.values()].filter((count) => count >= 2).length,
    definitionValidity: n === 0 ? 0 : (n - definitionIssues.length) / n,
    definitionIssues,
    matches,
  };
}

/** The discovery-only evaluator on the gold taxonomy (scripted oracle generator, offline) must score perfectly. */
export async function discoveryOracleGate(dataset: TopicBenchmarkDataset): Promise<{ passed: boolean; failures: string[] }> {
  const gold = goldOf(dataset);
  const phaseGold: TopicPhaseGold = {
    taxonomy: dataset.taxonomy.map(({ key, name, definition }) => ({ key, name, definition })),
    dispositions: gold.dispositions,
    members: gold.members,
    overallSentiment: gold.overallSentiment,
  };
  const result = await runDiscoveryAttempts(dataset, new ScriptedTaxonomyGenerator(phaseGold));
  const failures: string[] = [];
  if (result.status !== "valid" || result.attempts.length !== 1) failures.push(`oracle taxonomy not valid on the first attempt (${result.attempts.map((a) => a.outcome).join(", ")})`);
  if (result.taxonomy) {
    const m = evaluateDiscoveredTaxonomy(result.taxonomy, dataset);
    if (m.topicPrecision !== 1 || m.conceptRecall !== 1) failures.push(`oracle precision ${m.topicPrecision}, recall ${m.conceptRecall} (expected 1, 1)`);
    if (m.mergeErrors !== 0 || m.splitErrors !== 0) failures.push(`oracle merge ${m.mergeErrors}, split ${m.splitErrors} (expected 0, 0)`);
    if (m.definitionValidity !== 1) failures.push(`oracle definition validity ${m.definitionValidity}`);
  }
  return { passed: failures.length === 0, failures };
}

// ---------- plan (no network) and live run ----------

export interface DiscoveryBenchmarkPlan {
  apiCalls: 0;
  kind: DiscoveryBenchmarkKind;
  dataset: { id: string; version: string };
  topicBase: number;
  sampleSize: number;
  repeats: number;
  environment: { name: string; present: boolean };
  discovery: { provider: string; model: string; contract: string; priceConfigured: boolean };
  estimatedInputTokens: number;
  expectedCostUsdPerCall: number;
  maxCostUsdPerCall: number;
  /** Every repeat using both attempts at the output ceiling. */
  maxCostUsd: number;
  maxRequests: number;
}

/** Sizes and prices the discovery request a run would send. No network; Jev is not involved. */
export function buildDiscoveryBenchmarkPlan(kind: DiscoveryBenchmarkKind, dataset: TopicBenchmarkDataset, config: TopicProviderConfig, prices: PriceTable, env: Readonly<Record<string, string | undefined>>, repeats: number, commentIds?: readonly string[], contract: TopicDiscoveryContract = TOPIC_DISCOVERY_CONTRACT): DiscoveryBenchmarkPlan {
  const { request, baseIds, sampleIds } = discoveryRequestOf(dataset, commentIds);
  const rendered = buildTopicDiscoveryRequest(request, { contract });
  const d = config.discovery;
  const input = Math.ceil((rendered.instructions.length + rendered.data.length + JSON.stringify(sentDiscoverySchema(config, rendered.outputSchema)).length) / config.estimation.charsPerToken);
  const price = (out: number) => estimateCostUsd(prices, d.model, input, out) ?? Number.NaN;
  const keyValue = env[d.apiKeyEnv];
  return {
    apiCalls: 0,
    kind,
    dataset: { id: dataset.id, version: dataset.version },
    topicBase: baseIds.length,
    sampleSize: sampleIds.length,
    repeats,
    environment: { name: d.apiKeyEnv, present: typeof keyValue === "string" && keyValue.length > 0 },
    discovery: { provider: d.provider, model: d.model, contract, priceConfigured: prices[d.model] !== undefined },
    estimatedInputTokens: input,
    expectedCostUsdPerCall: price(d.expectedOutputTokens),
    maxCostUsdPerCall: price(d.maxOutputTokens),
    maxCostUsd: price(d.maxOutputTokens) * MAX_TOPIC_ATTEMPTS * repeats,
    maxRequests: MAX_TOPIC_ATTEMPTS * repeats,
  };
}

export function renderDiscoveryBenchmarkPlan(p: DiscoveryBenchmarkPlan): string {
  const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "unpriced");
  return [
    `# Topic ${p.kind === "smoke" ? "discovery smoke test" : "discovery-only benchmark"}: plan`,
    "",
    "NO API CALLS MADE",
    "",
    p.kind === "smoke" ? SMOKE_NOTICE : DISCOVERY_ONLY_NOTICE,
    `Dataset ${p.dataset.id} (${p.dataset.version}): topic base ${p.topicBase}${p.kind === "smoke" ? " (smoke subset)" : ""}, discovery sample ${p.sampleSize}. Repeats: ${p.repeats}.`,
    `Environment: ${p.environment.name} ${p.environment.present ? "present" : "MISSING"} (value never printed). No Jev key is needed.`,
    `Discovery: ${p.discovery.model} (${p.discovery.provider}, ${p.discovery.contract}); price ${p.discovery.priceConfigured ? "configured" : "MISSING"}.`,
    `- input ≈ ${p.estimatedInputTokens} tokens; cost per call ≈ ${usd(p.expectedCostUsdPerCall)} expected, ${usd(p.maxCostUsdPerCall)} max`,
    `- at most ${p.maxRequests} discovery requests (${MAX_TOPIC_ATTEMPTS} attempts × ${p.repeats} repeats), worst case ${usd(p.maxCostUsd)}`,
    ...(p.discovery.provider === "google" ? ["- Gemini prices are the paid-tier rates; a free-tier key is not billed, so these figures are an upper bound for it"] : []),
    "",
    "NO API CALLS MADE",
  ].join("\n");
}

export interface DiscoveryRun {
  repeat: number;
  status: "valid" | "unavailable";
  attempts: DiscoveryAttemptRecord[];
  topics: number | null;
  latencyMs: number;
  /** Example-based gold evaluation (discovery-only, valid runs); null for smoke runs. */
  taxonomy: DiscoveryTaxonomyMetrics | null;
  /** Proposed topic keys and names of the accepted taxonomy (no comment text). */
  topicList: { key: string; name: string }[];
  /** Raw text of every rejected discovery response, secrets removed (diagnostics only; absent in older results). */
  rejectedOutputs?: RejectedDiscoveryOutput[];
  usage: UsageSummary & { modelsServed: string[] };
  records: AiCallRecord[];
}

export interface DiscoveryBenchmarkResult {
  meta: {
    kind: DiscoveryBenchmarkKind;
    notice: string;
    timestamp: string;
    dataset: string;
    datasetVersion: string;
    topicBase: number;
    sampleSize: number;
    sampleSeed: string;
    smokeComments?: number;
    repeats: number;
    discovery: { provider: string; modelRequested: string; contract: string; settings: Record<string, string> };
    assignment: "not run";
    validation: string;
    matching: string | null;
  };
  /** The discovery-only evaluator's oracle gate (offline); null for smoke. */
  oracleGate: { passed: boolean; failures: string[] } | null;
  runs: DiscoveryRun[];
  totals: UsageSummary;
}

/** The first `n` topic-base comments in dataset order (spam excluded): the smoke subset. */
export function smokeCommentIds(dataset: TopicBenchmarkDataset, n: number): string[] {
  const base = goldOf(dataset).baseIds;
  if (!Number.isInteger(n) || n < 1 || n > base.length) throw new RangeError(`--comments must be an integer from 1 to ${base.length}`);
  return base.slice(0, n);
}

/**
 * Live discovery-only or smoke run with the configured discovery provider. Discovery-only runs the offline oracle gate
 * first and calls no provider if it fails; a configuration failure stops later repeats. No Jev call is ever made.
 */
export async function runDiscoveryBenchmark(
  kind: DiscoveryBenchmarkKind,
  dataset: TopicBenchmarkDataset,
  config: TopicProviderConfig,
  prices: PriceTable,
  discoveryApiKey: string,
  options: { repeats?: number; smokeComments?: number; clients?: DiscoveryClients; onProgress?: (message: string) => void; now?: () => number; discoveryContract?: TopicDiscoveryContract } = {},
): Promise<DiscoveryBenchmarkResult> {
  const contract = options.discoveryContract ?? TOPIC_DISCOVERY_CONTRACT;
  const repeats = kind === "smoke" ? 1 : (options.repeats ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1) throw new RangeError("repeats must be a positive integer");
  const commentIds = kind === "smoke" ? smokeCommentIds(dataset, options.smokeComments ?? DEFAULT_SMOKE_COMMENTS) : undefined;
  const { baseIds, sampleIds } = discoveryRequestOf(dataset, commentIds);
  const d = config.discovery;
  const oracleGate = kind === "discovery-only" ? await discoveryOracleGate(dataset) : null;
  const runs: DiscoveryRun[] = [];
  if (!oracleGate || oracleGate.passed) {
    const newTransport = discoveryTransportFactory(d, prices, discoveryApiKey, options.clients ?? {});
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const recorder = new InMemoryUsageRecorder();
      const generator = new ContractTopicTaxonomyGenerator(newTransport(recorder), { contract, secrets: [discoveryApiKey] });
      const result = await runDiscoveryAttempts(dataset, generator, { ...(commentIds ? { commentIds } : {}), ...(options.now ? { now: options.now } : {}) });
      const records = [...recorder.entries];
      runs.push({
        repeat,
        status: result.status,
        attempts: result.attempts,
        topics: result.taxonomy?.topics.length ?? null,
        latencyMs: result.attempts.reduce((s, a) => s + a.latencyMs, 0),
        taxonomy: kind === "discovery-only" && result.taxonomy ? evaluateDiscoveredTaxonomy(result.taxonomy, dataset) : null,
        topicList: result.taxonomy?.topics.map((t) => ({ key: t.key, name: t.proposedName })) ?? [],
        rejectedOutputs: [...generator.rejectedOutputs],
        usage: { ...summarizeUsage(records), modelsServed: [...new Set(records.flatMap((r) => (r.modelVersion ? [r.modelVersion] : [])))] },
        records,
      });
      options.onProgress?.(`repeat ${repeat}: ${result.status} after ${result.attempts.length} attempt(s)`);
      if (result.attempts.some((a) => a.providerFailure === "configuration")) break;
    }
  }
  return {
    meta: {
      kind,
      notice: kind === "smoke" ? SMOKE_NOTICE : DISCOVERY_ONLY_NOTICE,
      timestamp: new Date().toISOString(),
      dataset: dataset.id,
      datasetVersion: dataset.version,
      topicBase: baseIds.length,
      sampleSize: sampleIds.length,
      sampleSeed: TOPIC_BENCHMARK_SEED,
      ...(commentIds ? { smokeComments: commentIds.length } : {}),
      repeats,
      discovery: { provider: d.provider, modelRequested: d.model, contract, settings: d.provider === "google" ? { thinkingLevel: d.thinkingLevel } : { effort: d.effort, refusalFallback: d.refusalFallback } },
      assignment: "not run",
      validation: `production taxonomy validator (validateTopicTaxonomy), at most ${MAX_TOPIC_ATTEMPTS} attempts with structured feedback`,
      matching: kind === "discovery-only" ? EXAMPLE_MATCHING : null,
    },
    oracleGate,
    runs,
    totals: summarizeUsage(runs.flatMap((r) => r.records)),
  };
}

export function renderDiscoveryBenchmarkMarkdown(result: DiscoveryBenchmarkResult): string {
  const m = result.meta;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const attempts = (r: DiscoveryRun) => r.attempts.map((a) => (a.outcome === "valid" ? `${a.attempt}: valid` : `${a.attempt}: ${a.outcome}${a.providerFailure ? ` (${a.providerFailure})` : ""} [${a.issueCodes.join(", ")}]`)).join("; ");
  const lines = [
    `# Topic ${m.kind === "smoke" ? "discovery smoke test" : "discovery-only benchmark"}`,
    "",
    m.notice,
    "",
    `Dataset ${m.dataset} (${m.datasetVersion}): topic base ${m.topicBase}${m.smokeComments !== undefined ? ` (first ${m.smokeComments} topic-base comments)` : ""}, discovery sample ${m.sampleSize} (seed ${m.sampleSeed}). Repeats: ${m.repeats}.`,
    `Discovery: ${m.discovery.modelRequested} (${m.discovery.provider}, ${m.discovery.contract}; ${Object.entries(m.discovery.settings).map(([k, v]) => `${k} ${v}`).join(", ")}). Assignment: not run.`,
    `Validation: ${m.validation}.`,
  ];
  if (result.oracleGate) lines.push(`Oracle gate (discovery-only evaluator on the gold taxonomy, offline): ${result.oracleGate.passed ? "PASSED" : `FAILED: ${result.oracleGate.failures.join("; ")}`}`);
  lines.push("");
  if (m.kind === "smoke") {
    lines.push("| run | provider status | validation | attempts | topics | latency |", "|---|---|---|---|---|---|");
    for (const r of result.runs) {
      const providerOk = r.attempts.every((a) => a.outcome !== "provider_error");
      lines.push(`| ${r.repeat} | ${providerOk ? "ok" : "provider_error"} | ${r.status === "valid" ? "valid" : "invalid"} (${attempts(r)}) | ${r.attempts.length} | ${r.topics ?? "–"} | ${r.latencyMs} ms |`);
    }
  } else {
    lines.push(`Matching: ${m.matching}`, "", "| repeat | status | attempts | topics | with examples | matched | precision | concept recall | merge | split | definition validity | latency |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of result.runs) {
      const t = r.taxonomy;
      lines.push(`| ${r.repeat} | ${r.status} | ${attempts(r)} | ${r.topics ?? "–"} | ${t?.topicsWithExamples ?? "–"} | ${t?.matchedTopics ?? "–"} | ${t ? pct(t.topicPrecision) : "–"} | ${t ? pct(t.conceptRecall) : "–"} | ${t?.mergeErrors ?? "–"} | ${t?.splitErrors ?? "–"} | ${t ? pct(t.definitionValidity) : "–"} | ${r.latencyMs} ms |`);
    }
    for (const r of result.runs.filter((x) => x.taxonomy)) {
      lines.push("", `Repeat ${r.repeat} topics → gold concept (example labels):`);
      for (const t of r.taxonomy!.matches) lines.push(`- ${t.key} "${t.name}" → ${t.goldKey ?? "no match"} (${t.exampleGold.join(", ") || "no examples"})`);
    }
  }
  const cost = result.totals.estimatedCostUsd;
  lines.push("", `Requests ${result.totals.requests} (${result.totals.failedRequests} failed); tokens in ${result.totals.inputTokens}, out ${result.totals.outputTokens}; cost ${cost === undefined ? "partly unpriced" : `$${cost.toFixed(4)}`}; models served ${[...new Set(result.runs.flatMap((r) => r.usage.modelsServed))].join(", ") || "none"}.`);
  return lines.join("\n");
}

export function discoveryResultFileName(result: DiscoveryBenchmarkResult): string {
  return `${result.meta.timestamp}-topics-${result.meta.dataset}-${result.meta.kind}-${result.meta.discovery.provider}-${result.meta.discovery.modelRequested}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".json";
}
