// Syntactic YouTube URL parsing (spec.md F5). No network access.

export type UrlRejectionReason = "URL_INVALID" | "URL_UNSUPPORTED";

export type ParsedVideoUrl =
  | { ok: true; videoId: string }
  | { ok: false; reason: UrlRejectionReason };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_INPUT_LENGTH = 2048;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const PATH_PREFIXES = ["shorts", "live", "embed"];

export function parseYouTubeUrl(input: string): ParsedVideoUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return { ok: false, reason: "URL_INVALID" };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "URL_INVALID" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "URL_INVALID" };

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (SHORT_HOSTS.has(host)) {
    return toResult(segments[0]);
  }
  if (!YOUTUBE_HOSTS.has(host)) return { ok: false, reason: "URL_INVALID" };

  if (segments[0] === "watch") return toResult(url.searchParams.get("v") ?? undefined);
  if (segments[0] !== undefined && PATH_PREFIXES.includes(segments[0])) return toResult(segments[1]);

  // Channels, playlists, search, home page, etc. are YouTube URLs but not single videos.
  return { ok: false, reason: "URL_UNSUPPORTED" };
}

function toResult(candidate: string | undefined): ParsedVideoUrl {
  if (candidate !== undefined && VIDEO_ID.test(candidate)) return { ok: true, videoId: candidate };
  return { ok: false, reason: candidate === undefined ? "URL_UNSUPPORTED" : "URL_INVALID" };
}
