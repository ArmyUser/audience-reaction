import { readFileSync, writeFileSync } from "node:fs";
import { datasetVersion } from "../../src/benchmark/datasets";
import { auditT2Texts, checkT2Independence, collectT2Sources, loadT1, modelOutputFiles, provenanceAtAudit, T2_AUDIT_PATH, T2_DATASET_ID, T2_PATH, T2_THRESHOLDS } from "./t2-leakage-audit";

// Regenerates fixtures/t2-topics-v1/leakage-audit.json. Run from the repository root, before any provider run on
// the dataset version being audited (the artifact records that no t2 result existed then):
//   npx tsx tests/topics-benchmark/write-t2-leakage-audit.ts

/** How the final comments were reached (recorded once; not recomputed). */
const HISTORY = {
  automatedAuditRounds: [
    {
      round: 1,
      rejected: [
        "two-emoji reaction identical to a t1 comment",
        "'subscribed after this one' identical to a t1 comment",
        "birthday shout-out near-duplicate of a t1 off-topic comment",
        "sub-for-sub spam close to a t1 spam comment",
        "late-night viewing reaction close to a t1 comment",
        "shrugging one-liner close to a t1 comment",
        "local food recommendation question close to an m2 comment",
        "'First!' identical to an m2 comment and guideline examples",
        "prompt injection quoting the canonical 'ignore all previous instructions' phrase from guidelines and Jev questions",
        "battery comment containing a topic test literal",
        "crypto spam, script-tag and fake-JSON comments containing test literals",
        "gold topic name, key and accepted names for ruggedness contained in labels from stored t1 model outputs",
        "gold topic name and accepted name for grip and handling equal to a t1 gold accepted name",
        "grip comment using that same t1 accepted name as its subject",
      ],
    },
  ],
  regeneratedCommentsAfterAutomatedAudit: 14,
  renamedGoldTopicsAfterAutomatedAudit: 2,
};

const text = readFileSync(T2_PATH, "utf8");
const dataset = JSON.parse(text) as Parameters<typeof auditT2Texts>[0];
const sources = collectT2Sources();
const { comments, gold } = auditT2Texts(dataset, sources);
const independence = checkT2Independence(text, loadT1(), modelOutputFiles());
const sourceCounts: Record<string, number> = {};
for (const s of sources) {
  const kind = s.source.split(":")[0]!;
  sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
}
const all = [...comments, ...gold];
const artifact = {
  datasetId: T2_DATASET_ID,
  datasetVersion: datasetVersion(text),
  thresholds: T2_THRESHOLDS,
  methods: [
    "exact normalised match",
    "substring containment (either direction, ≥ 10 normalised chars)",
    "content-word Jaccard",
    "character trigram Jaccard",
    "structural independence checks (IDs, t1 gold labels, schema fields, provider vocabulary, prompt text, stored model outputs)",
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
  provenance: { ...provenanceAtAudit(), note: "Gold authored by hand before any provider run on this dataset version." },
  history: HISTORY,
  comments,
  gold,
};
writeFileSync(T2_AUDIT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  `Wrote ${T2_AUDIT_PATH}: ${artifact.summary.violations} violations, ${artifact.summary.independenceChecksFailed} failed independence checks, ` +
    `max token ${artifact.summary.maxTokenJaccard}, max trigram ${artifact.summary.maxTrigramJaccard}, t2 results at audit ${artifact.provenance.t2ResultFiles.length}`,
);
