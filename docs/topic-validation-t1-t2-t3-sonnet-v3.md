# Topic pipeline validation: t1 + t2 + t3, Sonnet with consolidation-v3

**Analysis only.** No code, prompts, contracts, datasets or result files were changed.

- **Inputs:** 9 saved `real-consolidated` runs (3 per dataset).
- **Repeats:** three repeats per dataset are exploratory evidence. "Avg" means the plain average of the repeats. It is not a new benchmark score, and no significance claims are made.
- **Earlier analysis:** this report supersedes the t1/t2 analysis in `docs/topic-validation-t1-t2-sonnet-v3.md` and keeps its definitions.

## 1. Frozen pipeline and inputs

| Stage | Configuration (identical in all 9 runs) |
|---|---|
| Discovery | Anthropic `claude-sonnet-5-5`, `topic-discovery-v2`, effort `high` |
| Consolidation (experimental) | same model, `topic-consolidation-v3`; production `min_topic_size` 10 |
| Assignment and topic sentiment | Jev `jev-latest` (served `jev-1.13.0`), `topic-assignment-v1` / `jev-topic-a1` |
| Scoring | unchanged full evaluator (`src/benchmark/topic-benchmark.ts`) |

| Dataset | Role | Version | Base / spam | Gold topics | Result files (`benchmark-results/`) | Schema |
|---|---|---|---|---|---|---|
| t1-topics-v1 (folding e-bike) | development (prompts were iterated on it) | `sha256:e44ac9d63b94ebc9` | 188 / 12 | 8 (one, `app`, below the minimum size) | `2026-10-06T01-58-38-547Z`, `02-02-58-518Z`, `02-04-50-024Z` | v1 |
| t2-topics-v1 (mirrorless camera) | first independent set | `sha256:c0087c94db1713b2` | 190 / 11 | 9 | `2026-10-06T02-23-52-912Z`, `02-25-46-602Z`, `02-27-15-801Z` | v1 |
| t3-topics-v1 (co-op board game) | final hold-out | `sha256:41e90795c48cf637` | 192 / 12 | 9 (`solo` exactly at the minimum, 10) | `2026-10-06T10-22-21-047Z`, `10-25-38-764Z`, `10-27-11-252Z` | v2 (instrumented) |

All 9 runs share these properties:
- the oracle gate passed and status was `available` on the first analysis attempt;
- consolidation was valid on its first attempt;
- there were 0 failed requests;
- AC-23 is valid, and HIGH_OTHER_SHARE is correct (never expected, never raised).

For the v1 files (t1, t2), the run diagnostics were rebuilt from the stored evaluator runs. The discovery candidates were not recorded for them, so their retained / merged / dropped decisions are inferred only.

## 2. Aggregate metrics

### Per dataset (avg of 3 repeats, with min – max; sd is the population sd over 3 runs)

