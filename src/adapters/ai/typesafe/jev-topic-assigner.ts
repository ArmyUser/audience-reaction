import { z } from "zod";
import { estimateCostUsd, type AiCallOutcome, type PriceTable, type UsageRecorder } from "../../../core/cost/usage";
import type { FocusTarget } from "../../../core/domain/types";
import type { TopicAssigner, TopicAssignmentRequest } from "../../../core/ports";
import { TOPIC_ASSIGNMENT_CONTRACT, TopicProviderError } from "../../../core/topics/provider-contracts";
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, JEV_PROVIDER } from "./jev-classifier";
import type { JevChoiceQuestion } from "./jev-questions";
import {
  buildJevTopicQuestion,
  buildJevTopicSentimentQuestion,
  buildJevTopicSentimentState,
  buildJevTopicState,
  JEV_TOPIC_KEYS,
  JEV_TOPIC_QUESTION_SET,
  NO_SPECIFIC_TOPIC_OPTION,
  OTHER_OPTION,
  retryCodesFor,
  TOPIC_OPTION_PREFIX,
  type TaxonomyTopic,
} from "./jev-topic-questions";

// TypeSafe Jev behind the TopicAssigner port (topic-assignment-v1 via question set jev-topic-a1). Independent of the
// Jev classifier: its own questions, no classifier labels in any request, and the classifier's results are never read.
// Transport conventions follow the classifier adapter (POST /v1/systemone, bearer key, bounded retries with backoff
// for 429/5xx/timeouts/network errors only). Validation retries are not done here: analyzeTopics owns them.

