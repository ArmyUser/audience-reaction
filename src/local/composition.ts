import "server-only";

import type { AnalysisPayload, AnalysisSnapshot, AnalysisSourceSetup, AnalysisSummary, SettingsView, StartAnalysisResponse } from "../application/analysis-api";
import { analyzeVideoSync, URL_MESSAGES, type AnalyzeVideoResult } from "../application/analyze-video-sync";
import {
  ProgressClassifier,
  ProgressCommentSource,
  ProgressTracker,
  stagesFor,
  type AnalysisSourceKind,
  type AnalysisStage,
} from "../application/progress";
import { keyFindings, reportOverview } from "../application/report-insights";
import type { AnalysisRunInfo } from "../application/run-info";
import { parseYouTubeUrl } from "../core/analysis/youtube-url";
import { DEFAULT_ANALYSIS_PARAMETERS } from "../core/aggregation/aggregate";
import { DEFAULT_TOPIC_PARAMETERS } from "../core/topics/aggregate-topics";
import { AnalysisRegistry, fingerprint, type AnalysisJob } from "./analysis-registry";
import { analysisTelemetry, createRealAnalysis, DEMO_PIPELINE, demoDeps, PROVIDER_FAILURE_RESULT, realModeGate, realModeSettings, realRunInfo, selectAnalysisMode, type RealModeOverrides, type RealModeSettings } from "./real-mode";
import { settingsView } from "./settings";
import { choiceId, defaultChoice, envForChoice, parseSourceChoice, sourceSetup, type SourceChoice } from "./source-choice";

// Composition root for the local app (server-only). The browser supplies an analysis-source option id (and, for real
// YouTube only, a video URL); the id is checked against an allowlist (source-choice.ts) and mapped onto the same mode
// variables the .env file uses. Analyses run detached from the request and are kept in an in-memory registry
// (analysis-registry.ts), so an identical analysis is reused instead of being paid for twice.
// Policy, providers, keys and limits are fixed here from server-side configuration.
// - demo: synthetic data and the fake classifier with the strictest compliance policy, exactly as in M2.
// - fixture (real AI): the real pipeline on a permitted synthetic development dataset: no YouTube call, no CG-1
//   evaluation (not YouTube data). Held-out datasets are refused.
// - youtube (real AI, EXPERIMENTAL): choosing it never lifts CG-1 by itself; only the recorded internal-testing
//   exception can, under its own conditions (local dev server, active, not expired;
//   docs/compliance/cg1-internal-testing-exception.md), evaluated before any retrieval.
const DEMO_DEPS = Object.freeze(demoDeps());

type Env = Readonly<Record<string, string | undefined>>;

/** What the analysis-source selector offers, from configuration only. */
export function currentSourceSetup(): AnalysisSourceSetup {
  return sourceSetup(process.env);
}

/** Settings → API & models: key presence (never values), models, limits, CG-1. */
export function currentSettings(): SettingsView {
  return settingsView(process.env);
}

export interface AnalysisResponse {
  result: AnalyzeVideoResult;
  /** Present once an analysis actually ran (not for configuration errors). */
  run?: AnalysisRunInfo;
}

export type PreparedAnalysis =
  | { ok: false; message: string; field?: "url" | "source" }
  | ({ ok: true } & AnalysisJob & { run: (onStage?: (stage: AnalysisStage) => void) => Promise<AnalysisPayload> });

/**
 * Test data is not tied to a video: the dataset's comments are analysed whatever the video ID, so a fixed internal
 * link is used and the report does not present it as a source.
 */
export const TEST_DATA_URL = "https://www.youtube.com/watch?v=testdataset";

/** Bump when a code change alters the report for the same source and configuration (invalidates cached analyses). */
export const REPORT_CACHE_VERSION = "report-v1";

/**
 * Fingerprint of everything configured that can change the analytical output for this kind of source: models,
 * contracts, prompts' question sets, sampling seed, limits and parameters. A configuration change gives a new key,
 * so an old result is never reused for it.
 */
export function configVersionFor(kind: AnalysisSourceKind, settings: RealModeSettings = realModeSettings()): string {
  const params = { analysis: DEFAULT_ANALYSIS_PARAMETERS, topics: DEFAULT_TOPIC_PARAMETERS };
  return fingerprint(kind === "demo" ? { v: REPORT_CACHE_VERSION, pipeline: DEMO_PIPELINE, params } : { v: REPORT_CACHE_VERSION, settings, params });
}

/**
 * Validates one analysis request from the browser without calling anything: the source option id (allowlisted;
 * held-out datasets refused) and, for real YouTube only, the video URL. `source` undefined means the .env default.
 */
