# 3DAgent — Evaluation Framework Review & Upgrade Report

**Project:** 3DAgent (Matterport 3D-space conversational agent)
**Date:** 2026-06-18
**Scope:** Critical assessment of the existing automated-evaluation suite (`eval/`), an upgrade addressing its defects, a live run against the Groq LLM backend, and the results.

---

## Executive Summary

The question posed was: *is the current evaluation good enough, and is there room for improvement?* The answer is **no, it was not good enough**, and the gaps were substantial:

1. **One evaluator was silently broken.** `activity_map` imported `get_location_for_activity()`, a function that no longer exists in the codebase — it crashed on every run.
2. **The intent taxonomy was stale.** The suite tested **8** intents; the live router (`route_intent`) now classifies **14**. Six intents (43% of the taxonomy) — `list_locations`, `report_issue`, `list_problems`, `scan_area`, `auto_tag`, `show_floorplan` — were **completely untested**.
3. **The headline AI metrics never actually ran.** Integration tests read `GROQ_API_KEY` from the shell, but the key lives only in `.env`. In practice the intent and ReAct evaluators were perpetually *skipped*.
4. **The "passing" evaluators were trivial.** Four of seven evaluators test deterministic pure functions (regex/dict lookups). Scoring 100% on them is expected and says little about system quality — they are unit tests presented as an evaluation.
5. **No statistical rigour.** Single run, no confidence intervals, no measure of LLM run-to-run stability, no robustness probes, no support-weighted metrics, no token/cost awareness, no pass/fail gating.

This report documents an upgrade that fixes all five issues, and a live run whose results are **genuinely informative** for the first time: the intent router scores **98.6% accuracy (95% CI 92.3–99.7%)** across the full 14-class taxonomy with **100% slot-filling accuracy**. The run also surfaced a real operational constraint — the Groq **free-tier daily token cap (100,000 TPD)** is too small to run the enlarged LLM evaluators repeatedly in one day — which corrupted the ReAct, robustness, and self-consistency measurements. New data-quality guards now **detect and flag** that contamination instead of silently reporting it as model failure.

---

## 1. Background & Scope

The `eval/` suite evaluates the components of 3DAgent that turn a user utterance into an action:

| Component | Function under test | Type |
|---|---|---|
| Label resolution | `resolve_asset()` | Deterministic |
| Vision parsing | `parse_groq_vision_response()`, `_parse_blip_detection_response()` | Deterministic |
| Scan diffing | `_compute_scan_diff()` | Deterministic |
| API latency | Flask DB endpoints | Deterministic |
| Intent routing | `route_intent()` | **LLM (Groq)** |
| ReAct parsing | `parse_react_request()` | **LLM (Groq)** |
| ~~Activity mapping~~ | ~~`get_location_for_activity()`~~ | **Removed from app** |

Only the two LLM components exercise the part of the system whose behaviour is uncertain and therefore worth *evaluating* rather than *unit-testing*.

---

## 2. Assessment of the Previous Framework

### 2.1 Correctness defects

- **Broken evaluator (`activity_map`).** `app.services.groq_service.get_location_for_activity` was deleted when activity→location logic moved into the LLM prompt. The evaluator still imported it and raised `ImportError` on every run. Activity routing was, as a result, **not tested at all**.
- **Stale taxonomy.** `INTENT_CLASSES` listed 8 classes; `route_intent` emits 14. The confusion matrix, per-class metrics, and macro-F1 were computed over a label set that did not match the system, and six intents had zero coverage.

### 2.2 Procedural defects

- **Integration tests never executed.** The runner relied on `os.environ["GROQ_API_KEY"]`, but the project stores the key in `.env` (loaded only inside `create_app`). Running `python eval/run_eval.py --integration` reported *"GROQ_API_KEY not set — skipping"*. The two most important evaluators produced no data.

### 2.3 Methodological weaknesses

- **Trivial targets.** label_match, vision_parser, scan_diff are deterministic; 100% is the only acceptable score and conveys no information about model quality.
- **No uncertainty quantification.** A single pass with no confidence interval; with only 5 examples per class a point estimate is fragile.
- **No stochastic-stability measure.** `route_intent` runs at `temperature=0.2` — it is non-deterministic — yet was sampled once.
- **No robustness testing.** All intent examples were near-paraphrases of the few-shot exemplars *inside the prompt*, measuring memorisation rather than generalisation.
- **No imbalance-aware metric**, **no token/cost tracking**, **no regression persistence**, and **no pass/fail exit code** for CI use.

---

## 3. Upgrades Implemented

