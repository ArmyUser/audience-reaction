import Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, type AiCallOutcome, type PriceTable, type UsageRecorder } from "../../../core/cost/usage";
import type { TopicModelTransport } from "../../../core/ports";
import { TopicProviderError, type TopicModelRequest } from "../../../core/topics/provider-contracts";

// Anthropic transport for the topic contracts (used for topic-discovery-v1). Anthropic-specific code lives only here:
// it sends the rendered request as system instructions + one user message with JSON-schema structured output and
// returns the model's text exactly as received. Parsing and validation stay with the provider-neutral contract code.

export const ANTHROPIC_TOPIC_PROVIDER = "anthropic";
export const DEFAULT_ANTHROPIC_TOPIC_MODEL = "claude-sonnet-5-5";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicTopicTransportOptions {
  client: Anthropic;
  model?: string;
  /** Output ceiling per request, including adaptive thinking (non-streaming: keep ≤ ~16k). */
  maxOutputTokens?: number;
  effort?: AnthropicEffort;
  /**
   * Server-side refusal fallback ("default" routes a policy decline to another model inside the same call). The model
   * that actually answered is recorded as modelVersion, so a fallback is visible in the results.
   */
  refusalFallback?: "default" | "off";
  prices: PriceTable;
  recorder?: UsageRecorder;
  now?: () => number;
}

/** JSON Schema keywords the structured-output endpoint does not accept; the frozen validators enforce them instead. */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["minLength", "maxLength", "minItems", "maxItems", "pattern", "minimum", "maximum", "multipleOf", "exclusiveMinimum", "exclusiveMaximum"]);

/** The contract's output schema reduced to the subset structured outputs supports. Never adds or loosens anything else. */
export function toAnthropicOutputSchema(schema: unknown): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).filter(([k]) => !UNSUPPORTED_SCHEMA_KEYWORDS.has(k)).map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, strip(pv)])) : strip(v)]));
  };
  return strip(schema) as Record<string, unknown>;
}

export class AnthropicTopicTransport implements TopicModelTransport {
  readonly label: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly effort: AnthropicEffort;
  private readonly refusalFallback: "default" | "off";
  private readonly now: () => number;

  constructor(private readonly options: AnthropicTopicTransportOptions) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_TOPIC_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 16_000;
    this.effort = options.effort ?? "high";
    this.refusalFallback = options.refusalFallback ?? "default";
    this.now = options.now ?? Date.now;
    this.label = `Anthropic ${this.model}`;
  }

  /**
   * The exact API request for a rendered contract request. Exposed for tests. No tools, no sampling parameters (the
   * model rejects non-default values), adaptive thinking left at the model default; comment data only in the user turn.
   */
  buildRequest(request: TopicModelRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      system: request.instructions,
      messages: [{ role: "user", content: request.data }],
      output_config: { effort: this.effort, format: { type: "json_schema", schema: toAnthropicOutputSchema(request.outputSchema) } },
      ...(this.refusalFallback === "default" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
  }

  async complete(request: TopicModelRequest): Promise<string> {
    const started = this.now();
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.options.client.beta.messages.create(this.buildRequest(request));
    } catch (error) {
      const failure = failureOf(error);
      this.record(request, "provider_error", started, undefined, `${failure.failure === "configuration" ? "configuration:" : ""}${error instanceof Error ? error.constructor.name : "Error"}`);
      throw failure;
    }
    if (message.stop_reason === "refusal") {
      this.record(request, "refusal", started, message);
      throw new TopicProviderError(ANTHROPIC_TOPIC_PROVIDER, "refusal");
    }
    // Text exactly as produced (thinking and fallback blocks are not part of the answer). A max_tokens stop returns the
    // truncated text unchanged: the contract parser rejects it as invalid output; nothing is completed or repaired.
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    this.record(request, message.stop_reason === "max_tokens" ? "incomplete_output" : "ok", started, message);
    return text;
  }

  private record(request: TopicModelRequest, outcome: AiCallOutcome, started: number, message?: Anthropic.Beta.BetaMessage, errorType?: string): void {
    const inputTokens = message?.usage.input_tokens;
    const outputTokens = message?.usage.output_tokens;
    // Priced at the model that actually answered; a fallback model without a configured price stays unpriced.
    const cost = message ? estimateCostUsd(this.options.prices, message.model, inputTokens, outputTokens) : undefined;
    this.options.recorder?.record({
      provider: ANTHROPIC_TOPIC_PROVIDER,
      model: this.model,
      ...(message ? { modelVersion: message.model } : {}),
      promptVersion: request.contract,
      schemaVersion: request.contract,
      batchSize: commentCount(request),
      attempt: request.feedback ? 2 : 1,
      outcome,
      ...(errorType ? { errorType } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
      latencyMs: this.now() - started,
      timestamp: new Date().toISOString(),
    });
  }
}

/** Maps SDK errors to provider-neutral failures; the SDK message (which may echo provider text) is never kept. */
function failureOf(error: unknown): TopicProviderError {
  const status = error instanceof Anthropic.APIError && typeof error.status === "number" ? error.status : undefined;
  const failure =
    error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError
      ? "configuration"
      : error instanceof Anthropic.RateLimitError
        ? "rate_limited"
        : error instanceof Anthropic.APIConnectionTimeoutError
          ? "timeout"
          : error instanceof Anthropic.InternalServerError
            ? "unavailable"
            : "transport";
  return new TopicProviderError(ANTHROPIC_TOPIC_PROVIDER, failure, status);
}

function commentCount(request: TopicModelRequest): number {
  const line = request.data.split("\n")[2] ?? "";
  try {
    const comments = (JSON.parse(line) as { comments?: unknown[] }).comments;
    return Array.isArray(comments) ? comments.length : 0;
  } catch {
    return 0;
  }
}
