import { readFileSync, writeFileSync } from "node:fs";
import { datasetVersion } from "../../src/benchmark/datasets";
import { auditT3Texts, checkT3Independence, collectT3Sources, loadReferences, T3_AUDIT_PATH, T3_DATASET_ID, T3_PATH, t3ModelOutputFiles, t3ProvenanceAtAudit, T3_THRESHOLDS } from "./t3-leakage-audit";

// Regenerates fixtures/t3-topics-v1/leakage-audit.json. Run from the repository root, before any provider run on
// the dataset version being audited (the artifact records that no t3 result existed then):
//   npx tsx tests/topics-benchmark/write-t3-leakage-audit.ts

/** How the final comments were reached (recorded once; not recomputed). */
const HISTORY = {
  automatedAuditRounds: [
    {
      round: 1,
      rejected: [
        "generic praise for the review close to a t2 comment",
        "fake admin-override comment close to a guideline description of system-directed text",
        "channel-plug spam containing a phrase quoted in spec.md",
        "pet anecdote close to an m2 off-topic comment",
        "gold accepted name for replayability containing a t1 gold key",
      ],
    },
  ],
  manualRewritesBeforeAudit: ["incidental-mention question that reused the sentence pattern of a t2 comment"],
  regeneratedCommentsAfterAutomatedAudit: 4,
  changedGoldLabelsAfterAutomatedAudit: 1,
};

const text = readFileSync(T3_PATH, "utf8");
const dataset = JSON.parse(text) as Parameters<typeof auditT3Texts>[0];
const sources = collectT3Sources();
const { comments, gold } = auditT3Texts(dataset, sources);
const independence = checkT3Independence(text, loadReferences(), t3ModelOutputFiles());
const sourceCounts: Record<string, number> = {};
for (const s of sources) {
  const kind = s.source.split(":")[0]!;
  sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
}
const all = [...comments, ...gold];
const artifact = {
  datasetId: T3_DATASET_ID,
  datasetVersion: datasetVersion(text),
  references: loadReferences().map((r) => r.datasetId),
  thresholds: T3_THRESHOLDS,
  methods: [
    "exact normalised match",
    "substring containment (either direction, ≥ 10 normalised chars)",
    "content-word Jaccard",
    "character trigram Jaccard",
    "structural independence checks against t1 and t2 (IDs, gold labels, schema fields, provider vocabulary, prompt text, stored model outputs)",
  ],
  sourceSegments: sourceCounts,
  summary: {
    comments: comments.length,
    goldDefinitions: gold.length,
    violations: all.filter((c) => c.violations.length > 0).length,
    maxTokenJaccard: Math.max(...all.map((c) => c.maxTokenJaccard)),
    maxTrigramJaccard: Math.max(...all.map((c) => c.maxTrigramJaccard)),
    independenceChecksPassed: independence.filter((c) => c.passed).length,
    independenceChecksFailed: independence.filter((c) => !c.passed).length,
  },
  independence,
  provenance: { ...t3ProvenanceAtAudit(), note: "Gold authored by hand before any provider run on this dataset version; no result file was consulted." },
  history: HISTORY,
  comments,
  gold,
};
writeFileSync(T3_AUDIT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  `Wrote ${T3_AUDIT_PATH}: ${artifact.summary.violations} violations, ${artifact.summary.independenceChecksFailed} failed independence checks, ` +
    `max token ${artifact.summary.maxTokenJaccard}, max trigram ${artifact.summary.maxTrigramJaccard}, t3 results at audit ${artifact.provenance.t3ResultFiles.length}`,
);
