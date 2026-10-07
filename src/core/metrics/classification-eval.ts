import type { CommentClassification } from "../domain/types";

// Pure evaluation metrics for classifier benchmarks (spec.md §14.4). No thresholds or decisions live here.

export const EVAL_TASKS = ["type", "isQuestion", "isRequest", "sentiment", "target_creator", "target_content", "target_focus"] as const;
export type EvalTask = (typeof EVAL_TASKS)[number];

export function taskValue(c: CommentClassification, task: EvalTask): string | undefined {
  switch (task) {
    case "type":
      return c.type;
    case "isQuestion":
      return String(c.isQuestion);
    case "isRequest":
      return String(c.isRequest);
    case "sentiment":
      return c.sentiment;
    case "target_creator":
      return c.targets.creator;
    case "target_content":
      return c.targets.content;
    case "target_focus":
      return c.targets.focus;
  }
}

export interface ClassMetrics {
  label: string;
  support: number;
  predicted: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface TaskMetrics {
  task: string;
  n: number;
  correct: number;
  accuracy: number;
  /** Mean F1 over labels present in gold or predictions. */
  macroF1: number;
  perClass: ClassMetrics[];
  confusion: { labels: string[]; matrix: number[][] };
}

/** Accuracy, per-class precision/recall/F1, macro-F1 and confusion matrix (rows = gold, columns = predicted). */
export function evaluateTask(task: string, pairs: readonly { gold: string; predicted: string }[]): TaskMetrics {
  const labels = [...new Set(pairs.flatMap((p) => [p.gold, p.predicted]))].sort();
  const index = new Map(labels.map((l, i) => [l, i]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const p of pairs) matrix[index.get(p.gold)!]![index.get(p.predicted)!]! += 1;

  const perClass = labels.map((label, i) => {
    const tp = matrix[i]![i]!;
    const support = matrix[i]!.reduce((s, x) => s + x, 0);
    const predicted = matrix.reduce((s, row) => s + row[i]!, 0);
    const precision = predicted === 0 ? 0 : tp / predicted;
    const recall = support === 0 ? 0 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, support, predicted, precision, recall, f1 };
  });
  const correct = pairs.filter((p) => p.gold === p.predicted).length;
  return {
    task,
    n: pairs.length,
    correct,
    accuracy: pairs.length === 0 ? 0 : correct / pairs.length,
    macroF1: perClass.length === 0 ? 0 : perClass.reduce((s, c) => s + c.f1, 0) / perClass.length,
    perClass,
    confusion: { labels, matrix },
  };
}

/** Share of comments (classified in both runs) whose value for `task` is identical across the two runs. */
export function agreementRate(
  a: ReadonlyMap<string, CommentClassification>,
  b: ReadonlyMap<string, CommentClassification>,
  task: EvalTask,
): { n: number; agreement: number } {
  const shared = [...a.keys()].filter((id) => b.has(id));
  const same = shared.filter((id) => taskValue(a.get(id)!, task) === taskValue(b.get(id)!, task)).length;
  return { n: shared.length, agreement: shared.length === 0 ? 0 : same / shared.length };
}
