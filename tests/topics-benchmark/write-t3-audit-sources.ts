import { writeAuditSourceManifest } from "./write-audit-source-manifest";

// Writes the frozen comparison-source manifest of the completed t3 audit, once (it is never rewritten). Same as
//   npx tsx tests/topics-benchmark/write-audit-source-manifest.ts --dataset t3-topics-v1
//   npx tsx tests/topics-benchmark/write-t3-audit-sources.ts

writeAuditSourceManifest("t3-topics-v1");
