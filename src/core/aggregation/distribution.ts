export interface DistributionRow<L extends string> {
  label: L;
  count: number;
  /** Integer percentage of `base`; a distribution's percentages sum to exactly 100 (or all 0 for an empty base). */
  percent: number;
}

export interface Distribution<L extends string> {
  base: number;
  rows: DistributionRow<L>[];
}

/** A single count over a base (e.g. questions among the sentiment base). Not part of a 100%-summing distribution. */
export interface Share {
  count: number;
  base: number;
  /** Integer percentage, rounded half up with integer arithmetic; 0 for an empty base. */
  percent: number;
}

export function share(count: number, base: number): Share {
  if (!Number.isInteger(count) || !Number.isInteger(base) || count < 0 || base < 0 || count > base) {
    throw new RangeError(`Invalid share ${count}/${base}`);
  }
  return { count, base, percent: base === 0 ? 0 : Math.floor((count * 200 + base) / (2 * base)) };
}

/**
 * Builds a distribution over a fixed, ordered label set (spec.md §8.0 rounding rule):
 * integer percentages via the largest-remainder method so displayed values sum to exactly 100.
 * Ties on the remainder are broken by label order, so results are deterministic.
 * An empty base yields all-zero rows.
 */
export function buildDistribution<L extends string>(labels: readonly L[], values: readonly L[]): Distribution<L> {
  const counts = new Map<L, number>(labels.map((label) => [label, 0]));
  for (const value of values) {
    const current = counts.get(value);
    if (current === undefined) throw new Error(`Unknown label: ${value}`);
    counts.set(value, current + 1);
  }

  const base = values.length;
  if (base === 0) return { base, rows: labels.map((label) => ({ label, count: 0, percent: 0 })) };

  const exact = labels.map((label, index) => {
    const count = counts.get(label) ?? 0;
    const raw = (count * 100) / base;
    return { label, count, index, floor: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });

  let missing = 100 - exact.reduce((sum, row) => sum + row.floor, 0);
  const byRemainder = [...exact].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const bonus = new Set<number>();
  for (const row of byRemainder) {
    if (missing <= 0) break;
    bonus.add(row.index);
    missing -= 1;
  }

  return {
    base,
    rows: exact.map((row) => ({ label: row.label, count: row.count, percent: row.floor + (bonus.has(row.index) ? 1 : 0) })),
  };
}
