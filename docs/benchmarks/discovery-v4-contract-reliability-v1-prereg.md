# Pre-registration (DRAFT, revision 4): discovery-v4 contract reliability experiment

**Status:** DRAFT. The design is approved; the text is not yet committed.
- Nothing is implemented. `topic-discovery-v4` does not exist in code.
- No run has been reserved, and no API call has been made.
- This document becomes binding only after it, the registered definition and its fingerprint are committed, before the first reservation (§14).

**Experiment id:** `discovery-v4-contract-reliability-v1`

**Starting point:** `main` at `0cf74350a4d13b0f58b81e734f9e0368c9aa175b`, equal to `origin/main`.

**This is a new experiment** (§16). It does not modify, reopen, re-score or pool with `discovery-v3-name-robustness-v1`. That experiment's FAIL verdict and its 80 artifacts stay frozen.

**Changes in revision 4.** Semantic clarifications only; the statistical design is unchanged.
1. `model_refusal` is registered and defined (§11.2).
2. A first-attempt outage followed by a valid retry is explicitly a first-attempt failure (§11.3).
3. The attempt denominators of criteria 3 and 5 are exact (§9.2, §10).
4. `--next-round-only` is the registered execution control (§13.9).
5. Fewer than 300 complete valid pairs now makes the experiment INCOMPLETE before any FAIL is considered (§9.4).
6. Open items are replaced by recorded decisions (end of the document).

---

## 1. Hypotheses

Every hypothesis concerns `topic-discovery-v4` against the frozen `topic-discovery-v3` control, with:
- **inputs:** the two registered datasets (§5);
- **model:** `claude-sonnet-5-5` (§6);
- **retry policy:** the production retry, at most 2 attempts.

**H1, reliability (primary).** Each threshold must hold as a **one-sided 95% Clopper–Pearson confidence bound** on the v4 arm:

| Measure | Required bound |
|---|---|
| Eventual validity | ≥ 99% |
| First-attempt validity | ≥ 95% |
| `invalid_topic_name` rate | ≤ 1% |
| Other structural rejection rate | ≤ 5% |

In addition, **no** accepted v4 taxonomy may break the example invariant V4-E.

**H2, quality (primary).** v4 is non-inferior to v3 in discovery-only proxy precision and proxy recall. The test uses complete valid pairs from the same registered round and dataset, with a margin of 1.0 percentage point.

**H3, cost (secondary, but a registered criterion).** v4's retry rate and cost per run stay within the registered ceilings (criterion 8).

## 2. Motivation

**From `discovery-v3-name-robustness-v1`** (FAIL on criteria 2 and 3; `docs/benchmarks/discovery-v3-name-robustness-v1-postmortem.md`):

| Pooled, t4 + t5 | v2 | v3 |
|---|---:|---:|
| First-attempt validity | 30.0% | 85.0% |
| Eventual validity | 95.0% | 100.0% |
| `invalid_topic_name` rate | 44.1% | 13.0% |
| Proxy precision | 66.83% | 78.37% |
| Proxy recall | 84.21% | 100.00% |

**1. The failure mode was counted-word overflow, and it persisted.** Every v2 and v3 rejection was `invalid_topic_name` for a name of **6 validator-counted words**, against a limit of 5.
- v3 still did this in 3 of 23 attempts (runs 5, 36, 37).
- Punctuation itself was never the cause. It matters only because the deterministic tn1 count treats it as a word separator. So the lever is the **counted-word limit**, not a ban on punctuation.

**2. The v3 sample was too small for its thresholds.** With 20 runs and 23 attempts per arm, the result was uninformative about a 1% requirement:
- Even 0 failures in 20 runs gives a one-sided 95% upper bound of **13.9%**.
- The observed 3 of 23 has an upper bound of **30.4%**.

**From the zero-example audit** (`docs/benchmarks/zero-example-taxonomy-audit.md`, commit `0cf7435`):

3. **Examples are optional today.** 4 of 56 accepted discovery taxonomies had zero examples: 4 of 34 under v2 and 0 of 20 under v3. v3's 0 of 20 is observational only.
4. **The contract relaxed the spec.**
   - The current contract makes `exampleCommentIds` optional and requests up to 3.
   - The validator accepts 0, 1 or more than 3 examples, and silently removes duplicates.
   - `spec.md` §7.3 documents `example_comment_ids: [ids from the sample, 2–5]`.
5. **Examples are needed downstream,** although assignment does not consume them. Discovery scoring, consolidation traceability and report-evidence selection depend on them.

## 3. The v4 contract proposal (exact)

`topic-discovery-v4` is `topic-discovery-v3` plus exactly the changes in §3.1–§3.3. Nothing else changes.

### 3.1 Topic names: rule V4-N

**Rule V4-N:** each topic name must contain **2–4 validator-counted words**.

**Counting is unchanged.** It is the existing deterministic tn1 rule (`TOPIC_NAME_RULE`, `src/core/topics/provider-contracts.ts`):
- apostrophes are removed;
- every run of characters that are not letters or digits becomes one separator. That covers spaces, hyphens, slashes, commas, other punctuation, symbols and emoji.

**Punctuation and hyphens may appear in a name** as long as the validator counts 2–4 words:

| Name | Counted words | Result |
|---|---|---|
| "Built-in Grinder" | 3 | accepted |
| "Warm-Up Time" | 3 | accepted |
| "Pricing, Billing and Account" | 4 | accepted |
| "Offline Sync" | 2 | accepted |
| "Noise" | 1 | rejected |
| "Warm-Up Speed and Scheduling" | 5 | rejected |
| "Offline Mode, Sync and App Issues" | 6 | rejected |

