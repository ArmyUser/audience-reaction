# Postmortem: topic-consolidation-v4 on t4-topics-v1

**Type:** read-only analysis. No API call was made. No code, prompt, contract, dataset, evaluator or result file was changed, and no replacement run was created.

**Inputs:**
- the six saved t4 runs in `benchmark-results/`, from 2026-10-06T11-01-44Z to 11-12-01Z;
- the pre-registered evaluator, `npx tsx src/benchmark/consolidation-experiment-cli.ts --dataset t4-topics-v1` (exit code 1);
- the gold labels in `fixtures/t4-topics-v1/comments.json`;
- for comparison, the nine t1/t2/t3 v3 runs.

**Pre-registration:** `docs/topic-consolidation-v4-experiment.md`.

**Run order:** the timestamps confirm the pre-registered alternation A, B, A, B, A, B. The evaluator did not flag the comparison as INVALID: the arms differ only in the consolidation contract.

| Arm | Run | File timestamp | Status |
|---|---|---|---|
| A (v3) | A1 | 11-01-44-015Z | available |
| B (v4) | B1 | 11-05-08-433Z | available |
| A (v3) | A2 | 11-07-25-102Z | available |
| B (v4) | B2 | 11-09-13-722Z | available |
| A (v3) | A3 | 11-11-00-740Z | available |
| B (v4) | B3 | 11-12-01-341Z | **unavailable** (discovery failed twice with `invalid_topic_name`) |

Total cost of the six runs was about $0.60.

---

## A. Official experiment result

### Verdict: **FAIL** (binding)

Means are over the first three runs per arm, and B3 counts as 0.

| # | Criterion | v4 mean | v3 mean | Result | Exact reason |
|---|---|---|---|---|---|
| 1 | Topic precision ≥ 88% | 60.0% (0.900, 0.900, 0) | 81.8% | **FAIL** | (0.9 + 0.9 + 0) / 3 = 0.600 < 0.88 |
| 2 | Concept recall ≥ 92% | 66.7% (1, 1, 0) | 100% | **FAIL** | (1 + 1 + 0) / 3 = 0.667 < 0.92 |
| 3 | Zero new merge errors | Σ 0 | Σ 0 | pass | 0 − 0 = 0 ≤ 0 |
| 4 | No regression, topic sentiment | 64.1% (0.962, 0.962, 0) | 96.1% | **FAIL** | 0.641 < 0.961 |
| 5 | No regression, primary topic | 64.7% (0.978, 0.963, 0) | 95.6% | **FAIL** | 0.647 < 0.956 |

**Valid v4 runs:**
- B1 (`2026-10-06T11-05-08-433Z…-topic-consolidation-v4.json`);
- B2 (`2026-10-06T11-09-13-722Z…-topic-consolidation-v4.json`).

In both, the first discovery attempt failed with `invalid_topic_name`, the retry succeeded, and consolidation succeeded on its first attempt.

**Unavailable v4 run:** B3 (`2026-10-06T11-12-01-341Z…-topic-consolidation-v4.json`):
- Both discovery attempts were rejected with `invalid_topic_name` (`phases[0].taxonomyCalls[*].discovery.outcome = "invalid_taxonomy"`).
- Consolidation was `not_run`, with 0 consolidation requests and 0 assignment requests.
- The run spent $0.054 on discovery only.

**Why B3 scores 0.** The pre-registration says (`V4_EXPERIMENT.unavailableRunScore = 0`, experiment doc §4): "An unavailable run is kept and scores 0 on every rate metric." The rule was fixed before any result existed, for two reasons:
- an unavailable pipeline delivers no report to the user;
- dropping failed runs would turn the experiment into a survivor comparison.

The rule applies whatever the cause of the failure.

**Why no replacement run may be substituted:**
- The pre-registration selects "the first three saved runs of each arm, in timestamp order: never the best three, never re-selected."
- Running a fourth v4 run now and using it in place of B3 would be selection after seeing the outcome. It is exactly the optional stopping that pre-registration exists to prevent.
- It would be asymmetric: only the arm that lost would get another draw.
- §6 of the experiment doc already settles this: "FAIL: … v3 remains the frozen baseline … No criterion, threshold, run selection or dataset may be changed after results are seen. A new idea requires a new contract version and a new pre-registered hold-out."

**Not a counterfactual verdict.** Sections B and C below use B1 and B2 to understand the hypothesis. They are not a recomputed verdict and do not soften the FAIL.

---

## B. Scientific interpretation

