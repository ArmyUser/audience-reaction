import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, ROOT, type Segment } from "../heldout/leakage-audit";
import { T4_AUDIT } from "./holdout-independence-audit";
import { T5_AUDIT } from "./t5-holdout-audit";
import { collectT1Sources, T1_PATH } from "./t1-leakage-audit";
import { checkT2Independence, collectT2Sources, modelOutputFiles as t2ModelOutputFiles, T2_AUDIT_PATH, topicPromptTexts } from "./t2-leakage-audit";
import { checkT3Independence, collectT3Sources, T3_AUDIT_PATH, T3_REFERENCES, t3ModelOutputFiles, type DatasetDoc } from "./t3-leakage-audit";

// Frozen comparison sources for a completed independence audit. An audit compares a hold-out set against the source
// artifacts that existed when it was written; a manifest lists exactly those artifacts (explicit paths or stable ids,
// each with its SHA-256), so results added later can never change the meaning of a completed audit. Nothing is
// excluded by keyword or dataset name: a source is in the manifest or it is not, and every listed source must still be
// present and byte-identical, or loading fails loudly. The audits' algorithms, thresholds and structural checks are
// their own, unchanged; only the set of comparison sources they receive is frozen.
//
// Frozen categories: the reference datasets (comments and gold), the recorded replay responses, the topic prompts and
// the stored live model outputs. The repository texts the t1 audit covers (guidelines, spec, design, tests, fakes, m2
// sets) are read as before.

export const AUDIT_SOURCE_MANIFEST_SCHEMA = "audit-source-manifest-v1";
export const MANIFEST_DIR = "tests/topics-benchmark/manifests";
export const T3_SOURCE_MANIFEST_PATH = `${MANIFEST_DIR}/t3-topics-v1-audit-sources.json`;

/** One completed audit whose comparison sources are frozen: its own source rules, unchanged. */
export interface FrozenAuditDefinition {
  datasetId: string;
  artifactPath: string;
  manifestPath: string;
  /** The audit's own rule for test files that hold the audited texts (excluded from the sources). */
  ownFiles: RegExp;
  /** The earlier datasets the audit compares against. */
  references: readonly { id: string; path: string }[];
  /** The audit's own prompt list (current rendering; verified against the frozen hashes, never used unverified). */
  promptTexts: () => { source: string; text: string }[];
  /** The audit's own structural checks, unchanged. */
  checkIndependence: (text: string, references: DatasetDoc[], modelOutputs: { source: string; strings: string[] }[]) => IndependenceCheck[];
  /** Exact name of the audit's prompt-text structural check (the one check whose input is the prompt list). */
  promptCheck: string;
  /** The audit's own live listing of stored model outputs (used once by the writer, and by equivalence tests). */
  liveModelOutputs: () => { source: string; strings: string[] }[];
  /** The audit's own live source collection (equivalence tests only). */
  liveSources: () => Segment[];
  /** Number of stored result files the artifact recorded as present at audit time (none of them the audited set's own). */
  storedResultFilesAtAudit: (artifact: AuditArtifact) => number;
}

export interface IndependenceCheck {
  check: string;
  passed: boolean;
  details: string[];
}

export interface AuditArtifact {
  datasetId: string;
  datasetVersion: string;
  provenance: { storedResultFiles: number } & Record<string, unknown>;
  sourceSegments: Record<string, number>;
}

/** Results the artifact recorded as the audited set's own (always empty: gold predates every provider run). */
const ownResults = (a: AuditArtifact): number => {
  const own = (a.provenance.t2ResultFiles ?? a.provenance.t3ResultFiles ?? a.provenance.ownResultFiles) as string[] | undefined;
  if (!Array.isArray(own)) throw new Error(`${a.datasetId}: the artifact does not record its own result files`);
  return own.length;
};

