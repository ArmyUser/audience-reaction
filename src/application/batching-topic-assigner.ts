import type { TopicAssigner, TopicAssignmentRequest } from "../core/ports";
import { TopicProviderError } from "../core/topics/provider-contracts";

// Batching for any TopicAssigner, preserving the frozen port semantics: one assignTopics call (one logical assignment
// phase of one outer attempt) is split into consecutive batches of at most `maxCommentsPerBatch` comments in request
// order; the entries are concatenated in batch order. There is no retry here: a batch whose provider call fails
// transiently (a TopicProviderError other than configuration) contributes no entries, so validation reports
// missing_assignment for exactly those comments and analyzeTopics' single outer retry reassigns only them.
// A configuration failure stops the whole call (retrying cannot help).

export interface BatchingTopicAssignerOptions {
  maxCommentsPerBatch: number;
  /** Called after each batch (for usage accounting and progress). */
  onBatch?: (info: { index: number; comments: number; failed: boolean }) => void;
}

export class BatchingTopicAssigner implements TopicAssigner {
  readonly label: string;

  constructor(
    private readonly inner: TopicAssigner,
    private readonly options: BatchingTopicAssignerOptions,
  ) {
    if (!Number.isInteger(options.maxCommentsPerBatch) || options.maxCommentsPerBatch < 1) throw new RangeError("maxCommentsPerBatch must be a positive integer");
    this.label = `${inner.label}, batches of ≤ ${options.maxCommentsPerBatch}`;
  }

  /** Deterministic batches: consecutive slices in request order. */
  static batchesOf<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    const entries: unknown[] = [];
    const batches = BatchingTopicAssigner.batchesOf(request.comments, this.options.maxCommentsPerBatch);
    for (const [index, comments] of batches.entries()) {
      try {
        const answer = await this.inner.assignTopics({ ...request, comments });
        entries.push(...answer);
        this.options.onBatch?.({ index, comments: comments.length, failed: false });
      } catch (error) {
        // Only a transient provider failure is absorbed. Configuration failures, structured invalid output
        // (TopicDiscoveryOutputError) and unexpected errors propagate unchanged, keeping the frozen semantics.
        if (!(error instanceof TopicProviderError) || error.failure === "configuration") throw error;
        this.options.onBatch?.({ index, comments: comments.length, failed: true });
      }
    }
    return entries;
  }
}