### B.1 Evidence about the subject-coherence rule itself

**Candidates seen and the fate v4 gave them.** These come from `instrumentation…candidate` and `consolidation.decisions`. v4 merged nothing.

| Run | Discovery candidates | Dropped by v4 | Retained, not matching any gold topic |
|---|---|---|---|
| B1 | 12 | `video_content_requests` ("Video content requests"); `privacy_data` ("Privacy and data handling", 2 example comments) | `pricing_billing_account` ("Pricing, billing and account") |
| B2 | 11 | `video_content_requests` ("Video content requests") | `pricing_account` ("Pricing and account management") |
| A1–A3 (v3) | 11 each | none | the requests meta-topic **and** the pricing/billing/account bundle, in every run |

**Were the drops correct?**

- **The comment-form / addressee candidate (rule clause (a)) was dropped in 2 of 2 valid runs.** It is a meta-topic defined by whom the comment addresses ("Viewers asking the creator to review, demonstrate or test…"). Its best member overlap with any gold topic was 0.04–0.05 (Jaccard) in every v3 run. v3 kept it 3/3, so this drop is the change v4 was designed to produce.

- **`privacy_data` (B1) was also a correct drop.** Its two examples, t4-009 and t4-023, are gold OTHER (peripheral). The result file records no reason for the drop: the consolidation output schema has no per-decision rationale. With only 2 example comments it may have been dropped by the unchanged v3 evidence rule rather than by the new block. It cannot be attributed to clause (b).

- **The bundle candidate was not dropped, in 2 of 2 valid runs.** This is the pricing/billing/account candidate (gold: peripheral side subjects that stay OTHER). The definitions it received list "subscription cost, plans, auto-renewal, charges, refunds, cancellation, account deletion, support (and privacy)".
  - The model evidently judged it "one shared concern", which the rule's escape clause permits.
  - It is the **only** reason precision in B1 and B2 is 0.90 rather than 1.00.
  - Clause (b) therefore showed **no observable effect** on t4.

**Was any valid gold topic dropped?** No. Concept recall is 1.00 in B1 and B2, and every one of the nine gold topics matched with Jaccard ≥ 0.53.

**Did v4 introduce merge errors?** No: merge and split errors are 0 in every run of both arms.

Both arms broadened the offline topic into "offline mode and technical issues", which absorbed login and install comments (Jaccard 0.53–0.69 in both arms). That happens in discovery, is identical across arms, and is not scored as a merge error.

**The mechanism behind the primary-accuracy gain is directly visible.** In v3, three gold-topic comments that are requests *about a subject* were pulled into the meta-topic:

| Comment | Text | Gold topic | Lost to the meta-topic in |
|---|---|---|---|
| t4-055 | "Could you review the Portuguese course specifically?" | course catalog | v3 3/3 |
| t4-119 | "Could you show a clip from one of the tutor sessions?" | tutors | v3 3/3 |
| t4-118 | "…walk through one full lesson…" | lessons | v3 2/3 |

That is 8 primary misses across the three v3 runs, and 0 in v4. Once the meta-topic was dropped, Jev assigned all three to their subject topics, exactly as the rule's text predicts ("such comments belong to the subject they discuss").

**What the rule did not fix.**
- The four "requests for other content" trap comments (t4-042, 056, 070, 084; gold OTHER) moved from the meta-topic (wrong) to grammar or lessons (also wrong).
- The OTHER accuracy did not change. The four "questions to the creator" traps were treated the same in both arms.
- Whether a request for different content belongs to a subject or to OTHER is decided by Jev at assignment, not by consolidation.

### B.2 Evidence about discovery and provider robustness

| | t1 / t2 / t3 (9 v3 runs) | t4 v3 arm (3 runs) | t4 v4 arm (3 runs) |
|---|---|---|---|
| First discovery attempt rejected (`invalid_topic_name`) | **0 / 9** | **3 / 3** | **3 / 3** |
| Retry also rejected (run unavailable) | 0 / 0 | 0 / 3 | 1 / 3 |

**Evidence that the failure is independent of the consolidation contract:**
1. **Order of stages.** Discovery runs before consolidation. In B3, consolidation was never called (0 consolidation requests), so the v4 prompt was never sent in the failed run.
2. **Identical requests.** The discovery requests are identical across arms:
   - every t4 run, in both arms, used exactly 7,742 input tokens on attempt 1 and 8,165 on attempt 2;
   - the offline test suite asserts that both arms send byte-identical discovery and Jev requests (`tests/benchmark/topic-consolidation-v4.test.ts`).
   - Each run is a separate CLI process, so no state passes from a v4 consolidation call into a later discovery call.
