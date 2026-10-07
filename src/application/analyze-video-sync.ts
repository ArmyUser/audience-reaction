import type { AnalysisWarning, TargetMetrics } from "../core/aggregation/aggregate";
import { CommentSourceError, type CommentSourceFailure } from "../core/analysis/comment-source-error";
import type { Distribution, Share } from "../core/aggregation/distribution";
import { parseYouTubeUrl, type UrlRejectionReason } from "../core/analysis/youtube-url";
import { ClassificationFailedError, runAnalysis, type AnalysisDeps, type AnalysisOutcome } from "../core/analysis/run-analysis";
import { CostLimitReachedError, type CostLimit } from "../core/cost/budget";
import type { ClassifiedComment, CommentType, FocusTarget, SentimentLabel, Target, TargetLabel } from "../core/domain/types";
import { PolicyBlockedError } from "../core/policy/compliance-policy";
import type { TopicDiscoverer } from "../core/ports";
import type { ReportModel, TopicsSection } from "../core/reporting/report-model";
import { DEFAULT_TOPIC_PARAMETERS, type CommentTopicLabel } from "../core/topics/aggregate-topics";
import { TOPIC_NORMALIZATION_VERSION } from "../core/topics/normalize";
import { toTopicsSection } from "../core/topics/topics-section";
import type { TopicParameters, TopicWarning } from "../core/topics/types";
import { analyzeTopics } from "./analyze-topics";

// Plain-data view models: safe to pass to UI components, contain no infrastructure objects.

export interface ShareView {
  count: number;
  base: number;
  percent: number;
}
export interface DistributionView {
  base: number;
  /** `key` is the stable label (e.g. `positive`) for colour encoding and filters; `label` is the display name. */
  rows: { key: string; label: string; count: number; percent: number }[];
}
export interface TargetView {
  key: Target;
  label: string;
  mentions: ShareView;
  sentiment: DistributionView;
  /** False when the sample is small: show counts only (spec.md §8.6). */
  showPercentages: boolean;
  focusReferences?: { explicit: number; inferred: number };
}
export interface SectionPlaceholderView {
  status: "not_run" | "unavailable";
  message: string;
}
export interface TopicView {
  id: string;
  name: string;
  description?: string;
  /** Comments with this primary topic; base = topic base (non-spam analysed comments). */
  count: ShareView;
  /** Sentiment toward the topic (not overall comment sentiment); base = the topic's comments. */
  topicSentiment: DistributionView;
  /** False when the topic is a small sample: show counts only. */
  showPercentages: boolean;
  evidenceCommentIds: string[];
  /** Representative comments selected by deterministic rules (IDs and labels; text stays with the comment rows). */
  evidence: EvidenceView[];
}
export interface EvidenceView {
  commentId: string;
  rank: number;
  /** Sentiment toward the topic (display name and stable key). */
  sentiment: string;
  sentimentKey: string;
  /** The topic model offered this comment as an example. */
  providerExample: boolean;
}
export interface AvailableTopicsView {
  status: "available";
  /** Non-spam analysed comments: the denominator of every topic share. */
  topicBase: number;
  minTopicSize: number;
  topics: TopicView[];
  /** One OTHER share; `providerOther` + `smallTopics` explain where it comes from. */
  other: {
    count: ShareView;
    providerOther: ShareView;
    smallTopics: ShareView;
    /** Topic sentiment of the small-topic comments only. */
    smallTopicSentiment: DistributionView;
    showPercentages: boolean;
    mergedTopicNames: string[];
  };
  noSpecificTopic: ShareView;
  providerLabel: string;
  /** Methodology of the discovery sample (spec §8.3), when the discoverer samples. */
  discoverySample?: { size: number; eligible: number; usedAll: boolean; strategy: string; version: string; seed: string };
}
export type TopicsView = SectionPlaceholderView | AvailableTopicsView;

export interface CommentRowView {
  id: string;
  text: string;
  type: string;
  typeKey: string;
  isQuestion: boolean;
  isRequest: boolean;
  sentiment: string;
  sentimentKey: string;
  targets: { label: string; value: string }[];
  /** The comment's topic disposition (synthetic data only); `none` when spam or topics did not run. */
  topic: CommentTopicView;
}
export type CommentTopicView =
  | { kind: "topic"; topicId: string; name: string; sentiment: string; sentimentKey: string }
  | { kind: "other"; mergedFrom?: string }
  | { kind: "no_specific_topic" }
  | { kind: "none" };