export function prepareAnalysis(request: { url?: unknown; source?: unknown }, env: Env = process.env, overrides: RealModeOverrides = {}): PreparedAnalysis {
  let choice: SourceChoice;
  if (request.source === undefined) choice = defaultChoice(env);
  else {
    const parsed = parseSourceChoice(request.source);
    if (!parsed.ok) return { ok: false, message: parsed.message, field: "source" };
    choice = parsed.choice;
  }

  let url = TEST_DATA_URL;
  let subject: string;
  let label: string;
  if (choice.kind === "youtube") {
    if (typeof request.url !== "string" || request.url.trim() === "") return { ok: false, message: "Enter a YouTube video link.", field: "url" };
    const parsed = parseYouTubeUrl(request.url);
    if (!parsed.ok) return { ok: false, message: URL_MESSAGES[parsed.reason], field: "url" };
    url = `https://www.youtube.com/watch?v=${parsed.videoId}`;
    subject = parsed.videoId;
    label = `YouTube video ${parsed.videoId}`;
  } else {
    subject = choice.kind === "fixture" ? choice.dataset : "demo";
    label = choice.kind === "fixture" ? choice.dataset : "Demo";
  }

  const stages = stagesFor(choice.kind);
  const configVersion = configVersionFor(choice.kind, overrides.settings);
  return {
    ok: true,
    key: `${choice.kind}|${subject}|${configVersion}`,
    sourceId: choiceId(choice),
    sourceKind: choice.kind,
    label,
    configVersion,
    stages,
    run: async (onStage) => {
      const progress = new ProgressTracker(stages, onStage ?? (() => {}));
      return withInsights(await runChoice(url, choice, envForChoice(env, choice), progress, overrides));
    },
  };
}

// ---------- analyses: start, follow, reopen (in-memory registry, see analysis-registry.ts) ----------

/**
 * A completed YouTube result (derived data) is kept only while CG-1 still allows YouTube data in this server; it is
 * dropped as soon as the exception expires or is revoked. Failed attempts (e.g. blocked by CG-1) hold no YouTube
 * data and stay visible until their normal expiry, so the reason can be shown.
 */
function retainedNow(entry: AnalysisSummary): boolean {
  return entry.sourceKind !== "youtube" || entry.status !== "completed" || realModeGate(process.env).state === "internal_testing";
}

const registry = new AnalysisRegistry({ retained: retainedNow });

export type StartResult = { ok: true; response: StartAnalysisResponse } | { ok: false; message: string; field?: "url" | "source" };

/** Starts an analysis, or returns the identical one already running or completed (no new provider calls). */
export function startAnalysis(request: { url?: unknown; source?: unknown }): StartResult {
  const prepared = prepareAnalysis(request);
  if (!prepared.ok) return prepared;
  return { ok: true, response: registry.start(prepared) };
}

export function getAnalysis(id: string): AnalysisSnapshot | undefined {
  return registry.get(id);
}

export function listAnalyses(): AnalysisSummary[] {
  return registry.list();
}

function withInsights(response: AnalysisResponse): AnalysisPayload {
  const { result, run } = response;
  return {
    result,
    ...(run ? { run } : {}),
    ...(result.status === "ok" ? { insights: { overview: reportOverview(result.report), findings: keyFindings(result.report) } } : {}),
  };
}

async function runChoice(url: string, choice: SourceChoice, env: Env, progress: ProgressTracker, overrides: RealModeOverrides): Promise<AnalysisResponse> {
  const selection = selectAnalysisMode(env);
  if (!selection.ok) return { result: { status: "not_configured", message: selection.message } };
  const started = Date.now();
  if (choice.kind === "demo") {
    const deps = { ...DEMO_DEPS, source: new ProgressCommentSource(DEMO_DEPS.source, progress), classifier: new ProgressClassifier(DEMO_DEPS.classifier, progress, "building") };
    const result = await analyzeVideoSync({ url }, deps);
    return { result, run: { mode: "demo", input: { kind: "demo", label: DEMO_DEPS.source.label }, durationMs: Date.now() - started, pipeline: [...DEMO_PIPELINE] } };
  }

  const build = createRealAnalysis(env, { ...overrides, progress });
  if (!build.ok) return { result: { status: "not_configured", message: build.message } };
  let result: AnalyzeVideoResult;
  try {
    result = await analyzeVideoSync({ url }, build.analysis.deps);
  } catch (error) {
    // Unexpected provider errors (e.g. a rejected AI key): only the error class name is logged, never its message.
    console.error(`[analysis] provider error: ${error instanceof Error ? error.name : "unknown"}`);
    result = PROVIDER_FAILURE_RESULT;
  }
  const durationMs = Date.now() - started;
  console.info(`[analysis] ${JSON.stringify(analysisTelemetry("real", result, build.analysis.budget, durationMs, build.analysis.input))}`);
  return { result, run: realRunInfo(build.analysis, durationMs) };
}
