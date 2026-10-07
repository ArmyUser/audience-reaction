import { z } from "zod";
import type { SourceOrigin } from "../domain/types";

// Centralized compliance hooks (spec.md §11–§12; README "YouTube integration and CG-1"). Business logic asks this policy;
// no compliance values live anywhere else. Values are configuration, set server-side only. These are product
// settings, not legal determinations: every value must be checked against current platform policies.

export type RetentionRule =
  | { mode: "delete_at_finalize" }
  | { mode: "max_age_days"; days: number }
  | { mode: "max_age_months"; months: number };

export type ExportMode = "derived" | "full";
export type SourceDataKind = "raw_comment" | "evidence" | "video_metadata";

/** Upper bound for keeping source (Category A) data, as currently understood (spec.md §11.0). */
export const SOURCE_DATA_MAX_AGE_DAYS_LIMIT = 30;
/** Upper bound for derived (Category B) data when the additional derived-metrics regime is accepted. */
export const DERIVED_DATA_MAX_AGE_MONTHS_LIMIT = 36;

const ORIGINS = ["youtube", "synthetic_fixture", "human_written", "licensed", "owner_authorized"] as const;

const policyConfigSchema = z
  .strictObject({
    /**
     * CG-1: derived analytics on real YouTube comments. Blocked until compliance is confirmed.
     * `internal_testing` is a recorded, time-limited product-owner exception for private local testing only (spec.md
     * §12.8 "internal testing … under default API rules"): analysis is allowed, but YouTube data never enters
     * benchmarks and nothing beyond the strict retention model applies. It is not compliance approval.
     */
    youtubeDerivedAnalytics: z.enum(["blocked", "internal_testing", "allowed"]),
    /** Recorded acceptance under the additional derived-metrics regime for the operator's API project. */
    derivedRegimeAccepted: z.boolean(),
    sourceDataMaxAgeDays: z.number().int().positive().max(SOURCE_DATA_MAX_AGE_DAYS_LIMIT),
    derivedDataMaxAgeMonths: z.number().int().positive().max(DERIVED_DATA_MAX_AGE_MONTHS_LIMIT).nullable(),
    allowFullExport: z.boolean(),
    benchmarkAllowedOrigins: z.array(z.enum(ORIGINS)),
  })
  .superRefine((config, ctx) => {
    if (config.derivedDataMaxAgeMonths !== null && !config.derivedRegimeAccepted) {
      ctx.addIssue({ code: "custom", message: "derived retention beyond the source-data window requires derivedRegimeAccepted" });
    }
    if (config.youtubeDerivedAnalytics === "internal_testing" && (config.derivedRegimeAccepted || config.derivedDataMaxAgeMonths !== null || config.allowFullExport)) {
      ctx.addIssue({ code: "custom", message: "the CG-1 internal-testing exception keeps the strict retention and export settings" });
    }
    if (config.benchmarkAllowedOrigins.includes("youtube") && config.youtubeDerivedAnalytics !== "allowed") {
      ctx.addIssue({ code: "custom", message: "YouTube benchmark data requires youtubeDerivedAnalytics = allowed (CG-1)" });
    }
  });

export type CompliancePolicyConfig = z.infer<typeof policyConfigSchema>;

/** Strictest settings. Used whenever no explicit server-side configuration exists. */
export const STRICT_POLICY_CONFIG: Readonly<CompliancePolicyConfig> = Object.freeze<CompliancePolicyConfig>({
  youtubeDerivedAnalytics: "blocked",
  derivedRegimeAccepted: false,
  sourceDataMaxAgeDays: SOURCE_DATA_MAX_AGE_DAYS_LIMIT,
  derivedDataMaxAgeMonths: null,
  allowFullExport: false,
  benchmarkAllowedOrigins: ["synthetic_fixture", "human_written", "licensed"],
});

export interface CompliancePolicy {
  readonly config: Readonly<CompliancePolicyConfig>;
  derivedAnalyticsAllowed(origin: SourceOrigin): boolean;
  sourceDataRetention(kind: SourceDataKind): RetentionRule;
  intermediateDataRetention(): RetentionRule;
  derivedDataRetention(origin: SourceOrigin): RetentionRule;
  exportModes(): readonly ExportMode[];
  exportRequiresAcknowledgment(mode: ExportMode): boolean;
  benchmarkOriginAllowed(origin: SourceOrigin): boolean;
  benchmarkLabelsPersist(origin: SourceOrigin): boolean;
  /** Human-readable, non-legal description of the CG-1 state for display. */
  describeYouTubeGate(): string;
}

export class PolicyBlockedError extends Error {
  override readonly name = "PolicyBlockedError";
  constructor(readonly origin: SourceOrigin) {
    super(`Derived analytics are disabled by the compliance policy for source origin "${origin}".`);
  }
}

/** Builds an immutable policy. Invalid or unsafe configurations are rejected, never partially applied. */
export function createCompliancePolicy(config: CompliancePolicyConfig = STRICT_POLICY_CONFIG): CompliancePolicy {
  const c = Object.freeze(policyConfigSchema.parse(config));
  const youtubeAllowed = c.youtubeDerivedAnalytics === "allowed" || c.youtubeDerivedAnalytics === "internal_testing";
  const sourceWindow: RetentionRule = { mode: "max_age_days", days: c.sourceDataMaxAgeDays };

  return Object.freeze({
    config: c,
    derivedAnalyticsAllowed: (origin: SourceOrigin) => (origin === "youtube" ? youtubeAllowed : true),
    sourceDataRetention: (kind: SourceDataKind): RetentionRule =>
      kind === "raw_comment" ? { mode: "delete_at_finalize" } : sourceWindow,
    intermediateDataRetention: (): RetentionRule => ({ mode: "delete_at_finalize" }),
    // Derived data stays within the source-data window unless the regime is accepted (spec.md §11.0, AC-55).
    derivedDataRetention: (origin: SourceOrigin): RetentionRule =>
      origin === "youtube" && c.derivedRegimeAccepted && c.derivedDataMaxAgeMonths !== null
        ? { mode: "max_age_months", months: c.derivedDataMaxAgeMonths }
        : sourceWindow,
    exportModes: (): readonly ExportMode[] => (c.allowFullExport ? ["derived", "full"] : ["derived"]),
    exportRequiresAcknowledgment: (mode: ExportMode) => mode === "full",
    benchmarkOriginAllowed: (origin: SourceOrigin) => c.benchmarkAllowedOrigins.includes(origin),
    benchmarkLabelsPersist: (origin: SourceOrigin) => origin !== "youtube",
    describeYouTubeGate: () =>
      c.youtubeDerivedAnalytics === "allowed"
        ? "Analysis of real YouTube comments is enabled by server-side configuration."
        : c.youtubeDerivedAnalytics === "internal_testing"
          ? "INTERNAL TEST: analysis of real YouTube comments runs under a recorded, time-limited CG-1 exception for private local testing only. Compliance is not confirmed; do not share these results."
          : "Analysis of real YouTube comments is disabled until compliance requirements are confirmed (CG-1).",
  });
}
