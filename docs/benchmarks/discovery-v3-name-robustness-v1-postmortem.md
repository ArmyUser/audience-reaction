# Postmortem: discovery-v3 name-robustness reliability experiment

**Type:** an artifact-only analysis.
- No API call was made, and no run was added, replaced or repeated.
- No code, prompt, contract, validator, evaluator, scheduler, dataset, preregistration or result file was changed.
- The binding verdict comes from the registered offline evaluator, which made no API calls and exited with code 1 (FAIL):
  ```bash
  npx tsx src/benchmark/discovery-reliability-cli.ts --check
  ```

## 1. Experiment identity

| Item | Value |
|---|---|
| Experiment | `discovery-v3-name-robustness-v1` |
| Definition fingerprint | `sha256:17aa3db369cc0ae836655e01132d2144f6f5f7cf4b19de88117b9075b2dda4fe` |
| Preregistration | `docs/topic-discovery-v3-reliability-preregistration.md` |
| Definition | `DISCOVERY_RELIABILITY_EXPERIMENT` in `src/benchmark/topic-discovery-reliability.ts` |
| Runner | `src/benchmark/discovery-reliability-cli.ts`, run 40 times as `--live --next-run-only` |
| Commit during every run | `e8a2fd3deccbee06852b5af650447aa22907930d` |
| Contracts | `topic-discovery-v2` (baseline) vs `topic-discovery-v3` (candidate) |
| Datasets | `t4-topics-v1` (SHA-256 `58e225f9…2043292fd`); `t5-topics-v1` (SHA-256 `cec6e656…9a2cc3`) |
| Provider / model / effort | Anthropic / `claude-sonnet-5-5` / `high`; every response was served by `claude-sonnet-5-5` |
| Retry policy | the production retry: at most 2 attempts, the second with structured feedback |
| Scope | discovery only; no consolidation, no Jev (every result records `assignment: "not run"`) |
| Live window | 2026-10-06, 16:53:39 to 18:18:27 UTC (run-1 reservation to run-40 result) |

## 2. Preregistered criteria

These were fixed in §6 of the preregistration before the first run.
- Comparisons use unrounded values, with a 1e-9 tolerance.
- Metrics are pooled over t4 and t5, per contract.

1. v3 eventual validity is at least 99%.
2. v3 first-attempt validity is at least 95%.
3. The v3 `invalid_topic_name` rate is at most 1%, per attempt that received a response.
4. No regression in proxy precision: the v3 mean is at least the v2 mean.
5. No regression in proxy recall: the v3 mean is at least the v2 mean.
6. No new schema failure mode: every v3 rejection code other than `invalid_topic_name` was also seen in v2.

Under §7, PASS requires all 40 runs evaluable and every criterion passing. FAIL means all 40 are evaluable and at least one criterion fails.

## 3. Final verdict: **FAIL**

All 40 of 40 scheduled runs are evaluable. None is provider-unavailable, aborted or pending.

| Criterion | Result | Recorded values |
|---|---|---|
| 1. v3 eventual validity ≥ 99% | pass | v3 100.00%, v2 95.00% |
| 2. v3 first-attempt validity ≥ 95% | **FAIL** | v3 85.00%, v2 30.00% |
| 3. v3 `invalid_topic_name` rate ≤ 1% | **FAIL** | v3 13.04% (3 of 23), v2 44.12% (15 of 34) |
| 4. no precision regression | pass | 78.37% vs 66.83% |
| 5. no recall regression | pass | 100.00% vs 84.21% |
| 6. no new schema failure mode | pass | none |

**When each failure became certain** (the order of runs did not change):
- **Criterion 3** became unattainable after run 5, the first v3 `invalid_topic_name`.
- **Criterion 2** became unattainable after run 36, the second v3 first-attempt failure.
- The schedule was nevertheless completed as registered.

This verdict is final. The preregistration, definition and all 80 artifacts stay frozen as historical evidence.

## 4. Pooled results (t4 + t5)

These figures come from the evaluator. Attempts, requests, tokens and cost are summed from each result's recorded `totals`.

