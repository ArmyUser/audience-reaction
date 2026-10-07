import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createAnthropicClient } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { consolidationProvenance } from "../../src/benchmark/topic-consolidated-diagnostics";
import { comparableSettings, evaluateConsolidationExperiment, renderConsolidationExperimentMarkdown, V4_EXPERIMENT } from "../../src/benchmark/topic-consolidation-experiment";
import { parseTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { ContractTaxonomyConsolidator } from "../../src/benchmark/topic-discovery-consolidated";
import { buildRealConsolidatedPlan, realConsolidatedResultFileName, runRealConsolidatedBenchmark, type RealConsolidatedResult } from "../../src/benchmark/topic-real-consolidated";
import { loadPrices, loadTopicProviderConfig } from "../../src/benchmark/topic-real";
import type { TopicModelRequest } from "../../src/core/topics/provider-contracts";
import {
  buildTopicConsolidationInstructions,
  buildTopicConsolidationRequest,
  isTopicConsolidationContract,
  TOPIC_CONSOLIDATION_CONTRACT,
  TOPIC_CONSOLIDATION_CONTRACT_V4,
  type TopicConsolidationRequest,
} from "../../src/core/topics/consolidation-contract";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";

// EXPERIMENT topic-consolidation-v4 (docs/topic-consolidation-v4-experiment.md), offline and on synthetic data only
// (a fictional desk-lamp review written for this test). What offline tests CAN show: the v4 prompt states each part
// of the new criterion and differs from the frozen v3 prompt by exactly that insertion; v3 is byte-for-byte unchanged;
// both experiment arms send identical discovery and assignment requests; when a model applies the rule, the outcome
// (drop / retain / merge) is recorded correctly; the pre-registered evaluator behaves as specified. Whether the model
// actually follows the rule is what the live experiment measures.

const ROOT = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- the contract ----------

/** SHA-256 of the frozen v3 instructions, recorded before v4 existed. */
const V3_FINGERPRINTS: Record<string, string> = {
  "3:false": "55b41ddb31647f59c2dd968ab6ed5d96484a1c8f4a6e9ec185d749fa6a864056",
  "3:true": "e74b1d158a6ed45a3e1cef17d2905e60971ff3e3769578b1e2661e3c8e8f9f93",
  "8:false": "e8cca57e97fc3b4bfae7e764be1e20abe2ecdc990ff8f368c37759ad31e3c8ca",
  "8:true": "5bb1126a9447924fc9550cd23f8f02aeec3b380722a2bc964cdcd2090d5552b0",
  "12:false": "cc6956d20176f69e35e72ff5580b620bccf728510c548b69ee98a1e3eb7f19ea",
  "12:true": "50e5cf59939489f26a427c2775aefea1a14ddabb1fc0005d847d20a448c1c14e",
};
const v3 = (maxTopics = 12, retry = false) => buildTopicConsolidationInstructions({ maxTopics, retry });
const v4 = (maxTopics = 12, retry = false) => buildTopicConsolidationInstructions({ maxTopics, retry, contract: TOPIC_CONSOLIDATION_CONTRACT_V4 });

describe("topic-consolidation-v4 contract: v3 plus exactly one criterion", () => {
  it("v3 stays the default and byte-for-byte frozen", () => {
    expect(TOPIC_CONSOLIDATION_CONTRACT).toBe("topic-consolidation-v3");
    for (const [k, h] of Object.entries(V3_FINGERPRINTS)) {
      const [m, retry] = k.split(":");
      expect(sha(v3(Number(m), retry === "true")), k).toBe(h);
      expect(sha(buildTopicConsolidationInstructions({ maxTopics: Number(m), retry: retry === "true", contract: TOPIC_CONSOLIDATION_CONTRACT })), k).toBe(h);
    }
  });

  it("v4 is v3 with only the contract name and one inserted block after the DROP rule", () => {
    for (const [m, retry] of [[12, false], [8, true]] as const) {
      const a = v3(m, retry).split("\n");
      const b = v4(m, retry).replace(TOPIC_CONSOLIDATION_CONTRACT_V4, TOPIC_CONSOLIDATION_CONTRACT).split("\n");
      const drop = a.findIndex((l) => l.startsWith("- DROP:"));
      const inserted = b.length - a.length;
      expect(inserted).toBe(4);
      expect([...b.slice(0, drop + 1), ...b.slice(drop + 1 + inserted)]).toEqual(a);
      expect(b[drop + 1]).toMatch(/^- DROP also/);
    }
    expect(v4()).toContain("(contract topic-consolidation-v4)");
    expect(isTopicConsolidationContract("topic-consolidation-v4")).toBe(true);
    expect(isTopicConsolidationContract("topic-consolidation-v5")).toBe(false);
  });

  it("states the criterion generically: one coherent subject; form or addressee groupings and unrelated bundles are dropped", () => {
    const rule = v4().split("\n").filter((l, i, all) => i > all.findIndex((x) => x.startsWith("- DROP:")) && i <= all.findIndex((x) => x.startsWith("- DROP:")) + 4).join("\n");
    expect(rule).toMatch(/does not represent one coherent subject or concern/);
    expect(rule).toMatch(/\(a\) a grouping of comments by their form or addressee rather than by what they are about/);
    expect(rule).toMatch(/requests, questions, suggestions, praise, reactions or feedback addressed to the creator or about the video or channel itself/);
    expect(rule).toMatch(/\(b\) a bundle of unrelated side subjects/);
    expect(rule).toMatch(/different aspects of one shared concern is coherent/);
    // Generic only: no product, domain or benchmark vocabulary.
    expect(rule).not.toMatch(/battery|price|shipping|crowdfund|camera|bike|game|lesson|tutor|t[1-4]-topics/i);
  });

  it("leaves MERGE, RETAIN, the evidence standard, the output format and retry wording exactly as in v3", () => {
    const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));
    for (const [from, to] of [["- RETAIN:", "- DROP:"], ["- MERGE:", "- DROP:"], ["EVIDENCE STANDARD:", "FIELDS of each"], ["OUTPUT:", "RETRY:"]] as const) {
      expect(section(v4(12, true), from, to)).toBe(section(v3(12, true), from, to));
    }
    expect(v4(12, true).slice(v4(12, true).indexOf("RETRY:"))).toBe(v3(12, true).slice(v3(12, true).indexOf("RETRY:")));
  });

  it("requests carry the chosen contract; the data message and output schema are identical", () => {
    const candidate = validated(CANDIDATES);
    const request: TopicConsolidationRequest = { candidate, sample: SAMPLE, context: { maxTopics: 12, topicBase: 24, minTopicSize: 10 } };
    const a = buildTopicConsolidationRequest(request);
    const b = buildTopicConsolidationRequest(request, TOPIC_CONSOLIDATION_CONTRACT_V4);
    expect(a.contract).toBe("topic-consolidation-v3");
    expect(b.contract).toBe("topic-consolidation-v4");
    expect(b.data).toBe(a.data);
    expect(b.outputSchema).toEqual(a.outputSchema);
    expect(b.phase).toBe(a.phase);
  });
});

