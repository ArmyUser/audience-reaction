import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JevClassifier } from "../../src/adapters/ai/typesafe/jev-classifier";
import { buildJevQuestionSet, DEFAULT_JEV_QUESTION_SET, isJevQuestionSetVersion, usesAddressedTargets } from "../../src/adapters/ai/typesafe/jev-question-sets";
import { buildJevQ2Questions } from "../../src/adapters/ai/typesafe/jev-questions-q2";
import { buildJevQ21Questions } from "../../src/adapters/ai/typesafe/jev-questions-q2-1";
import { buildJevQ22Questions, JEV_Q2_2_VERSION } from "../../src/adapters/ai/typesafe/jev-questions-q2-2";
import { runClassifierBenchmark } from "../../src/benchmark/classifier-benchmark";
import { QUESTION_VS_REQUEST_RULE, SPONSOR_AD_EXPERIENCE_RULE } from "../../src/core/classification/guidelines";
import { createClassificationSchema } from "../../src/core/classification/schema";
import { InMemoryUsageRecorder } from "../../src/core/cost/usage";
import { FIXTURE, FOCUS } from "../helpers";
import { goldJevResponder, JEV_PRICES, mockJevFetch, TEST_JEV_KEY } from "./jev-mock";

const schemas = {
  focus: createClassificationSchema({ focusConfigured: true }),
  noFocus: createClassificationSchema({ focusConfigured: false }),
  mixed: createClassificationSchema({ focusConfigured: true, mixedEnabled: true }),
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

describe("jev-q2.2 registration", () => {
  it("is registered, selectable and the default question set", () => {
    expect(JEV_Q2_2_VERSION).toBe("jev-q2.2");
    expect(isJevQuestionSetVersion("jev-q2.2")).toBe(true);
    expect(usesAddressedTargets("jev-q2.2")).toBe(true);
    expect(DEFAULT_JEV_QUESTION_SET).toBe("jev-q2.2");
    expect(buildJevQuestionSet("jev-q2.2", schemas.focus)).toEqual(buildJevQ22Questions(schemas.focus));
  });

  it("as the default, the classifier uses it when no question set is given; older sets stay explicitly selectable", async () => {
    const run = async (questionSet?: "jev-q1" | "jev-q2" | "jev-q2.1" | "jev-q2.2") => {
      const { fetch, calls } = mockJevFetch(goldJevResponder());
      const recorder = new InMemoryUsageRecorder();
      const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, prices: JEV_PRICES, recorder, fetch, sleep: async () => {}, ...(questionSet ? { questionSet } : {}) });
      await classifier.classify({ comments: [{ id: "m2-c01", text: FIXTURE.comments[0]!.text }], schema: schemas.focus, focus: FOCUS });
      return { label: classifier.label, questions: calls[0]!.body.questions, promptVersion: recorder.entries[0]!.promptVersion };
    };
    const byDefault = await run();
    expect(byDefault).toMatchObject({ label: "TypeSafe jev-latest (jev-q2.2)", promptVersion: "jev-q2.2" });
    expect(byDefault.questions).toEqual(buildJevQ22Questions(schemas.focus));
    for (const version of ["jev-q1", "jev-q2", "jev-q2.1"] as const) {
      const explicit = await run(version);
      expect(explicit, version).toMatchObject({ label: `TypeSafe jev-latest (${version})`, promptVersion: version });
      expect(explicit.questions, version).toEqual(buildJevQuestionSet(version, schemas.focus));
      expect(explicit.questions, version).not.toEqual(byDefault.questions);
    }
  });

  it("leaves jev-q1, jev-q2 and jev-q2.1 byte-identical", () => {
    const pins: [string, keyof typeof schemas, string][] = [
      ["jev-q1", "focus", "520634107f89f455"],
      ["jev-q1", "noFocus", "9e7024b9d8db4942"],
      ["jev-q1", "mixed", "b80f636f8af897e1"],
      ["jev-q2", "focus", "8d69648256627df8"],
      ["jev-q2", "noFocus", "adcccfcfdbf81efe"],
      ["jev-q2", "mixed", "697fb158e609d40e"],
      ["jev-q2.1", "focus", "770f25f359952b99"],
      ["jev-q2.1", "noFocus", "55bfa099100eceb8"],
      ["jev-q2.1", "mixed", "84c67e6cd040a739"],
    ];
    for (const [version, schema, expected] of pins) {
      if (!isJevQuestionSetVersion(version)) throw new Error(version);
      expect(hash(buildJevQuestionSet(version, schemas[schema])), `${version} ${schema}`).toBe(expected);
    }
  });

  it("building jev-q2.2 does not mutate jev-q2 or jev-q2.1", () => {
    const q2 = JSON.stringify(buildJevQ2Questions(schemas.focus));
    const q21 = JSON.stringify(buildJevQ21Questions(schemas.focus));
    buildJevQ22Questions(schemas.focus);
    expect(JSON.stringify(buildJevQ2Questions(schemas.focus))).toBe(q2);
    expect(JSON.stringify(buildJevQ21Questions(schemas.focus))).toBe(q21);
  });
});

