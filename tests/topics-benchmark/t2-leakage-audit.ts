import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildTopicConsolidationInstructions } from "../../src/core/topics/consolidation-contract";
import { buildTopicAssignmentInstructions, buildTopicDiscoveryInstructions, UNTRUSTED_DATA_RULES } from "../../src/core/topics/provider-contracts";
import { normalize, ROOT, type Segment } from "../heldout/leakage-audit";
import { auditT1Comments, collectT1Sources, T1_PATH, T1_THRESHOLDS, type T1CommentAudit } from "./t1-leakage-audit";

// Independence and leakage audit for the validation set t2-topics-v1. t2 must test generalisation, so beyond the
// lexical checks t1 already runs (m2 comments, guidelines, Jev questions, prompts, spec quotes, test literals, design
// document, topic fakes; same algorithm and thresholds) every t2 comment is also compared against the t1 comments,
// the t1 gold taxonomy, the recorded t1 replay responses, the topic provider prompts (discovery, consolidation,
// assignment) and any stored live model output under benchmark-results/. Structural checks cover IDs, gold names,
// provider/prompt vocabulary and gold provenance. Deterministic. Regenerate the stored artifact with:
//   npx tsx tests/topics-benchmark/write-t2-leakage-audit.ts

export const T2_PATH = "fixtures/t2-topics-v1/comments.json";
export const T2_AUDIT_PATH = "fixtures/t2-topics-v1/leakage-audit.json";
export const T2_DATASET_ID = "t2-topics-v1";
/** Same thresholds as the t1 audit. */
export const T2_THRESHOLDS = T1_THRESHOLDS;
export const T1_REPLAY_DIR = "fixtures/topic-provider-replay/t1-topics-v1";
export const MODEL_OUTPUT_DIR = "benchmark-results";

/** Files that hold the t2 texts themselves (not sources). */
const T2_OWN_FILES = /^test:tests\/(topics-benchmark\/|unit\/t2-)/;

/** Provider, model and contract vocabulary that must never appear anywhere in the t2 fixture. */
export const PROVIDER_VOCABULARY = /\b(anthropic|claude|sonnet|opus|haiku|gemini|google|openai|gpt|typesafe|jev)\b|topic-(discovery|consolidation|assignment)-v\d/i;

interface GoldTopicDoc {
  key: string;
  name: string;
  definition: string;
  acceptedNames: string[];
}
interface DatasetDoc {
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

/** Whole text plus its lines and sentences. */
function proseSegments(source: string, text: string): Segment[] {
  const parts = new Set<string>([text]);
  for (const line of text.split("\n")) {
    parts.add(line);
    for (const s of line.split(/(?<=[.!?])\s+/)) parts.add(s);
  }
  return [...parts].filter((p) => normalize(p).length > 0).map((p) => ({ source, text: p }));
}

/** Every string value of a JSON document (keys excluded). */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) jsonStrings(v, out);
  return out;
}

/** Strings of a raw model response: its parsed JSON values when it is JSON (possibly fenced), else its prose. */
function responseStrings(raw: string): string[] {
  const body = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    return jsonStrings(JSON.parse(body));
  } catch {
    return [raw];
  }
}

export function loadT1(): DatasetDoc {
  return JSON.parse(readFileSync(join(ROOT, T1_PATH), "utf8")) as DatasetDoc;
}

/** The topic provider prompts as they are sent (first attempt and retry). */
export function topicPromptTexts(): { source: string; text: string }[] {
  const prompts: { source: string; text: string }[] = [];
  for (const retry of [false, true]) {
    prompts.push({ source: `prompt:discovery${retry ? ":retry" : ""}`, text: buildTopicDiscoveryInstructions({ maxTopics: 12, retry }) });
    prompts.push({ source: `prompt:consolidation${retry ? ":retry" : ""}`, text: buildTopicConsolidationInstructions({ maxTopics: 12, retry }) });
    prompts.push({ source: `prompt:assignment${retry ? ":retry" : ""}`, text: buildTopicAssignmentInstructions({ sentimentLabels: ["positive", "neutral", "negative"], retry }) });
  }
  prompts.push({ source: "prompt:untrusted-data-rules", text: UNTRUSTED_DATA_RULES.join("\n") });
  return prompts;
}

