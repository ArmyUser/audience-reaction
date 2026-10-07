import type { TopicDiscoverer, TopicDiscoveryRequest, TopicDiscoveryRunInfo, TopicModelTransport, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../core/ports";
import { minimumTopicSize } from "../core/topics/aggregate-topics";
import {
  buildTopicConsolidationRequest,
  consolidationExampleIds,
  consolidationMaxTopics,
  parseTopicConsolidationResponse,
  TOPIC_CONSOLIDATION_CONTRACT,
  type TopicConsolidationContract,
  type TopicConsolidationRequest,
} from "../core/topics/consolidation-contract";
import { TopicProviderError } from "../core/topics/provider-contracts";
import { validateTopicTaxonomy, type ValidatedTaxonomy } from "../core/topics/taxonomy";
import { sanitizeReportedIssues, toValidationFeedback } from "../core/topics/topic-result";
import type { TopicIssue, TopicParameters, TopicValidationFeedback } from "../core/topics/types";
import { TopicDiscoveryOutputError } from "../core/topics/validation";
import { MAX_TOPIC_ATTEMPTS } from "./analyze-topics";

// Taxonomy consolidation for the local app: discovery → frozen taxonomy validation of the candidate → consolidation
// (topic-consolidation-v3 by default) with its own single retry → the consolidated taxonomy goes to
// TwoPhaseTopicDiscoverer, which validates it again and assigns against it. This is the taxonomy path of the validated
// pipeline (docs/topic-validation-t1-t2-t3-sonnet-v3.md: discovery v2 → consolidation v3 → assignment).
//
// It reproduces the decisions of the benchmark's ConsolidatingTaxonomyGenerator and runConsolidationAttempts
// (src/benchmark/topic-real-consolidated.ts, topic-discovery-consolidated.ts) without their instrumentation; the
// benchmark code is left untouched and tests/application/topic-consolidation.test.ts checks that both produce the
// same requests, results and errors. Everything model-facing (prompt, parser, validator) is the frozen core contract.
// Failure semantics, as in the benchmark: discovery keeps the production rule (analyzeTopics retries it once);
// consolidation gets at most two attempts with feedback; if it still fails, the analysis's remaining attempt ends
// without new provider calls and topics are unavailable. The unconsolidated taxonomy is never used as a fallback.

/** Consolidation failed after its own retry; the analysis ends with topics unavailable. */
export class TaxonomyConsolidationUnavailableError extends Error {
  override readonly name = "TaxonomyConsolidationUnavailableError";
  constructor() {
    super("taxonomy consolidation failed after its retry");
  }
}

/** Topic base and minimum topic size of the analysis in progress, which the consolidation prompt states. */
export interface ConsolidationEvidence {
  topicBase: number;
  minTopicSize: number;
}

/**
 * Observes the analysis's topic base (the sentiment-base comments analyzeTopics sends, spam excluded) so consolidation
 * can state the same base and minimum topic size the report uses. One instance per analysis.
 */
export class TopicBaseObserver implements TopicDiscoverer {
  readonly label: string;
  private base: number | undefined;
  constructor(
    private readonly inner: TopicDiscoverer,
    private readonly params: Pick<TopicParameters, "minTopicSizeFloor" | "minTopicSizePercentOfBase">,
  ) {
    this.label = inner.label;
  }
  discoverTopics(request: TopicDiscoveryRequest): Promise<unknown> {
    this.base = request.comments.length;
    return this.inner.discoverTopics(request);
  }
  finishRun(runId: string): TopicDiscoveryRunInfo | undefined {
    return this.inner.finishRun?.(runId);
  }
  /** Throws if no topic request has been seen yet (consolidation never runs before discovery). */
  evidence(): ConsolidationEvidence {
    if (this.base === undefined) throw new Error("topic base not observed yet");
    return { topicBase: this.base, minTopicSize: minimumTopicSize(this.base, this.params) };
  }
}

type ConsolidationOutcome = { status: "valid"; taxonomy: ValidatedTaxonomy } | { status: "skipped" } | { status: "unavailable"; configuration: boolean };

/** At most MAX_TOPIC_ATTEMPTS consolidation attempts; an invalid result or provider error is retried once with feedback. */
async function consolidate(
  transport: TopicModelTransport,
  contract: TopicConsolidationContract,
  candidate: ValidatedTaxonomy,
  sample: TopicConsolidationRequest["sample"],
  context: TopicConsolidationRequest["context"],
): Promise<ConsolidationOutcome> {
  if (candidate.topics.length === 0) return { status: "skipped" };
  const allowedExamples = consolidationExampleIds(candidate);
  const allowed = new Set(allowedExamples);
  const maxTopics = consolidationMaxTopics({ candidate, context });
  let feedback: TopicValidationFeedback | undefined;
  let configuration = false;
  for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
    let issues: TopicIssue[];
    try {
      const raw = await transport.complete(buildTopicConsolidationRequest({ candidate, sample, context, ...(feedback ? { feedback } : {}) }, contract));
      const validation = validateTopicTaxonomy(parseTopicConsolidationResponse(raw), { sampleCommentIds: allowedExamples, maxTopics });
      if (validation.status === "valid") return { status: "valid", taxonomy: validation.taxonomy };
      issues = sanitizeReportedIssues(validation.issues, allowed);
    } catch (error) {
      if (error instanceof TopicDiscoveryOutputError) issues = sanitizeReportedIssues(error.issues, allowed);
      else {
        issues = [{ code: "provider_error" }];
        if (error instanceof TopicProviderError && error.failure === "configuration") configuration = true;
      }
    }
    feedback = toValidationFeedback(attempt, issues, allowedExamples);
  }
  return { status: "unavailable", configuration };
}

export class ConsolidatingTopicTaxonomyGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  private exhausted = false;

  constructor(
    private readonly discovery: TopicTaxonomyGenerator,
    private readonly transport: TopicModelTransport,
    private readonly evidence: () => ConsolidationEvidence,
    private readonly contract: TopicConsolidationContract = TOPIC_CONSOLIDATION_CONTRACT,
  ) {
    this.label = `${discovery.label} → consolidation (${contract})`;
  }

  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    // Consolidation already failed after its retry in this analysis: end it without calling a provider.
    if (this.exhausted) throw new TaxonomyConsolidationUnavailableError();
    const raw = await this.discovery.proposeTaxonomy(request);
    const candidate = validateTopicTaxonomy(raw, { sampleCommentIds: request.sample.map((c) => c.id), maxTopics: request.context.maxTopics });
    if (candidate.status === "invalid") throw new TopicDiscoveryOutputError(candidate.issues);

    const context = { ...(request.context.focus ? { focus: request.context.focus } : {}), maxTopics: request.context.maxTopics, ...this.evidence() };
    const result = await consolidate(this.transport, this.contract, candidate.taxonomy, request.sample, context);
    if (result.status === "valid") return { topics: result.taxonomy.topics.map((t) => ({ key: t.key, name: t.proposedName, definition: t.definition, exampleCommentIds: [...t.exampleCommentIds] })) };
    // An empty candidate has nothing to consolidate: zero topics is a valid taxonomy.
    if (result.status === "skipped") return { topics: [] };
    this.exhausted = true;
    if (result.configuration) throw new TopicProviderError("consolidation", "configuration");
    throw new TaxonomyConsolidationUnavailableError();
  }
}