**What stays the same:**
- The existing tn1 name validity check (`MAX_TOPIC_NAME_WORDS = 5`), uniqueness after normalisation, the 60-character request and "no praise or criticism words" are unchanged.
- V4-N is an additional check, applied only under the v4 contract.

**A violation is reported as `invalid_topic_name`,** the existing code. The retry feedback keeps the v3 shape. Each entry of `retry_feedback.rejected_topic_names` holds:
- the rejected topic `key`;
- the `name` exactly as written, capped at 120 characters;
- `counted_words`, under the unchanged tn1 count;
- `rule`, the exact V4-N rule text including the counting rule.

**Prompt (v4 only).** The NAME LENGTH lines say "2-4 counted words", with the same stated counting rule. The worked examples are:
- "Built-in Grinder" is 3 words;
- "Warm-Up Speed and Scheduling" is 5 words, so it is rejected;
- "Noise" is 1 word, so it is rejected.

"Semantically meaningful" names are requested but **not validated**. They are measured only indirectly, through proxy precision and recall.

### 3.2 Topic examples: rule V4-E (restores and enforces `spec.md` §7.3)

**Rule V4-E:** every accepted topic must have an `exampleCommentIds` array of **2 to 5 entries** inclusive. Every entry must be an ID from the supplied discovery sample, and all entries must be **distinct** within the topic.

- **This restores the documented 2–5 example requirement of `spec.md` §7.3** and turns it into an enforced contract invariant. Today it is only "optional, up to 3 requested".
- **Duplicates are rejected, not silently removed.** The size limits count the raw entries.
- **The same comment ID may be used by two different topics.** No documented rule forbids it, and this experiment adds none.

**One top-level issue code: `invalid_examples`** (new). It is a taxonomy code, added to `TAXONOMY_ISSUE_CODES`, so `retryScope` sends the retry back to rediscovery. Each issue carries the topic `index` and `topicKey`, plus a machine-readable `reasons` list (sorted, without duplicates) drawn from:

| Reason | Condition |
|---|---|
| `missing_or_too_few` | the field is absent, or the array has 0 or 1 entries |
| `too_many` | the array has more than 5 entries |
| `unknown_id` | at least one entry is not an ID of the discovery sample, including an empty string |
| `duplicate_id` | at least one ID occurs more than once in the topic |

One topic can have several reasons, for example `["duplicate_id", "unknown_id"]`.

**`unknown_example_comment` is not emitted under v4.** Unknown IDs are reported as `invalid_examples` with reason `unknown_id`. The existing code stays unchanged for v2 and v3.

**Retry feedback (v4 only).** `retry_feedback` keeps the frozen counts per code and the topic keys, and adds:

```
invalid_examples: [ { "key": "<topic key>", "reasons": ["…"], "provided_count": <raw entry count>, "required": "2-5 distinct sample ids" } ]
```

It never includes example IDs, which come from the model and are untrusted (unchanged policy).

**Schema (v4 only):** `exampleCommentIds` is added to `required`, with `minItems: 2` and `maxItems: 5`. The Anthropic transport removes `minItems` and `maxItems` (existing behaviour, unchanged), so **the validator, not the schema, enforces V4-E**.

**Prompt (v4 only):** "exampleCommentIds (required): 2 to 5 distinct ids of sample comments that clearly belong to the topic, copied exactly from the data."

### 3.3 Implementation constraints (scope, not implemented here)

1. **v4 rules apply only under `topic-discovery-v4`.** v2 and v3 requests, schemas and validation must stay byte-identical, which means:
   - the pins in `tests/unit/topic-discovery-v3-contract.test.ts` and the v2 pins must pass unchanged;
   - the consolidation contract keeps calling the unchanged validator.
2. **Unchanged:**
   - discovery sampling;
   - taxonomy structure;
   - the assignment contract;
   - the retry budget (2 attempts);
   - sequential execution, with no concurrency change;
   - the provider, model and effort;
   - the evaluator (`evaluateDiscoveredTaxonomy`);
   - the datasets and their fingerprints.
3. **Diagnostics (additive).** Every result records:
   - the accepted taxonomy's `exampleCommentIds` per topic;
   - the **raw accepted output**, with secrets removed and at most 100,000 characters;
   - each attempt's recorded `providerFailure` kind, when there is one (§11.1).
4. **Attempt and run classification.** The evaluator of this experiment classifies **both arms** (v3 control and v4) with the same rules (§11), from the recorded `outcome` and `providerFailure` fields.
   - A `provider_error` attempt is provider-unavailable only if its `providerFailure` kind is in the registered set.
   - `refusal` is a `model_refusal`, not an outage.
   - This differs from the archived v3 evaluator, which treated every `provider_error` the same way. That evaluator stays unchanged.

## 4. The frozen v3 control

The control is `topic-discovery-v3` **exactly as archived**:
- the same prompts, schema, validator, retry feedback and evaluator;
- no change is made to v3 to accommodate this experiment.

**Before the first reservation,** the runner must show that the v3 control requests equal the archived v3 requests. If any differs, the experiment is INVALID and is not started. The checks:
- the instruction hashes and full first-attempt and retry requests pinned in `tests/unit/topic-discovery-v3-contract.test.ts`;
- the archived v3 prompt fingerprints. On t5 these are `sha256:71dbeb71…8bc207a5` (first attempt) and `sha256:a4ba1a3c…2fd293121` (retry); the full values are in that test file.

