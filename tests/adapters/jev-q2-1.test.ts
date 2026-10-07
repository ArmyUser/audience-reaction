import { describe, expect, it } from "vitest";
import { JevClassifier } from "../../src/adapters/ai/typesafe/jev-classifier";
import { buildJevQuestionSet, DEFAULT_JEV_QUESTION_SET, isJevQuestionSetVersion, usesAddressedTargets } from "../../src/adapters/ai/typesafe/jev-question-sets";
import { buildJevQ2Questions } from "../../src/adapters/ai/typesafe/jev-questions-q2";
import { buildJevQ21Questions, JEV_Q2_1_VERSION } from "../../src/adapters/ai/typesafe/jev-questions-q2-1";
import { runClassifierBenchmark, type TargetDiagnostic } from "../../src/benchmark/classifier-benchmark";
import { QUESTION_VS_REQUEST_RULE, SPONSOR_AD_EXPERIENCE_RULE } from "../../src/core/classification/guidelines";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { InMemoryUsageRecorder } from "../../src/core/cost/usage";
import type { CommentInput } from "../../src/core/domain/types";
import { FIXTURE, FOCUS } from "../helpers";
import { choice, goldJevResponder, JEV_PRICES, jevResponse, mockJevFetch, noul, TEST_JEV_KEY, type JevResponder } from "./jev-mock";

const schemas = {
  focus: createClassificationSchema({ focusConfigured: true }),
  noFocus: createClassificationSchema({ focusConfigured: false }),
  mixed: createClassificationSchema({ focusConfigured: true, mixedEnabled: true }),
};
const AD_RULE_KEYS = ["content_addressed", "content_sentiment", "focus_addressed", "focus_sentiment"];
const QR_RULE_KEYS = ["is_question", "is_request"];

describe("jev-q2.1 question set", () => {
  it("is registered and selectable explicitly; the default is jev-q2.2", () => {
    expect(JEV_Q2_1_VERSION).toBe("jev-q2.1");
    expect(isJevQuestionSetVersion("jev-q2.1")).toBe(true);
    expect(usesAddressedTargets("jev-q2.1")).toBe(true);
    expect(usesAddressedTargets("jev-q1")).toBe(false);
    expect(DEFAULT_JEV_QUESTION_SET).toBe("jev-q2.2");
    expect(buildJevQuestionSet("jev-q2.1", schemas.focus)).toEqual(buildJevQ21Questions(schemas.focus));
  });

  it.each(Object.entries(schemas))("keeps jev-q2's keys, question types and options (%s)", (_name, schema) => {
    const q2 = buildJevQ2Questions(schema);
    const q21 = buildJevQ21Questions(schema);
    expect(Object.keys(q21)).toEqual(Object.keys(q2));
    for (const key of Object.keys(q2)) {
      expect(q21[key]!.type, key).toBe(q2[key]!.type);
      expect((q21[key] as { criteria?: unknown }).criteria, key).toEqual((q2[key] as { criteria?: unknown }).criteria);
    }
  });

  it.each(Object.entries(schemas))("appends exactly the g1.4 rules to the questions they govern and changes nothing else (%s)", (_name, schema) => {
    const q2 = buildJevQ2Questions(schema);
    const q21 = buildJevQ21Questions(schema);
    for (const key of Object.keys(q2)) {
      const expected = QR_RULE_KEYS.includes(key) ? QUESTION_VS_REQUEST_RULE : AD_RULE_KEYS.includes(key) ? SPONSOR_AD_EXPERIENCE_RULE : undefined;
      expect(q21[key]!.instructions, key).toBe(expected ? `${q2[key]!.instructions} ${expected}` : q2[key]!.instructions);
    }
  });

  it("does not add the ad rule to creator questions or the question/request rule to type and sentiment", () => {
    const q21 = buildJevQ21Questions(schemas.focus);
    for (const key of ["type", "sentiment", "creator_addressed", "creator_sentiment"]) {
      expect(q21[key]!.instructions, key).not.toContain(SPONSOR_AD_EXPERIENCE_RULE);
      expect(q21[key]!.instructions, key).not.toContain(QUESTION_VS_REQUEST_RULE);
    }
  });

  it("does not mutate jev-q2 when built", () => {
    const before = JSON.stringify(buildJevQ2Questions(schemas.focus));
    buildJevQ21Questions(schemas.focus);
    expect(JSON.stringify(buildJevQ2Questions(schemas.focus))).toBe(before);
  });
});

function jev(responder: JevResponder) {
  const { fetch, calls } = mockJevFetch(responder);
  const recorder = new InMemoryUsageRecorder();
  const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, questionSet: "jev-q2.1", prices: JEV_PRICES, recorder, fetch, sleep: async () => {} });
  return { classifier, calls, recorder };
}

