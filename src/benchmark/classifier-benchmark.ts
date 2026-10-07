import { GoldLabelClassifier, type GoldComment } from "../adapters/fakes/gold-label-classifier";
import { aggregate } from "../core/aggregation/aggregate";
import { classifyComments } from "../core/classification/classify-comments";
import { createFocusMatcher } from "../core/classification/focus-matcher";
import { GUIDELINE_VERSION } from "../core/classification/guidelines";
import { createClassificationSchema, type ClassificationSchema } from "../core/classification/schema";
import type { SpamAdjustment } from "../core/classification/spam-invariant";
import { parseClassifierOutput } from "../core/classification/validation";
import { summarizeUsage, type AiCallRecord, type UsageSummary } from "../core/cost/usage";
import type { ClassifiedComment, CommentClassification, CommentInput, FocusTarget } from "../core/domain/types";
import { agreementRate, evaluateTask, EVAL_TASKS, taskValue, type EvalTask, type TaskMetrics } from "../core/metrics/classification-eval";
import type { Classifier } from "../core/ports";

// Phase-0 benchmark harness: runs a Classifier over a gold-labelled dataset and reports metrics, failures, cost and
// latency. Benchmark records are separate from product analytics and never feed the report model.

export interface BenchmarkDataset {
  name: string;
  /** Content hash of the dataset file, so results are tied to the exact labels used. */
  version: string;
  focus: FocusTarget;
  comments: (GoldComment & { text: string; tags: string[] })[];
}

export interface BenchmarkSubject {
  classifier: Classifier;
  provider: string;
  model: string;
  promptVersion: string;
  batchSize?: number;
  /** Returns the AI-call records made since the subject was created. */
  usage(): readonly AiCallRecord[];
  /**
   * Optional: spam-invariant adjustments the classifier applied since the subject was created, keyed by comment ID
   * (the latest reported per comment). Only providers that apply the invariant report them; they are not failures.
   */
  spamInvariantAdjustments?(): ReadonlyMap<string, readonly SpamAdjustment[]>;
  /**
   * Optional: per-target diagnostics for classifiers that gate targets with a separate "addressed" answer (latest per
   * comment): the addressed probability and the sentiment answer before the not_addressed reconstruction.
   */
  targetDiagnostics?(): ReadonlyMap<string, readonly TargetDiagnostic[]>;
}

export interface TargetDiagnostic {
  target: string;
  addressedProbability: number;
  sentimentAnswer: string;
}

export interface BenchmarkOptions {
  repeats: number;
  mixedEnabled: boolean;
  useFocus: boolean;
  retryRounds: number;
  /** Store each comment's text in the per-comment records. Only for synthetic datasets (never real YouTube comments). */
  includeCommentText?: boolean;
  now?: () => number;
}

/**
 * One record per dataset comment and run. `predicted` is the final validated classification the run scored; null
 * when the comment failed classification (a provider/validation failure, listed in `failureIssues`).
 * `mismatches` lists the scored fields where predicted differs from gold. Spam-invariant adjustments are not failures:
 * they belong to a classified comment and are listed separately.
 */
export interface CommentRecord {
  commentId: string;
  text?: string;
  tags: string[];
  status: "correct" | "incorrect" | "failed";
  gold: CommentClassification;
  predicted: CommentClassification | null;
  mismatches: EvalTask[];
  errorCount: number;
  consistencyIssues: string[];
  failureIssues?: string[];
  spamInvariantAdjustments?: SpamAdjustment[];
  /** Synthetic-benchmark diagnosis only; present when the classifier reports target gates. */
  targetDiagnostics?: TargetDiagnostic[];
}

export interface ErrorSummary {
  comments: number;
  perfectComments: number;
  commentsWithErrors: number;
  commentsWithOneError: number;
  commentsWithMultipleErrors: number;
  failedComments: number;
  totalFieldErrors: number;
  fieldErrorCounts: Record<EvalTask, number>;
  /** Every incorrect comment with its mismatched fields, in dataset order. */
  errors: { commentId: string; fields: EvalTask[] }[];
  spamInvariantAdjustedComments: number;
}