**No pooling.** The archived v3 runs are motivation only. They are never pooled with, or compared statistically against, this experiment's control runs.

## 5. Datasets and fingerprints

| Dataset | File | SHA-256 | Discovery sample |
|---|---|---|---|
| `t4-topics-v1` | `fixtures/t4-topics-v1/comments.json` | `58e225f986238591de8687faab59b9445e5d22088d1a3666382ba5e2043292fd` | all 189 topic-base comments |
| `t5-topics-v1` | `fixtures/t5-topics-v1/comments.json` | `cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3` | all 194 topic-base comments |

- **The same sample in both arms.** The sample comes from the unchanged seeded production discovery sampler (seed label `t1-topics-v1/ds1`, as archived), and covers the whole topic base. Both arms therefore receive **the same comment IDs in the same order**.
- **Sample fingerprint.** The definition records a SHA-256 of each dataset's ordered sample ID list. Every run records the fingerprint of the sample it actually sent. A mismatch makes the experiment INVALID.
- **These datasets have already been observed.** This is a robustness experiment, not a hold-out benchmark.

## 6. Provider and model

| Setting | Value |
|---|---|
| Provider | Anthropic |
| Model | `claude-sonnet-5-5` |
| Effort | `high` |
| `refusalFallback` | `off` |
| `maxOutputTokens` | 16,000 |

These are the same as v3 and the current `config/topic-providers.json`.
- Every run records the requested model and the model that served it. A different served model makes the experiment INVALID.
- Prices come from `config/model-prices.json` as at registration. A price or configuration change refuses the run.

## 7. Run schedule

**620 scheduled runs:** 155 rounds × 4 runs, so **310 scheduled runs per arm** and 155 per dataset and contract. There is no replacement and no additional run.

The number of **evaluable** runs per arm can be lower: 300–310 when the provider-unavailable tolerance is respected (§11).

Run index `i = 4·(r − 1) + j`, with round `r = 1…155` and position `j = 1…4`:

| Position j | Odd round r | Even round r |
|---|---|---|
| 1 | t4, v3 | t4, v4 |
| 2 | t4, v4 | t4, v3 |
| 3 | t5, v3 | t5, v4 |
| 4 | t5, v4 | t5, v3 |

So each round runs t4 then t5, with both contracts back to back, and alternates which contract goes first.

- **Registered pairs.** Each (round, dataset) defines one registered pair: its v3 run and its v4 run. There are **310 registered pairs**.
- Each run is reserved (a `wx` file written before it starts) and runs once.
- The schedule is a pure function of the definition, and the runner takes no override.
- Execution is one registered round per invocation, using `--next-round-only` (§13.9).

## 8. Sample-size rationale

### 8.1 Exact Clopper–Pearson counts

**Definition.** For `x` failures out of `n`, `CP-UB(x, n)` is the one-sided 95% Clopper–Pearson upper bound on the failure proportion: the `p` at which the probability of seeing at most `x` failures in `n` trials equals 0.05. `CP-UB(n, n) = 1`.
- A success-proportion threshold "lower bound ≥ 1 − q" is evaluated as `CP-UB(failures, n) ≤ q`.
- The evaluator computes this exactly, by bisection on the binomial distribution function, to a precision of at least 1e-9. It never uses a table.

**Minimum `n` for a given number of tolerated failures:**

| Bound | Failures tolerated | Minimum n |
|---|---|---|
| ≤ 1% | 0 | **299** |
| ≤ 1% | 1 | 473 |
| ≤ 1% | 2 | 628 |
| ≤ 5% | 0 | 59 |

**Largest failure count that passes, for every evaluable count from 300 to 310:**

| Evaluable n | First-attempt failures allowed (bound ≤ 5%) | CP-UB at that count | CP-UB at one more | Eventual-invalid runs allowed (bound ≤ 1%) | CP-UB(0, n) |
|---|---|---|---|---|---|
| 300 | **8** | 4.760% | 5.177% | **0** | 0.994% |
| 301 | 8 | 4.744% | 5.160% | 0 | 0.990% |
| 302 | 8 | 4.729% | 5.143% | 0 | 0.987% |
| 303 | 8 | 4.713% | 5.126% | 0 | 0.984% |
| 304 | 8 | 4.698% | 5.109% | 0 | 0.981% |
| 305 | 8 | 4.683% | 5.093% | 0 | 0.977% |
| 306 | 8 | 4.668% | 5.076% | 0 | 0.974% |
| 307 | 8 | 4.653% | 5.060% | 0 | 0.971% |
| 308 | 8 | 4.638% | 5.044% | 0 | 0.968% |
| 309 | 8 | 4.623% | 5.027% | 0 | 0.965% |
| **310** | **8** | 4.608% | 5.011% | **0** | 0.962% |

Across the whole range of 300–310 evaluable runs, criterion 2 allows **at most 8** first-attempt failures, and criterion 1 allows **0** runs ending invalid.

**Attempt-based criteria** (3 and 5) use the number of model-response attempts as `n`, which is at least the number of evaluable runs:
- `invalid_topic_name` (≤ 1%): 0 allowed from 299 to 472 attempts, and 1 from 473.
- Other structural rejections (≤ 5%): 8 allowed at 300 attempts, 9 at 320, 10 at 340.

These counts are illustrative. The criterion is always the computed bound itself.

For comparison, the v3 experiment had 0 failures in 20 runs, an upper bound of **13.9%**.

### 8.2 Alternative designs, with costs

The cost model uses archived v3 costs:

