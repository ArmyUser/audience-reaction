import type { CostBudget } from "../core/cost/budget";
import type { ClassificationRequest, Classifier, TopicAssigner, TopicAssignmentRequest, TopicModelTransport } from "../core/ports";
import type { TopicModelRequest } from "../core/topics/provider-contracts";

// Port decorators that enforce a per-analysis CostBudget around every AI-provider call: reserve the call's
// worst-case cost first (refused → CostLimitReachedError, and the budget stays reached), make the call, then release
// the reservation; the call's actual cost reaches the budget through the adapter's usage recorder. The worst-case
// estimates are supplied by the composition root, which knows the models, limits and prices.

export class CostGuardedClassifier implements Classifier {
  readonly label: string;
  constructor(
    private readonly inner: Classifier,
    private readonly budget: CostBudget,
    private readonly worstCaseUsd: (request: ClassificationRequest) => number,
  ) {
    this.label = inner.label;
  }
  async classify(request: ClassificationRequest): Promise<unknown> {
    const release = this.budget.reserve(this.worstCaseUsd(request));
    try {
      return await this.inner.classify(request);
    } finally {
      release();
    }
  }
}

export class CostGuardedTopicTransport implements TopicModelTransport {
  readonly label: string;
  constructor(
    private readonly inner: TopicModelTransport,
    private readonly budget: CostBudget,
    private readonly worstCaseUsd: (request: TopicModelRequest) => number,
  ) {
    this.label = inner.label;
  }
  async complete(request: TopicModelRequest): Promise<string> {
    const release = this.budget.reserve(this.worstCaseUsd(request));
    try {
      return await this.inner.complete(request);
    } finally {
      release();
    }
  }
}

export class CostGuardedTopicAssigner implements TopicAssigner {
  readonly label: string;
  constructor(
    private readonly inner: TopicAssigner,
    private readonly budget: CostBudget,
    private readonly worstCaseUsd: (request: TopicAssignmentRequest) => number,
  ) {
    this.label = inner.label;
  }
  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    const release = this.budget.reserve(this.worstCaseUsd(request));
    try {
      return await this.inner.assignTopics(request);
    } finally {
      release();
    }
  }
}

/**
 * Splits one classification request into consecutive slices classified concurrently (for classifiers that make one
 * request per comment). The `results` arrays of the slices are concatenated in slice order; a slice whose output is
 * not `{ results: [...] }` contributes nothing, so validation rejects exactly its comments and the engine's per-comment
 * retry decides. If any slice throws, every slice is awaited first and the first error is rethrown.
 */
export class ConcurrentClassifier implements Classifier {
  readonly label: string;
  constructor(
    private readonly inner: Classifier,
    private readonly concurrency: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
    this.label = inner.label;
  }
  async classify(request: ClassificationRequest): Promise<unknown> {
    const size = Math.ceil(request.comments.length / this.concurrency);
    if (size === 0) return this.inner.classify(request);
    const slices: (typeof request.comments)[] = [];
    for (let i = 0; i < request.comments.length; i += size) slices.push(request.comments.slice(i, i + size));
    const settled = await Promise.allSettled(slices.map((comments) => this.inner.classify({ ...request, comments })));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
    const results = settled.flatMap((s) => {
      const value = (s as PromiseFulfilledResult<unknown>).value;
      return typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results) ? (value as { results: unknown[] }).results : [];
    });
    return { results };
  }
}