// ---------- the criterion applied (scripted model output) ----------

const SAMPLE = Array.from({ length: 24 }, (_, i) => ({ id: `d-${String(i + 1).padStart(2, "0")}`, text: `synthetic lamp comment ${i + 1}` }));
const CANDIDATES = [
  { key: "brightness_levels", name: "Brightness levels", definition: "How bright the lamp gets.", exampleCommentIds: ["d-01", "d-02"] },
  { key: "colour_warmth", name: "Colour warmth", definition: "How warm or cool the light looks.", exampleCommentIds: ["d-03", "d-04"] },
  { key: "arm_joint", name: "Arm joint", definition: "How the arm joint holds its position.", exampleCommentIds: ["d-05", "d-06"] },
  { key: "viewer_asks", name: "Viewer requests", definition: "Requests for future videos and questions to the host.", exampleCommentIds: ["d-07", "d-08"] },
  { key: "host_questions", name: "Questions for the host", definition: "Questions about the host's own desk and camera.", exampleCommentIds: ["d-09", "d-10"] },
  { key: "odds_and_ends", name: "Packaging, cord and paperwork", definition: "Packaging, cord length and the paperwork.", exampleCommentIds: ["d-11", "d-12"] },
];
const validated = (topics: typeof CANDIDATES) => {
  const r = validateTopicTaxonomy({ topics }, { sampleCommentIds: SAMPLE.map((c) => c.id), maxTopics: 12 });
  if (r.status !== "valid") throw new Error("must validate");
  return r.taxonomy;
};
/** A scripted model applying v3 MERGE (two aspects of light quality) and the v4 rule (three non-subject candidates). */
const V4_APPLIED = [
  { key: "light_quality", name: "Light quality", definition: "Brightness and colour warmth of the light.", exampleCommentIds: ["d-01", "d-03"] },
  { key: "arm_joint", name: "Arm joint", definition: "How the arm joint holds its position.", exampleCommentIds: ["d-05"] },
];
const fateOf = (finals: typeof V4_APPLIED) => Object.fromEntries(consolidationProvenance(CANDIDATES, finals).candidates.map((m) => [m.candidateKey, m.fate]));

