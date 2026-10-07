import { fetchOnlySmoke, formatFetchSmokeResult } from "./youtube-fetch-smoke";

// Manual fetch-only YouTube ingestion smoke test (never part of `npm test`; see youtube-fetch-smoke.ts). Reads only
// YOUTUBE_API_KEY; no AI provider key is read and no AI provider can be reached. Prints technical ingestion
// statistics only, never comment text, authors, keys or request URLs. Writes no files.
// Usage: npm run youtube:fetch-smoke -- "<public YouTube video URL>"

export async function runFetchSmokeCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, fetchImpl?: typeof fetch): Promise<{ exitCode: number; output: string }> {
  const urls = argv.filter((a) => a.trim().length > 0);
  if (urls.length !== 1) return { exitCode: 2, output: 'Usage: npm run youtube:fetch-smoke -- "<public YouTube video URL>" (exactly one URL)' };
  const apiKey = env.YOUTUBE_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) return { exitCode: 2, output: "YOUTUBE_API_KEY is not set. Add it to the local .env file (never commit it) and re-run." };
  const result = await fetchOnlySmoke(urls[0]!, { apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { exitCode: result.status === "ok" ? 0 : 1, output: `YouTube fetch-only smoke test (no derived analytics, nothing stored)\n${formatFetchSmokeResult(result)}` };
}

if (process.argv[1]?.endsWith("youtube-fetch-smoke-cli.ts")) {
  const { exitCode, output } = await runFetchSmokeCli(process.argv.slice(2), process.env);
  (exitCode === 0 ? console.log : console.error)(output);
  process.exitCode = exitCode;
}
