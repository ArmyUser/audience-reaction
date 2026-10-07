import { describe, expect, it, vi } from "vitest";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { SyntheticCommentSource } from "../../src/adapters/fixtures/synthetic-comment-source";
import { analyzeVideoSync } from "../../src/application/analyze-video-sync";
import { createCompliancePolicy, STRICT_POLICY_CONFIG } from "../../src/core/policy/compliance-policy";
import { REPRESENTATIVENESS_NOTE } from "../../src/core/reporting/report-model";
import { FIXTURE, FOCUS, goldDeps, sourceOf, VALID_URL } from "../helpers";

const keywordDeps = () => ({ source: new SyntheticCommentSource(), classifier: new FakeClassifier(), policy: createCompliancePolicy() });

describe("analyzeVideoSync", () => {
  it("returns invalid_url without touching the source or classifier", async () => {
    const deps = keywordDeps();
    const listSpy = vi.spyOn(deps.source, "listComments");
    const classifySpy = vi.spyOn(deps.classifier, "classify");

    const result = await analyzeVideoSync({ url: "https://example.com/not-youtube" }, deps);

    expect(result).toMatchObject({ status: "invalid_url", reason: "URL_INVALID" });
    expect(listSpy).not.toHaveBeenCalled();
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it("returns a plain-data report view model for a valid URL", async () => {
    const result = await analyzeVideoSync({ url: VALID_URL }, keywordDeps());
    if (result.status !== "ok") throw new Error("expected ok");
    const r = result.report;

    expect(r.videoId).toBe("dQw4w9WgXcQ");
    expect(r.commentsAnalysed).toBe(FIXTURE.comments.length);
    expect(r.overallSentiment.rows.map((x) => x.label)).toEqual(["Positive", "Neutral", "Negative"]);
    expect(r.commentTypes.rows).toHaveLength(6);
    expect(r.targets.map((t) => t.key)).toEqual(["creator", "content"]);
    expect(r.topics.status).toBe("not_run");
    expect(r.evidence.status).toBe("not_run");
    expect(r.synthesis.status).toBe("not_run");
    expect(r.methodology.representativenessNote).toBe(REPRESENTATIVENESS_NOTE);
    expect(r.comments).toHaveLength(FIXTURE.comments.length);
    // View model must survive a JSON round-trip unchanged (no classes, functions or infrastructure objects).
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("supports a focus target in the application model (UI does not expose it yet)", async () => {
    const result = await analyzeVideoSync({ url: VALID_URL, focus: FOCUS }, goldDeps());
    if (result.status !== "ok") throw new Error("expected ok");
    const focus = result.report.targets.find((t) => t.key === "focus")!;
    expect(focus.label).toBe("Focus: Acme VPN");
    expect(focus.mentions.count).toBe(8);
    expect(focus.showPercentages).toBe(false); // small sample
    expect(focus.focusReferences).toEqual({ explicit: 6, inferred: 2 });
  });

  it("is deterministic for the same input", async () => {
    const deps = keywordDeps();
    expect(await analyzeVideoSync({ url: VALID_URL }, deps)).toEqual(await analyzeVideoSync({ url: VALID_URL }, deps));
  });

  it("returns blocked_by_policy for YouTube-origin data while CG-1 is closed", async () => {
    const result = await analyzeVideoSync({ url: VALID_URL }, goldDeps({ source: sourceOf([], "youtube") }));
    expect(result).toEqual({ status: "blocked_by_policy", message: expect.stringMatching(/CG-1/) });
  });

  it("ignores request-supplied attempts to weaken the policy", async () => {
    const permissive = createCompliancePolicy({ ...STRICT_POLICY_CONFIG, youtubeDerivedAnalytics: "allowed" });
    const hostileInput = { url: VALID_URL, policy: permissive, youtubeDerivedAnalytics: "allowed", mixedSentimentEnabled: true } as unknown as { url: string };
    const result = await analyzeVideoSync(hostileInput, goldDeps({ source: sourceOf([], "youtube") }));
    expect(result.status).toBe("blocked_by_policy");

    const synthetic = await analyzeVideoSync(hostileInput, goldDeps());
    if (synthetic.status !== "ok") throw new Error("expected ok");
    expect(synthetic.report.methodology.mixedCandidateEnabled).toBe(false);
  });

  it("returns insufficient_data below the minimum sentiment base", async () => {
    const result = await analyzeVideoSync({ url: VALID_URL }, goldDeps({ source: sourceOf([{ id: "m2-c01", text: "x" }]) }));
    expect(result).toMatchObject({ status: "insufficient_data", sentimentBase: 1, minimum: 50 });
  });
});
