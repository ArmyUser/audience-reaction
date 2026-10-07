import { describe, expect, it } from "vitest";
import { buildDistribution } from "../../src/core/aggregation/distribution";

const LABELS = ["positive", "neutral", "negative"] as const;
type L = (typeof LABELS)[number];

function repeat(label: L, n: number): L[] {
  return Array.from({ length: n }, () => label);
}

describe("buildDistribution (largest-remainder rounding)", () => {
  it("counts each label and reports the base", () => {
    const d = buildDistribution(LABELS, [...repeat("positive", 2), ...repeat("negative", 1)]);
    expect(d.base).toBe(3);
    expect(d.rows.map((r) => [r.label, r.count])).toEqual([["positive", 2], ["neutral", 0], ["negative", 1]]);
  });

  it("splits thirds so the total is exactly 100 (ties broken by label order)", () => {
    const d = buildDistribution(LABELS, ["positive", "neutral", "negative"]);
    expect(d.rows.map((r) => r.percent)).toEqual([34, 33, 33]);
  });

  it("gives extra points to the largest remainders", () => {
    // 1/7 = 14.28…, 2/7 = 28.57…, 4/7 = 57.14… → floors 14+28+57 = 99; largest remainder is 2/7.
    const d = buildDistribution(LABELS, [...repeat("positive", 1), ...repeat("neutral", 2), ...repeat("negative", 4)]);
    expect(d.rows.map((r) => r.percent)).toEqual([14, 29, 57]);
  });

  it("sums to exactly 100 for every split of 1..60 items across three labels", () => {
    for (let n = 1; n <= 60; n++) {
      for (let a = 0; a <= n; a++) {
        for (let b = 0; a + b <= n; b++) {
          const values = [...repeat("positive", a), ...repeat("neutral", b), ...repeat("negative", n - a - b)];
          const sum = buildDistribution(LABELS, values).rows.reduce((s, r) => s + r.percent, 0);
          expect(sum).toBe(100);
        }
      }
    }
  });

  it("returns all zeros for an empty base", () => {
    const d = buildDistribution(LABELS, []);
    expect(d.base).toBe(0);
    expect(d.rows.every((r) => r.count === 0 && r.percent === 0)).toBe(true);
  });

  it("is independent of input order", () => {
    const values: L[] = ["negative", "positive", "positive", "neutral", "positive"];
    expect(buildDistribution(LABELS, values)).toEqual(buildDistribution(LABELS, [...values].reverse()));
  });

  it("rejects labels outside the label set", () => {
    expect(() => buildDistribution(LABELS, ["mixed" as L])).toThrow(/Unknown label/);
  });
});
