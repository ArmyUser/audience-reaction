"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailableTopicsView, CommentRowView } from "../application/analyze-video-sync";
import { SectionHeader, SentimentBadge } from "./primitives";

// Analysed comments, for data sources whose comment text may be shown (synthetic data only; the report model has no
// comment rows for real YouTube data). The report shows a short preview; the full list opens in a dialog with search
// and filters, so the report itself stays compact. Text is rendered as React text nodes (escaped), never as HTML.

export const PREVIEW_COMMENTS = 12;
const PAGE_SIZE = 50;

export interface ExplorerFilters {
  topic: string;
  sentiment: string;
  type: string;
  query: string;
}

export function filterComments(comments: readonly CommentRowView[], f: ExplorerFilters): CommentRowView[] {
  const q = f.query.trim().toLowerCase();
  return comments.filter((c) => {
    if (f.sentiment !== "all" && c.sentimentKey !== f.sentiment) return false;
    if (f.type !== "all" && c.typeKey !== f.type) return false;
    if (f.topic === "other" || f.topic === "no_specific_topic") {
      if (c.topic.kind !== f.topic) return false;
    } else if (f.topic !== "all" && !(c.topic.kind === "topic" && c.topic.topicId === f.topic)) return false;
    return q === "" || c.text.toLowerCase().includes(q);
  });
}

interface ExplorerProps {
  comments: CommentRowView[];
  topics: AvailableTopicsView | null;
  filters: ExplorerFilters;
  onFilters: (patch: Partial<ExplorerFilters>) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
}

/** In-report preview: the first comments matching the current filters, and the way into the full explorer. */
export function CommentPreview(props: ExplorerProps) {
  const { comments, filters, onOpen } = props;
  const shown = useMemo(() => filterComments(comments, filters), [comments, filters.topic, filters.sentiment, filters.type, filters.query]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = filters.topic !== "all" || filters.sentiment !== "all" || filters.type !== "all" || filters.query.trim() !== "";
  return (
    <section className="section" aria-labelledby="comments" id="comments-section">
      <SectionHeader
        id="comments"
        eyebrow="Comments"
        title="Analysed comments (synthetic)"
        description="Each analysed comment with its labels. Topic sentiment is sentiment toward the comment's topic; overall sentiment is the comment as a whole."
        aside={
          <button type="button" className="button button-secondary" onClick={() => onOpen(true)}>
            Open comment explorer ({comments.length})
          </button>
        }
      />
      <Filters {...props} shownCount={shown.length} compact />
      <CommentTable rows={shown.slice(0, PREVIEW_COMMENTS)} />
      <div className="preview-foot">
        <span className="muted small">
          Showing {Math.min(PREVIEW_COMMENTS, shown.length)} of {shown.length}
          {active ? ` matching (${comments.length} in total)` : ""}
        </span>
        {shown.length > PREVIEW_COMMENTS && (
          <button type="button" className="link-button" onClick={() => onOpen(true)}>
            View all {shown.length} comments →
          </button>
        )}
      </div>
      <ExplorerDialog {...props} />
    </section>
  );
}

function ExplorerDialog(props: ExplorerProps) {
  const { comments, filters, open, onOpen } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const shown = useMemo(() => filterComments(comments, filters), [comments, filters.topic, filters.sentiment, filters.type, filters.query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setLimit(PAGE_SIZE), [filters.topic, filters.sentiment, filters.type, filters.query]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="explorer-dialog"
      aria-labelledby="explorer-title"
      onClose={() => onOpen(false)}
      // A click on the backdrop (the dialog element itself, outside its content) closes it.
      onClick={(e) => e.target === e.currentTarget && onOpen(false)}
    >
      {open && (
        <div className="explorer">
          <header className="explorer-head">
            <div>
              <p className="eyebrow">Comment explorer</p>
              <h2 id="explorer-title">All analysed comments</h2>
            </div>
            <button type="button" className="button button-ghost" onClick={() => onOpen(false)} aria-label="Close comment explorer">
              Close ✕
            </button>
          </header>
          <Filters {...props} shownCount={shown.length} />
          <div className="explorer-body">
            <CommentTable rows={shown.slice(0, limit)} />
          </div>
          <footer className="explorer-foot">
            <span className="muted small">
              Showing {Math.min(limit, shown.length)} of {shown.length}
            </span>
            {shown.length > limit && (
              <button type="button" className="button button-secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, shown.length - limit)} more
              </button>
            )}
          </footer>
        </div>
      )}
    </dialog>
  );
}

function Filters({ comments, topics, filters, onFilters, shownCount, compact }: ExplorerProps & { shownCount: number; compact?: boolean }) {
  const types = useMemo(() => [...new Map(comments.map((c) => [c.typeKey, c.type])).entries()], [comments]);
  return (
    <div className="filters">
      {!compact && (
        <label className="filter-search">
          Search
          <input type="search" value={filters.query} placeholder="Search comment text" onChange={(e) => onFilters({ query: e.target.value })} />
        </label>
      )}
      {topics && (
        <label>
          Topic
          <select value={filters.topic} onChange={(e) => onFilters({ topic: e.target.value })}>
            <option value="all">All topics</option>
            {topics.topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="other">Other</option>
            <option value="no_specific_topic">No specific topic</option>
          </select>
        </label>
      )}
      <label>
        Overall sentiment
        <select value={filters.sentiment} onChange={(e) => onFilters({ sentiment: e.target.value })}>
          <option value="all">All</option>
          <option value="positive">Positive</option>
          <option value="neutral">Neutral</option>
          <option value="negative">Negative</option>
        </select>
      </label>
      {!compact && (
        <label>
          Type
          <select value={filters.type} onChange={(e) => onFilters({ type: e.target.value })}>
            <option value="all">All types</option>
            {types.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {!compact && (
        <span className="muted small filters-count" aria-live="polite">
          {shownCount} of {comments.length} comments
        </span>
      )}
    </div>
  );
}

function CommentTable({ rows }: { rows: CommentRowView[] }) {
  return (
    <div className="table-wrap">
      <table className="comments-table">
        <thead>
          <tr>
            <th scope="col">Comment</th>
            <th scope="col">Topic</th>
            <th scope="col">Overall</th>
            <th scope="col">Type</th>
            <th scope="col">Targets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="comment-text">{c.text}</td>
              <td>
                <TopicCell row={c} />
              </td>
              <td>
                <SentimentBadge sentiment={c.sentiment} sentimentKey={c.sentimentKey} />
              </td>
              <td>
                {c.type}
                {(c.isQuestion || c.isRequest) && <span className="muted small"> · {[c.isQuestion && "question", c.isRequest && "request"].filter(Boolean).join(", ")}</span>}
              </td>
              <td className="small">{c.targets.map((t) => `${t.label}: ${t.value}`).join(" · ")}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No comments match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TopicCell({ row }: { row: CommentRowView }) {
  const t = row.topic;
  if (t.kind === "topic")
    return (
      <span className="topic-cell">
        <span>{t.name}</span>
        <SentimentBadge sentiment={t.sentiment} sentimentKey={t.sentimentKey} />
      </span>
    );
  if (t.kind === "other") return <span className="muted">Other{t.mergedFrom ? ` (${t.mergedFrom})` : ""}</span>;
  if (t.kind === "no_specific_topic") return <span className="muted">No specific topic</span>;
  return <span className="muted">—</span>;
}
