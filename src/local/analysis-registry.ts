import type { AnalysisPayload, AnalysisSnapshot, AnalysisStatus, AnalysisSummary } from "../application/analysis-api";
import type { AnalysisSourceKind, AnalysisStage, StageInfo } from "../application/progress";

// In-memory registry of analyses for the local app (server-side only). It lets a completed analysis be reopened,
// and a running one be followed, without running it again, i.e. without new YouTube, Jev or Anthropic calls.
// Retention (docs/compliance/cg1-internal-testing-exception.md):
// - memory only: no disk, no database, nothing survives a server restart;
// - entries hold the report view model only. For real YouTube data that model has no comment text (spec §11; the
//   comment rows exist for synthetic data only); comment text itself is discarded with the analysis, as before;
// - bounded: real YouTube results expire 30 minutes after completion, synthetic ones after 6 hours, at most
//   MAX_ENTRIES entries; and a YouTube entry is dropped as soon as its retention check (the CG-1 gate) fails;
// - nothing here is logged.
// Reuse: an analysis is reused only for the same key (source, dataset or video ID, configuration fingerprint) while
// it is queued, running or completed. Failed analyses are never reused, so a retry runs again.

export const YOUTUBE_RESULT_TTL_MS = 30 * 60 * 1000;
export const SYNTHETIC_RESULT_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTRIES = 25;

export interface AnalysisJob {
  /** Identity for reuse: equal keys mean an identical analysis. */
  key: string;
  sourceId: string;
  sourceKind: AnalysisSourceKind;
  label: string;
  configVersion: string;
  stages: StageInfo[];
  run: (onStage: (stage: AnalysisStage) => void) => Promise<AnalysisPayload>;
}

interface Entry extends AnalysisSnapshot {
  key: string;
}

export interface RegistryOptions {
  now?: () => number;
  newId?: () => string;
  /** Retention check for an entry, run on every read (YouTube: the CG-1 gate must still allow the data). */
  retained?: (entry: AnalysisSummary) => boolean;
}

export class AnalysisRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly retained: (entry: AnalysisSummary) => boolean;

  constructor(options: RegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.retained = options.retained ?? (() => true);
  }

  /** Starts the job, or returns the identical analysis already queued, running or completed. */
  start(job: AnalysisJob): { analysis: AnalysisSnapshot; reused: boolean } {
    this.sweep();
    for (const e of this.entries.values()) {
      if (e.key === job.key && e.status !== "failed") return { analysis: snapshot(e), reused: true };
    }
    const entry: Entry = {
      id: this.newId(),
      key: job.key,
      sourceId: job.sourceId,
      sourceKind: job.sourceKind,
      label: job.label,
      status: "queued",
      stage: null,
      stages: job.stages,
      configVersion: job.configVersion,
      createdAt: this.now(),
    };
    this.entries.set(entry.id, entry);
    this.trim();
    // Detached from the HTTP request: leaving the page does not stop or repeat the analysis.
    queueMicrotask(() => void this.execute(entry, job));
    return { analysis: snapshot(entry), reused: false };
  }

  get(id: string): AnalysisSnapshot | undefined {
    this.sweep();
    const e = this.entries.get(id);
    return e ? snapshot(e) : undefined;
  }

  /** Newest first, without results. */
  list(): AnalysisSummary[] {
    this.sweep();
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt).map(summary);
  }

  private async execute(entry: Entry, job: AnalysisJob): Promise<void> {
    entry.status = "running";
    try {
      const payload = await job.run((stage) => {
        entry.stage = stage;
      });
      entry.payload = payload;
      entry.status = payload.result.status === "ok" ? "completed" : "failed";
    } catch {
      // Never log provider error messages (they could echo request content).
      entry.status = "failed";
      entry.error = "The analysis failed unexpectedly. No report was produced.";
    }
    entry.stage = null;
    entry.completedAt = this.now();
    entry.expiresAt = entry.completedAt + (entry.sourceKind === "youtube" || entry.status === "failed" ? YOUTUBE_RESULT_TTL_MS : SYNTHETIC_RESULT_TTL_MS);
  }

  /** Drops expired entries and any entry whose retention check fails. Running analyses are kept until they finish. */
  private sweep(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const expired = e.expiresAt !== undefined && now >= e.expiresAt;
      if (expired || !this.retained(summary(e))) this.entries.delete(id);
    }
  }

  /** Keeps at most MAX_ENTRIES, dropping the oldest finished ones first. */
  private trim(): void {
    const finished = [...this.entries.values()].filter((e) => e.status === "completed" || e.status === "failed").sort((a, b) => a.createdAt - b.createdAt);
    while (this.entries.size > MAX_ENTRIES && finished.length > 0) this.entries.delete(finished.shift()!.id);
  }
}

function summary(e: Entry): AnalysisSummary {
  return {
    id: e.id,
    sourceId: e.sourceId,
    sourceKind: e.sourceKind,
    label: e.label,
    status: e.status,
    stage: e.stage,
    stages: e.stages,
    configVersion: e.configVersion,
    createdAt: e.createdAt,
    ...(e.completedAt !== undefined ? { completedAt: e.completedAt } : {}),
    ...(e.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}),
  };
}

function snapshot(e: Entry): AnalysisSnapshot {
  return { ...summary(e), ...(e.payload ? { payload: e.payload } : {}), ...(e.error ? { error: e.error } : {}) };
}

export function isFinished(status: AnalysisStatus): boolean {
  return status === "completed" || status === "failed";
}

/** 32-bit FNV-1a as 8 hex digits: a short, stable configuration fingerprint (not a security hash). */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
