import { describe, expect, it } from "vitest";
import { FixtureTopicDiscoverer, type TopicFixture } from "../../src/adapters/fakes/fixture-topic-discoverer";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseTopicDiscoveryOutput } from "../../src/core/topics/validation";

const LABELS = createClassificationSchema({ focusConfigured: false }).sentimentLabels;
const fixture = (unlisted: TopicFixture["unlisted"]): TopicFixture => ({
  topics: [
    { key: "audio", name: "Audio quality", description: "Sound, microphone or mixing.", exampleCommentIds: ["c1"] },
    { key: "price", name: "Pricing" },
  ],
  unlisted,
  decisions: {
    c1: { disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" },
    c2: { disposition: "primary_topic", topicKey: "price", topicSentiment: "positive", confidence: 0.8 },
    c4: { disposition: "other" },
    c5: { disposition: "no_specific_topic", confidence: 0.9 },
    c9: { disposition: "primary_topic", topicKey: "price", topicSentiment: "neutral" },
  },
});
const request = (ids: string[]) => ({ comments: ids.map((id) => ({ id, text: `text ${id}` })), context: { sentimentLabels: LABELS, maxTopics: 12 } });

describe("FixtureTopicDiscoverer (test-only fake)", () => {
  it("replays all three dispositions for requested comments only, in request order", async () => {
    const raw = await new FixtureTopicDiscoverer(fixture("omit")).discoverTopics(request(["c5", "c2", "c3", "c4", "c1"]));
    expect(raw).toEqual({
      topics: fixture("omit").topics,
      assignments: [
        { commentId: "c5", disposition: "no_specific_topic", confidence: 0.9 },
        { commentId: "c2", disposition: "primary_topic", topicKey: "price", topicSentiment: "positive", confidence: 0.8 },
        { commentId: "c4", disposition: "other" },
        { commentId: "c1", disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" },
      ],
    });
  });

  it("emits an explicit no_specific_topic for unlisted comments only when asked to", async () => {
    const explicit = (await new FixtureTopicDiscoverer(fixture("no_specific_topic")).discoverTopics(request(["c3"]))) as { assignments: unknown[] };
    expect(explicit.assignments).toEqual([{ commentId: "c3", disposition: "no_specific_topic" }]);
    const omitted = (await new FixtureTopicDiscoverer(fixture("omit")).discoverTopics(request(["c3"]))) as { assignments: unknown[] };
    expect(omitted.assignments).toEqual([]);
  });

  it("is deterministic and does not depend on comment text", async () => {
    const discoverer = new FixtureTopicDiscoverer(fixture("no_specific_topic"));
    const a = await discoverer.discoverTopics(request(["c1", "c2"]));
    const b = await discoverer.discoverTopics({ ...request(["c1", "c2"]), comments: [{ id: "c1", text: "different" }, { id: "c2", text: "" }] });
    expect(b).toEqual(a);
  });

  it("produces output the engine accepts without issues", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const result = parseTopicDiscoveryOutput(await new FixtureTopicDiscoverer(fixture("no_specific_topic")).discoverTopics(request(ids)), ids, {
      maxTopics: 12,
      sentimentLabels: LABELS,
    });
    expect(result.issues).toEqual([]);
    expect(result.assignments).toEqual([
      { commentId: "c1", disposition: "primary_topic", topicId: "topic:audio-quality", topicSentiment: "negative" },
      { commentId: "c2", disposition: "primary_topic", topicId: "topic:pricing", topicSentiment: "positive", confidence: 0.8 },
      { commentId: "c3", disposition: "no_specific_topic" },
      { commentId: "c4", disposition: "other" },
      { commentId: "c5", disposition: "no_specific_topic", confidence: 0.9 },
    ]);
  });

  it("returns copies, so callers cannot mutate the fixture", async () => {
    const f = fixture("omit");
    const raw = (await new FixtureTopicDiscoverer(f).discoverTopics(request(["c1"]))) as { topics: { exampleCommentIds?: string[] }[]; assignments: { topicSentiment: string }[] };
    raw.topics[0]!.exampleCommentIds!.push("c2");
    raw.assignments[0]!.topicSentiment = "positive";
    expect(f.topics[0]!.exampleCommentIds).toEqual(["c1"]);
    expect(f.decisions.c1).toEqual({ disposition: "primary_topic", topicKey: "audio", topicSentiment: "negative" });
  });

  it("treats IDs that collide with object properties as unlisted", async () => {
    const raw = (await new FixtureTopicDiscoverer(fixture("omit")).discoverTopics(request(["constructor", "__proto__", "toString"]))) as { assignments: unknown[] };
    expect(raw.assignments).toEqual([]);
  });
});
