import { MAX_YOUTUBE_PAGES, YOUTUBE_API_BASE_URL, YouTubeCommentSource } from "../adapters/youtube/youtube-comment-source";
import { CommentSourceError, type CommentSourceFailure } from "../core/analysis/comment-source-error";
import { parseYouTubeUrl, type UrlRejectionReason } from "../core/analysis/youtube-url";

// Fetch-only YouTube ingestion smoke test (manual; never part of the analysis report). It validates the official
// ingestion path on one public video: URL → video ID → commentThreads.list through the existing YouTubeCommentSource
// (relevance order, plain text, 100 per page, ≤ 500 top-level comments, no replies) → record checks → technical
// statistics. It performs NO derived analytics (no classification, sentiment, topics or any other metric about the
// comments), calls no AI provider and imports none, consults no compliance policy because it produces nothing CG-1
// governs, and persists nothing: the comments exist only inside fetchOnlySmoke and are dropped before it returns.
// The result holds counts and flags only, so printing it can never show comment text, authors, keys or URLs.

export const YOUTUBE_API_HOST = new URL(YOUTUBE_API_BASE_URL).hostname;

export type PaginationEnd = "no_next_page_token" | "cap_reached" | "page_without_usable_comments" | "page_limit";

export type FetchSmokeResult =
  | {
      status: "ok";
      videoId: string;
      pagesRequested: number;
      youtubeApiRequests: number;
      commentsFetched: number;
      maxComments: number;
      capReached: boolean;
      paginationEndedNaturally: boolean;
      paginationEnd: PaginationEnd;
      /** Record checks on what the source returned (expected: all valid, no duplicates). */
      records: { valid: number; invalid: number; duplicateIds: number };
      elapsedMs: number;
    }
  | { status: "invalid_url"; reason: UrlRejectionReason; youtubeApiRequests: 0; elapsedMs: number }
  | { status: "error"; videoId: string; error: CommentSourceFailure | "unexpected_error"; httpStatus?: number; pagesRequested: number; youtubeApiRequests: number; elapsedMs: number };

export interface FetchSmokeOptions {
  apiKey: string;
  fetch?: typeof fetch;
  maxComments?: number;
  now?: () => number;
}

export interface PageObservation {
  hasNextPageToken: boolean;
}

/**
 * Wraps fetch so that only the YouTube Data API host can be reached and each response's pagination state is observed
 * (from a clone; the source reads the original). Nothing about a request is logged or kept except these counts.
 */
export function youtubeOnlyFetch(inner: typeof fetch, pages: PageObservation[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== "https:" || url.hostname !== YOUTUBE_API_HOST) throw new Error("Blocked: the fetch-only smoke test may only call the YouTube Data API.");
    const response = await inner(input, init);
    let hasNextPageToken = false;
    try {
      const body: unknown = await response.clone().json();
      hasNextPageToken = typeof body === "object" && body !== null && typeof (body as { nextPageToken?: unknown }).nextPageToken === "string" && (body as { nextPageToken: string }).nextPageToken.length > 0;
    } catch {
      // Not JSON: the source classifies it.
    }
    pages.push({ hasNextPageToken });
    return response;
  };
}

export async function fetchOnlySmoke(url: string, options: FetchSmokeOptions): Promise<FetchSmokeResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const parsed = parseYouTubeUrl(url);
  if (!parsed.ok) return { status: "invalid_url", reason: parsed.reason, youtubeApiRequests: 0, elapsedMs: now() - started };

  const pages: PageObservation[] = [];
  const source = new YouTubeCommentSource({
    apiKey: options.apiKey,
    fetch: youtubeOnlyFetch(options.fetch ?? fetch, pages),
    ...(options.maxComments !== undefined ? { maxComments: options.maxComments } : {}),
  });

  let comments: { id: unknown; text: unknown }[] | undefined;
  try {
    comments = await source.listComments(parsed.videoId);
    const ids = new Set<string>();
    let valid = 0;
    let duplicateIds = 0;
    for (const c of comments) {
      const ok = typeof c.id === "string" && c.id.length > 0 && typeof c.text === "string" && c.text.trim().length > 0;
      if (ok && ids.has(c.id as string)) duplicateIds += 1;
      else if (ok) valid += 1;
      if (typeof c.id === "string") ids.add(c.id);
    }
    const fetched = comments.length;
    const capReached = fetched >= source.maxComments;
    const last = pages.at(-1);
    const paginationEnd: PaginationEnd = capReached ? "cap_reached" : last && !last.hasNextPageToken ? "no_next_page_token" : pages.length >= MAX_YOUTUBE_PAGES ? "page_limit" : "page_without_usable_comments";
    return {
      status: "ok",
      videoId: parsed.videoId,
      pagesRequested: pages.length,
      youtubeApiRequests: pages.length,
      commentsFetched: fetched,
      maxComments: source.maxComments,
      capReached,
      paginationEndedNaturally: paginationEnd === "no_next_page_token",
      paginationEnd,
      records: { valid, invalid: fetched - valid - duplicateIds, duplicateIds },
      elapsedMs: now() - started,
    };
  } catch (error) {
    return {
      status: "error",
      videoId: parsed.videoId,
      error: error instanceof CommentSourceError ? error.reason : "unexpected_error",
      ...(error instanceof CommentSourceError && error.status !== undefined ? { httpStatus: error.status } : {}),
      pagesRequested: pages.length,
      youtubeApiRequests: pages.length,
      elapsedMs: now() - started,
    };
  } finally {
    // Discard the fetched comments: nothing outlives this call.
    if (comments) comments.length = 0;
    comments = undefined;
  }
}

/** The printable report: built from the result's counts and flags only. */
export function formatFetchSmokeResult(r: FetchSmokeResult): string {
  if (r.status === "invalid_url") return [`status: invalid_url (${r.reason})`, "YouTube API requests: 0", `elapsed: ${r.elapsedMs} ms`].join("\n");
  if (r.status === "error") {
    return [
      `status: error`,
      `video ID: ${r.videoId}`,
      `error classification: ${r.error}${r.httpStatus !== undefined ? ` (HTTP ${r.httpStatus})` : ""}`,
      `pages requested: ${r.pagesRequested}`,
      `YouTube API requests: ${r.youtubeApiRequests}`,
      `elapsed: ${r.elapsedMs} ms`,
    ].join("\n");
  }
  return [
    `status: ok`,
    `video ID: ${r.videoId}`,
    `pages requested: ${r.pagesRequested}`,
    `comments fetched: ${r.commentsFetched} (cap ${r.maxComments})`,
    `cap reached: ${r.capReached ? "yes" : "no"}`,
    `pagination ended naturally: ${r.paginationEndedNaturally ? "yes" : "no"} (${r.paginationEnd})`,
    `records: ${r.records.valid} valid, ${r.records.invalid} invalid, ${r.records.duplicateIds} duplicate IDs`,
    `YouTube API requests: ${r.youtubeApiRequests}`,
    `elapsed: ${r.elapsedMs} ms`,
  ].join("\n");
}