describe("the criterion applied: what each case looks like when the model follows v4", () => {
  const rule = v4();
  it("comment-form / meta-topic candidate (viewer requests) → DROP", () => {
    expect(rule).toMatch(/grouping of comments by their form/);
    expect(fateOf(V4_APPLIED).viewer_asks).toBe("dropped");
  });
  it("addressee candidate (questions to the host) → DROP", () => {
    expect(rule).toMatch(/addressed to the creator/);
    expect(fateOf(V4_APPLIED).host_questions).toBe("dropped");
  });
  it("unrelated side-subject bundle → DROP", () => {
    expect(rule).toMatch(/bundle of unrelated side subjects that are merely mentioned in the same comments or listed together/);
    expect(fateOf(V4_APPLIED).odds_and_ends).toBe("dropped");
  });
  it("coherent multi-aspect subject → RETAIN (as one topic; its aspect candidates are merged exactly as in v3)", () => {
    expect(rule).toMatch(/different aspects of one shared concern is coherent: judge it by the other rules/);
    expect(fateOf(V4_APPLIED)).toMatchObject({ brightness_levels: "merged", colour_warmth: "merged" });
    expect(consolidationProvenance(CANDIDATES, V4_APPLIED).finalTopics[0]).toMatchObject({ finalKey: "light_quality", material: "merged", sourceCandidateKeys: ["brightness_levels", "colour_warmth"] });
  });
  it("valid narrow substantive recurring topic → RETAIN", () => {
    expect(rule).toContain("- RETAIN: keep it as a separate topic only when the comment evidence shows a substantial recurring audience theme");
    expect(fateOf(V4_APPLIED).arm_joint).toBe("retained");
  });
  it("existing v3 merge behaviour is unchanged: the MERGE rule is the v3 rule and v3 never states the new criterion", () => {
    const merge = (text: string) => text.split("\n").find((l) => l.startsWith("- MERGE:"));
    expect(merge(v4())).toBe(merge(v3()));
    expect(v3()).not.toMatch(/coherent subject or concern|form or addressee|unrelated side subjects/);
  });

  it("the consolidator sends the contract it was built with; v3 by default", async () => {
    const sent: TopicModelRequest[] = [];
    const transport = { label: "fake", complete: async (r: TopicModelRequest) => (sent.push(r), JSON.stringify({ topics: V4_APPLIED })) };
    const request: TopicConsolidationRequest = { candidate: validated(CANDIDATES), sample: SAMPLE, context: { maxTopics: 12, topicBase: 24, minTopicSize: 10 } };
    await new ContractTaxonomyConsolidator(transport).consolidate(request);
    await new ContractTaxonomyConsolidator(transport, TOPIC_CONSOLIDATION_CONTRACT_V4).consolidate(request);
    expect(sent.map((r) => r.contract)).toEqual(["topic-consolidation-v3", "topic-consolidation-v4"]);
    expect(sent[1]!.instructions).toBe(v4(6));
  });
});

// ---------- the two arms through the real-consolidated path ----------

