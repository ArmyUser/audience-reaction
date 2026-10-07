import { describe, expect, it, vi } from "vitest";
import type { AnalysisPayload } from "../../src/application/analysis-api";
import { ANALYSIS_STAGES, stagesFor } from "../../src/application/progress";
import { AnalysisRegistry, fingerprint, MAX_ENTRIES, SYNTHETIC_RESULT_TTL_MS, YOUTUBE_RESULT_TTL_MS, type AnalysisJob } from "../../src/local/analysis-registry";

// The registry runs jobs itself; these jobs are fakes, so nothing here calls a provider.

// Stage id from the source: a long literal here could collide with dataset text in the leakage audits.
const CLASSIFY = ANALYSIS_STAGES[1];
const OK = { result: { status: "ok", report: {} } } as unknown as AnalysisPayload;
const NOT_OK = { result: { status: "cost_limit_reached", message: "stopped" } } as unknown as AnalysisPayload;
const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function job(key: string, run: AnalysisJob["run"], kind: AnalysisJob["sourceKind"] = "fixture"): AnalysisJob {
  return { key, sourceId: `id-${key}`, sourceKind: kind, label: key, configVersion: "cfg1", stages: stagesFor(kind), run };
}

function registry(now = { t: 1_000 }, retained?: (e: { sourceKind: string }) => boolean) {
  let n = 0;
  return new AnalysisRegistry({ now: () => now.t, newId: () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`, ...(retained ? { retained } : {}) });
}

describe("analysis registry", () => {
  it("runs a job once, tracks its stage, and keeps the result", async () => {
    const r = registry();
    const gate = deferred<AnalysisPayload>();
    const run = vi.fn(async (onStage: (s: typeof CLASSIFY) => void) => {
      onStage(CLASSIFY);
      return gate.promise;
    });
    const { analysis, reused } = r.start(job("a", run));
    expect([analysis.status, reused]).toEqual(["queued", false]);
    await flush();
    expect(r.get(analysis.id)).toMatchObject({ status: "running", stage: CLASSIFY });
    gate.resolve(OK);
    await flush();
    expect(r.get(analysis.id)).toMatchObject({ status: "completed", stage: null, payload: OK });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reuses an identical running or completed analysis instead of running it again", async () => {
    const r = registry();
    const gate = deferred<AnalysisPayload>();
    const run = vi.fn(() => gate.promise);
    const first = r.start(job("same", run));
    const whileRunning = r.start(job("same", run));
    expect(whileRunning).toMatchObject({ reused: true, analysis: { id: first.analysis.id } });
    gate.resolve(OK);
    await flush();
    const afterwards = r.start(job("same", run));
    expect(afterwards).toMatchObject({ reused: true, analysis: { id: first.analysis.id, status: "completed" } });
    expect(run).toHaveBeenCalledTimes(1);
    // A different key (other dataset, video or configuration) is a different analysis.
    r.start(job("other", run));
    expect(run).toHaveBeenCalledTimes(1);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never reuses a failed analysis, so a retry runs again", async () => {
    const r = registry();
    const run = vi.fn(async () => NOT_OK);
    const first = r.start(job("k", run));
    await flush();
    expect(r.get(first.analysis.id)?.status).toBe("failed");
    const retry = r.start(job("k", run));
    expect(retry.reused).toBe(false);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);

    const thrown = r.start(job("x", async () => Promise.reject(new Error("provider said: secret text"))));
    await flush();
    expect(r.get(thrown.analysis.id)).toMatchObject({ status: "failed", error: "The analysis failed unexpectedly. No report was produced." });
    expect(JSON.stringify(r.get(thrown.analysis.id))).not.toContain("secret text");
  });

  it("drops YouTube results after 30 minutes and synthetic ones after 6 hours", async () => {
    const now = { t: 0 };
    const r = registry(now);
    const yt = r.start(job("yt", async () => OK, "youtube"));
    const fx = r.start(job("fx", async () => OK, "fixture"));
    await flush();
    now.t = YOUTUBE_RESULT_TTL_MS - 1;
    expect(r.get(yt.analysis.id)).toBeDefined();
    now.t = YOUTUBE_RESULT_TTL_MS;
    expect(r.get(yt.analysis.id)).toBeUndefined();
    expect(r.get(fx.analysis.id)).toBeDefined();
    now.t = SYNTHETIC_RESULT_TTL_MS;
    expect(r.get(fx.analysis.id)).toBeUndefined();
    expect(r.list()).toEqual([]);
  });

  it("drops an entry as soon as its retention check fails (e.g. CG-1 no longer allows YouTube data)", async () => {
    let allowed = true;
    const r = registry({ t: 0 }, (e) => e.sourceKind !== "youtube" || allowed);
    const yt = r.start(job("yt", async () => OK, "youtube"));
    await flush();
    expect(r.get(yt.analysis.id)).toBeDefined();
    allowed = false;
    expect(r.get(yt.analysis.id)).toBeUndefined();
    // And it is not reused either: a new request is a new analysis (which CG-1 will then block).
    expect(r.start(job("yt", async () => OK, "youtube")).reused).toBe(false);
  });

  it("keeps at most MAX_ENTRIES, dropping the oldest finished first; the list has no results", async () => {
    const now = { t: 0 };
    const r = registry(now);
    const ids: string[] = [];
    for (let i = 0; i < MAX_ENTRIES + 3; i++) {
      now.t = i;
      ids.push(r.start(job(`k${i}`, async () => OK)).analysis.id);
      await flush();
    }
    const list = r.list();
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0]!.id).toBe(ids.at(-1));
    expect(r.get(ids[0]!)).toBeUndefined();
    for (const s of list) expect("payload" in s).toBe(false);
  });

  it("fingerprints configurations stably and distinctly", () => {
    expect(fingerprint({ a: 1, b: [2] })).toBe(fingerprint({ a: 1, b: [2] }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({})).toMatch(/^[0-9a-f]{8}$/);
  });
});
