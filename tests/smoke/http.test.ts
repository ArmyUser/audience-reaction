import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalysisSnapshot, StartAnalysisResponse } from "../../src/application/analysis-api";

// HTTP-level smoke test against the production build.

const ROOT = resolve(__dirname, "../..");
const NEXT_BIN = join(ROOT, "node_modules", ".bin", "next");
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const VALID = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
/** Fake key values present in the build and server environment; none may reach a client bundle or the HTML. */
const SENTINEL_KEYS = {
  YOUTUBE_API_KEY: "smoke-sentinel-youtube-key-7f3a9c",
  ANTHROPIC_API_KEY: "smoke-sentinel-anthropic-key-7f3a9c",
  JEV_API_KEY: "smoke-sentinel-jev-key-7f3a9c",
};

let server: ChildProcess | undefined;

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Next.js server did not start in time");
}

beforeAll(async () => {
  // Demo mode explicitly (process env wins over a local .env), with fake keys: the smoke test never calls a provider.
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ANALYSIS_MODE: "demo", ...SENTINEL_KEYS };
  execFileSync(NEXT_BIN, ["build"], { cwd: ROOT, env, stdio: "pipe" });
  server = spawn(NEXT_BIN, ["start", "--hostname", "127.0.0.1", "--port", String(PORT)], { cwd: ROOT, env, stdio: "pipe" });
  await waitForServer(60_000);
});

afterAll(() => {
  server?.kill();
});

async function get(path: string): Promise<{ status: number; html: string; headers: Headers }> {
  const res = await fetch(BASE + path);
  return { status: res.status, html: await res.text(), headers: res.headers };
}