| Cell | Mean cost per run | Mean cost per request |
|---|---|---|
| v3 on t4 | $0.03262 | $0.02719 |
| v3 on t5 | $0.03181 | $0.02892 |

v4 is assumed to cost 5% more per request. The cost for one control run plus one v4 run is about **$0.0645** if 10% of v4 runs retry, and **$0.0912** if every v4 run retries.

| Design (runs per arm) | Total runs | Upper bound with 0 v4 failures | Expected cost range | Supports a 1% claim? |
|---|---|---|---|---|
| 20 (v3 size) | 40 | 13.9% | $1.3–1.8 | no |
| 59 | 118 | 4.95% | $3.8–5.4 | only claims at 5% |
| **310 (registered)** | **620** | **0.96%** (0.99% at 300 evaluable) | **$20–28** | **yes, if 0 failures** |
| 473 | 946 | 0.63% | $31–43 | yes, even with 1 failure |
| 628 | 1,256 | 0.48% | $41–57 | yes, even with 2 failures |

### 8.3 Observed-rate threshold vs confidence bound

- **An observed-rate threshold** compares the point estimate with the limit.
  - "Observed ≤ 1%" allows 3 failures in 310.
  - But 3 of 310 has an upper bound of 2.48%, so the data would still be consistent with a true rate well above 1%.
- **A confidence-bound requirement** makes the data *show* the rate is within the limit. At 300–310 it requires zero failures for the 1% criteria.

**Confidence bounds are the primary H1 criteria.** Observed rates are reported for every metric but never decide the verdict.

**Why 310 runs per arm?** It leaves room for up to 10 provider-unavailable runs per arm while keeping at least 300 evaluable runs, where `CP-UB(0, 300)` is 0.994% and still within 1%.

### 8.4 Power of the paired non-inferiority test

- **Spread.** In the archived v3 runs, run-level precision varied with a standard deviation of 2.49 points on t4 and 0.00 on t5. Recall had a standard deviation of 0.
- **Expected spread of the pair differences.** With independent repeats, the differences should spread by about 2.5 points.
- **Standard error.** With n = 300 pairs, the standard error is about 0.14 points.
- **Chance of passing if v3 and v4 truly have equal precision:**

  | Spread of differences | Chance |
  |---|---|
  | 2.5 points | essentially 1 |
  | 6 points | about 0.90 |
  | 10 points | about 0.54 |

## 9. Preregistered criteria

### 9.1 Glossary (definitions used everywhere below)

| Term | Definition |
|---|---|
| **Model-response attempt** | An attempt for which a model response was received. Its class (§11.1) is one of: **accepted**, **rejected**, or **model refusal**. |
| **Accepted taxonomy** | The taxonomy of a model-response attempt that the arm's validator judged valid. In v4 that means the v3 rules plus V4-N and V4-E. |
| **Rejected taxonomy** | A model-response attempt with outcome `invalid_taxonomy`, rejected by the arm's validator. This includes unparseable output (`invalid_output`). |
| **Model refusal** | A model-response attempt classified `model_refusal` (§11.2). |
| **Provider-unavailable attempt** | An attempt with outcome `provider_error` and a recorded `providerFailure` kind in the registered set `{rate_limited, unavailable, timeout, transport}`. No model response was received. |
| **Execution-error attempt** | An attempt with outcome `provider_error` and either no `providerFailure` kind, or `providerFailure = configuration`. |
| **Provider-unavailable run** | A run that ended **without** an accepted taxonomy, contains at least one provider-unavailable attempt, and contains no execution-error attempt. |
| **Evaluable run** | A run with a saved result, no execution-error attempt, and either: **valid**, meaning some attempt accepted (including after a provider-unavailable attempt 1); or **evaluable-invalid**, meaning no attempt accepted and both attempts were model-response attempts. |
| **Terminal state** | A scheduled run has reached a terminal state when its result is saved and it is classified as valid, evaluable-invalid, provider-unavailable or execution-error. A reservation without a result is not terminal. |
| **Complete valid quality pair** | A registered pair (same round and dataset) in which **both** the v3 run and the v4 run are evaluable and ended with an accepted taxonomy. |

### 9.2 Criteria

All criteria apply to the v4 arm, pooled over t4 and t5.
- **CP-UB(x, n)** is the one-sided 95% Clopper–Pearson upper bound on a failure proportion (§8.1).
- Values are compared unrounded, with a 1e-9 tolerance for floating-point representation only.

| # | Criterion | Numerator x / denominator n | Pass condition |
|---|---|---|---|
| 1 | Eventual validity | evaluable-invalid v4 runs / evaluable v4 runs | `CP-UB(x, n) ≤ 1%`, i.e. lower bound ≥ 99%. At 300–310 evaluable runs this means x = 0. |
| 2 | First-attempt validity | evaluable v4 runs whose attempt 1 is **not** accepted / evaluable v4 runs | `CP-UB(x, n) ≤ 5%`, i.e. lower bound ≥ 95%. At 300–310 evaluable runs this means x ≤ 8. |
| 3 | `invalid_topic_name` rate | v4 model-response attempts whose codes include `invalid_topic_name` / **all v4 model-response attempts** | `CP-UB(x, n) ≤ 1%` |
| 4 | Example invariant (structural) | accepted v4 taxonomies with any topic breaking V4-E, checked on recorded data | **x = 0** |
| 5 | Other rejections | v4 model-response attempts rejected for at least one **registered rejection reason other than `invalid_topic_name`** / **all v4 model-response attempts** | (a) every recorded rejection code is registered **and** (b) `CP-UB(x, n) ≤ 5%` |
| 6 | Proxy precision, paired non-inferiority | §9.3 with m = `topicPrecision` | `L ≥ −1.0` point |
| 7 | Proxy recall, paired non-inferiority | §9.3 with m = `conceptRecall` | `L ≥ −1.0` point |
| 8 | Retry and cost | (a) v4 requests / evaluable v4 runs; (b) v4 mean recorded cost per evaluable run against the v3 control's | (a) ≤ 1.10 **and** (b) ≤ 1.20 × the control |

