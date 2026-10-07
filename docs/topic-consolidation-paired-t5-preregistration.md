# Pre-registration: paired consolidation experiment v3 vs v4 on t5

**Status:** PRE-REGISTERED, written before any live run on t5. No t5 result exists. Nothing in this document, in the registered definition or in the evaluation rules may change after the first pair is reserved. A new idea needs a new experiment id and a new hold-out.

**Experiment id:** `paired-consolidation-v3-v4-t5-v1`

**Registered definition:** `PAIRED_EXPERIMENTS["paired-consolidation-v3-v4-t5-v1"]` in `src/benchmark/topic-paired-consolidation.ts`.

**Definition fingerprint:** `sha256:697e2e73965540c5e2e47f4406ffc8c0007e9de6958c37105ee326d0aa0a0d51` (SHA-256 of the canonical JSON of the definition).
- Every pair records this fingerprint.
- The evaluation refuses (INVALID) any pair or reservation made under a different definition.
- The fingerprint is pinned in `tests/benchmark/topic-paired-preregistration.test.ts`.

**Background:** `docs/topic-consolidation-v4-postmortem.md` (the t4 verdict FAIL stands and is not revisited) and `docs/topic-consolidation-paired-experiment.md` (the paired design). This experiment is the paired comparison the postmortem asked for: one shared discovery per pair, so a discovery failure removes the whole pair instead of scoring zero against one arm.

## 1. Fixed design

| Item | Registered value |
|---|---|
| Dataset | `t5-topics-v1`, file SHA-256 `cec6e6563d81a1799a1eeed9328a9c19558a9ce6fadc265901529c8bf79a2cc3` (version `sha256:cec6e6563d81a179`) |
| Baseline | `topic-consolidation-v3` (frozen) |
| Candidate | `topic-consolidation-v4` (frozen; exactly the rule used on t4) |
| Discovery | Anthropic, `claude-sonnet-5-5`, `topic-discovery-v2`, configured settings |
| Discovery per pair | exactly one shared discovery; retry policy `paired-discovery-retry-v1`, at most 2 attempts with the production structured feedback |
| Shared taxonomy | the exact validated discovery output is fingerprinted, frozen and served identically to both arms; the arms make no discovery request |
| Assignment | TypeSafe, `jev-latest`, `topic-assignment-v1` / `jev-topic-a1`, configured batching |
| Evaluator | the unchanged full evaluator of the real-consolidated path |
| Arm order | pairs 1 and 3: v3 first; pair 2: v4 first |

The only treatment difference between the two arms of a pair is the consolidation contract.

## 2. Schedule

- Exactly **3 pairs**, numbered 1, 2, 3, each run once.
- No replacement pairs, and no additional pairs after any result is seen.
- Before a pair starts, a reservation file is written, and it is never overwritten. A reserved number is used up even if the run aborts.
- The CLI refuses to run once all three numbers are used.

## 3. Pair availability rule

A pair is **available** only if all of these hold:
1. Discovery succeeds within the fixed 2-attempt policy, and its output validates.
2. Both arms complete: each arm's single run has a taxonomy, an assignment and a report.
3. Both arms consumed the exact same discovery taxonomy fingerprint.
4. The dataset, sample, prompt and settings fingerprints match.
5. Pairing validation passes, and the pair matches this registration.

A pair is **unavailable** in each of these cases:
- **Discovery still invalid after 2 attempts:** the whole pair is `unavailable_discovery`. No arm runs.
- **An arm fails after a valid shared discovery:** the pair is `unavailable_arm`. The failure is recorded explicitly.
- **A reservation exists without a saved result:** the pair is `aborted`.

An unavailable pair:
- contributes to neither arm's mean;
- is **not** converted to zero;
- is **not** rerun;
- is **not** replaced.

A pair that fails pairing validation or does not match this registration makes the evaluation **INVALID**; it is refused, not skipped. So do a scheduled number used twice, a pair numbered above 3, and a definition fingerprint other than the one above.

## 4. Fixed success criteria