| Metric | t1 (dev) | t2 (independent) | t3 (hold-out) | Pooled avg of 9 |
|---|---|---|---|---|
| Topic precision | 92.1% (87.5 – 100, sd 5.6) | 83.9% (72.7 – 90.0, sd 7.9) | **74.5%** (66.7 – 81.8, sd 6.2) | 83.5% |
| Concept recall | 91.7% (87.5 – 100) | 92.6% (88.9 – 100) | **96.3%** (88.9 – 100) | 93.5% |
| Merge / split errors (per run) | 0,0,0 / 0,0,0 | 1,1,0 / 0,0,0 | 0,0,0 / 0,0,1 | – |
| Disposition accuracy | 88.8% (86.2 – 91.5) | 90.0% (86.3 – 92.1) | 85.4% (85.4 – 85.4) | 88.1% |
| Primary-topic accuracy | 95.8% (93.3 – 99.3) | 88.3% (84.5 – 95.1) | 88.4% (81.9 – 91.7) | 90.8% |
| Topic sentiment accuracy | 92.0% (91.7 – 92.1, sd 0.2) | 96.0% (95.6 – 96.7, sd 0.5) | 96.9% (96.2 – 97.5, sd 0.5) | 95.0% |
| Copying overall sentiment would score | 87.3% | 90.2% | 88.0% | – |
| OTHER accuracy (evaluator, assignment level) | 30.3% (9.1 – 59.1) | 34.7% (8.0 – 52.0) | **2.7%** (0 – 4.0) | 22.5% |
| OTHER precision | 68.5% | 97.2% | 100% | – |
| `reportOtherAccuracy` (diagnostic, report level) | 41.7% (21 – 64) | 57.3% (44 – 76) | **20.0%** (8 – 40) | 39.7% |
| NO_SPECIFIC_TOPIC accuracy | 91.7% (87.5 – 93.8) | 91.3% (constant) | 84.1% (82.6 – 87.0) | 89.0% |
| Max named-share error (pp) | 3.2 (1.1 – 6.4) | 5.8 (2.6 – 8.4) | 4.3 (2.1 – 7.3) | 4.4 |
| Share in unmatched reported topics (pp) | 2.5 (0 – 7.4) | 3.9 (0 – 5.8) | **9.5** (5.2 – 18.2) | 5.3 |
| OTHER share error (pp) | 8.3 | 4.0 | 6.9 | 6.4 |
| Evidence precision | 90.1% (83.3 – 95.2) | 91.6% (88.9 – 95.8) | 79.9% (69.7 – 86.7) | 87.2% |
| Evidence coverage / sentiment coverage | 100% / 100% | 100% / 100% | 100% / 100% | – |
| Example-ID validity / support | 100% / 98.8% | 100% / 99.0% | 100% / 99.0% | – |
| Topics: discovery → consolidated (reported) | 12→8 (8), 12→9 (8), 12→7 (7) | 12→9 (8), 12→11 (9), 12→10 (10) | 12→12 (10), 12→11 (10), 12→12 (11) | – |
| Consolidation retained / merged / dropped | 6/4/2, 8/2/2, 6/2/4 | 7/4/1, 10/2/0, 8/4/0 | **12/0/0**, 10/2/0, **12/0/0** | – |
| Cost per run (USD) | 0.082 (0.081 – 0.084) | 0.087 (0.084 – 0.091) | 0.085 (0.083 – 0.088) | 0.085 |
| Wall-clock per run (approx.) | 40 s | 38 s | 43 s | 40 s |

**Cost and latency by phase (avg across all 9 runs):**

| Phase | Cost (USD) | Latency |
|---|---|---|
| Discovery | ≈ 0.028 | ≈ 10 s |
| Consolidation | ≈ 0.041 | ≈ 14 s (the most expensive single call) |
| Jev assignment | ≈ 0.016 | ≈ 95 s, summed over ≈ 340 concurrent requests |

All 9 runs together cost $0.76.

### Stability by dataset

| | t1 | t2 | t3 |
|---|---|---|---|
| Same gold-space label in all 3 runs | 160/188 (85%) | 143/190 (75%) | 145/192 (76%) |
| Jev label stability where the taxonomy is not the cause | 160/161 (99.4%) | 143/151 (94.7%) | 142/143 (99.3%) |
| Topic sentiment identical across runs (comments whose topic was correct in all 3 runs) | 122/125 | 116/117 | 116/116 |
| Taxonomy size after consolidation | 7–9, unstable | 9–11, unstable | 11–12 (consolidation is a near no-op) |
| Consolidation decisions across repeats | vary | vary materially (the grip+menus merge in 2/3) | stable, but because almost nothing is changed |

**Verdict on taxonomy stability.** Discovery is stable in size: exactly 12 topics, the cap, in **9/9** runs. Consolidation is the unstable stage. Jev assignment and topic sentiment are near-deterministic given a taxonomy.

## 3. Cross-dataset comparison

- **Degrades, from development to hold-out:**
  - topic precision (92.1 → 83.9 → 74.5%);
  - the number of candidates consolidation drops (8 → 1 → 0 over 3 runs);
  - OTHER, at both assignment and report level, on t3;
  - evidence precision on t3;
  - the unmatched named share on t3.