3. **The v3 arm fails the same way.** The identical first-attempt failure occurred in all three v3 runs.

So the v4 consolidation prompt **cannot plausibly** have increased discovery invalidity. This is evidence, not hypothesis. The failure is independent of the treatment, and which arm lost a run was a matter of chance: 5 of 6 retries succeeded, and the one that did not happened to fall in arm B.

**Is it stochastic formatting or a systematic problem?** Evidence:
- **First-attempt failure is systematic, and specific to t4:** 6/6 on t4 versus 0/9 on t1–t3, with the same discovery contract, model and effort.
- **The retry is stochastic:** it succeeded in 5 of 6 runs.
- `invalid_topic_name` means a normalised topic name was empty or longer than five words (`MAX_TOPIC_NAME_WORDS = 5`, `src/core/topics/normalize.ts`).
- **Corroborating signal.** Among the final topic names that survived (a proxy, since rejected outputs are not stored), t4 names sit at the 5-word limit far more often than elsewhere:

| Dataset | Share of 5-word names | Count |
|---|---|---|
| t4 | 19% | 10 / 53 |
| t2 | 10% | 3 / 30 |
| t1 | 4% | 1 / 24 |
| t3 | 3% | 1 / 35 |

Examples: "lesson design and learning effectiveness", "pricing billing and account issues".

Hypothesis, **not verified**:
- t4's subject structure invites compound names ("X, Y and Z") that tip over five words after normalisation (punctuation becomes spaces).
- The retry feedback names the issue, and the model usually shortens them.

The exact rejected names cannot be checked. The result files store only the issue code (`topics: null` for rejected attempts), not the raw rejected discovery output. This is the largest evidence gap in the postmortem.

### B.3 Evidence about consolidation behaviour

Totals per valid run:

| | v3 (A1–A3) | v4 (B1, B2) |
|---|---|---|
| Discovery candidates | 11 | 12, 11 |
| Final topics | 11 | 10, 10 |
| Retained / merged / dropped | 11 / 0 / 0 | 10 / 0 / 2 and 10 / 0 / 1 |

- The difference between arms is exactly the drop of the comment-form meta-topic, plus a narrow privacy candidate in B1.
- Neither arm merged anything; on t4 discovery already produced the right granularity.
- v4 consolidation succeeded on the first attempt in both runs, with no retry and no unavailability.
- Its latency was comparable to v3 (14.1 s and 9.8 s per call).

### B.4 Evidence about Jev assignment and topic sentiment

| Run | Primary-topic misses (of 135) | Topic-sentiment misses among correctly assigned | Topic-sentiment accuracy |
|---|---|---|---|
| A1 v3 | 6 | 5 | 0.9612 |
| A2 v3 | 6 | 5 | 0.9612 |
| A3 v3 | 6 | 5 | 0.9612 |
| B1 v4 | 3 | 5 | 0.9621 |
| B2 v4 | 5 | 5 | 0.9615 |

**Primary-topic accuracy.** v4 removed the meta-topic losses described in B.1. Its remaining extra misses come from the retained bundle:
- t4-090 lost to it in B1 and B2 (and in A2 and A3);
- t4-191 in B2 only.

**Topic sentiment.** The same core comments are missed in every run, in both arms (t4-077, 083/125, 110, 143, 147). The tiny accuracy differences come entirely from the denominator, which is the number of correctly assigned comments. There is **no evidence that v4 affected Jev's sentiment judgement**, in either direction.

**Other diagnostic metrics** (not part of pass/fail):

| Metric | v3 A1–A3 | v4 B1, B2 |
|---|---|---|
| Disposition | 0.873, 0.857, 0.831 | 0.868, 0.868 |
| OTHER | 0.25, 0.18, 0.14 | 0.25, 0.21 |
| NO_SPECIFIC_TOPIC | 0.88, 0.85, 0.69 | 0.85, 0.88 |
| Evidence precision | 0.963, 0.963, 0.867 | 0.963, 0.867 |

All of these are within the v3 range.

### B.5 Do the valid v4 runs meet the thresholds individually?

