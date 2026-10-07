import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchOnlySmoke, formatFetchSmokeResult, youtubeOnlyFetch } from "../../src/benchmark/youtube-fetch-smoke";
import { runFetchSmokeCli } from "../../src/benchmark/youtube-fetch-smoke-cli";

// Offline only: every request goes to a fake fetch serving fake YouTube responses. No live call is made.

const ROOT = resolve(__dirname, "../..");
const KEY = "AIzaSMOKE-fake-youtube-key-0123456789";
const URL_OK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const COMMENT_MARK = "PRIVATE-COMMENT-BODY";
const AUTHOR_MARK = "PRIVATE-AUTHOR-NAME";
const AUTHOR_ID_MARK = "UCprivateAuthorChannelId";

function page(from: number, count: number, nextPageToken?: string) {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      id: `thread-${from + i}`,
      snippet: {
        topLevelComment: {
          id: `c${from + i}`,
          snippet: { textDisplay: `${COMMENT_MARK} ${from + i}`, authorDisplayName: AUTHOR_MARK, authorChannelId: { value: AUTHOR_ID_MARK } },
        },
      },
    })),
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

function fakeYouTube(responses: { status?: number; body: unknown }[]) {
  const urls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    const next = responses[urls.length - 1];
    if (!next) throw new Error("unexpected extra request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

/** Everything a run could show: the result object and its printed form. */
function exposed(result: unknown): string {
  return `${JSON.stringify(result)}\n${formatFetchSmokeResult(result as never)}`;
}

function expectNothingPrivate(text: string): void {
  for (const forbidden of [COMMENT_MARK, AUTHOR_MARK, AUTHOR_ID_MARK, KEY, "key=", "googleapis.com", "https://"]) expect(text).not.toContain(forbidden);
}

describe("fetch-only smoke: successful ingestion", () => {
  it("follows pagination to a natural end and reports technical statistics only", async () => {
    const { fetchImpl, urls } = fakeYouTube([{ body: page(1, 100, "T2") }, { body: page(101, 100, "T3") }, { body: page(201, 37) }]);
    let t = 1000;
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl, now: () => (t += 50) });
    expect(result).toEqual({
      status: "ok",
      videoId: "dQw4w9WgXcQ",
      pagesRequested: 3,
      youtubeApiRequests: 3,
      commentsFetched: 237,
      maxComments: 500,
      capReached: false,
      paginationEndedNaturally: true,
      paginationEnd: "no_next_page_token",
      records: { valid: 237, invalid: 0, duplicateIds: 0 },
      elapsedMs: 50,
    });
    expect(urls.map((u) => u.searchParams.get("pageToken"))).toEqual([null, "T2", "T3"]);
    expectNothingPrivate(exposed(result));
  });

  it("uses commentThreads.list, relevance order, 100 per page, plain text and never asks for replies", async () => {
    const { fetchImpl, urls } = fakeYouTube([{ body: page(1, 3) }]);
    await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    const u = urls[0]!;
    expect(u.hostname + u.pathname).toBe("www.googleapis.com/youtube/v3/commentThreads");
    expect(Object.fromEntries(u.searchParams)).toEqual({ part: "snippet", videoId: "dQw4w9WgXcQ", order: "relevance", maxResults: "100", textFormat: "plainText", key: KEY });
  });

  it("stops at the 500-comment cap", async () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({ body: page(i * 100 + 1, 100, `T${i + 2}`) }));
    const { fetchImpl } = fakeYouTube(pages);
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "ok", commentsFetched: 500, pagesRequested: 5, capReached: true, paginationEndedNaturally: false, paginationEnd: "cap_reached" });
  });

  it("reports a stop at a page without usable comments as not natural", async () => {
    const { fetchImpl } = fakeYouTube([{ body: page(1, 2, "T2") }, { body: { items: [], nextPageToken: "T3" } }]);
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "ok", commentsFetched: 2, pagesRequested: 2, capReached: false, paginationEndedNaturally: false, paginationEnd: "page_without_usable_comments" });
  });

  it("handles a video with no comments", async () => {
    const { fetchImpl } = fakeYouTube([{ body: { items: [] } }]);
    expect(await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl })).toMatchObject({ status: "ok", commentsFetched: 0, paginationEndedNaturally: true });
  });
});

describe("fetch-only smoke: errors", () => {
  it("rejects a non-video URL without any request", async () => {
    const { fetchImpl } = fakeYouTube([]);
    const result = await fetchOnlySmoke("https://www.youtube.com/@somechannel", { apiKey: KEY, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "invalid_url", reason: "URL_UNSUPPORTED", youtubeApiRequests: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [403, "commentsDisabled", "comments_disabled"],
    [404, "videoNotFound", "video_not_found"],
    [403, "forbidden", "video_unavailable"],
    [400, "keyInvalid", "invalid_api_key"],
    [403, "quotaExceeded", "quota_exceeded"],
  ])("HTTP %i %s → structured error %s, key redacted", async (status, reason, expected) => {
    const body = { error: { code: status, message: `failed for key=${KEY}`, errors: [{ reason, message: `upstream ${KEY}` }] } };
    const { fetchImpl } = fakeYouTube([{ status, body }]);
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "error", error: expected, httpStatus: status, pagesRequested: 1, youtubeApiRequests: 1 });
    expectNothingPrivate(exposed(result));
  });

  it("classifies a mid-pagination failure and counts the requests made", async () => {
    const { fetchImpl } = fakeYouTube([{ body: page(1, 100, "T2") }, { status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } }]);
    expect(await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl })).toMatchObject({ status: "error", error: "quota_exceeded", pagesRequested: 2 });
  });

  it("classifies a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException(`timed out: ${URL_OK}&key=${KEY}`, "TimeoutError");
    }) as unknown as typeof fetch;
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "error", error: "timeout" });
    expectNothingPrivate(exposed(result));
  });

  it("classifies a network failure whose message quotes the request URL", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      throw new TypeError(`fetch failed: ${String(input)}`);
    }) as unknown as typeof fetch;
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "error", error: "network" });
    expectNothingPrivate(exposed(result));
  });
});

