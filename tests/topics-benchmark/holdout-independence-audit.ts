import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildTopicConsolidationInstructions, TOPIC_CONSOLIDATION_CONTRACTS } from "../../src/core/topics/consolidation-contract";
import { normalize, ROOT, type Segment } from "../heldout/leakage-audit";
import { auditT1Comments, collectT1Sources, T1_THRESHOLDS, type T1CommentAudit } from "./t1-leakage-audit";
import { MODEL_OUTPUT_DIR, PROVIDER_VOCABULARY, T1_REPLAY_DIR, topicPromptTexts } from "./t2-leakage-audit";

// Independence and leakage audit for a topic hold-out set against every earlier topic dataset (used from t4 on; the
// stored t2 and t3 audits keep their own frozen modules). Same algorithm and thresholds as the t1-t3 audits. Every
// comment and gold definition is compared lexically against everything the t1 audit covers, plus the earlier datasets'
// comments and gold, the recorded replay responses, every topic prompt (discovery, assignment, and every consolidation
// contract version) and every stored live model output except the hold-out's own. Structural checks cover IDs, gold
// labels, schema fields, provider vocabulary, prompt text and model output. Deterministic.

export const HOLDOUT_THRESHOLDS = T1_THRESHOLDS;

export interface HoldoutAuditConfig {
  datasetId: string;
  path: string;
  auditPath: string;
  /** Earlier datasets (id and fixture path) the hold-out must be independent of. */
  references: readonly { id: string; path: string }[];
  /** Test files that hold the hold-out's own texts (excluded from the sources), as `test:<path>` prefixes. */
  ownFiles: RegExp;
}

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

