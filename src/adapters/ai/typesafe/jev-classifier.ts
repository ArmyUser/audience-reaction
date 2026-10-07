import { z } from "zod";
import type { ClassificationSchema } from "../../../core/classification/schema";
import { enforceSpamInvariant, type SpamAdjustment } from "../../../core/classification/spam-invariant";
import { estimateCostUsd, type AiCallOutcome, type PriceTable, type UsageRecorder } from "../../../core/cost/usage";
import type { CommentInput, FocusTarget } from "../../../core/domain/types";
import type { ClassificationRequest, Classifier } from "../../../core/ports";
import { buildJevQuestionSet, DEFAULT_JEV_QUESTION_SET, usesAddressedTargets, type JevQuestionSetVersion } from "./jev-question-sets";
import { buildJevState, JEV_KEYS, type JevQuestion } from "./jev-questions";
import { JEV_Q2_KEYS } from "./jev-questions-q2";

// TypeSafe Jev adapter. Jev-specific code lives only in src/adapters/ai/typesafe/. The engine sees a Classifier that
// returns untrusted `unknown` output in the shared `{ results: [...] }` shape and validates it like any provider.

export const JEV_PROVIDER = "typesafe";
/**
 * Default model: the `jev-latest` alias, the stable name the TypeSafe account reports via GET /v1/models (alongside
 * `jev-preview`). It can move between versions, so each request records the version the response reports as modelVersion.
 */
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";

/** Errors that mean the request or credentials are wrong; retrying cannot help and silent skipping would hide it. */
export class JevConfigurationError extends Error {
  override readonly name = "JevConfigurationError";
  constructor(readonly status: number) {
    super(`Jev request rejected with HTTP ${status} (check JEV_API_KEY, model and question schema).`);
  }
}

/** jev-q2 per-target gate: what Jev answered before the deterministic not_addressed reconstruction. */
export interface JevTargetDiagnostic {
  target: string;
  addressedProbability: number;
  sentimentAnswer: string;
}

export interface JevClassifierOptions {
  apiKey: string;
  model?: string;
  /** Versioned question set (jev-q1 and jev-q2 frozen; jev-q2.1 adds the g1.4 rules). */
  questionSet?: JevQuestionSetVersion;
  baseUrl?: string;
  /** Threshold on Noul probability for the boolean flags and (jev-q2) the target-addressed questions. */
  noulThreshold?: number;
  /** Transport retries for 429/529/5xx/timeouts/network errors. */
  maxRetries?: number;
  timeoutMs?: number;
  prices: PriceTable;
  recorder?: UsageRecorder;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Debug/test hook: called when the spam invariant overrode answers that contradicted `type = spam_irrelevant`,
   * with the values Jev originally returned. Not persisted anywhere.
   */
  onSpamInvariantApplied?: (commentId: string, adjusted: SpamAdjustment[]) => void;
  /** Debug/benchmark hook (jev-q2 only): per-target addressed probability and sentiment answer. Not persisted. */
  onTargetDiagnostics?: (commentId: string, diagnostics: JevTargetDiagnostic[]) => void;
}

const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().optional(),
});
const noulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const jevResponse = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

/**
 * One Jev request per comment (all questions answered in parallel on that comment's state):
 * - questions share one state, so a state holding several comments would not yield per-comment answers;
 * - every answer is validated (type, option key in the declared criteria, probability range) before mapping;
 * - an invalid or missing answer drops that comment from the output, so the engine's per-comment retry decides;
 * - nothing is defaulted: no answer becomes "neutral" or "not_addressed" by itself;
 * - Jev answers each question independently, so after validation the spam domain invariant is applied: when Jev
 *   chose type = spam_irrelevant, the flags become false and all targets not_addressed. Type and overall sentiment
 *   are kept as answered.
 * - jev-q2 and jev-q2.1 ask per target whether it is addressed (Noul) and, separately, which sentiment it receives (Choice
 *   without not_addressed). The target is the sentiment answer when the addressed probability reaches the threshold,
 *   otherwise not_addressed. Both answers are always required and validated.
 */
export class JevClassifier implements Classifier {
  readonly label: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly questionSet: JevQuestionSetVersion;
  private readonly baseUrl: string;
  private readonly noulThreshold: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly prices: PriceTable;
  private readonly recorder: UsageRecorder | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onSpamInvariantApplied: JevClassifierOptions["onSpamInvariantApplied"];
  private readonly onTargetDiagnostics: JevClassifierOptions["onTargetDiagnostics"];

  constructor(options: JevClassifierOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_JEV_MODEL;
    this.questionSet = options.questionSet ?? DEFAULT_JEV_QUESTION_SET;
    this.baseUrl = (options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, "");
    this.noulThreshold = options.noulThreshold ?? 0.5;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.prices = options.prices;
    this.recorder = options.recorder;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.onSpamInvariantApplied = options.onSpamInvariantApplied;
    this.onTargetDiagnostics = options.onTargetDiagnostics;
    this.label = `TypeSafe ${this.model} (${this.questionSet})`;
  }

