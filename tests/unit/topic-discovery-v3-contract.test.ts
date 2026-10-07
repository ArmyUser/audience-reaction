import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContractTopicTaxonomyGenerator, MAX_REJECTED_DISCOVERY_OUTPUT_CHARS } from "../../src/application/contract-topic-phases";
import { loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { discoveryRequestOf, runDiscoveryAttempts } from "../../src/benchmark/topic-discovery-only";
import { requestPromptFingerprint } from "../../src/benchmark/topic-paired-consolidation";
import type { TopicModelTransport } from "../../src/core/ports";
import { isValidNormalizedTopicName, MAX_TOPIC_NAME_WORDS, normalizeTopicName } from "../../src/core/topics/normalize";
import {
  buildTopicDiscoveryInstructions,
  buildTopicDiscoveryRequest,
  countedTopicNameWords,
  isTopicDiscoveryContract,
  rejectedTopicNamesOf,
  TOPIC_DISCOVERY_CONTRACT,
  TOPIC_DISCOVERY_CONTRACT_V3,
  TOPIC_DISCOVERY_CONTRACTS,
  TOPIC_NAME_RULE,
  topicDiscoveryOutputSchema,
  type TopicModelRequest,
} from "../../src/core/topics/provider-contracts";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";

// topic-discovery-v3: v2 plus name-format robustness only (how the validator counts the words of a name, a preference
// for at most four counted words, no hyphenated compounds, and retry feedback naming each rejected name with its
// counted words and the rule). v2 stays byte-identical and the default. Offline, synthetic transports only.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const V2 = TOPIC_DISCOVERY_CONTRACT;
const V3 = TOPIC_DISCOVERY_CONTRACT_V3;
const t5 = loadTopicBenchmarkDataset("t5-topics-v1");
const { request } = discoveryRequestOf(t5);
const retryFeedback = { attempt: 1, issues: [{ code: "invalid_topic_name" as const, count: 1, topicKeys: ["heat_up_time"] }] };

/** topic-discovery-v2 as committed before v3 existed (instructions per max_topics:retry, full requests, schema). */
const V2_INSTRUCTIONS: Record<string, string> = {
  "3:false": "011df12f8f69663ae626535a426239d43bdd38cbe2551723908efc400fc74a54",
  "3:true": "58e11e9c647439573282e64d729dbbb2d2e21ab3406c6cddb2441d849f2eb0ae",
  "8:false": "d609c6990fbcbbf8a13af0bece19b176f608798dc9d7ae8f7a3919a43fc79123",
  "8:true": "ad15d4ace05427f26e9df70aca38dd982a3e6abce91f7e4bf937be74f3817e64",
  "12:false": "7b5421df82fd44f17aa3747dd6baecce4ae9d670019a3a5f573787e30ed8436c",
  "12:true": "faea2a22d337939e1155a53e019b35d5bcce4f1d87217ebcb417c29255de09d1",
};
const V2_REQUESTS: Record<string, [string, string]> = {
  "t1-topics-v1": ["4ee75395c3ecb57403c74898fd8962a130dde34e73177cf054fd507a060fac34", "1d472b5ffd1cff32629222df5d781ca6f5b7077ab6e9194a0aca976d823f6174"],
  "t4-topics-v1": ["20bdb22f058de49ff7db8cbf4b534451f7cbc450f0d01f7ac8f41fa60e17dc31", "5248a4ec7d4bb81eaffd10f4ac672adb431af386888b99836d3264c64d81b107"],
  "t5-topics-v1": ["696fdbf8404382c1c897f3bd807fc26a3af0a321278e23fec89accb168e87f46", "466b94f2d44fe9bd29f3b91b09dcd26f8e7874c982dd7b97b1ed04b2abc059fc"],
};
const SCHEMA = "edd9fe20b4e86c39c93c002ea65665ea196db52417ec41015ba6752f57c1e927";
/** The v2 t5 prompt fingerprints recorded by the live t5 paired run (pair 2 attempts 1 and 2). */
const V2_T5_PROMPT = { first: "sha256:7f01e2f9fdf31f5659f0f01823746f42c05d66d964caf251e45ed93e3f685af1", retry: "sha256:3b4a0ffb463ac0921327b1d92def71ec8a745626c5008e19c6bd353aff75002a" };
/** topic-discovery-v3 as frozen with the reliability pre-registration. */
const V3_INSTRUCTIONS: Record<string, string> = {
  "3:false": "e85471ec86b1ce3cb1b9415ec04286d8993ac4e45c28c6b6655fb235d05f3517",
  "3:true": "fe6b925d59efd5e2648f815264deb2dbd81e8ad5231e72fc34c384e1ec50aaca",
  "8:false": "aeb751c81d5ea3e04cb19b3f1153e1e9bec1be3b3862f585eaf865e2adcd1ab5",
  "8:true": "cb544861753b1adb757daf4f3ec3646e6a9f63d5afd6c63afb05466c8661554a",
  "12:false": "a4c7e9c7846df0a20d3c814925fa04079028f06d9a8948284feb3707ecbdc16d",
  "12:true": "79a0db48dafab1185f29691f9e8d500d0238b97c8a68ab53c721a0610f9bde72",
};
const V3_T5_PROMPT = { first: "sha256:71dbeb71e8d176fa2823289c46f7deb7ec45940723ec789748d6105f8bc207a5", retry: "sha256:a4ba1a3c3ee3af69adff31e98821a9f888eab3a042fdc277bb768ee2fd293121" };

describe("topic-discovery-v2 is frozen (byte-identical, still the default)", () => {
  it("instructions, full requests (first attempt and retry) and the output schema are unchanged", () => {
    for (const [k, h] of Object.entries(V2_INSTRUCTIONS)) {
      const [m, r] = k.split(":");
      expect(sha(buildTopicDiscoveryInstructions({ maxTopics: Number(m), retry: r === "true" })), k).toBe(h);
      expect(sha(buildTopicDiscoveryInstructions({ maxTopics: Number(m), retry: r === "true", contract: V2 })), k).toBe(h);
    }
    for (const [id, [first, retry]] of Object.entries(V2_REQUESTS)) {
      const req = discoveryRequestOf(loadTopicBenchmarkDataset(id as "t1-topics-v1")).request;
      expect(sha(JSON.stringify(buildTopicDiscoveryRequest(req))), id).toBe(first);
      expect(sha(JSON.stringify(buildTopicDiscoveryRequest({ ...req, feedback: { attempt: 1, issues: [{ code: "invalid_topic_name", count: 1, topicKeys: ["x_key"] }] } }))), id).toBe(retry);
    }
    expect(sha(JSON.stringify(topicDiscoveryOutputSchema(12)))).toBe(SCHEMA);
  });

  it("the v2 prompt fingerprints equal those the live t5 paired run recorded", () => {
    expect(requestPromptFingerprint(buildTopicDiscoveryRequest(request))).toBe(V2_T5_PROMPT.first);
    expect(requestPromptFingerprint(buildTopicDiscoveryRequest({ ...request, feedback: { attempt: 1, issues: [] } }))).toBe(V2_T5_PROMPT.retry);
    const pair2 = JSON.parse(readFileSync("benchmark-results/2026-10-06T16-06-38-444Z-topics-t5-topics-v1-paired-consolidation-anthropic-claude-sonnet-5-5-typesafe-jev-latest-topic-consolidation-v3-vs-topic-consolidation-v4-pair-2.json", "utf8")) as { discovery: { attempts: { promptFingerprint: string }[] } };
    expect(pair2.discovery.attempts.map((a) => a.promptFingerprint)).toEqual([V2_T5_PROMPT.first, V2_T5_PROMPT.retry]);
  });

  it("a v2 retry never carries rejected names, even if some are supplied", () => {
    const req = { ...request, feedback: retryFeedback };
    const plain = buildTopicDiscoveryRequest(req);
    const supplied = buildTopicDiscoveryRequest(req, { contract: V2, rejectedTopicNames: [{ key: "heat_up_time", name: "Heat-Up and Warm-Up Time", countedWords: 6 }] });
    expect(supplied).toEqual(plain);
    expect(plain.data).not.toContain("rejected_topic_names");
  });
});

describe("topic-discovery-v3: its own fingerprint and only the intended robustness change", () => {
  it("is a known contract with its own instruction and prompt fingerprints", () => {
    expect([...TOPIC_DISCOVERY_CONTRACTS]).toEqual(["topic-discovery-v2", "topic-discovery-v3"]);
    expect(isTopicDiscoveryContract("topic-discovery-v3")).toBe(true);
    expect(isTopicDiscoveryContract("topic-discovery-v4")).toBe(false);
    for (const [k, h] of Object.entries(V3_INSTRUCTIONS)) {
      const [m, r] = k.split(":");
      expect(sha(buildTopicDiscoveryInstructions({ maxTopics: Number(m), retry: r === "true", contract: V3 })), k).toBe(h);
    }
    expect(requestPromptFingerprint(buildTopicDiscoveryRequest(request, { contract: V3 }))).toBe(V3_T5_PROMPT.first);
    expect(requestPromptFingerprint(buildTopicDiscoveryRequest({ ...request, feedback: { attempt: 1, issues: [] } }, { contract: V3 }))).toBe(V3_T5_PROMPT.retry);
    expect(V3_T5_PROMPT.first).not.toBe(V2_T5_PROMPT.first);
  });

  it("differs from v2 only in the contract id, the name rules and (on a retry) the retry and invalid_topic_name lines", () => {
    for (const retry of [false, true]) {
      const v2 = buildTopicDiscoveryInstructions({ maxTopics: 12, retry }).split("\n");
      const v3 = buildTopicDiscoveryInstructions({ maxTopics: 12, retry, contract: V3 }).split("\n");
      const changed = (l: string) => l.startsWith("You find the discussion topics") || l.startsWith("- name: ") || l.startsWith("RETRY: ") || l.startsWith("- invalid_topic_name: ");
      expect(v3.filter((l) => !changed(l) && !l.startsWith("- NAME LENGTH: ") && !l.startsWith("- Avoid hyphenated"))).toEqual(v2.filter((l) => !changed(l)));
      expect(v3[0]).toBe(v2[0]!.replace("(contract topic-discovery-v2)", "(contract topic-discovery-v3)"));
      expect(v3.length - v2.length).toBe(2);
    }
    const v3 = buildTopicDiscoveryInstructions({ maxTopics: 12, retry: true, contract: V3 });
    expect(v3).toContain("- NAME LENGTH: 1-5 counted words, and prefer at most 4.");
    expect(v3).toMatch(/every space, hyphen, slash, comma, other punctuation mark or symbol separates words/);
    expect(v3).toContain("- Avoid hyphenated compound words in names");
    expect(v3).toContain("rejected_topic_names lists each rejected name as you wrote it, with its counted word total and the rule it broke");
  });

  it("the data on a first attempt, the output schema, parsing and validation are those of v2", () => {
    const a = buildTopicDiscoveryRequest(request);
    const b = buildTopicDiscoveryRequest(request, { contract: V3 });
    expect(b.data).toBe(a.data);
    expect(b.outputSchema).toEqual(a.outputSchema);
    expect(b.phase).toBe(a.phase);
    expect(b.contract).toBe("topic-discovery-v3");
  });
});

describe("word counting exactly as the validator counts", () => {
  const CASES: [string, number][] = [
    ["Video Requests and Follow-Up Tests", 6],
    ["Heat-Up and Warm-Up Time", 6],
    ["Warm-Up Speed and Scheduling", 5],
    ["Built-in Grinder Performance", 4],
    ["Touchscreen, Controls and Programming", 4],
    ["Espresso Taste and Extraction", 4],
    ["Creator's Picks", 2],
    ["Wi-Fi/Bluetooth Setup", 4],
    ["   ", 0],
    ["", 0],
  ];
  it.each(CASES)("%j counts %i words", (name, words) => {
    expect(countedTopicNameWords(name)).toBe(words);
  });

  it("agrees with the unchanged validator on every case: valid exactly when 1 to 5 counted words", () => {
    expect(MAX_TOPIC_NAME_WORDS).toBe(5);
    for (const [name, words] of CASES) expect(isValidNormalizedTopicName(normalizeTopicName(name)), name).toBe(words >= 1 && words <= 5);
    const taxonomy = (name: string) => ({ topics: [{ key: "k_one", name, definition: "A synthetic theme." }] });
    const ids = request.sample.map((c) => c.id);
    expect(validateTopicTaxonomy(taxonomy("Heat-Up and Warm-Up Time"), { sampleCommentIds: ids, maxTopics: 12 })).toMatchObject({ status: "invalid", issues: [{ code: "invalid_topic_name" }] });
    expect(validateTopicTaxonomy(taxonomy("Heatup and Warmup Time"), { sampleCommentIds: ids, maxTopics: 12 }).status).toBe("valid");
  });

  it("the rejected names of a candidate are exactly the names the validator rejects", () => {
    const candidate = { topics: [{ key: "a_ok", name: "Brew Temperature Stability" }, { key: "heat_up_time", name: "Heat-Up and Warm-Up Time" }, { key: "empty_name", name: "" }, { key: "x", name: 7 }] };
    expect(rejectedTopicNamesOf(candidate)).toEqual([
      { key: "heat_up_time", name: "Heat-Up and Warm-Up Time", countedWords: 6 },
      { key: "empty_name", name: "", countedWords: 0 },
    ]);
    expect(rejectedTopicNamesOf("not a taxonomy")).toEqual([]);
  });
});

/** A synthetic transport answering discovery from a script and remembering every request. */
function scripted(replies: string[]) {
  const requests: TopicModelRequest[] = [];
  const transport: TopicModelTransport = {
    label: "scripted",
    complete: async (r: TopicModelRequest) => {
      requests.push(r);
      return replies[Math.min(requests.length - 1, replies.length - 1)]!;
    },
  };
  return { transport, requests };
}
const ex = (i: number) => request.sample.slice(i * 2, i * 2 + 2).map((c) => c.id);
const taxonomyJson = (firstName: string) =>
  JSON.stringify({ topics: [{ key: "heat_up_time", name: firstName, definition: "Synthetic theme one.", exampleCommentIds: ex(0) }, { key: "second_theme", name: "Second Theme", definition: "Synthetic theme two.", exampleCommentIds: ex(1) }] });
const SECRET = "sk-ant-fake-secret-do-not-use-123456";

describe("v3 retry feedback names the rejected topic: key, name, counted words and the rule", () => {
  it("a v3 retry carries rejected_topic_names; the frozen issue feedback is unchanged", async () => {
    const { transport, requests } = scripted([taxonomyJson("Heat-Up and Warm-Up Time"), taxonomyJson("Heating Time")]);
    const result = await runDiscoveryAttempts(t5, new ContractTopicTaxonomyGenerator(transport, { contract: V3 }));
    expect(result.status).toBe("valid");
    expect(result.attempts.map((a) => [a.outcome, a.issueCodes])).toEqual([["invalid_taxonomy", ["invalid_topic_name"]], ["valid", []]]);
    expect(requests.map((r) => r.contract)).toEqual(["topic-discovery-v3", "topic-discovery-v3"]);
    const feedback = (JSON.parse(requests[1]!.data.split("\n")[2]!.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&")) as { retry_feedback: Record<string, unknown> }).retry_feedback;
    expect(feedback).toEqual({
      attempt: 1,
      issues: [{ code: "invalid_topic_name", count: 1, topicKeys: ["heat_up_time"] }],
      rejected_topic_names: [{ key: "heat_up_time", name: "Heat-Up and Warm-Up Time", counted_words: 6, rule: TOPIC_NAME_RULE }],
    });
    expect(TOPIC_NAME_RULE).toMatch(/^invalid_topic_name: a name must have 1-5 counted words; words are counted after removing apostrophes and turning every run of characters that are not letters or digits/);
    expect(requests[1]!.feedback).toEqual(retryFeedback);
  });

  it("the same exchange under v2 sends the frozen v2 retry: no names, v2 instructions", async () => {
    const { transport, requests } = scripted([taxonomyJson("Heat-Up and Warm-Up Time"), taxonomyJson("Heating Time")]);
    await runDiscoveryAttempts(t5, new ContractTopicTaxonomyGenerator(transport));
    expect(requests.map((r) => r.contract)).toEqual(["topic-discovery-v2", "topic-discovery-v2"]);
    expect(requests[1]).toEqual(buildTopicDiscoveryRequest({ ...request, feedback: retryFeedback }));
  });
});

describe("raw rejected output is kept with secrets removed (every contract)", () => {
  it.each([V2, V3] as const)("%s: rejected responses (invalid taxonomy and unparseable text) are kept and redacted; accepted ones are not", async (contract) => {
    const { transport } = scripted([`{"topics":[{"key":"heat_up_time","name":"Heat-Up and Warm-Up Time","definition":"Mentions ${SECRET}."}]}`, `not json ${SECRET}`]);
    const generator = new ContractTopicTaxonomyGenerator(transport, { contract, secrets: [SECRET] });
    const result = await runDiscoveryAttempts(t5, generator);
    expect(result.status).toBe("unavailable");
    expect(generator.rejectedOutputs.map((r) => [r.call, r.issueCodes])).toEqual([[1, ["invalid_topic_name"]], [2, ["invalid_output"]]]);
    for (const r of generator.rejectedOutputs) {
      expect(r.rawOutput).not.toContain(SECRET);
      expect(r.rawOutput).toContain("[REDACTED]");
      expect(r).toMatchObject({ rawOutputChars: r.rawOutput.length, rawOutputTruncated: false });
    }
    expect(MAX_REJECTED_DISCOVERY_OUTPUT_CHARS).toBe(100_000);

    const ok = scripted([taxonomyJson("Heating Time")]);
    const accepted = new ContractTopicTaxonomyGenerator(ok.transport, { contract, secrets: [SECRET] });
    expect((await runDiscoveryAttempts(t5, accepted)).status).toBe("valid");
    expect(accepted.rejectedOutputs).toEqual([]);
  });

  it("the generator label of v2 is unchanged and names the contract", () => {
    expect(new ContractTopicTaxonomyGenerator(scripted([""]).transport).label).toBe("scripted (topic-discovery-v2)");
    expect(new ContractTopicTaxonomyGenerator(scripted([""]).transport, { contract: V3 }).label).toBe("scripted (topic-discovery-v3)");
  });
});
