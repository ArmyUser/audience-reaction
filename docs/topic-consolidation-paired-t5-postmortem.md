# Postmortem: paired consolidation experiment v3 vs v4 on t5

**Type:** read-only analysis. No API call was made, and no pair was run, replaced or added. No code, prompt, contract, dataset, preregistration or result file was changed.

**Experiment:** `paired-consolidation-v3-v4-t5-v1`, definition `sha256:697e2e73965540c5e2e47f4406ffc8c0007e9de6958c37105ee326d0aa0a0d51` (`docs/topic-consolidation-paired-t5-preregistration.md`).

**Inputs** (`benchmark-results/`):

| Pair | Result file | Reservation |
|---|---|---|
| 1 | `2026-10-06T15-57-36-132Z-…-pair-1.json` | `2026-10-06T15-57-36-131Z-…-pair-1-reserved.json` |
| 2 | `2026-10-06T16-06-38-444Z-…-pair-2.json` | `2026-10-06T16-06-38-443Z-…-pair-2-reserved.json` |
| 3 | `2026-10-06T16-08-28-404Z-…-pair-3.json` | `2026-10-06T16-08-28-403Z-…-pair-3-reserved.json` |

**Comparison data** (Part C only): the t1–t4 result files and the archived t4 paired smoke test.

## A. Official result (binding)

### Verdict: **INCOMPLETE**

This comes from the registered evaluator:
```bash
npx tsx src/benchmark/paired-consolidation-cli.ts --dataset t5-topics-v1 --check --experiment paired-consolidation-v3-v4-t5-v1
```
It made no API calls and exited with code 2.

| Pair | Arm order | Status | Discovery attempts | Pairing validation |
|---|---|---|---|---|
| 1 | v3 → v4 | **available** | 1 (valid) | valid |
| 2 | v4 → v3 (never run) | **unavailable_discovery** | 2: `invalid_taxonomy` [`invalid_topic_name`], then `invalid_taxonomy` [`invalid_topic_name`] | valid (as an unavailable pair) |
| 3 | v3 → v4 | **available** | 1 (valid) | valid |

What the rules require:
- **Pair 2 was not scored.** No arm ran, and no consolidation or Jev request was made. The pair contributes to neither arm's mean, and it is not converted to zero.
- **No replacement is allowed.** All three scheduled numbers are reserved, and the CLI refuses any further pair.
- **No PASS/FAIL criterion is evaluated.** Only 2 of 3 scheduled pairs are available, and §5 of the preregistration makes that INCOMPLETE with no fallback interpretation.
- **Every file matches the registration.** All three pair files and all three reservations carry the registered definition fingerprint, and pairing validation passes for each.
- **No secrets were stored.** No key-shaped string appears in any t5 file.

## B. Descriptive analysis of the two available pairs (NON-BINDING)

> **NON-BINDING DESCRIPTIVE DATA.** These numbers come from 2 of 3 scheduled pairs. They are not an experiment result, not a PASS or FAIL, and not a substitute for the INCOMPLETE verdict.

Per pair, using the evaluator's per-run values:

