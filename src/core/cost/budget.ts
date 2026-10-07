import type { AiCallRecord, UsageRecorder } from "./usage";

// Per-analysis hard cap on AI-provider spend (estimated USD from the configured price table). Guards reserve a
// worst-case cost before each provider call and release it afterwards; the recorded cost of every call is added as it
// arrives. While a call is in flight, both its reservation and any cost it has already recorded count, so the check is
// conservative: it may stop slightly early, never late. Once the cap is reached the budget stays reached: every later
// reservation is refused, so no further provider call is made, and the caller reports the analysis as stopped instead
// of continuing. YouTube quota units are not money and are not counted here.

export class CostLimitReachedError extends Error {
  override readonly name = "CostLimitReachedError";
  constructor(
    readonly limitUsd: number,
    readonly spentUsd: number,
  ) {
    super(`Analysis cost limit reached: $${spentUsd.toFixed(4)} spent, limit $${limitUsd.toFixed(2)}.`);
  }
}

export interface CostLimit {
  readonly limitUsd: number;
  /** Estimated USD recorded so far. */
  spentUsd(): number;
  /** True once a reservation was refused or recorded spend passed the limit. Never resets. */
  reached(): boolean;
}

export class CostBudget implements CostLimit, UsageRecorder {
  readonly entries: AiCallRecord[] = [];
  private spent = 0;
  private reserved = 0;
  private stopped = false;

  constructor(readonly limitUsd: number) {
    if (!(Number.isFinite(limitUsd) && limitUsd > 0)) throw new RangeError("limitUsd must be a positive number");
  }

  spentUsd(): number {
    return this.spent;
  }

  reached(): boolean {
    return this.stopped;
  }

  /**
   * Records one provider call. A call without a cost estimate (unknown price or tokens) cannot be bounded, so it
   * stops the budget (fail closed).
   */
  record(entry: AiCallRecord): void {
    this.entries.push(entry);
    if (entry.estimatedCostUsd === undefined) {
      this.stopped = true;
      return;
    }
    this.spent += entry.estimatedCostUsd;
    if (this.spent > this.limitUsd) this.stopped = true;
  }

  /**
   * Reserves `worstCaseUsd` for a call about to be made. Throws CostLimitReachedError (and stops the budget) when the
   * spend so far, the calls still in flight and this call could together exceed the limit. Returns the release
   * function, to be called once the call has finished (its actual cost is recorded separately).
   */
  reserve(worstCaseUsd: number): () => void {
    if (!(Number.isFinite(worstCaseUsd) && worstCaseUsd >= 0)) this.stopped = true;
    if (this.stopped || this.spent + this.reserved + worstCaseUsd > this.limitUsd) {
      this.stopped = true;
      throw new CostLimitReachedError(this.limitUsd, this.spent);
    }
    this.reserved += worstCaseUsd;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= worstCaseUsd;
    };
  }
}
