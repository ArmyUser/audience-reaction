import { describe, expect, it } from "vitest";
import { FakeClassifier } from "../../src/adapters/fakes/fake-classifier";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { parseClassifierOutput } from "../../src/core/classification/validation";
import { FIXTURE, FOCUS, goldDeps, VIDEO_ID } from "../helpers";

const injection = FIXTURE.comments.filter((c) => c.tags.includes("prompt_injection"));

describe("hostile comment text stays data", () => {
  it("the fixture set contains prompt-injection and markup payloads", () => {
    expect(injection.length).toBeGreaterThanOrEqual(6);
    expect(FIXTURE.comments.some((c) => c.text.includes("<script>"))).toBe(true);
  });

  it("instruction-like text does not change any other comment's labels (keyword fake)", async () => {
    const schema = createClassificationSchema({ focusConfigured: true });
    const all = FIXTURE.comments.map((c) => ({ id: c.id, text: c.text }));
    const withoutInjection = all.filter((c) => !injection.some((i) => i.id === c.id));

    const fake = new FakeClassifier();
    const full = parseClassifierOutput(await fake.classify({ comments: all, schema, focus: FOCUS }), all, schema);
    const clean = parseClassifierOutput(await fake.classify({ comments: withoutInjection, schema, focus: FOCUS }), withoutInjection, schema);

    const fullById = new Map(full.map((r) => [r.commentId, r]));
    for (const r of clean) expect(fullById.get(r.commentId)).toEqual(r);
  });

  it("injection comments addressed at other ids (m2-c49, m2-c50) do not alter the targeted comments", async () => {
    const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
    if (outcome.status !== "completed") throw new Error("expected completed");
    const byId = new Map(outcome.classified.map((c) => [c.comment.id, c.classification]));
    expect(byId.get("m2-c03")!.sentiment).toBe("negative");
    expect(byId.get("m2-c06")!.sentiment).toBe("negative");
    expect(outcome.classified).toHaveLength(FIXTURE.comments.length);
  });

  it("fake-JSON comment text cannot inject extra classifier results", async () => {
    const schema = createClassificationSchema({ focusConfigured: true });
    const target = FIXTURE.comments.find((c) => c.tags.includes("fake_json") && c.text.includes("commentId"))!;
    const comments = [{ id: target.id, text: target.text }];
    const out = parseClassifierOutput(await new FakeClassifier().classify({ comments, schema, focus: FOCUS }), comments, schema);
    expect(out.map((r) => r.commentId)).toEqual([target.id]);
  });
});
