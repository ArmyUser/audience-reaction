# real-consolidated result instrumentation (schema v2)

**Purpose:** diagnostic instrumentation for the experimental `real-consolidated` suite.

**Scope:**
- It only **observes**. Provider requests and responses, validators, retries and evaluator scores are unchanged, as is pass/fail.
- Contracts, prompts, models, Jev and evidence selection are unchanged.
- Nothing is sent to a model.

**Code:**
- `src/benchmark/topic-consolidated-diagnostics.ts`: pure functions.
- `src/benchmark/topic-real-consolidated.ts`: recording and the reader.

## Result schema

- **Version marker:** `meta.resultSchema = "real-consolidated-result-v2"`. Files without it are v1 (written before instrumentation).
- **Where the new data lives:** the new `instrumentation` block holds everything new. Existing fields (`report`, `phases`, `usage`, `totals`) are unchanged, so v1 readers keep working.
- **Reading files:** `readRealConsolidatedResult(fileText, dataset)` reads both versions.
  - For a v1 file it rebuilds the run diagnostics from the stored evaluator run: report-level OTHER, evidence and label imitation.
  - It reports discovery candidates and consolidation attempts as **not recorded** (`recorded.candidates: false`) instead of guessing them.

```text
instrumentation.notice                       "DIAGNOSTIC ONLY: not part of the evaluator and never used for pass/fail."
instrumentation.repeats[].repeat
instrumentation.repeats[].taxonomyCalls[]    one per analysis attempt that asked for a taxonomy
  .call
  .candidate                                 validated discovery taxonomy before consolidation (null if none)
    { attempt, provider, model, contract, topics[{ key, name, definition, exampleCommentIds }] }
  .consolidationAttempts[]
    { attempt, provider, model, contract, inputCandidateKeys, outcome, issueCodes,
      feedbackIssues   sanitised retry feedback sent with this attempt (null on attempt 1)
      outputTopics     validated consolidation taxonomy (only for the valid attempt; invalid output is never stored)
      finalKeys }
  .provenance                                null unless a consolidation was accepted
    { discoveredTopics, consolidatedTopics, retained, merged, dropped, split, unknown,
      candidateCoverage { covered, withExamples },
      candidatesWithoutSurvivor[], candidatesInMultipleFinals[], finalTopicsWithUntraceableExamples[],
      candidates[{ candidateKey, fate, finalKeys, confidence, ambiguousExampleIds }],
      finalTopics[{ finalKey, exampleCommentIds, examples[{ id, sourceCandidateKeys }],
                    allExamplesFromCandidates, sourceCandidateKeys, material }] }
instrumentation.repeats[].run                null when the run was unavailable
  .reportOther    { reportOtherAccuracy, reportOtherPrecision, goldReportOther, predictedReportOther, hits,
                    goldFoldedTopics, predictedFoldedTopicIds }
  .evidence[]     { commentId, finalTopicId, finalTopicKeys, matchedGoldTopic, expected, assigned, topicSentiment,
                    rank, selection, fallbackReason, tieBreak, labelGroupSize, providerExamplesInLabelGroup }
  .labelImitation[] { commentId, signals, namedTopicIds, assigned, assignedToNamedTopic }
```

## Semantics

- **Candidate fate.** Inferred only from the example IDs the validated consolidation output cites, never from names:
  - `retained`: its examples are in exactly one final topic, and no other candidate's examples are there;
  - `merged`: that final topic also holds another candidate's examples;
  - `split`: its examples are in several final topics;
  - `dropped`: it has examples, but none reappears;
  - `unknown`: it has no examples.

  `confidence` is `ambiguous` when a linking example was cited by more than one candidate. Fates match the existing `phases[].taxonomyCalls[].consolidation.decisions`.
- **`material`** describes each final topic:
  - `retained`: one source candidate;
  - `merged`: several source candidates;
  - `unanchored`: no examples;
  - `untraceable`: none of its examples belongs to a candidate. The validator should make this impossible, so seeing it points to an implementation problem.
- **`reportOtherAccuracy`.** OTHER under report semantics: on both the gold and the predicted side, OTHER means explicit OTHER plus every comment of a topic below the production minimum topic size.
  - It is a diagnostic only.
  - The evaluator's assignment-level `otherAccuracy` is unchanged and remains the scored metric.
- **Evidence.**
  - `selection` is `provider_example` or `fallback`.
  - `fallbackReason` says why a non-example was chosen: `no_provider_example_with_label`, `provider_examples_exhausted_for_label`, or `examples_not_recorded`.
  - `tieBreak` gives the ordering that decided within the sentiment group: `confidence`, `provider_example` or `lowest_comment_id`. This mirrors `selectTopicEvidence`, which is unchanged.
- **Label imitation.** A local regex heuristic over comment text. It does not change classification, prompts or the untrusted-comment boundary. Signals:
  - `structured_label`: JSON-like label fields, including the topic contracts' own field names;
  - `instruction_phrase`: text addressed to whatever processes the comments;
  - `names_topic_label`: a final topic's key, name or name part, quoted or inside an instruction or label.

  `assignedToNamedTopic` shows whether the comment landed in the topic it names.

## Not stored

- API keys.
- Raw provider responses: invalid output is described only by issue codes.
- Provider error text: errors are stored by kind only.
- Comment text: diagnostics carry comment IDs only.

## Markdown

The run markdown gains a final section, "Diagnostics (not part of the evaluator; never pass/fail)". Everything above it is unchanged.
