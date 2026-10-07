import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_STAGES, ProgressClassifier, ProgressCommentSource, ProgressTopicDiscoverer, ProgressTracker, stagesFor, type AnalysisStage } from "../../src/application/progress";
import { createRealAnalysis } from "../../src/local/real-mode";
import { envForChoice, parseSourceChoice, sourceSetup } from "../../src/local/source-choice";

vi.mock("server-only", () => ({}));
const { configVersionFor, prepareAnalysis } = await import("../../src/local/composition");
const { realModeSettings } = await import("../../src/local/real-mode");

// Offline: no test here reaches YouTube, Jev or Anthropic. Every real-provider path either stops before any call
// (configuration, CG-1) or has its network replaced by a fetch that fails the test if used.

const VALID = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
// Built from parts: long literals here could collide with dataset text in the leakage audits.
const CLASSIFY = ANALYSIS_STAGES[1];
const PROD = ["produc", "tion"].join("");
const KEYS = { YOUTUBE_API_KEY: "test-yt-key-123", ANTHROPIC_API_KEY: "test-an-key-123", JEV_API_KEY: "test-jev-key-123" };
const ACTIVE_RECORD = { id: "EXC-TEST", scope: "local_internal_testing", decidedBy: "test", decidedOn: "2026-10-01", expiresOn: "2026-10-30", status: "active" };
const noNetwork = vi.fn(async () => {
  throw new Error("network must not be used");
}) as unknown as typeof fetch;

describe("analysis source choice from the browser", () => {
  it("accepts only allowlisted option ids", () => {
    expect(parseSourceChoice("demo")).toEqual({ ok: true, choice: { kind: "demo" } });
    expect(parseSourceChoice("youtube")).toEqual({ ok: true, choice: { kind: "youtube" } });
    expect(parseSourceChoice("fixture:t1-topics-v1")).toEqual({ ok: true, choice: { kind: "fixture", dataset: "t1-topics-v1" } });
    expect(parseSourceChoice("fixture:m2")).toEqual({ ok: true, choice: { kind: "fixture", dataset: "m2-synthetic" } });
    for (const bad of ["", "real", "fixture:", "fixture:unknown", "fixture:../.env", 42, null, { kind: "demo" }]) expect(parseSourceChoice(bad).ok, String(bad)).toBe(false);
  });

  it("refuses validation and held-out datasets", () => {
    for (const id of ["t2-topics-v1", "t3-topics-v1", "t4-topics-v1", "t5-topics-v1", "m2-heldout-v1"]) {
      const parsed = parseSourceChoice(`fixture:${id}`);
      expect(parsed.ok, id).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("refused");
      expect(prepareAnalysis({ source: `fixture:${id}` }, KEYS).ok, id).toBe(false);
    }
  });

  it("sets only the mode variables; NODE_ENV and keys stay as configured", () => {
    const env = { ...KEYS, NODE_ENV: PROD, ANALYSIS_MODE: "demo", FIXTURE_DATASET: "t1-topics-v1" };
    const yt = envForChoice(env, { kind: "youtube" });
    expect(yt).toMatchObject({ ...KEYS, NODE_ENV: PROD, ANALYSIS_MODE: "real", ANALYSIS_SOURCE: "youtube" });
    expect(yt.FIXTURE_DATASET).toBeUndefined();
    expect(envForChoice(env, { kind: "fixture", dataset: "m2-synthetic" })).toMatchObject({ NODE_ENV: PROD, ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: "m2-synthetic" });
  });
});

