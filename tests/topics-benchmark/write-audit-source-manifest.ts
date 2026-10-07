import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../heldout/leakage-audit";
import { buildFrozenManifest, FROZEN_AUDITS, frozenKinds } from "./audit-source-manifest";

// Writes the frozen comparison-source manifest of a COMPLETED independence audit, once; never overwrites one. The
// stored model outputs are the result files the audit artifact recorded as present at audit time (the first N of the
// audit's own listing), accepted only if they reproduce every frozen segment count the artifact recorded. Any
// mismatch aborts without writing.
//   npx tsx tests/topics-benchmark/write-audit-source-manifest.ts --dataset t2-topics-v1|t3-topics-v1|t4-topics-v1

export function writeAuditSourceManifest(datasetId: string): void {
  const def = FROZEN_AUDITS[datasetId];
  if (!def) throw new Error(`No frozen audit definition for "${datasetId}". Use ${Object.keys(FROZEN_AUDITS).join(", ")}.`);
  const path = join(ROOT, def.manifestPath);
  if (existsSync(path)) {
    console.error(`${def.manifestPath} exists and is frozen; it is never rewritten.`);
    process.exit(1);
  }
  const { manifest, problems, reproduced } = buildFrozenManifest(def);
  if (!manifest) {
    console.error(`The source set does not reproduce the completed ${datasetId} audit; nothing written:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote ${def.manifestPath}: ${manifest.modelOutputs.length} model outputs, ${manifest.replay.length} replay responses, ${manifest.prompts.length} prompts, ${manifest.references.length} references; reproduces ${frozenKinds(def).map((k) => `${k} ${reproduced[k]}`).join(", ")}.`);
}

if (process.argv[1]?.endsWith("write-audit-source-manifest.ts")) {
  const { values } = parseArgs({ options: { dataset: { type: "string" } } });
  if (!values.dataset) {
    console.error("--dataset is required");
    process.exit(1);
  }
  writeAuditSourceManifest(values.dataset);
}