type Disposition = { disposition: "primary_topic"; topicKey: string; topicSentiment: "positive" | "negative" } | { disposition: "other" } | { disposition: "no_specific_topic" } | null;
const lampRow = (id: string, text: string, topic: Disposition) => ({
  id,
  text,
  tags: ["synthetic"],
  classification: { type: topic === null ? "spam_irrelevant" : "opinion", isQuestion: false, isRequest: false, sentiment: topic && "topicSentiment" in topic ? topic.topicSentiment : "neutral", targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" } },
  focusMention: "none",
  topic,
});
const LIGHT = [
  "The top setting floods my whole desk.", "Too dim for reading small print.", "Warm mode is easy on the eyes at night.", "The cool white looks clinical.",
  "Dimming steps are smooth, no flicker.", "Glare bounces off my monitor.", "Even light with no hot spot.", "Colour looks greenish on camera.",
  "Perfect for sketching late.", "Brightness drops after an hour.", "Light spreads wide enough for two notebooks.", "Blue tint gives me a headache.",
];
const LAMP = parseTopicBenchmarkDataset(
  JSON.stringify({
    datasetId: "synthetic-lamp-v1",
    description: "Synthetic desk-lamp review comments written for this test only.",
    schema: { mixedEnabled: false, focusConfigured: true },
    focus: { name: "Arcwell Desk", aliases: [], isVideoSponsor: false },
    taxonomy: [
      { key: "light", name: "Light quality", definition: "Brightness and colour of the light.", acceptedNames: ["light"] },
      { key: "joint", name: "Arm joint", definition: "How the arm holds its position.", acceptedNames: ["arm"] },
    ],
    comments: [
      ...LIGHT.map((t, i) => lampRow(`d-${String(i + 1).padStart(2, "0")}`, t, { disposition: "primary_topic", topicKey: "light", topicSentiment: i % 2 ? "negative" : "positive" })),
      lampRow("d-13", "Arm sags when I angle it down.", { disposition: "primary_topic", topicKey: "joint", topicSentiment: "negative" }),
      lampRow("d-14", "Joint stays exactly where I leave it.", { disposition: "primary_topic", topicKey: "joint", topicSentiment: "positive" }),
      lampRow("d-15", "Can you review a monitor bar next?", { disposition: "other" }),
      lampRow("d-16", "What desk mat is that in the intro?", { disposition: "other" }),
      lampRow("d-17", "The cord barely reaches my socket.", { disposition: "other" }),
      lampRow("d-18", "Warranty leaflet never arrived.", { disposition: "other" }),
      lampRow("d-19", "Nice one, thanks.", { disposition: "no_specific_topic" }),
      lampRow("d-20", "Watching with tea.", { disposition: "no_specific_topic" }),
      lampRow("d-21", "Visit my shop for phone straps", null),
    ],
  }),
  "synthetic-lamp-v1",
);
const LAMP_CANDIDATES = [
  { key: "brightness_levels", name: "Brightness levels", definition: "How bright the lamp gets.", exampleCommentIds: ["d-01", "d-02"] },
  { key: "colour_warmth", name: "Colour warmth", definition: "How warm or cool the light looks.", exampleCommentIds: ["d-03", "d-04"] },
  { key: "viewer_asks", name: "Viewer requests", definition: "Requests and questions for the host.", exampleCommentIds: ["d-15", "d-16"] },
];
const LAMP_FINAL = [{ key: "light_quality", name: "Light quality", definition: "Brightness and colour warmth.", exampleCommentIds: ["d-01", "d-03"] }];

const config = loadTopicProviderConfig();
const prices = loadPrices();
const keys = { discoveryApiKey: "fake-anthropic-key-do-not-use-44", jevApiKey: "fake-jev-key-do-not-use-44" };
let trapped = 0;
beforeEach(() => {
  trapped = 0;
  vi.stubGlobal("fetch", async () => {
    trapped += 1;
    throw new Error("network access is not allowed in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

async function runArm(contract?: typeof TOPIC_CONSOLIDATION_CONTRACT_V4) {
  const anthropic: Record<string, unknown>[] = [];
  const jev: unknown[] = [];
  const anthropicClient = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          anthropic.push(structuredClone(params));
          const isConsolidation = /contract topic-consolidation-v\d/.test(String(params.system));
          return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify({ topics: isConsolidation ? LAMP_FINAL : LAMP_CANDIDATES }) }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 100, output_tokens: 50 } };
        },
      },
    },
  } as unknown as ReturnType<typeof createAnthropicClient>;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { state: { comment: string }; questions: Record<string, unknown> };
    jev.push(body);
    const c = LAMP.comments.find((x) => x.text === body.state.comment)!;
    const g = c.topic;
    const choice = g?.disposition === "primary_topic" ? (g.topicKey === "light" ? "topic:light_quality" : "other") : g!.disposition;
    const answers = "topic" in body.questions ? { topic: { type: "choice", choice } } : { topic_sentiment: { type: "choice", choice: g?.disposition === "primary_topic" ? g.topicSentiment : "neutral" } };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await runRealConsolidatedBenchmark(LAMP, config, prices, keys, 1, { anthropicClient, fetch: fetchImpl, ...(contract ? { consolidationContract: contract } : {}) });
  return { result, anthropic, jev };
}