describe("fetch-only smoke: CLI", () => {
  it("prints technical statistics only and exits 0", async () => {
    const { fetchImpl } = fakeYouTube([{ body: page(1, 12) }]);
    const { exitCode, output } = await runFetchSmokeCli([URL_OK], { YOUTUBE_API_KEY: KEY }, fetchImpl);
    expect(exitCode).toBe(0);
    for (const line of ["video ID: dQw4w9WgXcQ", "pages requested: 1", "comments fetched: 12 (cap 500)", "cap reached: no", "pagination ended naturally: yes", "YouTube API requests: 1", "elapsed:"]) {
      expect(output).toContain(line);
    }
    expectNothingPrivate(output);
  });

  it("requires YOUTUBE_API_KEY and names it without any value", async () => {
    const { fetchImpl } = fakeYouTube([]);
    const { exitCode, output } = await runFetchSmokeCli([URL_OK], { ANTHROPIC_API_KEY: "sk-ant-secret-value", JEV_API_KEY: "jev-secret-value" }, fetchImpl);
    expect(exitCode).toBe(2);
    expect(output).toContain("YOUTUBE_API_KEY is not set");
    expect(output).not.toMatch(/secret-value/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires exactly one URL", async () => {
    expect((await runFetchSmokeCli([], { YOUTUBE_API_KEY: KEY })).exitCode).toBe(2);
    expect((await runFetchSmokeCli([URL_OK, URL_OK], { YOUTUBE_API_KEY: KEY })).exitCode).toBe(2);
  });

  it("exits 1 with the error classification on a failure", async () => {
    const { fetchImpl } = fakeYouTube([{ status: 403, body: { error: { errors: [{ reason: "commentsDisabled" }] } } }]);
    const { exitCode, output } = await runFetchSmokeCli([URL_OK], { YOUTUBE_API_KEY: KEY }, fetchImpl);
    expect(exitCode).toBe(1);
    expect(output).toContain("error classification: comments_disabled (HTTP 403)");
    expectNothingPrivate(output);
  });
});

describe("fetch-only smoke: isolation", () => {
  const sources = ["youtube-fetch-smoke.ts", "youtube-fetch-smoke-cli.ts"].map((f) => readFileSync(join(ROOT, "src", "benchmark", f), "utf8"));
  const importsOf = (text: string) => [...text.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!);

  it("imports only the URL parser, the source error and the YouTube source: no AI adapter, analysis or policy", () => {
    const imports = sources.flatMap(importsOf).sort();
    expect(imports).toEqual(["../adapters/youtube/youtube-comment-source", "../core/analysis/comment-source-error", "../core/analysis/youtube-url", "./youtube-fetch-smoke"]);
  });

  it("reads no AI provider key and writes no files", () => {
    for (const text of sources) {
      expect(text).not.toMatch(/ANTHROPIC_API_KEY|JEV_API_KEY|GEMINI_API_KEY/);
      expect(text).not.toMatch(/node:fs|writeFile|mkdir|createWriteStream|appendFile/);
    }
  });

  it("refuses any host other than the YouTube Data API, before the network is touched", async () => {
    const inner = vi.fn(async () => new Response(JSON.stringify({ items: [] })));
    const guarded = youtubeOnlyFetch(inner as unknown as typeof fetch, []);
    for (const target of ["https://api.anthropic.com/v1/messages", "https://api.typesafe.ai/v1/systemone", "http://www.googleapis.com/youtube/v3/commentThreads", "https://evil.example/www.googleapis.com"]) {
      await expect(guarded(target)).rejects.toThrow("may only call the YouTube Data API");
    }
    expect(inner).not.toHaveBeenCalled();
    await guarded("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("returns no comment records: the result holds counts and flags only", async () => {
    const { fetchImpl } = fakeYouTube([{ body: page(1, 40) }]);
    const result = await fetchOnlySmoke(URL_OK, { apiKey: KEY, fetch: fetchImpl });
    expect(Object.keys(result).sort()).toEqual([
      "capReached",
      "commentsFetched",
      "elapsedMs",
      "maxComments",
      "pagesRequested",
      "paginationEnd",
      "paginationEndedNaturally",
      "records",
      "status",
      "videoId",
      "youtubeApiRequests",
    ]);
    expectNothingPrivate(exposed(result));
  });
});