- **Stable or improves:**
  - concept recall (91.7 → 92.6 → 96.3%);
  - topic sentiment (92 → 96 → 97%);
  - NO_SPECIFIC_TOPIC (about 84–92%);
  - cost and latency;
  - coverage and AC-23;
  - adjacent-topic separation on t3: rules vs difficulty, solo vs player count, and art vs components vs theme were kept apart in 3/3 runs.
- **Pattern:** the pipeline **finds** the right topics on unseen domains, but **does not remove the wrong ones**. Precision falls while recall rises, the signature of an over-inclusive taxonomy.

## 4. Error attribution (310 disposition errors over 9 runs)

Every gold-vs-predicted disposition difference was attributed to one cause. Comments in an unmatched topic are charged to that topic, classified by what it is.

| Cause | t1 | t2 | t3 | All | Share |
|---|---|---|---|---|---|
| **A1. Peripheral grab-bag topic retained** (gold-OTHER side subjects bundled into one named topic) | 14 | 22 | 38 | **74** | 24% |
| **A2. Meta topic by comment form or addressee** (requests and feedback to the creator, sponsorship / review content) | 8 | 7 | 27 | **42** | 14% |
| A3. Hybrid peripheral + fragment (overheating + battery, t2 runs 1–2) | – | 18 | – | 18 | 6% |
| A4. Fragment of a gold topic left unmerged (setup vs play length, t3 run 3) | – | – | 23 | 23 | 7% |
| B1. Adjacent gold topics merged (grip + menus, t2 runs 1–2) | – | 24 | – | 24 | 8% |
| B2. Sub-minimum gold topic dropped (t1 `app`, 6 comments) | 11 | – | – | 11 | 4% |
| C. Residual Jev assignment, with the taxonomy correct | 35 | 29 | 40 | 104 | 34% |
| D. Label-like or injection comment steered into the topic it names | 3 | 5 | 6 | 14 | 5% |

- **A1 + A2 (non-subject topics surviving consolidation): 116 of 310 errors (37%).** This is the single largest cause and the only one present in all three datasets. With A3 and A4, **157 errors (51%) come from candidates that consolidation should have dropped or merged but did not.**
- **The residual Jev errors (C) are spread out:**
  - gold OTHER pulled into a named topic by vocabulary;
  - creator-content OTHER read as NO_SPECIFIC_TOPIC;
  - a few comments moving between adjacent topics;
  - several debatable gold boundary calls.

  None of these are concentrated, and they repeat on the same comments, so they are systematic but low-volume.

## 5. Classification of weaknesses

### A. Systematic model / pipeline weaknesses

1. **Consolidation does not remove non-subject candidates (the main root cause).**
   - Discovery always fills the 12-topic cap. It reliably adds:
     - a peripheral bundle: t1 durability / support / ownership; t2 battery / cards / shutter; t3 price / crowdfunding / shipping or editions / add-ons;
     - a meta topic by comment form: t1 sponsorship / review content; t2 viewer requests; t3 video content requests, in **3/3** runs.
   - Consolidation-v3 retained them. Its drops by dataset are 8 → 1 → 0.
   - The v3 criteria (recurrence, salience, distinctness, `min_topic_size`) never test whether a candidate is **one subject**. A bundle of unrelated side matters, or a grouping by comment form, passes every v3 test once it is near `min_topic_size`.
   - These topics absorb gold OTHER and NO_SPECIFIC_TOPIC comments. On t3, assignment-level OTHER accuracy collapses to 2.7%: Jev is *correct* to put a price comment in a "price" topic once that topic exists, and its OTHER precision stays at 100%.
2. **Prompt-injection / fake-label steering on the Jev side.** Comments that name a topic in an instruction or a fake JSON label land in that topic (5% of errors; 1–2 comments per run, the same ones every run). Low volume, but such comments can then be shown as evidence.
3. **Topic sentiment: polarising mild or neutral wording, and short idioms.** Systematic and small (5–12 distinct comments per dataset). Topic-vs-overall divergence is handled well: 126 of 132 diverging comments with the correct topic got the correct topic sentiment.

### B. Dataset-specific failures

