import type { AvailableTopicsView, ReportViewModel, ShareView, TopicView } from "./analyze-video-sync";

// Deterministic overview and key findings computed from the report's own metrics (no model call, no new data).
// Every finding cites the topic or metric it comes from, so the UI can link to it and label it as computed, never as
// AI-generated. Small samples are stated as counts, never as percentages (spec.md §8.6).

export interface TopicHighlight {
  topicId: string;
  name: string;
  /** Comments with this topic sentiment, and their share of the topic's comments. */
  count: number;
  percentOfTopic: number;
  showPercentages: boolean;
}

export interface ReportOverview {
  commentsRetrieved: number;
  commentsAnalysed: number;
  sentimentBase: number;
  /** Positive minus negative share of the sentiment base, in points (e.g. +24). */
  netSentiment: number;
  topicCount: number | null;
  strongestPositive: TopicHighlight | null;
  strongestNegative: TopicHighlight | null;
}

export type FindingRef = { kind: "topic"; topicId: string } | { kind: "metric"; metric: "sentiment" | "topics" | "questions_requests" | "other" };

export interface Finding {
  text: string;
  ref: FindingRef;
}

const MAX_FINDINGS = 5;

function rowOf(t: TopicView, key: string) {
  return t.topicSentiment.rows.find((r) => r.key === key);
}

/**
 * The topic with the most comments of the given topic sentiment; ties broken by that sentiment's share of the topic,
 * then by topic order (volume). Null when no topic has any such comment (spec.md §8: rank by count, tie-break share).
 */
export function strongestTopic(topics: readonly TopicView[], sentiment: "positive" | "negative"): TopicHighlight | null {
  let best: TopicHighlight | null = null;
  for (const t of topics) {
    const row = rowOf(t, sentiment);
    if (!row || row.count === 0) continue;
    if (!best || row.count > best.count || (row.count === best.count && row.percent > best.percentOfTopic)) {
      best = { topicId: t.id, name: t.name, count: row.count, percentOfTopic: row.percent, showPercentages: t.showPercentages };
    }
  }
  return best;
}

function share(row: { count: number; percent: number } | undefined): number {
  return row?.percent ?? 0;
}

export function reportOverview(report: ReportViewModel): ReportOverview {
  const rows = report.overallSentiment.rows;
  const topics = report.topics.status === "available" ? report.topics : null;
  return {
    commentsRetrieved: report.commentsRetrieved,
    commentsAnalysed: report.commentsAnalysed,
    sentimentBase: report.sentimentBase,
    netSentiment: share(rows.find((r) => r.key === "positive")) - share(rows.find((r) => r.key === "negative")),
    topicCount: topics ? topics.topics.length : null,
    strongestPositive: topics ? strongestTopic(topics.topics, "positive") : null,
    strongestNegative: topics ? strongestTopic(topics.topics, "negative") : null,
  };
}

function shareText(s: ShareView, show: boolean, noun: string): string {
  return show ? `${s.count} ${noun} (${s.percent}%)` : `${s.count} ${noun}`;
}

function sentimentSplit(t: TopicView): string {
  if (!t.showPercentages) return `${rowOf(t, "positive")?.count ?? 0} positive, ${rowOf(t, "negative")?.count ?? 0} negative`;
  return `${share(rowOf(t, "positive"))}% positive, ${share(rowOf(t, "negative"))}% negative`;
}

function highlightText(h: TopicHighlight, sentiment: string): string {
  return h.showPercentages ? `${h.count} ${sentiment} comments, ${h.percentOfTopic}% of the topic` : `${h.count} ${sentiment} comments`;
}

/** Up to five findings, most general first, each tied to the metric or topic it is computed from. */
export function keyFindings(report: ReportViewModel): Finding[] {
  const findings: Finding[] = [];
  const rows = report.overallSentiment.rows;
  const pos = rows.find((r) => r.key === "positive");
  const neg = rows.find((r) => r.key === "negative");
  if (report.sentimentBase > 0 && pos && neg) {
    const lead = pos.count > neg.count ? "Reaction is mostly positive" : neg.count > pos.count ? "Reaction leans negative" : "Positive and negative reactions are balanced";
    findings.push({
      text: `${lead}: ${pos.percent}% of analysed comments are positive and ${neg.percent}% negative (${report.sentimentBase} comments).`,
      ref: { kind: "metric", metric: "sentiment" },
    });
  }

  const topics: AvailableTopicsView | null = report.topics.status === "available" ? report.topics : null;
  if (topics && topics.topics.length > 0) {
    const top = topics.topics[0]!;
    const negative = strongestTopic(topics.topics, "negative");
    const positive = strongestTopic(topics.topics, "positive");
    // A topic that is both the most discussed and the strongest on one side gets one finding, not two.
    const also = negative?.topicId === top.id ? " It also draws the most negative reaction." : positive?.topicId === top.id ? " It also draws the most positive reaction." : "";
    findings.push({
      text: `${top.name} is the most discussed topic: ${shareText(top.count, top.showPercentages, "comments")} of the topic base; ${sentimentSplit(top)}.${also}`,
      ref: { kind: "topic", topicId: top.id },
    });
    if (negative && negative.topicId !== top.id) findings.push({ text: `${negative.name} draws the most negative reaction: ${highlightText(negative, "negative")}.`, ref: { kind: "topic", topicId: negative.topicId } });
    if (positive && positive.topicId !== top.id) findings.push({ text: `${positive.name} draws the most positive reaction: ${highlightText(positive, "positive")}.`, ref: { kind: "topic", topicId: positive.topicId } });
    const unassigned = topics.other.count.count + topics.noSpecificTopic.count;
    if (topics.topicBase > 0 && unassigned * 100 > 35 * topics.topicBase) {
      findings.push({
        text: `${unassigned} of ${topics.topicBase} comments fit none of the main topics (Other or no specific topic); topic findings may be incomplete.`,
        ref: { kind: "metric", metric: "other" },
      });
    }
  }

  if (report.sentimentBase > 0 && (report.questions.count > 0 || report.requests.count > 0)) {
    findings.push({
      text: `${report.questions.count} comments ask a question (${report.questions.percent}%) and ${report.requests.count} make a request (${report.requests.percent}%).`,
      ref: { kind: "metric", metric: "questions_requests" },
    });
  }
  return findings.slice(0, MAX_FINDINGS);
}
