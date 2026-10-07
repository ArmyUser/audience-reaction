import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real benchmark CLI with a dummy key and a zero cost allowance: it parses the options, selects the question
// set and estimates the cost, then stops before creating any classifier. No network request is possible.

const ROOT = join(__dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const RESULTS = join(ROOT, "benchmark-results");

function runCli(args: string[]) {
  const before = existsSync(RESULTS) ? readdirSync(RESULTS).length : 0;
  // No --env-file: a local .env is never loaded here.
  const out = spawnSync(TSX, ["src/benchmark/cli.ts", "--provider", "jev", "--max-cost-usd", "0", ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", JEV_API_KEY: "dummy-not-a-real-key" },
    encoding: "utf8",
  });
  const after = existsSync(RESULTS) ? readdirSync(RESULTS).length : 0;
  expect(after).toBe(before);
  return { status: out.status, text: `${out.stdout}${out.stderr}` };
}

const estimate = (text: string) => Number(/Pre-run estimate: ~\$([\d.]+)/.exec(text)![1]);

describe("benchmark CLI Jev question-set selection", () => {
  it("defaults to jev-q2.2", () => {
    const { status, text } = runCli([]);
    expect(text).toMatch(/Jev question set jev-q2\.2\. Pre-run estimate/);
    expect(text).toContain("Estimated cost exceeds --max-cost-usd; not running.");
    expect(status).toBe(1);
  }, 60_000);

  it("selects jev-q1, jev-q2 or jev-q2.1 explicitly; each later set costs more input", () => {
    const q1 = runCli(["--jev-question-set", "jev-q1"]);
    const q2 = runCli(["--jev-question-set", "jev-q2"]);
    const q21 = runCli(["--jev-question-set", "jev-q2.1"]);
    // Exact phrases: "jev-q2." must not match the default "jev-q2.2." line.
    expect(q1.text).toMatch(/Jev question set jev-q1\. Pre-run estimate/);
    expect(q2.text).toMatch(/Jev question set jev-q2\. Pre-run estimate/);
    expect(q21.text).toMatch(/Jev question set jev-q2\.1\. Pre-run estimate/);
    expect(estimate(q2.text)).toBeGreaterThan(estimate(q1.text));
    expect(estimate(q21.text)).toBeGreaterThan(estimate(q2.text));
  }, 90_000);

  it("selects jev-q2.2 explicitly", () => {
    const { status, text } = runCli(["--jev-question-set", "jev-q2.2"]);
    expect(text).toContain("Jev question set jev-q2.2.");
    expect(text).toContain("Estimated cost exceeds --max-cost-usd; not running.");
    expect(status).toBe(1);
  }, 60_000);

  it("uses m2-synthetic by default and selects the held-out dataset explicitly", () => {
    expect(runCli([]).text).toContain("Dataset m2-synthetic (sha256:2ee5c7f4e8e678e5), 60 comments.");
    const { status, text } = runCli(["--jev-question-set", "jev-q2.2", "--dataset", "m2-heldout-v1"]);
    expect(text).toContain("Dataset m2-heldout-v1 (sha256:b278ced3034dfe3a), 100 comments.");
    expect(text).toContain("Jev question set jev-q2.2.");
    expect(status).toBe(1);
  }, 60_000);

  it("rejects an unknown dataset", () => {
    const { status, text } = runCli(["--dataset", "m3"]);
    expect(status).toBe(1);
    expect(text).toContain('Unknown dataset "m3". Use one of: m2-synthetic, m2-heldout-v1.');
  }, 60_000);

  it("rejects an unknown question set", () => {
    const { status, text } = runCli(["--jev-question-set", "jev-q9"]);
    expect(status).toBe(1);
    expect(text).toContain('Unknown Jev question set "jev-q9". Use one of: jev-q1, jev-q2, jev-q2.1, jev-q2.2.');
  }, 60_000);
});
