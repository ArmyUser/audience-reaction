import type { AssignmentStep, TaxonomyStep } from "../adapters/fakes/topic-benchmark-phases";
import type { TopicAssigner, TopicTaxonomyGenerator } from "../core/ports";
import type { TopicIssueCode } from "../core/topics/types";
import type { TopicBenchmarkDataset } from "./topic-datasets";

// Deterministic topic benchmark scenarios: the oracle (mandatory sanity gate, always run first) and scripted
// degradations of either phase. Each scenario states its expected outcome up front; the benchmark checks it.

export type TopicScenarioGroup = "oracle" | "taxonomy" | "assignment" | "retry" | "taxonomy_quality" | "replay" | "live";

export interface TopicScenarioExpectation {
  status: "available" | "unavailable";
  attempts: 1 | 2;
  generatorCalls: number;
  assignerCalls: number;
  /** Issue codes of each failed attempt, in attempt order (empty when the first attempt is accepted). */
  failedAttemptCodes: TopicIssueCode[][];
  /** Every taxonomy, assignment, topic-sentiment and reportability metric is perfect. */
  perfect: boolean;
  /** Plain-language expected outcome. */
  outcome: string;
}

export interface TopicScenario {
  id: string;
  group: TopicScenarioGroup;
  description: string;
  /** Per generator call (the last step repeats). */
  taxonomySteps: TaxonomyStep[];
  /** Per assigner call (the last step repeats). */
  assignmentSteps: AssignmentStep[];
  /** Comment ID → taxonomy key, for valid taxonomies that differ from gold. */
  keyOverride?: ReadonlyMap<string, string>;
  /**
   * Fresh phase providers for one run, replacing the scripted gold providers (e.g. contract providers over a replay
   * transport). Called once per repeat.
   */
  providers?: () => { generator: TopicTaxonomyGenerator; assigner: TopicAssigner };
  expected: TopicScenarioExpectation;
}

export const TOPIC_SCENARIO_IDS = [
  "oracle",
  "taxonomy-duplicate-name",
  "taxonomy-missing-definition",
  "taxonomy-too-many-topics",
  "taxonomy-invalid-example",
  "assignment-missing-comment",
  "assignment-duplicate",
  "assignment-unknown-topic",
  "assignment-wrong-sentiment",
  "assignment-other-nst-swap",
  "assignment-over-other",
  "assignment-malformed",
  "taxonomy-invalid",
  "assignment-invalid",
  "retry-success",
  "retry-failure",
  "taxonomy-merged",
  "taxonomy-split",
] as const;

export type TopicScenarioId = (typeof TOPIC_SCENARIO_IDS)[number];

export function isTopicScenarioId(value: string): value is TopicScenarioId {
  return (TOPIC_SCENARIO_IDS as readonly string[]).includes(value);
}

/** Gold topics the taxonomy-quality and collapse scenarios degrade, per dataset (naturally confusable pairs). */
const DEGRADATION_TARGETS: Record<string, { merge: [string, string]; split: string; splitFirst: number; collapse: [string, string] }> = {
  "t1-topics-v1": { merge: ["range", "charging"], split: "motor", splitFirst: 15, collapse: ["range", "motor"] },
  "t2-topics-v1": { merge: ["video", "stabilization"], split: "autofocus", splitFirst: 15, collapse: ["autofocus", "image_quality"] },
  "t3-topics-v1": { merge: ["rules", "difficulty"], split: "components", splitFirst: 15, collapse: ["components", "rules"] },
  "t4-topics-v1": { merge: ["tutors", "chat_partner"], split: "motivation", splitFirst: 13, collapse: ["motivation", "lessons"] },
  "t5-topics-v1": { merge: ["thermal", "warmup"], split: "upkeep", splitFirst: 12, collapse: ["upkeep", "extraction"] },
};

const ORACLE: TaxonomyStep = { kind: "oracle" };
const ORACLE_ASSIGN: AssignmentStep = { kind: "oracle" };