export interface SliceMetrics {
  tag: string;
  n: number;
  accuracy: Partial<Record<"type" | "sentiment" | "target_focus", number>>;
}

export interface RunReport {
  repeat: number;
  wallClockMs: number;
  classified: number;
  failures: { commentId: string; issues: string[] }[];
  consistencyIssues: { commentId: string; rule: string }[];
  responseIssues: number;
  /** Share of comments with a valid classification on the first attempt (structured-output validity). */
  firstAttemptValidRate: number;
  rounds: number;
  tasks: TaskMetrics[];
  slices: SliceMetrics[];
  aggregateOverallSentiment: { gold: Record<string, number>; predicted: Record<string, number>; maxAbsDiffPctPoints: number };
  usage: UsageSummary;
  errorSummary: ErrorSummary;
  comments: CommentRecord[];
}

export interface BenchmarkReport {
  meta: {
    timestamp: string;
    provider: string;
    model: string;
    modelVersions: string[];
    promptVersion: string;
    schemaVersion: string;
    guidelineVersion: string;
    dataset: { name: string; version: string; size: number };
    repeats: number;
    batchSize?: number;
    mixedEnabled: boolean;
    focus: FocusTarget | null;
    retryRounds: number;
  };
  runs: RunReport[];
  consistency: { task: EvalTask; meanAgreement: number; pairs: number }[];
  usageTotal: UsageSummary;
}

const SLICE_TAGS = [
  "sponsor",
  "sarcasm",
  "irony",
  "mixed",
  "implicit_target",
  "explicit_brand",
  "prompt_injection",
  "html_script",
  "emoji",
  "slang",
  "very_short",
  "question",
  "request",
  "spam",
  "off_topic",
];

export async function runClassifierBenchmark(
  dataset: BenchmarkDataset,
  createSubject: () => BenchmarkSubject,
  options: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const now = options.now ?? Date.now;
  const focus = options.useFocus ? dataset.focus : undefined;
  const schema = createClassificationSchema({ mixedEnabled: options.mixedEnabled, focusConfigured: focus !== undefined });
  const comments: CommentInput[] = dataset.comments.map((c) => ({ id: c.id, text: c.text }));
  const gold = await goldClassifications(dataset, comments, schema, focus);

  const runs: RunReport[] = [];
  const predictions: Map<string, CommentClassification>[] = [];
  const allUsage: AiCallRecord[] = [];
  let subjectMeta: BenchmarkSubject | undefined;

  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    const subject = createSubject();
    subjectMeta ??= subject;
    const started = now();
    const result = await classifyComments(comments, subject.classifier, schema, focus, { retryRounds: options.retryRounds });
    const wallClockMs = now() - started;
    const usage = [...subject.usage()];
    allUsage.push(...usage);

    const predicted = new Map(result.classifications.map((c) => [c.commentId, c]));
    predictions.push(predicted);
    const records = commentRecords(dataset, gold, predicted, result, subject, focus !== undefined, options.includeCommentText ?? false);
    runs.push({
      repeat,
      wallClockMs,
      classified: predicted.size,
      failures: result.failures,
      consistencyIssues: result.consistencyIssues,
      responseIssues: result.responseIssues.length,
      firstAttemptValidRate: comments.length === 0 ? 0 : (result.validPerRound[0] ?? 0) / comments.length,
      rounds: result.rounds,
      tasks: EVAL_TASKS.filter((t) => t !== "target_focus" || focus).map((task) => evaluateTask(task, pairsFor(task, comments, gold, predicted))),
      slices: SLICE_TAGS.map((tag) => sliceMetrics(tag, dataset, gold, predicted, focus !== undefined)),
      aggregateOverallSentiment: compareAggregates(comments, gold, predicted, schema, focus),
      usage: summarizeUsage(usage),
      errorSummary: summarizeErrors(records, focus !== undefined),
      comments: records,
    });
  }

  const consistency =
    predictions.length < 2
      ? []
      : EVAL_TASKS.filter((t) => t !== "target_focus" || focus).map((task) => {
          const rates: number[] = [];
          for (let i = 0; i < predictions.length; i += 1)
            for (let j = i + 1; j < predictions.length; j += 1) rates.push(agreementRate(predictions[i]!, predictions[j]!, task).agreement);
          return { task, meanAgreement: rates.reduce((s, r) => s + r, 0) / rates.length, pairs: rates.length };
        });

  return {
    meta: {
      timestamp: new Date().toISOString(),
      provider: subjectMeta?.provider ?? "unknown",
      model: subjectMeta?.model ?? "unknown",
      modelVersions: [...new Set(allUsage.flatMap((u) => (u.modelVersion ? [u.modelVersion] : [])))],
      promptVersion: subjectMeta?.promptVersion ?? "n/a",
      schemaVersion: schema.version,
      guidelineVersion: GUIDELINE_VERSION,
      dataset: { name: dataset.name, version: dataset.version, size: comments.length },
      repeats: options.repeats,
      ...(subjectMeta?.batchSize !== undefined ? { batchSize: subjectMeta.batchSize } : {}),
      mixedEnabled: options.mixedEnabled,
      focus: focus ?? null,
      retryRounds: options.retryRounds,
    },
    runs,
    consistency,
    usageTotal: summarizeUsage(allUsage),
  };
}

