# Audit: zero-example discovery taxonomies

**Type:** read-only diagnosis, made on 2026-10-07 from `main` at `1b54e786d0730dee69fd571702a5d46f66af4bba`.
- No API or provider call was made, and no benchmark was run.
- No code, contract, validator, evaluator, artifact or preregistration was changed.
- Nothing in the completed `discovery-v3-name-robustness-v1` experiment is re-scored or reinterpreted. Its FAIL verdict and its v2/v3 means stand as recorded.
- Every number below comes from:
  - the 122 files in `benchmark-results/`;
  - the source code;
  - a deterministic local probe of the frozen validator and schema helpers (§4.2);
  - the existing offline tests.

## 1. Observed evidence

**Definition.** A *zero-example taxonomy* is a discovery taxonomy that was **accepted** by the validator although **every** topic has an empty `exampleCommentIds`.

**Across all archived artifacts, exactly 4 accepted discovery taxonomies are zero-example.** All four used `topic-discovery-v2` on `claude-sonnet-5-5`:

| # | Artifact | Dataset | Context | Discovery attempts | Topics | With examples |
|---|---|---|---|---|---|---|
| 1 | `2026-10-06T13-58-40-845Z-…-t4-topics-v1-paired-consolidation-…-pair-1.json` | t4 | paired smoke test (archived in `5a9e710`) | 1, valid first | 11 | **0** |
| 2 | `2026-10-06T17-47-07-887Z-…-run-27-topic-discovery-v2.json` | t5 | reliability run 27 | `invalid_topic_name`, then valid | 12 | **0** |
| 3 | `2026-10-06T18-00-37-260Z-…-run-32-topic-discovery-v2.json` | t5 | reliability run 32 | 1, valid first | 12 | **0** |
| 4 | `2026-10-06T18-18-27-849Z-…-run-40-topic-discovery-v2.json` | t5 | reliability run 40 | 1, valid first | 12 | **0** |

Case 1 is new to this audit. The problem is **not** confined to t5 or to the reliability experiment: a zero-example v2 taxonomy also occurred on t4, in the paired smoke test.

**Model outputs that omit the field entirely.** Two *rejected* v2/t5 responses are kept as raw output. Neither contains an `exampleCommentIds` field on any topic:
- **Run 11, attempt 1:** 12 topics, each with only `key`, `name` and `definition`. It was rejected for `invalid_topic_name`.
- **Run 27, attempt 1:** 12 topics, likewise without the field. It was rejected for `invalid_topic_name`.

The run-27 retry was then accepted with 0 examples (case 2). The run-11 retry was accepted with 3 examples on every topic.

**All-or-nothing per response.** No recorded taxonomy, accepted or rejected, has a mix of topics with and without examples. Every taxonomy either cites examples on all topics or on none. This points to a per-response choice by the model to fill in or skip the optional field, not to topics the model could not find evidence for.

## 2. Exact affected runs and artifacts

| Location in the artifact | Zero-example items |
|---|---|
| **Reliability runs 27, 32, 40** | `result.runs[0].taxonomy`: `topicsWithExamples` = 0, every `matches[].examples` = 0, `topicPrecision` = `conceptRecall` = 0 |
| **t4 paired smoke, discovery** | `discovery.taxonomy[]`: 11 topics with `"exampleCommentIds": []` |
| **t4 paired smoke, both consolidation arms** | `arms[].result.instrumentation…candidate.topics[]`: 22 topics with 0 examples. `…consolidationAttempts[].outputTopics[]` and `…provenance.finalTopics[]`: 21 topics with 0 examples, every one with `material: "unanchored"` |
| **t4 paired smoke, real path** | `arms[].result.report.scenarios[real-…].runs[].fingerprint` → `topics[].formation.providerExampleIds`: 21 final topics (11 for consolidation v3, 10 for v4) with 0 examples. All 63 evidence selections are `"fallback"` (33 for v3, 30 for v4); none is `provider_example` |

The paired smoke file's oracle scenarios have examples on all 18 of their topics. Those come from the deterministic fake, not the model.

## 3. Current contract behaviour

**Prompt** (`topic-discovery-v2`, `src/core/topics/provider-contracts.ts:127`):
> `exampleCommentIds (optional): up to 3 ids of sample comments that clearly belong to the topic, copied exactly from the data.`

