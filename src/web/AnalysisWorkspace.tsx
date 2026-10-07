"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AnalysisSnapshot, AnalysisSourceOption, AnalysisSourceSetup } from "../application/analysis-api";
import type { AnalyzeVideoResult } from "../application/analyze-video-sync";
import { analysisStore, isRunning } from "./analysis-store";
import { StateMessage } from "./primitives";
import { ProgressPanel } from "./ProgressPanel";
import { Report } from "./Report";

// The Analyze page. The data source comes first and decides the next input: test data → choose a dataset; real
// YouTube → enter a video link (with the policy notice). Analyses live on the server (in memory) and are addressed by
// id (/?id=…): reopening one, from the URL or from Recent analyses, shows its current state or its result without
// running it again. The server re-checks every choice; this page only offers what it reports as configured.

type Mode = "test" | "youtube";

export function AnalysisWorkspace({ setup, initialId }: { setup: AnalysisSourceSetup; initialId?: string }) {
  const store = analysisStore;
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  useEffect(() => {
    if (initialId) store.open(initialId);
    store.restore();
  }, [store, initialId]);

  // Keep the address bar on the open analysis, so a reload or a copied link reopens it (never re-runs it).
  useEffect(() => {
    const target = snap.currentId ? `/?id=${encodeURIComponent(snap.currentId)}` : "/";
    if (window.location.pathname === "/" && `${window.location.pathname}${window.location.search}` !== target) window.history.replaceState(window.history.state, "", target);
  }, [snap.currentId]);

  const current = snap.currentId ? snap.analyses[snap.currentId] : undefined;

  return (
    <div className="workspace">
      <header className="page-header">
        <div>
          <h1>Analyze</h1>
          <p className="page-lede">Choose the data to analyse. The report shows overall sentiment, what people talk about, and how they feel about each topic.</p>
        </div>
      </header>

      <div className="analyze-layout">
        <SourceForm setup={setup} />
        <RecentAnalyses analyses={snap.order.map((id) => snap.analyses[id]!).filter(Boolean)} currentId={snap.currentId} onOpen={(id) => store.open(id)} />
      </div>

      <CurrentAnalysis analysis={current} missing={snap.missing} reused={snap.reused} />
    </div>
  );
}

// ---------- source selection ----------

function SourceForm({ setup }: { setup: AnalysisSourceSetup }) {
  const store = analysisStore;
  const { draft, starting, error } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [acknowledged, setAcknowledged] = useState(false);

  const defaultMode: Mode = setup.defaultId === "youtube" && setup.youtube?.available ? "youtube" : "test";
  const mode: Mode = draft.mode ?? defaultMode;
  const defaultDataset = setup.testOptions.find((o) => o.id === setup.defaultId) ?? setup.testOptions[0]!;
  const dataset = setup.testOptions.find((o) => o.id === draft.datasetId) ?? defaultDataset;
  const youtube = setup.youtube;

  const run = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (starting) return;
    if (mode === "test") {
      if (dataset.available) void store.start({ source: dataset.id });
      return;
    }
    if (!youtube?.available || !acknowledged) return;
    void store.start({ source: "youtube", url: draft.url.trim() });
  };

  return (
    <form className="panel source-panel" onSubmit={run} aria-label="Choose the data to analyse">
      {setup.configError && (
        <StateMessage tone="warning" title="Check the local .env file">
          <p>{setup.configError}</p>
        </StateMessage>
      )}

      <fieldset className="source-switch">
        <legend className="field-label">Data source</legend>
        <div className="segmented" role="radiogroup" aria-label="Data source">
          <SourceTab checked={mode === "test"} onSelect={() => store.setDraft({ mode: "test" })} title="Test data" detail="Synthetic datasets, no YouTube data" />
          <SourceTab checked={mode === "youtube"} onSelect={() => store.setDraft({ mode: "youtube" })} title="Real YouTube" detail="Comments of a public video" tone="real" />
        </div>
      </fieldset>

      {mode === "test" ? (
        <div className="source-config">
          <label className="field-label" htmlFor="dataset">
            Test dataset
          </label>
          <select id="dataset" value={dataset.id} onChange={(e) => store.setDraft({ datasetId: e.target.value })}>
            {setup.testOptions.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.available}>
                {o.kind === "demo" ? "Demo" : o.label}
                {!o.available ? " (not configured)" : ""}
              </option>
            ))}
          </select>
          <DatasetFacts option={dataset} costLimitUsd={setup.costLimitUsd} />
          <p className="field-hint">Synthetic and development data: explore the analysis without accessing any YouTube data.</p>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={starting || !dataset.available}>
              {starting ? "Starting…" : "Run analysis"}
            </button>
          </div>
          {error && <p className="field-error" role="alert">{error.message}</p>}
        </div>
      ) : (
        <YouTubeConfig setup={setup} url={draft.url} acknowledged={acknowledged} onAcknowledge={setAcknowledged} starting={starting} error={error} />
      )}
    </form>
  );
}

