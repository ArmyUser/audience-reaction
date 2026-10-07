import { describe, expect, it } from "vitest";
import { ContractTopicTaxonomyGenerator } from "../../src/application/contract-topic-phases";
import { ConsolidatingTopicTaxonomyGenerator, TaxonomyConsolidationUnavailableError, TopicBaseObserver } from "../../src/application/topic-consolidation";
import { goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { ConsolidatingTaxonomyGenerator, ConsolidationUnavailableError } from "../../src/benchmark/topic-real-consolidated";
import { DEFAULT_TOPIC_PARAMETERS } from "../../src/core/topics/aggregate-topics";
import { TOPIC_CONSOLIDATION_CONTRACT } from "../../src/core/topics/consolidation-contract";
import type { TopicModelTransport, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../../src/core/ports";
import { TOPIC_DISCOVERY_CONTRACT, TopicProviderError, type TopicModelRequest } from "../../src/core/topics/provider-contracts";
import { TopicDiscoveryOutputError } from "../../src/core/topics/validation";

// The app's consolidation stage must decide exactly as the benchmark's validated real-consolidated suite does. Both
// generators get the same scripted model answers (offline; no provider is called) and must send identical requests
// and produce identical results or failures. t1 is used through comment IDs only; topic names are synthetic.

const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const ids = gold.baseIds.slice(0, 40);
const textOf = new Map(dataset.comments.map((c) => [c.id, c.text]));
const request: TopicTaxonomyRequest = {
  sample: ids.map((id) => ({ id, text: textOf.get(id)! })),
  context: { sentimentLabels: ["positive", "neutral", "negative"], maxTopics: 12 },
};
const evidence = { topicBase: 188, minTopicSize: 10 };

type Proposal = { key: string; name: string; definition: string; exampleCommentIds?: string[] };
const json = (topics: Proposal[]) => JSON.stringify({ topics });
const candidate = json([
  { key: "speed", name: "Riding speed", definition: "Comments about how fast it rides.", exampleCommentIds: ids.slice(0, 3) },
  { key: "speed_hills", name: "Speed on hills", definition: "Speed when climbing.", exampleCommentIds: ids.slice(3, 5) },
  { key: "folding", name: "Folding mechanism", definition: "How it folds.", exampleCommentIds: ids.slice(5, 8) },
  { key: "side", name: "Side matters", definition: "Assorted side remarks.", exampleCommentIds: ids.slice(8, 10) },
]);
const consolidated = json([
  { key: "speed", name: "Riding speed", definition: "Speed on flat roads and hills.", exampleCommentIds: ids.slice(0, 5) },
  { key: "folding", name: "Folding mechanism", definition: "How it folds.", exampleCommentIds: ids.slice(5, 8) },
]);
const withUnknownExample = json([{ key: "speed", name: "Riding speed", definition: "Speed.", exampleCommentIds: ["not-a-candidate-example"] }]);
const invalidName = json([{ key: "speed", name: "a name that is far too long to be accepted here", definition: "Speed.", exampleCommentIds: ids.slice(0, 2) }]);

type Answer = string | TopicProviderError;

/** Answers discovery and consolidation requests from separate scripts and records every request. */
function scriptedTransport(discovery: Answer[], consolidation: Answer[]) {
  const requests: TopicModelRequest[] = [];
  const transport: TopicModelTransport = {
    label: "Scripted model",
    async complete(r) {
      requests.push(structuredClone(r));
      const script = r.contract === TOPIC_DISCOVERY_CONTRACT ? discovery : consolidation;
      const answer = script.shift();
      if (answer === undefined) throw new Error(`unexpected ${r.contract} request`);
      if (answer instanceof TopicProviderError) throw answer;
      return answer;
    },
  };
  return { transport, requests };
}

type Outcome = { value: unknown } | { error: string; detail?: unknown };

async function outcomeOf(generator: TopicTaxonomyGenerator): Promise<Outcome> {
  try {
    return { value: await generator.proposeTaxonomy(request) };
  } catch (error) {
    if (error instanceof ConsolidationUnavailableError || error instanceof TaxonomyConsolidationUnavailableError) return { error: "consolidation_unavailable" };
    if (error instanceof TopicDiscoveryOutputError) return { error: "invalid_discovery", detail: error.issues };
    if (error instanceof TopicProviderError) return { error: "provider", detail: [error.provider, error.failure] };
    throw error;
  }
}

/** Runs the benchmark and the app generator on the same scripts, `calls` times each. */
async function both(discovery: Answer[], consolidation: Answer[], calls = 1) {
  const b = scriptedTransport([...discovery], [...consolidation]);
  const a = scriptedTransport([...discovery], [...consolidation]);
  const benchmark = new ConsolidatingTaxonomyGenerator(new ContractTopicTaxonomyGenerator(b.transport), b.transport, evidence);
  const app = new ConsolidatingTopicTaxonomyGenerator(new ContractTopicTaxonomyGenerator(a.transport), a.transport, () => evidence);
  const results = { benchmark: [] as Outcome[], app: [] as Outcome[] };
  for (let i = 0; i < calls; i++) {
    results.benchmark.push(await outcomeOf(benchmark));
    results.app.push(await outcomeOf(app));
  }
  return { results, benchmarkRequests: b.requests, appRequests: a.requests };
}

const configurationError = () => new TopicProviderError("anthropic", "configuration");
const transientError = () => new TopicProviderError("anthropic", "unavailable");

describe("app consolidation matches the benchmark's validated real-consolidated stage", () => {
  it.each([
    ["valid discovery, valid consolidation", [candidate], [consolidated], 1],
    ["consolidation invalid once, valid on the retry with feedback", [candidate], [withUnknownExample, consolidated], 1],
    ["consolidation invalid twice: unavailable, and the next call makes no request", [candidate], [invalidName, withUnknownExample], 2],
    ["consolidation provider error, then valid", [candidate], [transientError(), consolidated], 1],
    ["consolidation configuration failure", [candidate], [configurationError(), configurationError()], 1],
    ["invalid discovery is rejected before consolidation", [invalidName], [], 1],
    ["empty discovery is passed on without consolidation", [json([])], [], 1],
  ] as const)("%s", async (_name, discovery, consolidation, calls) => {
    const { results, benchmarkRequests, appRequests } = await both([...discovery], [...consolidation], calls);
    expect(results.app).toEqual(results.benchmark);
    expect(appRequests).toEqual(benchmarkRequests);
  });

  it("the valid case returns the consolidated taxonomy in the discovery output format", async () => {
    const { results, appRequests } = await both([candidate], [consolidated]);
    expect(results.app[0]).toEqual({ value: JSON.parse(consolidated) });
    expect(appRequests.map((r) => r.contract)).toEqual([TOPIC_DISCOVERY_CONTRACT, TOPIC_CONSOLIDATION_CONTRACT]);
    expect(appRequests[1]!.data).toContain('"min_topic_size":10,"topic_base":188');
  });

  it("states the consolidation contract in its label", () => {
    const { transport } = scriptedTransport([], []);
    expect(new ConsolidatingTopicTaxonomyGenerator(new ContractTopicTaxonomyGenerator(transport), transport, () => evidence).label).toBe(
      "Scripted model (topic-discovery-v2) → consolidation (topic-consolidation-v3)",
    );
  });
});

describe("TopicBaseObserver", () => {
  it("reports the base analyzeTopics sent and the report's minimum topic size", async () => {
    const inner = { label: "inner", discoverTopics: async () => ({ topics: [], assignments: [] }), finishRun: () => ({}) };
    const observer = new TopicBaseObserver(inner, DEFAULT_TOPIC_PARAMETERS);
    expect(() => observer.evidence()).toThrow("not observed");
    await observer.discoverTopics({ comments: ids.map((id) => ({ id, text: "x" })), context: request.context });
    expect(observer.evidence()).toEqual({ topicBase: 40, minTopicSize: 10 });
    await observer.discoverTopics({ comments: gold.baseIds.map((id) => ({ id, text: "x" })), context: request.context });
    expect(observer.evidence()).toEqual({ topicBase: gold.baseIds.length, minTopicSize: 10 });
    expect(observer.finishRun("run-1")).toEqual({});
    expect(observer.label).toBe("inner");
  });
});
