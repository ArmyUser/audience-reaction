import type { TopicAssigner, TopicAssignmentRequest, TopicModelTransport, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../core/ports";
import {
  buildTopicAssignmentRequest,
  buildTopicDiscoveryRequest,
  parseTopicAssignmentResponse,
  parseTopicDiscoveryResponse,
  rejectedTopicNamesOf,
  TOPIC_ASSIGNMENT_CONTRACT,
  TOPIC_DISCOVERY_CONTRACT,
  TOPIC_DISCOVERY_CONTRACT_V3,
  type TopicDiscoveryContract,
} from "../core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../core/topics/taxonomy";
import type { TopicIssueCode } from "../core/topics/types";
import { TopicDiscoveryOutputError } from "../core/topics/validation";

// The two topic phases driven by the provider-neutral contracts (topic-provider-contracts-v1.md). A model is reached
// only through a TopicModelTransport, so a vendor adapter later supplies a transport and nothing else. The flow per
// call is: render the versioned request → transport returns raw text → parse it into an untyped candidate. Unparseable
// text throws TopicDiscoveryOutputError (`invalid_output`); everything else is judged by the frozen M4 validators in
// TwoPhaseTopicDiscoverer / analyzeTopics.

/** Rejected raw discovery output kept for diagnostics, at most this many characters. */
export const MAX_REJECTED_DISCOVERY_OUTPUT_CHARS = 100_000;

/** The raw text of a discovery response that was rejected (unparseable or an invalid taxonomy), secrets removed. */
export interface RejectedDiscoveryOutput {
  /** 1-based call of this generator (one call per discovery attempt). */
  call: number;
  issueCodes: TopicIssueCode[];
  rawOutput: string;
  rawOutputChars: number;
  rawOutputTruncated: boolean;
}

/** Removes every occurrence of the given secrets (defensive: model output never needs them). */
export function redactDiscoverySecrets(text: string, secrets: readonly string[]): string {
  return secrets.filter((s) => s.length >= 8).reduce((t, s) => t.split(s).join("[REDACTED]"), text);
}

/**
 * Discovery through a versioned contract (topic-discovery-v2 by default, or v3). Every rejected response, unparseable
 * or failing the frozen taxonomy validator, is kept in `rejectedOutputs` with secrets removed (diagnostics only; the
 * validator check here never changes what is returned or how analyzeTopics decides). Under v3, a retry also reports
 * the names of the previous candidate that broke the name rule, with their counted words.
 */
export class ContractTopicTaxonomyGenerator implements TopicTaxonomyGenerator {
  readonly label: string;
  readonly contract: TopicDiscoveryContract;
  readonly rejectedOutputs: RejectedDiscoveryOutput[] = [];
  private calls = 0;
  private previousCandidate: unknown = null;
  constructor(
    private readonly transport: TopicModelTransport,
    private readonly options: { contract?: TopicDiscoveryContract; secrets?: readonly string[] } = {},
  ) {
    this.contract = options.contract ?? TOPIC_DISCOVERY_CONTRACT;
    this.label = `${transport.label} (${this.contract})`;
  }
  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    const call = ++this.calls;
    const rejectedTopicNames = this.contract === TOPIC_DISCOVERY_CONTRACT_V3 && request.feedback ? rejectedTopicNamesOf(this.previousCandidate) : [];
    this.previousCandidate = null;
    const raw = await this.transport.complete(buildTopicDiscoveryRequest(request, { contract: this.contract, rejectedTopicNames }));
    let candidate: unknown;
    try {
      candidate = parseTopicDiscoveryResponse(raw);
    } catch (error) {
      if (error instanceof TopicDiscoveryOutputError) this.reject(call, raw, error.issues.map((i) => i.code));
      throw error;
    }
    this.previousCandidate = candidate;
    const validation = validateTopicTaxonomy(candidate, { sampleCommentIds: request.sample.map((c) => c.id), maxTopics: request.context.maxTopics });
    if (validation.status === "invalid") this.reject(call, raw, validation.issues.map((i) => i.code));
    return candidate;
  }
  private reject(call: number, raw: unknown, codes: TopicIssueCode[]): void {
    const text = redactDiscoverySecrets(typeof raw === "string" ? raw : String(raw), this.options.secrets ?? []);
    this.rejectedOutputs.push({ call, issueCodes: [...new Set(codes)].sort(), rawOutput: text.slice(0, MAX_REJECTED_DISCOVERY_OUTPUT_CHARS), rawOutputChars: text.length, rawOutputTruncated: text.length > MAX_REJECTED_DISCOVERY_OUTPUT_CHARS });
  }
}

export class ContractTopicAssigner implements TopicAssigner {
  readonly label: string;
  constructor(private readonly transport: TopicModelTransport) {
    this.label = `${transport.label} (${TOPIC_ASSIGNMENT_CONTRACT})`;
  }
  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    return parseTopicAssignmentResponse(await this.transport.complete(buildTopicAssignmentRequest(request)));
  }
}
