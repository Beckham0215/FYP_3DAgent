"""Evaluate intent classification accuracy (requires GROQ_API_KEY).

Runs each test message through route_intent and compares the returned
intent label against the ground truth.  Computes:

  * overall accuracy with a 95% Wilson confidence interval
  * per-class precision / recall / F1 with support
  * macro-F1 and support-weighted-F1
  * slot-filling accuracy (destination_label / asset_name / query_area)
  * activity-routing accuracy (a high-value slot sub-metric)
  * self-consistency across repeated runs (LLM is stochastic at T>0)
  * latency p50 / p95

Set EVAL_REPEATS (or pass repeats=) > 1 to measure run-to-run stability.
"""

import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from collections import Counter
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional

from eval.datasets import INTENT_CASES, INTENT_ROBUSTNESS_CASES, INTENT_CLASSES
from eval.metrics import (
    precision_recall_f1_per_class,
    macro_f1,
    weighted_f1,
    confusion_matrix,
    wilson_ci,
    percentile,
)


@dataclass
class IntentResult:
    name: str = "intent"
    total: int = 0
    correct: int = 0
    overall_accuracy: float = 0.0
    ci_low: float = 0.0
    ci_high: float = 0.0
    macro_f1: float = 0.0
    weighted_f1: float = 0.0
    per_class: Dict[str, Dict[str, float]] = field(default_factory=dict)
    conf_matrix: Dict[str, Dict[str, int]] = field(default_factory=dict)
    avg_latency_ms: float = 0.0
    p50_latency_ms: float = 0.0
    p95_latency_ms: float = 0.0
    # slot-filling
    slot_total: int = 0
    slot_correct: int = 0
    slot_accuracy: float = 0.0
    activity_total: int = 0
    activity_correct: int = 0
    activity_accuracy: float = 0.0
    # stochastic stability
    repeats: int = 1
    consistency: float = 1.0  # mean fraction of runs that agree with the modal label
    # robustness (paraphrase / typo probes)
    robustness_total: int = 0
    robustness_correct: int = 0
    robustness_accuracy: float = 0.0
    # data-quality guard: API errors (e.g. rate limits) that would otherwise be
    # silently counted as wrong predictions and corrupt the metrics.
    errored: int = 0
    robustness_errored: int = 0
    cases: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None


def _slot_check(case, result: dict) -> Optional[bool]:
    """Return True/False if this case carries a checkable slot, else None.

    Only evaluates the slot that matters for the case's intent, mirroring how
    route_intent populates fields per intent.
    """
    if case.expected_destination is not None:
        pred = (result.get("destination_label") or "").strip().lower()
        return pred == case.expected_destination.strip().lower()
    if case.expected_asset_name is not None:
        pred = (result.get("asset_name") or "").strip().lower()
        # asset names are free-form; accept substring containment either way
        exp = case.expected_asset_name.strip().lower()
        return exp in pred or pred in exp if pred else False
    if case.expected_query_area is not None:
        pred = (result.get("query_area") or "").strip().lower()
        exp = case.expected_query_area.strip().lower()
        # '__current__' / '__all__' sentinels accepted for "here"/"total" phrasing
        return pred == exp or (exp in pred) or pred in ("__current__", "__all__")
    return None


def _run_once(route_intent, cases) -> List[Dict[str, Any]]:
    """One full pass over the cases. Returns per-case raw outputs."""
    out = []
    for case in cases:
        rec: Dict[str, Any] = {"message": case.message,
                               "expected": case.expected_intent}
        try:
            t0 = time.perf_counter()
            result = route_intent(case.message, case.labels)
            rec["latency_ms"] = (time.perf_counter() - t0) * 1000
            rec["predicted"] = result.get("intent", "conversational")
            rec["slot_ok"] = _slot_check(case, result)
            rec["destination_label"] = result.get("destination_label")
            rec["asset_name"] = result.get("asset_name")
            rec["query_area"] = result.get("query_area")
        except Exception as exc:
            rec["latency_ms"] = 0.0
            rec["predicted"] = "ERROR"
            rec["slot_ok"] = None
            rec["error"] = str(exc)
        out.append(rec)
    return out


