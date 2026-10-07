import { describe, expect, it, vi } from "vitest";
import type { AnalysisPayload, AnalysisSnapshot } from "../../src/application/analysis-api";
import { analyzeVideoSync } from "../../src/application/analyze-video-sync";
import { stagesFor } from "../../src/application/progress";
import { keyFindings, reportOverview } from "../../src/application/report-insights";
import { createAnalysisStore, SESSION_KEY, type StorageLike } from "../../src/web/analysis-store";
import { goldDeps, VALID_URL } from "../helpers";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

async function okPayload(): Promise<AnalysisPayload> {
  const result = await analyzeVideoSync({ url: VALID_URL }, goldDeps());
  if (result.status !== "ok") throw new Error("expected ok");
  return { result, insights: { overview: reportOverview(result.report), findings: keyFindings(result.report) } };
}

const ID = "11111111-1111-4111-8111-111111111111";

function analysis(kind: AnalysisSnapshot["sourceKind"], status: AnalysisSnapshot["status"], payload?: AnalysisPayload): AnalysisSnapshot {
  return {
    id: ID,
    sourceId: kind === "fixture" ? "fixture:t1-topics-v1" : kind,
    sourceKind: kind,
    label: kind,
    status,
    stage: status === "running" ? "fetching" : null,
    stages: stagesFor(kind),
    configVersion: "cfg",
    createdAt: 1,
    ...(status === "completed" ? { completedAt: 2 } : {}),
    ...(payload ? { payload } : {}),
  };
}

/** A fake server: POST returns `started`; GET /<id> returns the queued snapshots in turn (the last one repeats). */
function server(started: { analysis: AnalysisSnapshot; reused: boolean }, snapshots: AnalysisSnapshot[] = []) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return Response.json(started, { status: started.reused ? 200 : 202 });
    if (url === "/api/analyses") return Response.json({ analyses: [] });
    const next = snapshots.length > 1 ? snapshots.shift()! : snapshots[0];
    return next ? Response.json({ analysis: next }) : Response.json({ error: "gone" }, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
};

describe("analysis store", () => {
  it("follows a running analysis to completion with one poller, then shows it without further requests", async () => {
    const payload = await okPayload();
    const { fetch, calls } = server({ analysis: analysis("fixture", "queued"), reused: false }, [analysis("fixture", "running"), analysis("fixture", "completed", payload)]);
    const store = createAnalysisStore({ fetch, storage: () => memoryStorage(), pollMs: 1 });
    await store.start({ source: "fixture:t1-topics-v1" });
    await store.start({ source: "fixture:t1-topics-v1" }); // the server dedupes; the store follows the same id
    await until(() => store.getSnapshot().analyses[ID]?.status === "completed");
    expect(store.getSnapshot().currentId).toBe(ID);
    expect(store.getSnapshot().analyses[ID]?.payload).toEqual(payload);
    const requests = calls.length;
    // "Navigating away and back": opening the known, finished analysis makes no request at all.
    store.close();
    store.open(ID);
    expect(store.getSnapshot().currentId).toBe(ID);
    expect(calls.length).toBe(requests);
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(2);
  });

  it("shows a reused completed analysis at once, flagged as reused (no progress)", async () => {
    const payload = await okPayload();
    const { fetch } = server({ analysis: analysis("demo", "completed", payload), reused: true });
    const store = createAnalysisStore({ fetch, storage: () => undefined });
    await store.start({ source: "demo" });
    expect(store.getSnapshot()).toMatchObject({ currentId: ID, reused: true });
    expect(store.getSnapshot().analyses[ID]?.status).toBe("completed");
  });

  it("keeps synthetic results in session storage and restores them without asking the server", async () => {
    const storage = memoryStorage();
    const payload = await okPayload();
    const first = createAnalysisStore({ fetch: server({ analysis: analysis("fixture", "completed", payload), reused: false }).fetch, storage: () => storage });
    await first.start({ source: "fixture:t1-topics-v1" });
    first.setUi({ explorerSentiment: "negative" });

    const { fetch, calls } = server({ analysis: analysis("fixture", "completed"), reused: true }); // server restarted: knows nothing
    const reloaded = createAnalysisStore({ fetch, storage: () => storage });
    reloaded.restore();
    expect(reloaded.getSnapshot().currentId).toBe(ID);
    expect(reloaded.getSnapshot().analyses[ID]?.payload).toEqual(payload);
    expect(reloaded.getSnapshot().ui.explorerSentiment).toBe("negative");
    expect(calls.filter((c) => c.includes(ID))).toEqual([]);
  });

  it("never writes real YouTube results to browser storage; only the opaque id", async () => {
    const storage = memoryStorage();
    const payload = await okPayload();
    const store = createAnalysisStore({ fetch: server({ analysis: analysis("youtube", "completed", payload), reused: false }).fetch, storage: () => storage });
    await store.start({ source: "youtube", url: VALID_URL });
    store.setUi({ explorerTopic: "x" });
    const saved = JSON.parse(storage.data.get(SESSION_KEY)!) as { currentId: string; analyses: unknown[]; ui: { explorerTopic: string } };
    expect(saved.currentId).toBe(ID);
    expect(saved.analyses).toEqual([]);
    expect(saved.ui.explorerTopic).toBe("all");
    expect(storage.data.get(SESSION_KEY)).not.toContain(payload.result.status === "ok" ? payload.result.report.videoId : "x");
  });

  it("ignores a saved entry that claims to be YouTube data; reopening asks the server, which may have dropped it", async () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ currentId: ID, ui: {}, analyses: [analysis("youtube", "completed", await okPayload())] }));
    const store = createAnalysisStore({ fetch: server({ analysis: analysis("youtube", "completed"), reused: false }).fetch, storage: () => storage });
    store.restore();
    expect(store.getSnapshot().analyses[ID]?.payload).toBeUndefined();
    await until(() => store.getSnapshot().missing);
    expect(store.getSnapshot().missing).toBe(true);
  });

  it("reports refused requests with the field they concern", async () => {
    const fetch = (async () => Response.json({ error: "This isn't a valid YouTube video link.", field: "url" }, { status: 400 })) as unknown as typeof globalThis.fetch;
    const store = createAnalysisStore({ fetch, storage: () => undefined });
    await store.start({ source: "youtube", url: "nope" });
    expect(store.getSnapshot().error).toEqual({ message: "This isn't a valid YouTube video link.", field: "url" });
    expect(store.getSnapshot().currentId).toBeNull();
  });
});