export const FROZEN_AUDITS: Readonly<Record<string, FrozenAuditDefinition>> = Object.freeze({
  "t2-topics-v1": {
    datasetId: "t2-topics-v1",
    artifactPath: T2_AUDIT_PATH,
    manifestPath: `${MANIFEST_DIR}/t2-topics-v1-audit-sources.json`,
    ownFiles: /^test:tests\/(topics-benchmark\/|unit\/t2-)/,
    references: [{ id: "t1-topics-v1", path: T1_PATH }],
    promptTexts: topicPromptTexts,
    checkIndependence: (text, refs, outputs) => checkT2Independence(text, refs[0]! as Parameters<typeof checkT2Independence>[1], outputs),
    promptCheck: "no topic prompt text in a t2 comment or gold text (exact or contained)",
    liveModelOutputs: t2ModelOutputFiles,
    liveSources: collectT2Sources,
    storedResultFilesAtAudit: (a) => a.provenance.storedResultFiles - ownResults(a),
  },
  "t3-topics-v1": {
    datasetId: "t3-topics-v1",
    artifactPath: T3_AUDIT_PATH,
    manifestPath: T3_SOURCE_MANIFEST_PATH,
    ownFiles: /^test:tests\/(topics-benchmark\/|unit\/t3-)/,
    references: T3_REFERENCES,
    promptTexts: topicPromptTexts,
    checkIndependence: checkT3Independence,
    promptCheck: "no topic prompt text in a t3 comment or gold text (exact or contained)",
    liveModelOutputs: t3ModelOutputFiles,
    liveSources: collectT3Sources,
    storedResultFilesAtAudit: (a) => a.provenance.storedResultFiles - ownResults(a),
  },
  "t4-topics-v1": {
    datasetId: "t4-topics-v1",
    artifactPath: T4_AUDIT.config.auditPath,
    manifestPath: `${MANIFEST_DIR}/t4-topics-v1-audit-sources.json`,
    ownFiles: T4_AUDIT.config.ownFiles,
    references: T4_AUDIT.config.references,
    promptTexts: T4_AUDIT.promptTexts,
    checkIndependence: T4_AUDIT.checkIndependence,
    promptCheck: "no topic prompt text (any contract version) in a comment or gold text (exact or contained)",
    liveModelOutputs: T4_AUDIT.modelOutputFiles,
    liveSources: T4_AUDIT.collectSources,
    storedResultFilesAtAudit: (a) => a.provenance.storedResultFiles - ownResults(a),
  },
  // Frozen at creation. Its document sources are frozen by the same manifest (documents: path, SHA-256, segments);
  // see t5-holdout-audit.ts.
  "t5-topics-v1": {
    datasetId: "t5-topics-v1",
    artifactPath: T5_AUDIT.config.auditPath,
    manifestPath: `${MANIFEST_DIR}/t5-topics-v1-audit-sources.json`,
    ownFiles: T5_AUDIT.config.ownFiles,
    references: T5_AUDIT.config.references,
    promptTexts: T5_AUDIT.promptTexts,
    checkIndependence: T5_AUDIT.checkIndependence,
    promptCheck: "no topic prompt text (any contract version) in a comment or gold text (exact or contained)",
    liveModelOutputs: T5_AUDIT.modelOutputFiles,
    liveSources: T5_AUDIT.collectSources,
    storedResultFilesAtAudit: (a) => a.provenance.storedResultFiles - ownResults(a),
  },
});

/** Source kinds whose content is frozen by a manifest (checked against the artifact's recorded counts). */
export function frozenKinds(def: FrozenAuditDefinition): string[] {
  return ["model-output", "t1-replay", "prompt", ...def.references.flatMap((r) => [r.id.slice(0, 2), `${r.id.slice(0, 2)}-gold`])];
}

export interface FrozenFile {
  path: string;
  sha256: string;
  /** Segments the audit takes from this file (strings with ≥ 3 normalised characters). */
  segments: number;
}

export interface AuditSourceManifest {
  schema: typeof AUDIT_SOURCE_MANIFEST_SCHEMA;
  datasetId: string;
  datasetVersion: string;
  /** The completed audit artifact this manifest belongs to (byte-identical). */
  auditArtifact: { path: string; sha256: string };
  /** How the source set was established and cross-checked against the artifact. */
  derivation: string[];
  references: { id: string; path: string; sha256: string }[];
  /** Topic prompts as the audit renders them: stable id and SHA-256 of the text. */
  prompts: { source: string; sha256: string }[];
  /**
   * Prompt sources among the repository texts of the t1 audit (the classifier instructions, "prompt:llm"): stable id,
   * number of segments and SHA-256 of those segment texts in order.
   */
  repositoryPrompts: { source: string; segments: number; sha256: string }[];
  replay: FrozenFile[];
  modelOutputs: FrozenFile[];
  /** Counts recorded in the audit artifact itself, reproduced by this source set. */
  recordedInArtifact: { storedResultFiles: number; sourceSegments: Record<string, number> };
}

export class FrozenSourceError extends Error {
  override readonly name = "FrozenSourceError";
}

export const sha256Of = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export function definitionOf(datasetId: string): FrozenAuditDefinition {
  const def = FROZEN_AUDITS[datasetId];
  if (!def) throw new FrozenSourceError(`no frozen audit definition for ${datasetId}`);
  return def;
}

