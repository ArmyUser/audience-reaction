"use client";

import { useEffect, useState } from "react";
import type { AnalysisStage, StageInfo } from "../application/progress";

// Stage-based progress: the bar advances by completed stages only (the server reports when each stage starts), and
// the running stage shows an indeterminate stripe, so no precision is implied that the server does not have.

export function ProgressPanel({ stages, current, startedAt, sourceLabel }: { stages: StageInfo[]; current: AnalysisStage | null; startedAt: number; sourceLabel: string }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const index = current ? stages.findIndex((s) => s.id === current) : -1;
  const total = Math.max(stages.length, 1);
  const done = Math.max(index, 0);
  const active = index >= 0 ? stages[index] : undefined;
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const stepText = active ? `Step ${index + 1} of ${stages.length}: ${active.label}` : "Starting the analysis";

  return (
    <section className="progress-card" aria-labelledby="progress-title">
      <div className="progress-head">
        <div>
          <p className="eyebrow">Analysis in progress</p>
          <h2 id="progress-title">{active ? `${active.label}…` : "Starting…"}</h2>
          <p className="muted small">{sourceLabel}</p>
        </div>
        <p className="progress-elapsed num" aria-label={`Elapsed ${elapsed} seconds`}>
          {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, "0")}s`}
        </p>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={stepText}>
        <span className="progress-done" style={{ width: `${(done / total) * 100}%` }} />
        {active && <span className="progress-active" style={{ left: `${(done / total) * 100}%`, width: `${100 / total}%` }} />}
      </div>
      <ol className="stage-list">
        {stages.map((s, i) => {
          const state = i < done ? "done" : i === index ? "active" : "pending";
          return (
            <li key={s.id} className={`stage stage-${state}`} aria-current={state === "active" ? "step" : undefined}>
              <span className="stage-icon" aria-hidden="true">
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="stage-label">{s.label}</span>
              <span className="sr-only">{state === "done" ? " (done)" : state === "active" ? " (running)" : " (pending)"}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted small" aria-live="polite">
        You can open other pages while this runs; the report will be here when you come back.
      </p>
    </section>
  );
}
