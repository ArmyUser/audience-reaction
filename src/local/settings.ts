import type { CredentialStatus, SettingsView } from "../application/analysis-api";
import { gateDescription } from "./source-choice";
import { ANALYSIS_MODE_ENV, ANALYSIS_SOURCE_ENV, FIXTURE_DATASET_ENV, realModeGate, realModeSettings, realPipeline, type RealModeOverrides } from "./real-mode";

// The Settings → API & models view (server-side only). Keys are configured in the local .env file and read by the
// server at startup; this view reports only whether each key is present and plausibly formatted. It never returns a
// key value, a part of one or its length, and it makes no provider call (connections are not tested from here).

type Env = Readonly<Record<string, string | undefined>>;

export const ENV_FILE = ".env";

const CREDENTIALS = [
  {
    id: "youtube",
    name: "YouTube Data API v3",
    envVar: "YOUTUBE_API_KEY",
    usedFor: "Retrieves a video's top-level comments (commentThreads.list) for real YouTube analysis. Sent only to the YouTube Data API.",
    requiredFor: ["Real YouTube comments"],
  },
  {
    id: "jev",
    name: "Jev (TypeSafe)",
    envVar: "JEV_API_KEY",
    usedFor: "Classifies every comment (sentiment, type, targets) and assigns comments to topics.",
    requiredFor: ["Fixture datasets (real AI)", "Real YouTube comments"],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude Sonnet)",
    envVar: "ANTHROPIC_API_KEY",
    usedFor: "Discovers and consolidates the topic taxonomy from a sample of up to 400 comments.",
    requiredFor: ["Fixture datasets (real AI)", "Real YouTube comments"],
  },
] as const;

/** Present, and free of whitespace or quotes that usually mean a copy/paste error in .env. The value is not returned. */
export function credentialStatus(value: string | undefined): CredentialStatus {
  const v = value ?? "";
  if (v.trim().length === 0) return "missing";
  if (/\s|["'`]/.test(v)) return "check_format";
  return "configured";
}

export function settingsView(env: Env, overrides: Pick<RealModeOverrides, "cg1Record" | "today"> = {}): SettingsView {
  const s = realModeSettings();
  const modeVar = (name: string) => ({ name, value: env[name]?.trim() || "(not set)" });
  return {
    credentials: CREDENTIALS.map((c) => ({ ...c, requiredFor: [...c.requiredFor], status: credentialStatus(env[c.envVar]) })),
    pipeline: realPipeline(s),
    limits: { costLimitUsd: s.maxCostUsd, maxYouTubeComments: s.maxComments },
    cg1: gateDescription(realModeGate(env, { ...("cg1Record" in overrides ? { record: overrides.cg1Record } : {}), ...(overrides.today ? { today: overrides.today } : {}) })),
    envFile: ENV_FILE,
    modeVariables: [modeVar(ANALYSIS_MODE_ENV), modeVar(ANALYSIS_SOURCE_ENV), modeVar(FIXTURE_DATASET_ENV)],
  };
}