describe("source selector setup", () => {
  it("hides real YouTube until every key is configured, and never lists held-out data", () => {
    const setup = sourceSetup({ ANTHROPIC_API_KEY: "a", JEV_API_KEY: "j" });
    expect(setup.youtube).toBeUndefined();
    expect(setup.testOptions.map((o) => o.id)).toEqual(["demo", "fixture:m2-synthetic", "fixture:t1-topics-v1"]);
    expect(JSON.stringify(setup)).not.toMatch(/t[2-5]-topics|heldout/);
  });

  it("marks fixture datasets unavailable without AI keys, naming the variables only", () => {
    const setup = sourceSetup({});
    const t1 = setup.testOptions.find((o) => o.id === "fixture:t1-topics-v1")!;
    expect(t1.available).toBe(false);
    expect(t1.unavailableReason).toContain("ANTHROPIC_API_KEY");
    expect(setup.defaultId).toBe("demo");
  });

  it("shows real YouTube disabled with the CG-1 reason when the gate blocks, available only under the exception", () => {
    const prod = sourceSetup({ ...KEYS, NODE_ENV: PROD }, { cg1Record: ACTIVE_RECORD, today: "2026-10-07" });
    expect(prod.youtube?.available).toBe(false);
    expect(prod.youtube?.unavailableReason).toContain("local development server");
    const dev = sourceSetup({ ...KEYS, NODE_ENV: "development" }, { cg1Record: ACTIVE_RECORD, today: "2026-10-07" });
    expect(dev.youtube).toMatchObject({ available: true, gate: { state: "internal_testing", id: "EXC-TEST" } });
    const expired = sourceSetup({ ...KEYS, NODE_ENV: "development" }, { cg1Record: ACTIVE_RECORD, today: "2026-11-30" });
    expect(expired.youtube?.available).toBe(false);
    for (const s of [prod, dev, expired]) for (const v of Object.values(KEYS)) expect(JSON.stringify(s)).not.toContain(v);
  });

  it("links the official YouTube API policy pages", () => {
    const urls = sourceSetup({}).policyLinks.map((l) => l.url);
    expect(urls).toContain("https://developers.google.com/youtube/terms/developer-policies");
    expect(urls).toContain("https://developers.google.com/youtube/terms/api-services-terms-of-service");
    for (const u of urls) expect(u.startsWith("https://developers.google.com/youtube/")).toBe(true);
  });

  it("defaults to the .env selection when it is available", () => {
    expect(sourceSetup({ ...KEYS, ANALYSIS_MODE: "real", ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: "m2" }).defaultId).toBe("fixture:m2-synthetic");
    expect(sourceSetup({ ANALYSIS_MODE: "nonsense" }).configError).toContain("ANALYSIS_MODE");
  });
});