- **t2:** adjacent grip/handling and menus merged by consolidation (2/3 runs). This did **not** recur on t3, where three adjacent pairs stayed separate in 3/3 runs. It is real, but not shown to be systematic.
- **t1:** the `app` gold topic (6 comments, below the minimum) dropped in 2/3 runs. That is consistent with production reportability: gold's own report would fold it into OTHER.
- **Contested gold boundaries:**
  - The t3 price / crowdfunding / shipping bundle reaches 9–10 comments, at the minimum size. Gold deliberately keeps it in OTHER as a "tempting peripheral". A product owner could reasonably accept a "buying and delivery" topic, so part of A1 is a product judgement rather than an unambiguous model error.
  - The meta topics (A2) are not contestable: they group comments by form, against discovery's own instructions.

### C. Stochastic run-to-run variation

- The taxonomy size after consolidation (7–9, 9–11, 11–12).
- Which peripheral or meta candidate survives, and whether it lands above or below `min_topic_size`. The t3 price topic had 8, 10 and 10 members: folded into OTHER once, reported twice. So **whether a peripheral topic appears in the report is decided by ±2 comments at the size boundary.**
- t2's adjacent merge (2/3) and t3's setup/play-time fragment (1/3; merged correctly in 1/3).
- Precision moves by about one topic per run: 9–15 pp with 7–12 topics.

### D. Evaluator and instrumentation effects (not model failures)

- **Assignment-level OTHER.** The evaluator's OTHER metric counts comments in small topics folded into OTHER as misses. `reportOtherAccuracy` corrects for this (t1 30 → 42%, t2 35 → 57%). On t3 it is still low (20%), because the peripheral topics were *reported*, so the t3 OTHER failure is real.
- **Evidence precision is mostly downstream of the taxonomy.**
  - Of 33 off-topic evidence items across 9 runs, 24 (73%) belong to unmatched reported topics and are off-topic by construction.
  - 8 (24%) are lowest-ID fallbacks that picked a misassigned comment in a matched topic.
  - 1 is a provider example.
- **The lowest-ID fallback** chose 89 of 243 evidence items (37%), because Jev returns no confidence score. That's acceptable when the topic's members are correct. It is content-blind and surfaces misassignments (about 9% of fallbacks).
- **Example support below 100%** (t1 r2, t2 r2, t3 r2): one example each, from a meta "requests" topic citing a request that Jev correctly put under its subject (t2, t3), or from an example carried over from a merged candidate (t1).
- **t1 recall** is penalised for the sub-minimum gold topic (see B).
- **Label-imitation diagnostic coverage.** The local heuristic flagged both steered t3 comments, but missed two unsteered injections whose wording it doesn't recognise. It is a diagnostic only, so this matters only for analysis.
- **t1 and t2 lack candidate taxonomies** (v1 schema), so their decisions are inferred from example IDs.

## 6. Concrete failure patterns from the diagnostics

| Pattern | Seen | Evidence |
|---|---|---|
| Peripheral topics surviving consolidation | t1 1/3, t2 3/3, t3 3/3 | t3 price / crowdfunding cluster: 100% gold-OTHER members in every run; drops 0 on t3 |
| OTHER / NO_SPECIFIC_TOPIC misrepresented | all | Jev OTHER precision 69–100%; recall is lost to topics that should not exist |
| Adjacent topics wrongly merged | t2 2/3 only | grip + menus; discovery had them separate |
| Aspects left separate that should be grouped | t3 1/3 | setup vs play length (both halves unmatched; split error 1) |
| Taxonomy size instability | all | after consolidation: 7–9 / 9–11 / 11–12 |
| Decisions that helped precision vs hurt recall | – | helped: broad merges (folding + portability, photo + colour, setup + play length in t3 r2) and t1 drops. Hurt: the t2 adjacent merge. On t3 consolidation neither helped nor hurt: it did almost nothing |
| Evidence fallback / lowest ID | all | 37% of evidence items; 8 misassigned items surfaced |
| Label-like injection comments | all | 1–2 per run steered into the named topic, identically across runs |
| Jev vs Sonnet stability | – | Jev 94.7–99.4% stable given a taxonomy; all-comment label identity 75–85%, almost all of the difference from the taxonomy |

## 7. Smallest set of root causes