async function start(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Promise<{ status: number; body: (StartAnalysisResponse & { error?: string; field?: string }) | null; text: string }> {
  const res = await fetch(`${BASE}/api/analyses`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : null, text };
}

async function finished(id: string): Promise<AnalysisSnapshot> {
  for (let i = 0; i < 200; i++) {
    const { analysis } = (await (await fetch(`${BASE}/api/analyses/${id}`)).json()) as { analysis: AnalysisSnapshot };
    if (analysis.status === "completed" || analysis.status === "failed") return analysis;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("analysis did not finish");
}

describe("HTTP smoke test (production build)", () => {
  it("serves the Analyze page: data source first, no URL field for test data, empty state", async () => {
    const { status, html } = await get("/");
    expect(status).toBe(200);
    expect(html).toContain("Data source");
    expect(html).toContain("Test dataset");
    expect(html).toContain(">Run analysis<");
    expect(html).not.toContain('name="url"');
    expect(html).toContain("Recent analyses");
    expect(html).toContain("Understand how an audience reacted");
    expect(html).not.toContain("Audience reaction report");
    expect(html).toContain("<title>Analyze · Audience Reaction</title>");
    expect(html).toContain('href="/settings"');
  });

  it("runs a demo analysis on the server and reuses it instead of running it again", async () => {
    const first = await start({ source: "demo" });
    expect(first.status).toBe(202);
    const done = await finished(first.body!.analysis.id);
    expect(done.status).toBe("completed");
    expect(done.stages.map((s) => s.id)).toHaveLength(3);
    if (done.payload?.result.status !== "ok") throw new Error("expected a report");
    expect(done.payload.result.report.isSyntheticData).toBe(true);
    expect(done.payload.insights?.findings.length).toBeGreaterThan(0);

    const again = await start({ source: "demo" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, analysis: { id: done.id, status: "completed" } });
    const { analyses } = (await (await fetch(`${BASE}/api/analyses`)).json()) as { analyses: AnalysisSnapshot[] };
    expect(analyses.filter((a) => a.sourceId === "demo")).toHaveLength(1);
  });

  it("never runs an analysis on page load: /?id= only selects an existing one", async () => {
    const { html } = await get("/?id=00000000-0000-0000-0000-000000000000");
    expect(html).not.toContain("Audience reaction report");
    const { analyses } = (await (await fetch(`${BASE}/api/analyses`)).json()) as { analyses: AnalysisSnapshot[] };
    expect(analyses.every((a) => a.sourceId === "demo")).toBe(true);
  });

  it("validates the YouTube link before anything runs", async () => {
    const res = await start({ source: "youtube", url: "https://example.com/watch?v=dQw4w9WgXcQ" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "url", error: "This isn't a valid YouTube video link." });
  });

  it("ignores body fields that try to change policy or schema settings", async () => {
    const res = await start({ source: "demo", youtubeDerivedAnalytics: "allowed", mixedSentimentEnabled: true, policy: "open" });
    const done = await finished(res.body!.analysis.id);
    if (done.payload?.result.status !== "ok") throw new Error("expected ok");
    expect(done.payload.result.report.methodology.policyNote).toContain("disabled until compliance requirements are confirmed (CG-1)");
    expect(done.payload.result.report.methodology.mixedCandidateEnabled).toBe(false);
  });

  it("refuses held-out datasets, cross-origin and non-JSON requests", async () => {
    expect((await start({ source: "fixture:t3-topics-v1" })).status).toBe(400);
    expect((await start({ source: "demo" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await start({ source: "demo" }, { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    // What a browser on the app's own page sends.
    expect((await start({ source: "demo" }, { "content-type": "application/json", origin: BASE })).status).toBe(200);
  });

  it("real YouTube on a production server stays blocked by CG-1", async () => {
    const { html } = await get("/");
    expect(html).not.toContain("Paste");
    const res = await start({ source: "youtube", url: VALID });
    const done = await finished(res.body!.analysis.id);
    expect(done.status).toBe("failed");
    expect(done.payload?.result.status).toBe("blocked_by_policy");
    // A blocked analysis is not reused: asking again is a new (and again blocked) attempt.
    expect((await start({ source: "youtube", url: VALID })).body?.reused).toBe(false);
  });

  it("sends baseline security headers", async () => {
    const { headers } = await get("/");
    expect(headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-powered-by")).toBeNull();
  });

  it("ships no server-side code or fixture data in client bundles", () => {
    const staticDir = join(ROOT, ".next", "static");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const bundles = walk(staticDir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8"));
    expect(bundles.length).toBeGreaterThan(0);
    for (const marker of [
      "m2-c01",
      "Subscribe to my channel",
      "Fake classifier (keyword rules)",
      "server-only",
      "ANTHROPIC_API_KEY",
      "anthropic-version",
      "JEV_API_KEY",
      "api.typesafe.ai",
      "YOUTUBE_API_KEY",
      "googleapis.com/youtube",
      "commentThreads",
      ...Object.values(SENTINEL_KEYS),
    ]) {
      expect(bundles.some((b) => b.includes(marker)), marker).toBe(false);
    }
  });

  it("never sends API key values to the browser", async () => {
    for (const path of ["/", "/settings", "/evaluation"]) {
      const { html } = await get(path);
      for (const value of Object.values(SENTINEL_KEYS)) expect(html, path).not.toContain(value);
    }
    expect((await get("/")).html).not.toContain("YOUTUBE_API_KEY");
    const { text } = await start({ source: "demo" });
    const list = await (await fetch(`${BASE}/api/analyses`)).text();
    for (const value of Object.values(SENTINEL_KEYS)) for (const body of [text, list]) expect(body).not.toContain(value);
  });

  it("serves Settings → API & models with key status, masked", async () => {
    const { status, html } = await get("/settings");
    expect(status).toBe(200);
    expect(html).toContain("API &amp; models");
    expect(html).toContain("status-ok");
    expect(html).toContain("Keys are read from the local .env file");
  });

  it("serves the internal evaluation page from committed result files, without key values", async () => {
    const { status, html } = await get("/evaluation");
    expect(status).toBe(200);
    expect(html).toContain("Pipeline evaluation");
    expect(html).toContain("Internal · not customer-facing");
    expect(html).toContain("Held-out");
  });

  it("serves the product icons and web manifest", async () => {
    expect((await fetch(`${BASE}/icon-192.png`)).status).toBe(200);
    expect((await fetch(`${BASE}/favicon.ico`)).status).toBe(200);
    const manifest = (await (await fetch(`${BASE}/manifest.webmanifest`)).json()) as { name: string };
    expect(manifest.name).toBe("Audience Reaction");
  });

  it("defaults to demo test data unless real mode is configured", async () => {
    const { html } = await get("/");
    expect(html).toMatch(/<option value="demo" selected/);
  });
});