| | topic-discovery-v2 | topic-discovery-v3 |
|---|---|---|
| Runs / evaluable / provider-unavailable | 20 / 20 / 0 | 20 / 20 / 0 |
| First-attempt validity | 30.0% (6 of 20) | 85.0% (17 of 20) |
| Eventual validity | 95.0% (19 of 20) | 100.0% (20 of 20) |
| `invalid_topic_name` rate | 44.1% (15 of 34 attempts) | 13.0% (3 of 23 attempts) |
| Other schema or validation failure rate | 0.0% | 0.0% |
| Proxy precision (mean over runs with a valid taxonomy) | 66.83% (n = 19) | 78.37% (n = 20) |
| Proxy recall (mean over runs with a valid taxonomy) | 84.21% (n = 19) | 100.00% (n = 20) |
| Attempts | 34 | 23 |
| Requests (failed) | 34 (0) | 23 (0) |
| Input / output tokens | 275,880 / 41,606 | 189,744 / 26,482 |
| Cost | $0.967820 | $0.644308 |
| Provider or API failures, timeouts | none | none |

## 5. Per-dataset results (descriptive)

| Cell | Runs | First-attempt valid | Eventually valid | `invalid_topic_name` | Precision | Recall | Requests | Cost |
|---|---|---|---|---|---|---|---|---|
| t4 / v2 | 10 | 0.0% (0) | 100.0% (10) | 50.0% (10 of 20) | 81.97% | 100.00% | 20 | $0.570980 |
| t4 / v3 | 10 | 80.0% (8) | 100.0% (10) | 16.7% (2 of 12) | 81.74% | 100.00% | 12 | $0.326230 |
| t5 / v2 | 10 | 60.0% (6) | 90.0% (9) | 35.7% (5 of 14) | 50.00% | 66.67% | 14 | $0.396840 |
| t5 / v3 | 10 | 90.0% (9) | 100.0% (10) | 9.1% (1 of 11) | 75.00% | 100.00% | 11 | $0.318078 |

**Consistency with the pooled results:**
- **Counts:**
  - First attempts: 0 + 6 = 6 for v2, and 8 + 9 = 17 for v3.
  - Eventually valid: 10 + 9 = 19, and 10 + 10 = 20.
  - `invalid_topic_name`: 10 + 5 = 15 of 20 + 14 = 34 for v2, and 2 + 1 = 3 of 12 + 11 = 23 for v3.
  - Requests: 20 + 14 = 34, and 12 + 11 = 23.
- **Precision and recall** are run-weighted means over valid runs:
  - v2 precision = (8.196970 + 4.500000) / 19 = 66.83%;
  - v2 recall = (10 + 6) / 19 = 84.21%;
  - v3 precision = (8.174242 + 7.500000) / 20 = 78.37%;
  - v3 recall = 20 / 20 = 100%.
- **Costs:** $0.570980 + $0.396840 = $0.967820, and $0.326230 + $0.318078 = $0.644308.

On t4 the two contracts reach the same quality once valid (precision 81.97% vs 81.74%). The pooled precision and recall gap comes from t5, specifically from run 8 and the zero-example runs (§8).

## 6. Failure analysis

Every rejected attempt in the experiment, for both contracts, is `invalid_taxonomy` with `invalid_topic_name`.
- No other validation or schema code was seen.
- There were no provider or API failures, timeouts or failed requests.

All of these failures are model-format failures against the frozen validator. The validator itself is unchanged: `validateTopicTaxonomy`, `MAX_TOPIC_NAME_WORDS = 5`, tn1 normalisation. That normalisation removes apostrophes and treats every space, hyphen, comma or other punctuation mark as a word separator. Each rejected name below counts **6 words**. All rejected raw outputs are kept in the result files with secrets removed, and none was truncated.

### v3 (candidate): 3 rejected attempts in 23

| Run | Cell | Rejected name (key) | Counted words | Retry outcome |
|---|---|---|---|---|
| 5 | t4 / v3, round 2 | "Offline Mode and App Technical Issues" (`offline_sync_tech`) | Offline / Mode / and / App / Technical / Issues = 6 | valid, 12 topics |
| 36 | t5 / v3, round 9 | "Warm-Up and Heat-Up Speed" (`warmup_time`) | Warm / Up / and / Heat / Up / Speed = 6 | valid; the topic became "Warm Up Speed" (3) |
| 37 | t4 / v3, round 10 | "Offline Mode, Sync and App Issues" (`offline_sync_tech`) | Offline / Mode / Sync / and / App / Issues = 6 | valid; the topic became "Offline Mode and Sync" (4) |

- All three v3 failures recovered on the first retry, which carried the v3 `rejected_topic_names` feedback.
- No v3 run ended invalid.
- Run 36 broke the v3 rule "Avoid hyphenated compound words in names" with two hyphenated compounds, the case the v3 counting rule and worked examples describe.
- Runs 5 and 37 are the same t4 offline/sync/technical concept that v2 failed in every t4 run.

### v2 (baseline): 15 rejected attempts in 34

