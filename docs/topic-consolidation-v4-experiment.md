# Experiment: topic-consolidation-v4 (subject coherence)

**Status:** PRE-REGISTERED. Set up offline; no live API call was made during setup. The success criteria below were written and committed to code (`V4_EXPERIMENT` in `src/benchmark/topic-consolidation-experiment.ts`) **before any live v4 result existed**. They must not change after results are seen.

**Motivation:** the t1/t2/t3 validation (`docs/topic-validation-t1-t2-t3-sonnet-v3.md`). The largest cross-dataset error cause (37% of disposition errors) was candidates that are not one coherent subject surviving consolidation:
- meta-topics grouped by comment form or addressee;
- bundles of unrelated side subjects.

## 1. Frozen baseline (arm A)

| Stage | Configuration |
|---|---|
| Discovery | Anthropic `claude-sonnet-5-5`, `topic-discovery-v2` (config `discovery`, effort `high`) |
| Consolidation | **`topic-consolidation-v3`**, still the default; byte-for-byte unchanged, with SHA-256 fingerprints of its instructions pinned in `tests/benchmark/topic-consolidation-v4.test.ts` |
| Assignment and topic sentiment | Jev `jev-latest`, `topic-assignment-v1` / `jev-topic-a1`, batches of ≤ 25 |
| Report and scoring | production `analyzeTopics` and report (minimum topic size 10, evidence selection unchanged), and the unchanged full evaluator |

The default `real-consolidated` run is byte-identical to before this change. That covers the offline fake-provider runs (evaluator report, phases, usage, instrumentation, the exact system prompts sent, file name, markdown, plan) and the CLI plan outputs.

## 2. The single change (arm B): `topic-consolidation-v4`

v4 is v3 with **exactly one inserted block**, placed directly after the v3 DROP rule, plus the contract name. Nothing else changes:
- the RETAIN, MERGE and DROP wording;
- the evidence standard;
- the principles;
- the fields;
- the output format;
- the retry and issue codes;
- the data message, the output schema, validation and the retry rule.

A test checks that v4 minus that block equals v3, line for line.

Inserted text (generic: no domain, product or benchmark vocabulary):

```text
- DROP also, however many comments support it, a candidate that does not represent one coherent subject or concern of the audience because it is primarily:
  (a) a grouping of comments by their form or addressee rather than by what they are about, for example requests, questions, suggestions, praise, reactions or feedback addressed to the creator or about the video or channel itself; such comments belong to the subject they discuss, or to no topic;
  (b) a bundle of unrelated side subjects that are merely mentioned in the same comments or listed together, rather than different aspects of one coherent audience concern.
  A candidate whose parts are different aspects of one shared concern is coherent: judge it by the other rules, not by this one.
```

**Not changed:**
- discovery;
- merging, beyond the unchanged v3 rule;
- Jev assignment and topic sentiment;
- report logic;
- `min_topic_size`;
- evidence selection (no confidence scoring);
- the evaluator.

**Code:**
- `src/core/topics/consolidation-contract.ts`: `TOPIC_CONSOLIDATION_CONTRACT_V4`, and an optional `contract` parameter that defaults to v3.
- `ContractTaxonomyConsolidator` and `ConsolidatingTaxonomyGenerator`: carry the contract through.
- `runRealConsolidatedBenchmark`: a `consolidationContract` dependency.
- `buildRealConsolidatedPlan`: an optional contract.
- `topics-cli.ts`: `--consolidation v3|v4`, accepted only with `--suite real-consolidated`; v3 is the default.
- Result files: v3 file names are unchanged; v4 files get the suffix `-topic-consolidation-v4`, so no file is ever overwritten.

## 3. Hold-out dataset t4-topics-v1 and its independence

`fixtures/t4-topics-v1/comments.json`, version `sha256:58e225f986238591` (full SHA-256 `58e225f986238591de8687faab59b9445e5d22088d1a3666382ba5e2043292fd`).

- **Domain:** an independent creator's review of a fictional language-learning service (Lingomoor, not sponsored). It's a new product, vocabulary and topic structure, unrelated to the e-bike, camera and board game of t1–t3.
- **Size:** 201 comments, topic base 189, 12 spam / off-topic, minimum topic size 10.
- **Dispositions:** 135 assigned to a named topic, 28 OTHER, 26 NO_SPECIFIC_TOPIC.

| Gold topic | Comments |
|---|---|
| Streaks and motivation | 22 |
| Lesson design and pacing | 20 |
| Pronunciation feedback | 18 |
| Live tutor sessions | 15 |
| Chatbot conversation practice | 14 |
| Languages and course depth | 13 |
| Grammar explanations | 12 |
| Progress tracking and placement | 11 |
| Offline use and syncing | 10, exactly at the minimum |

**Design:**
- **Adjacent but distinct:** live tutors vs chatbot practice, lesson design vs grammar explanations, motivation vs progress tracking.
- **Grouped:** one broad topic (streaks, leagues, badges, goals, reminders).
- **Peripheral, stays OTHER:** 13 comments on account, billing, privacy and device side subjects that are easy to bundle.
- **Comment-form trap (OTHER):** 4 viewer questions to the creator.
- **Addressee trap (OTHER):** 4 requests for other content. Requests *about* a subject belong to that subject.
- **Sentiment:** 17 comments where topic sentiment differs from overall sentiment.
- **Adversarial:** questions, requests, sarcasm, slang, prompt injections, fake JSON, HTML and checkbox markup, and a comment that names the service without addressing it.