def run(repeats: Optional[int] = None) -> IntentResult:
    """Call Groq API for each test case and evaluate intent routing."""
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        return IntentResult(error="GROQ_API_KEY not set — skipping intent evaluation.")

    if repeats is None:
        repeats = int(os.environ.get("EVAL_REPEATS", "1"))
    repeats = max(1, repeats)

    from flask import Flask
    from app.services.groq_service import route_intent

    app = Flask(__name__)
    app.config["GROQ_API_KEY"] = api_key
    app.config["GROQ_API_KEY_2"] = os.environ.get("GROQ_API_KEY_2", "")
    app.config["GROQ_MODEL"] = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

    with app.app_context():
        # Repeated passes over the main set to measure stability.
        all_passes = [_run_once(route_intent, INTENT_CASES) for _ in range(repeats)]
        robustness_pass = _run_once(route_intent, INTENT_ROBUSTNESS_CASES)

    # Aggregate the *first* pass for the headline confusion matrix / per-class,
    # but report accuracy/consistency across all passes.
    primary = all_passes[0]
    predictions = [r["predicted"] for r in primary]
    ground_truth = [r["expected"] for r in primary]

    latencies = [r["latency_ms"] for p in all_passes for r in p if r["latency_ms"] > 0]

    # Per-case modal prediction + consistency across repeats
    consistency_scores = []
    cases_out: List[Dict[str, Any]] = []
    for i, case in enumerate(INTENT_CASES):
        preds = [all_passes[k][i]["predicted"] for k in range(repeats)]
        modal, modal_n = Counter(preds).most_common(1)[0]
        consistency_scores.append(modal_n / repeats)
        rec = primary[i]
        cases_out.append({
            "message": case.message,
            "expected": case.expected_intent,
            "predicted": rec["predicted"],
            "pass": rec["predicted"] == case.expected_intent,
            "latency_ms": round(rec["latency_ms"], 1),
            "slot_ok": rec.get("slot_ok"),
            "destination_label": rec.get("destination_label"),
            "asset_name": rec.get("asset_name"),
            "query_area": rec.get("query_area"),
            "consistency": modal_n / repeats,
            "all_preds": preds if repeats > 1 else None,
        })

    total = len(INTENT_CASES)
    correct = sum(1 for c in cases_out if c["pass"])
    per_cls = precision_recall_f1_per_class(predictions, ground_truth, INTENT_CLASSES)
    cm = confusion_matrix(predictions, ground_truth, INTENT_CLASSES)
    ci_low, ci_high = wilson_ci(correct, total)

    # Slot-filling accuracy (only over cases that carry a slot)
    slot_checks = [c["slot_ok"] for c in cases_out if c["slot_ok"] is not None]
    slot_total = len(slot_checks)
    slot_correct = sum(1 for s in slot_checks if s)

    # Activity-routing accuracy (activity intent → destination_label)
    act = [(c["slot_ok"], c["pass"]) for c, case in zip(cases_out, INTENT_CASES)
           if case.expected_intent == "activity"]
    activity_total = len(act)
    activity_correct = sum(1 for slot_ok, intent_ok in act if slot_ok and intent_ok)

    # Robustness
    rob_correct = sum(1 for r, case in zip(robustness_pass, INTENT_ROBUSTNESS_CASES)
                      if r["predicted"] == case.expected_intent)
    rob_total = len(INTENT_ROBUSTNESS_CASES)
    rob_errored = sum(1 for r in robustness_pass if r["predicted"] == "ERROR")

    # Count API errors in the primary pass (rate limits etc.)
    errored = sum(1 for c in cases_out if c["predicted"] == "ERROR")

    return IntentResult(
        total=total,
        correct=correct,
        overall_accuracy=correct / total if total else 0.0,
        ci_low=ci_low,
        ci_high=ci_high,
        macro_f1=macro_f1(per_cls),
        weighted_f1=weighted_f1(per_cls),
        per_class=per_cls,
        conf_matrix=cm,
        avg_latency_ms=sum(latencies) / len(latencies) if latencies else 0.0,
        p50_latency_ms=percentile(latencies, 50),
        p95_latency_ms=percentile(latencies, 95),
        slot_total=slot_total,
        slot_correct=slot_correct,
        slot_accuracy=slot_correct / slot_total if slot_total else 0.0,
        activity_total=activity_total,
        activity_correct=activity_correct,
        activity_accuracy=activity_correct / activity_total if activity_total else 0.0,
        repeats=repeats,
        consistency=sum(consistency_scores) / len(consistency_scores) if consistency_scores else 1.0,
        robustness_total=rob_total,
        robustness_correct=rob_correct,
        robustness_accuracy=rob_correct / rob_total if rob_total else 0.0,
        errored=errored,
        robustness_errored=rob_errored,
        cases=cases_out,
    )
