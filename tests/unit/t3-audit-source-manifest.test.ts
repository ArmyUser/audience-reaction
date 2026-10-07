import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalize, ROOT } from "../heldout/leakage-audit";
import {
  collectFrozenT3Sources,
  frozenModelOutputs,
  frozenPrompts,
  frozenIndependenceChecks,
  frozenReferences,
  FrozenSourceError,
  loadManifest,
  segmentKinds,
  sha256Of,
  T3_SOURCE_MANIFEST_PATH,
  type AuditSourceManifest,
} from "../topics-benchmark/audit-source-manifest";
import { T4_AUDIT } from "../topics-benchmark/holdout-independence-audit";
import { auditT3Texts, checkT3Independence, collectT3Sources, T3_AUDIT_PATH, T3_PATH, t3ModelOutputFiles } from "../topics-benchmark/t3-leakage-audit";

// The t3 independence audit compares against a FROZEN source set: exactly the artifacts that existed when the audit
// was completed (tests/topics-benchmark/manifests/t3-topics-v1-audit-sources.json), each listed with its SHA-256.
// Results stored later cannot change the meaning of the completed audit; the algorithm, thresholds and structural
// checks are unchanged.

const fileText = readFileSync(join(ROOT, T3_PATH), "utf8");
const artifact = JSON.parse(readFileSync(join(ROOT, T3_AUDIT_PATH), "utf8")) as { provenance: { storedResultFiles: number }; sourceSegments: Record<string, number> };
const manifest = loadManifest();
const FROZEN_KINDS = ["model-output", "t1-replay", "prompt", "t1", "t1-gold", "t2", "t2-gold"];
const sha = (path: string) => sha256Of(readFileSync(join(ROOT, path)));
const failedChecks = (outputs: { source: string; strings: string[] }[], text = fileText) => checkT3Independence(text, frozenReferences(manifest), outputs).filter((c) => !c.passed);

/** The result file that triggered the original t3 regression (stored after the t3 audit was completed; not read here). */
const POST_AUDIT_RESULT = "benchmark-results/2026-10-06T11-11-00-740Z-topics-t4-topics-v1-real-consolidated-anthropic-claude-sonnet-5-5-typesafe-jev-latest.json";

/** A temporary root holding byte-identical copies of every frozen file. */
let copyRoot = "";
beforeAll(() => {
  copyRoot = mkdtempSync(join(tmpdir(), "t3-frozen-"));
  for (const path of [manifest.auditArtifact.path, ...manifest.references.map((r) => r.path), ...manifest.replay.map((f) => f.path), ...manifest.modelOutputs.map((f) => f.path)]) {
    mkdirSync(dirname(join(copyRoot, path)), { recursive: true });
    cpSync(join(ROOT, path), join(copyRoot, path));
  }
});
afterAll(() => {
  if (copyRoot) rmSync(copyRoot, { recursive: true, force: true });
});

describe("t3 audit: frozen comparison sources", () => {
  it("the manifest belongs to the completed, unchanged t3 audit and lists every source explicitly with its hash", () => {
    expect(manifest).toMatchObject({ datasetId: "t3-topics-v1", datasetVersion: "sha256:41e90795c48cf637", auditArtifact: { path: T3_AUDIT_PATH, sha256: sha(T3_AUDIT_PATH) } });
    expect(manifest.references.map((r) => r.id)).toEqual(["t1-topics-v1", "t2-topics-v1"]);
    expect(manifest.modelOutputs).toHaveLength(artifact.provenance.storedResultFiles);
    for (const f of [...manifest.references, ...manifest.replay, ...manifest.modelOutputs]) {
      expect(f.sha256, f.path).toMatch(/^[0-9a-f]{64}$/);
      expect(f.path, f.path).not.toMatch(/^\/|\.\./);
    }
    // No file of the audited dataset itself (as in the original audit: none existed).
    expect(manifest.modelOutputs.some((f) => f.path.includes("t3-topics-v1"))).toBe(false);
  });

  it("the frozen set reproduces every source count the completed audit recorded, and the original clean audit", () => {
    const sources = collectFrozenT3Sources(manifest);
    const kinds = segmentKinds(sources);
    for (const kind of FROZEN_KINDS) expect(kinds[kind], kind).toBe(artifact.sourceSegments[kind]);
    expect(manifest.recordedInArtifact.sourceSegments).toEqual(Object.fromEntries(FROZEN_KINDS.map((k) => [k, artifact.sourceSegments[k]])));
    const { comments, gold } = auditT3Texts(JSON.parse(fileText), sources);
    expect([...comments, ...gold].filter((r) => r.violations.length > 0)).toEqual([]);
    expect(failedChecks(frozenModelOutputs(manifest))).toEqual([]);
  }, 120_000);

  it("equals the audit's own collection restricted to the frozen files (same extraction, nothing else dropped)", () => {
    const frozen = new Set(manifest.modelOutputs.map((f) => `model-output:${f.path}`));
    const live = collectT3Sources().filter((s) => !s.source.startsWith("model-output:") || frozen.has(s.source));
    expect(collectFrozenT3Sources(manifest)).toEqual(live);
    const liveOutputs = t3ModelOutputFiles().filter((f) => !f.source.startsWith("model-output:") || frozen.has(f.source));
    expect(frozenModelOutputs(manifest)).toEqual(liveOutputs);
  }, 120_000);
});