  async classify(request: ClassificationRequest): Promise<unknown> {
    const questions = buildJevQuestionSet(this.questionSet, request.schema);
    const results: unknown[] = [];
    for (const comment of request.comments) {
      const result = await this.classifyOne(comment, request.schema, request.focus, questions);
      if (result) results.push(result);
    }
    return { results };
  }

  /** Request body for one comment. Exposed for tests. */
  buildRequestBody(comment: CommentInput, focus: FocusTarget | undefined, questions: Record<string, JevQuestion>) {
    return { model: this.model, state: buildJevState(comment, focus), questions };
  }

  private async classifyOne(
    comment: CommentInput,
    schema: ClassificationSchema,
    focus: FocusTarget | undefined,
    questions: Record<string, JevQuestion>,
  ): Promise<unknown | undefined> {
    const body = JSON.stringify(this.buildRequestBody(comment, focus, questions));
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const started = this.now();
      let response: Response;
      try {
        response = await this.post(body);
      } catch (error) {
        this.record(schema, attempt, "provider_error", started, undefined, error instanceof Error ? error.name : "NetworkError");
        if (attempt <= this.maxRetries) await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422 || response.status === 400) {
        this.record(schema, attempt, "provider_error", started, undefined, `HTTP${response.status}`);
        throw new JevConfigurationError(response.status);
      }
      if (!response.ok) {
        this.record(schema, attempt, "provider_error", started, undefined, `HTTP${response.status}`);
        if (attempt <= this.maxRetries) await this.sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        this.record(schema, attempt, "malformed_output", started);
        return undefined;
      }
      const parsed = jevResponse.safeParse(payload);
      if (!parsed.success) {
        this.record(schema, attempt, "malformed_output", started);
        return undefined;
      }
      const mapped = this.toDomainResult(comment.id, schema, questions, parsed.data.answers);
      this.record(schema, attempt, mapped ? "ok" : "malformed_output", started, parsed.data);
      return mapped;
    }
    return undefined;
  }

  /** Maps validated answers onto the provider-neutral result shape; undefined if any answer is missing or invalid. */
  private toDomainResult(
    commentId: string,
    schema: ClassificationSchema,
    questions: Record<string, JevQuestion>,
    answers: Record<string, unknown>,
  ): unknown | undefined {
    const choice = (key: string): string | undefined => {
      const q = questions[key];
      const a = choiceAnswer.safeParse(answers[key]);
      if (!q || q.type !== "choice" || !a.success || !(a.data.choice in q.criteria)) return undefined;
      return a.data.choice;
    };
    const flag = (key: string): boolean | undefined => {
      const a = noulAnswer.safeParse(answers[key]);
      return a.success ? a.data.noul >= this.noulThreshold : undefined;
    };

    const probability = (key: string): number | undefined => {
      const a = noulAnswer.safeParse(answers[key]);
      return a.success ? a.data.noul : undefined;
    };

    // The four shared keys have the same names in jev-q1 and jev-q2.
    const type = choice(JEV_KEYS.type);
    const sentiment = choice(JEV_KEYS.sentiment);
    const isQuestion = flag(JEV_KEYS.isQuestion);
    const isRequest = flag(JEV_KEYS.isRequest);
    let targets: Record<string, string | undefined>;
    if (usesAddressedTargets(this.questionSet)) {
      const diagnostics: JevTargetDiagnostic[] = [];
      targets = {};
      for (const t of schema.targets) {
        const p = probability(JEV_Q2_KEYS.addressed(t));
        const answer = choice(JEV_Q2_KEYS.targetSentiment(t));
        if (p === undefined || answer === undefined) return undefined;
        diagnostics.push({ target: t, addressedProbability: p, sentimentAnswer: answer });
        targets[t] = p >= this.noulThreshold ? answer : "not_addressed";
      }
      if (type === undefined || sentiment === undefined || isQuestion === undefined || isRequest === undefined) return undefined;
      this.onTargetDiagnostics?.(commentId, diagnostics);
    } else {
      targets = Object.fromEntries(schema.targets.map((t) => [t, choice(JEV_KEYS.target(t))]));
    }
    if (type === undefined || sentiment === undefined || isQuestion === undefined || isRequest === undefined) return undefined;
    if (Object.values(targets).some((v) => v === undefined)) return undefined;
    const { value, adjusted } = enforceSpamInvariant({ type, isQuestion, isRequest, targets: targets as Record<string, string> });
    if (adjusted.length > 0) this.onSpamInvariantApplied?.(commentId, adjusted);
    return { commentId, type: value.type, isQuestion: value.isQuestion, isRequest: value.isRequest, sentiment, targets: value.targets };
  }

  private async post(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private record(
    schema: ClassificationSchema,
    attempt: number,
    outcome: AiCallOutcome,
    started: number,
    response?: z.infer<typeof jevResponse>,
    errorType?: string,
  ): void {
    const inputTokens = response?.usage?.input_tokens;
    const outputTokens = response?.usage?.output_tokens;
    const cost = estimateCostUsd(this.prices, this.model, inputTokens, outputTokens);
    this.recorder?.record({
      provider: JEV_PROVIDER,
      model: this.model,
      ...(response?.model ? { modelVersion: response.model } : {}),
      promptVersion: this.questionSet,
      schemaVersion: schema.version,
      batchSize: 1,
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

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, seconds * 1000) : undefined;
}
