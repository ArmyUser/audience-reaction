import type { CommentInput } from "../../core/domain/types";
import type { CommentSource } from "../../core/ports";
import m2 from "../../../fixtures/m2/comments.json";
import t1 from "../../../fixtures/t1-topics-v1/comments.json";

// Permitted development datasets as a CommentSource, for running the real AI pipeline on synthetic data (local
// testing only). Only the two development sets are imported here (m2 for the classifier, t1 for topics); the
// validation and hold-out sets (t2-topics-v1, t3-topics-v1, t4-topics-v1, t5-topics-v1, m2-heldout-v1) are
// deliberately not, so they can never be used to tune the analysis through the app.
// Only each comment's ID and text leave this module: gold labels, tags and taxonomies are never passed on.
// The video ID is ignored: the comments are always the dataset's, whatever URL was entered.

export const FIXTURE_DATASETS = {
  "m2-synthetic": m2.comments,
  "t1-topics-v1": t1.comments,
} as const;

export type FixtureDatasetId = keyof typeof FIXTURE_DATASETS;
export const DEFAULT_FIXTURE_DATASET: FixtureDatasetId = "t1-topics-v1";

export function isFixtureDatasetId(value: string): value is FixtureDatasetId {
  return Object.hasOwn(FIXTURE_DATASETS, value);
}

export class FixtureDatasetSource implements CommentSource {
  readonly label: string;
  readonly origin = "synthetic_fixture" as const;
  readonly size: number;

  constructor(readonly dataset: FixtureDatasetId) {
    this.size = FIXTURE_DATASETS[dataset].length;
    this.label = `Synthetic fixture dataset ${dataset} (${this.size} comments)`;
  }

  async listComments(_videoId: string): Promise<CommentInput[]> {
    return FIXTURE_DATASETS[this.dataset].map((c) => ({ id: c.id, text: c.text }));
  }
}
