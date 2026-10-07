// Domain invariant (spec.md §6.2, §8): spam/irrelevant comments carry no question/request flags and address no target.
// Classifiers that answer each field independently can contradict it; this function applies the invariant after model
// interpretation. It never changes the primary type and never changes overall sentiment.

export interface SpamDependentFields {
  type: string;
  isQuestion: boolean;
  isRequest: boolean;
  targets: Record<string, string>;
}

/** A field that contradicted the invariant, with the value the classifier originally returned. */
export interface SpamAdjustment {
  field: string;
  original: boolean | string;
}

export interface SpamInvariantOutcome<T extends SpamDependentFields> {
  value: T;
  adjusted: SpamAdjustment[];
}

export function enforceSpamInvariant<T extends SpamDependentFields>(c: T): SpamInvariantOutcome<T> {
  if (c.type !== "spam_irrelevant") return { value: c, adjusted: [] };
  const adjusted: SpamAdjustment[] = [];
  if (c.isQuestion) adjusted.push({ field: "isQuestion", original: true });
  if (c.isRequest) adjusted.push({ field: "isRequest", original: true });
  for (const [target, label] of Object.entries(c.targets)) {
    if (label !== "not_addressed") adjusted.push({ field: `targets.${target}`, original: label });
  }
  if (adjusted.length === 0) return { value: c, adjusted };
  return {
    value: {
      ...c,
      isQuestion: false,
      isRequest: false,
      targets: Object.fromEntries(Object.keys(c.targets).map((t) => [t, "not_addressed"])),
    },
    adjusted,
  };
}