/**
 * Stored model outputs: recorded t1 replay responses and every live result file present locally, except results of
 * t2 runs themselves (those necessarily postdate the gold; provenance is recorded once in the audit artifact).
 */
export function modelOutputFiles(): { source: string; strings: string[] }[] {
  const files: { source: string; strings: string[] }[] = [];
  for (const file of listFiles(join(ROOT, T1_REPLAY_DIR, "responses"))) files.push({ source: `t1-replay:${relative(ROOT, file)}`, strings: responseStrings(readFileSync(file, "utf8")) });
  const results = join(ROOT, MODEL_OUTPUT_DIR);
  if (existsSync(results)) {
    for (const file of listFiles(results).filter((f) => f.endsWith(".json") && !f.includes(T2_DATASET_ID)).sort()) {
      files.push({ source: `model-output:${relative(ROOT, file)}`, strings: jsonStrings(JSON.parse(readFileSync(file, "utf8"))) });
    }
  }
  return files;
}

/** Everything the t1 audit compares against, plus t1 itself, the topic prompts and stored model outputs. */
export function collectT2Sources(): Segment[] {
  const segments = collectT1Sources().filter((s) => !T2_OWN_FILES.test(s.source));
  const t1 = loadT1();
  for (const c of t1.comments) segments.push({ source: `t1:${c.id}`, text: c.text });
  for (const t of t1.taxonomy) for (const text of [t.name, t.definition, ...t.acceptedNames]) segments.push({ source: `t1-gold:${t.key}`, text });
  for (const p of topicPromptTexts()) segments.push(...proseSegments(p.source, p.text));
  for (const f of modelOutputFiles()) for (const s of f.strings) if (normalize(s).length >= 3) segments.push({ source: f.source, text: s });
  return segments.filter((s) => s.text.trim().length > 0);
}

/**
 * Lexical audit of the t2 comment texts and gold definitions (same algorithm and thresholds as t1). Gold names and
 * accepted names are a few words, where fuzzy similarity is noise; they get exact and containment checks instead
 * (checkT2Independence).
 */
export function auditT2Texts(t2: DatasetDoc, sources: readonly Segment[]): { comments: T1CommentAudit[]; gold: T1CommentAudit[] } {
  const gold = t2.taxonomy.map((t) => ({ id: `gold:${t.key}:definition`, text: t.definition }));
  return { comments: auditT1Comments(t2.comments, sources), gold: auditT1Comments(gold, sources) };
}

export interface IndependenceCheck {
  check: string;
  passed: boolean;
  details: string[];
}

const phrase = (text: string) => normalize(text);
const containsPhrase = (haystack: string, needle: string) => ` ${phrase(haystack)} `.includes(` ${phrase(needle)} `);