describe.each(Object.entries(schemas))("jev-q2.2 vs jev-q2.1 (%s)", (_name, schema) => {
  const q21 = buildJevQ21Questions(schema);
  const q22 = buildJevQ22Questions(schema);
  const q2 = buildJevQ2Questions(schema);

  it("has the same keys in the same order, question types and answer options", () => {
    expect(Object.keys(q22)).toEqual(Object.keys(q21));
    for (const key of Object.keys(q21)) {
      expect(q22[key]!.type, key).toBe(q21[key]!.type);
      expect((q22[key] as { criteria?: unknown }).criteria, key).toEqual((q21[key] as { criteria?: unknown }).criteria);
    }
  });

  it("is byte-identical to jev-q2.1 for every question except content_addressed", () => {
    for (const key of Object.keys(q21).filter((k) => k !== "content_addressed")) expect(JSON.stringify(q22[key]), key).toBe(JSON.stringify(q21[key]));
    expect(JSON.stringify(q22.content_addressed)).not.toBe(JSON.stringify(q21.content_addressed));
  });

  it("content_addressed is jev-q2's question: jev-q2.1's minus exactly the appended sponsor/ad rule", () => {
    expect(q22.content_addressed).toEqual(q2.content_addressed);
    expect(q22.content_addressed!.instructions).not.toContain(SPONSOR_AD_EXPERIENCE_RULE);
    expect(q21.content_addressed!.instructions).toBe(`${q22.content_addressed!.instructions} ${SPONSOR_AD_EXPERIENCE_RULE}`);
  });

  it("keeps the sponsor/ad rule on content_sentiment and the focus questions, and the question/request rule on both flags", () => {
    expect(q22.content_sentiment!.instructions).toContain(SPONSOR_AD_EXPERIENCE_RULE);
    if (schema.focusConfigured) {
      expect(q22.focus_addressed!.instructions).toContain(SPONSOR_AD_EXPERIENCE_RULE);
      expect(q22.focus_sentiment!.instructions).toContain(SPONSOR_AD_EXPERIENCE_RULE);
    }
    expect(q22.is_question!.instructions).toContain(QUESTION_VS_REQUEST_RULE);
    expect(q22.is_request!.instructions).toContain(QUESTION_VS_REQUEST_RULE);
  });
});

describe("jev-q2.2 through the unchanged adapter and harness", () => {
  it("gold answers score perfectly; results, usage records and label carry jev-q2.2", async () => {
    let recorder = new InMemoryUsageRecorder();
    const report = await runClassifierBenchmark(
      { name: "m2-synthetic", version: "sha256:test", focus: FOCUS, comments: FIXTURE.comments },
      () => {
        const { fetch } = mockJevFetch(goldJevResponder());
        recorder = new InMemoryUsageRecorder();
        const classifier = new JevClassifier({ apiKey: TEST_JEV_KEY, questionSet: "jev-q2.2", prices: JEV_PRICES, recorder, fetch, sleep: async () => {} });
        expect(classifier.label).toBe("TypeSafe jev-latest (jev-q2.2)");
        return { classifier, provider: "typesafe", model: "jev-latest", promptVersion: "jev-q2.2", batchSize: 1, usage: () => recorder.entries };
      },
      { repeats: 1, mixedEnabled: false, useFocus: true, retryRounds: 0 },
    );
    expect(report.meta).toMatchObject({ promptVersion: "jev-q2.2", guidelineVersion: "g1.4" });
    expect(report.runs[0]!.errorSummary.perfectComments).toBe(60);
    expect(recorder.entries.every((e) => e.promptVersion === "jev-q2.2")).toBe(true);
  });
});
