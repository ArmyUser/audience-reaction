import type { SentimentLabel, Target } from "../domain/types";

/**
 * Provider-neutral description of what a classifier must return for one analysis. Built from configuration so
 * that enabling the `mixed` candidate label or a focus target changes the schema, not the domain model.
 */
export interface ClassificationSchema {
  version: string;
  sentimentLabels: readonly SentimentLabel[];
  mixedEnabled: boolean;
  targets: readonly Target[];
  focusConfigured: boolean;
}

export interface ClassificationSchemaOptions {
  /** Candidate label; off unless explicitly enabled (spec.md §6.3). */
  mixedEnabled?: boolean;
  focusConfigured: boolean;
}

const SCHEMA_GENERATION = "v1";

export function createClassificationSchema(options: ClassificationSchemaOptions): ClassificationSchema {
  const mixedEnabled = options.mixedEnabled ?? false;
  const sentimentLabels: SentimentLabel[] = mixedEnabled
    ? ["positive", "neutral", "negative", "mixed"]
    : ["positive", "neutral", "negative"];
  const targets: Target[] = options.focusConfigured ? ["creator", "content", "focus"] : ["creator", "content"];
  return Object.freeze({
    version: `${SCHEMA_GENERATION}-${sentimentLabels.length}label${options.focusConfigured ? "-focus" : ""}`,
    sentimentLabels: Object.freeze(sentimentLabels),
    mixedEnabled,
    targets: Object.freeze(targets),
    focusConfigured: options.focusConfigured,
  });
}
