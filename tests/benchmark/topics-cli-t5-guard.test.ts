import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAIRED_EXPERIMENTS, pairedExperimentFingerprint } from "../../src/benchmark/topic-paired-consolidation";

// The frozen t5 hold-out is reserved for the pre-registered paired experiment: topics-cli.ts must refuse every live
// call on it (any --live suite, and --check-models) before any provider client or request, while offline suites and
// plans stay available and the other datasets behave as before. Each CLI run is a child process with a preloaded
// network trap: the global fetch and every outbound TCP connection are replaced by a recorder that exits the process at
// once, so even a broken guard could not send anything (or write a result). Keys are dummies.

const ROOT = join(__dirname, "..", "..");
const RESULTS = join(ROOT, "benchmark-results");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const ID = "paired-consolidation-v3-v4-t5-v1";
const FAKE_ENV = { ANTHROPIC_API_KEY: "fake-anthropic-key-do-not-use-19", GEMINI_API_KEY: "fake-gemini-key-do-not-use-23", JEV_API_KEY: "fake-jev-key-do-not-use-29" };
const TRAPPED = 97;

const TRAP = `
import { appendFileSync } from "node:fs";
import net from "node:net";
const log = (what) => { appendFileSync(process.env.TRAP_LOG, JSON.stringify(what) + "\\n"); process.exit(${TRAPPED}); };
globalThis.fetch = async (input) => log({ fetch: String(input?.url ?? input) });
// Every outbound TCP/TLS connection is trapped before any DNS lookup. Local IPC (a socket path with no host or port,
// as tsx uses) is let through.
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipc = typeof o === "string" ? Number.isNaN(Number(o)) : Boolean(o && typeof o === "object" && o.path !== undefined && o.host === undefined && o.port === undefined);
  if (!ipc) log({ connect: String(o?.host ?? o) });
  return original.apply(this, args);
};
`;

