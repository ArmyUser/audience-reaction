import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FABRICATED_EXAMPLE_ID,
  MALFORMED_MARKER,
  OracleTaxonomyGenerator,
  OracleTopicAssigner,
  ScriptedTopicAssigner,
  UNLISTED_TOPIC_KEY,
  type TopicPhaseGold,
} from "../../src/adapters/fakes/topic-benchmark-phases";
import {
  definitionProblems,
  matchPredictedTopics,
  oracleGateFailures,
  perfectionFailures,
  renderTopicBenchmarkMarkdown,
  runTopicBenchmark,
  type TopicBenchmarkReport,
  type TopicScenarioResult,
} from "../../src/benchmark/topic-benchmark";
import { goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { TOPIC_SCENARIO_IDS } from "../../src/benchmark/topic-scenarios";

// Offline topic benchmark t1-topics-v1: the oracle gate, scripted degradations of both phases, retry semantics,
// AC-23, topic-specific sentiment, OTHER / NO_SPECIFIC_TOPIC, reportability and repeatability. Every provider is a
// deterministic fake; nothing leaves the process.

const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const B = gold.baseIds.length;
const PRIMARY = 134;
const DIVERGING = 17;
let report: TopicBenchmarkReport;
beforeAll(async () => {
  report = await runTopicBenchmark(dataset);
}, 120_000);

const scenario = (id: string): TopicScenarioResult => report.scenarios.find((s) => s.id === id)!;
const run = (id: string) => scenario(id).runs[0]!;
const calls = (id: string, phase: "taxonomy" | "assignment") => run(id).phaseCalls.filter((c) => c.phase === phase);
const pp = (count: number) => Math.round((count / B) * 100 * 1000) / 1000;

describe("oracle sanity gate", () => {
  it("runs first and passes", () => {
    expect(report.scenarios.map((s) => s.id)).toEqual([...TOPIC_SCENARIO_IDS]);
    expect(report.oracleGate).toEqual({ passed: true, failures: [] });
  });

  it("scores 100% on taxonomy, assignment, topic sentiment and reportability, with no retry and no validation failure", () => {
    const oracle = run("oracle");
    expect(perfectionFailures(oracle)).toEqual([]);
    expect(oracle.taxonomy).toMatchObject({ predictedTopics: 8, matchedTopics: 8, topicPrecision: 1, conceptRecall: 1, mergeErrors: 0, splitErrors: 0, definitionValidity: 1, exampleIdValidity: 1, exampleSupport: 1 });
    expect(oracle.taxonomy!.matches.every((m) => m.jaccard === 1)).toBe(true);
    expect(oracle.assignment).toEqual({
      dispositionAccuracy: 1,
      primaryTopicAccuracy: 1,
      otherAccuracy: 1,
      otherPrecision: 1,
      noSpecificTopicAccuracy: 1,
      noSpecificTopicPrecision: 1,
      topicSentimentAccuracy: 1,
      topicSentimentScored: PRIMARY,
      overallSentimentAgreement: (PRIMARY - DIVERGING) / PRIMARY,
      fullValidity: 1,
    });
    expect(oracle.report).toMatchObject({ namedShareErrorMaxPp: 0, unmatchedNamedSharePp: 0, otherShareErrorPp: 0, noSpecificTopicShareErrorPp: 0, highOtherShareExpected: false, highOtherShareCorrect: true, evidenceCoverage: 1, evidenceSentimentCoverage: 1, evidencePrecision: 1, ac23Valid: true });
    expect(scenario("oracle").retryRate).toBe(0);
    expect(oracle.failedAttemptCodes).toEqual([]);
    expect(oracle.taxonomyProposals).toEqual([{ attempt: 1, valid: true, issueCodes: [] }]);
    expect(oracle.phaseCalls).toEqual([
      { phase: "taxonomy", attempt: 1, comments: B, failed: false },
      { phase: "assignment", attempt: 1, comments: B, failed: false },
    ]);
  });

  it("reports the gold structure: seven named topics, the small topic merged into OTHER, gold topic sentiment per topic", () => {
    const section = run("oracle").section;
    if (section.status !== "available") throw new Error("expected available");
    expect(section.topics.map((t) => [t.name, t.count.count])).toEqual([
      ["riding range", 28], ["motor assist", 24], ["folding and carrying", 20], ["ride comfort", 16], ["charging and battery removal", 14], ["price and value", 14], ["brakes and stopping", 12],
    ]);
    expect(section.other).toMatchObject({ count: { count: 28 }, providerOther: { count: 22 }, smallTopics: { count: 6 }, mergedTopics: [{ name: "companion app", mentionCount: 6 }] });
    expect(section.noSpecificTopic.count).toBe(32);
    expect(section.warnings).toEqual([]);
    for (const t of section.topics) {
      const key = run("oracle").taxonomy!.matches.find((m) => m.topicId === t.id)!.goldKey!;
      expect(Object.fromEntries(t.topicSentiment.rows.map((r) => [r.label, r.count])), key).toEqual(report.gold.topicSentiment[key]);
    }
  });

  it("fails when the oracle taxonomy, assignments, topic sentiment, AC-23 or retry behaviour is not perfect", () => {
    const asOracle = (id: string): TopicScenarioResult => ({ ...scenario(id), id: "oracle" });
    expect(oracleGateFailures(asOracle("taxonomy-merged")).join("; ")).toMatch(/concept recall 0\.875.*1 merge errors/);
    expect(oracleGateFailures(asOracle("assignment-other-nst-swap")).join("; ")).toMatch(/OTHER not exact/);
    expect(oracleGateFailures(asOracle("assignment-wrong-sentiment")).join("; ")).toMatch(/topic-sentiment accuracy/);
    const broken = structuredClone(scenario("oracle"));
    broken.runs[0]!.report!.ac23Valid = false;
    expect(oracleGateFailures(broken).join("; ")).toMatch(/AC-23 violated/);
    expect(oracleGateFailures(asOracle("taxonomy-invalid"))).toEqual(expect.arrayContaining(["retry rate 1", "validation failures"]));
    expect(oracleGateFailures(asOracle("taxonomy-duplicate-name")).join("; ")).toMatch(/topics unavailable/);
    expect(oracleGateFailures(scenario("retry-success"))).toEqual(["the oracle did not run first"]);
  });
});

describe("every scenario meets its stated expectation", () => {
  it.each([...TOPIC_SCENARIO_IDS])("%s", (id) => {
    const s = scenario(id);
    expect(s.expectationFailures).toEqual([]);
    expect(s.perfect).toBe(s.expected.perfect);
    expect(s.runs).toHaveLength(2);
  });
});

describe("degraded taxonomy", () => {
  it.each([
    ["taxonomy-duplicate-name", "duplicate_topic_name", ["motor"]],
    ["taxonomy-missing-definition", "missing_definition", ["app"]],
    ["taxonomy-too-many-topics", "too_many_topics", undefined],
    ["taxonomy-invalid-example", "unknown_example_comment", ["range"]],
  ])("%s: caught before assignment, rediscovered with feedback, then TOPICS_UNAVAILABLE", (id, code, topicKeys) => {
    const r = run(id);
    expect(r).toMatchObject({ status: "unavailable", attempts: 2, generatorCalls: 2, assignerCalls: 0, failedAttemptCodes: [[code], [code]] });
    expect(r.taxonomyProposals.map((p) => p.valid)).toEqual([false, false]);
    const [first, second] = calls(id, "taxonomy");
    expect(first!.feedback).toBeUndefined();
    expect(second!.feedback).toEqual({ attempt: 1, issues: [{ code, count: 1, ...(topicKeys ? { topicKeys } : {}) }] });
    expect(r.section).toEqual(expect.objectContaining({ status: "unavailable", issues: [{ attempt: 1, code, count: 1 }, { attempt: 2, code, count: 1 }] }));
    expect(JSON.stringify(r.section)).not.toContain(FABRICATED_EXAMPLE_ID);
    expect(JSON.stringify(second!.feedback)).not.toContain(FABRICATED_EXAMPLE_ID);
  });
});

describe("degraded assignment", () => {
  it.each([
    ["assignment-missing-comment", "missing_assignment", 3, 3],
    ["assignment-duplicate", "multiple_primary_topics", 1, 1],
    ["assignment-unknown-topic", "unknown_topic", 3, 3],
    ["assignment-malformed", "invalid_output", 1, B],
  ])("%s: caught by validation, retried once, then TOPICS_UNAVAILABLE", (id, code, count, retried) => {
    const r = run(id);
    expect(r).toMatchObject({ status: "unavailable", attempts: 2, generatorCalls: 1, assignerCalls: 2, failedAttemptCodes: [[code], [code]] });
    const [first, second] = calls(id, "assignment");
    expect(first).toMatchObject({ attempt: 1, comments: B });
    expect(first!.feedback).toBeUndefined();
    expect(second).toMatchObject({ attempt: 2, comments: retried });
    expect(second!.feedback!.issues).toEqual([expect.objectContaining({ code, count })]);
    if (code === "unknown_topic") expect(second!.feedback!.issues[0]!.topicKeys).toEqual([UNLISTED_TOPIC_KEY]);
    if (code === "invalid_output") expect(second!.feedback!.issues[0]!.commentIds).toBeUndefined();
    else expect(second!.feedback!.issues[0]!.commentIds).toHaveLength(count);
    expect(r.section.status).toBe("unavailable");
    expect("topics" in r.section).toBe(false);
  });

  it("wrong topic sentiment (overall copied) is not a validation error, and only topic-sentiment accuracy drops", () => {
    const r = run("assignment-wrong-sentiment");
    expect(r.status).toBe("available");
    expect(r.assignment!.topicSentimentAccuracy).toBe((PRIMARY - DIVERGING) / PRIMARY);
    expect(r.assignment!.topicSentimentAccuracy).toBe(r.assignment!.overallSentimentAgreement);
    expect(perfectionFailures(r)).toEqual([`topic-sentiment accuracy ${(PRIMARY - DIVERGING) / PRIMARY}`]);
    // The report aggregates the (wrong) topic sentiment it was given, so its rows differ from gold.
    const section = r.section;
    if (section.status !== "available") throw new Error("expected available");
    const range = section.topics.find((t) => t.name === "riding range")!;
    expect(Object.fromEntries(range.topicSentiment.rows.map((x) => [x.label, x.count]))).not.toEqual(report.gold.topicSentiment.range);
  });

  it("swapping OTHER and NO_SPECIFIC_TOPIC is scored per bucket while the combined share stays right", () => {
    const r = run("assignment-other-nst-swap");
    expect(r.assignment).toMatchObject({ otherAccuracy: 0, noSpecificTopicAccuracy: 0, primaryTopicAccuracy: 1, topicSentimentAccuracy: 1, dispositionAccuracy: (B - 22 - 32) / B });
    expect(r.report).toMatchObject({ otherShareErrorPp: pp(10), noSpecificTopicShareErrorPp: pp(10), highOtherShareCorrect: true, ac23Valid: true });
  });

  it("over-assigning to OTHER removes named topics and raises a HIGH_OTHER_SHARE that gold does not have", () => {
    const r = run("assignment-over-other");
    expect(r.report).toMatchObject({ highOtherShareExpected: false, highOtherShareReported: true, highOtherShareCorrect: false, otherShareErrorPp: pp(52), ac23Valid: true });
    expect(r.assignment!.primaryTopicAccuracy).toBe((PRIMARY - 52) / PRIMARY);
    if (r.section.status !== "available") throw new Error("expected available");
    expect(r.section.topics).toHaveLength(5);
  });
});

describe("taxonomy quality and matching", () => {
  it("a merged taxonomy gives one merge error and loses the absorbed concept", () => {
    const t = run("taxonomy-merged").taxonomy!;
    expect(t).toMatchObject({ predictedTopics: 7, matchedTopics: 7, topicPrecision: 1, conceptRecall: 7 / 8, mergeErrors: 1, splitErrors: 0 });
    expect(t.matches.find((m) => m.name === "battery and charging")).toMatchObject({ members: 42, goldKey: "range", jaccard: 0.667 });
    expect(run("taxonomy-merged").assignment!.primaryTopicAccuracy).toBe((PRIMARY - 14) / PRIMARY);
  });

  it("a split taxonomy gives one split error; the smaller part is unmatched and merged into OTHER", () => {
    const r = run("taxonomy-split");
    expect(r.taxonomy).toMatchObject({ predictedTopics: 9, matchedTopics: 8, conceptRecall: 1, mergeErrors: 0, splitErrors: 1 });
    expect(r.taxonomy!.matches.filter((m) => m.goldKey === null)).toEqual([expect.objectContaining({ name: "assist level settings", members: 9, jaccard: 0.375 })]);
    if (r.section.status !== "available") throw new Error("expected available");
    expect(r.section.other.mergedTopics.map((t) => [t.name, t.mentionCount])).toEqual([["assist level settings", 9], ["companion app", 6]]);
    expect(r.report).toMatchObject({ highOtherShareReported: true, highOtherShareCorrect: false });
  });

  it("matches by member-comment Jaccard only: names are ignored and ties go to the earlier gold concept", () => {
    const goldSets = [
      { key: "first", members: new Set(["a", "b", "c", "d"]) },
      { key: "second", members: new Set(["a", "b", "e", "f"]) },
    ];
    const matches = matchPredictedTopics(
      [
        { id: "topic:x", name: "second", members: new Set(["a", "b"]) },
        { id: "topic:y", name: "first", members: new Set(["e", "f", "g"]) },
        { id: "topic:z", name: "first", members: new Set(["c", "d", "e"]) },
      ],
      goldSets,
    );
    // x ties 0.5 / 0.5 → the earlier concept; y and z peak at 0.4 → unmatched, whatever their names say.
    expect(matches.map((m) => [m.topicId, m.goldKey, m.jaccard])).toEqual([
      ["topic:x", "first", 0.5],
      ["topic:y", null, 0.4],
      ["topic:z", null, 0.4],
    ]);
  });

  it("checks definitions structurally", () => {
    const texts = ["The hinge squeaks every single morning on my commute."];
    expect(definitionProblems("Folding", "How the bike folds and is carried.", texts)).toEqual([]);
    expect(definitionProblems("Folding", "  ", texts)).toEqual(["empty_definition"]);
    expect(definitionProblems("Folding", `${"x".repeat(201)}`, texts)).toEqual(["definition_too_long"]);
    expect(definitionProblems("Folding", "How it folds. How it is carried.", texts)).toEqual(["more_than_one_sentence"]);
    expect(definitionProblems("Folding", "Comments like: the hinge squeaks every single morning on my commute", texts)).toEqual(["copies_a_comment"]);
    expect(definitionProblems("Bad brakes", "How the bike stops.", texts)).toEqual(["sentiment_word_in_name"]);
  });
});

describe("retry semantics", () => {
  it("never exceeds two attempts or two calls per phase; feedback is structured and correct; nothing raw travels", () => {
    for (const s of report.scenarios) {
      for (const r of s.runs) {
        expect(r.attempts, s.id).toBeLessThanOrEqual(2);
        expect(r.retry, s.id).toMatchObject({ withinAttemptLimit: true, phaseCallsWithinLimit: true, feedbackSanitized: true, reportSanitized: true, diagnosticsMatch: true });
        if (r.attempts === 2) expect(r.retry, s.id).toMatchObject({ feedbackSent: true, feedbackCorrect: true });
        if (r.status === "unavailable") expect(r.retry.noPartialTopics, s.id).toBe(true);
        expect(JSON.stringify(r.phaseCalls), s.id).not.toContain(MALFORMED_MARKER);
      }
    }
  });

  it("taxonomy invalid → valid: rediscovery receives the taxonomy feedback; assignment runs once, without feedback", () => {
    const [first, second] = calls("taxonomy-invalid", "taxonomy");
    expect(first).toEqual({ phase: "taxonomy", attempt: 1, comments: B, failed: false });
    expect(second).toEqual({ phase: "taxonomy", attempt: 2, comments: B, failed: false, feedback: { attempt: 1, issues: [{ code: "duplicate_topic_name", count: 1, topicKeys: ["motor"] }] } });
    expect(calls("taxonomy-invalid", "assignment")).toEqual([{ phase: "assignment", attempt: 2, comments: B, failed: false }]);
    expect(perfectionFailures(run("taxonomy-invalid"))).toEqual([]);
  });

  it("assignment invalid → valid: only the affected comments are reassigned against the kept taxonomy", () => {
    const [, second] = calls("assignment-invalid", "assignment");
    expect(second!.comments).toBe(3);
    expect(second!.feedback).toEqual({ attempt: 1, issues: [{ code: "unknown_topic", count: 3, commentIds: expect.any(Array), topicKeys: [UNLISTED_TOPIC_KEY] }] });
    expect(calls("assignment-invalid", "taxonomy")).toHaveLength(1);
    expect(perfectionFailures(run("assignment-invalid"))).toEqual([]);
  });

  it("malformed → valid: everything is reassigned; the feedback carries the code only", () => {
    const [, second] = calls("retry-success", "assignment");
    expect(second).toEqual({ phase: "assignment", attempt: 2, comments: B, failed: false, feedback: { attempt: 1, issues: [{ code: "invalid_output", count: 1 }] } });
    expect(perfectionFailures(run("retry-success"))).toEqual([]);
  });

  it("invalid → invalid: TOPICS_UNAVAILABLE with both attempts' diagnostics and no partial topics", () => {
    const r = run("retry-failure");
    expect(r.section).toEqual(expect.objectContaining({ status: "unavailable", reason: "TOPICS_UNAVAILABLE", issues: [{ attempt: 1, code: "missing_definition", count: 1 }, { attempt: 2, code: "multiple_primary_topics", count: 1 }] }));
    expect(Object.keys(r.section).sort()).toEqual(["issues", "method", "reason", "status"]);
    expect(calls("retry-failure", "taxonomy")[1]!.feedback).toEqual({ attempt: 1, issues: [{ code: "missing_definition", count: 1, topicKeys: ["app"] }] });
    // The fresh assignment after rediscovery is a first assignment: no assignment feedback exists yet.
    expect(calls("retry-failure", "assignment")).toEqual([{ phase: "assignment", attempt: 2, comments: B, failed: false }]);
    expect(r.taxonomy).toBeNull();
    expect(r.assignment).toBeNull();
    expect(r.predictions).toBeNull();
  });
});

describe("AC-23 and reportability", () => {
  it("every available result partitions the topic base exactly", () => {
    for (const s of report.scenarios) {
      for (const r of s.runs) {
        if (r.section.status !== "available") continue;
        const { namedTopics, other, noSpecificTopic, sentimentBase, spamExcluded } = r.section.coverage;
        expect(namedTopics.count + other.count + noSpecificTopic.count, s.id).toBe(sentimentBase);
        expect([sentimentBase, spamExcluded], s.id).toEqual([B, 12]);
        expect(r.report!.ac23Valid, s.id).toBe(true);
        expect(r.report!.evidenceCoverage, s.id).toBe(1);
      }
    }
  });

  it("records the gold summary and the discovery sample methodology", () => {
    expect(report.gold).toMatchObject({ topicBase: B, spamExcluded: 12, minTopicSize: 10, dispositions: { primary_topic: PRIMARY, other: 22, no_specific_topic: 32 }, smallTopics: ["app"], topicSentimentDiffersFromOverall: DIVERGING, highOtherShare: false, shares: { named: 68, other: 15, noSpecificTopic: 17 } });
    const section = run("oracle").section;
    if (section.status !== "available") throw new Error("expected available");
    expect(section.method.discoverySample).toMatchObject({ version: "ds1", seed: "t1-topics-v1/ds1", eligible: B, size: B, usedAll: true });
  });
});

describe("repeatability and isolation", () => {
  it("every scenario repeats identically: taxonomy, assignments, report and retry behaviour", () => {
    for (const s of report.scenarios) {
      expect(s.repeatIdentical, s.id).toBe(true);
      expect(s.repeatConsistency, s.id).toBe(1);
      expect(s.runs[1]!.fingerprint, s.id).toBe(s.runs[0]!.fingerprint);
    }
  });

  it("a second benchmark run produces the same report", async () => {
    expect(await runTopicBenchmark(dataset)).toEqual(report);
  }, 120_000);

  it("the phase providers are deterministic and answer from gold only", async () => {
    const source = readFileSync("src/adapters/fakes/topic-benchmark-phases.ts", "utf8");
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date|fetch\(|process\./);
    const phaseGold: TopicPhaseGold = { taxonomy: dataset.taxonomy, dispositions: gold.dispositions, members: gold.members, overallSentiment: gold.overallSentiment };
    const spamId = dataset.comments.find((c) => c.topic === null)!.id;
    const context = { sentimentLabels: dataset.schema.sentimentLabels, maxTopics: 12 };
    await expect(new ScriptedTopicAssigner(phaseGold).assignTopics({ comments: [{ id: spamId, text: "x" }], taxonomy: [], context })).rejects.toThrow(RangeError);
    expect(new OracleTaxonomyGenerator(phaseGold).label).toBe("Oracle taxonomy generator (gold)");
    expect(new OracleTopicAssigner(phaseGold).label).toBe("Oracle topic assigner (gold)");
  });

  it("renders a markdown summary with the gate result and one row per scenario", () => {
    const md = renderTopicBenchmarkMarkdown(report);
    expect(md).toContain("Oracle gate: PASSED");
    for (const id of TOPIC_SCENARIO_IDS) expect(md).toContain(`| ${id} |`);
    expect(md).not.toContain("NOT MET");
  });
});
