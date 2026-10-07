import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalize, ROOT, type Segment } from "../heldout/leakage-audit";
import { auditT1Comments, collectT1Sources, T1_PATH, T1_THRESHOLDS, type T1CommentAudit } from "./t1-leakage-audit";
import { MODEL_OUTPUT_DIR, PROVIDER_VOCABULARY, T1_REPLAY_DIR, T2_PATH, topicPromptTexts } from "./t2-leakage-audit";

// Independence and leakage audit for the final hold-out set t3-topics-v1. Same algorithm and thresholds as the t1 and
// t2 audits. Every t3 comment and gold definition is compared against everything the t1 audit covers plus BOTH
// earlier topic datasets (comments and gold taxonomies), the recorded replay responses, the topic provider prompts
// and every stored live model output under benchmark-results/ except t3's own (which necessarily postdates the gold).
// Structural checks cover IDs, gold labels of both earlier sets, schema fields, provider vocabulary, prompt text and
// model output. Deterministic. Regenerate the stored artifact only before any provider run on t3:
//   npx tsx tests/topics-benchmark/write-t3-leakage-audit.ts

export const T3_PATH = "fixtures/t3-topics-v1/comments.json";
export const T3_AUDIT_PATH = "fixtures/t3-topics-v1/leakage-audit.json";
export const T3_DATASET_ID = "t3-topics-v1";
/** Same thresholds as the t1 and t2 audits. */
export const T3_THRESHOLDS = T1_THRESHOLDS;
/** The earlier topic datasets t3 must be independent of. */
export const T3_REFERENCES = [
  { id: "t1-topics-v1", path: T1_PATH },
  { id: "t2-topics-v1", path: T2_PATH },
] as const;

/** Files that hold the t3 texts themselves (not sources). */
const T3_OWN_FILES = /^test:tests\/(topics-benchmark\/|unit\/t3-)/;

interface GoldTopicDoc {
  key: string;
  name: string;
  definition: string;
  acceptedNames: string[];
}
export interface DatasetDoc {
  datasetId: string;
  taxonomy: GoldTopicDoc[];
  comments: { id: string; text: string }[];
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function proseSegments(source: string, text: string): Segment[] {
  const parts = new Set<string>([text]);
  for (const line of text.split("\n")) {
    parts.add(line);
    for (const s of line.split(/(?<=[.!?])\s+/)) parts.add(s);
  }
  return [...parts].filter((p) => normalize(p).length > 0).map((p) => ({ source, text: p }));
}

function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) jsonStrings(v, out);
  return out;
}

function responseStrings(raw: string): string[] {
  const body = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    return jsonStrings(JSON.parse(body));
  } catch {
    return [raw];
  }
}

export function loadReferences(): DatasetDoc[] {
  return T3_REFERENCES.map((r) => JSON.parse(readFileSync(join(ROOT, r.path), "utf8")) as DatasetDoc);
}

/** Stored model outputs: recorded replay responses and every live result file except t3's own. */
export function t3ModelOutputFiles(): { source: string; strings: string[] }[] {
  const files: { source: string; strings: string[] }[] = [];
  for (const file of listFiles(join(ROOT, T1_REPLAY_DIR, "responses"))) files.push({ source: `t1-replay:${relative(ROOT, file)}`, strings: responseStrings(readFileSync(file, "utf8")) });
  const results = join(ROOT, MODEL_OUTPUT_DIR);
  if (existsSync(results)) {
    for (const file of listFiles(results).filter((f) => f.endsWith(".json") && !f.includes(T3_DATASET_ID)).sort()) {
      files.push({ source: `model-output:${relative(ROOT, file)}`, strings: jsonStrings(JSON.parse(readFileSync(file, "utf8"))) });
    }
  }
  return files;
}

/** Everything the t1 audit compares against, plus t1 and t2 themselves, the topic prompts and stored model outputs. */
export function collectT3Sources(): Segment[] {
  const segments = collectT1Sources().filter((s) => !T3_OWN_FILES.test(s.source));
  for (const ref of loadReferences()) {
    const tag = ref.datasetId.slice(0, 2);
    for (const c of ref.comments) segments.push({ source: `${tag}:${c.id}`, text: c.text });
    for (const t of ref.taxonomy) for (const text of [t.name, t.definition, ...t.acceptedNames]) segments.push({ source: `${tag}-gold:${t.key}`, text });
  }
  for (const p of topicPromptTexts()) segments.push(...proseSegments(p.source, p.text));
  for (const f of t3ModelOutputFiles()) for (const s of f.strings) if (normalize(s).length >= 3) segments.push({ source: f.source, text: s });
  return segments.filter((s) => s.text.trim().length > 0);
}

/** Lexical audit of t3 comment texts and gold definitions; names get exact and containment checks instead. */
export function auditT3Texts(t3: DatasetDoc, sources: readonly Segment[]): { comments: T1CommentAudit[]; gold: T1CommentAudit[] } {
  const gold = t3.taxonomy.map((t) => ({ id: `gold:${t.key}:definition`, text: t.definition }));
  return { comments: auditT1Comments(t3.comments, sources), gold: auditT1Comments(gold, sources) };
}

export interface IndependenceCheck {
  check: string;
  passed: boolean;
  details: string[];
}

const phrase = (text: string) => normalize(text);
const containsPhrase = (haystack: string, needle: string) => ` ${phrase(haystack)} `.includes(` ${phrase(needle)} `);

