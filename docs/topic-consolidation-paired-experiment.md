# Paired consolidation experiments: design and infrastructure

**Status:** infrastructure only. No paired experiment is registered (`PAIRED_EXPERIMENTS` is empty), no live run was made, and no dataset was created or changed. v3 remains the frozen baseline, and v4 is not promoted.

**Code:**
- `src/benchmark/topic-paired-consolidation.ts`: the mode itself, plus its validation and evaluation.
- `src/benchmark/paired-consolidation-cli.ts`: the command line.
- `tests/benchmark/topic-paired-consolidation.test.ts`: offline tests.

---

## 1. Why the v4 experiment is officially FAIL

The pre-registered evaluator (`docs/topic-consolidation-v4-experiment.md`) scored the first three runs per arm on t4, in timestamp order. An unavailable run scored 0 on every rate metric.

- **The run that failed.** The third v4 run (11:12:01Z) lost both discovery attempts to `invalid_topic_name`, so it never reached consolidation.
- **Its effect on the scores.** Scored as 0, it pulled the v4 means to:
  - precision 60.0%;
  - recall 66.7%;
  - topic sentiment 64.1%;
  - primary-topic accuracy 64.7%.

  Four of the five criteria failed.
- **The verdict is binding.** It may not be revised, and no replacement run may be substituted.

See `docs/topic-consolidation-v4-postmortem.md`.

## 2. Why the v4 hypothesis remains INCONCLUSIVE

- **The decisive failure was independent of the treatment.**
  - Discovery runs before consolidation, so the v4 prompt was never sent in the failed run.
  - Both arms sent byte-identical discovery requests.
  - The first discovery attempt failed in **all six** t4 runs, in both arms. Which arm lost a whole run was chance.
- **Both valid v4 runs were strong:** precision 90%, recall 100%, no merge errors, and primary and sentiment accuracy at or above v3.
  - The form/addressee clause dropped the meta-topic in both runs, as intended.
  - The bundle clause had no observable effect.
- **Two runs on one dataset** cannot establish the rule.

**The methodological flaw:** discovery was inside each arm. A discovery failure therefore scored 0 against one consolidation contract and decided a consolidation verdict.

## 3. The paired design

```text
DISCOVERY  (once per pair; fixed retry policy; every attempt recorded, raw rejected output kept)
    │
    ▼
validated discovery taxonomy  ── fingerprinted: dataset, sample, prompt, settings, taxonomy
    ├── arm A: consolidation (baseline, e.g. v3) → Jev assignment → topic sentiment → report → full evaluator
    └── arm B: consolidation (candidate, e.g. v4) → Jev assignment → topic sentiment → report → full evaluator
```

- **Discovery runs once per pair.** `runPairedDiscovery` uses the production discovery request, validator and retry (`runDiscoveryAttempts`). The discovery prompt (topic-discovery-v2) is unchanged; its fingerprint is pinned in the tests.
- **Each arm is the existing real-consolidated path, unchanged.** `runRealConsolidatedBenchmark` gained one optional hook, `discoveryOverride`. When it is absent, the suite runs exactly as before.
  - Proof: an offline capture of 20 real-consolidated runs (2 datasets × 2 contracts × 5 discovery/consolidation scenarios), covering outputs, Markdown, file names and every provider request, plus the plan and the notice. All are byte-identical before and after the change.
- **Inside an arm, discovery is served by `FrozenDiscoveryGenerator`.**
  - It returns the pair's validated taxonomy and never calls a provider.
  - It refuses any request for a different sample or context.
  - Arm results therefore record **0 discovery requests**, and the validator requires that.
- **Only the consolidation contract differs.**
  - Jev assignment, topic sentiment, the report, `min_topic_size`, evidence selection and the evaluator metrics are the existing code.
  - Each arm runs exactly one repeat.
- **Arm order alternates by pair index** (`armOrderOf`): odd pairs run the baseline first, even pairs the candidate first. The CLI continues the index from the pairs already saved.
- **One result file per pair:** `…-<dataset>-paired-consolidation-…-<baseline>-vs-<candidate>-pair-<n>.json`.
  - It is written with an exclusive flag, so it can never overwrite anything.
  - The existing v4 experiment evaluator only reads `-real-consolidated-` files, so it never picks up pair files (tested).

## 4. Fixed discovery retry policy: `paired-discovery-retry-v1`

| | |
|---|---|
| Attempts | at most **2** (`MAX_TOPIC_ATTEMPTS`, the production rule) |
| Retried | every rejected attempt: unparseable output, invalid taxonomy (e.g. `invalid_topic_name`), provider error |
| Feedback | the production structured validation feedback, exactly as `analyzeTopics` sends it |
| Exhausted | the **whole pair is unavailable** |

- **Why the production rule:** the paired discovery has the same failure distribution as production discovery, so the discovery-failure rate the experiment reports is the production rate.
- **Changing the policy** requires a new policy id. The validator rejects any pair recorded under another policy.

## 5. Unavailable pairs, and unavailable arms

**An unavailable pair** (`status: "unavailable_discovery"`) is one whose discovery has no valid taxonomy after the policy is exhausted. For such a pair:
- no consolidation, Jev or evaluator call is made;
- the result contains no arm;
- it is **never scored for either contract**. It is counted and listed by the evaluator as discovery unavailability.

**An unavailable arm** is different. Discovery was valid, but that arm's consolidation or assignment failed. The two contracts received identical input, so this is a **treatment outcome**: it is scored with the existing evaluator convention, 0 on every rate metric.

**An oracle-gate failure** (`status: "oracle_gate_failed"`) means the harness or dataset is broken. No provider is called, and the pair is invalid.