/** Complete jev-q2.1 answers (same keys as jev-q2), overridable per key. */
function answers(overrides: Record<string, unknown>): JevResponder {
  return () =>
    jevResponse({
      type: choice("opinion"),
      sentiment: choice("negative"),
      is_question: noul(0.05),
      is_request: noul(0.05),
      creator_addressed: noul(0.05),
      creator_sentiment: choice("neutral"),
      content_addressed: noul(0.05),
      content_sentiment: choice("neutral"),
      focus_addressed: noul(0.05),
      focus_sentiment: choice("neutral"),
      ...overrides,
    });
}

async function classify(responder: JevResponder, text: string) {
  const { classifier, calls, recorder } = jev(responder);
  const comment: CommentInput = { id: "x", text };
  const raw = (await classifier.classify({ comments: [comment], schema: schemas.focus, focus: FOCUS })) as { results: Record<string, unknown>[] };
  return { result: raw.results[0] as { type: string; isQuestion: boolean; isRequest: boolean; targets: Record<string, string> }, calls, recorder };
}

describe("jev-q2.1 regression examples (mocked answers that follow g1.4; they test the mapping, not the model)", () => {
  it.each(["the ad was way too long", "ugh another Acme ad"])("%s → content negative, focus not addressed", async (text) => {
    const { result, calls } = await classify(answers({ content_addressed: noul(0.85), content_sentiment: choice("negative"), focus_addressed: noul(0.2), focus_sentiment: choice("neutral") }), text);
    expect(result.targets).toEqual({ creator: "not_addressed", content: "negative", focus: "not_addressed" });
    expect(calls[0]!.body.questions.focus_addressed).toBeDefined();
    expect(JSON.stringify(calls[0]!.body.questions)).toContain(SPONSOR_AD_EXPERIENCE_RULE);
  });

  it.each(["Acme VPN is terrible", "Acme VPN is buggy and overpriced"])("%s → focus negative", async (text) => {
    const { result } = await classify(answers({ focus_addressed: noul(0.95), focus_sentiment: choice("negative") }), text);
    expect(result.targets).toEqual({ creator: "not_addressed", content: "not_addressed", focus: "negative" });
  });

  it("Acme VPN keeps sponsoring this channel → focus not addressed", async () => {
    const { result } = await classify(answers({ sentiment: choice("neutral"), focus_addressed: noul(0.3) }), "Acme VPN keeps sponsoring this channel");
    expect(result.targets.focus).toBe("not_addressed");
  });

  it.each([
    ["What mic are you using?", "question", 0.95, 0.1],
    ["Is the discount code still working?", "question", 0.95, 0.1],
    ["Does it support Linux?", "question", 0.95, 0.1],
    ["Please make a full review", "request", 0.05, 0.95],
    ["Could you cover battery life next time?", "request", 0.2, 0.95],
    ["Would love a follow-up in six months", "request", 0.05, 0.9],
  ] as const)("%s → type %s with independent flags", async (text, type, pQuestion, pRequest) => {
    const { result } = await classify(answers({ type: choice(type), sentiment: choice("neutral"), is_question: noul(pQuestion), is_request: noul(pRequest) }), text);
    expect(result).toMatchObject({ type, isQuestion: pQuestion >= 0.5, isRequest: pRequest >= 0.5 });
    expect(result.isQuestion && result.isRequest).toBe(false);
  });
});

describe("jev-q2.1 through the unchanged benchmark harness", () => {
  it("gold answers score perfectly and the results record jev-q2.1", async () => {
    const report = await runClassifierBenchmark(
      { name: "m2-synthetic", version: "sha256:test", focus: FOCUS, comments: FIXTURE.comments },
      () => {
        const { fetch } = mockJevFetch(goldJevResponder());
        const recorder = new InMemoryUsageRecorder();
        const gates = new Map<string, TargetDiagnostic[]>();
        const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, questionSet: "jev-q2.1", prices: JEV_PRICES, recorder, fetch, sleep: async () => {}, onTargetDiagnostics: (id, d) => gates.set(id, d) });
        return { classifier, provider: "typesafe", model: "jev-latest", promptVersion: "jev-q2.1", batchSize: 1, usage: () => recorder.entries, targetDiagnostics: () => gates };
      },
      { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 },
    );
    expect(report.meta).toMatchObject({ promptVersion: "jev-q2.1", guidelineVersion: "g1.4" });
    expect(report.runs[0]!.errorSummary.perfectComments).toBe(60);
    expect(report.runs[0]!.comments.every((c) => c.targetDiagnostics?.length === 3)).toBe(true);
  });

  it("usage records and the classifier label carry jev-q2.1", async () => {
    const { classifier, recorder } = jev(goldJevResponder());
    expect(classifier.label).toBe("TypeSafe jev-latest (jev-q2.1)");
    await classifier.classify({ comments: [{ id: "m2-c01", text: FIXTURE.comments[0]!.text }], schema: schemas.focus, focus: FOCUS });
    expect(recorder.entries[0]!.promptVersion).toBe("jev-q2.1");
  });
});