function SourceTab({ checked, onSelect, title, detail, tone }: { checked: boolean; onSelect: () => void; title: string; detail: string; tone?: "real" }) {
  return (
    <label className={`segment ${checked ? "is-selected" : ""} ${tone === "real" ? "segment-real" : ""}`}>
      <input type="radio" name="data-source" className="sr-only" checked={checked} onChange={onSelect} />
      <span className="segment-title">{title}</span>
      <span className="segment-detail">{detail}</span>
    </label>
  );
}

function DatasetFacts({ option, costLimitUsd }: { option: AnalysisSourceOption; costLimitUsd: number }) {
  if (option.kind === "demo") {
    return (
      <ul className="facts">
        <li>{option.comments} synthetic comments</li>
        <li>Rule-based classifier, no topics</li>
        <li>No AI calls, no cost</li>
      </ul>
    );
  }
  return (
    <>
      <ul className="facts">
        <li>{option.comments} synthetic comments (development set)</li>
        <li>Real AI pipeline with topics</li>
        <li>Paid AI calls, capped at ${costLimitUsd.toFixed(2)}</li>
      </ul>
      {!option.available && option.unavailableReason && <p className="field-error">{option.unavailableReason}</p>}
    </>
  );
}

function YouTubeConfig({
  setup,
  url,
  acknowledged,
  onAcknowledge,
  starting,
  error,
}: {
  setup: AnalysisSourceSetup;
  url: string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  starting: boolean;
  error: { message: string; field?: "url" | "source" } | null;
}) {
  const youtube = setup.youtube;
  if (!youtube) {
    return (
      <div className="source-config">
        <StateMessage tone="neutral" title="Real YouTube analysis is not configured" role="note">
          <p>It needs the YouTube Data API key and both AI provider keys. Settings → API &amp; models shows what is missing.</p>
        </StateMessage>
      </div>
    );
  }
  if (!youtube.available) {
    return (
      <div className="source-config">
        <StateMessage tone="warning" title="Real YouTube analysis is blocked by CG-1" role="note">
          <p>{youtube.unavailableReason}</p>
        </StateMessage>
      </div>
    );
  }
  return (
    <div className="source-config">
      <label className="field-label" htmlFor="url">
        YouTube video
      </label>
      <div className="url-row">
        <input
          id="url"
          name="url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => analysisStore.setDraft({ url: e.target.value })}
          placeholder="https://www.youtube.com/watch?v=…"
          maxLength={2048}
          required
          autoComplete="off"
          aria-invalid={error?.field === "url" ? true : undefined}
          aria-describedby={error?.field === "url" ? "url-error" : undefined}
        />
        <button type="submit" className="button button-primary" disabled={starting || !acknowledged || url.trim() === ""}>
          {starting ? "Starting…" : "Analyze"}
        </button>
      </div>
      {error && (
        <p className="field-error" id="url-error" role="alert">
          {error.message}
        </p>
      )}
      <p className="field-hint">
        Top-level comments (up to the configured limit), analysed by the real AI pipeline. Paid AI calls, capped at ${setup.costLimitUsd.toFixed(2)} per analysis.
      </p>

      <div className="policy-notice" role="note">
        <p className="policy-title">YouTube API policies apply</p>
        <p>
          Real YouTube data is accessed through the YouTube Data API and is subject to the YouTube API Services Terms of Service and Developer Policies. Some analytics and derived-metric uses
          require specific authorization from YouTube, which this tool does not hold. Here it is a time-limited internal test (CG-1 exception {youtube.gate.state === "internal_testing" ? youtube.gate.id : ""}
          {youtube.gate.state === "internal_testing" ? `, expires ${youtube.gate.expiresOn}` : ""}), not an approved product feature. You are responsible for using YouTube API data in line with the
          applicable policies.
        </p>
        <ul className="policy-links">
          {setup.policyLinks.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer noopener">
                {l.label} ↗
              </a>
            </li>
          ))}
        </ul>
        <label className="ack">
          <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
          <span>I understand: internal testing only. Results are not shared, exported or stored, and comment text is not shown.</span>
        </label>
      </div>
    </div>
  );
}

// ---------- recent analyses ----------