## 6. Strict pairing validation (`validatePairedResult`)

A comparison is **refused (INVALID)**, not skipped, if any pair fails a check. For an available pair:

1. **Discovery integrity.** The stored taxonomy hashes to its taxonomy fingerprint. The discovery fingerprint recomputes from the dataset, sample, prompt, settings and taxonomy fingerprints. The accepted attempt carries the taxonomy fingerprint.
2. **Dataset, sample and prompt.** Each attempt's fingerprints match the pair's. With the dataset at hand, they also match the current dataset and the current topic-discovery-v2 prompt (first-attempt and retry instructions are fingerprinted separately).
3. **Retry policy.** It is `paired-discovery-retry-v1`, with 1 to 2 attempts. An unavailable pair must have used all attempts and contain no arms.
4. **Exactly one arm per contract.** The two contracts differ, and both are known.
5. **Each arm consumed the pair's discovery.** The fingerprint of every discovery candidate recorded in the arm's own instrumentation equals the pair's taxonomy fingerprint.
6. **No discovery inside an arm.** Each arm made 0 discovery requests.
7. **Discovery settings.** Provider, model, contract and effort or thinking level are identical to the pair's.
8. **Assignment settings.** Model, contract, question set and batch size are identical to the pair's.
9. **Report and evaluator settings.** Parameters, sample seed, matching rule and the recorded evaluator constants are identical between the arms.
10. **Only the consolidation contract differs:** `comparableSettings` is identical for both arms.

Across the pairs of one experiment, the dataset, contracts, discovery, assignment, evaluator, discovery inputs and retry policy must also be identical.

## 7. Discovery diagnostics recorded per attempt

Each attempt records:
- attempt number;
- outcome (`valid`, `invalid_taxonomy`, `provider_error`) and provider failure kind;
- sanitised validation issue codes;
- whether feedback was sent, and latency;
- provider and model;
- the prompt fingerprint actually sent, plus the dataset and sample fingerprints;
- the validated taxonomy fingerprint (accepted attempt only);
- **the raw model text of every rejected attempt** (`rawOutput`): up to 100,000 characters, with its full length and a truncation flag.

A provider error has no text, so its raw output is null.

**Secrets:** the discovery and Jev keys are scrubbed from raw output before it is stored (tested). The result contains no key, and nothing is printed.

## 8. What must be pre-registered before the next live experiment

All of the following must be committed before the **first** live pair. Most of it goes into `PAIRED_EXPERIMENTS` (a `PairedExperimentDefinition`) and its pre-registration document:

1. **Dataset:** a new, frozen hold-out (t5), with:
   - its id and full SHA-256 version;
   - the independence audit result;
   - the oracle result;
   - its own commit.
2. **Contracts:** baseline and candidate, with their instruction fingerprints pinned in tests.
3. **Providers:** discovery provider, model and settings; assignment model and settings.
4. **Retry policy id:** `paired-discovery-retry-v1`, or a new one, defined before any run.
5. **`pairsRequired`:** the scored pairs are the **first** that many *available* pairs in timestamp order. They are never selected for quality, and never re-selected.
6. **`maxUnavailablePairs`:** the discovery-unavailable pairs tolerated before the required pairs are reached. More than that ends the comparison as `DISCOVERY_UNRELIABLE`: no conclusion about consolidation.
7. **Criteria and thresholds:** precision, recall, new merge errors, and the no-regression metrics (and whether they have a tolerance).
8. **How unavailable arms are treated** (section 5) and the arm-order rule (section 3).
9. **A total cost budget, and a stop rule:** what happens on `DISCOVERY_UNRELIABLE`, and whether any extension is allowed. An extension is only allowed if it is pre-registered.
10. **The analysis plan:**
    - the binding verdict;
    - the reported diagnostics (mean paired differences, discovery-unavailability rate, per-arm metrics);
    - a statement that none of it is changed after results are seen.

## 9. Why t4 is now a regression set, not a hold-out

The hold-out property of t4 is spent:
- Its gold, its error structure and the live v3/v4 outputs on it have now been inspected in detail: the postmortem traced individual comments and named the surviving bundle.
- Its discovery behaviour has been characterised: the first attempt failed 6/6, and names cluster at the five-word limit.

Any future contract, prompt or retry policy would be designed with that knowledge, so a t4 result could no longer be an independent test.

From now on, t4 serves alongside t1–t3 as a **regression and development set**:
- it is useful for checking that a new contract does not break known-good behaviour;
- it is useful for exercising the paired infrastructure;
- its results are exploratory and never a binding verdict.

The next binding experiment needs t5, built and audited before anyone sees results on it.

## 10. Commands

```bash
npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset t4-topics-v1 --pairs 3
```
Prints the plan only; NO API CALLS, and the exit code is 2.

```bash
npx tsx src/benchmark/paired-consolidation-cli.ts --dataset t4-topics-v1 --check
```
Validates saved pairs offline; NO API CALLS.

```bash
npx tsx src/benchmark/paired-consolidation-cli.ts --dataset <t5> --check --experiment <registered id>
```
The binding evaluation, once an experiment is registered.

Adding `--live` to the first command runs pairs. It needs the keys in `.env` and a worst case within `--max-cost-usd`. Its plan is a conservative bound, because each arm's estimate still includes a discovery call the arm never makes. **It was not run.**

## 11. Setup statement

No live API call was made. All checks used fake provider clients, a trapped global `fetch`, or CLI invocations without `--live` and without keys.

No dataset, prompt, contract, Jev path, report, evaluator metric or existing result file was changed: all 35 result files and 11 dataset files are byte-identical before and after.
