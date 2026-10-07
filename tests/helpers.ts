import { GoldLabelClassifier } from "../src/adapters/fakes/gold-label-classifier";
import { SyntheticCommentSource } from "../src/adapters/fixtures/synthetic-comment-source";
import type { ReportViewModel } from "../src/application/analyze-video-sync";
import { keyFindings, reportOverview } from "../src/application/report-insights";
import type { AnalysisDeps } from "../src/core/analysis/run-analysis";
import type { CommentInput, FocusTarget, SourceOrigin } from "../src/core/domain/types";
import { createCompliancePolicy } from "../src/core/policy/compliance-policy";
import type { Classifier, CommentSource } from "../src/core/ports";
import dataset from "../fixtures/m2/comments.json";

export const FIXTURE = dataset;
export const FOCUS: FocusTarget = { name: dataset.focus.name, aliases: [...dataset.focus.aliases], isVideoSponsor: dataset.focus.isVideoSponsor };
export const VIDEO_ID = "dQw4w9WgXcQ";
export const VALID_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

export function goldClassifier(): GoldLabelClassifier {
  return new GoldLabelClassifier(dataset.comments);
}

export function sourceOf(comments: CommentInput[], origin: SourceOrigin = "synthetic_fixture"): CommentSource {
  return { label: "test source", origin, listComments: async () => comments };
}

export function rawClassifier(raw: unknown): Classifier {
  return { label: "raw test classifier", classify: async () => raw };
}

/** Synthetic source + gold labels + strict policy, with test-friendly parameters unless overridden. */
export function goldDeps(overrides: Partial<AnalysisDeps> = {}): AnalysisDeps {
  return {
    source: new SyntheticCommentSource(),
    classifier: goldClassifier(),
    policy: createCompliancePolicy(),
    ...overrides,
  };
}

export function comment(id: string): CommentInput {
  const found = dataset.comments.find((c) => c.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return { id: found.id, text: found.text };
}

/** Props for rendering <Report> in tests, with the overview and findings computed as the page computes them. */
export function reportProps(report: ReportViewModel) {
  return { report, insights: { overview: reportOverview(report), findings: keyFindings(report) } };
}