The output template does show the field, but the prompt explicitly calls it **optional**.

**Output schema** (`topicDiscoveryOutputSchema`, lines 228–250):
- `required: ["key", "name", "definition"]`. **`exampleCommentIds` is not required.**
- The field is declared as `{ type: "array", maxItems: 3, items: { type: "string" } }`, with **no `minItems`**.

**Schema actually sent to each provider** (confirmed by the local probe):

| Provider | Schema sent for `exampleCommentIds` | Effect |
|---|---|---|
| **Anthropic** (`toAnthropicOutputSchema`) | `{ type: "array", items: { type: "string" } }`. `maxItems` is removed, because `minItems` and `maxItems` are in `UNSUPPORTED_SCHEMA_KEYWORDS`. | Structured output can omit the field, return `[]`, or return more than 3 IDs. |
| **Gemini** (`toGeminiResponseSchema`) | keeps `maxItems: 3` | The field is still optional. |

**v3** (`topic-discovery-v3`) changes only the name-format guidance and the retry feedback. Its example wording, schema and validator are identical to v2's; this is pinned in `tests/unit/topic-discovery-v3-contract.test.ts` and stated in the preregistration §2.

**Written specifications disagree with each other:**
- **`spec.md` §7.3 (line 554):** the discovery output is described as `example_comment_ids: [ids from the sample, 2–5]`.
- **`spec.md` AC-21 (line 1098):** it only requires that "all example IDs exist in the discovery sample". It sets no minimum.
- **`topic-provider-contracts-v1.md`:** it marks `exampleCommentIds` as **not required** and "at most 3 requested" (line 69), with 3 per topic described as "requested" (line 167).
- **`m4-topic-provider-design.md`:** it says "optional, from the sample only (spec suggests 2–5)" (line 91).

So the **implemented contract relaxed** the spec's "2–5" into "optional, up to 3". The documents do not record why. The acceptance criterion never required a minimum.

## 4. Validator behaviour

### 4.1 Code

`validateTopicTaxonomy` (`src/core/topics/taxonomy.ts:47–83`) handles examples as follows:
- `exampleCommentIds: z.array(z.string()).optional()`, which defaults to `[]` (lines 19 and 61).
- **Each ID must be in the discovery sample.** Any other ID gives `unknown_example_comment`, and the whole taxonomy is rejected (line 75).
- **Duplicate IDs inside a topic are silently de-duplicated**, not rejected (line 76).
- **There is no minimum and no maximum count.** Nothing checks the number of examples, or whether the same ID is cited by more than one topic.

The final attempt validator, `validateTopicAttempt` and its parser in `src/core/topics/validation.ts:15–20 and 93–97`, applies the same rules.

### 4.2 Deterministic probe

This was run locally against the frozen code. It made no API call and wrote no file into the repository.

| Input | Result |
|---|---|
| field omitted on every topic | **valid**, stored as `[]` on every topic |
| `[]` on every topic | **valid** |
| one example | **valid** |
| duplicate IDs `["s1","s1","s1"]` | **valid**, stored as `["s1"]` |
| 4 examples (above the requested 3) | **valid**, all 4 kept |
| the same ID in two topics | **valid** |
| an ID not in the sample | invalid: `unknown_example_comment` |
| an empty-string ID | invalid: `unknown_example_comment` |

**Answers:**
- The validator **accepts** zero examples, one example and duplicate IDs (de-duplicated), as well as more than 3 examples.
- It **rejects** only invalid IDs.

## 5. Historical prevalence (t1–t5)

**Accepted discovery taxonomies with example data in the artifacts:**