export interface ReportViewModel {
  videoId: string;
  focus?: FocusTarget;
  sourceLabel: string;
  classifierLabel: string;
  isSyntheticData: boolean;
  commentsRetrieved: number;
  classificationFailures: number;
  consistencyIssues: number;
  commentsAnalysed: number;
  spamExcluded: number;
  sentimentBase: number;
  overallSentiment: DistributionView;
  commentTypes: DistributionView;
  questions: ShareView;
  requests: ShareView;
  targets: TargetView[];
  topics: TopicsView;
  evidence: SectionPlaceholderView;
  synthesis: SectionPlaceholderView;
  warnings: { code: string; message: string }[];
  methodology: {
    schemaVersion: string;
    guidelineVersion: string;
    sentimentLabels: string[];
    mixedCandidateEnabled: boolean;
    sourceOrigin: string;
    sampling: string;
    representativenessNote: string;
    policyNote: string;
  };
  /** Per-comment rows; only for synthetic fixtures (real source text follows the evidence lifecycle instead). */
  comments?: CommentRowView[];
}

/** Topic analysis is optional: without a discoverer the topics section stays `not_run`. */
export interface AnalyzeVideoDeps extends AnalysisDeps {
  topics?: { discoverer: TopicDiscoverer; params?: Partial<TopicParameters> };
  /**
   * Per-analysis hard cap on AI-provider spend. The guarded providers stop calling once it is reached; the analysis
   * then ends as `cost_limit_reached`, never as a partial or degraded report.
   */
  costLimit?: CostLimit;
}

export interface AnalyzeVideoInput {
  url: string;
  focus?: FocusTarget;
}

export type AnalyzeVideoResult =
  | { status: "ok"; report: ReportViewModel }
  | { status: "invalid_url"; reason: UrlRejectionReason; message: string }
  | { status: "blocked_by_policy"; message: string }
  | { status: "analysis_failed"; failed: number; total: number; message: string }
  | { status: "insufficient_data"; sentimentBase: number; minimum: number; message: string }
  | { status: "source_unavailable"; reason: CommentSourceFailure; message: string }
  | { status: "cost_limit_reached"; limitUsd: number; spentUsd: number; message: string }
  | { status: "not_configured"; message: string };

export const URL_MESSAGES: Record<UrlRejectionReason, string> = {
  URL_INVALID: "This isn't a valid YouTube video link.",
  URL_UNSUPPORTED: "Paste a link to a single YouTube video (not a channel, playlist or search page).",
};

const SOURCE_MESSAGES: Record<CommentSourceFailure, string> = {
  comments_disabled: "Comments are turned off for this video.",
  video_not_found: "This video could not be found.",
  video_unavailable: "This video is private or otherwise unavailable.",
  invalid_api_key: "The server's YouTube API key was rejected. Check the local server configuration.",
  source_configuration: "The YouTube Data API is not set up correctly for this server (for example, the API is not enabled or the key is restricted).",
  quota_exceeded: "The YouTube API quota is used up. Try again later.",
  timeout: "YouTube did not respond in time. Try again.",
  network: "YouTube could not be reached. Check the connection and try again.",
  unexpected_response: "YouTube returned an unexpected response. No report was produced.",
};

const SENTIMENT_NAMES: Record<SentimentLabel, string> = { positive: "Positive", neutral: "Neutral", negative: "Negative", mixed: "Mixed" };
const TARGET_LABEL_NAMES: Record<TargetLabel, string> = { ...SENTIMENT_NAMES, not_addressed: "—" };
const TYPE_NAMES: Record<CommentType, string> = {
  opinion: "Opinion",
  question: "Question",
  request: "Request",
  joke_reaction: "Joke / reaction",
  spam_irrelevant: "Spam / irrelevant",
  other: "Other",
};

/**
 * T1/M2 use case: synchronous analysis for a syntactically valid YouTube URL. Policy, provider and schema options
 * come only from the server-side deps; nothing in the request input can change them.
 */
