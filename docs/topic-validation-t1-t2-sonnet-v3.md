# Topic pipeline validation: t1 (development) vs t2 (independent), Sonnet + consolidation-v3

**Status:** exploratory validation of a frozen experimental candidate. Nothing is promoted to production by this report.

- **Inputs:** 3 saved `real-consolidated` runs per dataset. No new API calls were made for this analysis.
- **Repeats:** three repeats are exploratory evidence. Means below are labelled **"avg of 3 repeats"**. They are not new benchmark scores, and no significance claims are made.

## 1. Frozen pipeline

| Stage | Configuration |
|---|---|
| Discovery | Anthropic `claude-sonnet-5-5`, contract `topic-discovery-v2`, effort `high`, seeded discovery sample (seed `t1-topics-v1/ds1`, whole topic base) |
| Consolidation (experimental) | same model, contract `topic-consolidation-v3` (RETAIN / MERGE / DROP, production `min_topic_size` = 10), at most 2 attempts |
| Assignment and topic sentiment | Jev `jev-latest` (served `jev-1.13.0`), contract `topic-assignment-v1`, question set `jev-topic-a1`, 8 batches of ≤ 25 |
| Analysis and report | production `TwoPhaseTopicDiscoverer` and `analyzeTopics`: minimum topic size, OTHER, NO_SPECIFIC_TOPIC, AC-23, HIGH_OTHER_SHARE, evidence |
| Scoring | existing full evaluator (`src/benchmark/topic-benchmark.ts`): member-Jaccard topic matching ≥ 0.5, never names |

All six runs record `topic-discovery-v2` and `topic-consolidation-v3` in their metadata. Every run had:
- the oracle gate passed;
- status `available` on the first attempt, with no retries;
- one consolidation attempt, valid first time;
- 0 failed requests;
- AC-23 valid.

**Result files** (`benchmark-results/`, untracked):

| Dataset | Run | File timestamp |
|---|---|---|
| t1 | 1 | 2026-10-06T01-58-38-547Z |
| t1 | 2 | 2026-10-06T02-02-58-518Z |
| t1 | 3 | 2026-10-06T02-04-50-024Z |
| t2 | 1 | 2026-10-06T02-23-52-912Z |
| t2 | 2 | 2026-10-06T02-25-46-602Z |
| t2 | 3 | 2026-10-06T02-27-15-801Z |

## 2. Datasets

| | t1-topics-v1 (development) | t2-topics-v1 (independent validation) |
|---|---|---|
| Version | `sha256:e44ac9d63b94ebc9` | `sha256:c0087c94db1713b2` |
| Domain | sponsored review of a fictional folding e-bike | unsponsored review of a fictional mirrorless camera |
| Comments / topic base / spam | 200 / 188 / 12 | 201 / 190 / 11 |
| Gold topics | 8 (one, `app` with 6 comments, below the minimum topic size of 10) | 9 (all ≥ 10) |
| Gold dispositions | 134 primary, 22 OTHER, 32 NST | 142 primary, 25 OTHER, 23 NST |
| Topic ≠ overall sentiment | 17 | 14 |
| Role | used while developing discovery-v2 and consolidation v1–v3, so its results are optimistic | authored independently, gold written before any provider run (see `fixtures/t2-topics-v1/leakage-audit.json`) |

t2 deliberately contains:
- adjacent but distinct topics (grip vs menus, video vs stabilization);
- broad topics that should not be split (image quality, video);
- 17 OTHER comments on small peripheral subjects: battery, cards, shutter, box contents, flash.

## 3. Aggregate metrics

Percentages are the evaluator's own per-run values. "Avg" is the plain average of the 3 repeats.

### t1-topics-v1 (development)

