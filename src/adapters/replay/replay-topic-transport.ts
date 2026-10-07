import type { TopicModelTransport } from "../../core/ports";
import type { TopicModelRequest, TopicPhase } from "../../core/topics/provider-contracts";

// Deterministic replay of recorded raw model responses, for offline tests and benchmarks. Per phase, call n returns
// response n of its script, exactly as given (no trimming, parsing or repair); a call beyond the script fails, so a
// scenario can never silently reuse a response. Every rendered request is recorded, including its retry feedback.
// No network, no clock, no randomness, no configuration or secrets.

export type ReplayScript = Readonly<Record<TopicPhase, readonly string[]>>;

export class ReplayTopicTransport implements TopicModelTransport {
  readonly requests: TopicModelRequest[] = [];

  constructor(
    private readonly script: ReplayScript,
    readonly label = "Replay transport (recorded responses)",
  ) {}

  /** Requests received for one phase, in call order. */
  requestsFor(phase: TopicPhase): TopicModelRequest[] {
    return this.requests.filter((r) => r.phase === phase);
  }

  async complete(request: TopicModelRequest): Promise<string> {
    const index = this.requestsFor(request.phase).length;
    this.requests.push(structuredClone(request));
    const responses = this.script[request.phase];
    if (index >= responses.length) throw new Error(`Replay script exhausted: no response ${index + 1} for ${request.phase}`);
    return responses[index]!;
  }
}
