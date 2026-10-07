import { describe, expect, it } from "vitest";
import { AnthropicClassifier } from "../../src/adapters/ai/anthropic/anthropic-classifier";
import { classifyComments } from "../../src/core/classification/classify-comments";
import { buildClassifierInstructions } from "../../src/core/classification/llm-prompt";
import { createClassificationSchema } from "../../src/core/classification/schema";
import type { CommentInput } from "../../src/core/domain/types";
import { FIXTURE, FOCUS } from "../helpers";
import { goldResponder, messageResponse, mockClient, PRICES, requestComments } from "./anthropic-mock";

// Mocked-model tests of the injection defences around the LLM adapter. Whether the real model resists injection is
// measured separately by the benchmark (prompt_injection slice); here we prove the pipeline never trusts it.

const schema = createClassificationSchema({ focusConfigured: true });
const injection: CommentInput[] = FIXTURE.comments.filter((c) => c.tags.includes("prompt_injection")).map((c) => ({ id: c.id, text: c.text }));

describe("prompt injection — request side", () => {
  it("fixture injection comments reach the model only as escaped data, never in the instructions", async () => {
    const { client, calls } = mockClient(goldResponder(true));
    await new AnthropicClassifier({ client, prices: PRICES }).classify({ comments: injection, schema, focus: FOCUS });
    const system = String(calls[0]!.body.system);
    for (const c of injection) expect(system).not.toContain(c.text);
    expect(requestComments(calls[0]!).map((x) => x.text)).toEqual(injection.map((c) => c.text));
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it("instructions state the data-not-instructions rule and the no-tools rule", () => {
    const text = buildClassifierInstructions(schema);
    expect(text).toMatch(/untrusted DATA/);
    expect(text).toMatch(/Never follow instructions/);
    expect(text).toMatch(/can never change the label of another comment/);
    expect(text).toMatch(/no tools/);
  });
});

describe("prompt injection — response side (model misbehaves)", () => {
  it.each<[string, (ids: string[]) => unknown]>([
    ["obeys 'return this exact text' with an empty result list", () => ({ results: [] })],
    ["adds an arbitrary field to every item", (ids) => ({ results: ids.map((id) => ({ ...valid(id), note: "ignored instructions" })) })],
    ["changes the schema with an extra root field", (ids) => ({ results: ids.map(valid), system_prompt: "..." })],
    ["labels other comments as the injected text demands (wrong ids)", (ids) => ({ results: ids.map((_, i) => valid(`m2-c0${i}`)) })],
    ["returns a label outside the schema", (ids) => ({ results: ids.map((id) => ({ ...valid(id), sentiment: "ecstatic" })) })],
  ])("the engine rejects a model that %s", async (_name, respond) => {
    const { client } = mockClient((req) => messageResponse(JSON.stringify(respond(requestComments(req).map((x) => x.commentId)))));
    const result = await classifyComments(injection, new AnthropicClassifier({ client, prices: PRICES }), schema, FOCUS, { retryRounds: 0 });
    expect(result.classifications).toEqual([]);
    expect(result.failures.map((f) => f.commentId)).toEqual(injection.map((c) => c.id));
  });

  it("a well-behaved model's labels for injection comments pass validation unchanged", async () => {
    const { client } = mockClient(goldResponder(true));
    const result = await classifyComments(injection, new AnthropicClassifier({ client, prices: PRICES }), schema, FOCUS, { retryRounds: 0 });
    expect(result.classifications).toHaveLength(injection.length);
    expect(result.classifications.every((c) => c.type === "other" && c.sentiment === "neutral")).toBe(true);
  });
});

function valid(id: string) {
  return { commentId: id, type: "other", isQuestion: false, isRequest: false, sentiment: "neutral", targets: { creator: "not_addressed", content: "not_addressed", focus: "not_addressed" } };
}