export interface IndependenceCheck {
  check: string;
  passed: boolean;
  details: string[];
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

const phrase = (text: string) => normalize(text);
const containsPhrase = (haystack: string, needle: string) => ` ${phrase(haystack)} `.includes(` ${phrase(needle)} `);

export function holdoutAudit(config: HoldoutAuditConfig) {
  const loadReferences = (): DatasetDoc[] => config.references.map((r) => JSON.parse(readFileSync(join(ROOT, r.path), "utf8")) as DatasetDoc);

  /** Every topic prompt as sent: discovery, assignment and every consolidation contract (first attempt and retry). */
  const promptTexts = (): { source: string; text: string }[] => [
    ...topicPromptTexts().filter((p) => !p.source.startsWith("prompt:consolidation")),
    ...TOPIC_CONSOLIDATION_CONTRACTS.flatMap((contract) =>
      [false, true].map((retry) => ({ source: `prompt:${contract}${retry ? ":retry" : ""}`, text: buildTopicConsolidationInstructions({ maxTopics: 12, retry, contract }) })),
    ),
  ];

  /** Stored model outputs: recorded replay responses and every live result file except the hold-out's own. */
  const modelOutputFiles = (): { source: string; strings: string[] }[] => {
    const files: { source: string; strings: string[] }[] = [];
    for (const file of listFiles(join(ROOT, T1_REPLAY_DIR, "responses"))) files.push({ source: `t1-replay:${relative(ROOT, file)}`, strings: responseStrings(readFileSync(file, "utf8")) });
    const results = join(ROOT, MODEL_OUTPUT_DIR);
    if (existsSync(results)) {
      for (const file of listFiles(results).filter((f) => f.endsWith(".json") && !f.includes(config.datasetId)).sort()) {
        files.push({ source: `model-output:${relative(ROOT, file)}`, strings: jsonStrings(JSON.parse(readFileSync(file, "utf8"))) });
      }
    }
    return files;
  };

  const collectSources = (): Segment[] => {
    const segments = collectT1Sources().filter((s) => !config.ownFiles.test(s.source));
    for (const ref of loadReferences()) {
      const tag = ref.datasetId.slice(0, 2);
      for (const c of ref.comments) segments.push({ source: `${tag}:${c.id}`, text: c.text });
      for (const t of ref.taxonomy) for (const text of [t.name, t.definition, ...t.acceptedNames]) segments.push({ source: `${tag}-gold:${t.key}`, text });
    }
    for (const p of promptTexts()) segments.push(...proseSegments(p.source, p.text));
    for (const f of modelOutputFiles()) for (const s of f.strings) if (normalize(s).length >= 3) segments.push({ source: f.source, text: s });
    return segments.filter((s) => s.text.trim().length > 0);
  };

  /** Lexical audit of comment texts and gold definitions; names get exact and containment checks instead. */
  const auditTexts = (doc: DatasetDoc, sources: readonly Segment[]): { comments: T1CommentAudit[]; gold: T1CommentAudit[] } => ({
    comments: auditT1Comments(doc.comments, sources),
    gold: auditT1Comments(doc.taxonomy.map((t) => ({ id: `gold:${t.key}:definition`, text: t.definition })), sources),
  });

  const idPattern = new RegExp(`^${config.datasetId.slice(0, 2)}-\\d{3}$`);

  const checkIndependence = (text: string, references: readonly DatasetDoc[], modelOutputs: readonly { source: string; strings: string[] }[]): IndependenceCheck[] => {
    const doc = JSON.parse(text) as DatasetDoc & Record<string, unknown>;
    const checks: IndependenceCheck[] = [];
    const add = (check: string, details: string[]) => checks.push({ check, passed: details.length === 0, details });
    const refIds = references.map((r) => r.datasetId).join(", ");
    const own = config.datasetId.slice(0, 2);

    const refIdSet = new Set(references.flatMap((r) => r.comments.map((c) => c.id)));
    add(`no comment IDs of ${refIds}; own IDs are ${own}-NNN`, doc.comments.flatMap((c) => [...(refIdSet.has(c.id) ? [`${c.id} is a reference ID`] : []), ...(idPattern.test(c.id) ? [] : [`${c.id} is not an own ID`])]));

    const refTexts = new Map(references.flatMap((r) => r.comments.map((c) => [phrase(c.text), `${r.datasetId}:${c.id}`] as const)));
    add(`no comment text of ${refIds} (exact normalised)`, doc.comments.filter((c) => refTexts.has(phrase(c.text))).map((c) => `${c.id} = ${refTexts.get(phrase(c.text))}`));

    const refLabels = references.flatMap((r) => r.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, ...t.acceptedNames].map((label) => ({ label, from: `${r.datasetId}:${t.key}` }))));
    const ownLabels = doc.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, ...t.acceptedNames].map((label) => ({ key: t.key, label })));
    add(
      `no gold topic key, name or accepted name of ${refIds} in the taxonomy`,
      ownLabels.flatMap(({ key, label }) => refLabels.filter((r) => containsPhrase(label, r.label) || containsPhrase(r.label, label)).map((r) => `${key}: "${label}" ~ ${r.from} "${r.label}"`)),
    );
    const refPhrases = refLabels.filter((r) => phrase(r.label).includes(" "));
    add(`no multi-word gold label of ${refIds} in a comment`, doc.comments.flatMap((c) => refPhrases.filter((r) => containsPhrase(c.text, r.label)).map((r) => `${c.id} contains ${r.from} "${r.label}"`)));

    const datasetFields = new Set(references.flatMap((r) => Object.keys(r)));
    const topicFields = new Set(references.flatMap((r) => r.taxonomy.flatMap((t) => Object.keys(t))));
    const commentFields = new Set(references.flatMap((r) => r.comments.flatMap((c) => Object.keys(c))));
    add("only the shared dataset schema fields (no model, provider or prompt metadata)", [
      ...Object.keys(doc).filter((k) => !datasetFields.has(k)).map((k) => `dataset field ${k}`),
      ...doc.taxonomy.flatMap((t) => Object.keys(t).filter((k) => !topicFields.has(k)).map((k) => `topic ${t.key} field ${k}`)),
      ...doc.comments.flatMap((c) => Object.keys(c).filter((k) => !commentFields.has(k)).map((k) => `${c.id} field ${k}`)),
    ]);

    add("no provider, model or contract vocabulary in the fixture", (text.match(new RegExp(PROVIDER_VOCABULARY.source, "gi")) ?? []).map((m) => `contains "${m}"`));

    const prompts = promptTexts().map((p) => ({ ...p, norm: phrase(p.text) }));
    add(
      "no topic prompt text (any contract version) in a comment or gold text (exact or contained)",
      [...doc.comments.map((c) => ({ id: c.id, text: c.text })), ...doc.taxonomy.map((t) => ({ id: `gold:${t.key}`, text: t.definition }))].flatMap((x) =>
        prompts.filter((p) => phrase(x.text).length >= 10 && p.norm.includes(phrase(x.text))).map((p) => `${x.id} in ${p.source}`),
      ),
    );

    const minChars = HOLDOUT_THRESHOLDS.substringMinChars;
    const goldTexts = doc.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, t.definition, ...t.acceptedNames].map((s) => ({ key: t.key, norm: phrase(s), text: s })));
    const outputs = modelOutputs.map((o) => ({ source: o.source, norms: o.strings.map((s) => phrase(s.replace(/[_-]/g, " "))).filter((n) => n.length > 0) }));
    add(
      "no stored model output embedded in the gold (exact or contained, either direction)",
      goldTexts.flatMap(({ key, norm, text: t }) =>
        outputs.filter((o) => o.norms.some((n) => n === norm || (norm.length >= minChars && n.includes(norm)) || (n.length >= minChars && norm.includes(n)))).map((o) => `${key}: "${t}" in ${o.source}`),
      ),
    );
    return checks;
  };

  /** Provenance, recorded once when the artifact is written: no own result may exist for the audited version. */
  const provenanceAtAudit = (): { storedResultFiles: number; ownResultFiles: string[] } => {
    const results = join(ROOT, MODEL_OUTPUT_DIR);
    const files = existsSync(results) ? readdirSync(results).filter((f) => f.endsWith(".json")).sort() : [];
    return { storedResultFiles: files.length, ownResultFiles: files.filter((f) => f.includes(config.datasetId)) };
  };

  return { config, loadReferences, promptTexts, modelOutputFiles, collectSources, auditTexts, checkIndependence, provenanceAtAudit };
}

/** The t4 hold-out audit: independent of t1, t2 and t3. */
export const T4_AUDIT = holdoutAudit({
  datasetId: "t4-topics-v1",
  path: "fixtures/t4-topics-v1/comments.json",
  auditPath: "fixtures/t4-topics-v1/leakage-audit.json",
  references: [
    { id: "t1-topics-v1", path: "fixtures/t1-topics-v1/comments.json" },
    { id: "t2-topics-v1", path: "fixtures/t2-topics-v1/comments.json" },
    { id: "t3-topics-v1", path: "fixtures/t3-topics-v1/comments.json" },
  ],
  ownFiles: /^test:tests\/(topics-benchmark\/|unit\/t4-)/,
});