- **t4, all 10 runs:** the first attempt failed on the offline/sync/technical topic every time (runs 1, 6, 9, 14, 17, 22, 25, 30, 33, 38). Examples:
  - "Offline mode, sync and app issues"
  - "Offline use, sync and technical issues"
  - "Offline Mode, Sync and App Issues"

  Each counted 6 words, and each run recovered on the retry.
- **t5, 5 attempts:** on the warm-up/heat-up topic in runs 8 (both attempts), 11, 24 and 27.
  - Run 27's first attempt also contained "Espresso Shot Quality and Dialing In" (6).
  - Examples: "Heat-Up and Warm-Up Time", "Warm-up and heat-up time", "Warm-Up and Heat-Up Time". Each counts 6 because the hyphens split words.
- **Run 8 (t5 / v2)** is the only run in the experiment that ended without a valid taxonomy.
  - Both attempts received model responses and both were rejected for `invalid_topic_name`.
  - The discovery runner's per-run `status` field reads `unavailable` (no taxonomy produced).
  - The reliability evaluator classifies the run by its attempts. Since no attempt was a `provider_error`, it counts the run as **evaluable and invalid**, a format failure, not provider-unavailable. That is why v2 eventual validity is 95%.

### Conclusion

v3 cut the failure rate but **did not eliminate** over-long topic names. The same two concepts (t4 offline/sync/technical and t5 warm-up/heat-up) produced every failure under both contracts. The v3 prompt did not solve the problem. What it did was make the failure rarer and the retry reliable in this sample.

## 7. Interpretation: v3 vs v2

1. **The preregistered experiment failed its strict reliability thresholds** (criteria 2 and 3). v3 does not meet the production reliability requirement the preregistration specified: first-attempt validity of at least 95% and an `invalid_topic_name` rate of at most 1%.
2. **There is strong evidence that v3 is materially better than v2** on every observed measure. These are qualitative findings, separate from the pass/fail criteria.

   | Measure | v2 | v3 |
   |---|---|---|
   | First-attempt validity | 30% | 85% |
   | Eventual validity | 95% | 100% |
   | `invalid_topic_name` rate | 44.1% | 13.0% |
   | Proxy precision | 66.83% | 78.37% |
   | Proxy recall | 84.21% | 100% |
   | Requests | 34 | 23 |
   | Cost | $0.967820 | $0.644308 |

   On t4, where both contracts always ended valid, v3 matches v2 on precision and recall, so the improvement there is in format robustness only.
3. **The evidence is insufficient to claim that v3 satisfies the production reliability requirement.** With 20 runs per contract, v3's 3 failures in 23 attempts are well above the registered 1% ceiling. The sample cannot show the rate is near it.
4. **The failed preregistration must remain frozen.** Nothing in this experiment may be re-scored, excluded or reinterpreted to change the verdict.

## 8. Zero-example pathology (v2 on t5)

Three v2 runs on t5 produced **accepted** taxonomies in which every topic has zero example comments:

| Run | Round | Attempts | `topicsWithExamples` | Matched | Precision / recall |
|---|---|---|---|---|---|
| 27 | 7 | `invalid_topic_name`, then valid (the retry output was accepted) | 0 of 12 | 0 | 0% / 0% |
| 32 | 8 | valid on the first attempt | 0 of 12 | 0 | 0% / 0% |
| 40 | 10 | valid on the first attempt | 0 of 12 | 0 | 0% / 0% |

How this happened:
- **The validator allows it.** The frozen validator permits topics with zero example comments, so these taxonomies were valid by the registered rules.
- **The evaluator needs examples.** The discovery-only evaluator (`evaluateDiscoveredTaxonomy`) matches each topic to a gold concept by the majority gold label of its `exampleCommentIds`. A topic with no examples cannot be matched.
- **The scores are therefore zero.** These three runs recorded 0% proxy precision and 0% proxy recall, and those values count in the v2 means.

Effect on the results:
- They account for most of the t5 / v2 precision and recall gap. The other six valid t5 / v2 runs each scored 75% precision and 100% recall.
- **No v3 run had zero examples.** Every v3 run had examples on every topic (11/11 or 12/12).

Constraints on this finding:
- These runs are **not excluded, modified or re-scored**. They are part of the registered result.
- This experiment does not establish whether the cause is the v2 prompt, the t5 sample, or chance.

## 9. Correction: run-37 token count

The run-by-run report sent after run 37 gave **2,298** output tokens. That number was copied in error from run 36, which recorded 2,298.

