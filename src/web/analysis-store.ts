import type { AnalysisSnapshot, AnalysisSummary, StartAnalysisResponse } from "../application/analysis-api";

// Browser-side view of the server's analyses (the server's in-memory registry is the source of truth). Kept outside
// React components, so it survives client-side navigation (Analyze → Evaluation → Analyze) without re-running or
// re-paying for anything. A running analysis is followed by polling its status; a finished one is fetched once and
// then shown from memory.
// Browser storage (sessionStorage, cleared when the tab closes):
// - synthetic data (demo, fixture datasets): finished results are kept, so a reload or a server restart still
//   reopens them without a new AI run;
// - real YouTube data: never written to browser storage. Only the opaque analysis id is kept, and reopening fetches
//   the result from the server's bounded in-memory cache while it lasts.

/** Report interaction state (selected topic, comment filters), kept with the open report. */
export interface ReportUiState {
  selectedTopicId?: string;
  explorerTopic: string;
  explorerSentiment: string;
  explorerType: string;
  explorerQuery: string;
  explorerOpen: boolean;
}

export const INITIAL_UI: ReportUiState = { explorerTopic: "all", explorerSentiment: "all", explorerType: "all", explorerQuery: "", explorerOpen: false };

export interface Draft {
  mode: "test" | "youtube" | null;
  datasetId: string | null;
  url: string;
}

export interface StoreSnapshot {
  /** Known analyses by id: summaries from the server, with results once fetched. */
  analyses: Record<string, AnalysisSnapshot>;
  /** Newest first. */
  order: string[];
  currentId: string | null;
  /** The current analysis was an existing one reused on request (no new provider calls). */
  reused: boolean;
  /** The current id could not be found (expired, dropped, or the server restarted). */
  missing: boolean;
  /** Request-level error (validation, network), with the field it concerns. */
  error: { message: string; field?: "url" | "source" } | null;
  starting: boolean;
  ui: ReportUiState;
  draft: Draft;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SESSION_KEY = "audience-reaction:analyses:v2";
const POLL_MS = 1000;

const INITIAL: StoreSnapshot = {
  analyses: {},
  order: [],
  currentId: null,
  reused: false,
  missing: false,
  error: null,
  starting: false,
  ui: INITIAL_UI,
  draft: { mode: null, datasetId: null, url: "" },
};

export const isRunning = (a: AnalysisSummary | undefined) => a !== undefined && (a.status === "queued" || a.status === "running");

export function createAnalysisStore(deps: { fetch?: typeof fetch; storage?: () => StorageLike | undefined; pollMs?: number } = {}) {
  let snapshot: StoreSnapshot = INITIAL;
  let restored = false;
  const polling = new Set<string>();
  const listeners = new Set<() => void>();
  const doFetch = (input: string, init?: RequestInit) => (deps.fetch ?? fetch)(input, init);
  const storage = () => {
    try {
      return deps.storage ? deps.storage() : typeof window === "undefined" ? undefined : window.sessionStorage;
    } catch {
      return undefined;
    }
  };

  const set = (next: Partial<StoreSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const l of listeners) l();
    persist();
  };

  /** Writes synthetic finished results and the current id. YouTube results are never written. */
  function persist() {
    try {
      const keep = Object.values(snapshot.analyses).filter((a) => a.sourceKind !== "youtube" && !isRunning(a) && a.payload);
      const ui = snapshot.currentId && snapshot.analyses[snapshot.currentId]?.sourceKind !== "youtube" ? { ...snapshot.ui, explorerOpen: false } : INITIAL_UI;
      storage()?.setItem(SESSION_KEY, JSON.stringify({ currentId: snapshot.currentId, ui, analyses: keep }));
    } catch {
      // storage unavailable: memory only for this page session
    }
  }

  /** Adds or updates an analysis; a summary (no result) never drops a result already fetched. */
  const upsert = (a: AnalysisSnapshot | AnalysisSummary) => {
    const analyses = { ...snapshot.analyses, [a.id]: { ...snapshot.analyses[a.id], ...a } };
    const order = Object.values(analyses)
      .sort((x, y) => y.createdAt - x.createdAt)
      .map((x) => x.id);
    set({ analyses, order });
  };