| Source | Accepted discovery taxonomies | Zero-example | Partly zero | Topics with 1 example | Topics with 2 examples |
|---|---|---|---|---|---|
| t1 discovery-only, Anthropic (2 runs on v1, 1 on v2) | 3 | 0 | 0 | 0 | 1 |
| t1 discovery-consolidated, Anthropic | 3 | 0 | 0 | 0 | 0 |
| t3 real-consolidated (instrumented candidates) | 3 | 0 | 0 | 0 | 0 |
| t4 real-consolidated, consolidation v3 (instrumented) | 3 | 0 | 0 | 0 | 0 |
| t4 real-consolidated, consolidation v4 (instrumented) | 2 | 0 | 0 | 0 | 1 |
| t4 paired smoke (v2) | 1 | **1** | 0 | 0 | 0 |
| t5 paired, pairs 1 and 3 (v2) | 2 | 0 | 0 | 0 | 0 |
| reliability t4 / v2 | 10 | 0 | 0 | 0 | 1 |
| reliability t4 / v3 | 10 | 0 | 0 | 0 | 2 |
| reliability t5 / v2 (9 valid; run 8 ended invalid) | 9 | **3** | 0 | 0 | 0 |
| reliability t5 / v3 | 10 | 0 | 0 | 0 | 0 |
| **Total** | **56** | **4** | **0** | **0** | **5** |

**Earlier real runs.** The t1 runs (Anthropic, Gemini 3.7, Gemini 3.8) and the t1/t2/t3/t4 real-consolidated runs record only the *final* topics' `providerExampleIds`. That gives 355 final-topic records. They include the deterministic oracle scenarios, which the report does not separate here. Every one has exactly 3 examples, and none has 0, 1 or 2.

**Rejected raw outputs.** 19 rejected discovery responses are kept as raw output: all 18 rejected attempts of the reliability experiment and one from the t5 paired experiment.
- Two responses have **no example field at all**: run 11 and run 27, attempt 1 of each, both v2 on t5.
- One-example topics appear only in rejected outputs: run 1 has one, and run 30 has one.

**Integrity of every recorded example ID list,** checked across the explicit ID lists in t3, t4 and t5, all final-topic `providerExampleIds`, and every parsable rejected output:
- **0** duplicate IDs within a list;
- **0** IDs that are not comments of the dataset (checked against `fixtures/tN-topics-v1/comments.json`);
- **0** empty-string IDs.

The validator already rejects IDs outside the sample, so invalid IDs cannot reach an accepted taxonomy.

**One other integrity finding, at the consolidation stage rather than discovery.** In the t1 discovery-consolidated run of 2026-10-06T01:48 (consolidation v3), two consolidated topics have **4 examples**: `folding_mechanism` and `build_durability_service`. That exceeds the requested maximum of 3. This happens because Anthropic structured output drops `maxItems` and the validator has no maximum. It has no effect on the results, but it confirms that the requested maximum is not enforced either.

**Zero-example rate by group:**

| Group | Zero-example rate |
|---|---|
| v2, all contexts | 4 of 34 accepted taxonomies (11.8%) |
| v2 on t5 | 3 of 11 |
| v2 on t4 | 1 of 16 |
| v2 on t1 / t3 | 0 of 7 |
| v3 | 0 of 20 |
| v1 | 0 of 2 (the two earliest t1 discovery-only runs) |

In these groups, "v2" covers every recorded discovery made with the v2 discovery contract, including the t1/t3/t4 instrumented runs, the paired runs and the reliability runs. The contract of each run was read from its `meta`.

## 6. Downstream impact

| Consumer | Uses examples? | Effect of zero examples |
|---|---|---|
| **Assignment (Jev / `topic-assignment-v1`)** | **No.** `buildTopicAssignmentData` sends only `key`, `name` and `definition` (`provider-contracts.ts:319`). | None, as the t4 paired smoke test shows. With a zero-example taxonomy, the real path still finished (`status: available`) with primary-topic accuracy of 93.3% (consolidation v3) and 94.8% (consolidation v4). |
| **Report evidence** (`selectTopicEvidence`, `evidence.ts:11–34`; used in `aggregate-topics.ts:163`) | **Tie-break only**, after topic-sentiment grouping and confidence and before comment ID | Evidence is still chosen deterministically, but never from the model's cited examples. In the t4 smoke test all 63 selections were `fallback`. |
| **Consolidation** (`consolidation-contract.ts:73–75`) | **Yes, structurally.** A consolidated topic may cite only its candidates' example IDs. | With no candidate examples, every consolidated topic is `unanchored`. Diagnostics cannot trace which candidates were kept, merged or dropped (fate `unknown`), and candidate coverage is undefined (`topic-discovery-consolidated.ts:118–160`, `topic-consolidated-diagnostics.ts:115–127`). |
| **Discovery-only proxy evaluator** (`evaluateDiscoveredTaxonomy`, `topic-discovery-only.ts:30, 125–160`) | **Yes, entirely.** Topics are matched by the majority gold label of their examples, and "topics without examples match nothing" (line 30). | Precision = recall = 0, whatever the quality of the names and definitions. This produced the zeros in reliability runs 27, 32 and 40. |
| **Real-path evaluator** (assignment and report metrics) | No | Unaffected. |
| **Product, web app** | No | Not on this path: `src/app` and `src/adapters` do not consume discovery examples. |

