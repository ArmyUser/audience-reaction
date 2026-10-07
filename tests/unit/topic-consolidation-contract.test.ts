import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTopicConsolidationInstructions,
  buildTopicConsolidationRequest,
  consolidationExampleIds,
  consolidationMaxTopics,
  isTopicConsolidationContract,
  TOPIC_CONSOLIDATION_CONTRACT,
  TOPIC_CONSOLIDATION_CONTRACT_V4,
  TOPIC_CONSOLIDATION_CONTRACTS,
  type TopicConsolidationRequest,
} from "../../src/core/topics/consolidation-contract";
import { validateTopicTaxonomy } from "../../src/core/topics/taxonomy";

// The topic consolidation contract as frozen: topic-consolidation-v3 (the default) and topic-consolidation-v4 (v3 plus
// one subject-coherence DROP criterion). Their rendered instructions are pinned by SHA-256: completed independence
// audits and recorded benchmark runs refer to exactly these texts, so any wording change needs a new contract version.
// Synthetic data only.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const V3_FINGERPRINTS: Record<string, string> = {
  "3:false": "55b41ddb31647f59c2dd968ab6ed5d96484a1c8f4a6e9ec185d749fa6a864056",
  "3:true": "e74b1d158a6ed45a3e1cef17d2905e60971ff3e3769578b1e2661e3c8e8f9f93",
  "8:false": "e8cca57e97fc3b4bfae7e764be1e20abe2ecdc990ff8f368c37759ad31e3c8ca",
  "8:true": "5bb1126a9447924fc9550cd23f8f02aeec3b380722a2bc964cdcd2090d5552b0",
  "12:false": "cc6956d20176f69e35e72ff5580b620bccf728510c548b69ee98a1e3eb7f19ea",
  "12:true": "50e5cf59939489f26a427c2775aefea1a14ddabb1fc0005d847d20a448c1c14e",
};
const V4_FINGERPRINTS: Record<string, string> = {
  "3:false": "8a1f3640582c6a22e097ed780789f91bec0ecc122e91b030e8b287972114e514",
  "3:true": "59b8a07c49e474a971761507841b676cbfa8824cc9054faf2f74f9a26e75a1a0",
  "8:false": "29015a9671a48d26c3e1a204cc21409f02356ec15370503982d76b45cc2820d9",
  "8:true": "54cfef5929829feca227c3db5148a262cdc822708b0dad85a7be2337c2a6781d",
  "12:false": "7932f8bf5c7c267acec17ebbc6babd307df02bc0a55bb4ec113e2b6250feb14c",
  "12:true": "8e49476cc9c7a9ab6f6c5a4dacc964a3bcd0d5ecbc8e525cc7667f239ae2ae06",
};
const v3 = (maxTopics = 12, retry = false) => buildTopicConsolidationInstructions({ maxTopics, retry });
const v4 = (maxTopics = 12, retry = false) => buildTopicConsolidationInstructions({ maxTopics, retry, contract: TOPIC_CONSOLIDATION_CONTRACT_V4 });

const SAMPLE = Array.from({ length: 12 }, (_, i) => ({ id: `s-${String(i + 1).padStart(2, "0")}`, text: `synthetic comment ${i + 1}` }));
const candidate = (() => {
  const r = validateTopicTaxonomy(
    {
      topics: [
        { key: "first_theme", name: "First theme", definition: "A synthetic first theme.", exampleCommentIds: ["s-01", "s-02"] },
        { key: "second_theme", name: "Second theme", definition: "A synthetic second theme.", exampleCommentIds: ["s-02", "s-03"] },
        { key: "third_theme", name: "Third theme", definition: "A synthetic third theme." },
      ],
    },
    { sampleCommentIds: SAMPLE.map((c) => c.id), maxTopics: 12 },
  );
  if (r.status !== "valid") throw new Error("the synthetic candidate must validate");
  return r.taxonomy;
})();
const request: TopicConsolidationRequest = { candidate, sample: SAMPLE, context: { maxTopics: 12, topicBase: 40, minTopicSize: 10 } };

describe("topic consolidation contract: frozen versions", () => {
  it("knows exactly v3 (the default) and v4", () => {
    expect(TOPIC_CONSOLIDATION_CONTRACT).toBe("topic-consolidation-v3");
    expect(TOPIC_CONSOLIDATION_CONTRACT_V4).toBe("topic-consolidation-v4");
    expect([...TOPIC_CONSOLIDATION_CONTRACTS]).toEqual(["topic-consolidation-v3", "topic-consolidation-v4"]);
    expect(isTopicConsolidationContract("topic-consolidation-v4")).toBe(true);
    expect(isTopicConsolidationContract("topic-consolidation-v2")).toBe(false);
  });

  it("v3 instructions are byte-for-byte frozen (and are the default)", () => {
    for (const [k, h] of Object.entries(V3_FINGERPRINTS)) {
      const [m, retry] = k.split(":");
      expect(sha(v3(Number(m), retry === "true")), k).toBe(h);
      expect(sha(buildTopicConsolidationInstructions({ maxTopics: Number(m), retry: retry === "true", contract: TOPIC_CONSOLIDATION_CONTRACT })), k).toBe(h);
    }
  });

  it("v4 instructions are byte-for-byte frozen", () => {
    for (const [k, h] of Object.entries(V4_FINGERPRINTS)) {
      const [m, retry] = k.split(":");
      expect(sha(v4(Number(m), retry === "true")), k).toBe(h);
    }
  });

  it("v4 is v3 with only the contract name and one four-line block after the DROP rule", () => {
    for (const [m, retry] of [[12, false], [8, true], [3, false]] as const) {
      const a = v3(m, retry).split("\n");
      const b = v4(m, retry).replace(TOPIC_CONSOLIDATION_CONTRACT_V4, TOPIC_CONSOLIDATION_CONTRACT).split("\n");
      const drop = a.findIndex((l) => l.startsWith("- DROP:"));
      expect(b.length - a.length).toBe(4);
      expect([...b.slice(0, drop + 1), ...b.slice(drop + 5)]).toEqual(a);
      expect(b[drop + 1]).toMatch(/^- DROP also/);
    }
    expect(v3()).not.toMatch(/coherent subject or concern|form or addressee|unrelated side subjects/);
  });

  it("requests carry the chosen contract (v3 by default); data, schema and phase do not depend on the version", () => {
    const a = buildTopicConsolidationRequest(request);
    const b = buildTopicConsolidationRequest(request, TOPIC_CONSOLIDATION_CONTRACT_V4);
    expect(a.contract).toBe("topic-consolidation-v3");
    expect(a.instructions).toBe(v3(consolidationMaxTopics(request), false));
    expect(b.contract).toBe("topic-consolidation-v4");
    expect(b.instructions).toBe(v4(consolidationMaxTopics(request), false));
    expect(b.data).toBe(a.data);
    expect(b.outputSchema).toEqual(a.outputSchema);
    expect(b.phase).toBe(a.phase);
  });

  it("bounds: at most as many topics as candidates; examples only from the candidates' example IDs", () => {
    expect(consolidationMaxTopics(request)).toBe(3);
    expect(consolidationMaxTopics({ ...request, context: { ...request.context, maxTopics: 2 } })).toBe(2);
    expect(consolidationExampleIds(candidate)).toEqual(["s-01", "s-02", "s-03"]);
  });
});
