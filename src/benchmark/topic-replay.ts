import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplayTopicTransport, type ReplayScript } from "../adapters/replay/replay-topic-transport";
import { ContractTopicAssigner, ContractTopicTaxonomyGenerator } from "../application/contract-topic-phases";
import { TOPIC_ASSIGNMENT_CONTRACT, TOPIC_DISCOVERY_CONTRACT, type TopicPhase } from "../core/topics/provider-contracts";
import { runTopicBenchmarkScenarios, type TopicBenchmarkOptions, type TopicBenchmarkReport } from "./topic-benchmark";
import type { TopicBenchmarkDataset, TopicBenchmarkDatasetId } from "./topic-datasets";
import { buildTopicScenario, type TopicScenario, type TopicScenarioExpectation } from "./topic-scenarios";

// Replay benchmark: recorded raw model responses (fixtures/topic-provider-replay/) go through the complete production
// path: contract request rendering → ReplayTopicTransport (returns the raw text unaltered) → contract parsing →
// TwoPhaseTopicDiscoverer → frozen validators, retry and reportability → t1 metrics. The oracle runs first as the gate.
// No model, network or key is involved.

export const REPLAY_FIXTURE_DIR: Partial<Record<TopicBenchmarkDatasetId, string>> & { "t1-topics-v1": string } = {
  "t1-topics-v1": "fixtures/topic-provider-replay/t1-topics-v1",
};

export interface ReplayManifest {
  datasetId: string;
  datasetVersion: string;
  description: string;
  responses: { id: string; phase: TopicPhase; contract: string; file: string; sha256: string; description: string }[];
}

export interface ReplayResponseRecord {
  phase: TopicPhase;
  contract: string;
  raw: string;
}

/** Earlier discovery contract versions whose responses have the current output format (only the instructions changed). */
export const OUTPUT_COMPATIBLE_DISCOVERY_CONTRACTS: readonly string[] = ["topic-discovery-v1"];

/**
 * Loads the recorded responses for a dataset, byte for byte. Fails if a file's hash differs from the manifest, the
 * manifest belongs to another dataset version, or a response was recorded for another contract version (except an
 * output-compatible earlier discovery version).
 */
