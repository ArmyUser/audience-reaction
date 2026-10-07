import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildJevQuestionSet, JEV_QUESTION_SETS } from "../../src/adapters/ai/typesafe/jev-question-sets";
import * as GUIDELINES from "../../src/core/classification/guidelines";
import { buildClassifierInstructions } from "../../src/core/classification/llm-prompt";
import { createClassificationSchema } from "../../src/core/classification/schema";

// Lexical leakage audit for the held-out benchmark set: compares every held-out comment against the m2 comments,
// every guideline text and quoted example, every Jev question set (all versions and schemas), the generative
// classifier prompt, quoted examples in spec.md, and string literals in the existing tests. Deterministic.
// Regenerate the stored artifact with: npx tsx tests/heldout/write-leakage-audit.ts

/** Repository root: tests and the regeneration script run from it. */
export const ROOT = process.cwd();
export const HELDOUT_PATH = "fixtures/m2-heldout-v1/comments.json";
export const AUDIT_PATH = "fixtures/m2-heldout-v1/leakage-audit.json";

/** A comment is rejected at or above these similarities (or on an exact or substring match). */
export const THRESHOLDS = { tokenJaccard: 0.5, trigramJaccard: 0.5, substringMinChars: 10 } as const;

/** Files that contain the held-out texts themselves and are therefore not sources. */
const EXCLUDED_TEST_FILES = new Set(["tests/heldout/leakage-audit.ts", "tests/heldout/write-leakage-audit.ts", "tests/unit/heldout-dataset.test.ts"]);

const STOPWORDS = new Set(
  "a an the and or but if of to in on at for with from by as is are was were be been it its this that these those i you he she they we me my your his her their our us them so not no do does did just really very too also than then there here what which who how when where why can could would should will about up out over into all any".split(" "),
);

export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

function contentTokens(text: string): Set<string> {
  return new Set((normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t)));
}

function trigrams(text: string): Set<string> {
  const s = normalize(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface Segment {
  source: string;
  text: string;
}

/** Full texts plus their sentences and quoted examples. */
function segmentsOf(source: string, text: string): Segment[] {
  const parts = new Set<string>([text]);
  for (const s of text.split(/(?<=[.!?])\s+/)) parts.add(s);
  for (const m of text.matchAll(/'([^']{1,160})'|"([^"]{1,160})"|‘([^’]{1,160})’|“([^”]{1,160})”/g)) parts.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
  return [...parts].filter((p) => p.trim().length > 0).map((p) => ({ source, text: p }));
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

export function collectSources(): Segment[] {
  const segments: Segment[] = [];
  const m2 = JSON.parse(readFileSync(join(ROOT, "fixtures/m2/comments.json"), "utf8")) as { comments: { id: string; text: string }[] };
  for (const c of m2.comments) segments.push({ source: `m2:${c.id}`, text: c.text });

  for (const [name, value] of Object.entries(GUIDELINES)) {
    const texts = typeof value === "string" ? [value] : typeof value === "object" && value !== null ? Object.values(value).filter((v): v is string => typeof v === "string") : [];
    for (const t of texts) segments.push(...segmentsOf(`guideline:${name}`, t));
  }

  const schemas = [
    createClassificationSchema({ focusConfigured: true }),
    createClassificationSchema({ focusConfigured: false }),
    createClassificationSchema({ focusConfigured: true, mixedEnabled: true }),
  ];
  const seen = new Set<string>();
  for (const version of JEV_QUESTION_SETS)
    for (const schema of schemas)
      for (const [key, q] of Object.entries(buildJevQuestionSet(version, schema))) {
        const texts = [q.instructions, ...("criteria" in q ? Object.values(q.criteria) : [])];
        for (const t of texts) {
          if (seen.has(t)) continue;
          seen.add(t);
          segments.push(...segmentsOf(`question:${version}:${key}`, t));
        }
      }
  for (const schema of schemas) segments.push(...segmentsOf("prompt:llm", buildClassifierInstructions(schema)));

  const spec = readFileSync(join(ROOT, "spec.md"), "utf8");
  for (const m of spec.matchAll(/"([^"\n]{2,160})"/g)) segments.push({ source: "spec.md", text: m[1]! });

  for (const file of listFiles(join(ROOT, "tests"))) {
    const rel = relative(ROOT, file);
    if (!/\.(ts|tsx)$/.test(rel) || EXCLUDED_TEST_FILES.has(rel)) continue;
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/"((?:[^"\\\n]|\\.){3,200})"|'((?:[^'\\\n]|\\.){3,200})'|`([^`$\n]{3,200})`/g))
      segments.push({ source: `test:${rel}`, text: m[1] ?? m[2] ?? m[3] ?? "" });
  }
  return segments.filter((s) => normalize(s.text).length > 0 || s.text.trim().length > 0);
}

export interface CommentAudit {
  id: string;
  maxTokenJaccard: number;
  maxTokenSource: string;
  maxTrigramJaccard: number;
  maxTrigramSource: string;
  violations: string[];
}

export function auditComments(comments: { id: string; text: string }[], sources: Segment[]): CommentAudit[] {
  const prepared = sources.map((s) => ({ ...s, norm: normalize(s.text), raw: s.text.trim(), tokens: contentTokens(s.text), grams: trigrams(s.text) }));
  return comments.map((c) => {
    const norm = normalize(c.text);
    const raw = c.text.trim();
    const tokens = contentTokens(c.text);
    const grams = trigrams(c.text);
    const violations: string[] = [];
    let maxTok = 0;
    let tokSrc = "";
    let maxTri = 0;
    let triSrc = "";
    for (const s of prepared) {
      if (raw === s.raw || (norm.length > 0 && norm === s.norm)) violations.push(`exact:${s.source}`);
      else if (norm.length >= THRESHOLDS.substringMinChars && s.norm.includes(norm)) violations.push(`contained-in:${s.source}`);
      else if (s.norm.length >= THRESHOLDS.substringMinChars && norm.includes(s.norm)) violations.push(`contains:${s.source}`);
      const tj = tokens.size + s.tokens.size >= 4 ? jaccard(tokens, s.tokens) : 0;
      const gj = norm.length >= 12 && s.norm.length >= 12 ? jaccard(grams, s.grams) : 0;
      if (tj > maxTok) [maxTok, tokSrc] = [tj, s.source];
      if (gj > maxTri) [maxTri, triSrc] = [gj, s.source];
    }
    if (maxTok >= THRESHOLDS.tokenJaccard) violations.push(`token-jaccard:${tokSrc}`);
    if (maxTri >= THRESHOLDS.trigramJaccard) violations.push(`trigram-jaccard:${triSrc}`);
    const round = (x: number) => Math.round(x * 1000) / 1000;
    return { id: c.id, maxTokenJaccard: round(maxTok), maxTokenSource: tokSrc, maxTrigramJaccard: round(maxTri), maxTrigramSource: triSrc, violations: [...new Set(violations)] };
  });
}