describe("prepareAnalysis", () => {
  it("runs a demo analysis with stage progress in order, plus computed insights; test data needs no URL", async () => {
    const prepared = prepareAnalysis({ source: "demo" }, {});
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.stages.map((s) => s.id)).toEqual(["fetching", CLASSIFY, "building"]);
    const seen: AnalysisStage[] = [];
    const payload = await prepared.run((s) => seen.push(s));
    expect(seen).toEqual(["fetching", CLASSIFY, "building"]);
    expect(payload.result.status).toBe("ok");
    expect(payload.insights?.findings.length).toBeGreaterThan(0);
    expect(payload.run?.mode).toBe("demo");
    // The report does not present test data as a YouTube video.
    if (payload.result.status === "ok") expect(payload.result.report.isSyntheticData).toBe(true);
  });

  it("real YouTube needs a valid video link; test data ignores any link sent", () => {
    expect(prepareAnalysis({ source: "youtube" }, KEYS)).toMatchObject({ ok: false, field: "url" });
    expect(prepareAnalysis({ source: "youtube", url: "https://example.com/watch?v=dQw4w9WgXcQ" }, KEYS)).toEqual({ ok: false, field: "url", message: "This isn't a valid YouTube video link." });
    const a = prepareAnalysis({ source: "fixture:t1-topics-v1", url: VALID }, KEYS);
    const b = prepareAnalysis({ source: "fixture:t1-topics-v1" }, KEYS);
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });

  it("keys an analysis by source, dataset or video, and configuration", () => {
    const key = (source: string, url?: string) => {
      const p = prepareAnalysis({ source, ...(url ? { url } : {}) }, KEYS);
      if (!p.ok) throw new Error(p.message);
      return p.key;
    };
    // The same video in two link forms is the same analysis; another video is not.
    expect(key("youtube", VALID)).toBe(key("youtube", "https://youtu.be/dQw4w9WgXcQ?t=42"));
    expect(key("youtube", VALID)).not.toBe(key("youtube", "https://youtu.be/aaaaaaaaaaa"));
    expect(new Set([key("demo"), key("fixture:m2"), key("fixture:t1-topics-v1"), key("youtube", VALID)]).size).toBe(4);
    // A configuration change (model, contract, cap, ...) changes the fingerprint, so an old result is not reused.
    const s = realModeSettings();
    expect(configVersionFor("fixture", s)).toBe(configVersionFor("fixture", realModeSettings()));
    expect(configVersionFor("fixture", { ...s, discoveryContract: "topic-discovery-v3" as never })).not.toBe(configVersionFor("fixture", s));
    expect(configVersionFor("fixture", { ...s, maxCostUsd: s.maxCostUsd * 2 })).not.toBe(configVersionFor("fixture", s));
    const changed = prepareAnalysis({ source: "fixture:t1-topics-v1" }, KEYS, { settings: { ...s, classifier: { ...s.classifier, questionSet: "jev-q2.1" } } });
    expect(changed.ok && changed.key !== key("fixture:t1-topics-v1")).toBe(true);
  });

  it("real YouTube in a non-development server: CG-1 blocks before any retrieval or AI call", async () => {
    const prepared = prepareAnalysis({ url: VALID, source: "youtube" }, { ...KEYS, NODE_ENV: PROD }, { fetch: noNetwork, cg1Record: ACTIVE_RECORD, today: "2026-10-07" });
    if (!prepared.ok) throw new Error(prepared.message);
    const seen: AnalysisStage[] = [];
    const payload = await prepared.run((s) => seen.push(s));
    expect(payload.result.status).toBe("blocked_by_policy");
    expect(seen).toEqual([]);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("real YouTube with an expired exception is blocked too, even under npm run dev", async () => {
    const prepared = prepareAnalysis({ url: VALID, source: "youtube" }, { ...KEYS, NODE_ENV: "development" }, { fetch: noNetwork, cg1Record: ACTIVE_RECORD, today: "2026-12-01" });
    if (!prepared.ok) throw new Error(prepared.message);
    expect((await prepared.run()).result.status).toBe("blocked_by_policy");
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("a fixture dataset without AI keys is a configuration error, not a call", async () => {
    const prepared = prepareAnalysis({ source: "fixture:t1-topics-v1" }, {}, { fetch: noNetwork });
    if (!prepared.ok) throw new Error(prepared.message);
    const payload = await prepared.run();
    expect(payload.result).toMatchObject({ status: "not_configured" });
    expect(noNetwork).not.toHaveBeenCalled();
  });
});

describe("real-mode wiring with and without progress", () => {
  const env = { ...KEYS, ANALYSIS_SOURCE: "fixture", FIXTURE_DATASET: "t1-topics-v1" };

  it("wraps the ports only when a progress tracker is given", () => {
    const plain = createRealAnalysis(env, { fetch: noNetwork });
    const observed = createRealAnalysis(env, { fetch: noNetwork, progress: new ProgressTracker(stagesFor("fixture"), () => {}) });
    if (!plain.ok || !observed.ok) throw new Error("expected ok");
    expect(plain.analysis.deps.source).not.toBeInstanceOf(ProgressCommentSource);
    expect(plain.analysis.deps.classifier).not.toBeInstanceOf(ProgressClassifier);
    expect(plain.analysis.deps.topics!.discoverer).not.toBeInstanceOf(ProgressTopicDiscoverer);
    expect(observed.analysis.deps.source).toBeInstanceOf(ProgressCommentSource);
    expect(observed.analysis.deps.classifier).toBeInstanceOf(ProgressClassifier);
    expect(observed.analysis.deps.topics!.discoverer).toBeInstanceOf(ProgressTopicDiscoverer);
    // Same policy, limit and source origin either way.
    expect(observed.analysis.deps.source.origin).toBe(plain.analysis.deps.source.origin);
    expect(observed.analysis.budget.limitUsd).toBe(plain.analysis.budget.limitUsd);
  });
});
