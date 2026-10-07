import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPLAY_FIXTURE_DIR, type ReplayManifest } from "../../src/benchmark/topic-replay";
import { loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { TOPIC_ASSIGNMENT_CONTRACT, TOPIC_DISCOVERY_CONTRACT } from "../../src/core/topics/provider-contracts";
import { buildReplayResponses } from "./replay-fixtures";

// Regenerates fixtures/topic-provider-replay/t1-topics-v1/. Run from the repository root:
//   npx tsx tests/topics-benchmark/write-replay-fixtures.ts

const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const dir = REPLAY_FIXTURE_DIR["t1-topics-v1"];
mkdirSync(join(dir, "responses"), { recursive: true });
const manifest: ReplayManifest = {
  datasetId: dataset.id,
  datasetVersion: dataset.version,
  description: "Recorded raw model responses for replay through the topic contracts (synthetic, written for this project; no model was called).",
  responses: buildReplayResponses(dataset).map((r) => {
    const file = `responses/${r.id}.txt`;
    writeFileSync(join(dir, file), r.raw);
    return {
      id: r.id,
      phase: r.phase,
      contract: r.phase === "taxonomy_discovery" ? TOPIC_DISCOVERY_CONTRACT : TOPIC_ASSIGNMENT_CONTRACT,
      file,
      sha256: createHash("sha256").update(r.raw).digest("hex"),
      description: r.description,
    };
  }),
};
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.responses.length} replay responses to ${dir}`);