export function loadTopicReplayResponses(dataset: TopicBenchmarkDataset): Map<string, ReplayResponseRecord> {
  const dir = REPLAY_FIXTURE_DIR[dataset.id as TopicBenchmarkDatasetId];
  if (!dir) throw new Error(`No replay fixtures for ${dataset.id}`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ReplayManifest;
  if (manifest.datasetId !== dataset.id || manifest.datasetVersion !== dataset.version) throw new Error("Replay fixtures belong to another dataset version");
  const current: Record<TopicPhase, string> = { taxonomy_discovery: TOPIC_DISCOVERY_CONTRACT, comment_assignment: TOPIC_ASSIGNMENT_CONTRACT };
  // topic-discovery-v2 changed only the instructions, not the output format, so v1-format responses replay unchanged.
  const accepted = (r: { phase: TopicPhase; contract: string }) => r.contract === current[r.phase] || (r.phase === "taxonomy_discovery" && OUTPUT_COMPATIBLE_DISCOVERY_CONTRACTS.includes(r.contract));
  const out = new Map<string, ReplayResponseRecord>();
  for (const r of manifest.responses) {
    const raw = readFileSync(join(dir, r.file), "utf8");
    if (createHash("sha256").update(raw).digest("hex") !== r.sha256) throw new Error(`Replay response ${r.id} does not match its recorded hash`);
    if (!accepted(r)) throw new Error(`Replay response ${r.id} was recorded for ${r.contract}, not ${current[r.phase]}`);
    out.set(r.id, { phase: r.phase, contract: r.contract, raw });
  }
  return out;
}

export const TOPIC_REPLAY_SCENARIO_IDS = [
  "replay-perfect",
  "replay-taxonomy-retry",
  "replay-malformed-taxonomy-retry",
  "replay-assignment-retry",
  "replay-missing-comment-retry",
  "replay-persistent-taxonomy-failure",
  "replay-persistent-malformed-assignment",
  "replay-topic-sentiment-corruption",
  "replay-injection-obeyed",
] as const;

export type TopicReplayScenarioId = (typeof TOPIC_REPLAY_SCENARIO_IDS)[number];

export function isTopicReplayScenarioId(value: string): value is TopicReplayScenarioId {
  return (TOPIC_REPLAY_SCENARIO_IDS as readonly string[]).includes(value);
}

interface ReplaySpec {
  description: string;
  taxonomy: string[];
  assignment: string[];
  expected: TopicScenarioExpectation;
}

const available = (attempts: 1 | 2, generatorCalls: number, assignerCalls: number, failedAttemptCodes: TopicScenarioExpectation["failedAttemptCodes"], perfect: boolean, outcome: string): TopicScenarioExpectation => ({
  status: "available",
  attempts,
  generatorCalls,
  assignerCalls,
  failedAttemptCodes,
  perfect,
  outcome,
});

const SPECS: Record<TopicReplayScenarioId, ReplaySpec> = {
  "replay-perfect": {
    description: "A. Valid discovery and valid assignment in the model's own wording.",
    taxonomy: ["taxonomy-perfect"],
    assignment: ["assignment-perfect"],
    expected: available(1, 1, 1, [], true, "accepted first time; every metric perfect (matching ignores the model's names)"),
  },
  "replay-taxonomy-retry": {
    description: "B. Taxonomy with a duplicate normalised name, then a valid taxonomy.",
    taxonomy: ["taxonomy-duplicate-name", "taxonomy-perfect"],
    assignment: ["assignment-perfect"],
    expected: available(2, 2, 1, [["duplicate_topic_name"]], true, "rediscovery receives the feedback; assignment runs once on the valid taxonomy"),
  },
  "replay-malformed-taxonomy-retry": {
    description: "B'. Taxonomy wrapped in prose and a code fence, then a valid taxonomy.",
    taxonomy: ["taxonomy-malformed-prose", "taxonomy-perfect"],
    assignment: ["assignment-perfect"],
    expected: available(2, 2, 1, [["invalid_output"]], true, "not repaired: invalid output, rediscovered on retry"),
  },
  "replay-assignment-retry": {
    description: "C. Valid taxonomy; assignment cites an invented key for three comments, then corrects exactly those.",
    taxonomy: ["taxonomy-perfect"],
    assignment: ["assignment-unknown-topic", "assignment-unknown-topic-retry"],
    expected: available(2, 1, 2, [["unknown_topic"]], true, "taxonomy reused; only the three affected comments are reassigned"),
  },
  "replay-missing-comment-retry": {
    description: "C'. Valid taxonomy; assignment omits two comments, then answers exactly those.",
    taxonomy: ["taxonomy-perfect"],
    assignment: ["assignment-missing-comment", "assignment-missing-comment-retry"],
    expected: available(2, 1, 2, [["missing_assignment"]], true, "taxonomy reused; only the two missing comments are reassigned"),
  },
  "replay-persistent-taxonomy-failure": {
    description: "D. Taxonomy with an empty definition, twice.",
    taxonomy: ["taxonomy-missing-definition", "taxonomy-missing-definition"],
    assignment: [],
    expected: {
      status: "unavailable",
      attempts: 2,
      generatorCalls: 2,
      assignerCalls: 0,
      failedAttemptCodes: [["missing_definition"], ["missing_definition"]],
      perfect: false,
      outcome: "TOPICS_UNAVAILABLE without assignment and without partial topics",
    },
  },
  "replay-persistent-malformed-assignment": {
    description: "D'. Valid taxonomy; assignment truncated, then fenced in Markdown.",
    taxonomy: ["taxonomy-perfect"],
    assignment: ["assignment-malformed-truncated", "assignment-malformed-fenced"],
    expected: {
      status: "unavailable",
      attempts: 2,
      generatorCalls: 1,
      assignerCalls: 2,
      failedAttemptCodes: [["invalid_output"], ["invalid_output"]],
      perfect: false,
      outcome: "not repaired: TOPICS_UNAVAILABLE without partial topics",
    },
  },
  "replay-topic-sentiment-corruption": {
    description: "E. Valid output whose topic sentiment copies the overall sentiment.",
    taxonomy: ["taxonomy-perfect"],
    assignment: ["assignment-wrong-sentiment"],
    expected: available(1, 1, 1, [], false, "accepted; topic-sentiment accuracy drops to the overall/topic agreement rate"),
  },
  "replay-injection-obeyed": {
    description: "F'. Valid output in which the model obeyed two instruction-like comments.",
    taxonomy: ["taxonomy-perfect"],
    assignment: ["assignment-injection-obeyed"],
    expected: available(1, 1, 1, [], false, "accepted structurally; the benchmark detects the changed dispositions"),
  },
};

export function buildTopicReplayScenario(id: TopicReplayScenarioId, responses: ReadonlyMap<string, ReplayResponseRecord>): TopicScenario {
  const spec = SPECS[id];
  const raw = (name: string, phase: TopicPhase) => {
    const r = responses.get(name);
    if (!r || r.phase !== phase) throw new Error(`Missing ${phase} replay response ${name}`);
    return r.raw;
  };
  const script: ReplayScript = {
    taxonomy_discovery: spec.taxonomy.map((n) => raw(n, "taxonomy_discovery")),
    comment_assignment: spec.assignment.map((n) => raw(n, "comment_assignment")),
  };
  return {
    id,
    group: "replay",
    description: spec.description,
    taxonomySteps: [],
    assignmentSteps: [],
    providers: () => {
      const transport = new ReplayTopicTransport(script);
      return { generator: new ContractTopicTaxonomyGenerator(transport), assigner: new ContractTopicAssigner(transport) };
    },
    expected: spec.expected,
  };
}

/** The oracle gate, then the replay scenarios. */
export async function runTopicReplayBenchmark(dataset: TopicBenchmarkDataset, ids: readonly TopicReplayScenarioId[] = TOPIC_REPLAY_SCENARIO_IDS, options: TopicBenchmarkOptions = {}): Promise<TopicBenchmarkReport> {
  const responses = loadTopicReplayResponses(dataset);
  return runTopicBenchmarkScenarios(dataset, [buildTopicScenario(dataset, "oracle"), ...ids.map((id) => buildTopicReplayScenario(id, responses))], options);
}
