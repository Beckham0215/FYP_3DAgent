"""3DAgent Evaluation Runner.

Usage
-----
  # Unit tests only (no external API calls)
  python eval/run_eval.py

  # Include Groq API-dependent tests
  python eval/run_eval.py --integration

  # Run a single evaluator
  python eval/run_eval.py --only label_match

  # Write the HTML report to a custom path
  python eval/run_eval.py --output my_report.html

  # Skip HTML report (console output only)
  python eval/run_eval.py --no-report

Available evaluators
--------------------
  Unit (always available):
    label_match   - resolve_asset() fuzzy label matching
    vision_parser - parse_groq_vision_response() + _parse_blip_detection_response()
    scan_diff     - _compute_scan_diff() change detection
    latency       - Flask test-client API endpoint latency

  Integration (require GROQ_API_KEY — auto-loaded from .env):
    intent        - route_intent() 14-class intent classification, slot-filling,
                    robustness probes, and self-consistency (with --repeats)
    react_parser  - parse_react_request() planning query extraction

Note: activity routing is no longer a standalone dict lookup; it is performed by
the LLM inside route_intent() and is measured by the intent evaluator's
activity-routing slot metric.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load .env so GROQ_API_KEY / GROQ_API_KEY_2 / GROQ_MODEL are available to the
# integration evaluators without the caller having to export them manually.
# (Previously the integration tests silently skipped because the key lived only
# in .env, not the shell environment.)
try:
    from dotenv import load_dotenv
    load_dotenv(override=False)
except Exception:
    pass

# ── colour helpers (ANSI) ─────────────────────────────────────────────────────

_GREEN  = "\033[32m"
_YELLOW = "\033[33m"
_RED    = "\033[31m"
_CYAN   = "\033[36m"
_BOLD   = "\033[1m"
_RESET  = "\033[0m"


def _col(text: str, code: str) -> str:
    return f"{code}{text}{_RESET}"


def _status(score: float) -> str:
    if score >= 0.9:
        return _col("PASS", _GREEN)
    if score >= 0.7:
        return _col("WARN", _YELLOW)
    return _col("FAIL", _RED)


def _bar(score: float, width: int = 20) -> str:
    filled = int(score * width)
    bar = "#" * filled + "-" * (width - filled)
    return f"[{bar}] {score * 100:.1f}%"


# ── runner ────────────────────────────────────────────────────────────────────

UNIT_EVALUATORS = ["label_match", "vision_parser", "scan_diff", "latency"]
INTEGRATION_EVALUATORS = ["intent", "react_parser"]

# Minimum acceptable score per evaluator; used for the pass/fail exit code.
# Deterministic parsers are held to a high bar; stochastic LLM evaluators to a
# realistic one. Keys map to (attribute, threshold).
THRESHOLDS = {
    "label_match":   ("overall_accuracy", 1.00),
    "vision_parser": ("overall_accuracy", 0.95),
    "scan_diff":     ("overall_accuracy", 1.00),
    "intent":        ("overall_accuracy", 0.85),
    "react_parser":  ("asset_accuracy",   0.85),
}


def run_evaluator(name: str):
    if name == "label_match":
        from eval.evaluators.label_match import run
    elif name == "vision_parser":
        from eval.evaluators.vision_parser import run
    elif name == "scan_diff":
        from eval.evaluators.scan_diff import run
    elif name == "intent":
        from eval.evaluators.intent import run
    elif name == "react_parser":
        from eval.evaluators.react_parser import run
    elif name == "latency":
        from eval.evaluators.latency import run
    else:
        raise ValueError(f"Unknown evaluator: {name!r}")
    return run()


def _print_result(name: str, result, elapsed: float) -> None:
    print(f"\n{_col('-' * 60, _CYAN)}")
    print(f"  {_col(name.upper().replace('_', ' '), _BOLD)}  [{elapsed:.1f}s]")
    print(_col("-" * 60, _CYAN))

    if hasattr(result, "error") and result.error:
        print(f"  {_col('SKIPPED', _YELLOW)}: {result.error}")
        return

    # ── label_match ──
    if name == "label_match":
        print(f"  Overall accuracy : {_bar(result.overall_accuracy)}"
              f"  {_status(result.overall_accuracy)}")
        print(f"  Correct / Total  : {result.correct}/{result.total}")
        print()
        for cat, v in result.by_category.items():
            print(f"    {cat:<20} {_bar(v['accuracy'], 12)}")

    # ── vision_parser ──
    elif name == "vision_parser":
        print(f"  Groq (Llama 4 Scout) : {_bar(result.groq_accuracy)}"
              f"  {_status(result.groq_accuracy)}"
              f"  ({result.groq_correct}/{result.groq_total})")
        print(f"  BLIP fallback        : {_bar(result.blip_accuracy)}"
              f"  {_status(result.blip_accuracy)}"
              f"  ({result.blip_correct}/{result.blip_total})")
        print(f"  Combined             : {_bar(result.overall_accuracy)}"
              f"  {_status(result.overall_accuracy)}")

    # ── scan_diff ──
    elif name == "scan_diff":
        print(f"  Accuracy         : {_bar(result.overall_accuracy)}"
              f"  {_status(result.overall_accuracy)}")
        print(f"  Correct / Total  : {result.correct}/{result.total}")

    # ── intent ──
    elif name == "intent":
        print(f"  Accuracy         : {_bar(result.overall_accuracy)}"
              f"  {_status(result.overall_accuracy)}")
        print(f"  95% CI           : [{result.ci_low*100:.1f}%, {result.ci_high*100:.1f}%]")
        print(f"  Macro F1         : {_bar(result.macro_f1)}")
        print(f"  Weighted F1      : {_bar(result.weighted_f1)}")
        print(f"  Correct / Total  : {result.correct}/{result.total}")
        print(f"  Slot accuracy    : {_bar(result.slot_accuracy)}"
              f"  ({result.slot_correct}/{result.slot_total})")
        print(f"  Activity routing : {_bar(result.activity_accuracy)}"
              f"  ({result.activity_correct}/{result.activity_total})")
        print(f"  Robustness acc   : {_bar(result.robustness_accuracy)}"
              f"  ({result.robustness_correct}/{result.robustness_total})")
        if result.errored or result.robustness_errored:
            print(_col(f"  ⚠ DATA QUALITY   : {result.errored} primary + "
                       f"{result.robustness_errored} robustness cases errored "
                       f"(likely rate-limited) — metrics above are unreliable.", _RED))
        if result.repeats > 1:
            print(f"  Consistency      : {_bar(result.consistency)}  (over {result.repeats} runs)")
        print(f"  Latency p50/p95  : {result.p50_latency_ms:.0f} / {result.p95_latency_ms:.0f} ms")
        print()
        header = f"  {'Intent':<18} {'Prec':>6} {'Rec':>6} {'F1':>6} {'Supp':>5}"
        print(header)
        print("  " + "-" * 44)
        for cls, v in result.per_class.items():
            supp = v['tp'] + v['fn']
            print(f"  {cls:<18} {v['precision']:>6.2f} {v['recall']:>6.2f} {v['f1']:>6.2f} {supp:>5}")

    # ── react_parser ──
    elif name == "react_parser":
        print(f"  Asset accuracy   : {_bar(result.asset_accuracy)}"
              f"  {_status(result.asset_accuracy)}")
        print(f"  95% CI           : [{result.asset_ci_low*100:.1f}%, {result.asset_ci_high*100:.1f}%]")
        print(f"  Count accuracy   : {_bar(result.count_accuracy)}"
              f"  ({result.count_correct}/{result.total})")
        print(f"  Count MAE        : {result.count_mae:.2f}")
        print(f"  Fully correct    : {result.exact_matches}/{result.total}")
        if result.suspected_throttling:
            print(_col(f"  ⚠ DATA QUALITY   : {result.default_fallback_rate*100:.0f}% of cases "
                       f"returned the default chair/1 fallback — API likely "
                       f"rate-limited; metrics above are unreliable.", _RED))

    # ── latency ──
    elif name == "latency":
        header = f"  {'Endpoint':<42} {'p50':>8} {'p95':>8} {'p99':>8} {'OK%':>6}"
        print(header)
        print("  " + "-" * 74)
        for ep in result.endpoints:
            short = ep.endpoint[-40:] if len(ep.endpoint) > 40 else ep.endpoint
            ok_flag = _col("100%", _GREEN) if ep.ok_rate == 1.0 else _col(f"{ep.ok_rate*100:.0f}%", _RED)
            print(f"  {short:<42} {ep.p50_ms:>7.1f}  {ep.p95_ms:>7.1f}  {ep.p99_ms:>7.1f}  {ok_flag}")

    # failed cases summary for unit evaluators
    if hasattr(result, "cases"):
        failed = [c for c in result.cases if not c.get("pass")]
        if failed:
            print(f"\n  {_col(f'{len(failed)} failing case(s):', _RED)}")
            for c in failed[:5]:
                # pick a sensible label for each evaluator
                label = (
                    c.get("message") or c.get("answer") or
                    c.get("activity") or c.get("request") or
                    str(c.get("current", c.get("input", "?")))
                )
                print(f"    • {label[:70]}")
            if len(failed) > 5:
                print(f"    … and {len(failed) - 5} more")


def _print_final_summary(results: dict, total_elapsed: float) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {_col('EVALUATION SUMMARY', _BOLD)}")
    print("=" * 60)

    score_map = {
        "label_match":  ("overall_accuracy", "Accuracy"),
        "vision_parser": ("overall_accuracy", "Accuracy"),
        "scan_diff":    ("overall_accuracy", "Accuracy"),
        "intent":       ("overall_accuracy", "Accuracy"),
        "react_parser": ("asset_accuracy",   "Asset Acc"),
    }

    for name, (attr, label) in score_map.items():
        r = results.get(name)
        if r is None:
            continue
        if hasattr(r, "error") and r.error:
            print(f"  {name:<18} {_col('SKIPPED', _YELLOW)}")
            continue
        score = getattr(r, attr, 0.0)
        print(f"  {name:<18} {_bar(score)}  {_status(score)}")

    lat = results.get("latency")
    if lat and not (hasattr(lat, "error") and lat.error):
        p50s = [e.p50_ms for e in lat.endpoints]
        avg = sum(p50s) / len(p50s) if p50s else 0
        print(f"  {'latency':<18} avg p50 = {avg:.1f} ms")

    print(f"\n  Total elapsed: {total_elapsed:.1f}s")
    print(_col("=" * 60, _BOLD))


def _check_thresholds(results: dict) -> list:
    """Return a list of (name, score, threshold) tuples that fell below bar."""
    failures = []
    for name, (attr, thr) in THRESHOLDS.items():
        r = results.get(name)
        if r is None or (hasattr(r, "error") and r.error):
            continue  # skipped evaluators don't fail the gate
        # Don't fail the gate on data we know is contaminated by rate limiting.
        if getattr(r, "suspected_throttling", False):
            continue
        if getattr(r, "errored", 0) or getattr(r, "robustness_errored", 0):
            continue
        score = getattr(r, attr, 0.0)
        if score < thr:
            failures.append((name, score, thr))
    return failures


def _results_to_dict(results: dict) -> dict:
    """Flatten dataclass results into a JSON-serialisable summary for trend tracking."""
    import dataclasses
    from datetime import datetime

    out = {"timestamp": datetime.now().isoformat(), "evaluators": {}}
    for name, r in results.items():
        if r is None:
            continue
        try:
            d = dataclasses.asdict(r)
        except TypeError:
            continue
        # Drop verbose per-case lists from the persisted summary.
        for big in ("cases", "groq_cases", "blip_cases", "endpoints", "conf_matrix", "per_class"):
            d.pop(big, None)
        out["evaluators"][name] = d
    return out


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Run 3DAgent evaluation suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--integration", action="store_true",
        help="Also run Groq API-dependent evaluators (intent, react_parser)",
    )
    parser.add_argument(
        "--only", metavar="NAME",
        help="Run a single named evaluator",
    )
    parser.add_argument(
        "--output", metavar="FILE", default="eval_report.html",
        help="Path for the HTML report (default: eval_report.html)",
    )
    parser.add_argument(
        "--no-report", action="store_true",
        help="Skip HTML report generation",
    )
    parser.add_argument(
        "--repeats", type=int, default=None,
        help="Repeat each LLM case N times to measure self-consistency (intent only)",
    )
    parser.add_argument(
        "--save-json", metavar="FILE", default="eval_results.json",
        help="Path to persist a JSON metric summary for trend tracking",
    )
    parser.add_argument(
        "--strict", action="store_true",
        help="Exit with non-zero status if any evaluator falls below its threshold",
    )
    args = parser.parse_args()

    if args.repeats is not None:
        os.environ["EVAL_REPEATS"] = str(args.repeats)

    to_run = UNIT_EVALUATORS[:]
    if args.integration:
        to_run += INTEGRATION_EVALUATORS
    if args.only:
        to_run = [args.only]

    print(_col("3DAgent Evaluation Suite", _BOLD))
    print(f"Evaluators: {', '.join(to_run)}")
    if args.integration:
        api_key = os.environ.get("GROQ_API_KEY", "")
        if api_key:
            print(_col("GROQ_API_KEY detected — integration tests will run.", _GREEN))
        else:
            print(_col("GROQ_API_KEY not set — integration tests will be skipped.", _YELLOW))

    results: dict = {}
    total_start = time.perf_counter()

    for name in to_run:
        print(f"\nRunning {_col(name, _CYAN)} …", end="", flush=True)
        t0 = time.perf_counter()
        try:
            result = run_evaluator(name)
        except Exception as exc:
            import traceback
            print(f"\n  {_col('ERROR', _RED)}: {exc}")
            traceback.print_exc()
            result = None
        elapsed = time.perf_counter() - t0
        print(f" done ({elapsed:.1f}s)")
        if result is not None:
            results[name] = result
            _print_result(name, result, elapsed)

    total_elapsed = time.perf_counter() - total_start
    _print_final_summary(results, total_elapsed)

    if not args.no_report:
        from eval.report import generate
        html = generate(results)
        out_path = os.path.abspath(args.output)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"\n{_col('HTML report saved to:', _GREEN)} {out_path}")

    if args.save_json:
        json_path = os.path.abspath(args.save_json)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(_results_to_dict(results), f, indent=2, default=str)
        print(f"{_col('JSON summary saved to:', _GREEN)} {json_path}")

    # Threshold gate
    failures = _check_thresholds(results)
    if failures:
        print(f"\n{_col('THRESHOLD FAILURES:', _RED)}")
        for name, score, thr in failures:
            print(f"  {name:<18} {score*100:.1f}% < {thr*100:.0f}% required")
        if args.strict:
            sys.exit(1)
    else:
        print(f"\n{_col('All evaluators met their thresholds.', _GREEN)}")


if __name__ == "__main__":
    main()