These are evaluated over the 3 available pairs, using the evaluator's per-run values. Means are taken over the 3 pairs, and "pp" means percentage points. Comparisons use the unrounded values; a tolerance of 1e-9 absorbs floating-point representation error only.

1. **Topic precision:** the v4 mean is at least 88.0%.
2. **Topic recall** (concept recall): the v4 mean is at least 92.0%.
3. **Precision improvement:** the v4 mean is at least the v3 mean + 5.0 pp.
4. **Recall regression:** the v4 mean is no more than 1.0 pp below the v3 mean.
5. **Merge errors:** total v4 merge errors are at most total v3 merge errors.
6. **Primary-topic accuracy:** the v4 mean is no more than 1.0 pp below the v3 mean.
7. **Topic sentiment accuracy:** the v4 mean is no more than 1.0 pp below the v3 mean.
8. **Splits:** no pair has a v4 split error where the same pair's v3 has zero split errors.

## 5. Interpretation rule

- **PASS** only if all 3 scheduled pairs are available and every criterion 1–8 passes.
- **FAIL** if all 3 scheduled pairs are available and at least one criterion fails.
- **INCOMPLETE** if fewer than 3 scheduled pairs are available, whether a pair is unavailable, aborted or not yet run. No criterion is evaluated, and no additional pair is run.
- **INVALID** if a saved pair or reservation breaks the registration, as described in §3.

There is no fallback interpretation: no partial verdict, no "best of", and no re-selection of pairs.

## 6. Cost and stop rule

Conservative worst case, from the committed paired CLI estimator (`buildPairedPlan`) at the configured prices:

| | Worst case |
|---|---|
| One pair | $1.749553584 (discovery $0.339744 for 2 attempts + both arms $1.409809584) |
| Three pairs | $5.248660752 |
| **Registered experiment budget** | **$5.25** |

The arm figure is conservative: each arm's estimate includes a discovery cost, although arms make no discovery call.

Stop rule, checked by the CLI before every pair:
- **Spent so far:**
  - each saved pair counts at its recorded cost;
  - a pair whose cost is not fully priced counts at $1.749553584;
  - an aborted reservation also counts at $1.749553584.
- **A pair starts only if both hold:**
  - its current worst case is no higher than the registered $1.749553584. If the configuration or prices changed, the run is refused.
  - its worst case is within the remaining budget, $5.25 minus spent.
- The budget cannot be raised. `--max-cost-usd` and every other override are refused in experiment mode.

## 7. What each pair records

Each pair file is `benchmark-results/<timestamp>-topics-t5-topics-v1-paired-consolidation-…-pair-<n>.json`. It records:
- the experiment id, the definition fingerprint, the scheduled pair number (also the pair index) and the dataset SHA-256 (`meta.experiment`);
- the discovery fingerprint, the number of discovery attempts and each attempt's outcome;
- the raw rejected output, with secrets redacted;
- the provider and model of every attempt;
- the discovery prompt fingerprints (first attempt and retry);
- the taxonomy fingerprint each arm consumed;
- the consolidation version and consolidation prompt fingerprints of each arm (first attempt and retry);
- the assignment model, contract and question set;
- the pairing validation, as saved;
- every evaluator metric (the full report);
- the cost and request counts per phase;
- unavailable or failure reasons.

API keys are never stored: model output is redacted, and keys are read only from the local environment.

## 8. How to run (not run yet)

```bash
npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset t5-topics-v1 --experiment paired-consolidation-v3-v4-t5-v1
npx tsx --env-file-if-exists=.env src/benchmark/paired-consolidation-cli.ts --dataset t5-topics-v1 --experiment paired-consolidation-v3-v4-t5-v1 --live
npx tsx src/benchmark/paired-consolidation-cli.ts --dataset t5-topics-v1 --check --experiment paired-consolidation-v3-v4-t5-v1
```

- The first command prints the plan only and makes no API calls.
- The second runs the remaining scheduled pairs, which is billed.
- The third evaluates the saved pairs offline.

Ad-hoc live pairs on `t5-topics-v1` are refused by the paired CLI.