**Attempt denominator for criteria 3 and 5** (exact): `n` is **all attempts of the arm for which a model response was received**, over every run of the arm, including the model-response attempts of runs that ended provider-unavailable. Therefore:

| Attempt class | In the denominator? |
|---|---|
| accepted taxonomies | **included** |
| rejected taxonomies, including `invalid_output` | **included** |
| model refusals | **included** |
| provider-unavailable attempts | excluded: no model response |
| execution-error attempts | excluded; such a run already makes the experiment INCOMPLETE |

**Criterion 5, exact definition:**

`other rejection rate = (model-response attempts rejected for at least one registered rejection reason other than invalid_topic_name) / (all model-response attempts)`

- **Registered rejection reasons:** `invalid_output`, `invalid_topic`, `invalid_topic_key`, `duplicate_topic_key`, `invalid_topic_name`, `duplicate_topic_name`, `missing_definition`, `too_many_topics`, `invalid_examples`, `model_refusal`.
- **What the numerator counts:** every reason except `invalid_topic_name`.
- **`invalid_topic_name` is measured only by criterion 3.** An attempt whose only code is `invalid_topic_name` is **not** in criterion 5's numerator. An attempt with `invalid_topic_name` **and** another registered reason counts in both criteria.
- **Unregistered codes.** A rejected model-response attempt with an unregistered code, or with no code at all, makes 5(a) fail.

**Criterion notes:**
- **Criterion 2** counts every evaluable run whose attempt 1 was not accepted, whether attempt 1 was rejected, a model refusal or provider-unavailable (§11.3). No evaluable run is excluded from its denominator.
- **Criterion 4 is a structural contract criterion.** It verifies V4-E on every accepted v4 taxonomy, using the recorded accepted taxonomy and raw accepted output, independently of the validator.
  - "Valid" means in the run's recorded sample. The checks are 2–5 raw entries, no duplicate entry and no unknown ID. This includes **0 accepted taxonomies with a topic that has fewer than 2 valid, distinct examples**.
  - It is independent of downstream assignment quality and of the proxy scores.
  - No exclusion is allowed.
  - The observed rate of accepted taxonomies with a topic that has fewer than 2 valid, distinct examples is reported descriptively for **both** arms, with its CP interval. For the v3 control this is descriptive only.

### 9.3 Paired non-inferiority test (criteria 6 and 7)

1. **Pairing.** For each round `r` (1…155) and dataset `D` (t4, t5), the registered pair `(r, D)` consists of the v3 run and the v4 run scheduled in that round on that dataset.
2. **Sample.** Only **complete valid quality pairs** (§9.1) are used. `n` is their number.
3. **Minimum.** **`n ≥ 300` is required.** If `n < 300`, the experiment is **INCOMPLETE** (§9.4, condition 2f). The minimum is never lowered.
4. **Difference.** For pair `i`: `d_i = 100 × (m(v4_i) − m(v3_i))`, in percentage points. `m` is the unchanged run-level metric of `evaluateDiscoveredTaxonomy`: `topicPrecision` for criterion 6 and `conceptRecall` for criterion 7.
5. **Mean difference.** `d̄ = (1/n) · Σ d_i`.
6. **Sample standard deviation.** `s_d = √( Σ (d_i − d̄)² / (n − 1) )`.
7. **Standard error.** `SE = s_d / √n`. This is the paired standard error; no independent-samples formula is used.
8. **Lower bound.** One-sided 95% Student-t bound: `L = d̄ − t(0.95, n − 1) · SE`.
   - `t(0.95, n − 1)` is the 0.95 quantile of Student's t with `n − 1` degrees of freedom. It is computed by numerically inverting the t distribution function, to at least 6 significant digits (about 1.6500 at 299 degrees of freedom and 1.6498 at 309).
   - If `s_d = 0`, `L = d̄`.
9. **Pass condition.** Given `n ≥ 300`: the criterion passes if `L ≥ −1.0`, and fails otherwise.

**Secondary, descriptive only, never used for the verdict:**
- an intent-to-treat version, using every registered pair with both runs evaluable, where a run without an accepted taxonomy scores 0;
- the paired statistics per dataset.

**Why the margin is 1.0 point:**
- One topic changing its match moves one run's precision by about 8–9 points. A mean loss of 1 point is roughly one extra unmatched topic every 8–9 runs.
- That is small next to the 11.5-point v2→v3 gain, and detectable at n ≥ 300 (§8.4).

### 9.4 Verdict (applied in this order)

1. **INVALID** if any integrity rule of §13 is broken.
2. **INCOMPLETE** if any of the following holds:
   - (a) not all 620 scheduled runs reached a terminal state (§9.1);
   - (b) a reserved run never finished, i.e. a reservation without a result;
   - (c) an implementation, configuration or operator error occurred. That means any execution-error attempt (§11.1), or an operator stopping execution before all 620 runs reached a terminal state;
   - (d) more than 10 provider-unavailable runs in either arm;
   - (e) fewer than 300 evaluable runs in either arm;
   - (f) fewer than 300 complete valid quality pairs;
   - (g) the hard budget stopped execution (§12).