let dir: string;
let trapFile: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "t5-guard-"));
  trapFile = join(dir, "trap.mjs");
  writeFileSync(trapFile, TRAP);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(script: string, args: string[], env: Record<string, string> = {}) {
  const log = join(dir, `trap-${Math.random().toString(36).slice(2)}.log`);
  const out = spawnSync(TSX, [script, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", NODE_OPTIONS: `--import ${pathToFileURL(trapFile).href}`, TRAP_LOG: log, ...env },
    encoding: "utf8",
  });
  return { status: out.status, text: `${out.stdout}${out.stderr}`, network: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}
const topics = (args: string[], env?: Record<string, string>) => cli("src/benchmark/topics-cli.ts", args, env);
const paired = (args: string[], env?: Record<string, string>) => cli("src/benchmark/paired-consolidation-cli.ts", args, env);

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const snapshot = () =>
  Object.fromEntries(
    readdirSync(RESULTS, { recursive: true })
      .map(String)
      .filter((f) => statSync(join(RESULTS, f)).isFile())
      .sort()
      .map((f) => [f, sha(join(RESULTS, f))]),
  );
/** The t5 files in benchmark-results (the archived experiment's pairs and reservations), by name with their hashes. */
const t5Snapshot = () => Object.fromEntries(Object.entries(snapshot()).filter(([f]) => f.includes("t5-topics-v1")));

const LEGACY_LIVE: string[][] = [
  ["--suite", "real", "--live"],
  ["--suite", "real-consolidated", "--live"],
  ["--suite", "real-consolidated", "--live", "--consolidation", "v4"],
  ["--suite", "discovery-only", "--live"],
  ["--suite", "smoke", "--live"],
  ["--suite", "discovery-consolidated", "--live"],
  ["--suite", "real", "--live", "--provider", "gemini"],
  ["--suite", "real-preflight", "--check-models"],
];

describe("topics-cli.ts refuses every live call on t5 (keys present, network trapped)", () => {
  it.each(LEGACY_LIVE.map((args) => ({ args, label: args.join(" ") })))("refuses `$label` on t5 before any request; writes nothing", ({ args }) => {
    const before = snapshot();
    const t5Before = t5Snapshot();
    const out = topics(["--dataset", "t5-topics-v1", ...args], FAKE_ENV);
    expect(out.status).toBe(1);
    expect(out.network).toEqual([]);
    expect(out.text).toContain("t5-topics-v1 is the frozen hold-out reserved for the pre-registered paired experiment");
    expect(out.text).toContain(ID);
    expect(out.text).toContain(`src/benchmark/paired-consolidation-cli.ts --dataset t5-topics-v1 --experiment ${ID} --live`);
    expect(out.text).toContain("nothing was sent, nothing was written");
    expect(out.text).not.toMatch(/LIVE .*RUN|API CALLS WILL BE MADE/);
    expect(snapshot()).toEqual(before);
    // The same t5 files, byte for byte: no new t5 result or reservation, none changed.
    expect(t5Snapshot()).toEqual(t5Before);
  }, 60_000);

  it("the guard names exactly the registered experiment, which is registered on t5", () => {
    expect(PAIRED_EXPERIMENTS[ID]).toMatchObject({ dataset: "t5-topics-v1" });
    expect(pairedExperimentFingerprint(PAIRED_EXPERIMENTS[ID]!)).toBe("sha256:697e2e73965540c5e2e47f4406ffc8c0007e9de6958c37105ee326d0aa0a0d51");
  });
});

describe("offline use of t5 is unchanged", () => {
  it("the offline oracle and plans (no --live) still work on t5, without any network access", () => {
    const before = snapshot();
    const oracle = topics(["--dataset", "t5-topics-v1"], FAKE_ENV);
    expect([oracle.status, oracle.network]).toEqual([0, []]);
    for (const suite of ["real-preflight", "real", "real-consolidated", "discovery-only", "smoke", "discovery-consolidated"]) {
      const plan = topics(["--dataset", "t5-topics-v1", "--suite", suite], FAKE_ENV);
      expect(plan.network, suite).toEqual([]);
      expect(plan.text, suite).toContain("NO API CALLS MADE");
      expect(plan.text, suite).not.toContain("reserved for the pre-registered paired experiment");
    }
    expect(snapshot()).toEqual(before);
  }, 180_000);
});

describe("other datasets behave exactly as before", () => {
  it.each(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1", "t4-topics-v1"])("%s: --live reaches the usual live gate (missing keys: nothing sent), never the t5 guard", (id) => {
    for (const suite of ["real", "real-consolidated", "discovery-only"]) {
      const out = topics(["--dataset", id, "--suite", suite, "--live"]);
      expect(out.status, suite).toBe(1);
      expect(out.network, suite).toEqual([]);
      expect(out.text, suite).toMatch(/Missing .*nothing was sent/);
      expect(out.text, suite).not.toContain("reserved for the pre-registered paired experiment");
    }
  }, 120_000);
});

describe("the paired experiment remains the permitted live path for t5", () => {
  it("passes every gate of the paired CLI and reaches its first provider request (trapped: nothing leaves the process)", () => {
    const results = mkdtempSync(join(dir, "results-"));
    const before = snapshot();
    const t5Before = t5Snapshot();
    const out = paired(["--dataset", "t5-topics-v1", "--experiment", ID, "--live", "--results", results], FAKE_ENV);
    expect(out.status).toBe(TRAPPED);
    expect(out.network).toHaveLength(1);
    expect(out.network[0]).toContain("api.anthropic.com");
    expect(out.text).toContain(`LIVE PRE-REGISTERED PAIR 1 of 3 (${ID})`);
    // The pair was reserved before it started (so an aborted pair is never re-run); no pair result was saved.
    expect(readdirSync(results).map((f) => f.replace(/^.*-pair-/, "pair-"))).toEqual(["pair-1-reserved.json"]);
    expect(snapshot()).toEqual(before);
    expect(t5Snapshot()).toEqual(t5Before);
  }, 180_000);
});
