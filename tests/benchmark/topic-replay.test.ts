import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ReplayTopicTransport } from "../../src/adapters/replay/replay-topic-transport";
import { analyzeTopics } from "../../src/application/analyze-topics";
import { ContractTopicAssigner, ContractTopicTaxonomyGenerator } from "../../src/application/contract-topic-phases";
import { TwoPhaseTopicDiscoverer } from "../../src/application/two-phase-topic-discoverer";
import { perfectionFailures, TOPIC_BENCHMARK_PARAMETERS, TOPIC_BENCHMARK_SEED, type TopicBenchmarkReport } from "../../src/benchmark/topic-benchmark";
import { classifiedCommentsOf, goldOf, loadTopicBenchmarkDataset } from "../../src/benchmark/topic-datasets";
import { loadTopicReplayResponses, REPLAY_FIXTURE_DIR, runTopicReplayBenchmark, TOPIC_REPLAY_SCENARIO_IDS } from "../../src/benchmark/topic-replay";
import type { TopicModelRequest } from "../../src/core/topics/provider-contracts";
import { buildReplayResponses, HALLUCINATED_KEY, REPLAY_TAXONOMY } from "../topics-benchmark/replay-fixtures";

// Replay benchmark: recorded raw model responses through the topic-discovery-v1 / topic-assignment-v1 contracts,
// the replay transport and the complete production pipeline, scored by the frozen t1-topics-v1 harness.

const ROOT = join(__dirname, "..", "..");
const dataset = loadTopicBenchmarkDataset("t1-topics-v1");
const gold = goldOf(dataset);
const B = gold.baseIds.length;
const responses = loadTopicReplayResponses(dataset);
let report: TopicBenchmarkReport;
beforeAll(async () => {
  report = await runTopicReplayBenchmark(dataset);
}, 120_000);

const scenario = (id: string) => report.scenarios.find((s) => s.id === id)!;
const run = (id: string) => scenario(id).runs[0]!;
const calls = (id: string, phase: "taxonomy" | "assignment") => run(id).phaseCalls.filter((c) => c.phase === phase);

/** Runs one replay script through analyzeTopics directly, keeping the transport to inspect the rendered requests. */
async function replay(taxonomy: string[], assignment: string[]) {
  const transport = new ReplayTopicTransport({ taxonomy_discovery: taxonomy.map((n) => responses.get(n)!.raw), comment_assignment: assignment.map((n) => responses.get(n)!.raw) });
  const discoverer = new TwoPhaseTopicDiscoverer({ generator: new ContractTopicTaxonomyGenerator(transport), assigner: new ContractTopicAssigner(transport), sample: { seed: TOPIC_BENCHMARK_SEED } });
  const analysis = await analyzeTopics({ classified: classifiedCommentsOf(dataset), schema: dataset.schema, focus: dataset.focus }, { discoverer, params: TOPIC_BENCHMARK_PARAMETERS });
  return { analysis, transport };
}
const payloadOf = (r: TopicModelRequest) => JSON.parse(r.data.split("\n")[2]!) as { comments: { id: string; text: string }[]; retry_feedback?: unknown; taxonomy?: unknown };

describe("replay fixtures", () => {
  it("are byte-identical to their manifest hashes, recorded for the current contracts and reproducible from gold", () => {
    const built = buildReplayResponses(dataset);
    expect([...responses.keys()]).toEqual(built.map((r) => r.id));
    for (const r of built) {
      expect(responses.get(r.id)!.raw, r.id).toBe(r.raw);
      expect(responses.get(r.id)!.phase, r.id).toBe(r.phase);
    }
    expect(new Set([...responses.values()].map((r) => r.contract))).toEqual(new Set(["topic-discovery-v1", "topic-assignment-v1"]));
  });

  it("cover every required response kind and contain no comment text", () => {
    for (const id of ["taxonomy-perfect", "assignment-perfect", "taxonomy-missing-definition", "taxonomy-duplicate-name", "assignment-unknown-topic", "assignment-missing-comment", "assignment-wrong-sentiment", "taxonomy-malformed-prose", "assignment-malformed-truncated", "assignment-malformed-fenced", "assignment-unknown-topic-retry", "assignment-missing-comment-retry"]) {
      expect(responses.has(id), id).toBe(true);
    }
    const all = [...responses.values()].map((r) => r.raw).join("\n");
    for (const c of dataset.comments) if (c.text.length >= 12) expect(all.includes(c.text), c.id).toBe(false);
    const manifest = JSON.parse(readFileSync(join(REPLAY_FIXTURE_DIR["t1-topics-v1"], "manifest.json"), "utf8")) as { datasetVersion: string };
    expect(manifest.datasetVersion).toBe(dataset.version);
  });
});