3. **Otherwise:**
   - **FAIL** if at least one of criteria 1–8 fails;
   - **PASS** only if all of criteria 1–8 pass.

**Clarifications:**
- A valid run after a provider-unavailable attempt 1 remains an **evaluable** run (§11.3).
- There is no partial or per-dataset verdict, and no fallback interpretation.

**Reported but not part of the verdict:**
- every metric as an observed rate, with its CP interval;
- per-dataset tables;
- the v3 control's own reliability and example statistics;
- the provider-unavailable and attempt-1-outage tallies;
- the difference between this control and the archived v3.

## 10. Evaluator and denominators

**The evaluator is unchanged.** Each accepted taxonomy is scored by `evaluateDiscoveredTaxonomy` (`src/benchmark/topic-discovery-only.ts`). The only additions are:
- the v4 structural checks (criterion 4);
- the paired aggregation (§9.3);
- the shared attempt and run classification of §11, applied identically to both arms.

| Quantity | Numerator | Denominator | Excluded from denominator |
|---|---|---|---|
| Eventual validity | evaluable runs ending with an accepted taxonomy | evaluable runs | provider-unavailable runs |
| First-attempt validity | evaluable runs whose attempt 1 was accepted | evaluable runs | provider-unavailable runs |
| `invalid_topic_name` rate (criterion 3) | model-response attempts whose codes include `invalid_topic_name` | all model-response attempts (accepted, rejected and refusal) | provider-unavailable attempts |
| Other rejection rate (criterion 5) | model-response attempts with at least one registered rejection reason other than `invalid_topic_name` | all model-response attempts (accepted, rejected and refusal) | provider-unavailable attempts |
| Example invariant (v4) | accepted v4 taxonomies breaking V4-E | — (requires 0) | none |
| Paired precision and recall | Σ d_i | complete valid quality pairs (`n ≥ 300` required) | pairs that are not complete valid pairs |
| Requests per run | requests sent, including failed ones | evaluable runs | provider-unavailable runs |
| Cost per run | recorded `estimatedCostUsd` | evaluable runs | provider-unavailable runs |

**Two further requirements:**
- Every per-arm run denominator must be **at least 300**. Otherwise the experiment is INCOMPLETE (§9.4, 2e).
- Every rate is pooled over t4 and t5 within an arm.

## 11. Failure and retry semantics

The same rules apply to the v3 control and the v4 candidate, wherever the shared evaluator records the fields involved.

### 11.1 Attempt and run classes

**Each attempt is exactly one of:**

| Class | Recorded condition | Model response received? |
|---|---|---|
| **Accepted** | outcome `valid` | yes |
| **Rejected** | outcome `invalid_taxonomy`, which includes `invalid_output` for unparseable output | yes |
| **Model refusal** | outcome `provider_error` with `providerFailure = refusal` (§11.2) | yes |
| **Provider-unavailable** | outcome `provider_error` with `providerFailure` ∈ `{rate_limited, unavailable, timeout, transport}` | no |
| **Execution error** | outcome `provider_error` with no `providerFailure` kind (an exception that is not a classified provider error, i.e. an implementation error), or `providerFailure = configuration` (bad key, unknown model, rejected request) | — |

The provider-unavailable kinds cover documented provider or API outages, rate limiting, timeouts and transport failures, as classified by the existing transport (`TopicProviderError`). In each case the provider or API failed before a usable model response was obtained.

**A response cut off at the output-token limit** (Anthropic `stop_reason = max_tokens`) is **not** an outage. The existing transport returns the partial text, which fails parsing and is recorded as `invalid_output`. It is a **rejected** model-response attempt.

**Each scheduled run is exactly one of these, checked in this order:**

| # | Class | Condition |
|---|---|---|
| 1 | **Not terminal** | reserved without a saved result, or not started |
| 2 | **Execution-error run** | contains any execution-error attempt, whatever its final status |
| 3 | **Valid** (evaluable) | some attempt accepted |
| 4 | **Evaluable-invalid** (evaluable) | no attempt accepted, and both attempts were model-response attempts (rejected or model refusal) |
| 5 | **Provider-unavailable** | no attempt accepted, and at least one attempt was provider-unavailable |

**Never provider-unavailable:**
- a deliberate experiment abort;
- an operator's choice to stop;
- a budget stop;
- an implementation error;
- a configuration error;
- a reservation without a result.

Each of these makes the experiment INCOMPLETE (§9.4).

### 11.2 `model_refusal` (registered rejection reason)

**`model_refusal`** means all of the following:
- a **model response was received**;
- the response did not produce an acceptable taxonomy because the model **refused the task or returned a refusal-style response**;
- it is **not** a provider-unavailable event;
- it is **not** `invalid_topic_name`;
- it is **not** `invalid_examples`.

**How it is detected (mechanical):**
- An attempt is recorded as `model_refusal` when the transport classifies the response as a refusal. That is the recorded `providerFailure = refusal`, from the model's refusal stop reason; `refusalFallback` is `off`.
- Refusal-style **text** that the transport does not classify as a refusal cannot be parsed as a taxonomy, so it is recorded as `invalid_output`.
- Both labels are model-response rejections, and both count identically in criteria 1, 2, 3 (denominator) and 5 (numerator and denominator). **The label therefore cannot change the verdict.**

**Effect on validity:**
- A model refusal on attempt 1 makes **first-attempt validity fail** for that run (criterion 2).
- If the retry also ends without an accepted taxonomy, the run is **evaluable-invalid**. It counts against criterion 1, and can make the experiment FAIL.
- If the retry produces an accepted taxonomy, the run is **eventually valid but not first-attempt valid**.