/** Gold labels go through the same strict validation as model output. */
async function goldClassifications(
  dataset: BenchmarkDataset,
  comments: CommentInput[],
  schema: ClassificationSchema,
  focus: FocusTarget | undefined,
): Promise<Map<string, CommentClassification>> {
  const raw = await new GoldLabelClassifier(dataset.comments).classify({ comments, schema, ...(focus ? { focus } : {}) });
  return new Map(parseClassifierOutput(raw, comments, schema).map((c) => [c.commentId, c]));
}

function scoredTasks(withFocus: boolean): EvalTask[] {
  return EVAL_TASKS.filter((t) => t !== "target_focus" || withFocus);
}

/** Per-comment diagnosis. Uses the same field comparison (taskValue) as the aggregate scoring. */
function commentRecords(
  dataset: BenchmarkDataset,
  gold: Map<string, CommentClassification>,
  predicted: Map<string, CommentClassification>,
  result: { failures: { commentId: string; issues: string[] }[]; consistencyIssues: { commentId: string; rule: string }[] },
  subject: BenchmarkSubject,
  withFocus: boolean,
  includeText: boolean,
): CommentRecord[] {
  const tasks = scoredTasks(withFocus);
  const adjustments = subject.spamInvariantAdjustments?.();
  const diagnostics = subject.targetDiagnostics?.();
  return dataset.comments.map((c) => {
    const g = gold.get(c.id)!;
    const p = predicted.get(c.id);
    const mismatches = p ? tasks.filter((t) => taskValue(g, t) !== taskValue(p, t)) : [];
    const failure = result.failures.find((f) => f.commentId === c.id);
    const adjusted = p ? adjustments?.get(c.id) : undefined;
    const gates = p ? diagnostics?.get(c.id) : undefined;
    return {
      commentId: c.id,
      ...(includeText ? { text: c.text } : {}),
      tags: c.tags,
      status: !p ? "failed" : mismatches.length === 0 ? "correct" : "incorrect",
      gold: g,
      predicted: p ?? null,
      mismatches,
      errorCount: mismatches.length,
      consistencyIssues: result.consistencyIssues.filter((i) => i.commentId === c.id).map((i) => i.rule),
      ...(!p ? { failureIssues: failure?.issues ?? [] } : {}),
      ...(adjusted && adjusted.length > 0 ? { spamInvariantAdjustments: [...adjusted] } : {}),
      ...(gates ? { targetDiagnostics: [...gates] } : {}),
    };
  });
}