export interface JevTopicAssignerOptions {
  apiKey: string;
  /** Requested alias; the version the response reports is recorded as modelVersion. */
  model?: string;
  baseUrl?: string;
  /** Comments processed concurrently within one call (order of the output never depends on it). */
  concurrency?: number;
  /** Transport retries per HTTP request (429, 5xx, timeouts, network). */
  maxTransportRetries?: number;
  timeoutMs?: number;
  prices: PriceTable;
  recorder?: UsageRecorder;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const choiceAnswer = z.object({ type: z.literal("choice"), choice: z.string() }).passthrough();
const jevResponse = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

type Answer = { kind: "choice"; choice: string } | { kind: "missing" };

/**
 * One disposition per requested comment, in request order:
 * - step 1 answer `topic:<key>` → primary_topic with that key; `other` / `no_specific_topic` → that disposition. A key
 *   outside the taxonomy is passed on without asking for a sentiment (there is no topic to ask about), so validation
 *   rejects the entry (invalid_assignment);
 * - step 2 (primary topics only) → topicSentiment exactly as answered (a label outside the schema fails validation);
 * - any other option string is passed on as the disposition, so validation reports invalid_assignment;
 * - no usable answer (transport failure after retries, malformed body) → no entry: validation reports
 *   missing_assignment, and the outer retry reassigns only those comments.
 * Nothing is defaulted, guessed or repaired. Configuration failures (bad key, unknown model, rejected request) throw.
 */
export class JevTopicAssigner implements TopicAssigner {
  readonly label: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly concurrency: number;
  private readonly maxTransportRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: JevTopicAssignerOptions) {
    this.model = options.model ?? DEFAULT_JEV_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, "");
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxTransportRetries = options.maxTransportRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.label = `TypeSafe ${this.model} (${JEV_TOPIC_QUESTION_SET})`;
  }

  /** Step-1 request body for one comment. Exposed for tests. */
  buildTopicRequestBody(text: string, focus: FocusTarget | undefined, taxonomy: readonly TaxonomyTopic[], retryCodes?: readonly string[]) {
    return { model: this.model, state: buildJevTopicState(text, focus, taxonomy, retryCodes), questions: { [JEV_TOPIC_KEYS.topic]: buildJevTopicQuestion(taxonomy) } };
  }

  /** Step-2 request body for one comment and its assigned topic. Exposed for tests. */
  buildSentimentRequestBody(text: string, focus: FocusTarget | undefined, topic: TaxonomyTopic, labels: TopicAssignmentRequest["context"]["sentimentLabels"]) {
    return { model: this.model, state: buildJevTopicSentimentState(text, focus, topic), questions: { [JEV_TOPIC_KEYS.topicSentiment]: buildJevTopicSentimentQuestion(labels) } };
  }

  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    const results: (Record<string, unknown> | undefined)[] = new Array(request.comments.length);
    let next = 0;
    const worker = async () => {
      while (next < request.comments.length) {
        const index = next++;
        results[index] = await this.assignOne(request, index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, request.comments.length) }, worker));
    return results.filter((r): r is Record<string, unknown> => r !== undefined);
  }

  private async assignOne(request: TopicAssignmentRequest, index: number): Promise<Record<string, unknown> | undefined> {
    const comment = request.comments[index]!;
    const focus = request.context.focus;
    const step1 = this.buildTopicRequestBody(comment.text, focus, request.taxonomy, retryCodesFor(request.feedback, comment.id));
    const topicAnswer = await this.ask(step1, JEV_TOPIC_KEYS.topic, request.comments.length, request.feedback !== undefined);
    if (topicAnswer.kind === "missing") return undefined;
    const choice = topicAnswer.choice;
    if (choice === OTHER_OPTION || choice === NO_SPECIFIC_TOPIC_OPTION) return { commentId: comment.id, disposition: choice };
    if (!choice.startsWith(TOPIC_OPTION_PREFIX)) return { commentId: comment.id, disposition: choice };

    const key = choice.slice(TOPIC_OPTION_PREFIX.length);
    const topic = request.taxonomy.find((t) => t.key === key);
    // An option outside the taxonomy is not asked about further; validation rejects the incomplete entry.
    if (!topic) return { commentId: comment.id, disposition: "primary_topic", topicKey: key };
    const step2 = this.buildSentimentRequestBody(comment.text, focus, topic, request.context.sentimentLabels);
    const sentiment = await this.ask(step2, JEV_TOPIC_KEYS.topicSentiment, request.comments.length, request.feedback !== undefined);
    return sentiment.kind === "missing"
      ? { commentId: comment.id, disposition: "primary_topic", topicKey: key }
      : { commentId: comment.id, disposition: "primary_topic", topicKey: key, topicSentiment: sentiment.choice };
  }

  /** One question request with transport retries. Returns the raw choice string, or missing. */
  private async ask(body: { questions: Record<string, JevChoiceQuestion> }, key: string, batchSize: number, isRetry: boolean): Promise<Answer> {
    const payload = JSON.stringify(body);
    for (let attempt = 1; attempt <= this.maxTransportRetries + 1; attempt += 1) {
      const started = this.now();
      let response: Response;
      try {
        response = await this.post(payload);
      } catch (error) {
        this.record(batchSize, isRetry, "provider_error", started, undefined, error instanceof Error && error.name === "AbortError" ? "timeout" : "network");
        if (attempt <= this.maxTransportRetries) await this.sleep(backoffMs(attempt));
        continue;
      }
      if ([400, 401, 403, 404, 422].includes(response.status)) {
        this.record(batchSize, isRetry, "provider_error", started, undefined, `configuration:HTTP${response.status}`);
        throw new TopicProviderError(JEV_PROVIDER, "configuration", response.status);
      }
      if (!response.ok) {
        this.record(batchSize, isRetry, "provider_error", started, undefined, `HTTP${response.status}`);
        if (attempt <= this.maxTransportRetries) await this.sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        this.record(batchSize, isRetry, "malformed_output", started);
        return { kind: "missing" };
      }
      const parsed = jevResponse.safeParse(json);
      if (!parsed.success) {
        this.record(batchSize, isRetry, "malformed_output", started);
        return { kind: "missing" };
      }
      const answer = choiceAnswer.safeParse(parsed.data.answers[key]);
      this.record(batchSize, isRetry, answer.success ? "ok" : "malformed_output", started, parsed.data);
      return answer.success ? { kind: "choice", choice: answer.data.choice } : { kind: "missing" };
    }
    return { kind: "missing" };
  }

  private async post(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private record(batchSize: number, isRetry: boolean, outcome: AiCallOutcome, started: number, response?: z.infer<typeof jevResponse>, errorType?: string): void {
    const inputTokens = response?.usage?.input_tokens;
    const outputTokens = response?.usage?.output_tokens;
    const cost = estimateCostUsd(this.options.prices, this.model, inputTokens, outputTokens);
    this.options.recorder?.record({
      provider: JEV_PROVIDER,
      model: this.model,
      ...(response?.model ? { modelVersion: response.model } : {}),
      promptVersion: JEV_TOPIC_QUESTION_SET,
      schemaVersion: TOPIC_ASSIGNMENT_CONTRACT,
      batchSize,
      attempt: isRetry ? 2 : 1,
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

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, seconds * 1000) : undefined;
}
