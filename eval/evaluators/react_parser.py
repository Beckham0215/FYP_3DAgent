"""Evaluate ReAct request parsing accuracy (requires GROQ_API_KEY).

Tests parse_react_request() against labelled planning queries and
measures asset-type extraction accuracy and count-extraction MAE.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional

from eval.datasets import REACT_PARSER_CASES
from eval.metrics import accuracy, mean_absolute_error, wilson_ci


@dataclass
class ReactParserResult:
    name: str = "react_parser"
    total: int = 0
    asset_correct: int = 0
    asset_accuracy: float = 0.0
    asset_ci_low: float = 0.0
    asset_ci_high: float = 0.0
    count_mae: float = 0.0
    count_correct: int = 0
    count_accuracy: float = 0.0
    exact_matches: int = 0  # both asset AND count correct
    exact_accuracy: float = 0.0
    # data-quality guard. parse_react_request() swallows API errors and returns
    # its default {"asset":"chair","min_count":1}, so a run that is silently
    # rate-limited looks like a uniform chair/1 prediction. Flag that case.
    suspected_throttling: bool = False
    default_fallback_rate: float = 0.0
    cases: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None


def run() -> ReactParserResult:
    """Call Groq API for each planning query and evaluate parsed output."""
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        return ReactParserResult(
            error="GROQ_API_KEY not set — skipping react_parser evaluation."
        )

    from flask import Flask
    from app.services.groq_service import parse_react_request

    app = Flask(__name__)
    app.config["GROQ_API_KEY"] = api_key
    app.config["GROQ_MODEL"] = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

    asset_preds: List[str] = []
    asset_truth: List[str] = []
    count_preds: List[int] = []
    count_truth: List[int] = []
    cases_out: List[Dict[str, Any]] = []

    with app.app_context():
        for case in REACT_PARSER_CASES:
            try:
                result = parse_react_request(case.request)
            except Exception as exc:
                cases_out.append({
                    "request": case.request,
                    "expected_asset": case.expected_asset,
                    "expected_count": case.expected_min_count,
                    "predicted_asset": "ERROR",
                    "predicted_count": 0,
                    "asset_pass": False,
                    "count_pass": False,
                    "pass": False,
                    "error": str(exc),
                })
                asset_preds.append("")
                asset_truth.append(case.expected_asset)
                count_preds.append(0)
                count_truth.append(case.expected_min_count)
                continue

            pred_asset = (result.get("asset") or "").lower().strip()
            pred_count = result.get("min_count", 1)
            asset_ok = pred_asset == case.expected_asset
            count_ok = pred_count == case.expected_min_count

            asset_preds.append(pred_asset)
            asset_truth.append(case.expected_asset)
            count_preds.append(pred_count)
            count_truth.append(case.expected_min_count)

            cases_out.append({
                "request": case.request,
                "expected_asset": case.expected_asset,
                "expected_count": case.expected_min_count,
                "predicted_asset": pred_asset,
                "predicted_count": pred_count,
                "asset_pass": asset_ok,
                "count_pass": count_ok,
                "pass": asset_ok and count_ok,
                "reasoning": result.get("reasoning", ""),
            })

    total = len(REACT_PARSER_CASES)
    asset_correct = sum(1 for p, g in zip(asset_preds, asset_truth) if p == g)
    count_correct = sum(1 for p, g in zip(count_preds, count_truth) if p == g)
    exact = sum(1 for c in cases_out if c.get("pass"))
    ci_low, ci_high = wilson_ci(asset_correct, total)

    # Heuristic throttling detector: fraction of cases that returned the exact
    # default fallback. >60% strongly suggests the API was rate-limited and the
    # accuracy figures are not measuring the model.
    default_hits = sum(1 for c in cases_out
                       if c.get("predicted_asset") == "chair"
                       and c.get("predicted_count") == 1)
    default_rate = default_hits / total if total else 0.0
    suspected = default_rate > 0.6

    return ReactParserResult(
        total=total,
        asset_correct=asset_correct,
        asset_accuracy=asset_correct / total if total else 0.0,
        asset_ci_low=ci_low,
        asset_ci_high=ci_high,
        count_mae=mean_absolute_error(count_preds, count_truth),
        count_correct=count_correct,
        count_accuracy=count_correct / total if total else 0.0,
        exact_matches=exact,
        exact_accuracy=exact / total if total else 0.0,
        suspected_throttling=suspected,
        default_fallback_rate=default_rate,
        cases=cases_out,
    )
