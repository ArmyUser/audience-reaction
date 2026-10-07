import type { ClassificationRequest, Classifier } from "../../core/ports";

export interface GoldLabels {
  type: string;
  isQuestion: boolean;
  isRequest: boolean;
  sentiment: string;
  targets: { creator: string; content: string; focus: string };
}

export interface GoldComment {
  id: string;
  gold: GoldLabels;
  goldWithMixed?: { sentiment?: string; targets?: GoldLabels["targets"] };
}

/**
 * Deterministic fake that replays hand-written gold labels from synthetic fixtures. Comments without gold labels
 * are omitted from the output, so the engine rejects the response instead of guessing.
 */
export class GoldLabelClassifier implements Classifier {
  readonly label = "Fake classifier (fixture gold labels)";
  private readonly byId: Map<string, GoldComment>;

  constructor(comments: readonly GoldComment[]) {
    this.byId = new Map(comments.map((c) => [c.id, c]));
  }

  async classify(request: ClassificationRequest): Promise<unknown> {
    const results = request.comments.flatMap((comment) => {
      const entry = this.byId.get(comment.id);
      if (!entry) return [];
      const labels = request.schema.mixedEnabled && entry.goldWithMixed ? { ...entry.gold, ...entry.goldWithMixed } : entry.gold;
      const { focus, ...baseTargets } = labels.targets;
      return [
        {
          commentId: comment.id,
          type: labels.type,
          isQuestion: labels.isQuestion,
          isRequest: labels.isRequest,
          sentiment: labels.sentiment,
          targets: request.schema.focusConfigured ? { ...baseTargets, focus } : baseTargets,
        },
      ];
    });
    return { results };
  }
}