export function loadManifest(path = T3_SOURCE_MANIFEST_PATH): AuditSourceManifest {
  const manifest = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as AuditSourceManifest;
  if (manifest.schema !== AUDIT_SOURCE_MANIFEST_SCHEMA) throw new FrozenSourceError(`${path}: unknown manifest schema ${String(manifest.schema)}`);
  return manifest;
}

// The extraction helpers below are the audits' own (identical in t2-, t3-leakage-audit.ts and the hold-out audit),
// repeated here because those frozen modules do not export them; the manifest tests prove the frozen collection
// equals each audit's own live collection on the manifest's files.

function proseSegments(source: string, text: string): Segment[] {
  const parts = new Set<string>([text]);
  for (const line of text.split("\n")) {
    parts.add(line);
    for (const s of line.split(/(?<=[.!?])\s+/)) parts.add(s);
  }
  return [...parts].filter((p) => normalize(p).length > 0).map((p) => ({ source, text: p }));
}

export function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) jsonStrings(v, out);
  return out;
}

export function responseStrings(raw: string): string[] {
  const body = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    return jsonStrings(JSON.parse(body));
  } catch {
    return [raw];
  }
}

export const auditSegmentCount = (strings: readonly string[]): number => strings.filter((s) => normalize(s).length >= 3).length;

/** Reads a listed file and checks it is still byte-identical; a missing or changed source is an error, never skipped. */
function readFrozen(root: string, path: string, sha: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, path));
  } catch {
    throw new FrozenSourceError(`frozen audit source missing: ${path}`);
  }
  if (sha256Of(bytes) !== sha) throw new FrozenSourceError(`frozen audit source changed: ${path}`);
  return bytes.toString("utf8");
}

/** The frozen reference datasets, verified. */
export function frozenReferences(manifest: AuditSourceManifest, root = ROOT): DatasetDoc[] {
  return manifest.references.map((r) => JSON.parse(readFrozen(root, r.path, r.sha256)) as DatasetDoc);
}

/** The frozen stored model outputs (replay responses and live results), verified; the audit's model-output input. */
export function frozenModelOutputs(manifest: AuditSourceManifest, root = ROOT): { source: string; strings: string[] }[] {
  const load = (f: FrozenFile, source: string, strings: string[]) => {
    if (auditSegmentCount(strings) !== f.segments) throw new FrozenSourceError(`frozen audit source yields ${auditSegmentCount(strings)} segments, manifest records ${f.segments}: ${f.path}`);
    return { source, strings };
  };
  return [
    ...manifest.replay.map((f) => load(f, `t1-replay:${f.path}`, responseStrings(readFrozen(root, f.path, f.sha256)))),
    ...manifest.modelOutputs.map((f) => load(f, `model-output:${f.path}`, jsonStrings(JSON.parse(readFrozen(root, f.path, f.sha256))))),
  ];
}

/**
 * The audit's frozen prompt sources. Prompts are rendered from the contract code, so each frozen source is a rendered
 * prompt identified by its stable id with the SHA-256 of its text when the audit was completed. Every listed prompt
 * must still render byte-identically (else: changed), must still exist (else: missing), and the list must be complete:
 * it must reproduce the prompt segment count recorded in the (hash-verified) audit artifact (else: omitted). Prompts
 * added later are never part of the set, whatever they are called.
 */
export function frozenPrompts(manifest: AuditSourceManifest, def: FrozenAuditDefinition = definitionOf(manifest.datasetId), root = ROOT): { source: string; text: string }[] {
  const current = new Map(def.promptTexts().map((p) => [p.source, p.text]));
  const prompts = manifest.prompts.map((p) => {
    const text = current.get(p.source);
    if (text === undefined) throw new FrozenSourceError(`frozen prompt missing: ${p.source}`);
    if (sha256Of(text) !== p.sha256) throw new FrozenSourceError(`frozen prompt changed: ${p.source}`);
    return { source: p.source, text };
  });
  const repository = frozenRepositoryPromptSources(manifest, def);
  const artifact = JSON.parse(readFrozen(root, manifest.auditArtifact.path, manifest.auditArtifact.sha256)) as AuditArtifact;
  const segments = prompts.reduce((n, p) => n + proseSegments(p.source, p.text).length, 0) + manifest.repositoryPrompts.reduce((n, g) => n + g.segments, 0);
  if (segments !== artifact.sourceSegments.prompt || repository.size !== manifest.repositoryPrompts.length)
    throw new FrozenSourceError(`frozen prompt set incomplete or altered: ${segments} prompt segments, the audit recorded ${artifact.sourceSegments.prompt} (a required prompt was omitted?)`);
  return prompts;
}