**Answers:**
- **Q4:** assignment does not require examples, and does not even receive them.
- **Q5:** examples are operationally required **nowhere** in production assignment. They matter for:
  - evaluation (the proxy metric);
  - consolidation provenance and traceability;
  - preferring a model-cited comment as report evidence.

## 7. Root-cause assessment

1. **The model chooses to leave out examples.** Sometimes, on its own initiative, `claude-sonnet-5-5` under v2 emits the whole taxonomy without examples. In two kept raw outputs (runs 11 and 27) the field is missing altogether. The behaviour applies to the whole response at once (§1), and recurs on t5: about 5 of the 14 v2/t5 responses lacked examples (runs 11 and 27 attempt 1, and the accepted taxonomies of runs 27, 32 and 40). It also happened once on t4 (the paired smoke test).
2. **The contract makes omission legitimate.** The prompt calls the field *optional*, and the schema does not require it. Structured output therefore allows omission, and the validator accepts it. Nothing in the pipeline turns "no evidence" into an error or a retry.
3. **The proxy evaluator's design** turns a valid but example-free taxonomy into 0/0 scores. That is a property of the metric, not a malfunction.

## 8. Contract gap, model behaviour, or both?

**Both.**
- **Model behaviour is the trigger.** The model leaves out an optional field.
- **The contract and validator are the enabling gap.** They define an example-free taxonomy as valid, contrary to the spec's original "2–5" description.

**Is it specific to v2 or to t5?**
- It is not specific to t5: it happened on t4.
- It is so far observed only under v2.

**Does v3 prevent it?** There is no evidence that it does; its absence in v3 is observational.
- v3 did not change the example wording, schema or validation.
- The difference is 0 of 20 accepted v3 taxonomies versus 3 of 19 v2 taxonomies in the same experiment.
- Under random allocation, a 3–0 split this extreme happens with probability about 0.11 (Fisher exact, one-sided; about 0.09 on t5 alone).
- So the difference is not statistically established. v3's different first-attempt instructions might change the model's tendency, but this audit cannot show that.

## 9. Recommendation for a future v4

**Future work, not implemented here.** v4 should **require evidence**: make zero examples a validation failure.

What v4 would need:
- **Prompt and schema:** make `exampleCommentIds` required, with at least 1 item. Optionally ask for at least 2, to match the spec's "2–5".
- **Validator:** a new taxonomy issue code, for example `missing_examples`. It must be a *taxonomy* code so that `retryScope` sends the retry to rediscovery.
- **Anthropic:** structured output drops `minItems`, so the minimum must be enforced by the validator, not by the schema.

**This is not a pure validation change.** It would affect:
- **Retry:** taxonomies that are valid today would be rejected and retried. That changes the retry rate, cost and the eventual-validity baseline.
- **Feedback and contract documents:** a new issue code needs retry-feedback text, a contract version bump, updated fingerprints and new pinned tests.
- **Comparability with past results:** v2 and v3 history would not be comparable on validity metrics without noting the extra rule.
- **Assignment and the real evaluator:** unaffected, since neither uses examples.
- **The proxy evaluator:** zero-example 0/0 runs would disappear because they would become rejections, which moves the effect from the precision/recall metrics to the validity metrics. A v4 preregistration must say so up front.

**Requirements for that preregistration:**
- Report a "zero-example taxonomy rate" as its own metric, separate from precision and recall.
- Decide the minimum count (1, 2 or 3) before any run.
- Decide whether a maximum of 3 should also be enforced, given §5's 4-example consolidated topics.

## 10. Deterministic tests that should exist

These are useful whatever is decided for v4; none is added in this audit.

**Gaps in the current tests:**
- `tests/unit/topic-taxonomy.test.ts` covers only:
  - a topic without examples, inside an otherwise normal taxonomy, accepted;
  - de-duplication of IDs inside a topic;
  - unknown IDs, rejected.
