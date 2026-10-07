import { readFileSync, writeFileSync } from "node:fs";
import { datasetVersion } from "../../src/benchmark/datasets";
import { auditT1Comments, collectT1Sources, T1_AUDIT_PATH, T1_PATH, T1_THRESHOLDS } from "./t1-leakage-audit";

// Regenerates fixtures/t1-topics-v1/leakage-audit.json. Run from the repository root:
//   npx tsx tests/topics-benchmark/write-t1-leakage-audit.ts

/** How the final 200 comments were reached (recorded once; not recomputed). */
const HISTORY = {
  automatedAuditRounds: [
    {
      round: 1,
      rejected: [
        "spam 'check out my channel' contained in topic test literals and close to an m2 spam comment",
        "HTML 'img onerror' generic praise close to an m2 injection comment",
        "'<script>' latch comment contained a smoke-test literal",
        "'Interesting.' contained in an m2-heldout-v1 comment",
        "'Meh.' identical to an m2 comment, a guideline example and question examples",
        "'sponsored segment' phrase quoted in spec.md and guideline tests",
        "off-topic local-recommendation question close to an m2 comment",
        "gift-card spam close to an m2-heldout-v1 spam comment",
        "triple laughing emoji identical to an m2 comment",
        "'most useful review' praise close to an m2 comment",
      ],
    },
  ],
  regeneratedAfterAutomatedAudit: 10,
};

const text = readFileSync(T1_PATH, "utf8");
const dataset = JSON.parse(text) as { comments: { id: string; text: string }[] };
const sources = collectT1Sources();
const comments = auditT1Comments(dataset.comments, sources);
const sourceCounts: Record<string, number> = {};
for (const s of sources) {
  const kind = s.source.split(":")[0]!;
  sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
}
const artifact = {
  datasetId: "t1-topics-v1",
  datasetVersion: datasetVersion(text),
  thresholds: T1_THRESHOLDS,
  methods: ["exact normalised match", "substring containment (either direction, ≥ 10 normalised chars)", "content-word Jaccard", "character trigram Jaccard"],
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
writeFileSync(T1_AUDIT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${T1_AUDIT_PATH}: ${artifact.summary.violations} violations, max token ${artifact.summary.maxTokenJaccard}, max trigram ${artifact.summary.maxTrigramJaccard}`);