1. **Consolidation lacks a subject-coherence criterion.** This explains about 37% of all disposition errors directly (A1 + A2), plus part of the t2 overheating + battery hybrid (A3), most of the unmatched named share, most off-topic evidence, the t3 OTHER collapse and the precision decline across datasets.
2. **Consolidation's merge and keep decisions are unstable.** About 21% (A3 + A4 + B1): a hybrid topic and an adjacent merge in t2, a fragment left in t3. Same stage, but a different decision type.
3. **Residual, systematic Jev behaviour.** About 34% of errors, low per comment and spread out: vocabulary pull, creator comments read as NST, injection steering. Stable and mostly near gold boundaries.

Root causes 1 and 2 are both in the consolidation stage and together explain about **58%** of errors (181 of 310). Root cause 1 alone is the largest single, cross-dataset, mechanistically identified cause.

## 8. Recommendation: **ONE TARGETED EXPERIMENT REQUIRED**

**Why not the other two statuses:**
- **Not "FREEZE AS BASELINE":** on the hold-out set, precision is 74.5% and OTHER is effectively lost, and the stage meant to prevent this is a near no-op there.
- **Not "REWORK PIPELINE":** recall is high and rising (96% on t3), adjacent-topic separation works on t3, Jev assignment and sentiment are strong and stable, and the dominant failure has one clear mechanism in one stage.

**The experiment:**
- **Hypothesis.** Peripheral bundles and meta topics survive because consolidation-v3 judges candidates only on recurrence, salience and distinctness, never on whether each one is a single audience subject. Adding a subject-coherence DROP criterion will remove them without losing the real topics.
- **One contract change.** A new contract version `topic-consolidation-v4`; v3 stays as it is. Change only the DROP rule, adding one generic criterion:
  - DROP a candidate whose comments are grouped by their form, purpose or addressee (requests, questions, feedback about the video, channel or creator) rather than by a subject they discuss; such comments belong to the subject they are about, or to no topic.
  - DROP a candidate that bundles several side subjects which are not aspects of one shared concern, unless one of those subjects alone is a recurring theme that meets the evidence standard.

  Everything else in v3 (the RETAIN / MERGE wording, the evidence standard, the output format, validation and retry) stays unchanged. Discovery-v2, Jev and the evaluator stay unchanged.
- **Expected metric improvement, primary and pre-registered.** Topic precision on the hold-out data rises substantially (t3 avg 74.5% → ≥ 88%), with guardrails:
  - concept recall does not fall by more than one topic per dataset (avg ≥ 92%);
  - merge errors do not increase;
  - topic sentiment and primary-topic accuracy do not regress.

  Secondary: `reportOtherAccuracy` and assignment-level OTHER accuracy rise, and the unmatched named share falls.
- **Failure mode targeted.** Non-subject candidates (peripheral bundles and meta topics) surviving consolidation (causes A1 + A2, about 37% of errors). The adjacent-merge instability (B1) is not targeted, but is guarded by the "no new merge errors" criterion.
- **How to test it without contaminating the baseline.**
  1. **Keep the baseline.** Leave `topic-consolidation-v3`, the `real-consolidated` suite and every existing result file untouched. v4 runs write new, timestamped files whose metadata carries the contract version, so nothing is overwritten.
  2. **Re-label t1–t3 as development data.** t1, t2 and t3 have now all been inspected in detail, so they serve only as regression sets: run v4 three times each and check the guardrails. Don't use them for the go/no-go decision.
  3. **Author a fresh hold-out `t4-topics-v1` before any v4 run.** It should be a new domain, with gold and the independence audit frozen, and no v4 output consulted while writing it. Run both v3 (baseline) and v4 three times each on t4 as a paired comparison. Decide go/no-go on t4 using the criteria above, written down before the runs.
  4. **One change only.** No other prompt, model or evaluator change during the experiment. If v4 fails the guardrails, v3 remains the frozen baseline.

**Secondary items, not part of the experiment.** These are model-independent and can be handled after it:
- the evidence tie-break (prefer representative members over the lowest ID);
- injection and fake-label handling on the assignment side;
- making the report-level OTHER diagnostic a standard column.
