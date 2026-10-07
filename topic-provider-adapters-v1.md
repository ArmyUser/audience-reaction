# Topic provider adapters v1

These are the first real providers behind the frozen contracts in `topic-provider-contracts-v1.md`. The contract semantics are unchanged: the rendered `topic-discovery-v1` and `topic-assignment-v1` prompts are byte-identical to the frozen version. The only change is that the assignment wording now lives in shared constants (`TOPIC_ASSIGNMENT_SEMANTICS`), so a question-based provider can reuse it verbatim. Discovery has since moved to `topic-discovery-v2` (generic grouping guidance; same output format), see `topic-provider-contracts-v1.md` §3.

| Phase | Provider | Requested model | Adapter |
|---|---|---|---|
| A. Taxonomy discovery | Anthropic | `claude-sonnet-5-5` | `src/adapters/ai/anthropic/anthropic-topic-transport.ts` (a `TopicModelTransport`) used through `ContractTopicTaxonomyGenerator` |
| A. Taxonomy discovery (optional alternative) | Google Gemini | `gemini-3.8-flash` | `src/adapters/ai/google/gemini-topic-transport.ts` (a `TopicModelTransport`), same generator; see [Optional: Gemini discovery](#optional-gemini-discovery) |
| B. Assignment | TypeSafe Jev | `jev-latest` (the alias; the served version is recorded) | `src/adapters/ai/typesafe/jev-topic-assigner.ts` (a `TopicAssigner`), wrapped in `BatchingTopicAssigner` |

**Configuration:**
- Providers and limits: `config/topic-providers.json`.
- Prices: `config/model-prices.json`. Sonnet 5.5 costs $2 per million input tokens and $10 per million output tokens (output includes adaptive-thinking tokens). Jev costs $0.042 per million input tokens; output is free.
- Keys come only from `ANTHROPIC_API_KEY` and `JEV_API_KEY` in the local `.env`. They are never printed or recorded.

## Anthropic discovery

- **Request:** the rendered instructions go in as the system prompt and the rendered data block as the single user message. Output uses structured JSON (`output_config.format`).
- **Thinking and sampling:** adaptive thinking at the model's default, with effort `high` (configurable). No `temperature` is sent, because Sonnet 5.5 rejects non-default sampling values.
- **Output schema:** the contract schema minus the keywords structured outputs doesn't accept (`minLength`, `maxLength`, `maxItems`, `pattern`, …). Nothing else is loosened, and the frozen validators still enforce those rules.
- **Refusal fallback:** **off** in `config/topic-providers.json` (`refusalFallback: "off"`), so the first measurement evaluates `claude-sonnet-5-5` itself, not a fallback model; a refusal is then a provider failure. The adapter still supports `"default"` (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), in which case the model that actually answered is recorded as `modelVersion` and a fallback model without a configured price is left unpriced.
- **Response:** the text is returned exactly as received and parsed by the contract parser. A `max_tokens` stop returns the truncated text, which is then rejected as `invalid_output`.
- **Failures:** SDK errors become a `TopicProviderError` (`configuration`, `rate_limited`, `unavailable`, `timeout`, `refusal`, `transport`). The provider's own message is never kept, and `analyzeTopics` reports the failure as `provider_error`.

## Optional: Gemini discovery

Gemini 3.8 Flash is an **optional** second discovery provider. It is not the default: without `--provider gemini` everything above is unchanged.

- **Selection:** `config/topic-providers.json` → `discoveryProviders.gemini` (provider `google`, model `gemini-3.8-flash`, key variable `GEMINI_API_KEY`). `--provider gemini` selects it. `--model`, if given, must be the entry's model or one of its `alternativeModels`: `--model gemini-3.7-flash` runs the same adapter, contract, request and settings with that model only (Google documents the same thinking levels, `low`/`medium`/`high`, and the same price for both). Assignment stays Jev.
- **Key:** put `GEMINI_API_KEY=…` in your local `.env` yourself (never commit it, never paste it into a chat). Keys are created in Google AI Studio; **no billing account is needed for the free tier**. A missing key fails locally before any request; the adapter always passes the key explicitly, so the SDK's own fallback to `GOOGLE_API_KEY` / `GEMINI_API_KEY` in the environment is never used.
- **Request:** official SDK `@google/genai` (`models.generateContent`), Gemini API (never Vertex AI). Instructions go in `systemInstruction`, the `<comment_data>` block as the single user turn. Output uses `responseMimeType: application/json` with `responseJsonSchema`: the contract schema minus `minLength`, `maxLength` and `pattern`, which it does not accept (the frozen validators still enforce them). Thinking level `low`, the lowest the model accepts (`minimal` is rejected for gemini-3.8-flash). No temperature or other sampling parameters.
- **Response:** the answer text exactly as received (thought parts excluded) goes through the same contract parser, validator and two-attempt retry as Anthropic. `MAX_TOKENS` returns the truncated text (then `invalid_output`); a blocked prompt or a safety/policy finish is a `refusal`. HTTP 400/401/403/404/422 are `configuration` failures; 429 `rate_limited`; 408/504 `timeout`; other 5xx `unavailable`. The SDK retries 408/429/5xx within the call (`maxTransportRetries`).
- **Prices:** `config/model-prices.json` holds the paid-tier introductory price for both `gemini-3.8-flash` and `gemini-3.7-flash` ($0.75 input / $3.75 output per million tokens through 2026-12-31; thinking tokens count as output). The price schema has no tiers, so preflight and result costs are an upper bound: a free-tier key is not billed.
- **Data:** Google may use free-tier inputs and outputs to improve its products. The benchmark sends only the synthetic `t1-topics-v1` comments. **Never send production or customer data through a free-tier key**; use a paid, appropriately configured project for that.

## Jev assignment: question set `jev-topic-a1`

Jev answers typed questions about one `state`, so `topic-assignment-v1` is expressed as two Choice questions per comment. The classifier question sets (`jev-q*`) are not reused, and classifier results are never read.

1. **`topic`:** the options are `topic:<key>` for each taxonomy topic (option text "name: definition"), plus `other` and `no_specific_topic`. The state holds the comment, the focus context, the taxonomy and, on a retry, this comment's issue codes.
2. **`topic_sentiment`:** asked only for primary-topic comments. The state holds the comment, the focus context and that one topic. The options are the schema's sentiment labels.

**Mapping:**
- answers become `{ commentId, disposition, topicKey?, topicSentiment? }`, in request order;
- an option outside the taxonomy, a non-disposition option or a label outside the schema fails validation (`invalid_assignment`);
- no usable answer means no entry, which validation reports as `missing_assignment`;
- nothing is defaulted or repaired.

**Transport:**
- `POST /v1/systemone` with a bearer key;
- retries with backoff only for 429, 5xx, timeouts and network errors;
- 400/401/403/404/422 are configuration failures and stop the run.

## Batching

- **Batches:** `BatchingTopicAssigner` splits one assignment call into consecutive batches of at most 25 comments, in request order, with deterministic slices. Entries are concatenated in order.
- **Within a batch:** Jev handles one comment per request (two requests for a primary topic), with up to 4 in flight. Output order never depends on completion order.
- **One outer attempt:** all batches of one assignment call count as a single outer attempt. There is no second retry system:
  - a transient batch failure leaves those comments unassigned, which gives `missing_assignment`, and the single outer retry in `analyzeTopics` reassigns exactly those comments;
  - configuration failures and structured invalid output propagate unchanged.

## Preflight, cost and the live gate

| Command | Network |
|---|---|
| `npm run benchmark-topics -- --suite real-preflight [--repeats 2] [--show-prompts]` | none; prints `NO API CALLS MADE` |
| `npm run benchmark-topics -- --suite real-preflight --check-models` | read-only model listing only (Anthropic models API, TypeSafe `GET /v1/models`) |
| `npm run benchmark-topics -- --suite real …` without `--live` | none; prints the preflight and exits with code 2 |
| `npm run benchmark-topics -- --suite real --dataset t1-topics-v1 --live --repeats 2` | inference (Anthropic discovery) |
| `npm run benchmark-topics -- --suite real-preflight --dataset t1-topics-v1 --provider gemini --model gemini-3.8-flash --repeats 1` | none; prints `NO API CALLS MADE` |
| `npm run benchmark-topics -- --suite real --dataset t1-topics-v1 --provider gemini --model gemini-3.8-flash --live --repeats 1` | inference (Gemini discovery) |
| `npm run benchmark-topics -- --suite real --dataset t1-topics-v1 --provider gemini --model gemini-3.7-flash --live --repeats 1` | inference (Gemini 3.7 discovery) |

Only the `--live` commands run inference.

### Discovery-only and smoke suites

For comparing discovery providers quickly, without Jev (no Jev call, no Jev key). Implementation: `src/benchmark/topic-discovery-only.ts`. The `real` suite is unchanged and remains the full benchmark.

| Command | What runs |
|---|---|
| `npm run benchmark-topics -- --suite discovery-only --dataset t1-topics-v1 --provider gemini --model gemini-3.7-flash --live --repeats 1` | discovery on the full t1 topic base; saved to `benchmark-results/<timestamp>-topics-<dataset>-discovery-only-<provider>-<model>.json` |
| `npm run benchmark-topics -- --suite smoke --dataset t1-topics-v1 --provider gemini --model gemini-3.7-flash --live --comments 20` | one discovery run on the first N topic-base comments (default 20); printed only, not saved |

Without `--live` both print their plan (`NO API CALLS MADE`) and exit with code 2. `--provider`/`--model` work as for `real`; without them the default Anthropic discovery provider is used.

- **Same discovery step as production:** the same topic base and seeded discovery sample, the same `topic-discovery-v2` request through `ContractTopicTaxonomyGenerator`, the same taxonomy validator, and the same retry rule: at most two attempts, with the sanitised structured feedback that `analyzeTopics` sends. A test checks the request is identical to the one the production discoverer sends.
- **Discovery-only evaluation:** with no assignment there are no member comments, so the real suite's member-comment Jaccard matching cannot run. Each topic is instead matched to the gold concept holding a strict majority of its `exampleCommentIds` (topics without examples match nothing). Precision, concept recall, merges, splits and definition validity are reported on that basis. This is a proxy, not comparable with the real suite's numbers, and the output says so. An offline oracle gate (the gold taxonomy through the same evaluator must score perfectly) runs first; if it fails, no provider is called.
- **Smoke:** reports provider status, validation result, attempts, number of topics and latency only. It is labelled "NOT benchmark-quality evidence". The canonical dataset and oracle are not modified (the subset is taken in memory).

**Preflight:**
- renders the exact discovery request for the real discovery sample and the Jev request shapes;
- counts characters and estimates tokens with the repository's characters ÷ 4 heuristic;
- uses the gold taxonomy as a stand-in for the size of the discovered taxonomy;
- prices the run from configuration.

**Live run safeguards:**
- requires both keys and configured prices, and a worst-case cost within `--max-cost-usd` (default: the configured limit of $1);
- prints the dataset, comment count, both models, estimated cost, estimated requests and "API CALLS WILL BE MADE" before the first request;
- runs the oracle gate first, then the live scenario through the unchanged t1 evaluator.

**Results** are saved to `benchmark-results/<timestamp>-topics-<dataset>-<discovery provider>-<model>-typesafe-<model>.json`. Each file records:
- provider, requested and served model;
- tokens, estimated cost and latency;
- attempts and batches;
- the full t1 report.

No keys and no comment text are stored outside the report's own evidence IDs.

### Experimental: discovery → consolidation (`topic-consolidation-v3`)

**Status:** experimental. It is not part of the production pipeline and is not used by `real`, `discovery-only` or `smoke`.

```bash
npm run benchmark-topics -- --suite discovery-consolidated --dataset t1-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1
```
Without `--live`, the command prints its plan (`NO API CALLS MADE`) and exits with code 2. No Jev call is made and no Jev key is needed.

**Flow:** the discovery step is exactly the discovery-only one (`topic-discovery-v2`). Its validated taxonomy then goes to a consolidation call: same provider, model, settings and transport, using the provider-neutral contract in `src/core/topics/consolidation-contract.ts`.

**Versions:**
- **v1:** candidate topics and focus context only. In the first live Sonnet run it was a no-op (12 → 12 topics).
- **v2:** also sends the **same seeded discovery sample** (IDs and text) that the discovery call received, inside `<comment_data>` with the discovery contract's untrusted-data rules and escaping. It asks for an internal RETAIN / MERGE / DROP decision per candidate. The comments may be used only to judge recurrence, support, salience, relations between candidates and peripherality, never to create topics. In the live Sonnet run it merged correctly (12 → 11) but dropped nothing.
- **v3:** a stricter, generic evidence standard.
  - RETAIN only a substantial recurring theme that stays distinct after grouping.
  - DROP peripheral, incidental, weakly supported or attribute-level candidates.
  - "Substantive" or "mentioned by several comments" is not enough on its own; recurrence, salience and distinctness are weighed together.
  - The data now carries the production **minimum topic size** (`min_topic_size` = `minimumTopicSize(topic base, topic parameters)`, spec §2.6: a topic with fewer primary-topic comments is not reported as a named topic) and `topic_base`, as evidence. The instructions hold no number.
  - Never split a candidate.

**Data block (v3):** `{ focus_target, max_topics, min_topic_size, topic_base, candidate_topics: [{ key, name, definition, exampleCommentIds }], comments: [{ id, text }], retry_feedback? }`, where `max_topics` = min(bound, number of candidates).

**Output and validation:**
- The output is the unchanged topic-discovery format, with no decision fields. It is judged by the frozen `validateTopicTaxonomy`.
- Two extra limits: at most as many topics as candidates, and examples only from the candidates' example IDs, so a topic cannot cite a sample comment that no candidate cites.
- **Retry:** the discovery retry rule, at most two attempts with structured feedback.

**Report** (`src/benchmark/topic-discovery-consolidated.ts`):
- topic counts before and after;
- the discovery-only example-based proxy (precision, concept recall, merge, split, definition validity) for both taxonomies;
- candidate coverage, and the retain / merge / drop decisions (and any split) inferred from where each candidate's example IDs reappear;
- the `min_topic_size` used;
- attempts and retries, and latency, tokens and cost per phase.

It is labelled EXPERIMENTAL and not comparable with the real suite. Offline gates run first. Results are saved to `benchmark-results/<timestamp>-topics-<dataset>-discovery-consolidated-<provider>-<model>.json`.

### Experimental: `real-consolidated` (consolidation before Jev assignment)

**Status:** experimental and not part of production yet. The `real` suite is unchanged (discovery → Jev → report).

```bash
npm run benchmark-topics -- --suite real-consolidated --dataset t1-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1
```
Without `--live`, the command prints the real preflight plus a consolidation section (`NO API CALLS MADE`) and exits with code 2. The live gate requires both keys and checks the worst case including consolidation; for one repeat that is about $0.70.

**Flow:** this is `runRealTopicBenchmark` itself, with one optional hook (`taxonomyStage`) that wraps the discovery generator in `ConsolidatingTaxonomyGenerator` (`src/benchmark/topic-real-consolidated.ts`):
1. Discovery (`topic-discovery-v2`), then the frozen taxonomy validator on the candidate. A rejection is thrown exactly as the discoverer throws it, so `analyzeTopics` retries discovery with feedback, as in production.
2. Consolidation (`topic-consolidation-v3`) with its own retry: same transport, the same seeded sample, and the production `min_topic_size`.
3. The consolidated taxonomy goes to the unchanged production pipeline: `TwoPhaseTopicDiscoverer` validation, Jev topic assignment and topic sentiment (`jev-topic-a1`, batching), `analyzeTopics` (minimum topic size, OTHER, NO_SPECIFIC_TOPIC, AC-23, HIGH_OTHER_SHARE, evidence), and the report.
4. The **same full evaluator** as `real` scores the result, so the full metrics are directly comparable with `real`. Only the taxonomy path differs.

**Failures:**
- If consolidation still fails after its retry, the run ends as **unavailable**: the second analysis attempt fails without any provider call.
- The unconsolidated taxonomy is never used as a fallback.
- A configuration failure stops later repeats, as in `real`.

**Report:**
- per taxonomy call: discovery status, issues and topic count; consolidation attempts, status and topic count; retained / merged / dropped decisions;
- the unchanged full benchmark table;
- latency, tokens and cost separately for discovery, consolidation and Jev assignment.

Saved to `benchmark-results/<timestamp>-topics-<dataset>-real-consolidated-<provider>-<model>-typesafe-<model>.json`.

### Independent validation dataset `t2-topics-v1`

`t2-topics-v1` (`fixtures/t2-topics-v1/comments.json`) is a held-back validation set for the frozen candidate pipeline: discovery `topic-discovery-v2`, consolidation `topic-consolidation-v3`, Anthropic `claude-sonnet-5-5`, Jev assignment and sentiment, and the full evaluator.

- **Domain:** an independent creator's hands-on review of a fictional mirrorless camera (Lumora S9, not sponsored).
- **Size:** 201 comments, topic base 190, 11 spam / off-topic, minimum topic size 10.
- **Gold:** 9 topics (142 primary topic, 25 OTHER, 23 NO_SPECIFIC_TOPIC). It includes broad topics, adjacent but distinct topics, small peripheral subjects kept in OTHER, ambiguous comments and comments where topic sentiment differs from overall sentiment.
- **Independence:** authored separately from t1, with the same schema and gold semantics, and the gold written before any provider run.
- **Audit:** `fixtures/t2-topics-v1/leakage-audit.json`. It reruns the t1 lexical audit, with the same thresholds, against t1's comments and gold, the t1 replay responses, the topic prompts and stored model outputs, and adds structural independence checks. Regenerate it only before a provider run, with `npx tsx tests/topics-benchmark/write-t2-leakage-audit.ts`.

Offline oracle gate and scenarios:
```bash
npm run benchmark-topics -- --dataset t2-topics-v1 --scenario all
```
Validation protocol: 3 independent repeats of `real-consolidated` on t2, with no prompt, model or evaluator change between them.
```bash
npm run benchmark-topics -- --suite real-consolidated --dataset t2-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1
```
The replay suite stays t1-only (its recorded responses belong to t1).

### Final hold-out dataset `t3-topics-v1`

`t3-topics-v1` (`fixtures/t3-topics-v1/comments.json`) is the final hold-out set for the frozen candidate: `topic-discovery-v2`, `topic-consolidation-v3`, Sonnet, Jev assignment and sentiment, and the existing evaluator. It is independent of both t1 and t2, so it measures generalisation to a third domain and topic structure. Do not tune anything against it.

- **Domain:** an independent creator's review of a fictional cooperative board game (Driftwardens, not sponsored).
- **Size:** 204 comments, topic base 192, 12 spam / off-topic, minimum topic size 10. Version `sha256:41e90795c48cf637`; the full file SHA-256 starts `41e90795c48cf637`.
- **Gold:** 9 topics (144 primary topic, 25 OTHER, 23 NO_SPECIFIC_TOPIC). The structure includes:
  - adjacent but distinct pairs: rules vs difficulty, solo play vs player-count scaling, art vs components vs theme;
  - broad topics: component quality, setup and play time;
  - tempting peripheral subjects kept in OTHER: crowdfunding and shipping, sleeves and storage, price;
  - one topic exactly at the minimum size: solo play, 10 comments;
  - other slices: questions and requests, sarcasm and slang, prompt injections, fake JSON / markup / instructions, and comments that name the game without addressing it.
- **Oracle and offline scenarios:** the oracle passes with every metric at 100%, and all 18 offline scenarios meet their stated expectations.
- **Independence audit:** `fixtures/t3-topics-v1/leakage-audit.json`, regenerated with `npx tsx tests/topics-benchmark/write-t3-leakage-audit.ts` (only before any t3 provider run).
  - It uses the t1/t2 lexical algorithm and thresholds against everything the t1 audit covers, plus t1 and t2 comments and gold, the replay responses, the topic prompts and all stored model outputs.
  - It also runs 8 structural checks: IDs, gold labels, schema fields, provider vocabulary, prompt text and model output.
  - Result: 0 violations and 8/8 checks passed. No t3 result existed when it was audited.

```bash
npm run benchmark-topics -- --dataset t3-topics-v1 --scenario all
```
First live hold-out run (repeat three times without any change in between):
```bash
npm run benchmark-topics -- --suite real-consolidated --dataset t3-topics-v1 --provider anthropic --model claude-sonnet-5-5 --live --repeats 1
```
