import type { ReactNode } from "react";
import type { DistributionView } from "../application/analyze-video-sync";

// Presentation primitives shared by the report and the evaluation view. Server- and client-safe (no hooks).
// Sentiment is always encoded the same way: stable keys map to the --sent-* colour tokens in globals.css, and every
// coloured mark also carries text, so colour is never the only channel.

export const SENTIMENT_ORDER = ["positive", "neutral", "mixed", "negative"] as const;

export function sentimentClass(key: string): string {
  return `sent-${(SENTIMENT_ORDER as readonly string[]).includes(key) ? key : "other"}`;
}

/** Rows in the canonical positive → neutral → (mixed) → negative order. */
export function orderedRows(d: DistributionView): DistributionView["rows"] {
  return [...d.rows].sort((a, b) => SENTIMENT_ORDER.indexOf(a.key as never) - SENTIMENT_ORDER.indexOf(b.key as never));
}

/** Small samples up to this size are drawn as one square per comment. */
export const UNIT_CHART_MAX = 60;

/**
 * One horizontal stacked bar of a sentiment distribution. With `showPercentages` false (small sample) no percentage is
 * shown or implied (spec.md §8.6): a unit chart draws one square per comment, so the marks are the counts themselves.
 */
export function SentimentBar({ distribution, showPercentages = true, size = "md", label }: { distribution: DistributionView; showPercentages?: boolean; size?: "sm" | "md" | "lg"; label?: string }) {
  const rows = orderedRows(distribution);
  const summary = rows.map((r) => `${r.label} ${showPercentages ? `${r.percent}%` : r.count}`).join(", ");
  if (!showPercentages && distribution.base > 0 && distribution.base <= UNIT_CHART_MAX) {
    return (
      <span className="units-wrap" role="img" aria-label={label ? `${label}: ${summary}` : summary}>
        <span className="units" aria-hidden="true">
          {rows.flatMap((r) => Array.from({ length: r.count }, (_, i) => <span key={`${r.key}-${i}`} className={`unit ${sentimentClass(r.key)}`} />))}
        </span>
        <span className="unit-counts" aria-hidden="true">
          {rows.map((r) => (
            <span key={r.key} className={sentimentClass(r.key)}>
              <span className="dot" />
              {r.count}
            </span>
          ))}
        </span>
      </span>
    );
  }
  if (!showPercentages || distribution.base === 0) {
    return (
      <span className="count-chips" aria-label={label ? `${label}: ${summary}` : summary}>
        {rows.map((r) => (
          <span key={r.key} className={`chip ${sentimentClass(r.key)}`}>
            <span className="dot" aria-hidden="true" />
            {r.count} {r.label.toLowerCase()}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className={`stacked stacked-${size}`} role="img" aria-label={label ? `${label}: ${summary}` : summary}>
      {rows
        .filter((r) => r.percent > 0)
        .map((r) => (
          <span key={r.key} className={`seg ${sentimentClass(r.key)}`} style={{ width: `${r.percent}%` }} title={`${r.label}: ${r.count} (${r.percent}%)`} />
        ))}
    </span>
  );
}

export function SentimentLegend({ keys = ["positive", "neutral", "negative"] }: { keys?: readonly string[] }) {
  return (
    <span className="legend">
      {keys.map((k) => (
        <span key={k} className={`legend-item ${sentimentClass(k)}`}>
          <span className="dot" aria-hidden="true" />
          {k.charAt(0).toUpperCase() + k.slice(1)}
        </span>
      ))}
    </span>
  );
}

export function SentimentBadge({ sentiment, sentimentKey }: { sentiment: string; sentimentKey: string }) {
  return (
    <span className={`badge ${sentimentClass(sentimentKey)}`}>
      <span className="dot" aria-hidden="true" />
      {sentiment}
    </span>
  );
}

/** A single-colour share bar (volume, not sentiment). */
export function ShareBar({ percent }: { percent: number }) {
  return (
    <span className="sharebar" aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );
}

export function SectionHeader({ id, eyebrow, title, description, aside }: { id?: string; eyebrow?: string; title: string; description?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="section-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 id={id}>{title}</h2>
        {description && <p className="section-desc">{description}</p>}
      </div>
      {aside && <div className="section-aside">{aside}</div>}
    </header>
  );
}

export type Tone = "info" | "warning" | "error" | "neutral";

export function StateMessage({ tone, title, children, role }: { tone: Tone; title: string; children?: ReactNode; role?: "alert" | "note" | "status" }) {
  return (
    <div className={`state state-${tone}`} role={role ?? (tone === "error" ? "alert" : "note")}>
      <p className="state-title">{title}</p>
      {children && <div className="state-body">{children}</div>}
    </div>
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
