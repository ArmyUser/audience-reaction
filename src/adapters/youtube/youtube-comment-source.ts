import { CommentSourceError, type CommentSourceFailure } from "../../core/analysis/comment-source-error";
import type { CommentInput } from "../../core/domain/types";
import type { CommentSource } from "../../core/ports";

// YouTube Data API v3 behind the CommentSource port (official access only, spec.md FR-S2). Top-level comments of one
// video through commentThreads.list (order=relevance, plain text, 100 per request), up to a fixed cap; replies are
// never requested. Only the comment ID and its text are kept: no author, channel or engagement fields.
//
// The API requires the key as the `key` query parameter, so the request URL holds a secret: it is never logged,
// never put in an error, and every string that could contain it goes through redactYouTubeKey first. Errors carry a
// provider-neutral reason and the HTTP status only, never upstream text.

export const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_PAGE_SIZE = 100;
export const DEFAULT_YOUTUBE_MAX_COMMENTS = 500;
export const DEFAULT_YOUTUBE_TIMEOUT_MS = 15_000;
/** Safety bound on requests per video, independent of the cap. */
export const MAX_YOUTUBE_PAGES = 50;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeCommentSourceOptions {
  apiKey: string;
  /** Top-level comments to collect at most (testing cap). */
  maxComments?: number;
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Replaces the key, and any `key=` query value, in a string that may contain a request URL. */
export function redactYouTubeKey(text: string, apiKey: string): string {
  const withoutParam = text.replace(/([?&]key=)[^&#\s"']*/gi, "$1[REDACTED]");
  return apiKey.length > 0 ? withoutParam.split(apiKey).join("[REDACTED]") : withoutParam;
}

const KEY_REASONS = new Set(["keyinvalid", "keyexpired", "api_key_invalid", "api_key_expired"]);
const CONFIGURATION_REASONS = new Set([
  "accessnotconfigured",
  "service_disabled",
  "iprefererblocked",
  "api_key_service_blocked",
  "api_key_http_referrer_blocked",
  "api_key_ip_address_blocked",
  "api_key_android_app_blocked",
  "api_key_ios_app_blocked",
]);
const QUOTA_REASONS = new Set(["quotaexceeded", "dailylimitexceeded", "ratelimitexceeded", "userratelimitexceeded", "rate_limit_exceeded", "resource_exhausted"]);
const UNAVAILABLE_REASONS = new Set(["forbidden", "commentthreadnotfound", "channelnotfound", "operationnotsupported"]);

/** Maps an API error response to a failure reason, from the structured reason codes only. */
export function youTubeFailureOf(status: number, body: unknown): CommentSourceFailure {
  const reasons = errorReasonsOf(body);
  if (reasons.includes("commentsdisabled")) return "comments_disabled";
  if (reasons.includes("videonotfound")) return "video_not_found";
  if (reasons.some((r) => KEY_REASONS.has(r))) return "invalid_api_key";
  if (reasons.some((r) => QUOTA_REASONS.has(r)) || status === 429) return "quota_exceeded";
  if (reasons.some((r) => CONFIGURATION_REASONS.has(r))) return "source_configuration";
  if (reasons.some((r) => UNAVAILABLE_REASONS.has(r))) return "video_unavailable";
  if (status === 404) return "video_not_found";
  return "unexpected_response";
}

/** `error.errors[].reason` (v3 style) and `error.details[].reason` (google.rpc.ErrorInfo), lower case. */
function errorReasonsOf(body: unknown): string[] {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (!error) return [];
  const lists = [error.errors, error.details].filter(Array.isArray) as unknown[][];
  return lists.flatMap((list) => list.flatMap((item) => (isRecord(item) && typeof item.reason === "string" ? [item.reason.toLowerCase()] : [])));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class YouTubeCommentSource implements CommentSource {
  readonly label: string;
  readonly origin = "youtube" as const;
  readonly maxComments: number;
  /** ECMAScript private: never enumerable, so serialising or logging the source cannot expose it. */
  readonly #apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: YouTubeCommentSourceOptions) {
    if (options.apiKey.trim().length === 0) throw new CommentSourceError("invalid_api_key");
    this.#apiKey = options.apiKey;
    this.maxComments = options.maxComments ?? DEFAULT_YOUTUBE_MAX_COMMENTS;
    if (!Number.isInteger(this.maxComments) || this.maxComments < 1) throw new RangeError("maxComments must be a positive integer");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_YOUTUBE_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? YOUTUBE_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.label = `YouTube Data API v3 (top-level comments, relevance order, up to ${this.maxComments})`;
  }

  /** Request URL for one page. Holds the key: never log or return it without redactYouTubeKey. */
  requestUrl(videoId: string, pageToken?: string): string {
    const params = new URLSearchParams({
      part: "snippet",
      videoId,
      order: "relevance",
      maxResults: String(YOUTUBE_PAGE_SIZE),
      textFormat: "plainText",
    });
    if (pageToken) params.set("pageToken", pageToken);
    params.set("key", this.#apiKey);
    return `${this.baseUrl}/commentThreads?${params.toString()}`;
  }

  /**
   * Pages through the video's top-level comments until the cap is reached, no `nextPageToken` remains, or a page
   * holds no usable comment. Comments without text are skipped; repeated IDs are kept once.
   */
  async listComments(videoId: string): Promise<CommentInput[]> {
    if (!VIDEO_ID.test(videoId)) throw new CommentSourceError("video_not_found");
    const comments: CommentInput[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_YOUTUBE_PAGES && comments.length < this.maxComments; page++) {
      const body = await this.fetchPage(videoId, pageToken);
      const items = isRecord(body) && Array.isArray(body.items) ? body.items : undefined;
      if (!items) throw new CommentSourceError("unexpected_response");
      let usable = 0;
      for (const item of items) {
        const comment = commentOf(item);
        if (!comment || seen.has(comment.id)) continue;
        seen.add(comment.id);
        usable += 1;
        comments.push(comment);
        if (comments.length >= this.maxComments) break;
      }
      const next = isRecord(body) && typeof body.nextPageToken === "string" && body.nextPageToken.length > 0 ? body.nextPageToken : undefined;
      if (usable === 0 || !next) break;
      pageToken = next;
    }
    return comments;
  }

  private async fetchPage(videoId: string, pageToken: string | undefined): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.requestUrl(videoId, pageToken), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The thrown error may quote the URL; nothing from it is kept.
      const name = error instanceof Error ? error.name : "";
      throw new CommentSourceError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CommentSourceError(response.ok ? "unexpected_response" : youTubeFailureOf(response.status, undefined), response.status);
    }
    if (!response.ok) throw new CommentSourceError(youTubeFailureOf(response.status, body), response.status);
    return body;
  }
}

/** `{ id, text }` of one commentThread resource, or undefined when it has no usable top-level comment text. */
function commentOf(item: unknown): CommentInput | undefined {
  if (!isRecord(item) || !isRecord(item.snippet)) return undefined;
  const top = item.snippet.topLevelComment;
  if (!isRecord(top) || !isRecord(top.snippet)) return undefined;
  const id = typeof top.id === "string" && top.id.length > 0 ? top.id : typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  const text = top.snippet.textDisplay;
  if (id === undefined || typeof text !== "string" || text.trim().length === 0) return undefined;
  return { id, text };
}
