import { ApiError, GoogleGenAI, ThinkingLevel, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { estimateCostUsd, type AiCallOutcome, type PriceTable, type UsageRecorder } from "../../../core/cost/usage";
import type { TopicModelTransport } from "../../../core/ports";
import { TopicProviderError, type TopicModelRequest } from "../../../core/topics/provider-contracts";

// Google Gemini transport for the topic contracts (used for topic-discovery-v1). Gemini-specific code lives only here:
// it sends the rendered request as a system instruction + one user turn with JSON-schema structured output
// (models.generateContent, responseJsonSchema) and returns the model's answer text exactly as received. Parsing and
// validation stay with the provider-neutral contract code, exactly as for the Anthropic transport.

export const GOOGLE_TOPIC_PROVIDER = "google";
export const DEFAULT_GEMINI_TOPIC_MODEL = "gemini-3.8-flash";

/** Thinking levels gemini-3.8-flash and gemini-3.7-flash accept (MINIMAL is rejected by the API for both; LOW is the lowest). */
export const GEMINI_THINKING_LEVELS = ["low", "medium", "high"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

const SDK_THINKING_LEVEL: Record<GeminiThinkingLevel, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

/**
 * A Gemini API client (never Vertex AI) with an explicit key. The SDK would otherwise fall back to GOOGLE_API_KEY /
 * GEMINI_API_KEY from the process environment, so an empty key is rejected here, before any request exists. The
 * SDK's own retries cover 408, 429 and 5xx; `fetch` is injectable so tests never reach the network.
 */
export function createGeminiClient(apiKey: string, options: { maxRetries?: number; timeoutMs?: number; fetch?: typeof fetch } = {}): GoogleGenAI {
  if (apiKey.trim().length === 0) throw new Error("Gemini API key is missing; no request was made.");
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: {
      timeout: options.timeoutMs ?? 60_000,
      retryOptions: { attempts: (options.maxRetries ?? 3) + 1 },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
}

export interface GeminiTopicTransportOptions {
  client: GoogleGenAI;
  model?: string;
  /** Output ceiling per request; Gemini counts thinking tokens against it and bills them as output. */
  maxOutputTokens?: number;
  thinkingLevel?: GeminiThinkingLevel;
  prices: PriceTable;
  recorder?: UsageRecorder;
  now?: () => number;
}

/** JSON Schema keywords responseJsonSchema accepts (SDK documentation); minLength, maxLength and pattern are not among them. */
const SUPPORTED_SCHEMA_KEYWORDS = new Set(["$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering"]);

/**
 * The contract's output schema reduced to the keywords responseJsonSchema supports. Never adds or loosens anything
 * else; the frozen validators still enforce the dropped length and pattern rules.
 */
export function toGeminiResponseSchema(schema: unknown): Record<string, unknown> {
  const keep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(keep);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => SUPPORTED_SCHEMA_KEYWORDS.has(k))
        .map(([k, v]) => [k, k === "properties" || k === "$defs" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, keep(pv)])) : keep(v)]),
    );
  };
  return keep(schema) as Record<string, unknown>;
}

/** Finish reasons that mean the model declined or was stopped by a policy filter. */
const POLICY_FINISH_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

export class GeminiTopicTransport implements TopicModelTransport {
  readonly label: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly thinkingLevel: GeminiThinkingLevel;
  private readonly now: () => number;

  constructor(private readonly options: GeminiTopicTransportOptions) {
    this.model = options.model ?? DEFAULT_GEMINI_TOPIC_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 16_000;
    this.thinkingLevel = options.thinkingLevel ?? "low";
    this.now = options.now ?? Date.now;
    this.label = `Google ${this.model}`;
  }

  /**
   * The exact SDK request for a rendered contract request. Exposed for tests. No tools and no sampling parameters
   * (Gemini 3.x models are meant to run at their defaults); comment data only in the user turn.
   */
  buildRequest(request: TopicModelRequest): GenerateContentParameters {
    return {
      model: this.model,
      contents: [{ role: "user", parts: [{ text: request.data }] }],
      config: {
        systemInstruction: request.instructions,
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiResponseSchema(request.outputSchema),
        thinkingConfig: { thinkingLevel: SDK_THINKING_LEVEL[this.thinkingLevel] },
        maxOutputTokens: this.maxOutputTokens,
      },
    };
  }

  async complete(request: TopicModelRequest): Promise<string> {
    const started = this.now();
    let response: GenerateContentResponse;
    try {
      response = await this.options.client.models.generateContent(this.buildRequest(request));
    } catch (error) {
      const failure = failureOf(error);
      this.record(request, "provider_error", started, undefined, `${failure.failure === "configuration" ? "configuration:" : ""}${error instanceof ApiError ? `HTTP${error.status}` : error instanceof Error ? error.name : "Error"}`);
      throw failure;
    }
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason as string | undefined;
    if (response.promptFeedback?.blockReason || (finishReason && POLICY_FINISH_REASONS.has(finishReason))) {
      this.record(request, "refusal", started, response);
      throw new TopicProviderError(GOOGLE_TOPIC_PROVIDER, "refusal");
    }
    // Answer text exactly as produced (thought parts are not part of the answer). A MAX_TOKENS stop returns the
    // truncated text unchanged: the contract parser rejects it as invalid output; nothing is completed or repaired.
    const text = (candidate?.content?.parts ?? []).flatMap((p) => (typeof p.text === "string" && p.thought !== true ? [p.text] : [])).join("");
    this.record(request, finishReason === "MAX_TOKENS" ? "incomplete_output" : "ok", started, response);
    return text;
  }

  private record(request: TopicModelRequest, outcome: AiCallOutcome, started: number, response?: GenerateContentResponse, errorType?: string): void {
    const usage = response?.usageMetadata;
    const inputTokens = usage?.promptTokenCount;
    // Thinking tokens are billed as output.
    const outputTokens = usage && (usage.candidatesTokenCount !== undefined || usage.thoughtsTokenCount !== undefined) ? (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) : undefined;
    const cost = response ? estimateCostUsd(this.options.prices, this.model, inputTokens, outputTokens) : undefined;
    this.options.recorder?.record({
      provider: GOOGLE_TOPIC_PROVIDER,
      model: this.model,
      ...(response?.modelVersion ? { modelVersion: response.modelVersion } : {}),
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

/** Read-only model lookup (no inference, no cost). Returns the served model name. */
export async function checkGeminiModel(client: GoogleGenAI, model: string): Promise<string> {
  const info = await client.models.get({ model });
  return info.name ?? model;
}

/** Maps SDK errors to provider-neutral failures; the SDK message (which may echo provider text) is never kept. */
function failureOf(error: unknown): TopicProviderError {
  if (error instanceof ApiError) {
    const s = error.status;
    const failure = [400, 401, 403, 404, 422].includes(s) ? "configuration" : s === 429 ? "rate_limited" : s === 408 || s === 504 ? "timeout" : s >= 500 ? "unavailable" : "transport";
    return new TopicProviderError(GOOGLE_TOPIC_PROVIDER, failure, s);
  }
  const name = error instanceof Error ? error.name : "";
  return new TopicProviderError(GOOGLE_TOPIC_PROVIDER, name === "AbortError" || name === "TimeoutError" ? "timeout" : "transport");
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