| Area | Change |
|---|---|
| **Broken evaluator** | Removed dead `activity_map`; activity routing is now measured by the intent evaluator's **activity-routing slot metric** (does `route_intent` return `intent=activity` *and* the correct `destination_label`?). |
| **Taxonomy** | `INTENT_CLASSES` expanded 8 → **14**; added 30 new labelled cases (5 per new intent). Intent dataset grew from 40 → **70** cases. |
| **`.env` auto-load** | `run_eval.py` now calls `load_dotenv()`, so integration tests run without manual env exports. Honours the `GROQ_API_KEY_2` fallback key. |
| **Confidence intervals** | Added **Wilson score 95% CI** (`metrics.wilson_ci`) — appropriate for small *n* and proportions near 1. |
| **Imbalance-aware metric** | Added **support-weighted F1** alongside macro-F1. |
| **Slot-filling accuracy** | Intent evaluator now scores `destination_label` / `asset_name` / `query_area` extraction, not just the intent label. |
| **Robustness probes** | New 15-case set (`INTENT_ROBUSTNESS_CASES`) of typos, slang, and indirect phrasings that deliberately differ from the prompt's exemplars. |
| **Self-consistency** | `--repeats N` runs each case *N* times and reports the mean modal-agreement rate (stochastic stability). |
| **Latency** | Intent latency reported as p50/p95 (not just mean). |
| **Data-quality guards** | Track API errors per pass; ReAct flags **suspected throttling** when >60% of outputs are the identical `chair/1` default. Contaminated evaluators are exempted from the pass/fail gate. |
| **Persistence & gating** | `--save-json` writes a metric summary for trend tracking; `THRESHOLDS` + `--strict` give a CI-style pass/fail exit code. |
| **ReAct** | Added Wilson CI, separate count-accuracy metric, and 4 extra cases (7 → 11). |

---

## 4. Methodology & Metrics

- **Model:** `llama-3.3-70b-versatile` (Groq), `temperature=0.2` for routing, `0.1` for ReAct parsing.
- **Run:** `python eval/run_eval.py --integration --repeats 3`.
- **Metrics:** accuracy with Wilson 95% CI; per-class precision/recall/F1 with support; macro-F1 and support-weighted-F1; confusion matrix; slot-filling accuracy; activity-routing accuracy; robustness accuracy; self-consistency over repeats; latency p50/p95; ReAct asset/count accuracy and MAE.
- **Thresholds:** deterministic parsers 0.95–1.00; LLM evaluators 0.85.

---

## 5. Results

### 5.1 Deterministic components — all pass (sanity baseline)

| Evaluator | Accuracy | Cases |
|---|---|---|
| Label resolution | 100.0% | 20/20 (exact, case, partial, fuzzy, no-match) |
| Vision parser — Groq | 100.0% | 14/14 |
| Vision parser — BLIP fallback | 100.0% | 7/7 |
| Scan-change detection | 100.0% | 7/7 |

These confirm the parsing/diff logic is correct but, being deterministic, carry no model-quality signal.

### 5.2 Intent classification — **valid, and strong**

The intent evaluator's primary pass completed *before* the token budget was exhausted, so these figures are trustworthy:

| Metric | Value |
|---|---|
| **Accuracy** | **98.6% (69/70)** |
| 95% Wilson CI | **[92.3%, 99.7%]** |
| Macro-F1 | 98.6% |
| Weighted-F1 | 98.6% |
| **Slot-filling accuracy** | **100% (25/25)** |
| **Activity-routing accuracy** | **100% (5/5)** |

Per-class F1 was 1.00 for 12 of 14 intents. The only imperfect classes:

| Intent | Precision | Recall | F1 |
|---|---|---|---|
| `visual` | 1.00 | 0.80 | 0.89 |
| `query_assets` | 0.83 | 1.00 | 0.91 |

**The single error:** *"what objects are in this room"* was routed to `query_assets` (expected `visual`). This is a genuinely ambiguous utterance — it can mean "describe the live view" *or* "list the catalogued assets here" — and the confusion is confined to that one semantically overlapping pair. The six newly-added intents (`list_locations`, `report_issue`, `list_problems`, `scan_area`, `auto_tag`, `show_floorplan`) all scored **perfect F1**, indicating the router generalises cleanly to the expanded taxonomy.

### 5.3 LLM evaluators blocked by the free-tier token cap

The `--repeats 3` sweep over 70 intent cases (each with a ~1.2k-token system prompt) consumed the entire Groq free-tier **daily** allowance. The API returned:

> `Error code: 429 — Rate limit reached … tokens per day (TPD): Limit 100000, Used 99979 …`

Consequently the following ran *after* exhaustion and are **contaminated, not reported as model quality**:

| Metric | Observed | Status |
|---|---|---|
| Self-consistency (3 runs) | 66.7% | **Artifact** — runs 2 & 3 were rate-limited to `ERROR`, forcing a 2/3 ceiling on every case. |
| Robustness (15 probes) | 0/15 | **Artifact** — all 15 calls were rate-limited. The new guard flags `15 robustness cases errored`. |
| ReAct asset accuracy | 72.7% | **Artifact** — 100% of cases returned the default `chair/1`; the 72.7% is coincidental matching of the default against chair-expecting cases. |