describe("experiment arms: only the consolidation contract differs", () => {
  it("both arms send identical discovery and Jev requests; consolidation differs only in its instructions", async () => {
    const a = await runArm();
    const b = await runArm(TOPIC_CONSOLIDATION_CONTRACT_V4);
    expect(trapped).toBe(0);
    const isConsolidation = (p: Record<string, unknown>) => /contract topic-consolidation-v\d/.test(String(p.system));
    expect(b.anthropic.filter((p) => !isConsolidation(p))).toEqual(a.anthropic.filter((p) => !isConsolidation(p)));
    const [ca] = a.anthropic.filter(isConsolidation);
    const [cb] = b.anthropic.filter(isConsolidation);
    expect(String(ca!.system)).toContain("topic-consolidation-v3");
    expect(String(cb!.system)).toContain("topic-consolidation-v4");
    expect({ ...cb, system: undefined }).toEqual({ ...ca, system: undefined });
    expect(b.jev).toEqual(a.jev);

    expect(a.result.meta.consolidation.contract).toBe("topic-consolidation-v3");
    expect(b.result.meta.consolidation.contract).toBe("topic-consolidation-v4");
    expect(comparableSettings(b.result)).toEqual(comparableSettings(a.result));
    expect(b.result.instrumentation!.repeats[0]!.taxonomyCalls[0]!.consolidationAttempts[0]!.contract).toBe("topic-consolidation-v4");
    expect(b.result.totals.consolidation.requests).toBe(1);
    expect(b.result.report.scenarios[1]!.runs[0]!.taxonomy).toEqual(a.result.report.scenarios[1]!.runs[0]!.taxonomy);
  });

  it("result files of the two arms never collide; the v3 name is unchanged", async () => {
    const a = await runArm();
    const b = await runArm(TOPIC_CONSOLIDATION_CONTRACT_V4);
    const at = (r: RealConsolidatedResult) => realConsolidatedResultFileName({ ...r, meta: { ...r.meta, timestamp: "2030-01-01T00:00:00.000Z" } });
    expect(at(a.result)).toBe("2030-01-01T00-00-00-000Z-topics-synthetic-lamp-v1-real-consolidated-anthropic-claude-sonnet-5-5-typesafe-jev-latest.json");
    expect(at(b.result)).toBe("2030-01-01T00-00-00-000Z-topics-synthetic-lamp-v1-real-consolidated-anthropic-claude-sonnet-5-5-typesafe-jev-latest-topic-consolidation-v4.json");
  });

  it("the plan prices the v4 prompt; v3 stays the default", () => {
    const p3 = buildRealConsolidatedPlan(LAMP, config, prices, {}, 1);
    const p4 = buildRealConsolidatedPlan(LAMP, config, prices, {}, 1, TOPIC_CONSOLIDATION_CONTRACT_V4);
    expect(p3.consolidation.contract).toBe("topic-consolidation-v3");
    expect(p4.consolidation.contract).toBe("topic-consolidation-v4");
    expect(p4.consolidation.estimatedInputTokens).toBeGreaterThan(p3.consolidation.estimatedInputTokens);
    expect(p4.real).toEqual(p3.real);
  });
});

// ---------- the pre-registered evaluator ----------

