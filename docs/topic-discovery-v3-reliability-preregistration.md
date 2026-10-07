# Pre-registration: discovery-v3 name-robustness reliability experiment

**Status:** PRE-REGISTERED before any live v3 result. No live call has been made with `topic-discovery-v3`. Nothing in this document, the registered definition or the evaluation rules may change after the first run is reserved.

**Experiment id:** `discovery-v3-name-robustness-v1`

**Definition:** `DISCOVERY_RELIABILITY_EXPERIMENT` in `src/benchmark/topic-discovery-reliability.ts`.

**Definition fingerprint:** `sha256:17aa3db369cc0ae836655e01132d2144f6f5f7cf4b19de88117b9075b2dda4fe`.
- Every run and reservation records it.
- A run made under any other definition makes the evaluation INVALID.
- The fingerprint is pinned in `tests/benchmark/topic-discovery-reliability.test.ts`.

**Runner:** `src/benchmark/discovery-reliability-cli.ts`. It is the only runner for this experiment and takes no override.

**This experiment does not modify or reinterpret the t5 paired-experiment verdict.** `paired-consolidation-v3-v4-t5-v1` remains INCOMPLETE (`docs/topic-consolidation-paired-t5-postmortem.md`). Its registration, results and evaluation are untouched.

## 1. Problem statement

Every rejected discovery attempt recorded so far is `invalid_topic_name`: 7 on t4 and 2 on t5 (t5 postmortem, §C). The validator counts the words of a topic name after tn1 normalisation, which turns every hyphen and other punctuation run into a space. "Video Requests and Follow-Up Tests" therefore counts 6 words, and "Heat-Up and Warm-Up Time" counts 6.

The v2 prompt asks for "1-5 words" without saying how words are counted. The v2 retry feedback names only the issue code and the topic key: it never shows the rejected name or its counted word total. A model that treats a hyphenated compound as one word keeps producing names that fail.

## 2. The v3 change: name-format robustness only

`topic-discovery-v3` (in `src/core/topics/provider-contracts.ts`) is `topic-discovery-v2` with exactly these edits:

1. **Contract id:** the first instruction line names `topic-discovery-v3`.
2. **The name field** is split into three lines:
   - a neutral label of at most 60 characters, without praise or criticism words, distinct after ignoring case and punctuation (as in v2);
   - "NAME LENGTH: 1-5 counted words, and prefer at most 4", with the counting rule stated exactly as the validator applies it: apostrophes removed, and every space, hyphen, slash, comma, other punctuation mark or symbol separates words. Worked examples: "Long-Term Use" is 3 words; "Sign-In and Set-Up Steps" is 6 words, so rejected; "Alpha, Beta and Gamma" is 4 words;
   - "Avoid hyphenated compound words in names."
3. **Retry only:** the RETRY explanation and the `invalid_topic_name` issue description refer to the new feedback.
   - The retry data adds `rejected_topic_names` inside `retry_feedback`. Each entry has the rejected topic `key`, the `name` as the model wrote it (data only, capped at 120 characters), `counted_words`, and `rule`. The rule is the exact validator rule, `TOPIC_NAME_RULE`.
   - The frozen issue feedback (codes, counts, comment ids, topic keys) is unchanged.

**Unchanged:** the task and every discovery rule, the data on a first attempt, the output format and schema, the parser, the validator (`validateTopicTaxonomy`, `MAX_TOPIC_NAME_WORDS = 5`, tn1), example selection, the maximum topic count, the sample and the retry policy.

**Prompt fingerprints** (`requestPromptFingerprint` on t5):

| | First attempt | Retry |
|---|---|---|
| v2 | `sha256:7f01e2f9…3f685af1` (equal to the live t5 paired run) | `sha256:3b4a0ffb…ff75002a` |
| v3 | `sha256:71dbeb71…8bc207a5` | `sha256:a4ba1a3c…2fd293121` |

**Diagnostics on every discovery path:** every rejected raw response, whether unparseable or an invalid taxonomy, is kept with secrets removed, at most 100,000 characters per response. This holds for the discovery-only (and smoke), discovery-consolidated, real and real-consolidated paths, both v2 and v3; the paired runner already kept them. It never changes what is validated or returned.

## 3. Frozen v2 baseline

- `topic-discovery-v2` stays byte-identical and the default.
- Its instruction hashes, full first-attempt and retry requests (t1, t4, t5) and output schema are pinned in `tests/unit/topic-discovery-v3-contract.test.ts`.
- Its prompt fingerprints equal those recorded by the live t5 paired run.

## 4. Fixed design

