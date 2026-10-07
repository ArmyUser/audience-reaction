import { readFileSync, writeFileSync } from "node:fs";
import { datasetVersion } from "../../src/benchmark/datasets";
import { HOLDOUT_THRESHOLDS, T4_AUDIT } from "./holdout-independence-audit";

// Regenerates fixtures/t4-topics-v1/leakage-audit.json. Run from the repository root, before any provider run on
// the dataset version being audited (the artifact records that no t4 result existed then):
//   npx tsx tests/topics-benchmark/write-t4-leakage-audit.ts

/** How the final comments were reached (recorded once; not recomputed). */
const HISTORY = {
  automatedAuditRounds: [
    {
      round: 1,
      rejected: [
        "generic 'how I found this video' reaction contained in a t1 comment",
        "discount question contained in a t1 comment",
        "end-of-data injection too close to a t3 injection",
        "chat-scenario comment containing a word that is a t3 gold key and a stored model-output label",
        "injection addressed to a classifier, a word that is a test and design-document literal",
        "fake JSON comment whose key is a test and design-document literal",
        "request for another review close to a spec.md segment",
        "microphone question close to a test literal",
        "dataset description naming the experimental consolidation contract (provider/contract vocabulary)",
      ],
    },
    {
      round: 2,
      rejected: ["injection naming a poem form that is also a model name (provider vocabulary)", "deck-builder request containing a test literal"],
    },
  ],
  regeneratedCommentsAfterAutomatedAudit: 9,
  changedDescriptionAfterAutomatedAudit: 1,
};

const text = readFileSync(T4_AUDIT.config.path, "utf8");
const doc = JSON.parse(text) as Parameters<typeof T4_AUDIT.auditTexts>[0];
const sources = T4_AUDIT.collectSources();
const { comments, gold } = T4_AUDIT.auditTexts(doc, sources);
const independence = T4_AUDIT.checkIndependence(text, T4_AUDIT.loadReferences(), T4_AUDIT.modelOutputFiles());
const sourceCounts: Record<string, number> = {};
for (const s of sources) {
  const kind = s.source.split(":")[0]!;
  sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
}
const all = [...comments, ...gold];
const artifact = {
  datasetId: T4_AUDIT.config.datasetId,
  datasetVersion: datasetVersion(text),
  references: T4_AUDIT.config.references.map((r) => r.id),
  thresholds: HOLDOUT_THRESHOLDS,
  methods: [
    "exact normalised match",
    "substring containment (either direction, ≥ 10 normalised chars)",
    "content-word Jaccard",
    "character trigram Jaccard",
    "structural independence checks against t1, t2 and t3 (IDs, gold labels, schema fields, provider vocabulary, prompt text of every contract version, stored model outputs)",
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
  provenance: { ...T4_AUDIT.provenanceAtAudit(), note: "Gold authored by hand before any provider run on this dataset version; no result file was consulted." },
  history: HISTORY,
  comments,
  gold,
};
writeFileSync(T4_AUDIT.config.auditPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  `Wrote ${T4_AUDIT.config.auditPath}: ${artifact.summary.violations} violations, ${artifact.summary.independenceChecksFailed} failed independence checks, ` +
    `max token ${artifact.summary.maxTokenJaccard}, max trigram ${artifact.summary.maxTrigramJaccard}, t4 results at audit ${artifact.provenance.ownResultFiles.length}`,
);
