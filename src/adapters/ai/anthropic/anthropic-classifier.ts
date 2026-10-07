import Anthropic from "@anthropic-ai/sdk";
import { classificationJsonSchema } from "../../../core/classification/json-schema";
import { buildClassifierData, buildClassifierInstructions, PROMPT_VERSION } from "../../../core/classification/llm-prompt";
import type { ClassificationSchema } from "../../../core/classification/schema";
import { estimateCostUsd, type AiCallOutcome, type PriceTable, type UsageRecorder } from "../../../core/cost/usage";
import type { CommentInput, FocusTarget } from "../../../core/domain/types";
import type { ClassificationRequest, Classifier } from "../../../core/ports";

// Anthropic-specific code lives only in this adapter. The engine sees a Classifier returning untrusted `unknown`.

export const ANTHROPIC_PROVIDER = "anthropic";
export const DEFAULT_ANTHROPIC_CLASSIFIER_MODEL = "claude-haiku-4-5";

export interface AnthropicClassifierOptions {
  client: Anthropic;
  model?: string;
  /** Comments per request (M3 default 20; to be optimized later). */
  batchSize?: number;
  /** Output-token budget per comment in a batch, plus a fixed overhead. */
  maxTokensPerComment?: number;
  /** Attempts per batch for malformed output (transport retries are done by the SDK). */
  maxMalformedAttempts?: number;
  prices: PriceTable;
  recorder?: UsageRecorder;
  now?: () => number;
}

/** Errors that indicate a configuration problem; retrying would not help, so they are not swallowed. */
const NON_RETRYABLE = [Anthropic.AuthenticationError, Anthropic.PermissionDeniedError, Anthropic.BadRequestError, Anthropic.NotFoundError];

/**
 * Classifier backed by the Anthropic Messages API with JSON-schema structured output.
 * - Batches comments; each batch is one request with no tools.
 * - Transport failures (429, 5xx, timeouts, connection errors) are retried by the SDK client (`maxRetries`);
 *   if they persist, the batch yields no results, and the engine's per-comment retry decides what happens next.
 * - Malformed JSON is retried once; `max_tokens` truncation splits the batch in half; refusals yield no results.
 * - Every request is recorded for cost/latency benchmarking.
 */
export class AnthropicClassifier implements Classifier {
  readonly label: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly maxTokensPerComment: number;
  private readonly maxMalformedAttempts: number;
  private readonly prices: PriceTable;
  private readonly recorder: UsageRecorder | undefined;
  private readonly now: () => number;

  constructor(options: AnthropicClassifierOptions) {
    this.client = options.client;
    this.model = options.model ?? DEFAULT_ANTHROPIC_CLASSIFIER_MODEL;
    this.batchSize = options.batchSize ?? 20;
    this.maxTokensPerComment = options.maxTokensPerComment ?? 150;
    this.maxMalformedAttempts = options.maxMalformedAttempts ?? 2;
    this.prices = options.prices;
    this.recorder = options.recorder;
    this.now = options.now ?? Date.now;
    this.label = `Anthropic ${this.model} (${PROMPT_VERSION})`;
  }

  async classify(request: ClassificationRequest): Promise<unknown> {
    const results: unknown[] = [];
    for (let i = 0; i < request.comments.length; i += this.batchSize) {
      results.push(...(await this.classifyBatch(request.comments.slice(i, i + this.batchSize), request.schema, request.focus)));
    }
    return { results };
  }

  private async classifyBatch(comments: readonly CommentInput[], schema: ClassificationSchema, focus: FocusTarget | undefined): Promise<unknown[]> {
    for (let attempt = 1; attempt <= this.maxMalformedAttempts; attempt += 1) {
      const started = this.now();
      let message: Anthropic.Message;
      try {
        message = await this.client.messages.create(this.buildRequest(comments, schema, focus));
      } catch (error) {
        if (NON_RETRYABLE.some((cls) => error instanceof cls)) throw error;
        if (!(error instanceof Anthropic.APIError)) throw error;
        this.record(comments, schema, attempt, "provider_error", started, undefined, error.constructor.name);
        return [];
      }

      if (message.stop_reason === "refusal") {
        this.record(comments, schema, attempt, "refusal", started, message);
        return [];
      }
      if (message.stop_reason === "max_tokens") {
        this.record(comments, schema, attempt, "incomplete_output", started, message);
        if (comments.length === 1) return [];
        const half = Math.ceil(comments.length / 2);
        return [
          ...(await this.classifyBatch(comments.slice(0, half), schema, focus)),
          ...(await this.classifyBatch(comments.slice(half), schema, focus)),
        ];
      }

      const parsed = parseResults(message);
      if (parsed !== undefined) {
        this.record(comments, schema, attempt, "ok", started, message);
        return parsed;
      }
      this.record(comments, schema, attempt, "malformed_output", started, message);
    }
    return [];
  }

  /** Builds the request. Exposed for tests: no tools, fixed instructions, comment data only in the user turn. */
  buildRequest(comments: readonly CommentInput[], schema: ClassificationSchema, focus: FocusTarget | undefined): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: 256 + this.maxTokensPerComment * comments.length,
      temperature: 0,
      system: buildClassifierInstructions(schema),
      messages: [{ role: "user", content: buildClassifierData(comments, focus) }],
      output_config: { format: { type: "json_schema", schema: classificationJsonSchema(schema) } },
    };
  }

  private record(
    comments: readonly CommentInput[],
    schema: ClassificationSchema,
    attempt: number,
    outcome: AiCallOutcome,
    started: number,
    message?: Anthropic.Message,
    errorType?: string,
  ): void {
    const inputTokens = message?.usage.input_tokens;
    const outputTokens = message?.usage.output_tokens;
    const cost = estimateCostUsd(this.prices, this.model, inputTokens, outputTokens);
    this.recorder?.record({
      provider: ANTHROPIC_PROVIDER,
      model: this.model,
      ...(message ? { modelVersion: message.model } : {}),
      promptVersion: PROMPT_VERSION,
      schemaVersion: schema.version,
      batchSize: comments.length,
      attempt,
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

/**
 * Extracts the `results` array from the structured-output text block. Anything else — invalid JSON, a missing
 * `results` array, or any extra root field — is malformed. Items are passed on unvalidated; the engine validates them.
 */
function parseResults(message: Anthropic.Message): unknown[] | undefined {
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Array.isArray((value as { results?: unknown }).results)
    ) {
      return (value as { results: unknown[] }).results;
    }
  } catch {
    // fall through: malformed
  }
  return undefined;
}

/** Client with bounded transport retries and a per-request timeout. The key is read by the caller, never logged. */
export function createAnthropicClient(apiKey: string, options: { maxRetries?: number; timeoutMs?: number } = {}): Anthropic {
  return new Anthropic({ apiKey, maxRetries: options.maxRetries ?? 3, timeout: options.timeoutMs ?? 60_000 });
}
