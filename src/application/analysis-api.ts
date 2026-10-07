import type { AnalyzeVideoResult } from "./analyze-video-sync";
import type { AnalysisSourceKind, AnalysisStage, StageInfo } from "./progress";
import type { Finding, ReportOverview } from "./report-insights";
import type { AnalysisRunInfo } from "./run-info";

// Types shared by the analysis endpoint (src/app/api/analyze), the composition root and the browser. They carry
// configuration status and results only: never a key value, never a provider request.

/** One choice in the analysis-source selector. `id` is "demo", "fixture:<dataset>" or "youtube". */
export interface AnalysisSourceOption {
  id: string;
  kind: AnalysisSourceKind;
  label: string;
  detail: string;
  /** Comments in a test dataset (test data only). */
  comments?: number;
  available: boolean;
  /** Why the option cannot be used right now (missing configuration, CG-1). */
  unavailableReason?: string;
}

export interface PolicyLink {
  label: string;
  url: string;
}

export interface AnalysisSourceSetup {
  /** Test-data options (demo and the permitted development datasets). Held-out datasets are never listed. */
  testOptions: AnalysisSourceOption[];
  /** Present only when every key real YouTube analysis needs is configured. */
  youtube?: AnalysisSourceOption & { gate: { state: "internal_testing"; id: string; expiresOn: string } | { state: "blocked"; reason: string } };
  defaultId: string;
  costLimitUsd: number;
  /** Official YouTube API policy pages, shown next to the real-YouTube option. */
  policyLinks: PolicyLink[];
  /** A server configuration problem (e.g. an invalid ANALYSIS_MODE value); the selector still works. */
  configError?: string;
}

export interface ReportInsightsPayload {
  overview: ReportOverview;
  findings: Finding[];
}

export interface AnalysisPayload {
  result: AnalyzeVideoResult;
  run?: AnalysisRunInfo;
  /** Present when the result is a report. */
  insights?: ReportInsightsPayload;
}

// ---------- analyses (server-side, in-memory registry) ----------

export type AnalysisStatus = "queued" | "running" | "completed" | "failed";

/** One analysis as listed in "Recent analyses". Carries no report data and no comment text. */
export interface AnalysisSummary {
  id: string;
  sourceId: string;
  sourceKind: AnalysisSourceKind;
  /** e.g. "t1-topics-v1", "Demo", "YouTube video dQw4w9WgXcQ". */
  label: string;
  status: AnalysisStatus;
  /** The running stage (queued/running only). */
  stage: AnalysisStage | null;
  stages: StageInfo[];
  /** Short fingerprint of the effective pipeline configuration the analysis ran with. */
  configVersion: string;
  createdAt: number;
  completedAt?: number;
  /** When the server drops the cached result (completed/failed only). */
  expiresAt?: number;
}

/** One analysis with its result once finished (a failed analysis may carry a non-report result to explain why). */
export interface AnalysisSnapshot extends AnalysisSummary {
  payload?: AnalysisPayload;
  error?: string;
}

/** Response of POST /api/analyses. `reused`: an identical analysis was already running or completed. */
export interface StartAnalysisResponse {
  analysis: AnalysisSnapshot;
  reused: boolean;
}

// ---------- settings (API & models) ----------

export type CredentialStatus = "configured" | "missing" | "check_format";

export interface ProviderCredentialView {
  id: string;
  name: string;
  /** The environment variable read from the local .env file (a name, never a value). */
  envVar: string;
  status: CredentialStatus;
  /** What the key is used for in this app. */
  usedFor: string;
  /** Analysis sources that need this key. */
  requiredFor: string[];
}

export interface SettingsView {
  credentials: ProviderCredentialView[];
  pipeline: { role: string; component: string }[];
  limits: { costLimitUsd: number; maxYouTubeComments: number };
  cg1: { state: "internal_testing"; id: string; expiresOn: string } | { state: "blocked"; reason: string };
  envFile: string;
  modeVariables: { name: string; value: string }[];
}