describe("replay benchmark", () => {
  it("runs the oracle gate first and every replay scenario meets its expectation, identically on repeat", () => {
    expect(report.scenarios.map((s) => s.id)).toEqual(["oracle", ...TOPIC_REPLAY_SCENARIO_IDS]);
    expect(report.oracleGate.passed).toBe(true);
    for (const s of report.scenarios) {
      expect(s.expectationFailures, s.id).toEqual([]);
      expect(s.repeatIdentical, s.id).toBe(true);
      expect(s.runs[0]!.retry, s.id).toMatchObject({ withinAttemptLimit: true, phaseCallsWithinLimit: true, feedbackSanitized: true, reportSanitized: true, diagnosticsMatch: true });
    }
  });

  it("A. perfect replay: 100% on every metric with zero retries, although the model chose its own names and keys", () => {
    const r = run("replay-perfect");
    expect(perfectionFailures(r)).toEqual([]);
    expect(r.attempts).toBe(1);
    if (r.section.status !== "available") throw new Error("expected available");
    expect(r.section.topics.map((t) => t.name)).toEqual(["battery range", "pedal assist and motor", "folding and portability", "comfort", "charging", "cost and value", "braking"]);
    expect(r.section.other.mergedTopics.map((t) => t.name)).toEqual(["phone app"]);
  });

  it("B. taxonomy retry: the duplicate name is caught, the second discovery receives the feedback, assignment runs once", () => {
    expect(calls("replay-taxonomy-retry", "taxonomy").map((c) => c.feedback)).toEqual([undefined, { attempt: 1, issues: [{ code: "duplicate_topic_name", count: 1, topicKeys: ["range_per_charge"] }] }]);
    expect(calls("replay-taxonomy-retry", "assignment")).toEqual([{ phase: "assignment", attempt: 2, comments: B, failed: false }]);
    expect(calls("replay-malformed-taxonomy-retry", "taxonomy")[1]!.feedback).toEqual({ attempt: 1, issues: [{ code: "invalid_output", count: 1 }] });
    expect(perfectionFailures(run("replay-malformed-taxonomy-retry"))).toEqual([]);
  });

  it("C. assignment retry: the taxonomy is reused and only the affected comments are asked again", () => {
    expect(calls("replay-assignment-retry", "taxonomy")).toHaveLength(1);
    const [, second] = calls("replay-assignment-retry", "assignment");
    expect(second).toMatchObject({ attempt: 2, comments: 3, feedback: { attempt: 1, issues: [{ code: "unknown_topic", count: 3, topicKeys: [HALLUCINATED_KEY] }] } });
    expect(calls("replay-missing-comment-retry", "assignment")[1]).toMatchObject({ comments: 2, feedback: { issues: [{ code: "missing_assignment", count: 2, commentIds: [gold.baseIds[4], gold.baseIds[90]] }] } });
    expect(perfectionFailures(run("replay-assignment-retry"))).toEqual([]);
    expect(perfectionFailures(run("replay-missing-comment-retry"))).toEqual([]);
  });

  it("D. persistent failure: TOPICS_UNAVAILABLE with both attempts' diagnostics and no partial topics", () => {
    expect(run("replay-persistent-taxonomy-failure").section).toEqual(expect.objectContaining({ status: "unavailable", issues: [{ attempt: 1, code: "missing_definition", count: 1 }, { attempt: 2, code: "missing_definition", count: 1 }] }));
    expect(run("replay-persistent-malformed-assignment").section).toEqual(expect.objectContaining({ status: "unavailable", issues: [{ attempt: 1, code: "invalid_output", count: 1 }, { attempt: 2, code: "invalid_output", count: 1 }] }));
    for (const id of ["replay-persistent-taxonomy-failure", "replay-persistent-malformed-assignment"]) {
      expect(Object.keys(run(id).section).sort(), id).toEqual(["issues", "method", "reason", "status"]);
      expect(run(id).retry.noPartialTopics, id).toBe(true);
    }
  });

  it("E. topic sentiment copied from overall sentiment is detected by the metrics", () => {
    const a = run("replay-topic-sentiment-corruption").assignment!;
    expect(a.topicSentimentAccuracy).toBe(117 / 134);
    expect(a.topicSentimentAccuracy).toBe(a.overallSentimentAgreement);
    expect(a.dispositionAccuracy).toBe(1);
  });

  it("F. instruction-like comments keep their gold disposition in a faithful replay; an obeying replay is detected", () => {
    const hostile = dataset.comments.filter((c) => c.tags.some((t) => ["prompt_injection", "html_script", "fake_json"].includes(t)));
    expect(hostile.length).toBe(6);
    const predictions = run("replay-perfect").predictions!;
    for (const c of hostile) {
      const g = gold.dispositions.get(c.id)!;
      expect(predictions[c.id]!.split(":")[0], c.id).toBe(g.disposition);
    }
    const obeyed = run("replay-injection-obeyed");
    expect(obeyed.assignment).toMatchObject({ dispositionAccuracy: (B - 2) / B, primaryTopicAccuracy: 133 / 134 });
    expect(perfectionFailures(obeyed).length).toBeGreaterThan(0);
  });
});

