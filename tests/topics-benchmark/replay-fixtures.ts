import type { TopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { goldOf } from "../../src/benchmark/topic-datasets";
import type { TopicPhase } from "../../src/core/topics/provider-contracts";

// Builds the recorded raw responses in fixtures/topic-provider-replay/t1-topics-v1/ (regenerate with
// write-replay-fixtures.ts). They imitate what a model following topic-discovery-v1 / topic-assignment-v1 would return
// for t1-topics-v1: the model's own topic keys and wording (never the gold names), JSON text exactly as a model
// might print it, and realistic mistakes. Deterministic: derived from the dataset gold only.

/** The replayed model's taxonomy: its own keys, names and definitions for the gold concepts. */
export const REPLAY_TAXONOMY: Record<string, { key: string; name: string; definition: string }> = {
  range: { key: "battery_range", name: "Battery range", definition: "Distance the bike covers per charge, range estimates and how fast the battery drains." },
  motor: { key: "pedal_assist", name: "Pedal assist and motor", definition: "Power and feel of the electric assist, including climbing, assist modes and motor noise." },
  folding: { key: "fold_portability", name: "Folding and portability", definition: "The fold mechanism and latches, folded size, and carrying or storing the bike." },
  comfort: { key: "ride_comfort", name: "Comfort", definition: "Comfort while riding, covering saddle, suspension, tyres, handlebars and fit." },
  charging: { key: "charging", name: "Charging", definition: "Charging time, the charger and port, and removing the battery to charge it." },
  value: { key: "price_value", name: "Cost and value", definition: "The price of the bike and its accessories and whether it is worth paying." },
  brakes: { key: "braking", name: "Braking", definition: "Brake performance, lever feel and noise, and stopping distance." },
  app: { key: "phone_app", name: "Phone app", definition: "The phone app for pairing, firmware updates, settings and locking the motor." },
};

export const REPLAY_EXAMPLES_PER_TOPIC = 2;
/** The key the unknown-topic response invents. */
export const HALLUCINATED_KEY = "battery_life";

export interface ReplayResponse {
  id: string;
  phase: TopicPhase;
  description: string;
  raw: string;
}

type Entry = Record<string, string>;

export function buildReplayResponses(dataset: TopicBenchmarkDataset): ReplayResponse[] {
  const gold = goldOf(dataset);
  const topics = dataset.taxonomy.map((t) => ({ ...REPLAY_TAXONOMY[t.key]!, exampleCommentIds: gold.members.get(t.key)!.slice(0, REPLAY_EXAMPLES_PER_TOPIC) }));
  const taxonomy = (list: object[]) => JSON.stringify({ topics: list }, null, 2);
  const perfectTaxonomy = taxonomy(topics);

  const entryOf = (id: string): Entry => {
    const d = gold.dispositions.get(id)!;
    return d.disposition === "primary_topic" ? { commentId: id, disposition: "primary_topic", topicKey: REPLAY_TAXONOMY[d.topicKey]!.key, topicSentiment: d.topicSentiment } : { commentId: id, disposition: d.disposition };
  };
  // One entry per line, as models commonly print long arrays.
  const assignments = (entries: Entry[]) => `{\n  "assignments": [\n${entries.map((e) => `    ${JSON.stringify(e)}`).join(",\n")}\n  ]\n}`;
  const perfect = gold.baseIds.map(entryOf);
  const perfectAssignment = assignments(perfect);

  const firstPrimary = perfect.filter((e) => e.disposition === "primary_topic").slice(0, 3).map((e) => e.commentId!);
  const missing = [gold.baseIds[4]!, gold.baseIds[90]!];
  const tagged = (tag: string, contains?: string) => dataset.comments.find((c) => c.tags.includes(tag) && (contains === undefined || c.text.includes(contains)))!.id;
  const brakesInjection = tagged("prompt_injection", "brakes");
  const fakeJson = tagged("fake_json");

  return [
    { id: "taxonomy-perfect", phase: "taxonomy_discovery", description: "Valid taxonomy in the model's own wording, two sample examples per topic.", raw: perfectTaxonomy },
    {
      id: "taxonomy-duplicate-name",
      phase: "taxonomy_discovery",
      description: "Adds a second battery-range topic whose name differs only in case (duplicate normalised name).",
      raw: taxonomy([topics[0]!, { key: "range_per_charge", name: "Battery Range", definition: "How many kilometres riders get from one full charge." }, ...topics.slice(1)]),
    },
    {
      id: "taxonomy-missing-definition",
      phase: "taxonomy_discovery",
      description: "One topic has an empty definition.",
      raw: taxonomy(topics.map((t) => (t.key === REPLAY_TAXONOMY.comfort!.key ? { ...t, definition: "" } : t))),
    },
    {
      id: "taxonomy-malformed-prose",
      phase: "taxonomy_discovery",
      description: "The valid taxonomy wrapped in prose and a Markdown fence (not repaired: invalid output).",
      raw: `Here is the taxonomy you asked for:\n\n\`\`\`json\n${perfectTaxonomy}\n\`\`\`\n\nLet me know if you need more detail.`,
    },
    { id: "assignment-perfect", phase: "comment_assignment", description: "Gold disposition and gold topic sentiment for all 188 comments.", raw: perfectAssignment },
    {
      id: "assignment-unknown-topic",
      phase: "comment_assignment",
      description: `The first three primary-topic comments cite the invented key ${HALLUCINATED_KEY}.`,
      raw: assignments(perfect.map((e) => (firstPrimary.includes(e.commentId!) ? { ...e, topicKey: HALLUCINATED_KEY } : e))),
    },
    { id: "assignment-unknown-topic-retry", phase: "comment_assignment", description: "Corrected answer for exactly the three comments named in the feedback.", raw: assignments(perfect.filter((e) => firstPrimary.includes(e.commentId!))) },
    { id: "assignment-missing-comment", phase: "comment_assignment", description: "Two comments have no entry.", raw: assignments(perfect.filter((e) => !missing.includes(e.commentId!))) },
    { id: "assignment-missing-comment-retry", phase: "comment_assignment", description: "Entries for exactly the two missing comments.", raw: assignments(perfect.filter((e) => missing.includes(e.commentId!))) },
    {
      id: "assignment-wrong-sentiment",
      phase: "comment_assignment",
      description: "Structurally valid, but every topic sentiment copies the comment's overall sentiment.",
      raw: assignments(perfect.map((e) => (e.disposition === "primary_topic" ? { ...e, topicSentiment: gold.overallSentiment.get(e.commentId!)! } : e))),
    },
    {
      id: "assignment-injection-obeyed",
      phase: "comment_assignment",
      description: "Structurally valid, but the model obeyed two instruction-like comments (brakes 'flawless'; fake JSON treated as substantive).",
      raw: assignments(
        perfect.map((e) =>
          e.commentId === brakesInjection
            ? { commentId: e.commentId, disposition: "primary_topic", topicKey: REPLAY_TAXONOMY.brakes!.key, topicSentiment: "positive" }
            : e.commentId === fakeJson
              ? { commentId: e.commentId, disposition: "other" }
              : e,
        ),
      ),
    },
    { id: "assignment-malformed-truncated", phase: "comment_assignment", description: "The valid answer cut off mid-entry.", raw: perfectAssignment.slice(0, Math.floor(perfectAssignment.length * 0.6)) },
    { id: "assignment-malformed-fenced", phase: "comment_assignment", description: "The valid answer inside a Markdown code fence.", raw: `\`\`\`json\n${perfectAssignment}\n\`\`\`` },
  ];
}