/** Structural independence checks against every reference dataset, the topic prompts and the stored model outputs. */
export function checkT3Independence(t3Text: string, references: readonly DatasetDoc[], modelOutputs: readonly { source: string; strings: string[] }[]): IndependenceCheck[] {
  const t3 = JSON.parse(t3Text) as DatasetDoc & Record<string, unknown>;
  const checks: IndependenceCheck[] = [];
  const add = (check: string, details: string[]) => checks.push({ check, passed: details.length === 0, details });
  const refIds = references.map((r) => r.datasetId).join(", ");

  const refIdSet = new Set(references.flatMap((r) => r.comments.map((c) => c.id)));
  add(`no comment IDs of ${refIds}; t3 IDs are t3-NNN`, t3.comments.flatMap((c) => [...(refIdSet.has(c.id) ? [`${c.id} is a reference ID`] : []), ...(/^t3-\d{3}$/.test(c.id) ? [] : [`${c.id} is not a t3 ID`])]));

  const refTexts = new Map(references.flatMap((r) => r.comments.map((c) => [phrase(c.text), `${r.datasetId}:${c.id}`] as const)));
  add(`no comment text of ${refIds} (exact normalised)`, t3.comments.filter((c) => refTexts.has(phrase(c.text))).map((c) => `${c.id} = ${refTexts.get(phrase(c.text))}`));

  const refLabels = references.flatMap((r) => r.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, ...t.acceptedNames].map((label) => ({ label, from: `${r.datasetId}:${t.key}` }))));
  const t3Labels = t3.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, ...t.acceptedNames].map((label) => ({ key: t.key, label })));
  add(
    `no gold topic key, name or accepted name of ${refIds} in the t3 taxonomy`,
    t3Labels.flatMap(({ key, label }) => refLabels.filter((r) => containsPhrase(label, r.label) || containsPhrase(r.label, label)).map((r) => `${key}: "${label}" ~ ${r.from} "${r.label}"`)),
  );
  const refPhrases = refLabels.filter((r) => phrase(r.label).includes(" "));
  add(`no multi-word gold label of ${refIds} in a t3 comment`, t3.comments.flatMap((c) => refPhrases.filter((r) => containsPhrase(c.text, r.label)).map((r) => `${c.id} contains ${r.from} "${r.label}"`)));

  // The shared schema is the reference datasets' own field set; anything else (e.g. model metadata) is rejected.
  const datasetFields = new Set(references.flatMap((r) => Object.keys(r)));
  const topicFields = new Set(references.flatMap((r) => r.taxonomy.flatMap((t) => Object.keys(t))));
  const commentFields = new Set(references.flatMap((r) => r.comments.flatMap((c) => Object.keys(c))));
  add("only the shared dataset schema fields (no model, provider or prompt metadata)", [
    ...Object.keys(t3).filter((k) => !datasetFields.has(k)).map((k) => `dataset field ${k}`),
    ...t3.taxonomy.flatMap((t) => Object.keys(t).filter((k) => !topicFields.has(k)).map((k) => `topic ${t.key} field ${k}`)),
    ...t3.comments.flatMap((c) => Object.keys(c).filter((k) => !commentFields.has(k)).map((k) => `${c.id} field ${k}`)),
  ]);

  add("no provider, model or contract vocabulary in the fixture", (t3Text.match(new RegExp(PROVIDER_VOCABULARY.source, "gi")) ?? []).map((m) => `contains "${m}"`));

  const prompts = topicPromptTexts().map((p) => ({ ...p, norm: phrase(p.text) }));
  add(
    "no topic prompt text in a t3 comment or gold text (exact or contained)",
    [...t3.comments.map((c) => ({ id: c.id, text: c.text })), ...t3.taxonomy.map((t) => ({ id: `gold:${t.key}`, text: t.definition }))].flatMap((x) =>
      prompts.filter((p) => phrase(x.text).length >= 10 && p.norm.includes(phrase(x.text))).map((p) => `${x.id} in ${p.source}`),
    ),
  );

  const minChars = T3_THRESHOLDS.substringMinChars;
  const goldTexts = t3.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, t.definition, ...t.acceptedNames].map((text) => ({ key: t.key, norm: phrase(text), text })));
  const outputs = modelOutputs.map((o) => ({ source: o.source, norms: o.strings.map((s) => phrase(s.replace(/[_-]/g, " "))).filter((n) => n.length > 0) }));
  add(
    "no stored model output embedded in the gold (exact or contained, either direction)",
    goldTexts.flatMap(({ key, norm, text }) =>
      outputs
        .filter((o) => o.norms.some((n) => n === norm || (norm.length >= minChars && n.includes(norm)) || (n.length >= minChars && norm.includes(n))))
        .map((o) => `${key}: "${text}" in ${o.source}`),
    ),
  );
  return checks;
}

/** Provenance, recorded once when the artifact is written: no t3 result may exist for the audited version. */
export function t3ProvenanceAtAudit(): { storedResultFiles: number; t3ResultFiles: string[] } {
  const results = join(ROOT, MODEL_OUTPUT_DIR);
  const files = existsSync(results) ? readdirSync(results).filter((f) => f.endsWith(".json")).sort() : [];
  return { storedResultFiles: files.length, t3ResultFiles: files.filter((f) => f.includes(T3_DATASET_ID)) };
}
