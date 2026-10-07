import { describe, expect, it, vi } from "vitest";
import { CommentSourceError, type CommentSourceFailure } from "../../src/core/analysis/comment-source-error";
import { parseYouTubeUrl } from "../../src/core/analysis/youtube-url";
import { redactYouTubeKey, YouTubeCommentSource, youTubeFailureOf } from "../../src/adapters/youtube/youtube-comment-source";

// Offline only: every request goes to a fake fetch. No YouTube call is made.

const KEY = "AIzaTEST-fake-youtube-key-0123456789";
const VIDEO = "dQw4w9WgXcQ";

function thread(id: string, text: unknown, extra: Record<string, unknown> = {}) {
  return {
    kind: "youtube#commentThread",
    id: `thread-${id}`,
    snippet: {
      videoId: VIDEO,
      topLevelComment: { id, snippet: { textDisplay: text, authorDisplayName: "Some Author", authorChannelId: { value: "UC123" }, likeCount: 7, ...extra } },
      totalReplyCount: 3,
    },
  };
}

function page(ids: string[], nextPageToken?: string) {
  return { kind: "youtube#commentThreadListResponse", items: ids.map((id) => thread(id, `comment ${id}`)), ...(nextPageToken ? { nextPageToken } : {}) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(status: number, reason: string, detailsReason?: string) {
  return {
    error: {
      code: status,
      message: `Something went wrong with key=${KEY}`,
      errors: [{ message: "upstream message", domain: "youtube.commentThread", reason }],
      ...(detailsReason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: detailsReason }] } : {}),
    },
  };
}

/** A fake fetch serving the given pages in order and recording each request URL. */
function pagedFetch(pages: unknown[]) {
  const urls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    const body = pages[urls.length - 1];
    if (body === undefined) throw new Error("unexpected extra request");
    return json(body);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls, calls: () => fetchImpl.mock.calls.length };
}

const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => `c${from + i}`);

function expectNoSecret(error: unknown): void {
  const e = error as Error;
  for (const text of [e.message, String(e), e.stack ?? "", JSON.stringify(e), JSON.stringify(Object.entries(e))]) {
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("key=");
  }
}

async function failureOf(promise: Promise<unknown>): Promise<CommentSourceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CommentSourceError);
    expectNoSecret(error);
    return error as CommentSourceError;
  }
  throw new Error("expected a CommentSourceError");
}

describe("YouTube URL → video ID → request", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", VIDEO],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123", VIDEO],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", VIDEO],
    ["https://m.youtube.com/shorts/aBcDeFgHiJk", "aBcDeFgHiJk"],
    ["www.youtube.com/live/A_b-C_d-E_f", "A_b-C_d-E_f"],
  ])("%s requests comments of video %s", async (url, expected) => {
    const parsed = parseYouTubeUrl(url);
    if (!parsed.ok) throw new Error("expected a video ID");
    expect(parsed.videoId).toBe(expected);
    const { fetchImpl, urls } = pagedFetch([page(["c1"])]);
    await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(parsed.videoId);
    expect(urls[0]!.searchParams.get("videoId")).toBe(expected);
  });

  it.each(["https://www.youtube.com/@channel", "https://www.youtube.com/playlist?list=PL123", "https://example.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/short"])(
    "%s is rejected before any source call",
    (url) => {
      expect(parseYouTubeUrl(url).ok).toBe(false);
    },
  );

  it("refuses a malformed video ID without a request", async () => {
    const { fetchImpl, calls } = pagedFetch([]);
    const error = await failureOf(new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments("not-an-id&key=x"));
    expect(error.reason).toBe("video_not_found");
    expect(calls()).toBe(0);
  });
});

describe("YouTubeCommentSource requests", () => {
  it("uses commentThreads.list with relevance order, plain text, 100 per page and the key as query parameter", async () => {
    const { fetchImpl, urls } = pagedFetch([page(["c1"])]);
    await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO);
    const url = urls[0]!;
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/commentThreads");
    expect(Object.fromEntries(url.searchParams)).toEqual({ part: "snippet", videoId: VIDEO, order: "relevance", maxResults: "100", textFormat: "plainText", key: KEY });
  });

  it("never asks for replies", async () => {
    const { fetchImpl, urls } = pagedFetch([page(["c1"])]);
    await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO);
    expect(urls[0]!.searchParams.get("part")).toBe("snippet");
    expect(urls[0]!.pathname.endsWith("/commentThreads")).toBe(true);
    expect(urls[0]!.searchParams.has("parentId")).toBe(false);
  });

  it("sends the key only in the URL, not in a header", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json(page(["c1"])));
    await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl as unknown as typeof fetch }).listComments(VIDEO);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(JSON.stringify(init.headers)).not.toContain(KEY);
    expect(init.method).toBe("GET");
  });
});