describe("rendered requests in a replayed analysis", () => {
  it("send hostile comments only as data, unchanged; never labels, spam or raw previous output", async () => {
    const { analysis, transport } = await replay(["taxonomy-duplicate-name", "taxonomy-perfect"], ["assignment-perfect"]);
    expect(analysis.status).toBe("available");
    const hostile = dataset.comments.filter((c) => c.tags.some((t) => ["prompt_injection", "html_script", "fake_json"].includes(t)));
    const spamIds = new Set(dataset.comments.filter((c) => c.topic === null).map((c) => c.id));
    for (const request of transport.requests) {
      for (const c of hostile) expect(request.instructions, c.id).not.toContain(c.text);
      const comments = payloadOf(request).comments;
      expect(comments.map((c) => Object.keys(c).sort().join())).toEqual(Array(B).fill("id,text"));
      expect(comments.some((c) => spamIds.has(c.id))).toBe(false);
      for (const c of hostile) expect(comments.find((x) => x.id === c.id)!.text, c.id).toBe(c.text);
    }
    // The second discovery request carries structured feedback only: not the rejected taxonomy's text.
    const second = transport.requestsFor("taxonomy_discovery")[1]!;
    expect(payloadOf(second).retry_feedback).toEqual({ attempt: 1, issues: [{ code: "duplicate_topic_name", count: 1, topicKeys: ["range_per_charge"] }] });
    expect(second.data).not.toContain("How many kilometres riders get from one full charge.");
    expect(second.data).not.toContain("Battery Range");
    // Assignment sees the validated taxonomy: provider keys, normalised names and definitions.
    expect(payloadOf(transport.requestsFor("comment_assignment")[0]!).taxonomy).toEqual(
      dataset.taxonomy.map((t) => ({ key: REPLAY_TAXONOMY[t.key]!.key, name: REPLAY_TAXONOMY[t.key]!.name.toLowerCase(), definition: REPLAY_TAXONOMY[t.key]!.definition })),
    );
  });

  it("reuse the taxonomy on an assignment retry and ask only for the affected comments", async () => {
    const { analysis, transport } = await replay(["taxonomy-perfect"], ["assignment-unknown-topic", "assignment-unknown-topic-retry"]);
    expect(analysis.status).toBe("available");
    const [first, second] = transport.requestsFor("comment_assignment");
    expect(payloadOf(second!).taxonomy).toEqual(payloadOf(first!).taxonomy);
    expect(payloadOf(second!).comments.map((c) => c.id)).toEqual((second!.feedback!.issues[0]!.commentIds ?? []));
    expect(second!.instructions).toContain("RETRY: your previous assignment was rejected");
  });
});

describe("replay CLI", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const RESULTS = join(ROOT, "benchmark-results");
  const cli = (args: string[]) => {
    const before = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
    const out = spawnSync(TSX, ["src/benchmark/topics-cli.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(existsSync(RESULTS) ? readdirSync(RESULTS).sort() : []).toEqual(before);
    return { status: out.status, text: `${out.stdout}${out.stderr}` };
  };

  it("runs the oracle and the selected replay scenarios offline", () => {
    const { status, text } = cli(["--suite", "replay", "--scenario", "replay-perfect,replay-persistent-taxonomy-failure"]);
    expect(text).toContain("Oracle gate: PASSED");
    const rows = text.split("\n").filter((l) => /^\| [a-z-]+ \| (available|unavailable) /.test(l)).map((l) => l.split(" | ")[0]!.slice(2));
    expect(rows).toEqual(["oracle", "replay-perfect", "replay-persistent-taxonomy-failure"]);
    expect(status).toBe(0);
  }, 60_000);

  it("rejects unknown suites and core scenario ids in the replay suite", () => {
    expect(cli(["--suite", "live"])).toMatchObject({ status: 1, text: expect.stringContaining('Unknown suite "live"') });
    expect(cli(["--suite", "replay", "--scenario", "oracle"])).toMatchObject({ status: 1, text: expect.stringContaining("Unknown scenario(s) oracle") });
  }, 60_000);
});