describe("results stored after the audit cannot change its verdict", () => {
  it("the original regression: a result stored after the audit made the unfrozen check fail; the frozen audit ignores it", () => {
    // What happened (documented, not read here): a later t4 result, ${POST_AUDIT_RESULT}, describes a lesson topic
    // with the generic word "difficulty", which is also a t3 gold key, and the audit's live listing picked it up.
    // Reproduced with a synthetic later result so this test does not depend on any experiment result file.
    const later = { source: `model-output:${POST_AUDIT_RESULT}`, strings: ["Structure, length, variety, repetition, difficulty progression and effectiveness of the lessons and exercises."] };
    expect(manifest.modelOutputs.some((f) => f.path === POST_AUDIT_RESULT)).toBe(false);
    const unfrozen = failedChecks([...frozenModelOutputs(manifest), later]);
    expect(unfrozen.map((c) => c.check)).toEqual(["no stored model output embedded in the gold (exact or contained, either direction)"]);
    expect(unfrozen[0]!.details).toEqual([`difficulty: "difficulty" in model-output:${POST_AUDIT_RESULT}`]);
    expect(failedChecks(frozenModelOutputs(manifest))).toEqual([]);
    expect(frozenIndependenceChecks(manifest, fileText).filter((c) => !c.passed)).toEqual([]);
  }, 120_000);

  it("adding a new benchmark result, even one that overlaps the t3 gold, leaves the frozen audit unchanged", () => {
    const before = collectFrozenT3Sources(manifest, copyRoot);
    const t3 = JSON.parse(fileText) as { taxonomy: { definition: string }[]; comments: { text: string }[] };
    const later = join(copyRoot, "benchmark-results", "2099-01-01T00-00-00-000Z-topics-later-dataset-real-consolidated.json");
    writeFileSync(later, JSON.stringify({ outputs: [t3.taxonomy[0]!.definition, t3.comments[0]!.text, "difficulty"] }));
    expect(collectFrozenT3Sources(manifest, copyRoot)).toEqual(before);
    expect(failedChecks(frozenModelOutputs(manifest, copyRoot))).toEqual([]);
    rmSync(later);
  }, 120_000);
});

