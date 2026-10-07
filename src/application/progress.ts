import type {
  ClassificationRequest,
  Classifier,
  CommentSource,
  TopicAssigner,
  TopicAssignmentRequest,
  TopicDiscoverer,
  TopicDiscoveryRequest,
  TopicDiscoveryRunInfo,
  TopicModelTransport,
  TopicTaxonomyGenerator,
  TopicTaxonomyRequest,
} from "../core/ports";
import type { TopicModelRequest } from "../core/topics/provider-contracts";

// Stage-based progress for one analysis, for display only. Observers wrap the existing ports and report when a stage
// starts; they never change a request, a result or an error, so the analysis itself is unaffected. Progress is
// deterministic and coarse (which stage is running), never an estimated percentage.

export const ANALYSIS_STAGES = ["fetching", "classifying", "discovering", "consolidating", "assigning", "building"] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

export interface StageInfo {
  id: AnalysisStage;
  label: string;
}

export type AnalysisSourceKind = "demo" | "fixture" | "youtube";

const FETCH_LABEL: Record<AnalysisSourceKind, string> = {
  demo: "Loading demo comments",
  fixture: "Loading fixture comments",
  youtube: "Fetching YouTube comments",
};

/** The stages an analysis of this source goes through, in order. Demo mode has no topic stages. */
export function stagesFor(kind: AnalysisSourceKind): StageInfo[] {
  const fetch: StageInfo = { id: "fetching", label: FETCH_LABEL[kind] };
  const classify: StageInfo = { id: "classifying", label: "Classifying comments" };
  const build: StageInfo = { id: "building", label: "Building report" };
  if (kind === "demo") return [fetch, classify, build];
  return [
    fetch,
    classify,
    { id: "discovering", label: "Discovering topics" },
    { id: "consolidating", label: "Consolidating topics" },
    { id: "assigning", label: "Assigning comments to topics" },
    build,
  ];
}

/** Reports each stage once, in order; a stage that starts again (a retry) never moves progress backwards. */
export class ProgressTracker {
  private index = -1;

  constructor(
    private readonly stages: readonly StageInfo[],
    private readonly onStage: (stage: AnalysisStage) => void,
  ) {}

  advance(stage: AnalysisStage): void {
    const i = this.stages.findIndex((s) => s.id === stage);
    if (i <= this.index) return;
    this.index = i;
    this.onStage(stage);
  }
}

export class ProgressCommentSource implements CommentSource {
  constructor(
    private readonly inner: CommentSource,
    private readonly progress: ProgressTracker,
  ) {}

  get label() {
    return this.inner.label;
  }

  get origin() {
    return this.inner.origin;
  }

  listComments(videoId: string) {
    this.progress.advance("fetching");
    return this.inner.listComments(videoId);
  }
}

export class ProgressClassifier implements Classifier {
  constructor(
    private readonly inner: Classifier,
    private readonly progress: ProgressTracker,
    /** Stage reached once classification returns (demo mode: "building", as nothing else follows). */
    private readonly after?: AnalysisStage,
  ) {}

  get label() {
    return this.inner.label;
  }

  async classify(request: ClassificationRequest): Promise<unknown> {
    this.progress.advance("classifying");
    const result = await this.inner.classify(request);
    if (this.after) this.progress.advance(this.after);
    return result;
  }
}

export class ProgressTaxonomyGenerator implements TopicTaxonomyGenerator {
  constructor(
    private readonly inner: TopicTaxonomyGenerator,
    private readonly progress: ProgressTracker,
  ) {}

  get label() {
    return this.inner.label;
  }

  proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    this.progress.advance("discovering");
    return this.inner.proposeTaxonomy(request);
  }
}

/** For the consolidation transport only: its first call marks the consolidation stage. */
export class ProgressTopicTransport implements TopicModelTransport {
  constructor(
    private readonly inner: TopicModelTransport,
    private readonly progress: ProgressTracker,
    private readonly stage: AnalysisStage,
  ) {}

  get label() {
    return this.inner.label;
  }

  complete(request: TopicModelRequest): Promise<string> {
    this.progress.advance(this.stage);
    return this.inner.complete(request);
  }
}

export class ProgressTopicAssigner implements TopicAssigner {
  constructor(
    private readonly inner: TopicAssigner,
    private readonly progress: ProgressTracker,
  ) {}

  get label() {
    return this.inner.label;
  }

  assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    this.progress.advance("assigning");
    return this.inner.assignTopics(request);
  }
}

/** Marks "building" once topic analysis returns: only aggregation remains. */
export class ProgressTopicDiscoverer implements TopicDiscoverer {
  constructor(
    private readonly inner: TopicDiscoverer,
    private readonly progress: ProgressTracker,
  ) {}

  get label() {
    return this.inner.label;
  }

  async discoverTopics(request: TopicDiscoveryRequest): Promise<unknown> {
    const result = await this.inner.discoverTopics(request);
    this.progress.advance("building");
    return result;
  }

  finishRun(runId: string): TopicDiscoveryRunInfo | undefined {
    return this.inner.finishRun?.(runId);
  }
}
