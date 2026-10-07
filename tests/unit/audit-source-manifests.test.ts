import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalize, ROOT, type Segment } from "../heldout/leakage-audit";
import {
  buildFrozenManifest,
  collectFrozenSources,
  FROZEN_AUDITS,
  frozenKinds,
  frozenModelOutputs,
  frozenReferences,
  FrozenSourceError,
  loadManifest,
  segmentKinds,
  sha256Of,
  T3_SOURCE_MANIFEST_PATH,
  type AuditArtifact,
  type AuditSourceManifest,
} from "../topics-benchmark/audit-source-manifest";
import { T4_AUDIT } from "../topics-benchmark/holdout-independence-audit";
import type { T1CommentAudit } from "../topics-benchmark/t1-leakage-audit";
import { auditT2Texts, checkT2Independence, T2_PATH } from "../topics-benchmark/t2-leakage-audit";
import type { DatasetDoc } from "../topics-benchmark/t3-leakage-audit";

// Frozen comparison sources for the completed t2 and t4 independence audits (the t3 audit has its own focused tests in
// t3-audit-source-manifest.test.ts). Each manifest lists exactly the artifacts the audit compared against, with SHA-256,
// and reproduces the source counts the stored audit artifact recorded. The audits' algorithms, thresholds and
// structural checks are unchanged; only the set of comparison sources they receive is frozen.

type Check = { check: string; passed: boolean; details: string[] };
interface Case {
  datasetId: "t2-topics-v1" | "t4-topics-v1";
  path: string;
  /** The audit's own lexical audit and structural checks, unchanged. */
  audit: (doc: DatasetDoc, sources: readonly Segment[]) => { comments: T1CommentAudit[]; gold: T1CommentAudit[] };
  check: (text: string, references: DatasetDoc[], outputs: { source: string; strings: string[] }[]) => Check[];
  modelOutputCheck: string;
}

const CASES: Case[] = [
  {
    datasetId: "t2-topics-v1",
    path: T2_PATH,
    audit: (doc, sources) => auditT2Texts(doc as never, sources),
    check: (text, refs, outputs) => checkT2Independence(text, refs[0]! as never, outputs),
    modelOutputCheck: "no stored model output embedded in the gold (exact or contained, either direction)",
  },
  {
    datasetId: "t4-topics-v1",
    path: T4_AUDIT.config.path,
    audit: (doc, sources) => T4_AUDIT.auditTexts(doc, sources),
    check: (text, refs, outputs) => T4_AUDIT.checkIndependence(text, refs, outputs),
    modelOutputCheck: "no stored model output embedded in the gold (exact or contained, either direction)",
  },
];

const sha = (path: string) => sha256Of(readFileSync(join(ROOT, path)));
const copyFrozen = (manifest: AuditSourceManifest): string => {
  const root = mkdtempSync(join(tmpdir(), `${manifest.datasetId}-frozen-`));
  for (const path of [manifest.auditArtifact.path, ...manifest.references.map((r) => r.path), ...manifest.replay.map((f) => f.path), ...manifest.modelOutputs.map((f) => f.path)]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path));
  }
  return root;
};

