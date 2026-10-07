import { FIXTURE_DATASETS, type FixtureDatasetId } from "../adapters/fixtures/fixture-dataset-source";
import type { AnalysisSourceOption, AnalysisSourceSetup, PolicyLink } from "../application/analysis-api";
import {
  ANALYSIS_MODE_ENV,
  ANALYSIS_SOURCE_ENV,
  analysisSetup,
  FIXTURE_DATASET_ENV,
  FIXTURE_SOURCE_KEY_ENVS,
  REAL_MODE_KEY_ENVS,
  realModeGate,
  realModeSettings,
  selectAnalysisSource,
  type Cg1Gate,
  type RealModeOverrides,
} from "./real-mode";

// The analysis source chosen in the UI (local composition; server-side only). The browser sends an option id; it is
// checked against an allowlist here and turned into the same three mode variables the .env file uses, so the existing
// selection rules apply unchanged: held-out datasets are refused by selectAnalysisSource, real YouTube analysis runs
// under the unchanged CG-1 gate (evaluated from the server environment, which the request cannot touch), and missing
// keys are a configuration error. The choice never changes policy, limits, models or keys.

type Env = Readonly<Record<string, string | undefined>>;

export type SourceChoice = { kind: "demo" } | { kind: "fixture"; dataset: FixtureDatasetId } | { kind: "youtube" };

export type ChoiceParse = { ok: true; choice: SourceChoice } | { ok: false; message: string };

/** Official YouTube API Services policy pages (the same sources as docs/compliance/youtube-derived-metrics-application.md). */
export const YOUTUBE_POLICY_LINKS: readonly PolicyLink[] = Object.freeze([
  { label: "YouTube API Services Terms of Service", url: "https://developers.google.com/youtube/terms/api-services-terms-of-service" },
  { label: "YouTube API Services Developer Policies", url: "https://developers.google.com/youtube/terms/developer-policies" },
  { label: "Derived metrics and data storage policies", url: "https://developers.google.com/youtube/terms/derived-metrics-policy" },
]);

export function choiceId(choice: SourceChoice): string {
  return choice.kind === "fixture" ? `fixture:${choice.dataset}` : choice.kind;
}

/** Parses an option id from the browser. Anything not on the allowlist is refused; held-out datasets explicitly. */
export function parseSourceChoice(value: unknown): ChoiceParse {
  if (value === "demo") return { ok: true, choice: { kind: "demo" } };
  if (value === "youtube") return { ok: true, choice: { kind: "youtube" } };
  if (typeof value === "string" && value.startsWith("fixture:") && value.length > "fixture:".length && value.length <= 64) {
    const selection = selectAnalysisSource({ [ANALYSIS_SOURCE_ENV]: "fixture", [FIXTURE_DATASET_ENV]: value.slice("fixture:".length) });
    if (!selection.ok) return { ok: false, message: selection.message };
    if (selection.source.kind === "fixture") return { ok: true, choice: { kind: "fixture", dataset: selection.source.dataset } };
  }
  return { ok: false, message: "Unknown analysis source." };
}

/** The server environment with the mode variables set for this choice. NODE_ENV and keys are left as they are. */
export function envForChoice(env: Env, choice: SourceChoice): Env {
  const rest = { ...env };
  delete rest[FIXTURE_DATASET_ENV];
  if (choice.kind === "demo") return { ...rest, [ANALYSIS_MODE_ENV]: "demo", [ANALYSIS_SOURCE_ENV]: undefined };
  if (choice.kind === "youtube") return { ...rest, [ANALYSIS_MODE_ENV]: "real", [ANALYSIS_SOURCE_ENV]: "youtube" };
  return { ...rest, [ANALYSIS_MODE_ENV]: "real", [ANALYSIS_SOURCE_ENV]: "fixture", [FIXTURE_DATASET_ENV]: choice.dataset };
}

/** The .env selection as a choice (the selector's default). A misconfigured .env falls back to demo. */
export function defaultChoice(env: Env): SourceChoice {
  const setup = analysisSetup(env);
  if (setup.mode !== "real") return { kind: "demo" };
  return setup.input.kind === "fixture" ? { kind: "fixture", dataset: setup.input.dataset } : { kind: "youtube" };
}

function missingKeys(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => (env[name] ?? "").trim().length === 0);
}

const GATE_REASON: Record<Extract<Cg1Gate, { state: "blocked" }>["reason"], string> = {
  no_record: "no CG-1 exception is recorded",
  invalid_record: "the CG-1 exception record is invalid",
  not_active: "the CG-1 exception is not active",
  not_yet_valid: "the CG-1 exception is not valid yet",
  expired: "the CG-1 exception has expired",
  not_local_development: "the CG-1 exception applies only to the local development server (npm run dev)",
};

export function gateDescription(gate: Cg1Gate): { state: "internal_testing"; id: string; expiresOn: string } | { state: "blocked"; reason: string } {
  return gate.state === "internal_testing" ? gate : { state: "blocked", reason: GATE_REASON[gate.reason] };
}

/** What the selector shows: computed from configuration only; nothing is called. */
export function sourceSetup(env: Env, overrides: Pick<RealModeOverrides, "cg1Record" | "today"> = {}): AnalysisSourceSetup {
  const aiMissing = missingKeys(env, FIXTURE_SOURCE_KEY_ENVS);
  const testOptions: AnalysisSourceOption[] = [
    { id: "demo", kind: "demo", label: "Demo", detail: "Synthetic comments and a rule-based classifier. No AI calls, no cost.", comments: FIXTURE_DATASETS["m2-synthetic"].length, available: true },
    ...(Object.keys(FIXTURE_DATASETS) as FixtureDatasetId[]).map(
      (dataset): AnalysisSourceOption => ({
        id: `fixture:${dataset}`,
        kind: "fixture",
        label: dataset,
        detail: `${FIXTURE_DATASETS[dataset].length} synthetic comments (development set), analysed by the real AI pipeline.`,
        comments: FIXTURE_DATASETS[dataset].length,
        available: aiMissing.length === 0,
        ...(aiMissing.length > 0 ? { unavailableReason: `Needs ${aiMissing.join(", ")} (see Settings).` } : {}),
      }),
    ),
  ];

  let youtube: AnalysisSourceSetup["youtube"];
  if (missingKeys(env, REAL_MODE_KEY_ENVS).length === 0) {
    const gate = gateDescription(realModeGate(env, { ...("cg1Record" in overrides ? { record: overrides.cg1Record } : {}), ...(overrides.today ? { today: overrides.today } : {}) }));
    youtube = {
      id: "youtube",
      kind: "youtube",
      label: "Real YouTube comments",
      detail: "Top-level comments of the video from the YouTube Data API, analysed by the real AI pipeline.",
      available: gate.state === "internal_testing",
      ...(gate.state === "blocked" ? { unavailableReason: `Blocked by CG-1: ${gate.reason}.` } : {}),
      gate,
    };
  }

  const preferred = choiceId(defaultChoice(env));
  const all: AnalysisSourceOption[] = [...testOptions, ...(youtube ? [youtube] : [])];
  const defaultId = all.find((o) => o.id === preferred && o.available)?.id ?? "demo";
  const setup = analysisSetup(env);
  return {
    testOptions,
    ...(youtube ? { youtube } : {}),
    defaultId,
    costLimitUsd: realModeSettings().maxCostUsd,
    policyLinks: [...YOUTUBE_POLICY_LINKS],
    ...(setup.mode === "misconfigured" ? { configError: `${setup.message} The selector below is used instead.` } : {}),
  };
}