| Metric | P1 v3 | P1 v4 | P3 v3 | P3 v4 | Mean v3 | Mean v4 | Δ (v4 − v3) |
|---|---|---|---|---|---|---|---|
| Topic precision | 75.00% | 81.82% | 75.00% | 81.82% | 75.00% | 81.82% | +6.82 pp |
| Topic (concept) recall | 100% | 100% | 100% | 100% | 100% | 100% | 0 |
| Primary-topic accuracy | 88.11% | 88.11% | 87.41% | 88.81% | 87.76% | 88.46% | +0.70 pp |
| Topic sentiment accuracy | 98.41% | 98.41% | 98.40% | 98.43% | 98.41% | 98.42% | +0.01 pp |
| Disposition accuracy | 81.44% | 84.02% | 84.02% | 86.08% | 82.73% | 85.05% | +2.32 pp |
| OTHER accuracy | 11.54% | 23.08% | 15.38% | 34.62% | 13.46% | 28.85% | +15.38 pp |
| NO_SPECIFIC_TOPIC accuracy | 48.00% | 56.00% | 64.00% | 60.00% | 56.00% | 58.00% | +2.00 pp |
| Merge / split errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 |
| Discovered → final topics | 12 → 12 | 12 → 11 | 12 → 12 | 12 → 11 | | | |
| Retained / merged / dropped | 12 / 0 / 0 | 11 / 0 / 1 | 12 / 0 / 0 | 11 / 0 / 1 | | | |
| Gold topics matched | 9 of 12 | 9 of 11 | 9 of 12 | 9 of 11 | | | |
| Arm cost | $0.0620 | $0.0596 | $0.0605 | $0.0598 | | | |
| Requests (consolidation / Jev) | 1 / 367 | 1 / 357 | 1 / 363 | 1 / 353 | | | |

How each arm ran:
- **Shared discovery:** each available pair used exactly one discovery attempt, which was accepted.
- **Arms:** both arms consumed that pair's taxonomy fingerprint, made no discovery request of their own (one frozen-discovery call each), and needed one consolidation attempt with no retries.

| | Pair 1 | Pair 3 |
|---|---|---|
| Discovery fingerprint | `sha256:46af5958…e43312` | `sha256:a102bcd5…1a43` |
| Taxonomy fingerprint (both arms) | `sha256:85d2683f…3a1f` | `sha256:e36486b4…7107` |

**Cost:**

| | Cost |
|---|---|
| Pair 1 | $0.150782 |
| Pair 2 (discovery only, 2 requests) | $0.055910 |
| Pair 3 | $0.148969 |
| **Experiment total** | **$0.355661** of the $5.25 budget |

## C. Discovery failure investigation (pair 2)

### C.1 What the stored raw output shows

The paired runner stores the raw text of every rejected attempt. I re-ran the production validator (`validateTopicTaxonomy`, tn1 normalisation) on both stored outputs offline, and it reproduces the recorded issues exactly.

| Attempt | Rejected name (as written by the model) | Words as written | Words after tn1 normalisation | Validator issue |
|---|---|---|---|---|
| 1 | "Video Requests and Follow-Up Tests" (key `content_requests`) | 5 | **6** ("video requests and follow up tests") | `invalid_topic_name`, index 11 |
| 2 | "Heat-Up and Warm-Up Time" (key `heat_up_time`) | 4 | **6** ("heat up and warm up time") | `invalid_topic_name`, index 2 |

- **The rule violated:** a topic name must be 1–5 words after tn1 normalisation (`MAX_TOPIC_NAME_WORDS = 5`, `isValidNormalizedTopicName` in `src/core/topics/normalize.ts`; spec.md §7.4).
- **How the word count grows:** tn1 rule 4 turns every run of non-letter, non-digit characters into a space. A hyphen therefore splits a compound into two words: "Follow-Up" becomes "follow up", and "Heat-Up" becomes "heat up".
- **Everything else was valid:** all other 11 names in each attempt were valid. Commas don't add words, because they are absorbed into the existing word boundary. Keys, definitions and examples raised no issues.

### C.2 Model output, not benchmark wiring

The validator is the production validator, and its result on the stored raw text matches the recorded issue codes. The raw outputs are the model's text before any benchmark processing. So the failure comes from the model output measured against the documented rule. There was no wiring defect.

There is still a contract-level mismatch between what the model is told and what is counted:
- **The discovery prompt** asks for "a neutral label of 1-5 words (at most 60 characters)". It doesn't say that hyphenated or slashed compounds count as several words.
- **The retry feedback** sends only the code, its description ("a name was empty or longer than five words") and the offending key (`content_requests`). It doesn't send the name or the counted word total.
- **The retry changed the name but not the habit.** The model shortened the flagged topic to "Video Content Requests" (3 words). It also renamed another topic to "Heat-Up and Warm-Up Time", which looks like 4 words and normalises to 6. The model consistently treats a hyphenated compound as a single word.

