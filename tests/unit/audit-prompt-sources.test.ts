import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalize, ROOT } from "../heldout/leakage-audit";
import {
  collectFrozenSources,
  FROZEN_AUDITS,
  frozenIndependenceChecks,
  frozenPrompts,
  frozenReferences,
  FrozenSourceError,
  loadManifest,
  promptTextOverlaps,
  segmentKinds,
  sha256Of,
  type AuditArtifact,
  type AuditSourceManifest,
  type FrozenAuditDefinition,
} from "../topics-benchmark/audit-source-manifest";
import type { DatasetDoc } from "../topics-benchmark/t3-leakage-audit";

// Frozen prompt sources of the completed t2, t3 and t4 independence audits. Prompts are rendered from the contract
// code, so each frozen prompt source is a rendered prompt identified by its stable id (e.g.
// "prompt:topic-consolidation-v4:retry") with the SHA-256 of its text when the audit was completed. The prompt-text
// structural check and the lexical prompt sources both use exactly that set: a prompt or contract added later, under
// any name, cannot change a completed audit, while a changed, missing or omitted frozen prompt fails loudly.

const AUDITS = [
  { datasetId: "t2-topics-v1", path: "fixtures/t2-topics-v1/comments.json" },
  { datasetId: "t3-topics-v1", path: "fixtures/t3-topics-v1/comments.json" },
  { datasetId: "t4-topics-v1", path: "fixtures/t4-topics-v1/comments.json" },
] as const;

