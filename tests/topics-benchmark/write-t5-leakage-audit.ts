import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetVersion } from "../../src/benchmark/datasets";
import { goldOf, parseTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { ROOT } from "../heldout/leakage-audit";
import { buildFrozenManifest, FROZEN_AUDITS, frozenKinds } from "./audit-source-manifest";
import { HOLDOUT_THRESHOLDS } from "./holdout-independence-audit";
import { T5_AUDIT, t5DocumentFiles } from "./t5-holdout-audit";

// Writes fixtures/t5-topics-v1/leakage-audit.json and, from it, the frozen source manifest
// tests/topics-benchmark/manifests/t5-topics-v1-audit-sources.json. Run from the repository root, before any provider
// run on the dataset version being audited (the artifact records that no t5 result existed then):
//   npx tsx tests/topics-benchmark/write-t5-leakage-audit.ts
// Once the manifest exists the audit is complete and frozen; the script then refuses to run.

/** How the final comments were reached (recorded once; not recomputed). */
const HISTORY = {
  automatedAuditRounds: [
    {
      round: 1,
      rejected: [
        "five comments and two gold definitions containing a word or phrase that is a test literal or a stored model-output label",
        "three comments containing another test literal (a spam phrase, a video-section phrase, a script tag)",
        "four comments too close to t1, t3 and t4 comments (one exact)",
        "one comment too close to a test literal (token and trigram similarity)",
        "gold topic name and one accepted name equal to topic labels in stored model outputs",
      ],
    },
    { round: 2, rejected: ["spam comment too close to a t2 comment"] },
  ],
  authoringOnlyCheck:
    "The final comments and gold were also audited, with the same algorithm and thresholds, against every committed Markdown document at the time (the six frozen analysis documents plus nine living documents): no overlap. The living documents are not frozen sources.",
  regeneratedCommentsAfterAutomatedAudit: 14,
  changedGoldDefinitionsAfterAutomatedAudit: 2,
  changedGoldLabelsAfterAutomatedAudit: 2,
};

const def = FROZEN_AUDITS["t5-topics-v1"]!;
if (existsSync(join(ROOT, def.manifestPath))) {
  console.error(`${def.manifestPath} exists: the t5 audit is complete and frozen; it is never rewritten.`);
  process.exit(1);
}

const text = readFileSync(T5_AUDIT.config.path, "utf8");
const dataset = parseTopicBenchmarkDataset(text, "t5-topics-v1");
const goldView = goldOf(dataset);
const dispositions: Record<string, number> = {};
for (const d of goldView.dispositions.values()) dispositions[d.disposition] = (dispositions[d.disposition] ?? 0) + 1;
const sentimentDisagreements = goldView.baseIds.filter((id) => {
  const d = goldView.dispositions.get(id)!;
  return d.disposition === "primary_topic" && d.topicSentiment !== goldView.overallSentiment.get(id);
}).length;

const doc = JSON.parse(text) as Parameters<typeof T5_AUDIT.auditTexts>[0];
const sources = T5_AUDIT.collectSources();
const { comments, gold } = T5_AUDIT.auditTexts(doc, sources);
const independence = T5_AUDIT.checkIndependence(text, T5_AUDIT.loadReferences(), T5_AUDIT.modelOutputFiles());
const sourceCounts: Record<string, number> = {};
for (const s of sources) {
  const kind = s.source.split(":")[0]!;
  sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
}
const all = [...comments, ...gold];
const artifact = {
  datasetId: T5_AUDIT.config.datasetId,
  datasetVersion: datasetVersion(text),
  references: T5_AUDIT.config.references.map((r) => r.id),
  thresholds: HOLDOUT_THRESHOLDS,
  methods: [
    "exact normalised match",
    "substring containment (either direction, ≥ 10 normalised chars)",
    "content-word Jaccard",
    "character trigram Jaccard",
    "structural independence checks against t1, t2, t3 and t4 (IDs, gold labels, schema fields, provider vocabulary, prompt text of every contract version, stored model outputs)",
    "the committed t1-t4 analysis and experiment documents (whole text, lines and sentences) as an additional lexical source",
  ],
  sourceSegments: sourceCounts,
  frozenDataset: {
    fileSha256: createHash("sha256").update(text).digest("hex"),
    comments: dataset.comments.length,
    topicBase: goldView.baseIds.length,
    spam: dataset.comments.filter((c) => c.topic === null).length,
    goldTopics: dataset.taxonomy.length,
    dispositions,
    topicSizes: Object.fromEntries(dataset.taxonomy.map((t) => [t.key, goldView.members.get(t.key)!.length])),
    sentimentDisagreements,
  },
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
  provenance: { ...T5_AUDIT.provenanceAtAudit(), note: "Gold authored by hand before any provider run on this dataset version; no result file was consulted." },
  history: HISTORY,
  comments,
  gold,
};
if (artifact.summary.violations > 0 || artifact.summary.independenceChecksFailed > 0 || artifact.provenance.ownResultFiles.length > 0) {
  console.error(`The t5 audit is not clean (${artifact.summary.violations} violations, ${artifact.summary.independenceChecksFailed} failed checks, ${artifact.provenance.ownResultFiles.length} t5 results); nothing written.`);
  process.exit(1);
}
writeFileSync(T5_AUDIT.config.auditPath, `${JSON.stringify(artifact, null, 2)}\n`);

const { manifest, problems, reproduced } = buildFrozenManifest(def);
if (!manifest) {
  console.error(`The source set does not reproduce the t5 audit; no manifest written:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
const documents = t5DocumentFiles();
if (documents.reduce((n, d) => n + d.segments, 0) !== sourceCounts.doc) {
  console.error("The document list does not reproduce the recorded document segments; no manifest written.");
  process.exit(1);
}
const frozen = {
  ...manifest,
  derivation: [...manifest.derivation, `Documents: the ${documents.length} committed t1-t4 analysis and experiment documents listed in t5-holdout-audit.ts, each with SHA-256 and segment count; together they reproduce the recorded ${sourceCounts.doc} document segments.`],
  documents,
};
writeFileSync(join(ROOT, def.manifestPath), `${JSON.stringify(frozen, null, 2)}\n`, { flag: "wx" });
console.log(
  `Wrote ${T5_AUDIT.config.auditPath}: ${artifact.summary.violations} violations, ${artifact.summary.independenceChecksFailed} failed independence checks, ` +
    `max token ${artifact.summary.maxTokenJaccard}, max trigram ${artifact.summary.maxTrigramJaccard}, t5 results at audit ${artifact.provenance.ownResultFiles.length}`,
);
console.log(`Wrote ${def.manifestPath}: ${frozen.modelOutputs.length} model outputs, ${frozen.replay.length} replay responses, ${frozen.prompts.length} prompts, ${frozen.references.length} references, ${documents.length} documents; reproduces ${frozenKinds(def).map((k) => `${k} ${reproduced[k]}`).join(", ")}.`);
