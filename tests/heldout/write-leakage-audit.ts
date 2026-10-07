import { readFileSync, writeFileSync } from "node:fs";
import { datasetVersion } from "../../src/benchmark/datasets";
import { AUDIT_PATH, auditComments, collectSources, HELDOUT_PATH, THRESHOLDS } from "./leakage-audit";

// Regenerates fixtures/m2-heldout-v1/leakage-audit.json. Run from the repository root:
//   npx tsx tests/heldout/write-leakage-audit.ts

/** How the final 100 comments were reached (recorded once; not recomputed). */
const HISTORY = {
  draftsReplacedBeforeAutomatedAudit: 26,
  draftReplacementReasons: [
    "near-paraphrase of an m2 comment (e.g. creator-setup question, follow-up wish, explanation praise, honesty about sponsors, 'bro' test complaint, refund complaint, 'mid' slang, off-topic 'anyone know', 'daily' self-promotion, 'skip to' timestamp)",
    "near-paraphrase of a guideline or question example (e.g. 'Your channel is…', 'W', 'next time', 'buggy and overpriced', 'way too long', 'he didn't test it', 'follow-up', 'would love')",
    "same mechanism and wording as an m2 injection (summary rewrite, topic creation, 'ignore … instructions', label-everything-positive)",
    "spec.md example ('Your editing is great')",
  ],
  automatedAuditRounds: [
    { round: 1, rejected: ["h1-062 contains rule O example 'the product'", "h1-066 contains sponsor-reference example 'the sponsor'", "h1-074 contains 'the sponsor'", "h1-096 contains question key 'focus sentiment'"] },
    { round: 2, rejected: ["h1-085 shares slang token 'fr' with m2-c21 (review band)", "h1-100 same 'return an empty result' intent as m2-c45 (review band)"] },
    { round: 3, rejected: ["h1-030 shares the phrase 'comparison table' with m2-c54 (review band)"] },
  ],
  regeneratedAfterAutomatedAudit: 7,
};

const text = readFileSync(HELDOUT_PATH, "utf8");
const dataset = JSON.parse(text) as { comments: { id: string; text: string }[] };
const sources = collectSources();
const comments = auditComments(dataset.comments, sources);
const sourceCounts: Record<string, number> = {};
for (const s of sources) {
  const kind = s.source.split(":")[0]!;
  sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
}
const artifact = {
  datasetId: "m2-heldout-v1",
  datasetVersion: datasetVersion(text),
  thresholds: THRESHOLDS,
  sourceSegments: sourceCounts,
  summary: {
    comments: comments.length,
    violations: comments.filter((c) => c.violations.length > 0).length,
    maxTokenJaccard: Math.max(...comments.map((c) => c.maxTokenJaccard)),
    maxTrigramJaccard: Math.max(...comments.map((c) => c.maxTrigramJaccard)),
  },
  history: HISTORY,
  comments,
};
writeFileSync(AUDIT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${AUDIT_PATH}: ${artifact.summary.violations} violations, max token ${artifact.summary.maxTokenJaccard}, max trigram ${artifact.summary.maxTrigramJaccard}`);