/** Structural independence checks against t1, the topic prompts and the stored model outputs. */
export function checkT2Independence(t2Text: string, t1: DatasetDoc, modelOutputs: readonly { source: string; strings: string[] }[]): IndependenceCheck[] {
  const t2 = JSON.parse(t2Text) as DatasetDoc & Record<string, unknown>;
  const checks: IndependenceCheck[] = [];
  const add = (check: string, details: string[]) => checks.push({ check, passed: details.length === 0, details });

  const t1Ids = new Set(t1.comments.map((c) => c.id));
  add("no t1 comment IDs; t2 IDs are t2-NNN", t2.comments.flatMap((c) => [...(t1Ids.has(c.id) ? [`${c.id} is a t1 ID`] : []), ...(/^t2-\d{3}$/.test(c.id) ? [] : [`${c.id} is not a t2 ID`])]));

  const t1Texts = new Set(t1.comments.map((c) => phrase(c.text)));
  add("no t1 comment text (exact normalised)", t2.comments.filter((c) => t1Texts.has(phrase(c.text))).map((c) => c.id));

  // Every t1 gold label (key, name, accepted names) against every t2 gold label, as whole-word phrases.
  const t1Labels = t1.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, ...t.acceptedNames]);
  const t2Labels = t2.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, ...t.acceptedNames].map((label) => ({ key: t.key, label })));
  add(
    "no t1 gold topic key, name or accepted name in the t2 taxonomy",
    t2Labels.flatMap(({ key, label }) => t1Labels.filter((l) => containsPhrase(label, l) || containsPhrase(l, label)).map((l) => `${key}: "${label}" ~ t1 "${l}"`)),
  );
  // Multi-word t1 gold names and accepted names in t2 comment texts (single generic words are covered lexically).
  const t1Phrases = t1.taxonomy.flatMap((t) => [t.name, ...t.acceptedNames]).filter((l) => phrase(l).includes(" "));
  add("no t1 gold topic name in a t2 comment", t2.comments.flatMap((c) => t1Phrases.filter((l) => containsPhrase(c.text, l)).map((l) => `${c.id} contains t1 "${l}"`)));

  // The shared schema is t1's own field set; anything else (e.g. model or provider metadata) is rejected.
  const datasetFields = new Set(Object.keys(t1));
  const topicFields = new Set(t1.taxonomy.flatMap((t) => Object.keys(t)));
  const commentFields = new Set(t1.comments.flatMap((c) => Object.keys(c)));
  const foreignFields = [
    ...Object.keys(t2).filter((k) => !datasetFields.has(k)).map((k) => `dataset field ${k}`),
    ...t2.taxonomy.flatMap((t) => Object.keys(t).filter((k) => !topicFields.has(k)).map((k) => `topic ${t.key} field ${k}`)),
    ...t2.comments.flatMap((c) => Object.keys(c).filter((k) => !commentFields.has(k)).map((k) => `${c.id} field ${k}`)),
  ];
  add("only the shared dataset schema fields (no model, provider or prompt metadata)", foreignFields);

  add("no provider, model or contract vocabulary in the fixture", (t2Text.match(new RegExp(PROVIDER_VOCABULARY.source, "gi")) ?? []).map((m) => `contains "${m}"`));

  const prompts = topicPromptTexts().map((p) => ({ ...p, norm: phrase(p.text) }));
  add(
    "no topic prompt text in a t2 comment or gold text (exact or contained)",
    [...t2.comments.map((c) => ({ id: c.id, text: c.text })), ...t2.taxonomy.map((t) => ({ id: `gold:${t.key}`, text: t.definition }))].flatMap((x) =>
      prompts.filter((p) => phrase(x.text).length >= 10 && p.norm.includes(phrase(x.text))).map((p) => `${x.id} in ${p.source}`),
    ),
  );

  // Gold keys, names, accepted names and definitions never equal or sit inside a string a model produced (replay
  // recordings or stored live results), and never contain one of at least the same minimum length.
  const minChars = T2_THRESHOLDS.substringMinChars;
  const goldTexts = t2.taxonomy.flatMap((t) => [t.key.replace(/_/g, " "), t.name, t.definition, ...t.acceptedNames].map((text) => ({ key: t.key, norm: phrase(text), text })));
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

/**
 * Provenance, recorded once when the audit artifact is written: the live result files present then and those that
 * belong to t2. The gold is independent of provider outputs when no t2 run existed when this dataset version was audited.
 */
export function provenanceAtAudit(): { storedResultFiles: number; t2ResultFiles: string[] } {
  const results = join(ROOT, MODEL_OUTPUT_DIR);
  const files = existsSync(results) ? readdirSync(results).filter((f) => f.endsWith(".json")).sort() : [];
  return { storedResultFiles: files.length, t2ResultFiles: files.filter((f) => f.includes(T2_DATASET_ID)) };
}
