import type { CommentInput } from "../../core/domain/types";
import type { CommentSource } from "../../core/ports";
import dataset from "../../../fixtures/m2/comments.json";

/**
 * Returns the same synthetic comment set for any video ID. No network access, no YouTube data.
 */
export class SyntheticCommentSource implements CommentSource {
  readonly label = "Synthetic fixture (m2)";
  readonly origin = "synthetic_fixture" as const;

  async listComments(_videoId: string): Promise<CommentInput[]> {
    return dataset.comments.map((c) => ({ id: c.id, text: c.text }));
  }
}