The run-37 result file is correct and was not modified:
`2026-10-06T18-11-28-684Z-topics-t4-topics-v1-discovery-reliability-discovery-v3-name-robustness-v1-run-37-topic-discovery-v3.json`.

It records:
- **16,544 input tokens**;
- **2,337 output tokens**;
- **2 requests, 0 failed**;
- **$0.056458** cost.

All totals in this document use 2,337.

## 10. Budget and cost

| Item | Value |
|---|---|
| Registered budget | $14.00 (worst case for all 40 runs: $13.5908) |
| Per-run worst case | t4 v2 $0.33932, t4 v3 $0.339796, t5 v2 $0.339744, t5 v3 $0.34022 |
| **Total cost** | **$1.612128** (v2 $0.967820 + v3 $0.644308) |
| Unused budget | $12.387872 |
| Requests | 57 (34 v2 + 23 v3), 0 failed |
| Tokens | 465,624 input, 68,088 output |
| Most expensive run | run 8 (t5 / v2, both attempts rejected), $0.064324 |
| Cheapest run | run 32 (t5 / v2, one attempt), $0.024736 |

The budget gate passed before every run. The registered budget was never raised, and the CLI accepts no override.

## 11. Reproducibility and integrity audit

All checks below were made on the saved artifacts, with no API calls.

| Check | Result |
|---|---|
| Artifact count | 80 = 40 results + 40 reservations; exactly one of each per scheduled run 1–40 |
| Schedule | every result's `stamp` (`scheduledRun`, `dataset`, `contract`, `runNumber`) equals `reliabilitySchedule(def)`. Rounds 1–10 run t4 then t5, with v2 first in odd rounds and v3 first in even rounds |
| Fingerprint | every result stamp and every reservation records `sha256:17aa3db3…b2dda4fe`, which equals `reliabilityExperimentFingerprint(def)` at HEAD |
| Dataset identity | the 20 t4 results record SHA-256 `58e225f9…`; the 20 t5 results record `cec6e656…` |
| Reservation before result | each reservation timestamp precedes its result timestamp |
| No replacement or deletion | no run has a second result or reservation. Before every live run, the SHA-256 of every pre-existing `benchmark-results/` file was recorded and rechecked after the run. Every check matched, nothing was removed, and each run added exactly two files |
| No code or configuration change | HEAD was `e8a2fd3` before every run and is now. `git diff HEAD` is empty for tracked files. The newest mtime of any tracked file under `src/`, `tests/` and `docs/` is 16:46:50 UTC, before the first reservation at 16:53:39 UTC |
| Model / provider | every result records Anthropic and `claude-sonnet-5-5` (requested and served), effort `high` |
| No consolidation or Jev | every result records `assignment: "not run"`, and no result contains consolidation output |
| Secrets | none of the 80 artifacts contains the API key or any `sk-ant-`, `sk-proj-` or `Bearer` string |
| Verdict reproduction | `discovery-reliability-cli.ts --check` reproduces FAIL, with criteria 2 and 3 failing and 1, 4, 5, 6 passing. An independent recomputation from the artifacts gives the same pooled and per-dataset values |
| Cost | the sum of the 40 recorded `totals.estimatedCostUsd` values is exactly $1.612128 |

## 12. No live runs remain

All 40 scheduled runs have a reservation and a result.
- The runner refuses any further run ("Every scheduled run has been started; no additional or replacement run is allowed").
- The registration allows no replacement and no extra run.
- This experiment is closed.

## 13. Future work (not part of this experiment)

These recommendations are **not** part of `discovery-v3-name-robustness-v1`. They change nothing here, and none is implemented in this commit. Any of them needs a new contract, a new preregistration and a new fingerprint.

1. **Target the two recurring concepts.** Every failure in 57 attempts involved t4 offline/sync/technical issues or t5 warm-up/heat-up time. A candidate prompt could tell the model to name compound concepts by their main noun, for example "Offline Sync" or "Warm Up Time", instead of listing every part.
2. **Prefer at most 4 words more strictly,** or ask the model to count the words of each name before answering. The v3 failures were all exactly 6 words, one word over the limit.
3. **Address zero-example taxonomies separately.** Decide, in a new preregistration, whether a topic with no examples should be a validation error or a separate diagnostic. Measure it as its own metric, not through precision and recall.
4. **Size the next experiment for its thresholds.** Showing an `invalid_topic_name` rate at or below 1% needs far more than about 23 attempts per contract. Register the sample size against the threshold, and report confidence intervals as well as point estimates.
5. **Keep the v2 baseline frozen** as the comparison, and compare any v4 against both v2 and v3 using the same datasets, model, retry policy and evaluator.