| Metric | Run 1 | Run 2 | Run 3 | Avg of 3 repeats | Min – max |
|---|---|---|---|---|---|
| Topic precision | 87.5% | 88.9% | 100% | 92.1% | 87.5 – 100 |
| Concept recall | 87.5% | 100% | 87.5% | 91.7% | 87.5 – 100 |
| Merge / split errors | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | – |
| Disposition accuracy | 86.2% | 88.8% | 91.5% | 88.8% | 86.2 – 91.5 |
| Primary-topic accuracy | 93.3% | 99.3% | 94.8% | 95.8% | 93.3 – 99.3 |
| OTHER accuracy (assignment level) | 9.1% | 22.7% | 59.1% | 30.3% | 9.1 – 59.1 |
| OTHER precision | 33.3% | 100% | 72.2% | 68.5% | 33.3 – 100 |
| NO_SPECIFIC_TOPIC accuracy | 93.8% | 87.5% | 93.8% | 91.7% | 87.5 – 93.8 |
| Topic sentiment accuracy | 92.0% (n=125) | 91.7% (n=133) | 92.1% (n=127) | 92.0% | 91.7 – 92.1 |
| Evidence precision | 83.3% | 91.7% | 95.2% | 90.1% | 83.3 – 95.2 |
| Example support | 100% | 96.3% | 100% | 98.8% | – |
| Max named-share error (pp) | 1.1 | 6.4 | 2.1 | 3.2 | 1.1 – 6.4 |
| Discovery → final topics (reported) | 12 → 8 (8) | 12 → 9 (8) | 12 → 7 (7) | – | – |
| Consolidation retained / merged / dropped | 6 / 4 / 2 | 8 / 2 / 2 | 6 / 2 / 4 | – | – |
| Cost (USD) | 0.0821 | 0.0840 | 0.0812 | 0.0824 | 0.0812 – 0.0840 |
| Wall-clock (approx.) | 40 s | 42 s | 37 s | 40 s | – |

### t2-topics-v1 (independent)

| Metric | Run 1 | Run 2 | Run 3 | Avg of 3 repeats | Min – max |
|---|---|---|---|---|---|
| Topic precision | 88.9% | 72.7% | 90.0% | 83.9% | 72.7 – 90.0 |
| Concept recall | 88.9% | 88.9% | 100% | 92.6% | 88.9 – 100 |
| Merge / split errors | 1 / 0 | 1 / 0 | 0 / 0 | – | – |
| Disposition accuracy | 92.1% | 86.3% | 91.6% | 90.0% | 86.3 – 92.1 |
| Primary-topic accuracy | 85.2% | 84.5% | 95.1% | 88.3% | 84.5 – 95.1 |
| OTHER accuracy (assignment level) | 52.0% | 8.0% | 44.0% | 34.7% | 8.0 – 52.0 |
| OTHER precision | 100% | 100% | 91.7% | 97.2% | 91.7 – 100 |
| NO_SPECIFIC_TOPIC accuracy | 91.3% | 91.3% | 91.3% | 91.3% | – |
| Topic sentiment accuracy | 96.7% (n=121) | 95.8% (n=120) | 95.6% (n=135) | 96.0% | 95.6 – 96.7 |
| Evidence precision | 95.8% | 88.9% | 90.0% | 91.6% | 88.9 – 95.8 |
| Example support | 100% | 97.0% | 100% | 99.0% | – |
| Max named-share error (pp) | 8.4 | 6.3 | 2.6 | 5.8 | 2.6 – 8.4 |
| Discovery → final topics (reported) | 12 → 9 (8) | 12 → 11 (9) | 12 → 10 (10) | – | – |
| Consolidation retained / merged / dropped | 7 / 4 / 1 | 10 / 2 / 0 | 8 / 4 / 0 | – | – |
| Cost (USD) | 0.0865 | 0.0906 | 0.0839 | 0.0870 | 0.0839 – 0.0906 |
| Wall-clock (approx.) | 38 s | 40 s | 36 s | 38 s | – |

**Cost and latency per phase (avg of 3 repeats, t1 / t2):**

| Phase | Cost (USD) | Latency |
|---|---|---|
| Discovery | 0.028 / 0.029 | ≈ 9.4 s / 9.5 s |
| Consolidation | 0.040 / 0.041 | ≈ 14.0 s / 13.0 s |
| Jev assignment | 0.015 / 0.017 | ≈ 93 s / 94 s, summed over ≈ 330 concurrent requests |

- Consolidation is the most expensive single call: about 48% of run cost.
- All six runs together cost about $0.51.
- Wall-clock is derived from request timestamps, so it is approximate.

