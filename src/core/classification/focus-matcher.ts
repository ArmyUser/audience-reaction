import type { FocusTarget } from "../domain/types";

/**
 * Deterministic explicit-mention matcher for the focus target (spec.md §6.4.4): case-insensitive, word-boundary
 * match of the name or any alias, tolerating possessives ("Acme's") and flexible whitespace/hyphens between words.
 */
export function createFocusMatcher(focus: FocusTarget): (text: string) => boolean {
  const terms = [focus.name, ...focus.aliases].map((t) => t.trim()).filter((t) => t.length > 0);
  if (terms.length === 0) return () => false;

  const alternatives = terms
    .map((term) => term.split(/[\s-]+/).map(escapeRegExp).join("[\\s-]+"))
    .join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?:['’]s)?(?![\\p{L}\\p{N}])`, "iu");
  return (text) => pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
