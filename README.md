<p align="center">
  <img src="public/icon-192.png" alt="" width="72" height="72">
</p>

<h1 align="center">Audience Reaction</h1>

<p align="center">
  AI-powered audience intelligence from comments: sentiment, topics, targets, and evaluation.
</p>

---

Audience Reaction turns the comments under a video into a structured, evidence-backed report: what the audience
talked about, how they felt about each of those things, what they asked for, and which comments support each claim.
It is a multi-stage pipeline (a comment classifier, an LLM topic discoverer and a topic
assigner), built and tuned against synthetic datasets with gold labels, with separate validation and hold-out sets.

**Status: research prototype, local only.** The web app runs on your machine (`npm run dev`). There is no hosted
service, no user accounts and no database. Real YouTube analysis is gated by an internal compliance check (CG-1),
see [YouTube integration and CG-1](#youtube-integration-and-cg-1).

## Contents

- [What it produces](#what-it-produces)
- [Architecture](#architecture)
- [Models and why they are used](#models-and-why-they-are-used)
- [Research and benchmarking process](#research-and-benchmarking-process)
- [Datasets](#datasets)
- [Metrics and why they matter](#metrics-and-why-they-matter)
- [Results: how the pipeline was reached](#results-how-the-pipeline-was-reached)
- [Running the web app](#running-the-web-app)
- [API configuration](#api-configuration)
- [YouTube integration and CG-1](#youtube-integration-and-cg-1)
- [Privacy and data handling](#privacy-and-data-handling)
- [Tests, benchmarks and evaluation](#tests-benchmarks-and-evaluation)
- [Limitations and open research questions](#limitations-and-open-research-questions)
- [Roadmap](#roadmap)
- [Repository layout](#repository-layout)
- [Documentation index](#documentation-index)

---

## What it produces

**The problem.** A popular video can collect hundreds or thousands of comments. Creators, sponsors and brand teams
want to know how the audience reacted, but reading every comment is slow, and a single "sentiment score" hides the
useful part: *what* people were positive or negative about. A comment like "great video, but the sponsor segment was
way too long" is positive about the creator and negative about the sponsor read.

**What Audience Reaction does** is separate two levels of analysis:

| Level | Question | Output |
|---|---|---|
| **Comment-level classification** | What is this one comment? | sentiment, comment type, question/request flags, sentiment toward each target |
| **Aggregate audience intelligence** | What did the audience as a whole say? | shares and distributions, recurring topics, sentiment toward each topic, findings, supporting evidence |

For each comment the classifier assigns:

- **sentiment** (`positive`, `neutral`, `negative`; a `mixed` label exists in the schema but is disabled);
- **comment type** (`opinion`, `question`, `request`, `joke_reaction`, `spam_irrelevant`, `other`);
- **question and request flags**, independent of the type;
- **targets**: the sentiment toward the **creator**, the **content**, and an optional **focus** (a brand, product or
  sponsor named by the user), or `not_addressed`.

On top of that, the topic pipeline gives every non-spam comment exactly one disposition: a **primary topic** with the
**sentiment toward that topic** (which can differ from the comment's overall sentiment), **Other** (substantive, but no
topic fits), or **No specific topic** (generic comments such as "great video").

The report then shows:

- **aggregate shares**: overall sentiment, comment types, questions and requests, sentiment per target;
- **topics** ranked by volume, each with its topic-sentiment split (small samples are shown as counts, never as
  percentages);
- **findings**: up to five sentences computed from the report's own numbers by fixed rules (not AI-generated text),
  each linked to the topic or metric it comes from;
- **supporting evidence**: verbatim comments selected by fixed rules for each topic;
- **methodology notes and run diagnostics**: bases, sampling, warnings, the pipeline used, cost and duration.

A separate internal **evaluation page** (`/evaluation`) shows the benchmark metrics of the pipeline the app runs,
with every dataset labelled by role (development, validation, held-out).

**Long-term vision.** The intended product is audience-reaction intelligence for brand, sponsorship and creator teams:
a hosted SaaS that reports how an audience reacted to a video, a sponsor or a product, with transparent methodology.
That is a direction, not a current capability: today this repository is a local research prototype.

---

## Architecture

For YouTube data the policy gate has to be checked before the comments are fetched; test datasets are not YouTube data and use the
strict policy.

The pipeline is deliberately **not one large prompt**. Each stage has a narrow job, a versioned contract, a validator
and its own benchmark:

1. **Classification** labels each comment independently (one request per comment, run concurrently).
2. **Discovery** reads a sample of comments and proposes a candidate taxonomy (at most 12 topics).
3. **Consolidation** reviews the candidates and retains, merges or drops them.
4. **Assignment** gives every non-spam comment one disposition against the consolidated taxonomy, with the
   sentiment toward that topic.
5. **Aggregation** is plain code: shares, minimum topic size, Other / No specific topic, warnings and evidence
   selection. No model is involved in the numbers.

Every model output is untrusted: it is parsed and validated by the engine, a rejected output gets one retry with
structured feedback, and a second failure makes topics unavailable rather than guessed.

### Modes

| Mode | Data | Classifier and topics | Provider calls |
|---|---|---|---|
| **Demo** | 60 synthetic comments (m2) | rule-based fake classifier, no topics | none |
| **Test data** | a synthetic development dataset (m2-synthetic or t1-topics-v1) | the real AI pipeline | Jev, Anthropic (billed) |
| **Real YouTube** | a public video's top-level comments | the real AI pipeline | YouTube, Jev, Anthropic (billed); only if CG-1 allows it |

### Components and boundaries

The code is layered, and the boundaries are enforced by a test (`tests/architecture/boundaries.test.ts`):

| Layer | Directory | Responsibility |
|---|---|---|
| Core | `src/core/` | domain types, classification schema and validation, aggregation, topic validation and reporting, compliance policy, cost budget. No I/O, no vendor names, no environment access. |
| Application | `src/application/` | use cases: analyse a video, two-phase topic discovery, consolidation, cost guards, progress, report insights. |
| Adapters | `src/adapters/` | data ingestion (YouTube, synthetic fixtures) and providers (Jev, Anthropic, optional Gemini), plus fakes and replay transports for offline tests. |
| Composition | `src/local/` | the server-only composition root: reads configuration and keys, wires the pipeline, enforces CG-1, holds the in-memory analysis cache, builds the evaluation view. |
| Web | `src/web/`, `src/app/` | the Next.js app: Analyze, Evaluation and Settings pages, and the `/api/analyses` endpoint. Browser code never imports server layers and never names a key variable. |
| Benchmarks | `src/benchmark/` | classifier and topic benchmarks, experiment runners and evaluators. |

---

## Models and why they are used

All model settings live in `config/real-mode.json` and `config/topic-providers.json`; prices in
`config/model-prices.json`. No key is stored in the repository.

### Classifier: TypeSafe Jev

| Setting | Value |
|---|---|
| Provider / model | TypeSafe Jev, `jev-latest` |
| Question set | `jev-q2.2` (labelling guideline `g1.4`, schema `v1-3label-focus`) |
| What it classifies | comment type, question flag, request flag, sentiment, sentiment toward creator / content / focus |
| Requests | one per comment, 8 concurrent, 30 s timeout, up to 3 retries |

Jev answers a fixed set of structured questions per comment rather than generating free text, which suits a
classification schema with fixed labels. The question set was iterated over four versions (`jev-q1` → `q2` → `q2.1` →
`q2.2`) on the development set and checked on a hold-out set; see [Classifier results](#classifier). The repository
records Jev runs only: there is no stored head-to-head comparison with other classifier providers (an Anthropic
classifier adapter exists for the benchmark, but no results from it are archived).

### Topic discovery: Claude Sonnet

| Setting | Value |
|---|---|
| Provider / model | Anthropic, `claude-sonnet-5-5`, effort `high` |
| Contract | `topic-discovery-v2` |
| Input | a seeded, stratified discovery sample of up to 400 non-spam comments (seed `t1-topics-v1/ds1`) |
| Output | at most 12 candidate topics, each with a name (at most five words), a definition and example comment IDs |
| Retries | at most 2 attempts, the second with structured validation feedback |

Discovery decides *what the topics are*. It only sees comment IDs and text, never the classifier's labels, so topic
names stay sentiment-neutral.

### Topic consolidation: Claude Sonnet

| Setting | Value |
|---|---|
| Provider / model | same model and settings as discovery |
| Contract | `topic-consolidation-v3` (RETAIN / MERGE / DROP) |
| Minimum topic size | the larger of 10 comments and 1% of the topic base |

Consolidation exists because discovery over-generates: it returned exactly 12 topics, the cap, in every validated run
(9 of 9 in the t1–t3 validation). Without a review step the report would contain fragments, duplicates and side
subjects. Consolidation merges duplicates and drops candidates without enough evidence.

### Topic assignment: Jev

| Setting | Value |
|---|---|
| Provider / model | TypeSafe Jev, `jev-latest` |
| Question set / contract | `jev-topic-a1` / `topic-assignment-v1` |
| Batching | up to 25 comments per batch, 4 batches concurrent, up to 3 transport retries |

Assignment applies the consolidated taxonomy to **every** non-spam comment (not just the discovery sample) and
records the sentiment toward the assigned topic. In validation, Jev's assignment was near-deterministic given a fixed
taxonomy (94.7–99.4% of labels identical across repeats).

### Cost cap

Every real-mode analysis has a hard cost cap of **$1.00** (`maxCostUsd`). Before each provider call the app reserves
its worst-case cost; if a call could exceed the cap, the analysis stops with a "cost limit reached" result and no
partial report.

---

## Research and benchmarking process

The configuration above was reached by experiment, not chosen up front. The guiding rule is the usual one for model
evaluation:

```text
development set → iterate prompts and settings
validation set  → check that improvements generalise (not used for tuning)
hold-out set    → final, untouched evaluation of a frozen candidate
```

A hold-out set stops being a hold-out the moment it is used to make a decision about the thing it evaluates. So in
this project:

- datasets are **frozen** (content-hashed) before any provider run on them;
- each new dataset passes an automated **leakage audit** against everything written before it (other datasets,
  prompts, guidelines, tests, stored model outputs);
- experiments that decide something are **pre-registered**: the criteria, the run schedule and the run selection are
  committed before the first live result, and a registered definition fingerprint is checked by the evaluator;
- once a hold-out has been inspected in detail it is **demoted** to a regression set, and a fresh hold-out is written
  for the next decision.

### Evaluation stages

| Stage | What is measured | Datasets |
|---|---|---|
| Classifier benchmark | per-comment labels against gold (accuracy, macro F1, per class) | m2-synthetic (dev), m2-heldout-v1 (hold-out) |
| Oracle and replay benchmarks | the topic engine's validation, retries, reporting rules, using perfect or recorded model outputs (offline) | t1-topics-v1 |
| Discovery-only and discovery + consolidation | taxonomy quality before assignment | t1-topics-v1 |
| End-to-end topic validation (`real-consolidated`) | discovery → consolidation → assignment → report, scored against gold | t1 (dev), t2 (validation), t3 (hold-out) |
| Pre-registered experiments | one contract change against the frozen baseline | t4, t5 (hold-outs) |

---

## Datasets

All datasets are **synthetic**: comments written for this project about fictional products and videos, in English,
stored in `fixtures/`. **No real YouTube comment text is committed to this repository**, and none was ever committed
to its history.

| Dataset | Size | Purpose | Role | Gold labels | In the web app |
|---|---|---|---|---|---|
| **Demo** | 60 (= m2) | product demo with no provider calls | demo | (rule-based classifier, no scoring) | yes (Demo) |
| **m2-synthetic** | 60 comments | classifier development: a fictional sponsored tech video, focus "Acme VPN" | development | per-comment classification (guideline g1.4) | yes (test data) |
| **m2-heldout-v1** | 100 comments | classifier generalisation: a fictional drill comparison sponsored by a meal-kit brand | held-out | per-comment classification (g1.4) | no |
| **t1-topics-v1** | 200 comments, 8 gold topics | topic development: a sponsored long-term review of a folding e-bike | development | taxonomy, one disposition per comment, topic sentiment | yes (test data) |
| **t2-topics-v1** | 201 comments, 9 gold topics | first independent topic validation: a mirrorless-camera review | validation | same as t1 | no |
| **t3-topics-v1** | 204 comments, 9 gold topics | final hold-out of the t1–t3 validation: a co-op board game review | held-out (now a regression set) | same as t1 | no |
| **t4-topics-v1** | 201 comments, 9 gold topics | pre-registered hold-out for the consolidation-v4 experiment: a language-learning service | held-out | same as t1 | no |
| **t5-topics-v1** | 206 comments, 9 gold topics | hold-out for the paired v3-vs-v4 consolidation comparison: a home espresso machine | held-out | same as t1 | no |

The web app only offers the development sets; the server refuses validation and hold-out sets even if requested
directly, so they can never be used to tune the analysis through the app.

### How the datasets were built

- **Written by hand for this project**, each in a different product domain, so a model cannot do well by memorising
  one domain's vocabulary.
- **Gold first.** For every topic dataset the gold taxonomy and labels were written before any provider was run on it
  (recorded in each dataset's `leakage-audit.json` provenance).
- **Deliberate variation.** Comments are tagged with the difficulty they test. Examples from the actual tag sets:
  - classifier sets: sarcasm and irony, slang, emoji, very short reactions, implicit targets, sponsor praise vs. ad
    criticism, opinions that also contain a request, timestamps, off-topic spam;
  - topic sets: strong vs. borderline topic membership, generic comments, adjacent topics that must stay separate,
    peripheral side subjects, comments whose topic sentiment diverges from their overall sentiment, lexical variants,
    addressee and meta traps, incidental focus mentions;
  - every set includes adversarial comments: prompt injections ("ignore all previous instructions…"), fake JSON
    labels, HTML/script tags and fake markup.

  These variations are where pipelines fail in practice, so each is represented on purpose.
- **Gold semantics.** Classifier gold follows the labelling guideline (`src/core/classification/guidelines.ts`,
  version g1.4). Topic gold gives each non-spam comment one disposition (primary topic + topic sentiment, Other, or No
  specific topic) and each gold topic a definition and accepted alternative names. In the topic sets the per-comment
  classification labels are oracle inputs (for sampling and aggregation), not a classifier benchmark.
- **Leakage audits.** Each later dataset is checked against all earlier sources (other datasets and their gold, the
  guideline, Jev questions, prompts, the spec, design notes, tests, fakes and stored model outputs) by exact match,
  substring containment (≥ 10 characters), content-word Jaccard and character-trigram Jaccard (thresholds 0.4), plus
  structural independence checks. The audits are part of the test suite, and the sources they compare against are
  pinned by SHA-256 in `tests/topics-benchmark/manifests/`.

**Why synthetic data.** Real comments would make the benchmarks more realistic, but committing them would mean
redistributing YouTube data and commenters' text, which YouTube's policies and basic privacy rule out. Synthetic data
can be published, versioned, labelled by hand and shaped to cover hard cases. The cost is realism; see
[Limitations](#limitations-and-open-research-questions).

---

## Metrics and why they matter

| Metric | What it is | Why it matters here |
|---|---|---|
| **Accuracy** | share of comments labelled exactly like gold | the headline number for each classification task; misleading on its own when classes are rare |
| **Precision / recall** | of the comments given a label, how many were right / of the comments that should have it, how many got it | a report that over-calls "negative" misrepresents the audience as much as one that misses negatives |
| **Macro F1** | the unweighted mean of per-class F1 | the label sets are unbalanced (few requests, few negative creator mentions); macro F1 keeps rare classes from disappearing behind the majority class |
| **Topic precision** | share of reported topics that match a gold topic (member Jaccard ≥ 0.5, never by name) | every reported topic is a claim about the audience; a spurious topic is a false finding |
| **Topic (concept) recall** | share of gold topics recovered | a missed topic is a theme the report silently omits |
| **Merge / split errors** | distinct gold topics merged into one, or one split into several | merged topics blur separate concerns; split topics inflate the topic count and dilute shares |
| **Disposition / primary-topic accuracy** | each comment's disposition (or topic) against gold | topic shares and topic sentiment are only as good as the per-comment assignment |
| **Topic sentiment accuracy** | sentiment toward the assigned topic | the core value of the product: what the audience felt about *each* subject |
| **Other rate / Other accuracy** | how well "fits no topic" comments are recognised | if side subjects are forced into named topics, the topics look bigger and more coherent than they are |
| **Topic coverage** | share of comments in reported topics | low coverage means the topics explain little of the conversation |
| **Evidence precision** | evidence comments that really belong to their topic | evidence is what lets a reader verify a finding; off-topic evidence undermines trust |
| **Latency** | wall-clock time per analysis and per phase | determines whether the product can be interactive or must be a background job |
| **Estimated cost** | provider tokens priced from `config/model-prices.json` | sets the unit economics of a future SaaS and the per-analysis cap |

---

## Results: how the pipeline was reached

The numbers below are taken from the archived result files in `benchmark-results/` and the reports in `docs/`. With
two or three repeats per configuration they are exploratory evidence, not significance-tested scores.

### Classifier

Jev question sets on the development set (m2-synthetic, 60 comments; accuracy, with macro F1 in brackets):

| Task | jev-q1 (g1.2) | jev-q2 (g1.3) | jev-q2.1 (g1.4) | **jev-q2.2 (g1.4)** |
|---|---|---|---|---|
| Comment type | 78.3% (0.66–0.67) | 95.0% (0.93) | 95.0% (0.93) | **95.0% (0.93)** |
| Question flag | 93.3% | 100% | 100% | **100%** |
| Request flag | 95.0–96.7% | 95.0–96.7% | 100% | **100%** |
| Sentiment | 88.3% (0.88) | 95.0% (0.95) | 95.0% (0.95) | **94.2% (0.94)** |
| Target: creator | 80.0% (0.44) | 98.3% (0.97) | 98.3% (0.97) | **98.3% (0.97)** |
| Target: content | 81.7–85.0% | 86.7–87.5% | 83.3% (0.72) | **91.7% (0.80)** |
| Target: focus | 78.3–80.0% | 86.7–87.5% | 94.2% (0.88) | **94.2% (0.88)** |

The guideline was revised alongside the question sets (g1.2 → g1.3 → g1.4), so columns with different guideline
versions are not strictly like-for-like.

The two leading candidates on the hold-out set (m2-heldout-v1, 100 comments, guideline g1.4, 2 repeats each):

| Task | jev-q2 | **jev-q2.2** |
|---|---|---|
| Comment type | 96.0% (0.93) | **96.0% (0.93)** |
| Question flag | 99.0% | **100%** |
| Request flag | 95.0% | **100%** |
| Sentiment | 92.0% (0.92) | **92.0% (0.92)** |
| Target: creator | 96.0% (0.96) | **95.5% (0.95)** |
| Target: content | 83.0% (0.63) | **82.0% (0.62)** |
| Target: focus | 90.0% (0.83) | **94.0% (0.88)** |
| Cost per run (100 comments) | $0.025 | **$0.029** |

**Why jev-q2.2:** it was the best question set on the development set, and it held up on unseen data: flags and focus
improved over q2, the other tasks were equal or within one comment. The weakest task is the **content target** (macro
F1 about 0.62 on the hold-out), which the report treats with small-sample rules.

### Topic discovery

Early runs on t1 (development) compared Gemini Flash and Claude Sonnet for discovery under the first contract
(`topic-discovery-v1`). A few completed Gemini runs scored well on t1, but Gemini runs also ended in provider errors,
including the only Gemini run under `topic-discovery-v2`. All later work (consolidation, t2–t5) used Sonnet. The
repository does not contain a written selection decision beyond these result files.

`topic-discovery-v2` replaced v1's guidance with generic grouping guidance (same output format). Its behaviour is
consistent: it finds the real topics (high recall) but always fills the 12-topic cap, so its raw output contains
fragments, peripheral subjects and meta topics. That is why consolidation exists.

A pre-registered experiment later tested **discovery-v3** (topic-name robustness) against v2 over 40 scheduled runs.
v3 improved validity and taxonomy quality (eventual validity 100% vs 95%, first-attempt validity 85% vs 30%, topic
precision 78.4% vs 66.8%, recall 100% vs 84.2%), but it missed two pre-registered thresholds (first-attempt validity
≥ 95%, `invalid_topic_name` rate ≤ 1%). **Verdict: FAIL**, so v2 remains the production contract.
([postmortem](docs/benchmarks/discovery-v3-name-robustness-v1-postmortem.md))

### End-to-end topic validation (current pipeline)

Discovery-v2 → consolidation-v3 → Jev assignment, three runs per dataset
([full report](docs/topic-validation-t1-t2-t3-sonnet-v3.md)):

| Metric (avg of 3 runs) | t1 (development) | t2 (validation) | t3 (hold-out) | Pooled avg of 9 |
|---|---|---|---|---|
| Topic precision | 92.1% | 83.9% | **74.5%** | 83.5% |
| Concept recall | 91.7% | 92.6% | 96.3% | 93.5% |
| Disposition accuracy | 88.8% | 90.0% | 85.4% | 88.1% |
| Primary-topic accuracy | 95.8% | 88.3% | 88.4% | 90.8% |
| Topic sentiment accuracy | 92.0% | 96.0% | 96.9% | 95.0% |
| Other accuracy (assignment level) | 30.3% | 34.7% | **2.7%** | 22.5% |
| No-specific-topic accuracy | 91.7% | 91.3% | 84.1% | 89.0% |
| Evidence precision | 90.1% | 91.6% | 79.9% | 87.2% |
| Cost per run (≈ 200 comments) | $0.082 | $0.087 | $0.085 | $0.085 |
| Wall-clock per run | ≈ 40 s | ≈ 38 s | ≈ 43 s | ≈ 40 s |

**How to read the 83.5%.** It is the plain average of nine exploratory runs across three datasets, one of which (t1)
was used to develop the prompts. It is validation evidence for this configuration on synthetic data, not a
production-quality guarantee. The trend matters more than the average: **topic precision falls from 92.1% on the
development set to 74.5% on the hold-out**, while recall rises. The pipeline finds the right topics on unseen
domains but does not remove the wrong ones.

The error analysis (310 disposition errors over 9 runs) attributed about **37%** of errors to non-subject candidates
surviving consolidation: peripheral "grab-bag" topics (price + shipping + editions) and meta topics grouped by comment
form ("viewer requests", "video feedback"). Including fragments and hybrids, about 51% came from candidates
consolidation should have dropped or merged. About 34% were residual, spread-out Jev assignment errors.

### Consolidation v4: what did not work

The analysis above led to a single targeted change: **consolidation-v4**, which adds a subject-coherence DROP rule
(drop candidates grouped by comment form or addressee, and bundles of unrelated side subjects). It was tested as a
pre-registered experiment on a fresh hold-out (t4), against v3 as the baseline arm.

- **t4, verdict FAIL** ([postmortem](docs/topic-consolidation-v4-postmortem.md)). One of the three v4 runs failed in
  *discovery* (both attempts rejected for a topic name over five words), so it scored 0 under the pre-registered rule.
  The two valid v4 runs scored 90% topic precision each against v3's 81.8% mean, but the verdict is binding and was
  not revised. The flaw was in the design: discovery ran inside each arm, so a discovery failure decided a
  consolidation verdict.
- **Paired redesign.** The experiment was rebuilt so both contracts consolidate *the same* discovery output
  ([design](docs/topic-consolidation-paired-experiment.md)).
- **t5, verdict INCOMPLETE** ([postmortem](docs/topic-consolidation-paired-t5-postmortem.md)). One of three
  scheduled pairs again lost its discovery to the topic-name limit. In the two available pairs (non-binding), v4
  raised topic precision from 75.0% to 81.8% and Other accuracy from 13.5% to 28.9%, with no recall loss, but stayed
  below the pre-registered 88% floor, and it did not remove the peripheral bundle.

Both experiments pointed back to **discovery reliability** as the bottleneck, which led to the discovery-v3 experiment
above (FAIL) and to an audit of "zero-example" taxonomies: discovery outputs accepted although no topic cites an
example comment ([audit](docs/benchmarks/zero-example-taxonomy-audit.md)).

### Why the current pipeline is `Jev q2.2 → discovery v2 → consolidation v3 → Jev assignment`

```text
classifier:     q1 → q2 → q2.1 → q2.2  (best on dev, confirmed on hold-out)        → jev-q2.2
discovery:      v1 → v2 (generic grouping)  → v3 tested: FAIL                       → discovery-v2
consolidation:  v1 → v2 → v3 → v4 tested: FAIL (t4), INCOMPLETE (t5)                → consolidation-v3
assignment:     Jev, near-deterministic given a taxonomy                             → jev-topic-a1
```

Every alternative that was tested either failed its pre-registered criteria or is unproven, so the app runs the
configuration with the strongest validated evidence (the t1–t3 validation). The equivalence of the app's pipeline and
the benchmark's is itself tested.

---

## Running the web app

### Prerequisites

- **Node.js ≥ 22.12** (see `engines` in `package.json`) and npm.
- For demo mode: nothing else.
- For test data with the real AI pipeline: a TypeSafe Jev key and an Anthropic key.
- For real YouTube analysis: additionally a YouTube Data API v3 key, and CG-1 must allow it.

### Start

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>. The dev server binds to 127.0.0.1 only. For a production build, run `npm run build` and
then `npm start`.

### Using it

1. **Choose a data source** on the Analyze page:
   - **Test data**: pick *Demo*, *m2-synthetic* or *t1-topics-v1* and press **Run analysis**. No URL is needed.
   - **Real YouTube**: enter a video link, read the policy notice, tick the acknowledgement and press **Analyze**. This
     option appears only when all three provider keys are configured, and is disabled with the reason when CG-1 blocks
     it.
2. **Progress** is shown stage by stage (fetching, classifying, discovering, consolidating, assigning, building the
   report). The bar moves with completed stages; the running stage is shown as indeterminate, never as a made-up
   percentage.
3. **The report** opens at `/?id=<analysisId>`. Click a topic to see its sentiment and supporting comments; open the
   comment explorer for search and filters (synthetic data only).
4. **Recent analyses** lists this session's analyses. Reopening one shows the stored result immediately, with no new
   provider calls.
5. **`/evaluation`** shows the benchmark results of the pipeline, by dataset role. **Settings** shows which keys are
   configured (never their values), the models, the limits and the CG-1 state.

### Analyses, IDs and caching

- Each analysis gets an ID and runs on the server, detached from the browser request: leaving the page neither stops
  nor repeats it.
- An analysis is **reused** instead of re-run when the source, the dataset or video ID, and the configuration
  fingerprint (models, contracts, question sets, sampling seed, limits and parameters) are all identical. A changed
  configuration produces a new analysis. Failed analyses are never reused, so a retry runs again.
- Results are kept **in server memory only**: synthetic results for 6 hours, real YouTube results for 30 minutes, at
  most 25 analyses. Nothing is written to disk, and a server restart clears them.

---

## API configuration

Copy the template and fill in your own keys:

```bash
cp .env.example .env
```

| Variable | Used for | Needed for |
|---|---|---|
| `JEV_API_KEY` | TypeSafe Jev: classification and topic assignment | test data (real AI), real YouTube, Jev benchmarks |
| `ANTHROPIC_API_KEY` | Anthropic: topic discovery and consolidation | test data (real AI), real YouTube, topic benchmarks |
| `YOUTUBE_API_KEY` | YouTube Data API v3: fetching comments | real YouTube only |
| `GEMINI_API_KEY` | optional alternative discovery provider in the topic benchmarks | benchmarks only |
| `ANALYSIS_MODE` | default source: `demo` (default) or `real` | optional |
| `ANALYSIS_SOURCE` | with `real`: `fixture` or `youtube` (default) | optional |
| `FIXTURE_DATASET` | with `fixture`: `t1-topics-v1` (default) or `m2` | optional |

The mode variables only set the default selection on the Analyze page. Keys are read on the server only: they are
never sent to the browser, never logged, and never shown on the Settings page (a test scans the production client
bundle for key names and values). `.env` is git-ignored.

---

## YouTube integration and CG-1

**What the code does:**

- A video link (`youtube.com/watch`, `youtu.be`, `/shorts/`, `/live/`, `/embed/`) is parsed into an 11-character video
  ID with no network access; anything else is rejected.
- Comments are fetched with the official YouTube Data API v3, `commentThreads.list`, `order=relevance`,
  `textFormat=plainText`, 100 per page, following `nextPageToken`, up to **500 top-level comments** (at most 50 pages,
  15 s timeout per request). **Replies are not fetched.**
- Only each comment's ID and text are kept. Author names, channel IDs and like counts are discarded on ingestion.
- The API key is sent only as the `key` query parameter and is redacted from every error and log path.
- `npm run youtube:fetch-smoke -- "<url>"` is a fetch-only check: it retrieves comments and prints counts, with no
  classification, no AI provider and no derived analytics.

**CG-1** is the project's compliance gate for YouTube-derived analytics. YouTube's
[Developer Policies](https://developers.google.com/youtube/terms/developer-policies) and the
[derived metrics and data storage policies](https://developers.google.com/youtube/terms/derived-metrics-policy) restrict
creating and storing metrics derived from YouTube API data, and some uses require specific authorization. **Audience
Reaction does not have YouTube approval for derived metrics.** Accordingly:

- by default CG-1 is **blocked**: real YouTube comments are never retrieved or analysed, and the check happens before
  any request is made;
- the only exception is a recorded, time-limited **internal-testing decision** by the maintainer
  (`config/compliance/cg1-internal-testing-exception.json`, explained in
  [docs/compliance/cg1-internal-testing-exception.md](docs/compliance/cg1-internal-testing-exception.md)). It applies
  only to the local development server (`npm run dev`), only while the record is `active` and unexpired (at most 90
  days), and it is not a YouTube approval or a legal determination. A production build (`npm start`) stays blocked.
  Expiry and revocation are enforced by the code: set `status` to `revoked` or let it expire;
- the exception record is the maintainer's own decision for their own testing. It does not authorise anyone else's use
  of YouTube data. If you run real YouTube analysis, you are responsible for complying with the
  [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
  and Developer Policies, including any authorization they require;
- [docs/compliance/youtube-derived-metrics-application.md](docs/compliance/youtube-derived-metrics-application.md)
  collects what a future application for derived-metrics approval would need. It is a preparation document; nothing in
  it has been submitted or approved.

In short: the YouTube API integration is technically implemented; real-data analysis is an internal, time-limited
test; production or SaaS use would require YouTube's approval and a full compliance review.

---

## Privacy and data handling

| Data | Where it goes | Kept? |
|---|---|---|
| Comment text (real YouTube) | **sent to third-party AI processors during the analysis**: every comment to Jev (classification; non-spam comments again for assignment), and up to 400 comments per request to Anthropic for discovery and consolidation (at most 6 requests per analysis, including retries) | in server memory for the duration of the analysis only; not written to disk, logs, fixtures or browser storage. Those providers process it under their own API terms and retention policies. |
| Comment metadata (author, channel, likes) | nowhere | discarded on ingestion |
| Derived report (real YouTube) | the browser that requested it | server memory, 30 minutes; it contains metrics, topic names and comment IDs, but no comment text (the comment explorer is disabled for YouTube data); never written to browser storage |
| Synthetic test data | AI providers (test-data mode) and the browser | server memory 6 hours; the finished report is also kept in the tab's `sessionStorage` (cleared when the tab closes) |
| Keys | the provider each key belongs to | `.env` on your machine; never in the browser, logs or reports |
| Logs | the server console | one line per analysis with counts, statuses, request counts, cost and duration, never comment text, URLs or keys |

These properties are enforced in code and covered by tests (no key values in client bundles or HTML, no comment text in
logs, no YouTube results in browser storage, CG-1 checked before retrieval). They are not a privacy certification. The
app is meant to run locally and has no authentication; do not expose it to a network.

---

## Tests, benchmarks and evaluation

| Command | What it does | Network |
|---|---|---|
| `npm test` | the full suite (≈ 1,700 tests): unit, architecture, security, leakage audits, rendering, endpoint, and an HTTP smoke test that builds and starts the production app | none (the smoke test needs a free port and a few minutes) |
| `npx vitest run --exclude "tests/smoke/**"` | everything except the production smoke test | none |
| `npm run build` | type-check and production build | none |
| `npm run dev` / `npm start` | run the web app | provider calls only when you start a real analysis |
| `npm run benchmark -- --provider fake-keyword` | classifier benchmark plumbing with the offline rule-based classifier (`fake-gold` replays the gold labels); saves a result file to `benchmark-results/` | none |
| `npm run benchmark -- --provider jev --repeats 2 [--dataset m2-heldout-v1]` | live Jev classifier benchmark (default question set `jev-q2.2`) | Jev, billed |
| `npm run benchmark` (no `--provider`) | **defaults to the Anthropic classifier: live and billed** | Anthropic, billed |
| `npm run benchmark-topics -- --dataset t1-topics-v1 --scenario oracle` | topic engine with oracle model outputs | none |
| `npm run benchmark-topics -- --suite replay` | topic contracts against recorded provider responses | none |
| `npm run benchmark-topics -- --suite real-preflight` | renders the real prompts and estimates cost | none |
| `npm run benchmark-topics -- --suite real-consolidated --dataset t1-topics-v1 --live --repeats 1` | the end-to-end topic validation suite (discovery → consolidation → assignment) | Anthropic + Jev, billed |
| `npx tsx src/benchmark/consolidation-experiment-cli.ts --dataset t4-topics-v1` | re-evaluates the archived v4 experiment (exits 1: FAIL) | none |
| `npx tsx src/benchmark/paired-consolidation-cli.ts --dataset t5-topics-v1 --check --experiment paired-consolidation-v3-v4-t5-v1` | re-evaluates the t5 paired experiment (exits 2: INCOMPLETE) | none |
| `npx tsx src/benchmark/discovery-reliability-cli.ts --check` | re-evaluates the discovery-v3 experiment (exits 1: FAIL) | none |
| `npm run jev:models` | lists the Jev models available to your key | Jev (read-only) |
| `npm run youtube:fetch-smoke -- "<url>"` | fetch-only YouTube check | YouTube (CG-1 is not involved: no derived analytics) |

The topic and experiment commands print a plan and refuse to run without `--live`; the classifier benchmark runs live
for `anthropic` and `jev` straight away (after an estimated-cost check against `--max-cost-usd`). Live runs write new
timestamped files to `benchmark-results/` without overwriting anything.

**Which data each kind of test uses:**

- **Development and regression:** the unit, replay and oracle tests, m2-synthetic, t1-topics-v1, and t3 (since its
  detailed inspection).
- **Validation:** t2-topics-v1 (independent of tuning).
- **Final hold-out:** m2-heldout-v1, t4 and t5. Their numbers come only from pre-registered or confirmatory runs and
  are reproduced offline from the archived files. Do not tune against them.

The archived results, their documents and the datasets are pinned by the leakage-audit manifests: changing any of them
makes the audit tests fail, which is intended.

---

## Limitations and open research questions

- **Synthetic data only.** Every benchmark is on hand-written synthetic comments (60–206 per dataset, English only).
  Real comment sections are larger, noisier, multilingual and more varied. Real-world accuracy is unmeasured.
- **Few repeats.** Results are averages of two or three runs; differences of a few points are within run-to-run noise.
- **Topic precision degrades on unseen domains** (92.1% → 83.9% → 74.5% on t1 → t2 → t3), and **Other is largely
  lost** when consolidation keeps peripheral and meta topics (assignment-level Other accuracy 2.7% on t3).
- **Consolidation is the unstable stage.** The number of topics after consolidation varies between repeats (7–9 on t1,
  9–11 on t2), and whether a borderline peripheral topic appears in the report can depend on ±2 comments at the
  minimum-size boundary.
- **Discovery reliability.** In the 40-run reliability experiment, discovery-v2 produced a valid taxonomy on the first
  attempt in only 30% of its runs (95% after the retry), mostly because of the five-word topic-name limit. A small share of accepted
  taxonomies cite no example comments.
- **Prompt-injection steering.** Comments that name a topic in an instruction or a fake label can land in that topic
  (1–2 comments per run); they can then be shown as evidence.
- **Evidence selection** falls back to the lowest comment ID when the assigner returns no confidence, which can surface
  a misassigned comment.
- **Classifier weak spots.** The content target is the weakest task (macro F1 about 0.62 on the hold-out). The
  datasets contain sarcasm, irony and slang cases, but no per-phenomenon accuracy is reported, so performance on
  sarcasm specifically is not established.
- **Gold is a judgement.** Some disagreements are contestable boundary calls (for example whether "price and
  shipping" is a topic or Other).
- **No replies, no time dimension.** Only top-level comments are analysed, and comment dates are not fetched, so there
  is no trend or temporal analysis. Taxonomies are per analysis; there is no tracking of how topics change across
  videos or over time.
- **Local prototype.** No authentication, no persistence beyond memory, no multi-user support.

---

## Roadmap

Grounded in the current state of the repository; nothing below is implemented yet.

- **AI quality**
  - Discovery reliability: a new discovery contract that makes topic-name rules unambiguous and requires example
    comments (a draft pre-registration exists:
    [discovery-v4 draft](docs/benchmarks/discovery-v4-contract-reliability-v1-prereg.md), not run).
  - Then re-test the subject-coherence consolidation idea with a reliable discovery stage and a fresh hold-out.
  - Evidence selection that prefers representative members; hardening assignment against injected labels.
  - Evaluation on real comments under an approved data regime.
- **Analytics**: replies, comment timestamps and trends; comparisons across videos.
- **Product**: report export (derived data only), saved analyses with retention rules, focus/brand configuration in
  the UI.
- **YouTube compliance**: the API audit and derived-metrics approval process before any production use.
- **SaaS infrastructure**: authentication, persistent storage with enforced retention, background jobs, hosting.

---

## Repository layout

```text
.
├── README.md
├── spec.md                          requirements and design specification (cited as spec.md §… in the code)
├── m4-topic-provider-design.md      design of the two-phase topic pipeline
├── topic-provider-contracts-v1.md   provider-neutral prompt contracts (discovery, assignment)
├── topic-provider-adapters-v1.md    provider adapters and benchmark commands
├── config/                          models, limits, prices, evaluation manifest, CG-1 record
├── docs/                            validation reports, pre-registrations, postmortems, compliance
├── fixtures/                        synthetic datasets with gold labels and leakage audits; replay responses
├── benchmark-results/               archived benchmark runs (evidence for every result above)
├── public/                          icons
├── src/
│   ├── core/                        domain, schema, aggregation, topics, policy, cost
│   ├── application/                 use cases and pipeline orchestration
│   ├── adapters/                    YouTube, fixtures, Jev, Anthropic, Gemini, fakes, replay
│   ├── local/                       server-only composition root (config, keys, CG-1, cache)
│   ├── web/  app/                   Next.js UI and API route
│   └── benchmark/                   benchmarks, experiment runners and evaluators
└── tests/                           unit, architecture, security, leakage audits, rendering, smoke
```

`spec.md` and the design documents were written during development and refer to some internal planning notes that are
not part of this repository. Where they differ from the code, the code and this README describe the current behaviour.

## Documentation index

| Document | Content |
|---|---|
| [docs/topic-validation-t1-t2-t3-sonnet-v3.md](docs/topic-validation-t1-t2-t3-sonnet-v3.md) | end-to-end validation of the current topic pipeline, error attribution |
| [docs/topic-validation-t1-t2-sonnet-v3.md](docs/topic-validation-t1-t2-sonnet-v3.md) | the earlier t1/t2 validation |
| [docs/topic-consolidation-v4-experiment.md](docs/topic-consolidation-v4-experiment.md) | pre-registration of consolidation-v4 on t4 |
| [docs/topic-consolidation-v4-postmortem.md](docs/topic-consolidation-v4-postmortem.md) | its FAIL verdict and analysis |
| [docs/topic-consolidation-paired-experiment.md](docs/topic-consolidation-paired-experiment.md) | the paired experiment design |
| [docs/topic-consolidation-paired-t5-preregistration.md](docs/topic-consolidation-paired-t5-preregistration.md) | pre-registration on t5 |
| [docs/topic-consolidation-paired-t5-postmortem.md](docs/topic-consolidation-paired-t5-postmortem.md) | its INCOMPLETE verdict |
| [docs/topic-discovery-v3-reliability-preregistration.md](docs/topic-discovery-v3-reliability-preregistration.md) | pre-registration of discovery-v3 |
| [docs/benchmarks/discovery-v3-name-robustness-v1-postmortem.md](docs/benchmarks/discovery-v3-name-robustness-v1-postmortem.md) | its FAIL verdict |
| [docs/benchmarks/zero-example-taxonomy-audit.md](docs/benchmarks/zero-example-taxonomy-audit.md) | audit of taxonomies without examples |
| [docs/benchmarks/discovery-v4-contract-reliability-v1-prereg.md](docs/benchmarks/discovery-v4-contract-reliability-v1-prereg.md) | draft of the next discovery experiment (not run) |
| [docs/topic-real-consolidated-instrumentation.md](docs/topic-real-consolidated-instrumentation.md) | result-file instrumentation (schema v2) |
| [docs/compliance/](docs/compliance/) | the CG-1 internal-testing record and the derived-metrics preparation notes |