export async function analyzeVideoSync(input: AnalyzeVideoInput, deps: AnalyzeVideoDeps): Promise<AnalyzeVideoResult> {
  const parsed = parseYouTubeUrl(input.url);
  if (!parsed.ok) return { status: "invalid_url", reason: parsed.reason, message: URL_MESSAGES[parsed.reason] };

  try {
    const outcome = await runAnalysis({ videoId: parsed.videoId, ...(input.focus ? { focus: input.focus } : {}) }, deps);
    if (deps.costLimit?.reached()) return costLimitResult(deps.costLimit);
    if (outcome.status === "insufficient_data") {
      const minimum = deps.params?.minAnalyzableForReport ?? 50;
      return {
        status: "insufficient_data",
        sentimentBase: outcome.metrics.sentimentBase,
        minimum,
        message: `Only ${outcome.metrics.sentimentBase} comments could be analysed; at least ${minimum} are needed for a report.`,
      };
    }
    const topics = await topicsSectionFor(outcome, deps);
    const report: ReportModel = { ...outcome.report, topics: topics.section };
    // Topic failures are absorbed into an unavailable section; a stop caused by the cost cap must not be.
    if (deps.costLimit?.reached()) return costLimitResult(deps.costLimit);
    return { status: "ok", report: toViewModel(report, outcome.classified, topics.commentTopics) };
  } catch (error) {
    if (error instanceof CostLimitReachedError || deps.costLimit?.reached()) return costLimitResult(deps.costLimit, error);
    if (error instanceof CommentSourceError) return { status: "source_unavailable", reason: error.reason, message: SOURCE_MESSAGES[error.reason] };
    if (error instanceof PolicyBlockedError) return { status: "blocked_by_policy", message: deps.policy.describeYouTubeGate() };
    if (error instanceof ClassificationFailedError) {
      const failed = error.result.failures.length;
      return {
        status: "analysis_failed",
        failed,
        total: error.total,
        message: `Classification failed for ${failed} of ${error.total} comments, above the allowed limit. No report was produced.`,
      };
    }
    throw error;
  }
}

function costLimitResult(limit: CostLimit | undefined, error?: unknown): AnalyzeVideoResult {
  const limitUsd = limit?.limitUsd ?? (error instanceof CostLimitReachedError ? error.limitUsd : 0);
  const spentUsd = limit?.spentUsd() ?? (error instanceof CostLimitReachedError ? error.spentUsd : 0);
  return {
    status: "cost_limit_reached",
    limitUsd,
    spentUsd,
    message: `Analysis cost limit reached ($${limitUsd.toFixed(2)} per analysis): the analysis was stopped and no report was produced.`,
  };
}

/**
 * Classification → topics. A topic failure of any kind yields an unavailable topics section; classification,
 * sentiment and every other metric are kept (partial report rather than total failure, spec.md §7.8).
 */
async function topicsSectionFor(
  outcome: Extract<AnalysisOutcome, { status: "completed" }>,
  deps: AnalyzeVideoDeps,
): Promise<{ section: TopicsSection; commentTopics: readonly CommentTopicLabel[] }> {
  if (!deps.topics) return { section: { status: "not_run" }, commentTopics: [] };
  const focus = outcome.report.focus;
  try {
    const analysis = await analyzeTopics({ classified: outcome.classified, schema: outcome.schema, ...(focus ? { focus } : {}) }, deps.topics);
    // Per-comment labels go to the view model only (never into the report model).
    return { section: toTopicsSection(analysis), commentTopics: analysis.status === "available" ? analysis.commentTopics : [] };
  } catch {
    return {
      commentTopics: [],
      section: {
      status: "unavailable",
      reason: "TOPICS_UNAVAILABLE",
      issues: [{ attempt: 1, code: "internal_error", count: 1 }],
      method: {
        providerLabel: deps.topics.discoverer.label,
        normalizationVersion: TOPIC_NORMALIZATION_VERSION,
        commentsSent: 0,
        attempts: 0,
        parameters: { ...DEFAULT_TOPIC_PARAMETERS, ...deps.topics.params },
      },
      },
    };
  }
}

