// Provider-neutral failures of a CommentSource (spec.md F5/FR-S2). Adapters map their transport's errors to one of
// these reasons. The message is built from the reason only: an adapter must never pass through upstream text,
// request URLs or credentials.

export const COMMENT_SOURCE_FAILURES = [
  "comments_disabled",
  "video_not_found",
  "video_unavailable",
  "invalid_api_key",
  "source_configuration",
  "quota_exceeded",
  "timeout",
  "network",
  "unexpected_response",
] as const;

export type CommentSourceFailure = (typeof COMMENT_SOURCE_FAILURES)[number];

export class CommentSourceError extends Error {
  override readonly name = "CommentSourceError";
  constructor(
    readonly reason: CommentSourceFailure,
    /** HTTP status of the failed request, when there was one. */
    readonly status?: number,
  ) {
    super(`Comments could not be retrieved: ${reason}${status !== undefined ? ` (HTTP ${status})` : ""}`);
  }
}