export function buildTopicScenario(dataset: TopicBenchmarkDataset, id: TopicScenarioId): TopicScenario {
  const persistentTaxonomy = (step: TaxonomyStep, code: TopicIssueCode, what: string): Omit<TopicScenario, "id"> => ({
    group: "taxonomy",
    description: `Both taxonomy proposals ${what}.`,
    taxonomySteps: [step],
    assignmentSteps: [ORACLE_ASSIGN],
    expected: {
      status: "unavailable",
      attempts: 2,
      generatorCalls: 2,
      assignerCalls: 0,
      failedAttemptCodes: [[code], [code]],
      perfect: false,
      outcome: "validation catches it before assignment; rediscovery repeats it → TOPICS_UNAVAILABLE",
    },
  });
  const persistentAssignment = (step: AssignmentStep, code: TopicIssueCode, what: string, retryAll = false): Omit<TopicScenario, "id"> => ({
    group: "assignment",
    description: `Both assignment responses ${what}.`,
    taxonomySteps: [ORACLE],
    assignmentSteps: [step],
    expected: {
      status: "unavailable",
      attempts: 2,
      generatorCalls: 1,
      assignerCalls: 2,
      failedAttemptCodes: [[code], [code]],
      perfect: false,
      outcome: `validation catches it; ${retryAll ? "full" : "affected-only"} reassignment repeats it → TOPICS_UNAVAILABLE`,
    },
  });
  const acceptedButWrong = (step: AssignmentStep, what: string, outcome: string): Omit<TopicScenario, "id"> => ({
    group: "assignment",
    description: `Assignment is structurally valid but ${what}.`,
    taxonomySteps: [ORACLE],
    assignmentSteps: [step],
    expected: { status: "available", attempts: 1, generatorCalls: 1, assignerCalls: 1, failedAttemptCodes: [], perfect: false, outcome },
  });

  const spec = ((): Omit<TopicScenario, "id"> => {
    switch (id) {
      case "oracle":
        return {
          group: "oracle",
          description: "Gold taxonomy and gold dispositions (harness sanity check; must score 100%).",
          taxonomySteps: [ORACLE],
          assignmentSteps: [ORACLE_ASSIGN],
          expected: { status: "available", attempts: 1, generatorCalls: 1, assignerCalls: 1, failedAttemptCodes: [], perfect: true, outcome: "accepted first time; every metric perfect" },
        };
      case "taxonomy-duplicate-name":
        return persistentTaxonomy({ kind: "duplicate_name" }, "duplicate_topic_name", "contain two names that normalise identically");
      case "taxonomy-missing-definition":
        return persistentTaxonomy({ kind: "missing_definition" }, "missing_definition", "leave a definition blank");
      case "taxonomy-too-many-topics":
        return persistentTaxonomy({ kind: "too_many_topics" }, "too_many_topics", "propose more topics than max_topics");
      case "taxonomy-invalid-example":
        return persistentTaxonomy({ kind: "invalid_example" }, "unknown_example_comment", "cite an example ID outside the discovery sample");
      case "assignment-missing-comment":
        return persistentAssignment({ kind: "missing_comment", count: 3 }, "missing_assignment", "omit three requested comments");
      case "assignment-duplicate":
        return persistentAssignment({ kind: "duplicate_assignment" }, "multiple_primary_topics", "give one comment two entries");
      case "assignment-unknown-topic":
        return persistentAssignment({ kind: "unknown_topic", count: 3 }, "unknown_topic", "cite a topic key outside the taxonomy");
      case "assignment-malformed":
        return persistentAssignment({ kind: "malformed" }, "invalid_output", "are not an array of entries", true);
      case "assignment-wrong-sentiment":
        return acceptedButWrong({ kind: "overall_sentiment" }, "copies overall sentiment as topic sentiment", "accepted (not a validation error); topic-sentiment accuracy drops to the overall/topic agreement rate");
      case "assignment-other-nst-swap":
        return acceptedButWrong({ kind: "swap_other_nst" }, "swaps OTHER and NO_SPECIFIC_TOPIC", "accepted; OTHER and NO_SPECIFIC_TOPIC accuracy and shares wrong, combined share unchanged");
      case "assignment-over-other": {
        const keys = DEGRADATION_TARGETS[dataset.id]!.collapse;
        return acceptedButWrong({ kind: "collapse_to_other", topicKeys: keys }, `puts the ${keys.join(" and ")} comments under OTHER`, "accepted; two named topics vanish and HIGH_OTHER_SHARE fires although gold does not warn");
      }
      case "taxonomy-invalid":
        return {
          group: "retry",
          description: "Attempt 1 taxonomy has a duplicate normalised name; attempt 2 taxonomy is correct.",
          taxonomySteps: [{ kind: "duplicate_name" }, ORACLE],
          assignmentSteps: [ORACLE_ASSIGN],
          expected: { status: "available", attempts: 2, generatorCalls: 2, assignerCalls: 1, failedAttemptCodes: [["duplicate_topic_name"]], perfect: true, outcome: "rediscovery with taxonomy feedback repairs it; assignment runs once, on the valid taxonomy" },
        };
      case "assignment-invalid":
        return {
          group: "retry",
          description: "Attempt 1 assignment cites an unknown topic for three comments; the retry reassigns only those.",
          taxonomySteps: [ORACLE],
          assignmentSteps: [{ kind: "unknown_topic", count: 3 }, ORACLE_ASSIGN],
          expected: { status: "available", attempts: 2, generatorCalls: 1, assignerCalls: 2, failedAttemptCodes: [["unknown_topic"]], perfect: true, outcome: "affected-only reassignment with feedback repairs it; taxonomy kept" },
        };
      case "retry-success":
        return {
          group: "retry",
          description: "Attempt 1 assignment response is malformed; attempt 2 is correct.",
          taxonomySteps: [ORACLE],
          assignmentSteps: [{ kind: "malformed" }, ORACLE_ASSIGN],
          expected: { status: "available", attempts: 2, generatorCalls: 1, assignerCalls: 2, failedAttemptCodes: [["invalid_output"]], perfect: true, outcome: "full reassignment with feedback repairs it; taxonomy kept" },
        };
      case "retry-failure":
        return {
          group: "retry",
          description: "Attempt 1 taxonomy leaves a definition blank; attempt 2 taxonomy is valid but its assignment duplicates a comment.",
          taxonomySteps: [{ kind: "missing_definition" }, ORACLE],
          assignmentSteps: [{ kind: "duplicate_assignment" }],
          expected: {
            status: "unavailable",
            attempts: 2,
            generatorCalls: 2,
            assignerCalls: 1,
            failedAttemptCodes: [["missing_definition"], ["multiple_primary_topics"]],
            perfect: false,
            outcome: "two different failures exhaust the single retry → TOPICS_UNAVAILABLE, no partial topics",
          },
        };
      case "taxonomy-merged": {
        const [a, b] = DEGRADATION_TARGETS[dataset.id]!.merge;
        const merged = { key: `${a}_${b}`, name: "Battery and charging", definition: "How long the battery lasts on a ride and how it is charged or removed." };
        const topics = [merged, ...dataset.taxonomy.filter((t) => t.key !== a && t.key !== b).map(({ key, name, definition }) => ({ key, name, definition }))];
        const keyOverride = new Map(dataset.comments.filter((c) => c.topic?.disposition === "primary_topic" && (c.topic.topicKey === a || c.topic.topicKey === b)).map((c) => [c.id, merged.key]));
        return {
          group: "taxonomy_quality",
          description: `Valid taxonomy that merges the gold topics ${a} and ${b} into one topic.`,
          taxonomySteps: [{ kind: "fixed", topics }],
          assignmentSteps: [ORACLE_ASSIGN],
          keyOverride,
          expected: { status: "available", attempts: 1, generatorCalls: 1, assignerCalls: 1, failedAttemptCodes: [], perfect: false, outcome: `accepted; one merge error, ${b} unmatched (recall below 1), ${b} comments mis-assigned` },
        };
      }
      case "taxonomy-split": {
        const { split, splitFirst } = DEGRADATION_TARGETS[dataset.id]!;
        const parts = [
          { key: `${split}_hills`, name: "Hill climbing power", definition: "How strongly the bike pulls on climbs and under heavy loads." },
          { key: `${split}_levels`, name: "Assist level settings", definition: "The assist modes, how they are chosen and how each one behaves." },
        ];
        const topics = [...dataset.taxonomy.filter((t) => t.key !== split).map(({ key, name, definition }) => ({ key, name, definition })), ...parts];
        const members = dataset.comments.filter((c) => c.topic?.disposition === "primary_topic" && c.topic.topicKey === split).map((c) => c.id);
        const keyOverride = new Map(members.map((cid, i) => [cid, i < splitFirst ? parts[0]!.key : parts[1]!.key]));
        return {
          group: "taxonomy_quality",
          description: `Valid taxonomy that splits the gold topic ${split} into two topics (${splitFirst} / ${members.length - splitFirst} comments).`,
          taxonomySteps: [{ kind: "fixed", topics }],
          assignmentSteps: [ORACLE_ASSIGN],
          keyOverride,
          expected: { status: "available", attempts: 1, generatorCalls: 1, assignerCalls: 1, failedAttemptCodes: [], perfect: false, outcome: "accepted; one split error, the smaller part is unmatched and falls below the minimum topic size into OTHER" },
        };
      }
    }
  })();
  return { id, ...spec };
}