### C.3 Comparison with the successful discoveries (pairs 1 and 3)

The accepted taxonomies run the same risk and pass only narrowly:

| | Pair 1 | Pair 3 |
|---|---|---|
| Hyphenated names | "Warm-Up Speed and Scheduling" (5 after normalisation); "Built-in Grinder Performance" (4) | "Warm-up Time and Scheduling" (5); "Built-in Grinder Performance" (4) |
| Names at exactly 5 normalised words | 3 of 12 | 3 of 12 |

Overall, 4 of the 24 accepted t5 names contain a hyphen. In each of them the normalised count is higher than the visible count, and two of them reach the limit exactly. The topic structure is the same in all three discoveries: 12 candidates with near-identical concepts. Pair 2 differs only in wording that crossed the boundary twice.

### C.4 Across datasets

Discovery attempt outcomes in every stored topic result:

| Dataset / runs | Rejected discovery attempts | Codes | Rejected names available? |
|---|---|---|---|
| t1 (real, discovery-only, discovery-consolidated, real-consolidated v3) | 0 validation failures; 5 `provider_error` attempts in 3 runs | `provider_error` only | n/a |
| t2 (3 real-consolidated v3) | 0 | – | n/a |
| t3 (3 real-consolidated v3) | 0 | – | n/a |
| t4 (3 v3 + 3 v4 real-consolidated) | **7** (the first attempt in all 6 runs; both attempts in v4 run B3) | `invalid_topic_name` only | **no** (only the issue code was stored) |
| t4 paired smoke test | 0 | – | – |
| t5 paired (3 pairs) | **2** (both attempts in pair 2) | `invalid_topic_name` only | **yes** (raw output stored) |

- **Every validation failure was a name failure.** All 9 rejected discovery attempts recorded across t1–t5 (7 on t4, 2 on t5) are `invalid_topic_name`, and the t1–t3 runs have none. The five-word topic-name limit is therefore the **only** cause of validation failures observed so far.
- **The hyphen mechanism is proven for t5.** Both rejected t5 names hit 6 words because of hyphen splitting.
- **For t4 the mechanism is not proven.** The rejected t4 names were not stored.
  - None of the 67 accepted t4 names contains a hyphen, but 13 (19%) sit at exactly 5 normalised words, often compound "X, Y and Z" names.
  - So the t4 failures are consistent with the same 5-word limit, but not necessarily with hyphens.
- **t4 and t5 run closest to the limit.** The share of accepted names at exactly 5 normalised words is t1 8%, t3 3%, t4 19% and t5 25%. (t2 results predate the instrumentation that stores candidate names.)

**Conclusion:** the five-word topic-name limit is the dominant, and so far only, cause of discovery validation failures. On t5 the specific trigger is that tn1 counts hyphenated compounds as several words, while neither the prompt nor the retry feedback tells the model so.

## D. Treatment interpretation (two available pairs only)

| Question | Pair 1 | Pair 3 | Reading |
|---|---|---|---|
| Does v4 drop the intended comment-form / addressee topic? | yes: dropped "Video Content and Requests" | yes: dropped "Video Requests and Production" | consistent in 2 of 2 |
| Does v4 drop a valid topic? | no: 9/9 gold topics matched, recall 100% | no: 9/9, recall 100% | none observed |
| Does v4 introduce a merge or split error? | no (0/0) | no (0/0) | none observed |
| Primary-topic regression? | none (88.11% in both arms) | none (+1.40 pp for v4) | none observed |
| Topic sentiment regression? | none (98.41% in both arms) | none (+0.03 pp for v4) | none observed |