A single un-throttled probe parsed *"I need a meeting room for 10 people"* correctly as `{asset: chair, min_count: 10}`, and a **rate-limited, 8-second-spaced** retry recovered to asset 9/11 and count 5/11 — but still with a 55% default-fallback rate. **A clean ReAct/robustness/consistency measurement is not possible within the free-tier daily cap and must be run after the daily reset (or on a paid tier).**

This is itself a key finding: the enlarged, repeated LLM evaluation now exceeds what the free tier can serve in one day (≈120k tokens for a single `--repeats 1 --integration` pass vs. the 100k cap).

### 5.4 Latency

- **DB-backed API endpoints:** p50 **1.1–1.9 ms**, p95 ≤ 10 ms, 100% success — excellent.
- **Intent routing latency** as recorded (p50 8.7 s) is **not representative**: it is inflated by rate-limit back-off during the contaminated run. A single un-throttled `route_intent` call returns in roughly 2–4 s.

---

## 6. Discussion

The upgrade changed the evaluation from a green wall of trivially-passing unit tests into a measurement that produces real, defensible signal. The headline result — **98.6% intent accuracy across 14 classes with perfect slot-filling** — is meaningful precisely because the taxonomy now matches the deployed system and the metric carries a confidence interval. The lone misclassification points to a concrete, addressable ambiguity (`visual` vs. `query_assets`) rather than a systemic weakness.

Equally important, the run exposed two problems the old suite could never have caught: a **silently broken evaluator** and an **operational ceiling on evaluation itself** (the token cap). The new data-quality guards mean that a future rate-limited run will be loudly flagged as unreliable rather than quietly recorded as a 0% model score.

---

## 7. Threats to Validity

- **Token-cap contamination.** As detailed in §5.3, ReAct, robustness, and self-consistency could not be measured cleanly. Treat them as *pending*, not failing.
- **Small per-class samples.** Five examples per intent give wide confidence intervals; a single error moves a class F1 from 1.00 to ~0.89. More examples per class would tighten the estimates.
- **In-distribution intent cases.** The 70 core cases paraphrase the prompt's own exemplars. The robustness set was designed to counter this but could not be run; until it is, the 98.6% may overstate real-world generalisation.
- **Single model / single temperature.** Results are specific to `llama-3.3-70b-versatile` at T=0.2.

---

## 8. Recommendations

1. **Re-run the LLM evaluators after the daily token reset** (or on a paid Groq tier) to obtain clean robustness, ReAct, and self-consistency numbers. Default `--repeats` is now 1 to keep a single integration pass affordable.
2. **Budget tokens / shard the run.** A full `--repeats 1 --integration` pass needs ≈120k tokens; either split intent and ReAct across two days on the free tier, or upgrade the tier.
3. **Disambiguate `visual` vs. `query_assets`** in the router prompt — e.g. clarify that "what objects are *in this room*" without a live-view verb leans toward `query_assets`, while "what do you *see*" is `visual`.
4. **Grow the dataset** to ≥15 examples per intent and fold the robustness probes into the standard run once budget allows.
5. **Surface ReAct's swallowed errors.** `parse_react_request` silently returns `chair/1` on failure; consider propagating an error flag so the agent (and the evaluator) can distinguish "model said chair" from "call failed".
6. **Wire `--strict` into CI** so regressions below threshold fail the build (now possible via the JSON summary + exit code).

---

## 9. Conclusion

The previous evaluation was **not adequate**: it contained a crashing evaluator, tested a taxonomy 6 classes out of date, never actually called the LLM, and reported only trivial deterministic passes. The upgraded suite fixes these defects and adds confidence intervals, weighted-F1, slot-filling, robustness probes, self-consistency, latency percentiles, persistence, threshold gating, and — prompted by this very run — automatic detection of rate-limit contamination. The clean results show a **strong, well-characterised intent router (98.6%, CI 92.3–99.7%, 14 classes, 100% slot-filling)**. The remaining LLM metrics are well-defined and ready to run, blocked only by the free-tier daily token cap, for which concrete remediation is given above.

---

## Appendix — How to run

```bash
# Deterministic evaluators only (no API, instant)
python eval/run_eval.py

# Full suite incl. LLM evaluators (auto-loads .env)
python eval/run_eval.py --integration

# Measure LLM self-consistency (token-expensive — see §8.2)
python eval/run_eval.py --integration --repeats 3

# CI mode: non-zero exit if any clean evaluator misses its threshold
python eval/run_eval.py --integration --strict

# Single evaluator
python eval/run_eval.py --only intent
```

Artifacts: `eval_report.html` (visual report), `eval_results.json` (machine-readable summary for trend tracking).
