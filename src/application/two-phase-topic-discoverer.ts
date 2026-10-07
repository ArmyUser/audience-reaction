import type { TopicAssigner, TopicDiscoverer, TopicDiscoveryComment, TopicDiscoveryRequest, TopicDiscoveryRunInfo, TopicTaxonomyGenerator } from "../core/ports";
import {
  DEFAULT_DISCOVERY_SAMPLE_PARAMETERS,
  selectDiscoverySample,
  toDiscoverySampleMethod,
  type DiscoveryCandidate,
  type DiscoverySample,
  type DiscoverySampleParameters,
} from "../core/topics/discovery-sample";
import { retryScope, toTopicDiscoveryOutput, validateTopicTaxonomy, type ValidatedTaxonomy } from "../core/topics/taxonomy";
import type { TopicIssue, TopicValidationFeedback } from "../core/topics/types";
import { TopicDiscoveryOutputError } from "../core/topics/validation";

export interface TwoPhaseTopicDiscovererOptions {
  generator: TopicTaxonomyGenerator;
  assigner: TopicAssigner;
  /** Discovery sample settings; the seed is recorded with the sample. */
  sample: Partial<Omit<DiscoverySampleParameters, "seed">> & { seed: string };
  /**
   * After assignment issues that all name comments: redo only those comments (`affected`, allowed by the
   * TopicAssigner contract) or every comment (`all`).
   */
  assignmentRetry?: "affected" | "all";
}

/**
 * Safety bound for runs that never call finishRun (e.g. a caller without run identity). analyzeTopics always ends its
 * runs, so in normal operation the map holds only analyses in progress.
 */
export const MAX_OPEN_TOPIC_RUNS = 64;

/** Per-run state, kept between the first attempt and its single retry. Holds IDs and the taxonomy, never text. */
interface RunState {
  /** Seed + ordered comment IDs: a retry must be for exactly the same comments. */
  fingerprint: string;
  sample: DiscoverySample;
  taxonomy?: ValidatedTaxonomy;
  /** The phase that failed in the last call (provider error, invalid taxonomy, unusable assignment response). */
  failedPhase?: "taxonomy" | "assignment";
  /** The last assignment response, entry by entry, for affected-only retries. */
  entries: unknown[];
}

/**
 * TopicDiscoverer built from two roles (design: m4-topic-provider-design.md §7):
 * 1. a seeded, stratified discovery sample (spec §7.2) from the request's sampling labels;
 * 2. discovery on the sample only (`TopicTaxonomyGenerator`; text and IDs, no classification labels);
 * 3. strict AC-21 taxonomy validation; an invalid taxonomy is never assigned against: the call throws
 *    TopicDiscoveryOutputError with the structured issues, and analyzeTopics retries;
 * 4. assignment of every eligible comment against the validated taxonomy (`TopicAssigner`);
 * 5. the frozen output ({ topics, assignments }), validated by analyzeTopics (validateTopicAttempt), which stays the
 *    only assignment validator and owns the two-attempt limit.
 * On the retry (a request with feedback, the same run identity, comments and seed) the previous call is corrected,
 * not redone from scratch: taxonomy issues → rediscover from the same sample, then assign all; assignment issues →
 * keep the taxonomy and reassign the affected comments (or all). Retry state is kept per run identity, so one
 * instance can serve concurrent analyses; `finishRun` releases it and reports the sampling methodology. The run
 * identity is never passed to the phase providers.
 */