| Item | Registered value |
|---|---|
| Datasets (already observed; a robustness/regression experiment, **not** a hold-out benchmark) | `t4-topics-v1`, SHA-256 `58e225f986238591de8687faab59b9445e5d22088d1a3666382ba5e2043292fd`; `t5-topics-v1`, SHA-256 `cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3` |
| Contracts | `topic-discovery-v2` (baseline) vs `topic-discovery-v3` (candidate) |
| Provider / model | Anthropic, `claude-sonnet-5-5`, configured settings (same for both contracts) |
| Sample | the discovery-only sample methodology (seeded production discovery sample) |
| Run | one discovery-only run, scored by the unchanged discovery-only evaluator; no consolidation, no Jev |
| Retry policy | the production rule: at most 2 attempts, the second with structured feedback (v3 adds the rejected names) |
| Runs | 10 per dataset and contract: **40 runs, so 40 discovery runs**. With the retry, at most 80 discovery requests |
| Order | fixed, round by round (run numbers 1–10): t4 then t5, both contracts back to back. Odd rounds run v2 first, even rounds v3 first |
| Replacement | none: no replacement and no additional runs after any result is seen. Each scheduled run is reserved before it starts and runs once |

## 5. Metrics

Metrics are computed per contract, pooled over t4 and t5. Per-dataset values are reported descriptively.

1. **First-attempt taxonomy validity:** runs whose first attempt is valid, divided by runs whose first attempt received a model response.
2. **Eventual taxonomy validity:** runs ending with a valid taxonomy within the 2-attempt policy, divided by evaluable runs.
3. **Invalid-topic-name failure rate:** attempts rejected with `invalid_topic_name`, divided by attempts that received a model response.
4. **Other schema/validation failure rate:** attempts rejected with any other validation or schema code, divided by attempts that received a model response. Each code is also counted.
5. **Discovery-only proxy precision:** mean over runs with a valid taxonomy.
6. **Discovery-only proxy recall:** mean over runs with a valid taxonomy.

Reported separately, and never mixed into the format metrics:
- topic-name validation failures;
- other schema failures;
- provider/API failures by kind;
- timeouts (the `timeout` kind);
- unavailable runs.

## 6. Fixed success criteria for v3

Comparisons use unrounded values, with a 1e-9 tolerance for floating-point representation only.

1. Eventual validity is at least 99%.
2. First-attempt validity is at least 95%.
3. The `invalid_topic_name` failure rate is at most 1%.
4. No regression in proxy precision: the v3 mean is at least the v2 mean, with no tolerance.
5. No regression in proxy recall: the v3 mean is at least the v2 mean, with no tolerance.
6. No new schema failure mode: every rejection code other than `invalid_topic_name` seen in v3 attempts was also seen in v2 attempts.

With 20 v3 runs, these thresholds mean in practice:
- criterion 1 requires every v3 run to end valid;
- criterion 2 allows at most one v3 first-attempt failure;
- criterion 3 allows no `invalid_topic_name` at all (one failure in about 21 attempts is 4.8%).

## 7. Interpretation

- **PASS:** all 40 scheduled runs are evaluable and every criterion 1–6 passes.
- **FAIL:** all 40 runs are evaluable and at least one criterion fails.
- **INCOMPLETE:** any scheduled run is not run yet, aborted (reserved with no saved result), or provider-unavailable.
- **INVALID:** a run or reservation breaks the registration (another definition fingerprint, dataset, contract, provider, model or assignment), or a scheduled run is run twice. INVALID runs are refused, not skipped.

**Unavailable runs:**
- A run that ends without a valid taxonomy because a needed attempt received no model response (provider/API failure or timeout) is **provider-unavailable**. It is not a format failure and is not replaced; the experiment is then INCOMPLETE.
- A provider failure followed by a valid attempt leaves the run evaluable. Its first attempt is excluded from the first-attempt denominator.

There is no fallback interpretation, and no partial or per-dataset verdict.

## 8. Budget and stop rule

Conservative worst case per run (both attempts at the output ceiling, `buildDiscoveryBenchmarkPlan` with the configured prices):

| Dataset | v2 | v3 |
|---|---|---|
| t4 | $0.33932 | $0.339796 |
| t5 | $0.339744 | $0.34022 |

All 40 runs at the worst case total **$13.5908**. **Registered budget: $14.00.**

Before every run, the CLI checks:
- **Spent so far:** saved runs count at their recorded cost. An unpriced run, and a reserved run with no result, count at their cell's registered worst case.
- **Start condition:** the run starts only if its current worst case is within its cell's registered worst case and within the remaining budget. A configuration or price change refuses the run.
- **No overrides:** the budget cannot be raised, and the CLI takes no override.

## 9. How to run (not run yet)

```bash
npx tsx --env-file-if-exists=.env src/benchmark/discovery-reliability-cli.ts
npx tsx --env-file-if-exists=.env src/benchmark/discovery-reliability-cli.ts --live --next-run-only
npx tsx src/benchmark/discovery-reliability-cli.ts --check
```

- The first command prints the plan only and makes no API calls.
- The second runs exactly the next scheduled run, which is billed. Without `--next-run-only`, it runs all remaining scheduled runs.
- The third evaluates the saved runs offline.
- Run and reservation files are written to `benchmark-results/` and never overwrite anything.

This CLI is the only live path for this experiment. `topics-cli.ts` still refuses every live call on t5.