function toViewModel(report: ReportModel, classified: ClassifiedComment[], commentTopics: readonly CommentTopicLabel[]): ReportViewModel {
  const m = report.metrics;
  const isSyntheticData = report.methodology.sourceOrigin === "synthetic_fixture";
  return {
    videoId: report.videoId,
    ...(report.focus ? { focus: report.focus } : {}),
    sourceLabel: report.methodology.sourceLabel,
    classifierLabel: report.methodology.classifierLabel,
    isSyntheticData,
    commentsRetrieved: m.commentsRetrieved,
    classificationFailures: m.classificationFailures,
    consistencyIssues: m.consistencyIssues,
    commentsAnalysed: m.commentsAnalysed,
    spamExcluded: m.spamExcluded,
    sentimentBase: m.sentimentBase,
    overallSentiment: distributionView(m.overallSentiment, SENTIMENT_NAMES),
    commentTypes: distributionView(m.commentTypes, TYPE_NAMES),
    questions: shareView(m.questions),
    requests: shareView(m.requests),
    targets: m.targets.map((t) => targetView(t, report.focus)),
    topics: topicsView(report.topics),
    evidence: { status: "not_run", message: "Representative evidence is not available in this version." },
    synthesis: { status: "not_run", message: "The written summary is not available in this version." },
    warnings: [...m.warnings.map((w) => ({ code: w.code, message: warningMessage(w, report.focus) })), ...topicWarnings(report.topics)],
    methodology: {
      schemaVersion: report.methodology.schemaVersion,
      guidelineVersion: report.methodology.guidelineVersion,
      sentimentLabels: report.methodology.sentimentLabels.map((l) => SENTIMENT_NAMES[l]),
      mixedCandidateEnabled: report.methodology.mixedCandidateEnabled,
      sourceOrigin: report.methodology.sourceOrigin,
      sampling: report.methodology.sampling,
      representativenessNote: report.methodology.representativenessNote,
      policyNote: report.methodology.policyNote,
    },
    ...(isSyntheticData ? { comments: commentRows(classified, report.focus, report.topics, commentTopics) } : {}),
  };
}

function distributionView<L extends string>(d: Distribution<L>, names: Record<L, string>): DistributionView {
  return { base: d.base, rows: d.rows.map((r) => ({ key: r.label, label: names[r.label], count: r.count, percent: r.percent })) };
}

const TOPICS_UNAVAILABLE_MESSAGE = "Topics could not be determined for this analysis. All other figures are unaffected.";

function topicsView(section: TopicsSection): TopicsView {
  if (section.status === "not_run") return { status: "not_run", message: "Topic discovery is not available in this version." };
  if (section.status === "unavailable") return { status: "unavailable", message: TOPICS_UNAVAILABLE_MESSAGE };
  const small = section.method.parameters.smallSampleThreshold;
  return {
    status: "available",
    topicBase: section.coverage.sentimentBase,
    minTopicSize: section.minTopicSize,
    topics: section.topics.map((t) => ({
      id: t.id,
      name: displayTopicName(t.name),
      ...(t.description !== undefined ? { description: t.description } : {}),
      count: shareView(t.count),
      topicSentiment: distributionView(t.topicSentiment, SENTIMENT_NAMES),
      showPercentages: !t.smallSample,
      evidenceCommentIds: t.evidence.map((e) => e.commentId),
      evidence: t.evidence.map((e) => ({
        commentId: e.commentId,
        rank: e.rank,
        sentiment: SENTIMENT_NAMES[e.topicSentiment],
        sentimentKey: e.topicSentiment,
        providerExample: e.providerExample,
      })),
    })),
    other: {
      count: shareView(section.other.count),
      providerOther: shareView(section.other.providerOther),
      smallTopics: shareView(section.other.smallTopics),
      smallTopicSentiment: distributionView(section.other.smallTopicSentiment, SENTIMENT_NAMES),
      showPercentages: section.other.smallTopics.count >= small,
      mergedTopicNames: section.other.mergedTopics.map((t) => displayTopicName(t.name)),
    },
    noSpecificTopic: shareView(section.noSpecificTopic),
    providerLabel: section.method.providerLabel,
    ...(section.method.discoverySample
      ? {
          discoverySample: {
            size: section.method.discoverySample.size,
            eligible: section.method.discoverySample.eligible,
            usedAll: section.method.discoverySample.usedAll,
            strategy: section.method.discoverySample.strategy,
            version: section.method.discoverySample.version,
            seed: section.method.discoverySample.seed,
          },
        }
      : {}),
  };
}