export class TwoPhaseTopicDiscoverer implements TopicDiscoverer {
  readonly label: string;
  private readonly sampleParams: DiscoverySampleParameters;
  /** One entry per run identity (request.run.id), so concurrent analyses on one instance never share state. */
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly options: TwoPhaseTopicDiscovererOptions) {
    this.label = `Two-phase topics (${options.generator.label} + ${options.assigner.label})`;
    this.sampleParams = { ...DEFAULT_DISCOVERY_SAMPLE_PARAMETERS, ...options.sample };
  }

  /** Open runs (for tests and monitoring). */
  get openRuns(): number {
    return this.runs.size;
  }

  async discoverTopics(request: TopicDiscoveryRequest): Promise<unknown> {
    const fingerprint = runFingerprint(this.sampleParams.seed, request.comments);
    // Without run identity (a caller other than analyzeTopics), runs are told apart by their comments only.
    const runKey = request.run ? `run:${request.run.id}` : `comments:${fingerprint}`;
    const stored = this.runs.get(runKey);
    const previous = stored?.fingerprint === fingerprint ? stored : undefined;
    if (!request.feedback || !previous) return this.freshRun(runKey, fingerprint, request);

    const scope = retryScope(request.feedback);
    if (scope === "taxonomy" || !previous.taxonomy || (scope === "unknown" && previous.failedPhase === "taxonomy")) {
      return this.discoverThenAssign(previous, request, request.feedback);
    }
    const affected = scope === "assignment" ? affectedComments(request.feedback) : undefined;
    if (affected && (this.options.assignmentRetry ?? "affected") === "affected") {
      return this.reassign(previous, previous.taxonomy, request, request.feedback, affected);
    }
    return this.reassign(previous, previous.taxonomy, request, request.feedback);
  }

  /** Releases the run's state and returns its sampling methodology (no comment IDs or text). */
  finishRun(runId: string): TopicDiscoveryRunInfo | undefined {
    const state = this.runs.get(`run:${runId}`);
    this.runs.delete(`run:${runId}`);
    return state ? { discoverySample: toDiscoverySampleMethod(state.sample, this.sampleParams) } : undefined;
  }

  private freshRun(runKey: string, fingerprint: string, request: TopicDiscoveryRequest): Promise<unknown> {
    const candidates = request.comments.map(candidateOf);
    const state: RunState = { fingerprint, sample: selectDiscoverySample(candidates, this.sampleParams), entries: [] };
    this.runs.delete(runKey);
    this.runs.set(runKey, state);
    while (this.runs.size > MAX_OPEN_TOPIC_RUNS) this.runs.delete(this.runs.keys().next().value!);
    return this.discoverThenAssign(state, request, undefined);
  }

  private async discoverThenAssign(state: RunState, request: TopicDiscoveryRequest, feedback: TopicValidationFeedback | undefined): Promise<unknown> {
    const sampled = new Set(state.sample.commentIds);
    state.taxonomy = undefined;
    state.failedPhase = "taxonomy";
    const proposal = await this.options.generator.proposeTaxonomy({
      // Discovery sees only the sample's IDs and text: no classification labels.
      sample: request.comments.filter((c) => sampled.has(c.id)).map((c) => ({ id: c.id, text: c.text })),
      context: request.context,
      ...(feedback ? { feedback } : {}),
    });
    const validation = validateTopicTaxonomy(proposal, { sampleCommentIds: state.sample.commentIds, maxTopics: request.context.maxTopics });
    if (validation.status === "invalid") throw new TopicDiscoveryOutputError(validation.issues);
    state.taxonomy = validation.taxonomy;
    // A new taxonomy invalidates earlier assignments: everything is assigned afresh, without assignment feedback.
    return this.reassign(state, validation.taxonomy, request, undefined);
  }

  /** Assigns `only` (affected comments) or every comment; merges an affected-only answer with the kept entries. */
  private async reassign(
    state: RunState,
    taxonomy: ValidatedTaxonomy,
    request: TopicDiscoveryRequest,
    feedback: TopicValidationFeedback | undefined,
    only?: ReadonlySet<string>,
  ): Promise<unknown> {
    state.failedPhase = "assignment";
    const comments = (only ? request.comments.filter((c) => only.has(c.id)) : request.comments).map((c) => ({ id: c.id, text: c.text }));
    const response: unknown = await this.options.assigner.assignTopics({
      comments,
      taxonomy: taxonomy.topics.map((t) => ({ key: t.key, name: t.name, definition: t.definition })),
      context: request.context,
      ...(feedback ? { feedback } : {}),
    });
    if (!Array.isArray(response)) throw new TopicDiscoveryOutputError([{ code: "invalid_output" } satisfies TopicIssue]);
    const kept = only
      ? state.entries.filter((e) => {
          const id = entryCommentId(e);
          return id !== undefined && !only.has(id);
        })
      : [];
    state.entries = [...kept, ...response];
    state.failedPhase = undefined;
    return toTopicDiscoveryOutput(taxonomy, state.entries);
  }
}

function candidateOf(c: TopicDiscoveryComment): DiscoveryCandidate {
  // Without sampling labels a comment is treated as a neutral, substantive opinion (no stratification signal).
  return {
    id: c.id,
    text: c.text,
    type: c.classification?.type ?? "opinion",
    sentiment: c.classification?.sentiment ?? "neutral",
    focusMentioned: c.classification?.focusMentioned ?? false,
  };
}

/** Same comments (in order) and seed → same fingerprint. */
function runFingerprint(seed: string, comments: readonly TopicDiscoveryComment[]): string {
  return `${seed}\u0000${comments.map((c) => c.id).join("\u0001")}`;
}

/** The comment IDs named by assignment feedback, or undefined when some issue names none (then all are redone). */
function affectedComments(feedback: TopicValidationFeedback): ReadonlySet<string> | undefined {
  const ids = new Set<string>();
  for (const issue of feedback.issues) {
    // An issue code counted more often than it names comments includes entries no comment can be blamed for.
    if (!issue.commentIds || issue.commentIds.length === 0 || issue.commentIds.length < issue.count) return undefined;
    for (const id of issue.commentIds) ids.add(id);
  }
  return ids.size > 0 ? ids : undefined;
}

function entryCommentId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("commentId" in entry)) return undefined;
  const id = (entry as { commentId: unknown }).commentId;
  return typeof id === "string" ? id : undefined;
}