/** A minimal saved result for the evaluator (only the fields it reads). */
function fake(contract: string, timestamp: string, m: { precision: number; recall: number; merges?: number; sentiment?: number; primary?: number; available?: boolean }, version = "sha256:v"): { file: string; result: RealConsolidatedResult } {
  const available = m.available ?? true;
  const run = {
    repeat: 1,
    status: available ? "available" : "unavailable",
    taxonomy: available ? { topicPrecision: m.precision, conceptRecall: m.recall, mergeErrors: m.merges ?? 0, splitErrors: 0 } : null,
    assignment: available ? { dispositionAccuracy: 0.9, primaryTopicAccuracy: m.primary ?? 0.9, otherAccuracy: 0.5, noSpecificTopicAccuracy: 0.9, topicSentimentAccuracy: m.sentiment ?? 0.95 } : null,
    report: available ? { evidencePrecision: 0.9 } : null,
  };
  const usage = { requests: 1, failedRequests: 0, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01, latencyMs: { total: 1000, mean: 1000, p50: 1000, p95: 1000, max: 1000 } };
  const result = {
    meta: {
      kind: "real-consolidated",
      timestamp,
      dataset: "t4-topics-v1",
      datasetVersion: version,
      discovery: { provider: "anthropic", modelRequested: "m", contract: "d", effort: "high" },
      assignment: { provider: "typesafe", modelRequested: "j", contract: "a", questionSet: "q", maxCommentsPerBatch: 25 },
      consolidation: { contract, topicBase: 189, minTopicSize: 10 },
    },
    report: { meta: { sampleSeed: "s", parameters: { maxTopics: 12 }, matching: "x" }, scenarios: [{ id: "oracle", runs: [] }, { id: "live", runs: [run] }] },
    phases: [{ repeat: 1, taxonomyCalls: [{ call: 1, discovery: { topics: 12 }, consolidation: { status: "valid", topics: 9, decisions: { retained: [1, 2], merged: [3], dropped: [4] } } }] }],
    usage: [{ repeat: 1, discovery: usage, consolidation: usage, assignment: usage }],
  } as unknown as RealConsolidatedResult;
  return { file: `${timestamp}-${contract}.json`, result };
}
const arm = (contract: string, values: Parameters<typeof fake>[2][], day = 1) => values.map((v, i) => fake(contract, `2030-01-0${day}T0${i}:00:00.000Z`, v));
const V3 = "topic-consolidation-v3";
const V4 = "topic-consolidation-v4";
const good = { precision: 0.9, recall: 0.95 };

describe("pre-registered evaluator (fixed before any live v4 result)", () => {
  it("records the fixed criteria", () => {
    expect(V4_EXPERIMENT).toMatchObject({ dataset: "t4-topics-v1", baseline: V3, candidate: V4, repeatsPerArm: 3, unavailableRunScore: 0 });
    expect(V4_EXPERIMENT.criteria).toEqual({ minTopicPrecision: 0.88, minConceptRecall: 0.92, maxNewMergeErrors: 0, noRegression: ["topicSentimentAccuracy", "primaryTopicAccuracy"] });
  });

  it("PASS only when every criterion holds", () => {
    const e = evaluateConsolidationExperiment("t4-topics-v1", "sha256:v", [...arm(V3, [{ precision: 0.75, recall: 0.95 }, { precision: 0.7, recall: 0.95 }, { precision: 0.8, recall: 0.95 }]), ...arm(V4, [good, good, good])]);
    expect(e.verdict).toBe("PASS");
    expect(e.preRegistered).toBe(true);
    expect(e.criteria.map((c) => c.passed)).toEqual([true, true, true, true, true]);
  });

  it("FAIL on each criterion: precision, recall, new merge errors, sentiment or primary regression", () => {
    const base = arm(V3, [good, good, good]);
    const failing = (v: Parameters<typeof fake>[2]) => evaluateConsolidationExperiment("t4-topics-v1", "sha256:v", [...base, ...arm(V4, [good, good, v])]);
    expect(failing({ precision: 0.8, recall: 0.95 }).criteria[0]!.passed).toBe(false);
    expect(failing({ precision: 0.9, recall: 0.8 }).criteria[1]!.passed).toBe(false);
    expect(failing({ ...good, merges: 1 }).criteria[2]!.passed).toBe(false);
    expect(failing({ ...good, sentiment: 0.94 }).criteria[3]!.passed).toBe(false);
    expect(failing({ ...good, primary: 0.89 }).criteria[4]!.passed).toBe(false);
    for (const v of [{ precision: 0.8, recall: 0.95 }, { ...good, merges: 1 }, { ...good, primary: 0.89 }]) expect(failing(v).verdict).toBe("FAIL");
  });

  it("uses the FIRST three runs of each arm, never the best; unavailable runs score 0", () => {
    const v4Runs = [...arm(V4, [{ precision: 0.5, recall: 0.95 }, good, good]), ...arm(V4, [good, good, good], 2)];
    const e = evaluateConsolidationExperiment("t4-topics-v1", "sha256:v", [...arm(V3, [good, good, good]), ...v4Runs]);
    expect(e.arms[1]!.runs.map((r) => r.timestamp)).toEqual(["2030-01-01T00:00:00.000Z", "2030-01-01T01:00:00.000Z", "2030-01-01T02:00:00.000Z"]);
    expect(e.verdict).toBe("FAIL");
    const down = evaluateConsolidationExperiment("t4-topics-v1", "sha256:v", [...arm(V3, [good, good, good]), ...arm(V4, [good, good, { precision: 0, recall: 0, available: false }])]);
    expect(down.arms[1]!.runs[2]).toMatchObject({ available: false, topicPrecision: 0, conceptRecall: 0, topicSentimentAccuracy: 0 });
    expect(down.verdict).toBe("FAIL");
  });

  it("INCOMPLETE with fewer than three runs per arm; INVALID when the arms differ in more than consolidation; stale versions ignored", () => {
    expect(evaluateConsolidationExperiment("t4-topics-v1", "sha256:v", arm(V3, [good, good, good])).verdict).toBe("INCOMPLETE");
    const other = arm(V4, [good, good, good]);
    (other[2]!.result.meta.assignment as { modelRequested: string }).modelRequested = "different";
    expect(evaluateConsolidationExperiment("t4-topics-v1", "sha256:v", [...arm(V3, [good, good, good]), ...other]).verdict).toBe("INVALID");
    const stale = evaluateConsolidationExperiment("t4-topics-v1", "sha256:new", [...arm(V3, [good, good, good]), ...arm(V4, [good, good, good])]);
    expect(stale.verdict).toBe("INCOMPLETE");
    expect(stale.reasons.join(" ")).toMatch(/another version of t4-topics-v1 ignored/);
  });

  it("any other dataset is exploratory, never binding", () => {
    const e = evaluateConsolidationExperiment("t3-topics-v1", "sha256:v", []);
    expect(e.preRegistered).toBe(false);
    expect(renderConsolidationExperimentMarkdown(e)).toContain("EXPLORATORY");
  });
});

