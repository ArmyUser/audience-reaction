"use client";

import { useMemo, useState } from "react";
import type { AvailableTopicsView, ReportViewModel, TargetView, TopicView } from "../application/analyze-video-sync";
import type { Finding, ReportOverview } from "../application/report-insights";
import type { AnalysisRunInfo } from "../application/run-info";
import { INITIAL_UI, type ReportUiState } from "./analysis-store";
import { CommentPreview } from "./CommentExplorer";
import { formatDuration, SectionHeader, SentimentBadge, SentimentBar, SentimentLegend, ShareBar, signed, StateMessage } from "./primitives";

// The customer-facing report. It renders a view model only and never computes metrics: the overview and findings
// arrive precomputed (application/report-insights.ts). Order follows the analytical questions: what happened → what
// people talk about → which topics are positive or negative → strongest insights → evidence → individual comments.
// Interaction (topic drill-down, comment filters) is browser state only: nothing re-runs the analysis. The state is
// local, or held by the caller (`ui`/`onUiChange`) so it survives navigation with the report. All text,
// including comment text, is rendered as React text nodes, which are escaped; never as HTML.

export interface ReportInsights {
  overview: ReportOverview;
  findings: Finding[];
}

export interface ReportProps {
  report: ReportViewModel;
  insights: ReportInsights;
  run?: AnalysisRunInfo;
  /** The report was produced by the real AI pipeline on a synthetic fixture dataset (default: from `run`). */
  fixture?: { dataset: string; comments: number };
  /** The analysis this report belongs to (registry id and configuration fingerprint), for diagnostics. */
  analysisMeta?: { id: string; configVersion: string };
  /** Interaction state held by the caller; local state when absent. */
  ui?: ReportUiState;
  onUiChange?: (patch: Partial<ReportUiState>) => void;
}

