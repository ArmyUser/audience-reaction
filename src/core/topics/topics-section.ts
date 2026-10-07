import { share } from "../aggregation/distribution";
import type { TopicIssueCount, TopicsSection } from "../reporting/report-model";
import { compareIds } from "./validation";
import type { TopicAnalysis, TopicIssue } from "./types";

/**
 * Report section from a topic analysis. Keeps only long-lived, provider-neutral data: normalised names, counts,
 * distributions, comment-ID evidence and method. Provider-supplied raw names (`formation`), issue details and
 * provider keys stay out of the report. An available section never has a rejected bucket and must satisfy AC-23.
 */
export function toTopicsSection(analysis: TopicAnalysis): TopicsSection {
  if (analysis.status === "unavailable") {
    return { status: "unavailable", reason: "TOPICS_UNAVAILABLE", issues: issueCounts(analysis.issues), method: analysis.method };
  }
  const base = analysis.coverage.sentimentBase;
  const { namedTopics, other, noSpecificTopic } = analysis.coverage;
  if (namedTopics.count + other.count + noSpecificTopic.count !== base || analysis.topics.reduce((sum, t) => sum + t.mentionCount, 0) !== namedTopics.count) {
    throw new RangeError("An available topic analysis must satisfy AC-23");
  }
  return {
    status: "available",
    topics: analysis.topics.map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      count: share(t.mentionCount, base),
      topicSentiment: t.topicSentiment,
      smallSample: t.smallSample,
      evidence: t.evidence,
    })),
    other: {
      count: analysis.coverage.other,
      providerOther: share(analysis.other.providerOther, base),
      smallTopics: share(analysis.other.smallTopics, base),
      smallTopicSentiment: analysis.other.smallTopicSentiment,
      mergedTopics: analysis.other.mergedTopics,
    },
    noSpecificTopic,
    coverage: analysis.coverage,
    minTopicSize: analysis.minTopicSize,
    warnings: analysis.warnings,
    method: analysis.method,
  };
}

/** Counts per (attempt, code), ordered by attempt then code. */
function issueCounts(issues: readonly TopicIssue[]): TopicIssueCount[] {
  const counts = new Map<string, TopicIssueCount>();
  for (const i of issues) {
    const attempt = i.attempt ?? 1;
    const key = `${attempt}\u0000${i.code}`;
    const entry = counts.get(key) ?? { attempt, code: i.code, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => a.attempt - b.attempt || compareIds(a.code, b.code));
}