describe.each(AUDITS)("$datasetId: frozen prompt sources", ({ datasetId, path }) => {
  const def = FROZEN_AUDITS[datasetId]!;
  const manifest = loadManifest(def.manifestPath);
  const artifact = JSON.parse(readFileSync(join(ROOT, def.artifactPath), "utf8")) as AuditArtifact;
  const text = readFileSync(join(ROOT, path), "utf8");
  const withPrompts = (promptTexts: FrozenAuditDefinition["promptTexts"]): FrozenAuditDefinition => ({ ...def, promptTexts });
  const promptCheckOf = (checks: { check: string; passed: boolean; details: string[] }[]) => checks.find((c) => c.check === def.promptCheck)!;

  it("lists every prompt source explicitly with a SHA-256 of its rendered text", () => {
    expect(manifest.prompts.length).toBeGreaterThan(0);
    for (const p of manifest.prompts) {
      expect(p.source, p.source).toMatch(/^prompt:/);
      expect(p.sha256, p.source).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(manifest.prompts.map((p) => p.source)).size).toBe(manifest.prompts.length);
  });

  it("the frozen prompt set reproduces the original audit: recorded prompt segments, same check result as the audit's own", () => {
    const prompts = frozenPrompts(manifest);
    expect(segmentKinds(collectFrozenSources(manifest)).prompt).toBe(artifact.sourceSegments.prompt);
    // Today the current prompt list is exactly the frozen one, so the frozen rule must equal the audit's own check.
    expect(def.promptTexts().map((p) => p.source)).toEqual(prompts.map((p) => p.source));
    const own = promptCheckOf(def.checkIndependence(text, frozenReferences(manifest), []));
    expect(promptCheckOf(frozenIndependenceChecks(manifest, text))).toEqual(own);
    expect(own).toMatchObject({ passed: true, details: [] });
    expect(frozenIndependenceChecks(manifest, text).filter((c) => !c.passed)).toEqual([]);
  }, 180_000);

  it("modifying a frozen prompt fails loudly; so does a missing one or one omitted from the manifest", () => {
    const changed = withPrompts(() => def.promptTexts().map((p, i) => (i === 0 ? { ...p, text: `${p.text} ` } : p)));
    expect(() => frozenPrompts(manifest, changed)).toThrow(/frozen prompt changed/);
    expect(() => frozenIndependenceChecks(manifest, text, ROOT, changed)).toThrow(FrozenSourceError);
    expect(() => collectFrozenSources(manifest, ROOT, changed)).toThrow(/frozen prompt changed/);
    const missing = withPrompts(() => def.promptTexts().slice(1));
    expect(() => frozenPrompts(manifest, missing)).toThrow(/frozen prompt missing/);
    const omitted: AuditSourceManifest = { ...manifest, prompts: manifest.prompts.slice(0, -1) };
    expect(() => frozenPrompts(omitted)).toThrow(/incomplete or altered/);
    expect(() => frozenIndependenceChecks(omitted, text)).toThrow(/incomplete or altered/);
  }, 180_000);

  it("the classifier prompts among the repository texts are frozen too: changed or omitted fails", () => {
    expect(manifest.repositoryPrompts.map((g) => g.source)).toEqual(["prompt:llm"]);
    expect(manifest.prompts.length > 0 && manifest.repositoryPrompts[0]!.segments > 0).toBe(true);
    const changed: AuditSourceManifest = { ...manifest, repositoryPrompts: [{ ...manifest.repositoryPrompts[0]!, sha256: "0".repeat(64) }] };
    expect(() => collectFrozenSources(changed)).toThrow(/frozen prompt changed: prompt:llm/);
    const renamed: AuditSourceManifest = { ...manifest, repositoryPrompts: [{ ...manifest.repositoryPrompts[0]!, source: "prompt:llm-v0" }] };
    expect(() => collectFrozenSources(renamed)).toThrow(/frozen prompt missing: prompt:llm-v0/);
    const omitted: AuditSourceManifest = { ...manifest, repositoryPrompts: [] };
    expect(() => frozenPrompts(omitted)).toThrow(/incomplete or altered/);
  }, 180_000);

  it("adding a new prompt after the freeze does not affect the completed audit, whatever it is named", () => {
    const doc = JSON.parse(text) as DatasetDoc;
    // A later contract whose prompt happens to contain one of the audited comments verbatim.
    const extra = [
      { source: "prompt:topic-consolidation-v9", text: `New rules.\n${doc.comments[0]!.text}\nMore rules.` },
      { source: "prompt:discovery:v3", text: `Quote: ${doc.taxonomy[0]!.definition}` },
    ];
    const later = withPrompts(() => [...def.promptTexts(), ...extra]);
    expect(promptTextOverlaps(text, extra)).not.toEqual([]); // it WOULD overlap if it were (wrongly) part of the set
    expect(collectFrozenSources(manifest, ROOT, later)).toEqual(collectFrozenSources(manifest));
    expect(frozenIndependenceChecks(manifest, text, ROOT, later)).toEqual(frozenIndependenceChecks(manifest, text));
    expect(frozenIndependenceChecks(manifest, text, ROOT, later).filter((c) => !c.passed)).toEqual([]);
  }, 180_000);

  it("genuine overlap with a frozen prompt is still detected, exactly as the audit's own check detects it", () => {
    const prompts = frozenPrompts(manifest);
    const sentence = prompts.flatMap((p) => p.text.split("\n")).find((l) => normalize(l).length >= 40)!;
    const doc = JSON.parse(text) as DatasetDoc & { comments: { id: string; text: string }[] };
    doc.comments[3]!.text = sentence;
    doc.taxonomy[1]!.definition = sentence.slice(0, 60);
    const probe = JSON.stringify(doc);
    const frozen = promptCheckOf(frozenIndependenceChecks(manifest, probe));
    expect(frozen.passed).toBe(false);
    expect(frozen.details.join("\n")).toContain(`${doc.comments[3]!.id} in prompt:`);
    expect(frozen.details.join("\n")).toContain(`gold:${doc.taxonomy[1]!.key} in prompt:`);
    expect(frozen).toEqual(promptCheckOf(def.checkIndependence(probe, frozenReferences(manifest), [])));
  }, 180_000);

  it("the manifest's prompt list is bound to the completed artifact", () => {
    expect(manifest.auditArtifact.sha256).toBe(sha256Of(readFileSync(join(ROOT, def.artifactPath))));
    expect(manifest.recordedInArtifact.sourceSegments.prompt).toBe(artifact.sourceSegments.prompt);
  });
});

describe("the frozen prompt sets differ per audit, as the audits did", () => {
  it("t2 and t3 froze the default consolidation prompt; t4 froze every contract version that existed then (v3, v4)", () => {
    const sources = (id: string) => loadManifest(FROZEN_AUDITS[id]!.manifestPath).prompts.map((p) => p.source);
    expect(sources("t2-topics-v1")).toEqual(sources("t3-topics-v1"));
    expect(sources("t3-topics-v1")).toContain("prompt:consolidation");
    expect(sources("t4-topics-v1").filter((s) => s.includes("consolidation"))).toEqual(["prompt:topic-consolidation-v3", "prompt:topic-consolidation-v3:retry", "prompt:topic-consolidation-v4", "prompt:topic-consolidation-v4:retry"]);
  });
});
