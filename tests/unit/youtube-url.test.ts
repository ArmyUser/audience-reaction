import { describe, expect, it } from "vitest";
import { parseYouTubeUrl } from "../../src/core/analysis/youtube-url";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeUrl — accepted video URLs", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=30s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=PL123`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `  https://www.youtube.com/watch?v=${ID}  `,
  ])("extracts the video ID from %s", (input) => {
    expect(parseYouTubeUrl(input)).toEqual({ ok: true, videoId: ID });
  });
});

describe("parseYouTubeUrl — rejected input", () => {
  it.each([
    ["", "URL_INVALID"],
    ["not a url", "URL_INVALID"],
    ["https://example.com/watch?v=" + ID, "URL_INVALID"],
    ["https://youtube.com.evil.example/watch?v=" + ID, "URL_INVALID"],
    ["javascript:alert(1)", "URL_INVALID"],
    ["ftp://youtube.com/watch?v=" + ID, "URL_INVALID"],
    ["https://www.youtube.com/watch?v=short", "URL_INVALID"],
    ["https://www.youtube.com/watch?v=<script>alert(1)</script>", "URL_INVALID"],
    ["https://youtu.be/", "URL_UNSUPPORTED"],
    ["https://www.youtube.com/watch", "URL_UNSUPPORTED"],
    ["https://www.youtube.com/@somechannel", "URL_UNSUPPORTED"],
    ["https://www.youtube.com/playlist?list=PL123", "URL_UNSUPPORTED"],
    ["https://www.youtube.com/results?search_query=test", "URL_UNSUPPORTED"],
    ["https://www.youtube.com/", "URL_UNSUPPORTED"],
  ])("rejects %j with %s", (input, reason) => {
    expect(parseYouTubeUrl(input)).toEqual({ ok: false, reason });
  });

  it("rejects overly long input", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&x=${"a".repeat(3000)}`)).toEqual({ ok: false, reason: "URL_INVALID" });
  });
});