// ---------- CLI (no live call) ----------

describe("CLI wiring (no API call, no result file)", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const RESULTS = join(ROOT, "benchmark-results");
  const run = (script: string, args: string[]) => {
    const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
    const out = spawnSync(TSX, [script, ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []).toEqual(before);
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("real-consolidated --consolidation v4 prints the v4 plan and refuses to start without --live", () => {
    const { status, text } = run("src/benchmark/topics-cli.ts", ["--suite", "real-consolidated", "--dataset", "t4-topics-v1", "--provider", "anthropic", "--model", "claude-sonnet-5-5", "--consolidation", "v4", "--repeats", "1"]);
    expect(status).toBe(2);
    expect(text).toContain("topic-consolidation-v4");
    expect(text).toContain("--suite real-consolidated --dataset t4-topics-v1 --provider anthropic --model claude-sonnet-5-5 --consolidation v4 --live --repeats 1");
    expect(text).not.toContain("WILL BE MADE");
  }, 60_000);

  it("--consolidation is validated and only accepted by real-consolidated", () => {
    expect(run("src/benchmark/topics-cli.ts", ["--suite", "real-consolidated", "--dataset", "t4-topics-v1", "--consolidation", "v9"]).text).toMatch(/Unknown --consolidation "v9"/);
    expect(run("src/benchmark/topics-cli.ts", ["--suite", "real", "--dataset", "t4-topics-v1", "--consolidation", "v4"]).text).toMatch(/--consolidation is only valid with --suite real-consolidated/);
  }, 60_000);

  it("the experiment evaluator is offline and reports INCOMPLETE without saved runs", () => {
    const empty = mkdtempSync(join(tmpdir(), "consolidation-experiment-"));
    try {
      const { status, text } = run("src/benchmark/consolidation-experiment-cli.ts", ["--dataset", "t4-topics-v1", "--results", empty]);
      expect(status).toBe(2);
      expect(text).toContain("NO API CALLS MADE");
      expect(text).toContain("Verdict: INCOMPLETE");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);
});
