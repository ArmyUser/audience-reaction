import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, ROOT, type Segment } from "../heldout/leakage-audit";
import { holdoutAudit } from "./holdout-independence-audit";

// The t5 hold-out audit: the hold-out audit module (unchanged algorithm, thresholds and structural checks) against
// t1, t2, t3 and t4, plus one source kind of its own: the committed t1-t4 analysis and experiment documents (the
// validation analyses, the v4 pre-registration and postmortem, the instrumentation notes and the paired-experiment
// design). These are historical records, so the list is explicit and frozen with the audit (path and SHA-256 in the
// t5 source manifest); documents added later are never part of it. Living documents that are edited over time
// (spec, architecture, provider docs) are not frozen sources; spec.md and the M4 design stay covered as t1 sources.

export const T5_DOCUMENTS: readonly string[] = [
  "docs/topic-consolidation-paired-experiment.md",
  "docs/topic-consolidation-v4-experiment.md",
  "docs/topic-consolidation-v4-postmortem.md",
  "docs/topic-real-consolidated-instrumentation.md",
  "docs/topic-validation-t1-t2-sonnet-v3.md",
  "docs/topic-validation-t1-t2-t3-sonnet-v3.md",
];

const base = holdoutAudit({
  datasetId: "t5-topics-v1",
  path: "fixtures/t5-topics-v1/comments.json",
  auditPath: "fixtures/t5-topics-v1/leakage-audit.json",
  references: [
    { id: "t1-topics-v1", path: "fixtures/t1-topics-v1/comments.json" },
    { id: "t2-topics-v1", path: "fixtures/t2-topics-v1/comments.json" },
    { id: "t3-topics-v1", path: "fixtures/t3-topics-v1/comments.json" },
    { id: "t4-topics-v1", path: "fixtures/t4-topics-v1/comments.json" },
  ],
  ownFiles: /^test:tests\/(topics-benchmark\/|unit\/t5-)/,
});

/** Whole document, each line and each sentence: the same segmentation the hold-out audit applies to prompt text. */
function documentSegments(source: string, text: string): Segment[] {
  const parts = new Set<string>([text]);
  for (const line of text.split("\n")) {
    parts.add(line);
    for (const s of line.split(/(?<=[.!?])\s+/)) parts.add(s);
  }
  return [...parts].filter((p) => normalize(p).length > 0).map((p) => ({ source, text: p }));
}

export interface FrozenDocument {
  path: string;
  sha256: string;
  segments: number;
}

const sha256Of = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The listed documents as read now, with their hashes and segment counts (recorded once, by the writer). */
export function t5DocumentFiles(root = ROOT): FrozenDocument[] {
  return T5_DOCUMENTS.map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, sha256: sha256Of(bytes), segments: documentSegments(`doc:${path}`, bytes.toString("utf8")).length };
  });
}

/** Document segments from a frozen list; a missing, changed or re-segmented document is an error, never skipped. */
export function frozenDocumentSegments(documents: readonly FrozenDocument[], root = ROOT): Segment[] {
  return documents.flatMap((d) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, d.path));
    } catch {
      throw new Error(`frozen audit document missing: ${d.path}`);
    }
    if (sha256Of(bytes) !== d.sha256) throw new Error(`frozen audit document changed: ${d.path}`);
    const segments = documentSegments(`doc:${d.path}`, bytes.toString("utf8"));
    if (segments.length !== d.segments) throw new Error(`frozen audit document yields ${segments.length} segments, manifest records ${d.segments}: ${d.path}`);
    return segments;
  });
}

export const T5_AUDIT = {
  ...base,
  /** The hold-out sources plus every listed document. */
  collectSources: (): Segment[] => [...base.collectSources(), ...frozenDocumentSegments(t5DocumentFiles())],
};
