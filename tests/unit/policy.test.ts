import { describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import {
  createCompliancePolicy,
  PolicyBlockedError,
  STRICT_POLICY_CONFIG,
  type CompliancePolicyConfig,
} from "../../src/core/policy/compliance-policy";
import { goldClassifier, goldDeps, sourceOf, VIDEO_ID } from "../helpers";

const strict = createCompliancePolicy();

describe("compliance policy — strict defaults", () => {
  it("uses the strict configuration when none is given", () => {
    expect(strict.config).toEqual(STRICT_POLICY_CONFIG);
    expect(STRICT_POLICY_CONFIG.youtubeDerivedAnalytics).toBe("blocked");
    expect(STRICT_POLICY_CONFIG.derivedRegimeAccepted).toBe(false);
  });

  it("CG-1: blocks derived analytics on YouTube data, allows synthetic/permissible origins", () => {
    expect(strict.derivedAnalyticsAllowed("youtube")).toBe(false);
    expect(strict.derivedAnalyticsAllowed("synthetic_fixture")).toBe(true);
    expect(strict.derivedAnalyticsAllowed("human_written")).toBe(true);
  });

  it("applies strict retention: raw and intermediate data deleted at finalize, the rest within the source window", () => {
    expect(strict.sourceDataRetention("raw_comment")).toEqual({ mode: "delete_at_finalize" });
    expect(strict.intermediateDataRetention()).toEqual({ mode: "delete_at_finalize" });
    expect(strict.sourceDataRetention("evidence")).toEqual({ mode: "max_age_days", days: 30 });
    expect(strict.sourceDataRetention("video_metadata")).toEqual({ mode: "max_age_days", days: 30 });
    expect(strict.derivedDataRetention("youtube")).toEqual({ mode: "max_age_days", days: 30 });
  });

  it("restricts exports and benchmark data by default", () => {
    expect(strict.exportModes()).toEqual(["derived"]);
    expect(strict.exportRequiresAcknowledgment("full")).toBe(true);
    expect(strict.benchmarkOriginAllowed("youtube")).toBe(false);
    expect(strict.benchmarkOriginAllowed("synthetic_fixture")).toBe(true);
    expect(strict.benchmarkLabelsPersist("youtube")).toBe(false);
  });

  it("describes the gate without legal claims", () => {
    expect(strict.describeYouTubeGate()).toMatch(/disabled until compliance requirements are confirmed \(CG-1\)/);
    expect(strict.describeYouTubeGate()).not.toMatch(/\b(legal|lawful|compliant|exempt)\b/i);
  });
});

describe("compliance policy — enforcement in the engine", () => {
  it("blocks a YouTube-origin analysis before retrieving or classifying anything", async () => {
    const source = sourceOf([{ id: "a", text: "x" }], "youtube");
    const listSpy = vi.spyOn(source, "listComments");
    const classifier = goldClassifier();
    const classifySpy = vi.spyOn(classifier, "classify");

    await expect(runAnalysis({ videoId: VIDEO_ID }, goldDeps({ source, classifier }))).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(listSpy).not.toHaveBeenCalled();
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it("allows YouTube-origin analysis only through an explicit server-side configuration", async () => {
    const opened = createCompliancePolicy({ ...STRICT_POLICY_CONFIG, youtubeDerivedAnalytics: "allowed" });
    expect(opened.derivedAnalyticsAllowed("youtube")).toBe(true);
  });
});

describe("compliance policy — cannot be weakened implicitly", () => {
  it.each<[string, Partial<CompliancePolicyConfig> & Record<string, unknown>]>([
    ["source retention above the limit", { sourceDataMaxAgeDays: 31 }],
    ["derived retention without regime acceptance", { derivedDataMaxAgeMonths: 36 }],
    ["derived retention above the limit", { derivedRegimeAccepted: true, derivedDataMaxAgeMonths: 37 }],
    ["YouTube benchmark data while CG-1 is blocked", { benchmarkAllowedOrigins: ["youtube"] }],
    ["unknown settings", { disableAllChecks: true }],
    ["wrongly typed values", { youtubeDerivedAnalytics: "yes" as never }],
  ])("rejects %s", (_name, patch) => {
    expect(() => createCompliancePolicy({ ...STRICT_POLICY_CONFIG, ...patch } as CompliancePolicyConfig)).toThrow();
  });

  it("is immutable at runtime", () => {
    const policy = createCompliancePolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.config)).toBe(true);
    expect(() => {
      (policy as unknown as Record<string, unknown>).derivedAnalyticsAllowed = () => true;
    }).toThrow(TypeError);
    expect(policy.derivedAnalyticsAllowed("youtube")).toBe(false);
  });

  it("keeps derived data within the source window until the regime is accepted", () => {
    const accepted = createCompliancePolicy({ ...STRICT_POLICY_CONFIG, derivedRegimeAccepted: true, derivedDataMaxAgeMonths: 36 });
    expect(accepted.derivedDataRetention("youtube")).toEqual({ mode: "max_age_months", months: 36 });
  });
});