function summarizeErrors(records: CommentRecord[], withFocus: boolean): ErrorSummary {
  const fieldErrorCounts = Object.fromEntries(scoredTasks(withFocus).map((t) => [t, 0])) as Record<EvalTask, number>;
  for (const r of records) for (const t of r.mismatches) fieldErrorCounts[t] += 1;
  const incorrect = records.filter((r) => r.status === "incorrect");
  return {
    comments: records.length,
    perfectComments: records.filter((r) => r.status === "correct").length,
    commentsWithErrors: incorrect.length,
    commentsWithOneError: incorrect.filter((r) => r.errorCount === 1).length,
    commentsWithMultipleErrors: incorrect.filter((r) => r.errorCount > 1).length,
    failedComments: records.filter((r) => r.status === "failed").length,
    totalFieldErrors: incorrect.reduce((sum, r) => sum + r.errorCount, 0),
    fieldErrorCounts,
    errors: incorrect.map((r) => ({ commentId: r.commentId, fields: r.mismatches })),
    spamInvariantAdjustedComments: records.filter((r) => r.spamInvariantAdjustments !== undefined).length,
  };
}

function pairsFor(task: EvalTask, comments: CommentInput[], gold: Map<string, CommentClassification>, predicted: Map<string, CommentClassification>) {
  return comments.flatMap(({ id }) => {
    const p = predicted.get(id);
    const g = gold.get(id)!;
    const gv = taskValue(g, task);
    const pv = p ? taskValue(p, task) : undefined;
    return gv !== undefined && pv !== undefined ? [{ gold: gv, predicted: pv }] : [];
  });
}

function sliceMetrics(
  tag: string,
  dataset: BenchmarkDataset,
  gold: Map<string, CommentClassification>,
  predicted: Map<string, CommentClassification>,
  withFocus: boolean,
): SliceMetrics {
  const ids = dataset.comments.filter((c) => c.tags.includes(tag) && predicted.has(c.id)).map((c) => c.id);
  const acc = (task: EvalTask) =>
    ids.length === 0 ? 0 : ids.filter((id) => taskValue(gold.get(id)!, task) === taskValue(predicted.get(id)!, task)).length / ids.length;
  return {
    tag,
    n: ids.length,
    accuracy: { type: acc("type"), sentiment: acc("sentiment"), ...(withFocus ? { target_focus: acc("target_focus") } : {}) },
  };
}