**What the dropped topic contained** (v3 assignments):
- **Pair 1:** 14 comments: 8 gold OTHER (all 4 addressee-trap requests and all 4 score cards, the comment-form trap), 4 NO_SPECIFIC_TOPIC, and 2 legitimate topic requests (extraction, upkeep).
- **Pair 3:** 12 comments: the same 8 gold OTHER, 2 NO_SPECIFIC_TOPIC, and the same 2 topic requests.

**Where v4 sent those comments:**
- the two topic requests went to their correct topics;
- most of the rest went to OTHER or NO_SPECIFIC_TOPIC;
- some genuine OTHER comments went to NO_SPECIFIC_TOPIC instead;
- one addressee-trap request in pair 3 went to the design topic.

**What v4 did not change:** two candidate topics that match no gold topic survive in both arms of both pairs:
- **"Design, Size and Delivery/Water Tank"** bundles 7–8 peripheral OTHER side subjects (packaging, colours, cable, counter space and so on) with a few topic comments.
- **"Overall Verdict and Value"** collects generic focus evaluations (NO_SPECIFIC_TOPIC), price comments and a few topic comments.

These two topics cap precision at 9 of 11 matched topics (81.82%) for v4 in both pairs.

**Evidence supporting the v4 hypothesis (non-binding):**
- In both available pairs, v4 dropped exactly the topic grouped by comment form and addressee, and nothing else.
- It did so without losing a gold topic and without a merge, split, primary-topic or sentiment regression.
- Precision rose by +6.82 pp in each pair, and OTHER accuracy roughly doubled.

**Inconclusive because pair 2 is unavailable:**
- whether this behaviour holds in a third independent discovery;
- every registered criterion, all of which need 3 available pairs.

**Outside the v4 hypothesis:**
- The v4 rule did not remove the peripheral side-subject bundle or the generic-verdict topic.
- In both available pairs, v4 precision (81.82%) was below the registered 88% floor of criterion 1. This is a descriptive observation, not a verdict, and no counterfactual is drawn.

## E. Recommendation

**2. FIX DISCOVERY VALIDATION/ROBUSTNESS BEFORE A NEW PAIRED EXPERIMENT.**

Why:
- Discovery availability is what decided this experiment, not the treatment. 1 of 3 t5 pairs and 6 of 6 t4 runs lost at least one discovery attempt to the same limit.
- Another paired experiment with unchanged discovery has a material chance of ending INCOMPLETE again, wasting a fresh hold-out.
- Freezing v3 and stopping (option 1) would ignore a treatment signal that is consistent across both available pairs (non-binding).
- Running again without changing discovery (option 3) would repeat the known failure mode.

How discovery robustness should be handled first (a new discovery contract version; tn1 and the five-word production rule stay as specified):
1. **State the counting rule explicitly in the discovery prompt**, for example: "words are counted after replacing hyphens, slashes and other punctuation with spaces; 'Follow-Up' counts as two words". Ask for names of at most 4 such words as a safety margin, or forbid hyphenated compounds in names.
2. **Make the retry feedback actionable** for `invalid_topic_name`. Include the offending name and its counted word total, so the retry fixes the actual problem instead of moving it to another topic.
3. **Keep the raw rejected output stored** for every discovery path, not only the paired runner. Without it, the t4 failures can't be diagnosed.
4. **Measure discovery reliability on its own, offline of any treatment comparison**, before a new hold-out is spent. Use repeated discovery-only runs on the already observed t4 and t5. The rejection rate and the share of names at the boundary are the metrics, against an acceptance threshold registered in advance.
5. **Only then register a new paired experiment** on a new, unseen hold-out, with the same no-replacement rules. Separately from discovery, it should decide whether the 88% precision floor still fits a v4 rule that does not address peripheral side-subject bundles. That is a design question for the next preregistration, not a reinterpretation of this one.

The v4 contract, v3 (still the frozen baseline) and the INCOMPLETE verdict of this experiment remain unchanged.