| Criterion | B1 | B2 | Margin |
|---|---|---|---|
| Precision ≥ 0.88 | 0.900 ✓ | 0.900 ✓ | One extra unmatched topic would give 9/11 = 0.818 ✗ |
| Recall ≥ 0.92 | 1.000 ✓ | 1.000 ✓ | Comfortable |
| Merge errors ≤ v3 (0) | 0 ✓ | 0 ✓ | — |
| Sentiment ≥ v3 mean 0.9612 | 0.9621 ✓ | 0.9615 ✓ | +0.0003 to +0.0009, under one comment; noise |
| Primary ≥ v3 mean 0.9556 | 0.9778 ✓ | 0.9630 ✓ | +1 to +3 comments, with an identified mechanism (B.1) |

Both valid runs individually meet all five thresholds. That is **not** the verdict; see A.

- The precision margin is a single topic.
- The sentiment "pass" is noise-level.
- n = 2.

### B.6 Does the evidence support the hypothesis?

The hypothesis is: "Candidate topics that are grouped by comment form/addressee or bundle unrelated side subjects should be dropped."

- **Clause (a), form or addressee: supported in 2 of 2 valid runs.**
  - The meta-topic was dropped every time.
  - No valid topic was lost.
  - The primary-accuracy gain follows the predicted mechanism.
  - But n = 2, on one dataset.
- **Clause (b), bundles: not supported.** The one bundle candidate on t4 survived in both v4 runs, exactly as in v3. Either the model reads it as one coherent concern, which the rule's escape clause allows, or the rule's wording is too weak to override that reading. These runs cannot tell the two apart.
- **Reliability.** The run-level unreliability came from discovery, not from the rule (B.2). It says nothing about the rule, positive or negative.

On balance, half of the hypothesis has favourable but tiny-sample evidence, and the other half has no observable effect. Nothing in the data refutes the rule, and nothing establishes it.

---

## C. Is the evaluator's treatment of unavailable runs appropriate? (No change made)

**What it gets right:**
- It was fixed in advance.
- It is conservative.
- It treats availability as part of product quality.
- It avoids survivorship bias.

As a binding rule for this experiment, it stands.

**Where it is a weak instrument for *this* question,** which is the effect of consolidation:

1. **It scores an upstream, treatment-independent failure against one arm.** With a per-run unavailability rate of about 1/6 on t4 (1 of 6 observed), the chance that an arm of three runs contains at least one unavailable run is about 42%. That figure is a rough estimate from a single observed failure.
2. **One unavailable run decides the absolute criteria.**
   - A single 0 among three runs caps the mean at 0.667, so criteria 1 and 2 cannot pass however good the other runs are.
   - The same failure in the baseline arm would instead make criteria 4 and 5 easy to pass.
   - The outcome therefore depends heavily on which arm discovery happens to fail in.
3. **It is internally inconsistent on merges.** An unavailable run contributes 0 merge errors, which *favours* the failing arm on criterion 3 while it is penalised on every other criterion.
4. **The rejected discovery output is not kept,** so a run lost this way cannot be diagnosed afterwards (B.2).

These points are lessons for designing the next experiment. They are not grounds to revise this one.

---

## Final conclusions

1. **OFFICIAL EXPERIMENT STATUS: FAIL.** It is binding: the first three v4 runs by timestamp, with the unavailable B3 scored 0 as pre-registered. v3 remains the frozen baseline. No run will be substituted.

2. **HYPOTHESIS STATUS: INCONCLUSIVE.**
   - The comment-form / addressee clause behaved exactly as intended in both valid runs. It dropped the meta-topic, recovered the subject-request comments it had absorbed, and lost no valid topic.
   - The bundle clause had no observable effect: the one bundle survived in both runs.
   - The evidence is two runs on one dataset, and the sentiment "non-regression" is noise-level.
   - The failure that decided the verdict is independent of the treatment and says nothing about the rule.

3. **RECOMMENDED NEXT STEP: INVESTIGATE DISCOVERY ROBUSTNESS BEFORE ANY NEW CONSOLIDATION EXPERIMENT.**
   - On t4, topic-discovery-v2 rejected its first attempt in 6 of 6 runs (0 of 9 on t1–t3) and lost 1 of 6 runs entirely. That is the dominant, treatment-independent source of variance; any consolidation experiment run on top of it will mostly measure discovery luck.
   - The investigation needs the rejected discovery output persisted (diagnostic only) so the cause of `invalid_topic_name` can be confirmed rather than inferred.
   - **Single most important change before any future consolidation experiment (v5):** both arms must consume the *same* validated discovery taxonomy in each paired run. Discovery is called once per pair and fed to both contracts, so an upstream failure removes the pair symmetrically rather than scoring 0 against one arm. The discovery failure rate must be measured and reported as its own metric, not folded into the consolidation verdict.
