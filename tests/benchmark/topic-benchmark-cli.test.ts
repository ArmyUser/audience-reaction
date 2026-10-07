import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real topic benchmark CLI. It needs no key and makes no network request: every provider is a local,
// deterministic fake. Without --save nothing is written.

const ROOT = join(__dirname, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const RESULTS = join(ROOT, "benchmark-results");

function runCli(args: string[]) {
  const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
  const out = spawnSync(TSX, ["src/benchmark/topics-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
  const after = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
  expect(after).toEqual(before);
  return { status: out.status, text: `${out.stdout}${out.stderr}` };
}

describe("topic benchmark CLI", () => {
  it("runs the oracle on t1-topics-v1 and passes the gate", () => {
    const { status, text } = runCli(["--dataset", "t1-topics-v1", "--scenario", "oracle"]);
    expect(text).toContain("# Topic benchmark t1-topics-v1 (sha256:");
    expect(text).toContain("Oracle gate: PASSED");
    expect(text).toMatch(/\| oracle \| available \| 1 \| 1\/1 \| 100% \| 100% \| 0\/0 \|/);
    expect(status).toBe(0);
  }, 60_000);

  it("always runs the oracle first, then the requested scenarios", () => {
    const { status, text } = runCli(["--scenario", "retry-success,retry-failure"]);
    const rows = text.split("\n").filter((l) => /^\| [a-z-]+ \| (available|unavailable) /.test(l)).map((l) => l.split(" | ")[0]!.slice(2));
    expect(rows).toEqual(["oracle", "retry-success", "retry-failure"]);
    expect(status).toBe(0);
  }, 60_000);

  it("rejects unknown scenarios and classifier datasets", () => {
    expect(runCli(["--scenario", "real-provider"])).toMatchObject({ status: 1, text: expect.stringContaining('Unknown scenario(s) real-provider') });
    expect(runCli(["--dataset", "m2-heldout-v1"])).toMatchObject({ status: 1, text: expect.stringContaining('Unknown topic dataset "m2-heldout-v1"') });
  }, 60_000);
});