export function Report({ report, insights, run, fixture: fixtureProp, analysisMeta, ui: uiProp, onUiChange }: ReportProps) {
  const topics = report.topics.status === "available" ? report.topics : null;
  const [localUi, setLocalUi] = useState<ReportUiState>(INITIAL_UI);
  const ui = uiProp ?? localUi;
  const update = (patch: Partial<ReportUiState>) => (onUiChange ? onUiChange(patch) : setLocalUi((u) => ({ ...u, ...patch })));
  const fixture = fixtureProp ?? (run?.input.kind === "fixture" ? { dataset: run.input.dataset, comments: run.input.comments } : undefined);
  const selectedTopicId = ui.selectedTopicId ?? topics?.topics[0]?.id ?? null;
  // Evidence text exists only where the comments themselves are shown (synthetic data).
  const textOf = useMemo(() => new Map((report.comments ?? []).map((c) => [c.id, c.text])), [report.comments]);
  const filters = { topic: ui.explorerTopic, sentiment: ui.explorerSentiment, type: ui.explorerType, query: ui.explorerQuery };

  const selectTopic = (id: string) => {
    update({ selectedTopicId: id });
    // Side by side on wide screens: scroll only when the detail is below the table.
    const detail = document.getElementById("topic-detail");
    if (detail && detail.getBoundingClientRect().top > window.innerHeight * 0.6) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const showInExplorer = (id: string) => update({ explorerTopic: id, explorerSentiment: "all", explorerType: "all", explorerQuery: "", explorerOpen: true });

  return (
    <article className="report" aria-labelledby="report-title">
      <ReportHeader report={report} run={run} fixture={fixture} />
      <Overview overview={insights.overview} report={report} />
      {report.warnings.length > 0 && (
        <StateMessage tone="warning" title="Read these figures with care">
          <ul className="plain-list">
            {report.warnings.map((w) => (
              <li key={w.code + w.message}>
                <span className="code">{w.code}</span> {w.message}
              </li>
            ))}
          </ul>
        </StateMessage>
      )}
      <Findings findings={insights.findings} onTopic={selectTopic} />
      <div className={topics && topics.topics.length > 0 ? "topics-layout" : undefined}>
        <TopicIntelligence report={report} selectedTopicId={selectedTopicId} onSelect={selectTopic} />
        {topics && <TopicDetail topics={topics} topicId={selectedTopicId} textOf={textOf} onShowComments={report.comments ? showInExplorer : undefined} />}
      </div>
      <SentimentOverview report={report} />
      {report.comments && (
        <CommentPreview
          comments={report.comments}
          topics={topics}
          filters={filters}
          onFilters={(f) => update({ ...(f.topic !== undefined ? { explorerTopic: f.topic } : {}), ...(f.sentiment !== undefined ? { explorerSentiment: f.sentiment } : {}), ...(f.type !== undefined ? { explorerType: f.type } : {}), ...(f.query !== undefined ? { explorerQuery: f.query } : {}) })}
          open={ui.explorerOpen}
          onOpen={(open) => update({ explorerOpen: open })}
        />
      )}
      {!report.comments && !report.isSyntheticData && (
        <StateMessage tone="neutral" title="Comment text is not shown for this data source" role="note">
          <p>Real YouTube comments are analysed in memory for this report only. Their text is not displayed, exported or stored.</p>
        </StateMessage>
      )}
      <Methodology report={report} topics={topics} />
      {run && <RunDiagnostics run={run} {...(analysisMeta ? { meta: analysisMeta } : {})} />}
    </article>
  );
}

// ---------- 1. header ----------

function ReportHeader({ report, run, fixture }: { report: ReportViewModel; run?: AnalysisRunInfo; fixture?: ReportProps["fixture"] }) {
  return (
    <header className="report-header">
      <SourceBanner report={report} fixture={fixture} />
      <div className="report-title-row">
        <div>
          <p className="eyebrow">Audience intelligence</p>
          <h1 id="report-title">Audience reaction report</h1>
        </div>
        {run && <span className={`mode-pill mode-${run.mode === "demo" ? "demo" : run.input.kind}`}>{run.mode === "demo" ? "Demo · fake classifier" : run.input.kind === "fixture" ? "Real AI · fixture data" : "Real AI · YouTube"}</span>}
      </div>
      <dl className="meta-row">
        <div>
          <dt>Source</dt>
          <dd>
            {fixture ? (
              <>
                Synthetic fixture dataset <strong>{fixture.dataset}</strong> (test data; not a YouTube video)
              </>
            ) : report.isSyntheticData ? (
              <>Demo dataset (synthetic comments; not a YouTube video)</>
            ) : (
              <>
                YouTube video ID: <code>{report.videoId}</code>
              </>
            )}
          </dd>
        </div>
        {report.focus && (
          <div>
            <dt>Focus</dt>
            <dd>Focus: {report.focus.name}</dd>
          </div>
        )}
        <div>
          <dt>Comments analysed</dt>
          <dd>
            {report.commentsAnalysed} of {report.commentsRetrieved} retrieved
          </dd>
        </div>
        {run && (
          <div>
            <dt>Analysis time</dt>
            <dd>{formatDuration(run.durationMs)}</dd>
          </div>
        )}
      </dl>
    </header>
  );
}

/** The one statement of where the data came from and how it was analysed. */
function SourceBanner({ report, fixture }: { report: ReportViewModel; fixture?: ReportProps["fixture"] }) {
  if (fixture) {
    return (
      <div className="data-banner data-fixture" role="note">
        <strong>REAL AI · FIXTURE DATA · NO YOUTUBE COMMENTS ANALYZED</strong>
        <span>
          Dataset <code>{fixture.dataset}</code> ({fixture.comments} synthetic comments) · {report.classifierLabel}
        </span>
      </div>
    );
  }
  if (report.isSyntheticData) {
    return (
      <div className="data-banner data-demo" role="note">
        <strong>DEMO · SYNTHETIC DATA</strong>
        <span>
          {report.sourceLabel} · {report.classifierLabel}. No YouTube or AI calls were made.
        </span>
      </div>
    );
  }
  return (
    <div className="data-banner data-real" role="note">
      <strong>REAL YOUTUBE COMMENTS · INTERNAL TEST ONLY</strong>
      <span>
        {report.sourceLabel} · {report.classifierLabel}. Experimental local prototype; comment text is not stored. Do not share these results.
      </span>
    </div>
  );
}

// ---------- 2. executive overview ----------

function Overview({ overview, report }: { overview: ReportOverview; report: ReportViewModel }) {
  const net = overview.netSentiment;
  return (
    <section className="overview" aria-label="Overview">
      <div className="stat">
        <p className="stat-label">Comments analysed</p>
        <p className="stat-value">{overview.commentsAnalysed}</p>
        <p className="stat-note">
          {report.spamExcluded} spam excluded · {overview.sentimentBase} in sentiment base
        </p>
      </div>
      <div className="stat stat-wide">
        <p className="stat-label">Net sentiment</p>
        <p className={`stat-value ${net > 0 ? "tone-pos" : net < 0 ? "tone-neg" : ""}`}>{signed(net)}</p>
        <SentimentBar distribution={report.overallSentiment} size="sm" label="Overall sentiment" />
        <p className="stat-note">positive minus negative, in points</p>
      </div>
      <div className="stat">
        <p className="stat-label">Topics</p>
        <p className="stat-value">{overview.topicCount ?? "—"}</p>
        <p className="stat-note">{overview.topicCount === null ? "not available" : "recurring discussion topics"}</p>
      </div>
      <TopicStat label="Most positive topic" highlight={overview.strongestPositive} sentiment="positive" />
      <TopicStat label="Most negative topic" highlight={overview.strongestNegative} sentiment="negative" />
    </section>
  );
}

function TopicStat({ label, highlight, sentiment }: { label: string; highlight: ReportOverview["strongestPositive"]; sentiment: "positive" | "negative" }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className={`stat-topic ${sentiment === "positive" ? "tone-pos" : "tone-neg"}`}>{highlight ? highlight.name : "—"}</p>
      <p className="stat-note">
        {highlight ? `${highlight.count} ${sentiment} comments${highlight.showPercentages ? ` · ${highlight.percentOfTopic}% of topic` : ""}` : `no ${sentiment} topic`}
      </p>
    </div>
  );
}