### 11.3 Provider-unavailable rules

1. **Outage on attempt 1, then a valid retry.** This is deliberate: if an evaluable run's attempt 1 is provider-unavailable and the retry produces an accepted taxonomy, then:
   - **eventual validity = valid**;
   - **first-attempt validity = failed**.

   The run remains an evaluable run and stays in both validity denominators.
2. **Outage that prevents any taxonomy.** If a provider-unavailable attempt means the run never produces an accepted taxonomy, the run is **provider-unavailable**. It is **excluded from the validity denominators** (criteria 1, 2 and 8) and handled by the tolerance below. This applies in each of these cases:
   - attempt 1 provider-unavailable and attempt 2 rejected or a model refusal;
   - attempt 1 rejected or a model refusal and attempt 2 provider-unavailable;
   - both attempts provider-unavailable.

   In all three, the model-response attempts the run did produce still count in criteria 3 and 5 (item 3).
3. **Attempt rates.** Provider-unavailable attempts are **not** in the criterion 3 or 5 denominators, because no model response was received. Model-response attempts in the same run still count.
4. **Completeness.** Provider-unavailable runs **count toward completeness**: they are terminal.
5. **Tolerance.** **At most 10 provider-unavailable runs per arm** are tolerated. **More than 10 in either arm makes the experiment INCOMPLETE.**
6. **No replacement.** A provider-unavailable run is never retried outside the 2-attempt policy, never replaced and never re-run.

### 11.4 Retry

The unchanged production policy: at most 2 attempts. A retry follows a rejected attempt, a model refusal or a provider-unavailable attempt 1.
- Attempt 2 carries the frozen structured feedback, plus the v3 `rejected_topic_names` extension.
- For v4, the names extension uses rule V4-N, and the `invalid_examples` extension gives topic keys, reasons and counts (§3.2).
- There are no other retries, re-runs or manual repairs.

### 11.5 No post-hoc exclusions

Only the classifications above, decided mechanically from recorded fields, can remove a run, attempt or pair from a denominator.

## 12. Budget

| Item | Value |
|---|---|
| Scheduled runs | **620** (310 per arm) |
| Scheduled first attempts | 620 |
| **Worst-case requests** | **1,240** (2 per run) |
| Expected requests | about 700–970 (control about 1.15 per run, as in v3; v4 about 1.1–2.0) |
| Worst case per run | about $0.340 (v3 registered: t4 $0.339796, t5 $0.34022; v4 slightly higher). Computed and registered per cell by `buildDiscoveryBenchmarkPlan` at registration |
| **Theoretical worst case for all 620 runs** | **about $211**, every attempt at the 16,000-token output ceiling |
| **Expected cost** | **about $20 if 10% of v4 runs retry; about $24 at 50%; about $28 if every v4 run retries** |
| **Hard budget** | **$50.00**. The old $14 v3 budget is **not** reused |

The expected cost is about $10 for the control plus $10–18 for v4.

**The hard budget is deliberately below the theoretical worst case** ($50 vs about $211).
- Registering $211 would authorise an implausible spend: every request at the output ceiling, about 13 times the observed output length.
- Instead, $50 is 1.8 times the pessimistic expected cost.
- As a result, the experiment **can stop before completion**, and that outcome is defined as **INCOMPLETE**, never PASS or FAIL.

**Stop rules:**
1. **Per-run worst-case authorisation (existing gate).** Before each run starts, both must hold:
   - its current worst case is within its cell's registered worst case;
   - money spent so far plus that worst case is within $50.00.

   Money spent counts each saved run at its recorded cost. An unpriced or aborted run counts at its cell's worst case.
2. **Running out of budget.** If the gate refuses a run, the experiment **stops immediately and is INCOMPLETE**. The budget cannot be raised, and continuing requires a new experiment id. It would take about 2.5 times the expected spend to reach this point.
3. **No result-based stopping.** There is no interim analysis, and no stopping for success or futility.
4. **Pausing.** Execution may pause between rounds for a provider outage or operator availability, and resumes at the next scheduled round. A pause never skips, reorders or replaces a run. Stopping for good before all 620 runs reach a terminal state makes the experiment INCOMPLETE (§9.4, 2c).
5. **Gate refusal mid-round.** If the budget gate refuses a run inside a round, the earlier runs of that round keep their results, and the experiment is INCOMPLETE (§9.4, 2g).

## 13. Reproducibility and integrity controls

1. **Frozen before the first reservation:**
   - this document, the definition `DISCOVERY_V4_RELIABILITY_EXPERIMENT` and its fingerprint;
   - the v4 contract code and its tests;
   - the per-cell worst cases;
   - the sample fingerprints.

   All are committed to `main` before any reservation. Changing any of them afterwards makes the experiment **INVALID**.
2. **The fingerprint covers:**
   - the experiment id;
   - the contract ids and the v3/v4 instruction and schema hashes;
   - the dataset SHA-256s and sample fingerprints;
   - the provider, model and settings;
   - the schedule and pairing;
   - the retry policy;
   - the attempt and run classification, including the provider-unavailable kind set;
   - the criteria, thresholds, margin, pair minimum and tolerance;
   - the budget and the per-cell worst cases.

   Every reservation and result records it.