  async function fetchAnalysis(id: string): Promise<AnalysisSnapshot | null> {
    const res = await doFetch(`/api/analyses/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { analysis: AnalysisSnapshot }).analysis;
  }

  /** Follows a running analysis until it finishes. One poller per id; navigation does not start another. */
  function follow(id: string) {
    if (polling.has(id)) return;
    polling.add(id);
    const tick = async () => {
      try {
        const a = await fetchAnalysis(id);
        if (!a) {
          polling.delete(id);
          const { [id]: _gone, ...rest } = snapshot.analyses;
          set({ analyses: rest, order: snapshot.order.filter((x) => x !== id), ...(snapshot.currentId === id ? { missing: true } : {}) });
          return;
        }
        upsert(a);
        if (isRunning(a)) setTimeout(tick, deps.pollMs ?? POLL_MS);
        else polling.delete(id);
      } catch {
        setTimeout(tick, (deps.pollMs ?? POLL_MS) * 3);
      }
    };
    void tick();
  }

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,

    /** Once per tab: restores saved synthetic results and the current id, then merges the server's recent list. */
    restore() {
      if (restored) return;
      restored = true;
      try {
        const raw = storage()?.getItem(SESSION_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as { currentId: string | null; ui: ReportUiState; analyses: AnalysisSnapshot[] };
          for (const a of saved.analyses ?? []) if (a.sourceKind !== "youtube" && a.payload) upsert(a);
          if (saved.currentId && !snapshot.currentId) store.open(saved.currentId, saved.ui);
        }
      } catch {
        try {
          storage()?.removeItem(SESSION_KEY);
        } catch {
          // ignore
        }
      }
      void store.refreshList();
    },

    async refreshList() {
      try {
        const res = await doFetch("/api/analyses");
        if (!res.ok) return;
        for (const a of ((await res.json()) as { analyses: AnalysisSummary[] }).analyses) {
          upsert(a);
          if (isRunning(a)) follow(a.id);
        }
      } catch {
        // offline: keep what is known
      }
    },

    /** Shows an analysis: from memory when its result is known (no request at all), otherwise from the server. */
    open(id: string, ui: ReportUiState = INITIAL_UI) {
      set({ currentId: id, missing: false, reused: false, error: null, ui });
      const known = snapshot.analyses[id];
      if (known?.payload && !isRunning(known)) return;
      void (async () => {
        try {
          const a = await fetchAnalysis(id);
          if (!a) return set(snapshot.currentId === id ? { missing: true } : {});
          upsert(a);
          if (isRunning(a)) follow(id);
        } catch {
          set({ error: { message: "The local server could not be reached." } });
        }
      })();
    },

    close() {
      set({ currentId: null, missing: false, reused: false, ui: INITIAL_UI });
    },

    setDraft(draft: Partial<Draft>) {
      set({ draft: { ...snapshot.draft, ...draft }, error: null });
    },

    setUi(patch: Partial<ReportUiState>) {
      set({ ui: { ...snapshot.ui, ...patch } });
    },

    /** Starts an analysis; the server returns the identical one instead when it is running or completed. */
    async start(request: { source: string; url?: string }): Promise<void> {
      if (snapshot.starting) return;
      set({ starting: true, error: null });
      try {
        const res = await doFetch("/api/analyses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.url === undefined ? { source: request.source } : { source: request.source, url: request.url }),
        });
        const body = (await res.json().catch(() => null)) as (StartAnalysisResponse & { error?: string; field?: "url" | "source" }) | null;
        if (!res.ok || !body?.analysis) {
          return set({ starting: false, error: { message: body?.error ?? `The server refused the request (HTTP ${res.status}).`, ...(body?.field ? { field: body.field } : {}) } });
        }
        upsert(body.analysis);
        set({ starting: false, currentId: body.analysis.id, reused: body.reused, missing: false, ui: INITIAL_UI });
        if (isRunning(body.analysis)) follow(body.analysis.id);
      } catch {
        set({ starting: false, error: { message: "The local server could not be reached. Check that it is running." } });
      }
    },
  };
  return store;
}

export type AnalysisStore = ReturnType<typeof createAnalysisStore>;

/** The page-wide store: one per browser tab, shared by every route. */
export const analysisStore = createAnalysisStore();