/** Normalised names are lower case; show them in sentence case. */
function displayTopicName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function topicWarnings(section: TopicsSection): { code: string; message: string }[] {
  if (section.status === "unavailable") return [{ code: "TOPICS_UNAVAILABLE", message: TOPICS_UNAVAILABLE_MESSAGE }];
  if (section.status !== "available") return [];
  return section.warnings.map((w) => ({ code: w.code, message: topicWarningMessage(w) }));
}

function topicWarningMessage(w: TopicWarning): string {
  return (
    `Many comments did not fit the main topics (other ${w.other.percent}%, no specific topic ${w.noSpecificTopic.percent}%, ` +
    `combined ${w.combined.percent}% of ${w.combined.base}); topic findings may be incomplete.`
  );
}

function shareView(s: Share): ShareView {
  return { count: s.count, base: s.base, percent: s.percent };
}

function targetName(target: Target, focus: FocusTarget | undefined): string {
  if (target === "focus") return `Focus: ${focus?.name ?? "brand/product"}`;
  return target === "creator" ? "Creator" : "Content";
}

function targetView(t: TargetMetrics, focus: FocusTarget | undefined): TargetView {
  return {
    key: t.target,
    label: targetName(t.target, focus),
    mentions: shareView(t.mentions),
    sentiment: distributionView(t.sentiment, SENTIMENT_NAMES),
    showPercentages: !t.smallSample,
    ...(t.focusReferences ? { focusReferences: t.focusReferences } : {}),
  };
}

function warningMessage(w: AnalysisWarning, focus: FocusTarget | undefined): string {
  switch (w.code) {
    case "INSUFFICIENT_DATA":
      return "Too few comments could be analysed for a reliable report.";
    case "LOW_VOLUME":
      return "Low comment volume: treat these figures as indicative only.";
    case "TARGET_SMALL_SAMPLE":
      return `Few comments address ${w.target ? targetName(w.target, focus) : "this target"}: counts are shown without percentages.`;
    case "CLASSIFICATION_FAILURES":
      return "Some comments could not be classified after retries; they are excluded from all figures.";
    case "CONSISTENCY_ISSUES":
      return "Some classifications have a comment type that disagrees with their question/request flag; they are kept as returned.";
  }
}

function commentRows(classified: readonly ClassifiedComment[], focus: FocusTarget | undefined, topics: TopicsSection, labels: readonly CommentTopicLabel[]): CommentRowView[] {
  const byComment = new Map(labels.map((l) => [l.commentId, l]));
  const names = new Map<string, string>();
  if (topics.status === "available") {
    for (const t of topics.topics) names.set(t.id, displayTopicName(t.name));
    for (const t of topics.other.mergedTopics) names.set(t.id, displayTopicName(t.name));
  }
  return classified.map((c) => commentRow(c, focus, topicView(byComment.get(c.comment.id), names)));
}

function topicView(label: CommentTopicLabel | undefined, names: ReadonlyMap<string, string>): CommentTopicView {
  if (!label) return { kind: "none" };
  if (label.disposition === "no_specific_topic") return { kind: "no_specific_topic" };
  if (label.disposition === "other") {
    const merged = label.mergedFromTopicId !== undefined ? names.get(label.mergedFromTopicId) : undefined;
    return merged !== undefined ? { kind: "other", mergedFrom: merged } : { kind: "other" };
  }
  return { kind: "topic", topicId: label.topicId, name: names.get(label.topicId) ?? label.topicId, sentiment: SENTIMENT_NAMES[label.topicSentiment], sentimentKey: label.topicSentiment };
}

function commentRow(c: ClassifiedComment, focus: FocusTarget | undefined, topic: CommentTopicView): CommentRowView {
  const targets = (Object.keys(c.classification.targets) as Target[]).map((t) => ({
    label: targetName(t, focus),
    value: TARGET_LABEL_NAMES[c.classification.targets[t]!] + (t === "focus" && c.focusMention && c.focusMention !== "none" ? ` (${c.focusMention})` : ""),
  }));
  return {
    id: c.comment.id,
    text: c.comment.text,
    type: TYPE_NAMES[c.classification.type],
    typeKey: c.classification.type,
    isQuestion: c.classification.isQuestion,
    isRequest: c.classification.isRequest,
    sentiment: SENTIMENT_NAMES[c.classification.sentiment],
    sentimentKey: c.classification.sentiment,
    targets,
    topic,
  };
}