3. **v3 control identity:** the control requests are checked against the archived v3 pins before the first run (§4).
4. **Write-once artifacts:** the reservation is written before each run and the result after, both with `wx` and never overwritten. The SHA-256 of every pre-existing file in `benchmark-results/` is recorded before each run or block and rechecked after it. Any change or deletion halts the experiment as INVALID.
5. **Per-run records:**
   - the stamp: experiment, fingerprint, index, round, dataset and contract;
   - the sample fingerprint;
   - the requested and served model;
   - every attempt's outcome, codes, `invalid_examples` reasons and `providerFailure` kind;
   - rejected and accepted raw outputs, with secrets removed;
   - the accepted taxonomy's example IDs;
   - usage and cost;
   - `assignment: "not run"`.
6. **No secrets in artifacts.** Every artifact is scanned for the API key and for `sk-ant-`, `sk-proj-` and `Bearer` strings.
7. **Offline re-evaluation.** A `--check` mode recomputes every classification, criterion and the verdict from artifacts alone, with no API calls.
8. **INVALID conditions:**
   - another fingerprint, dataset, sample fingerprint, contract, provider or served model;
   - a run made twice;
   - a v3 control request that does not match its pins;
   - an artifact changed or deleted after it was written;
   - a run executed out of registered order, or with a dataset or contract other than its registered one.
9. **Operational execution control** (an execution control, not a scientific criterion):
   - **One registered round is four runs.** Execution uses `--next-round-only`, and **each invocation executes exactly one registered round**: the next round with no reservation, and only its 4 runs.
   - **The run order inside the round is fixed** by §7.
   - **No run number may be skipped.** A round starts only if every earlier run has a reservation.
   - **There is no manual choice of dataset or contract.** The runner derives both from the schedule and accepts no override.
   - **There are no replacement runs.** A run with a reservation is never run again.
   - The budget gate (§12) and the per-run integrity checks apply **before each of the four runs**, not only once per round.
   - Authorisation is per invocation, so there are 155 invocations for the full experiment. Each invocation's report lists the four runs it executed and their terminal classes (§11.1).

## 14. Freeze rules

1. **This draft is not binding.** It becomes binding when committed together with the implementation (§3.3), the definition and fingerprint, and passing offline tests, all before the first reservation.
2. **After the first reservation,** nothing in §3–§13 may change. Any change needs a new experiment id.
3. **Archiving:** the completed artifacts and a postmortem are archived together. A FAIL or INCOMPLETE verdict is archived unchanged.
4. **v4 does not become the production default** by passing. Promotion is a separate decision.

## 15. Risks and limitations

1. **Rejecting 5-word names is the main risk.**
   - Under V4-N, **12 of the 235 names v3 accepted** in the archived experiment would be rejected. All count exactly 5 words, for example "Warm-Up Speed and Scheduling". Those names occur in **9 of v3's 20 accepted taxonomies**: 2 of 10 on t4 and 7 of 10 on t5.
   - No archived v3 taxonomy would break V4-E: every topic had 2 or 3 examples.
   - If the v4 prompt does not move names to 4 counted words or fewer, criteria 2 and 3 fail, which is a valid result.
2. **Criterion 3 tolerates no failures** at 299–472 model-response attempts.
3. **The pair minimum is tight.** 310 registered pairs leave a margin of only 10 pairs for:
   - provider-unavailable runs in either arm;
   - evaluable-invalid runs in either arm.

   A v4 invalid run already fails criterion 1. But 11 or more lost pairs, from v3-control failures and outages combined, make the experiment **INCOMPLETE** (§9.4, 2f), even if every other criterion would pass or fail.
4. **Limited generality.** Each arm repeats the **same two inputs**. The bounds describe this model on these two samples during this period, not production reliability across videos. Independence between calls is assumed.
5. **The example rule may hurt naming.** Requiring 2 examples may make the model merge topics or avoid narrow ones. This is measured only through the proxy (criteria 6 and 7).
6. **Pairs are a scheduling device, not a matched design.** The two runs of a pair get the same input but are independent calls. Pairing removes dataset and time-block variation only.
7. **Proxy metrics only.** No Jev assignment is run.
8. **Drift** over about 3 hours is possible. Balanced ordering limits its effect on the comparison.

## 16. Relation to the v3 experiment

**This is a new experiment.** It does **not**:
- modify, reopen, re-score or extend `discovery-v3-name-robustness-v1`;
- change its definition (fingerprint `sha256:17aa3db369cc0ae836655e01132d2144f6f5f7cf4b19de88117b9075b2dda4fe`), its 80 artifacts or its FAIL verdict;
- pool its runs with this experiment's.

v3 appears here only as:
- the motivation (§2);
- the frozen control contract, run fresh (§4);
- the source of the cost and variance estimates (§8, §12).

## Recorded design decisions (approved)

| # | Decision | Where |
|---|---|---|
| (a) | Execution uses `--next-round-only`, exactly one registered round per invocation | §13.9 |
| (b) | Refusals are model responses, recorded as `model_refusal` | §11.2 |
| (c) | An attempt-1 outage followed by a valid retry is eventually valid but a first-attempt failure | §11.3 |
| (d) | Implementation and configuration errors are execution errors, making the experiment INCOMPLETE | §11.1, §9.4 |
| (e) | 310 registered pairs, with a minimum of 300 complete valid pairs; fewer makes the experiment INCOMPLETE | §9.3, §9.4 |
| (f) | Raw accepted outputs and accepted example IDs are recorded, so criterion 4 can be checked independently | §3.3 |
| (g) | Thresholds: the 1.20× cost ceiling, the 1.10 requests-per-run ceiling and the $50 hard budget | §9.2, §12 |

No open item remains.
