import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { collectSources, normalize, ROOT, type Segment } from "../heldout/leakage-audit";

// Lexical leakage audit for the topic benchmark t1-topics-v1. Every comment is compared against everything the
// m2-heldout-v1 audit already covers (m2 comments, guideline constants and quoted examples, every Jev question set,
// the generative classifier prompt, spec.md quotes, string literals in the tests) plus the m2-heldout-v1 comments,
// the M4 topic-provider design document and the string literals of the existing topic fakes. Thresholds are stricter
// than the held-out audit's. Deterministic. Regenerate the stored artifact with:
//   npx tsx tests/topics-benchmark/write-t1-leakage-audit.ts

export const T1_PATH = "fixtures/t1-topics-v1/comments.json";
export const T1_AUDIT_PATH = "fixtures/t1-topics-v1/leakage-audit.json";

/** Rejected at or above these similarities, or on an exact or containment match (conservative: held-out uses 0.5). */
export const T1_THRESHOLDS = { tokenJaccard: 0.4, trigramJaccard: 0.4, substringMinChars: 10 } as const;

/** Files that hold or reference the t1 texts themselves (not sources). */
const OWN_FILES = /^test:tests\/(topics-benchmark\/|benchmark\/topic-benchmark|unit\/t1-)/;

const STOPWORDS = new Set(
  "a an the and or but if of to in on at for with from by as is are was were be been it its this that these those i you he she they we me my your his her their our us them so not no do does did just really very too also than then there here what which who how when where why can could would should will about up out over into all any".split(" "),
);

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

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Lines, sentences, quoted and backticked snippets of a prose document. */
function documentSegments(source: string, text: string): Segment[] {
  const parts = new Set<string>();
  for (const line of text.split("\n")) {
    parts.add(line);
    for (const s of line.split(/(?<=[.!?])\s+/)) parts.add(s);
  }
  for (const m of text.matchAll(/`([^`\n]{2,200})`|"([^"\n]{2,200})"|'([^'\n]{3,200})'|“([^”\n]{2,200})”/g)) parts.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
  return [...parts].filter((p) => normalize(p).length > 0).map((p) => ({ source, text: p }));
}

export function collectT1Sources(): Segment[] {
  const segments = collectSources().filter((s) => !OWN_FILES.test(s.source));
  const heldout = JSON.parse(readFileSync(join(ROOT, "fixtures/m2-heldout-v1/comments.json"), "utf8")) as { comments: { id: string; text: string }[] };
  for (const c of heldout.comments) segments.push({ source: `m2-heldout-v1:${c.id}`, text: c.text });
  segments.push(...documentSegments("design:m4-topic-provider-design.md", readFileSync(join(ROOT, "m4-topic-provider-design.md"), "utf8")));
  for (const file of listFiles(join(ROOT, "src/adapters/fakes"))) {
    const rel = relative(ROOT, file);
    if (!/topic/.test(rel)) continue;
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/"((?:[^"\\\n]|\\.){3,200})"|'((?:[^'\\\n]|\\.){3,200})'|`([^`$\n]{3,200})`/g))
      segments.push({ source: `fake:${rel}`, text: m[1] ?? m[2] ?? m[3] ?? "" });
  }
  return segments.filter((s) => s.text.trim().length > 0);
}

export interface T1CommentAudit {
  id: string;
  maxTokenJaccard: number;
  maxTokenSource: string;
  maxTrigramJaccard: number;
  maxTrigramSource: string;
  violations: string[];
}

export function auditT1Comments(comments: readonly { id: string; text: string }[], sources: readonly Segment[]): T1CommentAudit[] {
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
      else if (norm.length >= T1_THRESHOLDS.substringMinChars && s.norm.includes(norm)) violations.push(`contained-in:${s.source}`);
      else if (s.norm.length >= T1_THRESHOLDS.substringMinChars && norm.includes(s.norm)) violations.push(`contains:${s.source}`);
      const tj = tokens.size + s.tokens.size >= 4 ? jaccard(tokens, s.tokens) : 0;
      const gj = norm.length >= 12 && s.norm.length >= 12 ? jaccard(grams, s.grams) : 0;
      if (tj > maxTok) [maxTok, tokSrc] = [tj, s.source];
      if (gj > maxTri) [maxTri, triSrc] = [gj, s.source];
    }
    if (maxTok >= T1_THRESHOLDS.tokenJaccard) violations.push(`token-jaccard:${tokSrc}`);
    if (maxTri >= T1_THRESHOLDS.trigramJaccard) violations.push(`trigram-jaccard:${triSrc}`);
    const round = (x: number) => Math.round(x * 1000) / 1000;
    return { id: c.id, maxTokenJaccard: round(maxTok), maxTokenSource: tokSrc, maxTrigramJaccard: round(maxTri), maxTrigramSource: triSrc, violations: [...new Set(violations)] };
  });
}