- `tests/benchmark/topic-discovery-only.test.ts` scores a single example-less topic as unmatched.
- `tests/adapters/anthropic-topic-transport.test.ts` checks that `maxItems` is removed in general.

**Tests to add:**
1. **Pin the current behaviour (characterisation):**
   - a taxonomy in which *every* topic omits `exampleCommentIds` is valid;
   - a taxonomy in which every topic has `[]` is valid;
   - more than 3 examples are kept;
   - the same ID cited by two topics is accepted.

   Any future rule change would then show up as a deliberate test change.
2. **Evaluator:** an all-zero-example taxonomy gives `topicsWithExamples` = 0, precision 0 and recall 0. This pins the proxy's documented behaviour as a whole-taxonomy case.
3. **Contract schema:** `exampleCommentIds` is absent from `required` and has no `minItems`, for both v2 and v3. Also, the Anthropic-sent schema has no `maxItems` for `exampleCommentIds` specifically.
4. **Assignment independence:** `buildTopicAssignmentData` output contains no example IDs. This guards the finding that assignment does not depend on examples.
5. **Consolidation with zero candidate examples:** every output topic is `unanchored`, and candidate fates are `unknown`.

## 11. Limitations

- **Accepted raw outputs are not stored.** Only *rejected* responses keep raw text. For accepted cases 2, 3 and 4 it cannot be told whether the model omitted the field or returned `[]`; the validator stores both as `[]`. Field omission is proven only for the rejected attempts of runs 11 and 27.
- **Small samples.** There are 4 cases among 56 recorded accepted discovery taxonomies, so rates are rough. The v2 vs v3 difference is not statistically significant (§8).
- **Older runs record only final topics.** The t1–t4 real runs keep final topics, not discovery taxonomies. Their zero count (0 of 355 final-topic records, oracle scenarios included) covers only what survived to the report.
- **One model and one provider.** All the evidence is `claude-sonnet-5-5` with effort `high`. The single Gemini discovery-only run on t1 failed with provider errors and recorded no taxonomy.
- **Membership checks use the dataset, not the sample.** ID validity in old artifacts was checked against each dataset's comments, not the exact discovery sample. The validator had already enforced sample membership for every accepted taxonomy.
- **No new data.** There were no API calls, so the model's tendency could not be tested, for example by repeat sampling or prompt variants.

## Inputs inspected

**Code:**
- `src/core/topics/`: `taxonomy.ts`, `validation.ts`, `provider-contracts.ts`, `consolidation-contract.ts`, `evidence.ts`, `aggregate-topics.ts`, `types.ts`, `topic-result.ts`;
- `src/application/contract-topic-phases.ts`;
- `src/adapters/ai/anthropic/anthropic-topic-transport.ts`;
- `src/adapters/ai/google/gemini-topic-transport.ts`;
- `src/benchmark/`: `topic-discovery-only.ts`, `topic-discovery-consolidated.ts`, `topic-consolidated-diagnostics.ts`, `topic-paired-consolidation.ts`, `topic-real-consolidated.ts`, `topic-benchmark.ts`, `topic-datasets.ts`;
- `src/adapters/fakes/topic-benchmark-phases.ts`.

**Specifications:** `spec.md` (§7.3, S5, AC-21), `topic-provider-contracts-v1.md`, `m4-topic-provider-design.md`, and `docs/topic-discovery-v3-reliability-preregistration.md`.

**Artifacts:** all 122 files in `benchmark-results/`, including:
- the 80 discovery-v3 reliability files;
- the t1–t5 real, real-consolidated, discovery-only, discovery-consolidated and paired files;
- the Jev files, which hold no taxonomies.

Also the fixtures `fixtures/t1…t5-topics-v1/comments.json`.

**Tests:**
- `tests/unit/`: `topic-taxonomy`, `topic-discovery-validation`, `topic-provider-contracts`, `topic-discovery-v3-contract`, `topic-result`, `topic-aggregation`, `topic-consolidation-contract`;
- `tests/benchmark/`: `topic-discovery-only`, `topic-discovery-reliability`, `topic-discovery-consolidated`;
- `tests/adapters/`: `anthropic-topic-transport`, `gemini-topic-transport`.

These 12 files pass: 273 tests, offline.