const STATUS_LABEL: Record<AnalysisSnapshot["status"], string> = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" };

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RecentAnalyses({ analyses, currentId, onOpen }: { analyses: AnalysisSnapshot[]; currentId: string | null; onOpen: (id: string) => void }) {
  return (
    <section className="panel recent" aria-labelledby="recent-title">
      <div className="recent-head">
        <h2 id="recent-title">Recent analyses</h2>
        <span className="muted small">this session</span>
      </div>
      {analyses.length === 0 ? (
        <p className="muted small recent-empty">Completed analyses appear here and reopen instantly, without running again.</p>
      ) : (
        <ul className="recent-list">
          {analyses.slice(0, 8).map((a) => (
            <li key={a.id}>
              <button type="button" className={`recent-item ${a.id === currentId ? "is-current" : ""}`} onClick={() => onOpen(a.id)} aria-current={a.id === currentId ? "true" : undefined}>
                <span className={`source-dot source-${a.sourceKind}`} aria-hidden="true" />
                <span className="recent-main">
                  <span className="recent-label">{a.label}</span>
                  <span className="recent-meta">
                    {a.sourceKind === "youtube" ? "Real YouTube" : a.sourceKind === "fixture" ? "Test data · real AI" : "Test data · demo"} · {time(a.completedAt ?? a.createdAt)}
                  </span>
                </span>
                <span className={`status-pill status-${a.status}`}>
                  <span className="dot" aria-hidden="true" />
                  {isRunning(a) && a.stage ? (a.stages.find((s) => s.id === a.stage)?.label ?? STATUS_LABEL[a.status]) : STATUS_LABEL[a.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small recent-note">Results are kept in memory by the local server for a limited time. Real YouTube results are never saved in the browser.</p>
    </section>
  );
}

// ---------- the open analysis ----------

function CurrentAnalysis({ analysis, missing, reused }: { analysis: AnalysisSnapshot | undefined; missing: boolean; reused: boolean }) {
  const store = analysisStore;
  const { ui } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  if (missing) {
    return (
      <StateMessage tone="neutral" title="This analysis is no longer available" role="note">
        <p>Results are kept in memory for a limited time (and never for real YouTube data beyond 30 minutes), and are cleared when the local server restarts. Run the analysis again to see it.</p>
      </StateMessage>
    );
  }
  if (!analysis) return <EmptyState />;
  if (isRunning(analysis)) {
    return <ProgressPanel stages={analysis.stages} current={analysis.stage} startedAt={analysis.createdAt} sourceLabel={sourceLabel(analysis)} />;
  }
  if (!analysis.payload) {
    if (analysis.error) {
      return (
        <StateMessage tone="error" title="The analysis could not be completed" role="alert">
          <p>{analysis.error}</p>
        </StateMessage>
      );
    }
    return (
      <section className="panel loading-line" role="status">
        <p className="muted">Loading the analysis…</p>
      </section>
    );
  }
  const { result, insights, run } = analysis.payload;
  if (result.status !== "ok" || !insights) return <ResultMessage result={result as Exclude<AnalyzeVideoResult, { status: "ok" }>} />;
  return (
    <>
      {reused && analysis.completedAt !== undefined && (
        <p className="reuse-note" role="status">
          Reopened the completed analysis from {time(analysis.completedAt)}. Nothing was run again: no new provider calls, no cost.
        </p>
      )}
      <Report key={analysis.id} report={result.report} insights={insights} {...(run ? { run } : {})} ui={ui} onUiChange={store.setUi} analysisMeta={{ id: analysis.id, configVersion: analysis.configVersion }} />
    </>
  );
}

function sourceLabel(a: AnalysisSnapshot): string {
  if (a.sourceKind === "demo") return "Test data · Demo (rule-based classifier, no AI calls)";
  if (a.sourceKind === "fixture") return `Test data · ${a.label} · real AI pipeline`;
  return `Real YouTube · ${a.label} · internal test`;
}

const TITLES: Record<Exclude<AnalyzeVideoResult["status"], "ok">, string> = {
  invalid_url: "That link isn't a single YouTube video",
  blocked_by_policy: "Analysis of real YouTube comments is blocked",
  insufficient_data: "Not enough comments to report on",
  analysis_failed: "The analysis could not be completed",
  source_unavailable: "The comments could not be retrieved",
  cost_limit_reached: "The analysis stopped at its cost limit",
  not_configured: "The local app is not configured for this source",
};

export function ResultMessage({ result }: { result: Exclude<AnalyzeVideoResult, { status: "ok" }> }) {
  const tone = result.status === "invalid_url" || result.status === "insufficient_data" || result.status === "blocked_by_policy" ? "warning" : "error";
  return (
    <StateMessage tone={tone} title={TITLES[result.status]} role="alert">
      <p>
        {result.message}
        {result.status === "invalid_url" && <span className="code"> ({result.reason})</span>}
      </p>
      {result.status === "cost_limit_reached" && <p className="muted">No partial report is shown. The limit is set in config/real-mode.json.</p>}
      {result.status === "not_configured" && <p className="muted">Provider keys are set in the local .env file; see Settings → API &amp; models.</p>}
    </StateMessage>
  );
}

function EmptyState() {
  return (
    <section className="empty" aria-label="Getting started">
      <div>
        <h2>Understand how an audience reacted</h2>
        <p className="lead">Choose a data source and run an analysis. The report answers, in order:</p>
      </div>
      <ol className="steps">
        <li>
          <strong>What happened</strong>
          <span>Volume and overall sentiment of the conversation.</span>
        </li>
        <li>
          <strong>What people talk about</strong>
          <span>Recurring topics, ranked by volume.</span>
        </li>
        <li>
          <strong>How they feel about each topic</strong>
          <span>Sentiment toward every topic, side by side.</span>
        </li>
        <li>
          <strong>The evidence</strong>
          <span>Representative comments behind each topic, then every comment.</span>
        </li>
      </ol>
    </section>
  );
}