**Supplementary, not an evaluator metric.** The evaluator scores OTHER on raw assignments. The report, however, folds topics below the minimum size into OTHER. For reference, the share of gold report-level OTHER comments (gold OTHER plus t1's sub-minimum `app` topic) that end up in report-level OTHER is:
- t1: 21%, 39%, 64% (avg 42%);
- t2: 76%, 52%, 44% (avg 57%).

## 4. Cross-dataset comparison

| Metric (avg of 3 repeats) | t1 development | t2 independent | Direction on t2 |
|---|---|---|---|
| Topic precision | 92.1% | 83.9% | **degrades** (−8.2 pp; wider range) |
| Concept recall | 91.7% | 92.6% | stable |
| Merge errors (sum) | 0 | 2 | **degrades** |
| Split errors (sum) | 0 | 0 | stable (none) |
| Disposition accuracy | 88.8% | 90.0% | stable |
| Primary-topic accuracy | 95.8% | 88.3% | **degrades** (−7.5 pp), almost entirely from one adjacent-topic merge |
| OTHER accuracy (assignment level) | 30.3% | 34.7% | weak on both |
| OTHER precision | 68.5% | 97.2% | improves |
| NO_SPECIFIC_TOPIC accuracy | 91.7% | 91.3% | stable |
| Topic sentiment accuracy | 92.0% | 96.0% | improves (stable on both) |
| Evidence precision | 90.1% | 91.6% | stable |
| Final topic count | 7–9 | 9–11 | higher on t2 (more topics kept) |
| Cost per run | $0.082 | $0.087 | stable |

**Does consolidation generalise? Partially.**
- **What carried over:**
  - discovery always returns the full 12-topic cap, and consolidation is what produces a compact taxonomy;
  - broad-concept merges carry over to the new domain: photo quality + colour in t2 runs 1 and 3, and folding + portability in t1 runs 1 and 3 (in the other run discovery proposed a single candidate, so there was nothing to merge); overheating was folded into video in 1/3 t2 runs;
  - no split errors anywhere.
- **What did not:**
  - On t2, consolidation drops much less (dropped 1, 0, 0 vs 2, 2, 4 on t1). Peripheral grab-bag topics survive.
  - In 2 of 3 t2 runs it merges a genuinely distinct adjacent pair (grip/handling + menus), even though discovery proposed them separately in every run.

## 5. Error analysis

Comment-level stability:

| | t1 | t2 |
|---|---|---|
| Base comments | 188 | 190 |
| Correct in all 3 runs | 153 | 139 |
| Correct in 1–2 runs | 23 | 35 |
| Wrong in all 3 runs | 12 | 16 |
| Same label in all 3 runs | 160 (85%) | 143 (75%) |

### A. Discovery and taxonomy errors

| Pattern | t1 | t2 | Stable or stochastic |
|---|---|---|---|
| **Over-merging (adjacent topics)** | none | grip/handling + menus merged by consolidation in runs 1–2 (merged topics with 32 and 28 members, 11–12 menus comments lost); discovery had them separate in 3/3 runs | stochastic (2/3), **introduced by consolidation** |
| **Peripheral topic retained** | run 1: "durability / support / ownership" (14 members, reported, unmatched); run 2: "sponsorship / review content" (8, folded to OTHER) | battery/power cluster kept in 3/3 runs: combined with overheating (9, folded to OTHER) in runs 1–2, as "battery and storage" (11, **reported**) in run 3; run 2 also "cards / shutter / connectivity" (11, reported) | battery cluster **systematic** on t2; other grab-bags stochastic |
| **Meta topic by comment type, not subject** | run 2: sponsorship/review content | run 2: viewer requests / buying questions (7, folded to OTHER) | stochastic (1/3 each) |
| **Over-splitting** | none | overheating separated from video in runs 1–2 (3 video comments moved into a small topic that the report folds into OTHER) | stochastic (2/3) |
| **Missing major topic** | none: every gold topic ≥ 10 recovered in all runs | none, except `menus` absorbed by the merge in runs 1–2 | – |
| **Valid topic dropped** | `app` (gold, 6 comments < minimum 10) dropped in runs 1 and 3. That matches production reportability (gold's own report folds it into OTHER), so the recall loss is mostly a gold artefact | none | – |

Discovery itself returned exactly 12 topics, the maximum, in all six runs. Discovery-v2 consistently over-generates and relies on consolidation to compact.

### B. Assignment errors (Jev)

- **Correct taxonomy, wrong primary topic.** Low volume, mostly at adjacent boundaries, and largely systematic:
  - t2-075, lens vignetting: lenses → image quality, 3/3;
  - t2-034, manual focus aids: autofocus → handling, 3/3;
  - t2-151, a prime lens praised: lenses → image quality, 2/3;
  - t1-064, a price-justification comment mentioning the fold: value → folding, 3/3;
  - t1-013: range → charging, 1/3.

  Several are debatable gold boundaries rather than clear model errors.
- **Wrong OTHER or NST.** This is the weakest metric (assignment-level OTHER accuracy averages about 30–35%). Causes, in order of volume:
  1. **Taxonomy propagation.** Gold OTHER comments are absorbed by unnecessary or peripheral topics: t1 run 1 has 12 of 20 OTHER misses in the durability topic; t2 run 2 has 20 of 23 misses in the cards and battery topics.
  2. **Small model topics later folded into OTHER.** These count as misses at assignment level but are OTHER in the report (see the supplementary view).
  3. **Vocabulary pull into named topics, systematic:**
     - t1-019, a train-access remark → folding;
     - t1-040, a sarcastic comparison → folding;
     - t1-182, a legal speed-cap remark → motor;
     - t2-076, a creator editing-preset question → image quality;
     - t2-141, the strap → ruggedness.
  4. **OTHER → NST.** Creator and colour comments become NST (t1-067, t1-118, t1-138, t1-187, t1-199 in 2–3 runs each).
- **Embedded instructions and fake labels steer assignment.** This is a robustness issue, not a taxonomy issue. Of the three gold-NST injection or fake-label comments that **name a topic**, two were steered into it in every run and the third in 1/3:
  - t1-036, a prompt injection naming brakes: NST → brakes, 3/3, with a **positive** topic sentiment, so it inflates that topic's positive count;
  - t2-131, a fake JSON label naming lenses: NST → lenses, 3/3;
  - t2-006, an injection naming autofocus: NST → autofocus, 1/3.

  Injections that name no topic (t1-169, t2-169) and HTML/script comments were handled correctly in 6/6 runs. Related vocabulary pull: t1-059, an incidental "charged my phone", went NST → charging in 3/3.
- **Ambiguity between adjacent topics.** On t2, the handling/menus/viewfinder boundary accounts for most stochastic primary errors (touchscreen and eye-sensor comments move between handling and viewfinder across runs).

### C. Sentiment errors

- **Overall.** Topic sentiment is the most stable component (range ≤ 1.1 pp per dataset). Errors repeat on the **same comments** in every run, so they are systematic.
- **t1 (12 distinct comments, 9 wrong in all 3 runs).** Mostly gold-neutral, mildly worded comments ("fine", "okay", "nothing to report") that are pushed to positive or negative (7 comments). Some of these are arguably gold judgement calls.
- **t2 (6 distinct comments).** Mostly very short or idiomatic praise or complaint pushed to the wrong pole or to neutral (t2-053, t2-086, t2-128, t2-137), plus one neutral fact read as positive (t2-176).
- **Topic vs overall sentiment is mostly handled.** Copying overall sentiment would score 87% (t1) and 89–91% (t2) on the same comments. The pipeline scores 92% and 96%, so it is not just copying. Each dataset has one diverging comment that fails repeatedly: t1-159, 3/3; t2-188, 2/3.

### D. Evidence and report errors

- **Example IDs.** All example IDs were valid (example-ID validity 100% in 6/6 runs). Example support fell below 100% twice, one example each (see §7).
- **Evidence coverage.** Evidence coverage and sentiment-label coverage are 100% in 6/6 runs. AC-23 is valid in 6/6.
- **Off-topic evidence.** Evidence precision is below 100% in all six runs (not only t2). Every off-topic evidence item was traced:

| Run | Off-topic evidence items | Cause |
|---|---|---|
| t1 run 1 | 4 | 3 from the unmatched "durability / support / ownership" topic (two were provider examples); 1 is t1-019 (gold OTHER) under folding |
| t1 run 2 | 2 | t1-019 under folding; t1-095 (gold OTHER) under the app topic |
| t1 run 3 | 1 | t1-019 under folding |
| t2 run 1 | 1 | t2-006, the **prompt-injection comment**, shown as autofocus evidence |
| t2 run 2 | 3 | the unmatched "cards / shutter / connectivity" topic |
| t2 run 3 | 3 | the unmatched "battery and storage" topic |

Every evidence item is a member of its topic, with the same topic sentiment as its assignment. The production evidence selection is consistent with the assignments in all six runs.

## 6. Stability analysis

- **Taxonomy topic count is not fully stable.**
  - Discovery is perfectly stable at 12, the cap.
  - Final counts vary: t1 7–9 (reported 7–8), t2 9–11 (reported 8–10).
  - The variation comes from consolidation.
- **Precision and recall variability.**
  - t1 precision spans 12.5 pp and t2 spans 17.3 pp; recall spans 12.5 pp and 11.1 pp.
  - With 7–11 topics, one extra or missing topic moves precision by 9–14 pp, so these ranges amount to about one topic per run.
  - Acceptable for exploration. Too wide to guarantee a stable topic list for a user across reruns.
- **Primary-topic variability is mostly downstream of taxonomy variability.**
  - t2 primary ranges 84.5–95.1%. The low runs are exactly the two runs with the handling + menus merge.
  - The run without the merge (95.1%) matches t1 (93.3–99.3%).
  - Given a fixed taxonomy, Jev assignment is close to deterministic: the same comments fail in the same way.
- **Consolidation decisions vary materially.**
  - Retained / merged / dropped: t1 6/4/2, 8/2/2, 6/2/4; t2 7/4/1, 10/2/0, 8/4/0.
  - The same discovery candidates (handling vs menus, overheating vs video, battery cluster) are merged in one run and retained in another.
- **Sentiment is stable** (≤ 1.1 pp range). Its errors are systematic, not stochastic.

## 7. Evidence warning diagnosis

**Where the warnings come from.** Both warnings are evaluator outcomes from `perfectionFailures` in `src/benchmark/topic-benchmark.ts`. They are not production validation failures:
- **"evidence incomplete or off-topic"** fires when `evidenceCoverage`, `evidenceSentimentCoverage` or `evidencePrecision` is below 1, as computed by the report metrics in the same file. In all six runs only `evidencePrecision` is below 1. An evidence item counts as correct only if its comment's gold disposition is the gold concept matched to the topic.
- **"example IDs not valid and supporting"** fires when `exampleIdValidity` or `exampleSupport` is below 1 (`taxonomyMetrics`). Validity was always 1. Support was below 1 in t1 run 2 (26/27) and t2 run 2 (32/33).

**Diagnosis.**
1. **"evidence incomplete or off-topic" is a real consequence of model errors plus a known limitation of evidence selection. It is not a mapper, validator or evaluator bug.**
   - (a) **Unmatched reported topics.** When consolidation keeps a peripheral topic with ≥ 10 members, every evidence item for it is off-topic by definition. This explains 9 of the 14 off-topic items: all of t1 run 1's topic-level items and all of t2 runs 2–3.
   - (b) **Misassigned comments selected as evidence.** `selectTopicEvidence` in `src/core/topics/evidence.ts` fills one slot per present sentiment label and ranks each label group by confidence, then provider example, then **lowest comment ID**. Jev returns no confidence, and the three provider examples rarely cover the neutral label. So the neutral slot goes to the lowest-ID neutral member, which is content-blind.
     - That is why t1-019, a gold-OTHER comment misassigned to folding, is folding's neutral evidence in **all three** t1 runs.
     - It is also why the prompt-injection comment t2-006 became autofocus evidence in the one t2 run where Jev put it there.
     - The selector behaves exactly as specified. The weakness is the lack of any quality signal for the tie-break.
2. **"example IDs not valid and supporting" is a real model-output disagreement between the consolidation step and Jev. It is not a deterministic bug.**
   - **t1 run 2.** The consolidated topic "app electronics and reliability" cites t1-035 (gold folding) as an example. The decision record shows a `build_durability` candidate merged into that topic, so the example was carried over from a merged candidate. Jev, agreeing with gold, assigned it to folding.
   - **t2 run 2.** The retained "viewer requests / buying questions" topic cites t2-008, a request for a video test (gold video). Jev assigned it to the overheating topic.
   - **The enabling mechanism is the expected behaviour of the experimental contract.**
     - Consolidated example IDs are validated only against the union of candidate example IDs: `consolidationExampleIds` in `src/core/topics/consolidation-contract.ts`, used by `runConsolidationAttempts` in `src/benchmark/topic-discovery-consolidated.ts`.
     - The production discoverer then re-validates them only against the discovery sample (`ConsolidatingTaxonomyGenerator` in `src/benchmark/topic-real-consolidated.ts`, then `validateTopicTaxonomy`).
     - Neither step can check, or is meant to check, that an example is topically supported. That is what the evaluator's `exampleSupport` measures.
3. **Not deterministic in consolidation, and no implementation defect found.**
   - Example-ID validity is 100%.
   - Every evidence item is a topic member with the matching sentiment.
   - AC-23 holds.
   - The warnings appear on t1 too, and their counts follow the taxonomy and assignment errors.
4. **Diagnostic gaps (measurement, not correctness):**
   - **No candidate taxonomy in the results.** Result files don't keep the discovery candidate taxonomy or the raw consolidation output. Retained / merged / dropped is inferred from shared example IDs (`consolidationDecisions` in `src/benchmark/topic-discovery-consolidated.ts`), which is a heuristic. In particular, an example carried over from a merged candidate cannot be told apart from a deliberate merge.
   - **OTHER is scored before the report fold.** The evaluator's OTHER accuracy is assignment-level, so comments in model topics that the report folds into OTHER count as misses. Read with the report-level shares, this explains much of the low OTHER accuracy.

## 8. Production-readiness assessment

| Component | Rating | Basis |
|---|---|---|
| Taxonomy discovery (`topic-discovery-v2`) | **Needs hardening** | It proposes every gold topic with at least 10 comments as a separate candidate in every run on both datasets (the t2 menus topic is lost only later, in consolidation), with no splits and valid definitions and examples. But it always returns 12 topics, the cap, so its output is not usable without consolidation. |
| Consolidation (`topic-consolidation-v3`) | **Needs hardening** | It compacts 12 → 7–11 topics and its broad-concept merges carry over to the new domain. On t2: it merges a distinct adjacent pair in 2/3 runs (the main cause of the −7.5 pp primary drop), keeps peripheral grab-bag topics in 3/3 runs, drops much less than on t1, and its decisions vary materially across repeats. |
| Assignment (Jev, `topic-assignment-v1`) | **Needs hardening** | Primary accuracy is about 93–99% given a correct taxonomy, and it is near-deterministic. OTHER handling is weak, partly from taxonomy propagation and partly from vocabulary pull. Embedded instructions and fake JSON labels that name a topic steer assignment (2 of 3 such comments in every run, the third in 1/3). |
| Topic sentiment | **Strong** | 92% / 96%, the most stable component, and better than copying overall sentiment. Remaining errors are systematic, on mild neutral wording and short idiomatic comments, some of them debatable gold calls. |
| Evidence and report generation | **Needs hardening** | AC-23, coverage and the evidence-to-assignment link are correct in 6/6 runs, and no implementation bug was found. The content-blind lowest-ID tie-break can surface misassigned comments, including an injection comment, as evidence, and off-topic evidence follows taxonomy errors. |

No component is rated **not acceptable**. The closest is user-visible: a prompt-injection comment shown as evidence. It happened once in 6 runs and needs a fix before production.

## 9. Recommendation: next engineering step

Treat t2 as **consumed** for tuning: this report analyses its errors in detail. Any change aimed at those errors needs a new, independently authored held-out set (`t3`) before it can be called validated.

1. **First, model-independent instrumentation** (no prompt, contract or model change, so results stay comparable):
   - persist the discovery candidate taxonomy and the raw consolidation output in `real-consolidated` result files;
   - add a clearly labelled report-level OTHER / disposition metric next to the existing assignment-level ones;
   - add a per-comment stability summary across repeats.

   This removes the guesswork in §7(4) and makes the next experiment measurable.
2. **Then, one targeted consolidation experiment**, a new contract version and not an edit of v3, aimed at the two transferable failure modes:
   - merging adjacent topics that are distinct concerns (a physical vs software interface);
   - keeping heterogeneous peripheral grab-bag topics.

   Evaluate it on t1 + t2 for regressions and confirm on t3. Accept it only if precision and primary improve without losing recall.
3. **In parallel, model-independent hardening** of the evidence tie-break in `selectTopicEvidence` (prefer provider examples and representative members over lowest ID) and of injection/fake-label handling on the assignment side. Both are visible in the report regardless of the discovery model.