**Independence methodology** (same standard as t3):
- **Gold written first.** The gold was written by hand before any provider run on t4. No result file was consulted.
- **Lexical audit** (`tests/topics-benchmark/holdout-independence-audit.ts`). It uses exact, containment, content-word Jaccard and trigram Jaccard checks at the same 0.4 thresholds, against:
  - everything the t1 audit covers;
  - t1, t2 and t3 comments and gold;
  - the replay recordings;
  - every topic prompt (discovery, assignment, and both consolidation contracts v3 and v4);
  - every stored live model output (about 62,000 strings).
- **8 structural checks:** IDs, gold labels, schema fields, provider/model/contract vocabulary, prompt text and model output.
- **Result** (`fixtures/t4-topics-v1/leakage-audit.json`): 0 violations (max token Jaccard 0.333, trigram 0.345), 8/8 checks passed, and no t4 result file existed at audit time. Two automated rounds forced 11 rewrites:
  - 9 comments;
  - 1 description that named the contract;
  - 1 comment that used a model name ("haiku").
- **Oracle:** the gate passes with every metric at 100%, and all 18 offline scenarios meet their stated expectations.

## 4. Fixed success criteria (binding, t4 only)

The verdict covers the **first three** saved runs of each arm on t4, in timestamp order: never the best three, never re-selected. Each metric is the **arithmetic mean** of the evaluator's per-run values. An unavailable run is kept and scores 0 on every rate metric.

v4 **passes only if all five hold**:

| # | Criterion | Exact rule |
|---|---|---|
| 1 | Topic precision ≥ 88% | mean v4 `topicPrecision` ≥ 0.88 |
| 2 | Topic recall ≥ 92% | mean v4 `conceptRecall` ≥ 0.92 |
| 3 | Zero new merge errors relative to v3 | Σ v4 `mergeErrors` − Σ v3 `mergeErrors` ≤ 0 |
| 4 | No regression in topic sentiment accuracy | mean v4 `topicSentimentAccuracy` ≥ mean v3 (no tolerance) |
| 5 | No regression in primary-topic accuracy | mean v4 `primaryTopicAccuracy` ≥ mean v3 (no tolerance) |

- Criteria 4 and 5 are deliberately strict: "no regression" has no tolerance, so normal run-to-run noise in either direction can decide them.
- The comparison is **INVALID** if the arms differ in anything but the consolidation contract: dataset version, discovery provider / model / contract / effort, assignment model / contract / question set / batch size, sample seed, topic parameters or matching rule.
- It is **INCOMPLETE** while either arm has fewer than three runs.
- Any dataset other than t4 gives an exploratory, non-binding comparison. t1–t3 serve only as regression checks.

**Also reported per arm** (mean, min – max, sd), not part of pass/fail:
- disposition, OTHER and NO_SPECIFIC_TOPIC accuracy;
- `reportOtherAccuracy` (diagnostic);
- taxonomy size before and after consolidation;
- retained / merged / dropped;
- evidence precision;
- cost;
- summed request latency per phase.

## 5. Commands for the live comparison (not run yet)

Run order (pre-registered): alternate the arms, so time-of-day or provider drift affects both equally: A, B, A, B, A, B. About $0.09 per run, so about $0.5 in total. Each run stays far below the default $1 limit.

```bash
npm run benchmark-topics -- --suite real-consolidated --dataset t4-topics-v1 --provider anthropic --model claude-sonnet-5-5 --consolidation v3 --live --repeats 1
```
```bash
npm run benchmark-topics -- --suite real-consolidated --dataset t4-topics-v1 --provider anthropic --model claude-sonnet-5-5 --consolidation v4 --live --repeats 1
```

After six runs (three per arm), evaluate offline. This makes no API call and writes no files. Exit code 0 means PASS, 1 means FAIL or INVALID, 2 means INCOMPLETE.

```bash
npx tsx src/benchmark/consolidation-experiment-cli.ts --dataset t4-topics-v1
```

Optional regression checks on the development sets (exploratory, never binding): the same two commands with `--dataset t1-topics-v1`, `t2-topics-v1` or `t3-topics-v1`, then the evaluator with that `--dataset`.

## 6. Pass and fail

- **PASS:** all five criteria hold. v4 may become the next candidate for further validation; it is not promoted to production by this experiment.
- **FAIL:** any criterion fails. v3 remains the frozen baseline, and the result is reported as is. No criterion, threshold, run selection or dataset may be changed after results are seen. A new idea requires a new contract version and a new pre-registered hold-out.
- **INVALID or INCOMPLETE:** no conclusion. Fix the run set (for example a missing run) without changing the criteria.

## 7. Setup statement

No live API call was made during setup. All checks used fake providers, a trapped global `fetch`, or CLI invocations without `--live` and without keys. No existing result file or dataset was modified.
