import { describe, expect, it, vi } from "vitest";
import type { AnalysisSnapshot, StartAnalysisResponse } from "../../src/application/analysis-api";

vi.mock("server-only", () => ({}));
const { GET, POST } = await import("../../src/app/api/analyses/[[...id]]/route");

// Demo analyses only (no provider is involved); held-out and unknown sources are refused before anything runs.

const BASE = "http://127.0.0.1:3000/api/analyses";
const JSON_HEADERS = { "content-type": "application/json", host: "127.0.0.1:3000" };
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id: [id] }) });

function post(body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  return POST(new Request(BASE, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), noParams);
}

async function get(id?: string): Promise<Response> {
  return GET(new Request(id ? `${BASE}/${id}` : BASE, { headers: { host: "127.0.0.1:3000" } }), id ? idParams(id) : noParams);
}

async function waitFinished(id: string): Promise<AnalysisSnapshot> {
  for (let i = 0; i < 100; i++) {
    const a = ((await (await get(id)).json()) as { analysis: AnalysisSnapshot }).analysis;
    if (a.status === "completed" || a.status === "failed") return a;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("did not finish");
}

describe("/api/analyses", () => {
  it("starts a demo analysis, then reuses it instead of running it again", async () => {
    const res = await post({ source: "demo", policy: "open", youtubeDerivedAnalytics: "allowed" });
    expect(res.status).toBe(202);
    const started = (await res.json()) as StartAnalysisResponse;
    expect(started.reused).toBe(false);
    const done = await waitFinished(started.analysis.id);
    expect(done.status).toBe("completed");
    if (done.payload?.result.status === "ok") expect(done.payload.result.report.methodology.policyNote).toContain("CG-1");

    const again = await post({ source: "demo" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as StartAnalysisResponse)).toMatchObject({ reused: true, analysis: { id: started.analysis.id, status: "completed" } });

    const list = (await (await get()).json()) as { analyses: AnalysisSnapshot[] };
    expect(list.analyses.some((a) => a.id === started.analysis.id)).toBe(true);
    for (const a of list.analyses) expect(a.payload).toBeUndefined();
  });

  it("returns 404 for unknown or malformed ids", async () => {
    expect((await get("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await get("../etc")).status).toBe(404);
  });

  it("refuses non-JSON, cross-origin and rebinding requests (no paid analysis from another site)", async () => {
    expect((await post({ source: "demo" }, { "content-type": "text/plain", host: "127.0.0.1:3000" })).status).toBe(415);
    expect((await post({ source: "demo" }, { ...JSON_HEADERS, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ source: "demo" }, { ...JSON_HEADERS, origin: "http://127.0.0.1:3001" })).status).toBe(403);
    expect((await post({ source: "demo" }, { ...JSON_HEADERS, origin: "null" })).status).toBe(403);
    expect((await post({ source: "demo" }, { "content-type": "application/json", host: "evil.example:3000", origin: "http://evil.example:3000" })).status).toBe(403);
    expect((await GET(new Request(BASE, { headers: { host: "evil.example:3000" } }), noParams)).status).toBe(403);
    const sameOrigin = await POST(new Request("http://localhost:3000/api/analyses", { method: "POST", headers: { ...JSON_HEADERS, origin: "http://127.0.0.1:3000" }, body: JSON.stringify({ source: "demo" }) }), noParams);
    expect([200, 202]).toContain(sameOrigin.status);
  });

  it("refuses held-out datasets, unknown sources, bad YouTube links and malformed bodies", async () => {
    for (const source of ["fixture:t3-topics-v1", "fixture:m2-heldout-v1", "unknown-src"]) expect((await post({ source })).status, source).toBe(400);
    const badUrl = await post({ source: "youtube", url: "https://example.com/x" });
    expect(badUrl.status).toBe(400);
    expect(await badUrl.json()).toMatchObject({ field: "url" });
    expect((await post("not json")).status).toBe(400);
  });
});