describe.each(CASES)("$datasetId audit: frozen comparison sources", (c) => {
  const def = FROZEN_AUDITS[c.datasetId]!;
  const manifest = loadManifest(def.manifestPath);
  const artifact = JSON.parse(readFileSync(join(ROOT, def.artifactPath), "utf8")) as AuditArtifact;
  const text = readFileSync(join(ROOT, c.path), "utf8");
  let copyRoot = "";
  beforeAll(() => {
    copyRoot = copyFrozen(manifest);
  });
  afterAll(() => {
    if (copyRoot) rmSync(copyRoot, { recursive: true, force: true });
  });

  it("belongs to the completed, unchanged audit and lists every source explicitly with its hash", () => {
    expect(manifest).toMatchObject({ datasetId: c.datasetId, datasetVersion: artifact.datasetVersion, auditArtifact: { path: def.artifactPath, sha256: sha(def.artifactPath) } });
    expect(manifest.references.map((r) => r.id)).toEqual(def.references.map((r) => r.id));
    expect(manifest.modelOutputs).toHaveLength(def.storedResultFilesAtAudit(artifact));
    for (const f of [...manifest.references, ...manifest.replay, ...manifest.modelOutputs]) {
      expect(f.sha256, f.path).toMatch(/^[0-9a-f]{64}$/);
      expect(f.path, f.path).not.toMatch(/^\/|\.\./);
    }
    expect(manifest.modelOutputs.some((f) => f.path.includes(c.datasetId))).toBe(false);
  });

  it("1. the frozen source counts match the audit artifact, and the audit is clean on them", () => {
    const sources = collectFrozenSources(manifest);
    const kinds = segmentKinds(sources);
    for (const kind of frozenKinds(def)) expect(kinds[kind], kind).toBe(artifact.sourceSegments[kind]);
    expect(manifest.recordedInArtifact.sourceSegments).toEqual(Object.fromEntries(frozenKinds(def).map((k) => [k, artifact.sourceSegments[k]])));
    const { comments, gold } = c.audit(JSON.parse(text), sources);
    expect([...comments, ...gold].filter((r) => r.violations.length > 0)).toEqual([]);
    expect(c.check(text, frozenReferences(manifest), frozenModelOutputs(manifest)).filter((x) => !x.passed)).toEqual([]);
  }, 180_000);

  it("equals the audit's own collection restricted to the frozen files (same extraction, nothing else dropped)", () => {
    const frozen = new Set(manifest.modelOutputs.map((f) => `model-output:${f.path}`));
    expect(collectFrozenSources(manifest)).toEqual(def.liveSources().filter((s) => !s.source.startsWith("model-output:") || frozen.has(s.source)));
    expect(frozenModelOutputs(manifest)).toEqual(def.liveModelOutputs().filter((f) => !f.source.startsWith("model-output:") || frozen.has(f.source)));
  }, 180_000);

  it("2. adding a future benchmark result, even one overlapping the audited gold, does not change the audit", () => {
    const before = collectFrozenSources(manifest, copyRoot);
    const doc = JSON.parse(text) as DatasetDoc;
    const later = join(copyRoot, "benchmark-results", "2099-01-01T00-00-00-000Z-topics-later-dataset-real-consolidated.json");
    writeFileSync(later, JSON.stringify({ outputs: [doc.taxonomy[0]!.definition, doc.taxonomy[0]!.name, doc.comments[0]!.text] }));
    expect(collectFrozenSources(manifest, copyRoot)).toEqual(before);
    expect(c.check(text, frozenReferences(manifest, copyRoot), frozenModelOutputs(manifest, copyRoot)).filter((x) => !x.passed)).toEqual([]);
    rmSync(later);
  }, 180_000);

  it("3. a modified or removed frozen source fails loudly", () => {
    const victim = manifest.modelOutputs[manifest.modelOutputs.length - 1]!.path;
    const original = readFileSync(join(copyRoot, victim));
    writeFileSync(join(copyRoot, victim), Buffer.concat([original, Buffer.from("\n")]));
    expect(() => frozenModelOutputs(manifest, copyRoot)).toThrow(FrozenSourceError);
    expect(() => collectFrozenSources(manifest, copyRoot)).toThrow(/changed/);
    rmSync(join(copyRoot, victim));
    expect(() => frozenModelOutputs(manifest, copyRoot)).toThrow(/missing/);
    writeFileSync(join(copyRoot, victim), original);
    expect(() => frozenModelOutputs(manifest, copyRoot)).not.toThrow();
    const replay = manifest.replay[0]!.path;
    rmSync(join(copyRoot, replay));
    expect(() => frozenModelOutputs(manifest, copyRoot)).toThrow(/missing/);
    cpSync(join(ROOT, replay), join(copyRoot, replay));
    const ref = manifest.references[0]!.path;
    writeFileSync(join(copyRoot, ref), "{}");
    expect(() => frozenReferences(manifest, copyRoot)).toThrow(/changed/);
    cpSync(join(ROOT, ref), join(copyRoot, ref));
    const changedPrompt: AuditSourceManifest = { ...manifest, prompts: [{ ...manifest.prompts[0]!, sha256: "0".repeat(64) }, ...manifest.prompts.slice(1)] };
    expect(() => collectFrozenSources(changedPrompt)).toThrow(/frozen prompt changed/);
  }, 180_000);

  it("4. genuine overlaps with frozen historical sources are still detected (model output and reference dataset)", () => {
    const outputs = frozenModelOutputs(manifest).filter((f) => f.source.startsWith("model-output:"));
    const hit = outputs.flatMap((f) => f.strings.filter((s) => normalize(s).length >= 40 && normalize(s).split(" ").length >= 6).map((s) => ({ source: f.source, text: s })))[0]!;
    const reference = frozenReferences(manifest)[0]!;
    const doc = JSON.parse(text) as DatasetDoc;
    doc.taxonomy[0]!.definition = hit.text;
    doc.comments[0]!.text = hit.text;
    doc.comments[1]!.text = reference.comments[5]!.text;
    const failed = c.check(JSON.stringify(doc), frozenReferences(manifest), frozenModelOutputs(manifest)).filter((x) => !x.passed);
    expect(failed.map((x) => x.check)).toContain(c.modelOutputCheck);
    expect(failed.flatMap((x) => x.details).join("\n")).toContain(hit.source);
    // The reference-text check (each audit words it its own way) names the copied comment.
    const textCheck = failed.find((x) => /comment text/.test(x.check))!;
    expect(textCheck.details.join("\n")).toContain(doc.comments[1]!.id);
    const { comments } = c.audit(doc, collectFrozenSources(manifest));
    expect(comments.find((x) => x.id === doc.comments[0]!.id)!.violations.join()).toContain(hit.source);
    expect(comments.find((x) => x.id === doc.comments[1]!.id)!.violations.join()).toContain(`${reference.datasetId.slice(0, 2)}:${reference.comments[5]!.id}`);
  }, 180_000);
});