describe("the frozen sources are still enforced", () => {
  /** A prose string from a frozen model output (deterministic: the first long one). */
  const frozenString = () => {
    const outputs = frozenModelOutputs(manifest).filter((f) => f.source.startsWith("model-output:"));
    for (const f of outputs) for (const s of f.strings) if (normalize(s).length >= 40 && normalize(s).split(" ").length >= 6) return { source: f.source, text: s };
    throw new Error("no prose string in the frozen outputs");
  };

  it("a genuinely overlapping artifact in the frozen set still fails the audit (gold and comments)", () => {
    const { source, text } = frozenString();
    const doc = JSON.parse(fileText) as { taxonomy: { key: string; definition: string }[]; comments: { id: string; text: string }[] };
    doc.taxonomy[0]!.definition = text;
    doc.comments[0]!.text = text;
    const failed = failedChecks(frozenModelOutputs(manifest), JSON.stringify(doc));
    expect(failed.map((c) => c.check)).toContain("no stored model output embedded in the gold (exact or contained, either direction)");
    expect(failed.flatMap((c) => c.details).join("\n")).toContain(source);
    const { comments } = auditT3Texts(doc as never, collectFrozenT3Sources(manifest));
    expect(comments.find((c) => c.id === doc.comments[0]!.id)!.violations.join()).toContain(source);
  }, 120_000);

  it("a frozen source that is missing or changed is an error, never silently skipped", () => {
    const victim = manifest.modelOutputs[0]!.path;
    const original = readFileSync(join(copyRoot, victim));
    writeFileSync(join(copyRoot, victim), Buffer.concat([original, Buffer.from(" ")]));
    expect(() => frozenModelOutputs(manifest, copyRoot)).toThrow(FrozenSourceError);
    rmSync(join(copyRoot, victim));
    expect(() => frozenModelOutputs(manifest, copyRoot)).toThrow(/missing/);
    writeFileSync(join(copyRoot, victim), original);
    expect(() => frozenModelOutputs(manifest, copyRoot)).not.toThrow();

    const changedRef: AuditSourceManifest = { ...manifest, references: [{ ...manifest.references[0]!, sha256: "0".repeat(64) }, manifest.references[1]!] };
    expect(() => frozenReferences(changedRef)).toThrow(/changed/);
    const changedPrompt: AuditSourceManifest = { ...manifest, prompts: [{ ...manifest.prompts[0]!, sha256: "0".repeat(64) }, ...manifest.prompts.slice(1)] };
    expect(() => frozenPrompts(changedPrompt)).toThrow(/frozen prompt changed/);
    const wrongCount: AuditSourceManifest = { ...manifest, modelOutputs: [{ ...manifest.modelOutputs[0]!, segments: 1 }, ...manifest.modelOutputs.slice(1)] };
    expect(() => frozenModelOutputs(wrongCount)).toThrow(/segments/);
  });
});

describe("unchanged artifacts and implementations", () => {
  const PINNED: Record<string, string> = {
    "fixtures/t3-topics-v1/comments.json": "41e90795c48cf63709eb1835190c9aca80dc0fd030b9c3a2161b1bc408285269",
    "fixtures/t3-topics-v1/leakage-audit.json": "dc3345bf70597f2c86ce56bf6f5cfdf9f0d2480ed7bff18d491dac8a8c4327fd",
    "fixtures/t4-topics-v1/comments.json": "58e225f986238591de8687faab59b9445e5d22088d1a3666382ba5e2043292fd",
    "fixtures/t4-topics-v1/leakage-audit.json": "4be0493cd657ca3b8a2c95030ec90df197cc68ded3b5e9c1892170331e86eb3a",
    "tests/topics-benchmark/t3-leakage-audit.ts": "1fde2b00ca938e6f35be2eca9affe38fe06ccb1647b28dc8b4824211632e404c",
    "tests/topics-benchmark/holdout-independence-audit.ts": "69cdc8844a81c37d7c28c5289681a66034eb7d17063e4a6780c935d48b45efd6",
    "tests/heldout/leakage-audit.ts": "72fabdd7f83145a818b96f22b0904eba7829a400770a0912c396aa4f4f6cd42f",
  };

  it("the t3 dataset and audit artifact, the t4 audit and the audit implementations are byte-identical", () => {
    for (const [path, hash] of Object.entries(PINNED)) expect(sha(path), path).toBe(hash);
  });

  it("the t4 audit is unchanged: same configuration, references and own-file rule", () => {
    expect(T4_AUDIT.config).toMatchObject({ datasetId: "t4-topics-v1", path: "fixtures/t4-topics-v1/comments.json", auditPath: "fixtures/t4-topics-v1/leakage-audit.json" });
    expect(T4_AUDIT.config.references.map((r) => r.id)).toEqual(["t1-topics-v1", "t2-topics-v1", "t3-topics-v1"]);
  });

  it("the manifest path is the one the audit documents", () => {
    expect(T3_SOURCE_MANIFEST_PATH).toBe("tests/topics-benchmark/manifests/t3-topics-v1-audit-sources.json");
  });
});