/** Deterministic aggregation applied to gold vs predicted labels over the same comments. */
function compareAggregates(
  comments: CommentInput[],
  gold: Map<string, CommentClassification>,
  predicted: Map<string, CommentClassification>,
  schema: ClassificationSchema,
  focus: FocusTarget | undefined,
) {
  const matches = focus ? createFocusMatcher(focus) : undefined;
  const build = (labels: Map<string, CommentClassification>): ClassifiedComment[] =>
    comments.flatMap((comment) => {
      const c = labels.get(comment.id);
      if (!c || !predicted.has(comment.id)) return [];
      if (!matches) return [{ comment, classification: c }];
      const explicit = matches(comment.text);
      return [{ comment, classification: c, focusMention: explicit ? "explicit" : c.targets.focus !== "not_addressed" ? "inferred" : "none" }];
    });
  const params = { minAnalyzableForReport: 0, lowVolumeWarningThreshold: 0, smallSampleThreshold: 0 };
  const toRecord = (rows: { label: string; percent: number }[]) => Object.fromEntries(rows.map((r) => [r.label, r.percent]));
  const g = toRecord(aggregate(build(gold), schema, params).overallSentiment.rows);
  const p = toRecord(aggregate(build(predicted), schema, params).overallSentiment.rows);
  return { gold: g, predicted: p, maxAbsDiffPctPoints: Math.max(...Object.keys(g).map((k) => Math.abs((g[k] ?? 0) - (p[k] ?? 0)))) };
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const m = report.meta;
  lines.push(`# Classifier benchmark — ${m.provider} / ${m.model}`);
  lines.push("");
  lines.push(`- Timestamp: ${m.timestamp}`);
  lines.push(`- Model versions: ${m.modelVersions.join(", ") || "n/a"}; prompt ${m.promptVersion}; schema ${m.schemaVersion}; guideline ${m.guidelineVersion}`);
  lines.push(`- Dataset: ${m.dataset.name} (${m.dataset.version}), ${m.dataset.size} comments; repeats ${m.repeats}; batch size ${m.batchSize ?? "n/a"}; mixed ${m.mixedEnabled}; focus ${m.focus?.name ?? "none"}`);
  for (const run of report.runs) {
    lines.push("");
    lines.push(`## Run ${run.repeat}`);
    lines.push(`- Classified ${run.classified}/${m.dataset.size}; failures ${run.failures.length}; first-attempt structured validity ${pct(run.firstAttemptValidRate)}; rounds ${run.rounds}; consistency issues ${run.consistencyIssues.length}`);
    lines.push(`- Requests ${run.usage.requests} (failed ${run.usage.failedRequests}); tokens in/out ${run.usage.inputTokens}/${run.usage.outputTokens}; est. cost ${run.usage.estimatedCostUsd === undefined ? "unknown" : `$${run.usage.estimatedCostUsd.toFixed(4)}`}; latency mean ${Math.round(run.usage.latencyMs.mean)} ms, p95 ${Math.round(run.usage.latencyMs.p95)} ms; wall clock ${Math.round(run.wallClockMs)} ms`);
    lines.push("");
    lines.push("| Task | Accuracy | Macro-F1 | n |");
    lines.push("|---|---|---|---|");
    for (const t of run.tasks) lines.push(`| ${t.task} | ${pct(t.accuracy)} | ${t.macroF1.toFixed(3)} | ${t.n} |`);
    lines.push("");
    lines.push(`Overall sentiment distribution (gold → predicted, % points): ${Object.keys(run.aggregateOverallSentiment.gold).map((k) => `${k} ${run.aggregateOverallSentiment.gold[k]}→${run.aggregateOverallSentiment.predicted[k]}`).join(", ")}; max |Δ| ${run.aggregateOverallSentiment.maxAbsDiffPctPoints}`);
    const e = run.errorSummary;
    lines.push(`- Per comment: ${e.perfectComments} perfect, ${e.commentsWithErrors} with errors (${e.commentsWithOneError} single, ${e.commentsWithMultipleErrors} multiple), ${e.failedComments} failed; ${e.totalFieldErrors} field errors (${Object.entries(e.fieldErrorCounts).map(([k, v]) => `${k} ${v}`).join(", ")}); spam-invariant adjusted ${e.spamInvariantAdjustedComments}`);
    lines.push("");
    lines.push("| Slice | n | type | sentiment | focus |");
    lines.push("|---|---|---|---|---|");
    for (const s of run.slices) if (s.n > 0) lines.push(`| ${s.tag} | ${s.n} | ${pct(s.accuracy.type ?? 0)} | ${pct(s.accuracy.sentiment ?? 0)} | ${s.accuracy.target_focus === undefined ? "—" : pct(s.accuracy.target_focus)} |`);
  }
  if (report.consistency.length > 0) {
    lines.push("");
    lines.push("## Consistency across repeats");
    for (const c of report.consistency) lines.push(`- ${c.task}: ${pct(c.meanAgreement)} mean agreement (${c.pairs} pair(s))`);
  }
  lines.push("");
  const u = report.usageTotal;
  lines.push(`Total: ${u.requests} requests, ${u.inputTokens}/${u.outputTokens} tokens, est. cost ${u.estimatedCostUsd === undefined ? "unknown" : `$${u.estimatedCostUsd.toFixed(4)}`}`);
  return lines.join("\n");
}