/** The prompt segments of the t1 audit's repository texts, grouped by source id (in the audit's own order). */
function repositoryPromptGroups(def: FrozenAuditDefinition): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const s of collectT1Sources()) {
    if (def.ownFiles.test(s.source) || !s.source.startsWith("prompt:") || s.text.trim().length === 0) continue;
    groups.set(s.source, [...(groups.get(s.source) ?? []), s.text]);
  }
  return groups;
}

/** The frozen repository prompt sources, verified (missing or changed fails); returns their source ids. */
export function frozenRepositoryPromptSources(manifest: AuditSourceManifest, def: FrozenAuditDefinition = definitionOf(manifest.datasetId)): Set<string> {
  const current = repositoryPromptGroups(def);
  for (const g of manifest.repositoryPrompts ?? []) {
    const texts = current.get(g.source);
    if (texts === undefined) throw new FrozenSourceError(`frozen prompt missing: ${g.source}`);
    if (texts.length !== g.segments || sha256Of(JSON.stringify(texts)) !== g.sha256) throw new FrozenSourceError(`frozen prompt changed: ${g.source}`);
  }
  return new Set((manifest.repositoryPrompts ?? []).map((g) => g.source));
}

/**
 * An audit's comparison sources from its frozen manifest: the repository texts of the t1 audit (as before, minus the
 * audit's own files), the frozen reference datasets, the frozen prompts and the frozen stored model outputs. Same
 * segmentation and order as the audit's own collection.
 */
export function collectFrozenSources(manifest: AuditSourceManifest, root = ROOT, def: FrozenAuditDefinition = definitionOf(manifest.datasetId)): Segment[] {
  // Repository texts as before, except that prompt sources among them are admitted only if frozen (and verified).
  const repositoryPrompts = frozenRepositoryPromptSources(manifest, def);
  const segments = collectT1Sources().filter((s) => !def.ownFiles.test(s.source) && (!s.source.startsWith("prompt:") || repositoryPrompts.has(s.source)));
  for (const ref of frozenReferences(manifest, root)) {
    const tag = ref.datasetId.slice(0, 2);
    for (const c of ref.comments) segments.push({ source: `${tag}:${c.id}`, text: c.text });
    for (const t of ref.taxonomy) for (const text of [t.name, t.definition, ...t.acceptedNames]) segments.push({ source: `${tag}-gold:${t.key}`, text });
  }
  for (const p of frozenPrompts(manifest, def, root)) segments.push(...proseSegments(p.source, p.text));
  for (const f of frozenModelOutputs(manifest, root)) for (const s of f.strings) if (normalize(s).length >= 3) segments.push({ source: f.source, text: s });
  return segments.filter((s) => s.text.trim().length > 0);
}

/** The t3 audit's frozen sources (kept for the t3 tests). */
export function collectFrozenT3Sources(manifest: AuditSourceManifest, root = ROOT): Segment[] {
  if (manifest.datasetId !== "t3-topics-v1") throw new FrozenSourceError(`not the t3 manifest: ${manifest.datasetId}`);
  return collectFrozenSources(manifest, root);
}

/**
 * The audits' prompt-text structural rule, verbatim (identical in t2-, t3-leakage-audit.ts and the hold-out audit): a
 * comment text or gold definition of at least 10 normalised characters must not appear inside any prompt.
 */
export function promptTextOverlaps(text: string, prompts: readonly { source: string; text: string }[]): string[] {
  const doc = JSON.parse(text) as DatasetDoc;
  const norms = prompts.map((p) => ({ source: p.source, norm: normalize(p.text) }));
  return [...doc.comments.map((c) => ({ id: c.id, text: c.text })), ...doc.taxonomy.map((t) => ({ id: `gold:${t.key}`, text: t.definition }))].flatMap((x) =>
    norms.filter((p) => normalize(x.text).length >= 10 && p.norm.includes(normalize(x.text))).map((p) => `${x.id} in ${p.source}`),
  );
}

/**
 * The audit's own structural checks on its frozen sources: references and stored model outputs from the manifest,
 * and the prompt-text check evaluated on the frozen prompt set (the audit's own check reads the current prompt list,
 * so its result is replaced by the same rule on the frozen prompts). Every other check is the audit's own, unchanged.
 */