// ---------- 3. key findings ----------

const METRIC_TARGETS: Record<string, string> = { sentiment: "sentiment", topics: "topics", questions_requests: "sentiment", other: "topics" };

function Findings({ findings, onTopic }: { findings: Finding[]; onTopic: (id: string) => void }) {
  if (findings.length === 0) return null;
  return (
    <section className="section" aria-labelledby="findings-title">
      <SectionHeader id="findings-title" eyebrow="Key findings" title="What stands out" description="Computed from the metrics in this report by fixed rules — not AI-generated text." />
      <ol className="findings">
        {findings.map((f) => (
          <li key={f.text}>
            <span>{f.text}</span>
            {f.ref.kind === "topic" ? (
              <button type="button" className="link-button" onClick={() => onTopic((f.ref as { topicId: string }).topicId)}>
                View topic →
              </button>
            ) : (
              <a className="link-button" href={`#${METRIC_TARGETS[f.ref.metric]}`}>
                See data →
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- 4–5. topic intelligence: ranked topics × sentiment ----------

function TopicIntelligence({ report, selectedTopicId, onSelect }: { report: ReportViewModel; selectedTopicId: string | null; onSelect: (id: string) => void }) {
  const section = report.topics;
  return (
    <section className="section" aria-labelledby="topics" id="topics-section">
      <SectionHeader
        id="topics"
        eyebrow="Topics"
        title="What people are talking about"
        description={section.status === "available" ? `Ranked by volume; bars show sentiment toward each topic (base: ${section.topicBase} non-spam comments; one primary topic per comment).` : undefined}
        aside={section.status === "available" && section.topics.length > 0 ? <SentimentLegend /> : undefined}
      />
      {section.status !== "available" && (
        <StateMessage tone="neutral" title={section.status === "unavailable" ? "Topics could not be determined" : "Topics were not analysed"} role="note">
          <p>{section.message}</p>
        </StateMessage>
      )}
      {section.status === "available" && section.topics.length === 0 && (
        <StateMessage tone="neutral" title="No recurring topics found" role="note">
          <p>No topic reached the minimum of {section.minTopicSize} comments. All comments are counted under Other or No specific topic below.</p>
        </StateMessage>
      )}
      {section.status === "available" && section.topics.length > 0 && <TopicMatrix section={section} selectedTopicId={selectedTopicId} onSelect={onSelect} />}
    </section>
  );
}

function TopicMatrix({ section, selectedTopicId, onSelect }: { section: AvailableTopicsView; selectedTopicId: string | null; onSelect: (id: string) => void }) {
  const maxShare = Math.max(1, ...section.topics.map((t) => t.count.percent));
  return (
    <div className="table-wrap">
      <table className="matrix">
        <caption className="sr-only">Topics ranked by volume, with sentiment toward each topic</caption>
        <thead>
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">Share of comments</th>
            <th scope="col">Sentiment toward topic</th>
          </tr>
        </thead>
        <tbody>
          {section.topics.map((t, i) => (
            <tr key={t.id} className={`matrix-topic ${t.id === selectedTopicId ? "is-selected" : ""}`} onClick={() => onSelect(t.id)}>
              <th scope="row">
                <button type="button" className="topic-button" aria-pressed={t.id === selectedTopicId} onClick={(e) => (e.stopPropagation(), onSelect(t.id))}>
                  <span className="rank">{i + 1}</span>
                  {t.name}
                </button>
              </th>
              <td className="topic-share">
                <ShareBar percent={(t.count.percent / maxShare) * 100} />
                <span className="num">
                  {t.count.count} <span className="muted">· {t.count.percent}%</span>
                </span>
              </td>
              <td className="topic-sent">
                <SentimentBar distribution={t.topicSentiment} showPercentages={t.showPercentages} label={t.name} />
                {t.showPercentages && <SentimentNumbers topic={t} />}
              </td>
            </tr>
          ))}
          <tr className="matrix-muted">
            <th scope="row">
              Other
              <span className="muted small">
                {" "}
                · substantive comments that fit no topic: {section.other.providerOther.count}; in topics under {section.minTopicSize} comments: {section.other.smallTopics.count}
                {section.other.mergedTopicNames.length > 0 && ` (merged: ${section.other.mergedTopicNames.join(", ")})`}
              </span>
            </th>
            <td className="topic-share">
              <span className="num">
                {section.other.count.count} <span className="muted">· {section.other.count.percent}%</span>
              </span>
            </td>
            <td className="muted small">No topic sentiment</td>
          </tr>
          <tr className="matrix-muted">
            <th scope="row">
              No specific topic (generic comments)
            </th>
            <td className="topic-share">
              <span className="num">
                {section.noSpecificTopic.count} <span className="muted">· {section.noSpecificTopic.percent}%</span>
              </span>
            </td>
            <td className="muted small">No topic sentiment</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SentimentNumbers({ topic }: { topic: TopicView }) {
  const get = (k: string) => topic.topicSentiment.rows.find((r) => r.key === k)?.percent ?? 0;
  return (
    <span className="sent-nums">
      <span className="tone-pos">{get("positive")}%</span>
      <span className="muted">{get("neutral")}%</span>
      <span className="tone-neg">{get("negative")}%</span>
    </span>
  );
}

// ---------- drill-down: topic → sentiment → evidence ----------

function TopicDetail({ topics, topicId, textOf, onShowComments }: { topics: AvailableTopicsView; topicId: string | null; textOf: ReadonlyMap<string, string>; onShowComments?: (id: string) => void }) {
  const topic = topics.topics.find((t) => t.id === topicId);
  if (!topic) return null;
  const groups = ["negative", "neutral", "mixed", "positive"]
    .map((key) => ({ key, items: topic.evidence.filter((e) => e.sentimentKey === key) }))
    .filter((g) => g.items.length > 0);
  return (
    <section className="section topic-detail" id="topic-detail" aria-labelledby="topic-detail-title">
      <SectionHeader id="topic-detail-title" eyebrow="Topic detail" title={topic.name} description={topic.description} />
      <div className="detail-grid">
        <div className="detail-figures">
          <p className="stat-label">Volume</p>
          <p className="stat-value">{topic.count.count}</p>
          <p className="stat-note">
            {topic.count.percent}% of {topic.count.base} comments
          </p>
          <p className="stat-label spaced">Sentiment toward this topic</p>
          <SentimentBar distribution={topic.topicSentiment} showPercentages={topic.showPercentages} size="lg" label={topic.name} />
          <ul className="sent-table">
            {topic.topicSentiment.rows.map((r) => (
              <li key={r.key}>
                <SentimentBadge sentiment={r.label} sentimentKey={r.key} />
                <span className="num">
                  {r.count}
                  {topic.showPercentages && <span className="muted"> · {r.percent}%</span>}
                </span>
              </li>
            ))}
          </ul>
          {!topic.showPercentages && <p className="base">Small sample: percentages are not shown.</p>}
          {onShowComments && (
            <button type="button" className="button button-secondary" onClick={() => onShowComments(topic.id)}>
              Show all {topic.count.count} comments in this topic
            </button>
          )}
        </div>
        <div className="evidence">
          <p className="evidence-title">Supporting comments</p>
          <p className="evidence-note">Verbatim source comments, selected by fixed rules from this topic&apos;s comments. These are evidence, not AI-written text.</p>
          {topic.evidence.length === 0 && <p className="muted">No representative comments were selected for this topic.</p>}
          {groups.map((g) => (
            <div key={g.key} className="evidence-group">
              {g.items.map((e) => (
                <blockquote key={e.commentId} className="quote">
                  {textOf.has(e.commentId) ? <p className="comment-text">{textOf.get(e.commentId)}</p> : <p className="muted">Comment text is not shown for this data source.</p>}
                  <footer>
                    <SentimentBadge sentiment={e.sentiment} sentimentKey={e.sentimentKey} />
                    <span className="muted small">
                      toward this topic · comment {e.commentId}
                      {e.providerExample ? " · offered as an example by the topic model" : ""}
                    </span>
                  </footer>
                </blockquote>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- 6. sentiment overview ----------

function SentimentOverview({ report }: { report: ReportViewModel }) {
  const typeMax = Math.max(1, ...report.commentTypes.rows.map((r) => r.percent));
  return (
    <section className="section" aria-labelledby="sentiment">
      <SectionHeader id="sentiment" eyebrow="Sentiment" title="Overall sentiment" description={`Sentiment of each comment as a whole, spam excluded (base: ${report.overallSentiment.base} comments).`} aside={<SentimentLegend />} />
      <div className="sentiment-hero">
        <SentimentBar distribution={report.overallSentiment} size="lg" label="Overall sentiment" />
        <ul className="sent-inline">
          {report.overallSentiment.rows.map((r) => (
            <li key={r.key}>
              <SentimentBadge sentiment={r.label} sentimentKey={r.key} />
              <span className="num">
                {r.percent}% <span className="muted">· {r.count}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <h3 className="subhead">Sentiment by target</h3>
      <div className="target-list">
        {report.targets.map((t) => (
          <TargetRow key={t.key} target={t} />
        ))}
      </div>

      <div className="two-col">
        <div>
          <h3 className="subhead">Comment types</h3>
          <ul className="type-list">
            {report.commentTypes.rows.map((r) => (
              <li key={r.key}>
                <span>{r.label}</span>
                <ShareBar percent={(r.percent / typeMax) * 100} />
                <span className="num">
                  {r.percent}% <span className="muted">· {r.count}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="subhead">Questions and requests</h3>
          <div className="mini-stats">
            <div>
              <p className="stat-value">{report.questions.percent}%</p>
              <p className="stat-note">
                ask a question · {report.questions.count} of {report.questions.base}
              </p>
            </div>
            <div>
              <p className="stat-value">{report.requests.percent}%</p>
              <p className="stat-note">
                make a request · {report.requests.count} of {report.requests.base}
              </p>
            </div>
          </div>
          <p className="base small">Flags over the sentiment base; independent of comment type.</p>
        </div>
      </div>
    </section>
  );
}

function TargetRow({ target }: { target: TargetView }) {
  return (
    <div className="target-row">
      <div>
        <p className="target-label">{target.label}</p>
        <p className="stat-note">
          addressed by {target.mentions.count} of {target.mentions.base} comments
          {target.focusReferences && ` · explicit ${target.focusReferences.explicit}, inferred ${target.focusReferences.inferred}`}
        </p>
      </div>
      <div className="target-bar">
        <SentimentBar distribution={target.sentiment} showPercentages={target.showPercentages} label={target.label} />
        {target.showPercentages ? (
          <span className="sent-nums">
            {target.sentiment.rows.map((r) => (
              <span key={r.key} className={r.key === "positive" ? "tone-pos" : r.key === "negative" ? "tone-neg" : "muted"}>
                {r.label} {r.percent}%
              </span>
            ))}
          </span>
        ) : (
          <p className="base small">Small sample: percentages are not shown.</p>
        )}
      </div>
    </div>
  );
}

// ---------- methodology and internal diagnostics ----------

function Methodology({ report, topics }: { report: ReportViewModel; topics: AvailableTopicsView | null }) {
  return (
    <section className="section methodology" aria-labelledby="methodology">
      <SectionHeader id="methodology" eyebrow="About this report" title="Methodology and data notes" />
      <p className="note">{report.methodology.representativenessNote}</p>
      <ul className="plain-list muted">
        <li>
          Comments retrieved: {report.commentsRetrieved} · analysed: {report.commentsAnalysed}
          {report.classificationFailures > 0 && ` · could not be classified (excluded): ${report.classificationFailures}`} · spam/irrelevant excluded from sentiment: {report.spamExcluded} · sentiment base:{" "}
          {report.sentimentBase}
          {report.consistencyIssues > 0 && ` · consistency issues: ${report.consistencyIssues}`}
        </li>
        <li>Sampling: {report.methodology.sampling}</li>
        <li>
          Schema {report.methodology.schemaVersion}, guideline {report.methodology.guidelineVersion}; sentiment labels: {report.methodology.sentimentLabels.join(", ")}
          {report.methodology.mixedCandidateEnabled ? " (mixed is a candidate label)" : ""}
        </li>
        {topics && (
          <li>
            Topics by {topics.providerLabel}. Minimum topic size: {topics.minTopicSize} comments.
            {topics.discoverySample &&
              ` Discovery sample: ${topics.discoverySample.size} of ${topics.discoverySample.eligible} non-spam comments${topics.discoverySample.usedAll ? " (all)" : ""}, ${topics.discoverySample.strategy.replace("_", " ")} (${topics.discoverySample.version}, seed ${topics.discoverySample.seed}).`}
          </li>
        )}
        {report.topics.status !== "available" && <li>{report.topics.message}</li>}
        <li>{report.evidence.message}</li>
        <li>{report.synthesis.message}</li>
        <li>Source origin: {report.methodology.sourceOrigin}</li>
        <li>{report.methodology.policyNote}</li>
      </ul>
    </section>
  );
}

function RunDiagnostics({ run, meta }: { run: AnalysisRunInfo; meta?: { id: string; configVersion: string } }) {
  return (
    <details className="diagnostics">
      <summary>Run diagnostics (internal)</summary>
      <p className="muted small">Technical details of this analysis run. Not part of the customer-facing report. Benchmark results of this pipeline are on the Evaluation page.</p>
      <ol className="pipeline">
        {run.pipeline.map((p) => (
          <li key={p.role}>
            <span className="pipeline-role">{p.role}</span>
            <span className="pipeline-component">{p.component}</span>
          </li>
        ))}
      </ol>
      <dl className="meta-row">
        {meta && (
          <div>
            <dt>Analysis</dt>
            <dd>
              <code>{meta.id.slice(0, 8)}</code> · config <code>{meta.configVersion}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(run.durationMs)}</dd>
        </div>
        {run.usage && (
          <>
            <div>
              <dt>AI requests</dt>
              <dd>
                {run.usage.requests}
                {run.usage.failedRequests > 0 && ` (${run.usage.failedRequests} failed)`} ·{" "}
                {Object.entries(run.usage.requestsByProvider)
                  .map(([p, n]) => `${p} ${n}`)
                  .join(", ")}
              </dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>
                ${run.usage.estimatedCostUsd.toFixed(4)} <span className="muted">of ${run.usage.costLimitUsd.toFixed(2)} cap</span>
              </dd>
            </div>
          </>
        )}
      </dl>
    </details>
  );
}