describe("5. the t3 audit stays frozen and green under the shared mechanism", () => {
  it("the generic builder reproduces the stored t3 manifest exactly (apart from its derivation wording)", () => {
    const stored = loadManifest(T3_SOURCE_MANIFEST_PATH);
    const { manifest, problems } = buildFrozenManifest(FROZEN_AUDITS["t3-topics-v1"]!);
    expect(problems).toEqual([]);
    const { derivation: _a, ...rebuilt } = manifest!;
    const { derivation: _b, ...frozen } = stored;
    expect(rebuilt).toEqual(frozen);
  }, 180_000);

  it("the builder refuses a source set that does not reproduce the artifact", () => {
    const def = FROZEN_AUDITS["t2-topics-v1"]!;
    const { manifest, problems } = buildFrozenManifest({ ...def, storedResultFilesAtAudit: (a) => def.storedResultFilesAtAudit(a) + 1 });
    expect(manifest).toBeNull();
    expect(problems.join()).toMatch(/model-output: \d+ reproduced, 42520 recorded/);
  }, 180_000);
});

describe("unchanged audits and artifacts", () => {
  it("dataset versions are the audited ones", () => {
    for (const c of CASES) {
      const artifact = JSON.parse(readFileSync(join(ROOT, FROZEN_AUDITS[c.datasetId]!.artifactPath), "utf8")) as AuditArtifact;
      expect(`sha256:${sha(c.path).slice(0, 16)}`).toBe(artifact.datasetVersion);
    }
  });

  it("the datasets, stored audit artifacts and audit implementations are byte-identical to the completed audits", () => {
    const pinned: Record<string, string> = {
      "fixtures/t2-topics-v1/comments.json": "c0087c94db1713b2fff1ca271472e02867ba09b5f6d8a0451ce0456bd0018307",
      "fixtures/t2-topics-v1/leakage-audit.json": "2aa670b95293a77113186419f9ab9a1f745e7151ebe061a162bc280c31840f70",
      "fixtures/t4-topics-v1/comments.json": "58e225f986238591de8687faab59b9445e5d22088d1a3666382ba5e2043292fd",
      "fixtures/t4-topics-v1/leakage-audit.json": "4be0493cd657ca3b8a2c95030ec90df197cc68ded3b5e9c1892170331e86eb3a",
      "tests/topics-benchmark/t2-leakage-audit.ts": "15c4a1f7e115c64338558366ffa51125a5865a64117ec9eed0e053e39ee81ce0",
      "tests/topics-benchmark/holdout-independence-audit.ts": "69cdc8844a81c37d7c28c5289681a66034eb7d17063e4a6780c935d48b45efd6",
      "tests/topics-benchmark/t1-leakage-audit.ts": "67c3a5d788ddebfeb188cc4b2d61c85fdc5240d42074bce54bfdbb11a0cf1d4b",
      "tests/heldout/leakage-audit.ts": "72fabdd7f83145a818b96f22b0904eba7829a400770a0912c396aa4f4f6cd42f",
    };
    for (const [path, hash] of Object.entries(pinned)) expect(sha(path), path).toBe(hash);
    for (const c of CASES) expect(loadManifest(FROZEN_AUDITS[c.datasetId]!.manifestPath).auditArtifact.sha256).toBe(sha(FROZEN_AUDITS[c.datasetId]!.artifactPath));
  });
});