export function frozenIndependenceChecks(manifest: AuditSourceManifest, text: string, root = ROOT, def: FrozenAuditDefinition = definitionOf(manifest.datasetId)): IndependenceCheck[] {
  const checks = def.checkIndependence(text, frozenReferences(manifest, root), frozenModelOutputs(manifest, root));
  const at = checks.filter((c) => c.check === def.promptCheck);
  if (at.length !== 1) throw new FrozenSourceError(`${def.datasetId}: the audit has ${at.length} checks named "${def.promptCheck}"; expected exactly one`);
  const details = promptTextOverlaps(text, frozenPrompts(manifest, def, root));
  return checks.map((c) => (c.check === def.promptCheck ? { check: c.check, passed: details.length === 0, details } : c));
}

/** Segment counts per source kind (the artifact's `sourceSegments` breakdown). */
export function segmentKinds(segments: readonly Segment[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const s of segments) {
    const kind = s.source.split(":")[0]!;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

// ---------- writing a manifest (once per completed audit) ----------

/**
 * Builds the manifest of a completed audit, or explains why the current files cannot reproduce it. The stored model
 * outputs are the first N files of the audit's own sorted listing (result files are named by run timestamp), where N
 * is the number of stored result files the artifact recorded; the set is accepted only if it reproduces every frozen
 * segment count the artifact recorded. Any mismatch is a refusal.
 */
export function buildFrozenManifest(def: FrozenAuditDefinition): { manifest: AuditSourceManifest | null; problems: string[]; reproduced: Record<string, number> } {
  const artifactBytes = readFileSync(join(ROOT, def.artifactPath));
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as AuditArtifact;
  const atAudit = def.storedResultFilesAtAudit(artifact);
  const live = def.liveModelOutputs();
  const outputs = live.filter((f) => f.source.startsWith("model-output:"));
  if (outputs.length < atAudit) return { manifest: null, problems: [`only ${outputs.length} stored result files; the artifact recorded ${atAudit}`], reproduced: {} };
  const fileOf = (source: string) => source.slice(source.indexOf(":") + 1);
  const frozenFile = (source: string, strings: string[]): FrozenFile => ({ path: fileOf(source), sha256: sha256Of(readFileSync(join(ROOT, fileOf(source)))), segments: auditSegmentCount(strings) });
  const kinds = frozenKinds(def);
  const manifest: AuditSourceManifest = {
    schema: AUDIT_SOURCE_MANIFEST_SCHEMA,
    datasetId: def.datasetId,
    datasetVersion: artifact.datasetVersion,
    auditArtifact: { path: def.artifactPath, sha256: sha256Of(artifactBytes) },
    derivation: [
      `Sources the completed ${def.datasetId} audit compared against, listed explicitly with SHA-256; later artifacts are never added.`,
      `Stored model outputs: the first ${atAudit} result files of the audit's own sorted listing, i.e. the ${atAudit} files the artifact recorded in provenance.storedResultFiles (no result of ${def.datasetId} existed).`,
      `Accepted only because this set reproduces every frozen segment count recorded in the artifact's sourceSegments (${kinds.join(", ")}).`,
      "Prompt sources: every topic prompt the audit rendered (stable id, SHA-256 of the text) and the prompt sources among the t1 audit's repository texts (stable id, segment count, SHA-256); together they reproduce the recorded prompt segment count. Prompts added later are never part of the set.",
      "Algorithm, thresholds and structural checks: unchanged (the audit's own module).",
    ],
    references: def.references.map((r) => ({ id: r.id, path: r.path, sha256: sha256Of(readFileSync(join(ROOT, r.path))) })),
    prompts: def.promptTexts().map((p) => ({ source: p.source, sha256: sha256Of(p.text) })),
    repositoryPrompts: [...repositoryPromptGroups(def)].map(([source, texts]) => ({ source, segments: texts.length, sha256: sha256Of(JSON.stringify(texts)) })),
    replay: live.filter((f) => f.source.startsWith("t1-replay:")).map((f) => frozenFile(f.source, f.strings)),
    modelOutputs: outputs.slice(0, atAudit).map((f) => frozenFile(f.source, f.strings)),
    recordedInArtifact: { storedResultFiles: artifact.provenance.storedResultFiles, sourceSegments: Object.fromEntries(kinds.map((k) => [k, artifact.sourceSegments[k]!])) },
  };
  const reproduced = segmentKinds(collectFrozenSources(manifest));
  const problems = kinds.filter((k) => reproduced[k] !== artifact.sourceSegments[k]).map((k) => `${k}: ${reproduced[k] ?? 0} reproduced, ${artifact.sourceSegments[k]} recorded`);
  return { manifest: problems.length === 0 ? manifest : null, problems, reproduced };
}