describe("YouTubeCommentSource pagination and cap", () => {
  it("follows nextPageToken until it is absent", async () => {
    const { fetchImpl, urls } = pagedFetch([page(ids(1, 100), "T2"), page(ids(101, 100), "T3"), page(ids(201, 40))]);
    const comments = await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO);
    expect(comments).toHaveLength(240);
    expect(urls.map((u) => u.searchParams.get("pageToken"))).toEqual([null, "T2", "T3"]);
    expect(comments[0]).toEqual({ id: "c1", text: "comment c1" });
    expect(comments.at(-1)).toEqual({ id: "c240", text: "comment c240" });
  });

  it("stops at the 500-comment cap: five requests, exactly 500 comments", async () => {
    const pages = Array.from({ length: 8 }, (_, i) => page(ids(i * 100 + 1, 100), `T${i + 2}`));
    const { fetchImpl, calls } = pagedFetch(pages);
    const source = new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl });
    expect(source.maxComments).toBe(500);
    const comments = await source.listComments(VIDEO);
    expect(comments).toHaveLength(500);
    expect(calls()).toBe(5);
    expect(comments.at(-1)!.id).toBe("c500");
  });

  it("truncates within a page when the cap falls inside it", async () => {
    const { fetchImpl, calls } = pagedFetch([page(ids(1, 100), "T2"), page(ids(101, 100), "T3")]);
    const comments = await new YouTubeCommentSource({ apiKey: KEY, maxComments: 150, fetch: fetchImpl }).listComments(VIDEO);
    expect(comments).toHaveLength(150);
    expect(calls()).toBe(2);
  });

  it("stops when a page has no usable comments, even with a nextPageToken", async () => {
    const empty = { items: [thread("x1", ""), thread("x2", "   "), { id: "broken" }], nextPageToken: "T3" };
    const { fetchImpl, calls } = pagedFetch([page(ids(1, 3), "T2"), empty, page(ids(10, 5))]);
    const comments = await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO);
    expect(comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(calls()).toBe(2);
  });

  it("returns no comments for a video without comments", async () => {
    const { fetchImpl } = pagedFetch([{ items: [] }]);
    expect(await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO)).toEqual([]);
  });

  it("keeps only ID and text (no author, channel or engagement fields), skips blank text and repeated IDs", async () => {
    const body = { items: [thread("a", "first"), thread("b", ""), thread("a", "duplicate"), thread("c", 42), thread("d", "second")] };
    const { fetchImpl } = pagedFetch([body]);
    const comments = await new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO);
    expect(comments).toEqual([
      { id: "a", text: "first" },
      { id: "d", text: "second" },
    ]);
  });

  it("treats a 200 response without items as unexpected", async () => {
    const { fetchImpl } = pagedFetch([{ kind: "something else" }]);
    expect((await failureOf(new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO))).reason).toBe("unexpected_response");
  });
});

describe("YouTubeCommentSource errors", () => {
  const cases: [string, number, unknown, CommentSourceFailure][] = [
    ["comments disabled", 403, apiError(403, "commentsDisabled"), "comments_disabled"],
    ["video not found", 404, apiError(404, "videoNotFound"), "video_not_found"],
    ["private or forbidden video", 403, apiError(403, "forbidden"), "video_unavailable"],
    ["invalid API key (v3 reason)", 400, apiError(400, "keyInvalid"), "invalid_api_key"],
    ["invalid API key (ErrorInfo reason)", 400, apiError(400, "badRequest", "API_KEY_INVALID"), "invalid_api_key"],
    ["expired API key", 400, apiError(400, "badRequest", "API_KEY_EXPIRED"), "invalid_api_key"],
    ["daily quota exceeded", 403, apiError(403, "quotaExceeded"), "quota_exceeded"],
    ["rate limit", 403, apiError(403, "rateLimitExceeded"), "quota_exceeded"],
    ["HTTP 429", 429, { error: { code: 429 } }, "quota_exceeded"],
    ["API not enabled", 403, apiError(403, "accessNotConfigured", "SERVICE_DISABLED"), "source_configuration"],
    ["key restricted", 403, apiError(403, "forbidden", "API_KEY_HTTP_REFERRER_BLOCKED"), "source_configuration"],
    ["unknown server error", 500, apiError(500, "backendError"), "unexpected_response"],
  ];

  it.each(cases)("%s → %s", async (_name, status, body, reason) => {
    const fetchImpl = vi.fn(async () => json(body, status)) as unknown as typeof fetch;
    const error = await failureOf(new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO));
    expect(error.reason).toBe(reason);
    expect(error.status).toBe(status);
  });

  it("maps a non-JSON error body by status only", async () => {
    const fetchImpl = vi.fn(async () => new Response(`<html>error for key=${KEY}</html>`, { status: 404 })) as unknown as typeof fetch;
    expect((await failureOf(new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO))).reason).toBe("video_not_found");
  });

  it("times out a request that does not answer", async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    const error = await failureOf(new YouTubeCommentSource({ apiKey: KEY, timeoutMs: 20, fetch: fetchImpl }).listComments(VIDEO));
    expect(error.reason).toBe("timeout");
  });

  it("reports a network failure without the request URL the transport quoted", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      throw new TypeError(`fetch failed for ${String(input)}`);
    }) as unknown as typeof fetch;
    const error = await failureOf(new YouTubeCommentSource({ apiKey: KEY, fetch: fetchImpl }).listComments(VIDEO));
    expect(error.reason).toBe("network");
    expect(error.status).toBeUndefined();
  });

  it("rejects an empty key before any request", () => {
    expect(() => new YouTubeCommentSource({ apiKey: "  " })).toThrow(CommentSourceError);
  });
});

describe("API key redaction", () => {
  it("redacts the key query parameter and the literal key", () => {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&key=${KEY}&videoId=${VIDEO}`;
    const redacted = redactYouTubeKey(`GET ${url} failed; key was ${KEY}`, KEY);
    expect(redacted).not.toContain(KEY);
    expect(redacted).toContain("key=[REDACTED]&videoId=");
    expect(redactYouTubeKey(`?KEY=other-secret#x`, KEY)).toBe("?KEY=[REDACTED]#x");
  });

  it("the source's label and public fields never contain the key", () => {
    const source = new YouTubeCommentSource({ apiKey: KEY });
    expect(source.label).not.toContain(KEY);
    expect(JSON.stringify(source)).not.toContain(KEY);
  });

  it("maps failures from structured reason codes only, never from messages", () => {
    expect(youTubeFailureOf(400, { error: { message: "commentsDisabled videoNotFound quotaExceeded" } })).toBe("unexpected_response");
  });
});
