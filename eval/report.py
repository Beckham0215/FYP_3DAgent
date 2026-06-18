"""HTML report generator for 3DAgent evaluation results."""

from __future__ import annotations

import html
import json
from datetime import datetime
from typing import Any, Dict, Optional

from eval.metrics import score_badge


# ── helpers ───────────────────────────────────────────────────────────────────

def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def _badge(score: float) -> str:
    cls = score_badge(score)
    label = "PASS" if cls == "pass" else ("WARN" if cls == "warn" else "FAIL")
    return f'<span class="badge {cls}">{label} {_pct(score)}</span>'


def _row_class(ok: bool) -> str:
    return "pass-row" if ok else "fail-row"


def _e(s: Any) -> str:
    return html.escape(str(s) if s is not None else "—")


# ── section builders ──────────────────────────────────────────────────────────

def _summary_section(results: Dict[str, Any]) -> str:
    rows = []
    metric_map = {
        "label_match":   ("Label Resolution",         "overall_accuracy", "Accuracy"),
        "vision_parser":  ("Vision Response Parsers",  "overall_accuracy", "Accuracy"),
        "scan_diff":     ("Scan Change Detection",    "overall_accuracy", "Accuracy"),
        "intent":        ("Intent Classification",    "overall_accuracy", "Accuracy"),
        "react_parser":  ("ReAct Request Parsing",    "asset_accuracy",   "Asset Accuracy"),
        "latency":       (None, None, None),
    }
    for key, (label, score_field, score_label) in metric_map.items():
        r = results.get(key)
        if r is None:
            continue
        if key == "latency":
            if hasattr(r, "error") and r.error:
                rows.append(f"<tr><td>API Latency</td><td colspan='3' class='na'>Error: {_e(r.error)}</td></tr>")
            elif hasattr(r, "endpoints"):
                p50_vals = [e.p50_ms for e in r.endpoints]
                avg_p50 = sum(p50_vals) / len(p50_vals) if p50_vals else 0
                rows.append(
                    f"<tr><td>API Latency</td><td>p50 avg</td>"
                    f"<td>{avg_p50:.1f} ms</td>"
                    f"<td>—</td></tr>"
                )
            continue

        if hasattr(r, "error") and r.error:
            rows.append(
                f"<tr><td>{_e(label)}</td><td>{_e(score_label)}</td>"
                f"<td colspan='2' class='na'>Skipped — {_e(r.error)}</td></tr>"
            )
            continue

        score = getattr(r, score_field, 0.0)
        total = getattr(r, "total", "?")
        correct_attr = "correct" if hasattr(r, "correct") else "exact_matches" if hasattr(r, "exact_matches") else None
        correct = getattr(r, correct_attr, "?") if correct_attr else "?"

        extra = ""
        if key == "intent" and hasattr(r, "macro_f1"):
            extra = f"&nbsp; | &nbsp; Macro F1: {_pct(r.macro_f1)}"
        if key == "count_parser" and hasattr(r, "mae"):
            extra = f"&nbsp; | &nbsp; MAE: {r.mae:.2f}"
        if key == "react_parser" and hasattr(r, "count_mae"):
            extra = f"&nbsp; | &nbsp; Count MAE: {r.count_mae:.2f}"

        rows.append(
            f"<tr><td>{_e(label)}</td><td>{_e(score_label)}</td>"
            f"<td>{_badge(score)}{extra}</td>"
            f"<td>{correct}/{total}</td></tr>"
        )

    return f"""
<section id="summary">
  <h2>Summary</h2>
  <table class="summary-table">
    <thead><tr><th>Component</th><th>Metric</th><th>Score</th><th>Correct / Total</th></tr></thead>
    <tbody>{"".join(rows)}</tbody>
  </table>
</section>"""


def _label_match_section(r: Any) -> str:
    if r.error:
        return f'<section id="label_match"><h2>Label Resolution</h2><p class="na">{_e(r.error)}</p></section>'

    by_cat_rows = "".join(
        f"<tr><td>{_e(cat)}</td><td>{_pct(v['accuracy'])}</td>"
        f"<td>{v['correct']}/{v['total']}</td></tr>"
        for cat, v in r.by_category.items()
    )

    case_rows = "".join(
        f'<tr class="{_row_class(c["pass"])}">'
        f'<td>{_e(c["input"])}</td>'
        f'<td>{_e(", ".join(c["available"]))}</td>'
        f'<td>{_e(c["expected"])}</td>'
        f'<td>{_e(c["predicted"])}</td>'
        f'<td>{"✓" if c["pass"] else "✗"}</td>'
        f'<td>{_e(c["category"])}</td></tr>'
        for c in r.cases
    )

    return f"""
<section id="label_match">
  <h2>Label Resolution <span class="sub">resolve_asset()</span></h2>
  <div class="metric-row">
    <div class="metric-card">
      <div class="metric-val">{_pct(r.overall_accuracy)}</div>
      <div class="metric-lbl">Overall Accuracy</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.correct}/{r.total}</div>
      <div class="metric-lbl">Correct / Total</div>
    </div>
  </div>
  <h3>By Category</h3>
  <table>
    <thead><tr><th>Category</th><th>Accuracy</th><th>Correct/Total</th></tr></thead>
    <tbody>{by_cat_rows}</tbody>
  </table>
  <h3>Test Cases <button class="toggle" onclick="toggleTable('lm-cases')">show/hide</button></h3>
  <div id="lm-cases" style="display:none">
  <table>
    <thead><tr><th>Input</th><th>Available Labels</th><th>Expected</th><th>Predicted</th><th></th><th>Category</th></tr></thead>
    <tbody>{case_rows}</tbody>
  </table>
  </div>
</section>"""


def _vision_parser_section(r: Any) -> str:
    if r.error:
        return f'<section id="vision_parser"><h2>Vision Response Parsers</h2><p class="na">{_e(r.error)}</p></section>'

    def _case_rows(cases, tid):
        rows = "".join(
            f'<tr class="{_row_class(c["pass"])}">'
            f'<td><code>{_e(c["input"])}</code></td>'
            f'<td><code>{_e(c["expected"])}</code></td>'
            f'<td><code>{_e(c["predicted"])}</code></td>'
            f'<td>{"&check;" if c["pass"] else "&cross;"}</td>'
            f'<td>{_e(c.get("description",""))}</td></tr>'
            for c in cases
        )
        return (
            f'<div id="{tid}" style="display:none">'
            f'<table><thead><tr>'
            f'<th>Input</th><th>Expected</th><th>Got</th><th></th><th>Note</th>'
            f'</tr></thead><tbody>{rows}</tbody></table></div>'
        )

    return f"""
<section id="vision_parser">
  <h2>Vision Response Parsers</h2>

  <h3>Groq Llama&nbsp;4&nbsp;Scout <span class="sub">parse_groq_vision_response() — primary path</span></h3>
  <div class="metric-row">
    <div class="metric-card">
      <div class="metric-val">{_pct(r.groq_accuracy)}</div>
      <div class="metric-lbl">Accuracy</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.groq_correct}/{r.groq_total}</div>
      <div class="metric-lbl">Correct / Total</div>
    </div>
  </div>
  <button class="toggle" onclick="toggleTable('vp-groq')">show/hide cases</button>
  {_case_rows(r.groq_cases, "vp-groq")}

  <h3>BLIP Fallback <span class="sub">_parse_blip_detection_response() — fallback path</span></h3>
  <div class="metric-row">
    <div class="metric-card">
      <div class="metric-val">{_pct(r.blip_accuracy)}</div>
      <div class="metric-lbl">Accuracy</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.blip_correct}/{r.blip_total}</div>
      <div class="metric-lbl">Correct / Total</div>
    </div>
  </div>
  <button class="toggle" onclick="toggleTable('vp-blip')">show/hide cases</button>
  {_case_rows(r.blip_cases, "vp-blip")}
</section>"""


def _scan_diff_section(r: Any) -> str:
    if r.error:
        return f'<section id="scan_diff"><h2>Scan Change Detection</h2><p class="na">{_e(r.error)}</p></section>'

    def fmt_dict(d: Any) -> str:
        if not d:
            return "{}"
        return _e(json.dumps(d, separators=(", ", ":")))

    case_rows = "".join(
        f'<tr class="{_row_class(c["pass"])}">'
        f'<td><code>{fmt_dict(c["current"])}</code></td>'
        f'<td><code>{fmt_dict(c["previous"])}</code></td>'
        f'<td><code>{fmt_dict(c["expected"])}</code></td>'
        f'<td><code>{fmt_dict(c["predicted"])}</code></td>'
        f'<td>{"✓" if c["pass"] else "✗"}</td></tr>'
        for c in r.cases
    )

    return f"""
<section id="scan_diff">
  <h2>Scan Change Detection <span class="sub">_compute_scan_diff()</span></h2>
  <div class="metric-row">
    <div class="metric-card">
      <div class="metric-val">{_pct(r.overall_accuracy)}</div>
      <div class="metric-lbl">Accuracy</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.correct}/{r.total}</div>
      <div class="metric-lbl">Correct / Total</div>
    </div>
  </div>
  <h3>Test Cases <button class="toggle" onclick="toggleTable('sd-cases')">show/hide</button></h3>
  <div id="sd-cases" style="display:none">
  <table>
    <thead><tr><th>Current</th><th>Previous</th><th>Expected Diff</th><th>Predicted Diff</th><th></th></tr></thead>
    <tbody>{case_rows}</tbody>
  </table>
  </div>
</section>"""


def _intent_section(r: Any) -> str:
    if r.error:
        return f'<section id="intent"><h2>Intent Classification</h2><p class="na">{_e(r.error)}</p></section>'

    from eval.datasets import INTENT_CLASSES

    # Confusion matrix
    cm_header = "<tr><th>Actual \\ Pred</th>" + "".join(
        f"<th>{_e(c[:6])}</th>" for c in INTENT_CLASSES
    ) + "</tr>"
    cm_rows = ""
    for actual in INTENT_CLASSES:
        row_vals = r.conf_matrix.get(actual, {})
        cells = "".join(
            f'<td class="{"cm-diag" if p == actual else ("cm-nonzero" if row_vals.get(p, 0) > 0 else "")}">'
            f'{row_vals.get(p, 0)}</td>'
            for p in INTENT_CLASSES
        )
        cm_rows += f"<tr><td><b>{_e(actual[:10])}</b></td>{cells}</tr>"

    # Per-class table
    cls_rows = "".join(
        f"<tr><td>{_e(cls)}</td>"
        f"<td>{v['precision']:.2f}</td>"
        f"<td>{v['recall']:.2f}</td>"
        f"<td>{v['f1']:.2f}</td>"
        f"<td>{v['tp']}/{v['tp']+v['fn']}</td></tr>"
        for cls, v in r.per_class.items()
    )

    # Case list
    case_rows = "".join(
        f'<tr class="{_row_class(c["pass"])}">'
        f'<td>{_e(c["message"])}</td>'
        f'<td>{_e(c["expected"])}</td>'
        f'<td>{_e(c["predicted"])}</td>'
        f'<td>{"✓" if c["pass"] else "✗"}</td>'
        f'<td>{c.get("latency_ms", "—")} ms</td></tr>'
        for c in r.cases
    )

    return f"""
<section id="intent">
  <h2>Intent Classification <span class="sub">route_intent() — Groq API, 14 classes</span></h2>
  <div class="metric-row">
    <div class="metric-card">
      <div class="metric-val">{_pct(r.overall_accuracy)}</div>
      <div class="metric-lbl">Accuracy<br><span style="font-size:.7rem">95% CI [{_pct(r.ci_low)}, {_pct(r.ci_high)}]</span></div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.macro_f1)}</div>
      <div class="metric-lbl">Macro F1</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.weighted_f1)}</div>
      <div class="metric-lbl">Weighted F1</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.slot_accuracy)}</div>
      <div class="metric-lbl">Slot Fill ({r.slot_correct}/{r.slot_total})</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.activity_accuracy)}</div>
      <div class="metric-lbl">Activity Routing</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.robustness_accuracy)}</div>
      <div class="metric-lbl">Robustness ({r.robustness_correct}/{r.robustness_total})</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.consistency)}</div>
      <div class="metric-lbl">Consistency ({r.repeats} runs)</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.p50_latency_ms:.0f} ms</div>
      <div class="metric-lbl">Latency p50 (p95 {r.p95_latency_ms:.0f})</div>
    </div>
  </div>

  <h3>Confusion Matrix</h3>
  <div class="cm-wrap">
  <table class="cm">
    <thead>{cm_header}</thead>
    <tbody>{cm_rows}</tbody>
  </table>
  </div>

  <h3>Per-class Metrics</h3>
  <table>
    <thead><tr><th>Intent</th><th>Precision</th><th>Recall</th><th>F1</th><th>TP/Support</th></tr></thead>
    <tbody>{cls_rows}</tbody>
  </table>

  <h3>Test Cases <button class="toggle" onclick="toggleTable('int-cases')">show/hide</button></h3>
  <div id="int-cases" style="display:none">
  <table>
    <thead><tr><th>Message</th><th>Expected</th><th>Predicted</th><th></th><th>Latency</th></tr></thead>
    <tbody>{case_rows}</tbody>
  </table>
  </div>
</section>"""


def _react_parser_section(r: Any) -> str:
    if r.error:
        return f'<section id="react_parser"><h2>ReAct Request Parsing</h2><p class="na">{_e(r.error)}</p></section>'

    case_rows = "".join(
        f'<tr class="{_row_class(c["pass"])}">'
        f'<td>{_e(c["request"])}</td>'
        f'<td>{_e(c["expected_asset"])}</td><td>{_e(c["predicted_asset"])}</td>'
        f'<td>{"✓" if c["asset_pass"] else "✗"}</td>'
        f'<td>{_e(c["expected_count"])}</td><td>{_e(c["predicted_count"])}</td>'
        f'<td>{"✓" if c["count_pass"] else "✗"}</td></tr>'
        for c in r.cases
    )

    return f"""
<section id="react_parser">
  <h2>ReAct Request Parsing <span class="sub">parse_react_request() — Groq API</span></h2>
  <div class="metric-row">
    <div class="metric-card">
      <div class="metric-val">{_pct(r.asset_accuracy)}</div>
      <div class="metric-lbl">Asset Accuracy<br><span style="font-size:.7rem">95% CI [{_pct(r.asset_ci_low)}, {_pct(r.asset_ci_high)}]</span></div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{_pct(r.count_accuracy)}</div>
      <div class="metric-lbl">Count Accuracy</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.count_mae:.2f}</div>
      <div class="metric-lbl">Count MAE</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">{r.exact_matches}/{r.total}</div>
      <div class="metric-lbl">Fully Correct</div>
    </div>
  </div>
  <h3>Test Cases <button class="toggle" onclick="toggleTable('rp-cases')">show/hide</button></h3>
  <div id="rp-cases" style="display:none">
  <table>
    <thead>
      <tr>
        <th>Request</th>
        <th>Exp Asset</th><th>Pred Asset</th><th></th>
        <th>Exp Count</th><th>Pred Count</th><th></th>
      </tr>
    </thead>
    <tbody>{case_rows}</tbody>
  </table>
  </div>
</section>"""


def _latency_section(r: Any) -> str:
    if r.error:
        return f'<section id="latency"><h2>API Latency</h2><p class="na">{_e(r.error)}</p></section>'

    rows = "".join(
        f"<tr>"
        f"<td>{_e(e.method)}</td>"
        f"<td><code>{_e(e.endpoint)}</code></td>"
        f"<td>{e.p50_ms}</td>"
        f"<td>{e.p95_ms}</td>"
        f"<td>{e.p99_ms}</td>"
        f"<td>{e.mean_ms}</td>"
        f'<td class="{"pass" if e.ok_rate == 1.0 else "fail"}">{_pct(e.ok_rate)}</td>'
        f"</tr>"
        for e in r.endpoints
    )

    return f"""
<section id="latency">
  <h2>API Endpoint Latency <span class="sub">Flask test client, n={_N_VAL}</span></h2>
  <p class="note">Pure DB-backed endpoints only (no Groq/BLIP calls).</p>
  <table>
    <thead>
      <tr><th>Method</th><th>Endpoint</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Mean ms</th><th>OK Rate</th></tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>
</section>"""


_N_VAL = 20  # keep in sync with latency._N


# ── main entry point ──────────────────────────────────────────────────────────

_CSS = """
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f4f6f9; color: #2d3748; margin: 0; padding: 0; }
header { background: #1a202c; color: #fff; padding: 24px 40px; }
header h1 { margin: 0; font-size: 1.6rem; }
header p  { margin: 4px 0 0; opacity: .7; font-size: .9rem; }
nav { background: #2d3748; display: flex; gap: 8px; padding: 10px 40px; flex-wrap: wrap; }
nav a { color: #a0aec0; text-decoration: none; font-size: .85rem; padding: 4px 10px;
        border-radius: 4px; }
nav a:hover { background: #4a5568; color: #fff; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 32px; }
section { background: #fff; border-radius: 8px; padding: 28px 32px;
          margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
h2 { margin: 0 0 16px; font-size: 1.2rem; color: #1a202c; }
h3 { font-size: 1rem; color: #4a5568; margin: 20px 0 8px; }
.sub { font-size: .78rem; font-weight: 400; color: #a0aec0; margin-left: 8px; font-family: monospace; }
.metric-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.metric-card { background: #edf2f7; border-radius: 8px; padding: 14px 20px;
               min-width: 120px; text-align: center; }
.metric-val { font-size: 1.8rem; font-weight: 700; color: #2b6cb0; }
.metric-lbl { font-size: .78rem; color: #718096; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th { background: #edf2f7; text-align: left; padding: 8px 12px; font-weight: 600;
     color: #4a5568; white-space: nowrap; }
td { padding: 7px 12px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
tr:last-child td { border-bottom: none; }
.pass-row td:last-child { color: #276749; font-weight: 700; }
.fail-row { background: #fff5f5; }
.fail-row td:last-child { color: #9b2c2c; font-weight: 700; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px;
         font-size: .8rem; font-weight: 700; }
.badge.pass { background: #c6f6d5; color: #276749; }
.badge.warn { background: #fefcbf; color: #744210; }
.badge.fail { background: #fed7d7; color: #9b2c2c; }
.na { color: #a0aec0; font-style: italic; }
.note { font-size: .82rem; color: #718096; margin: 0 0 12px; }
button.toggle { font-size: .75rem; padding: 3px 10px; cursor: pointer;
                border: 1px solid #cbd5e0; border-radius: 4px; background: #edf2f7;
                color: #4a5568; margin-left: 8px; }
button.toggle:hover { background: #bee3f8; }
.summary-table th, .summary-table td { padding: 10px 16px; }
.cm-wrap { overflow-x: auto; }
table.cm th, table.cm td { padding: 4px 8px; text-align: center; font-size: .78rem; }
.cm-diag  { background: #c6f6d5; font-weight: 700; }
.cm-nonzero { background: #fed7d7; }
code { font-family: monospace; font-size: .82rem; background: #edf2f7;
       padding: 1px 4px; border-radius: 3px; }
"""

_JS = """
function toggleTable(id) {
  var el = document.getElementById(id);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
"""


def generate(results: Dict[str, Any], timestamp: Optional[str] = None) -> str:
    ts = timestamp or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    nav_links = "".join(
        f'<a href="#{key}">{label}</a>'
        for key, label in [
            ("summary",     "Summary"),
            ("label_match", "Label Match"),
            ("vision_parser","Vision Parser"),
            ("scan_diff",   "Scan Diff"),
            ("intent",      "Intent (API)"),
            ("react_parser","ReAct (API)"),
            ("latency",     "Latency"),
        ]
    )

    sections = [
        _summary_section(results),
    ]
    if "label_match" in results:
        sections.append(_label_match_section(results["label_match"]))
    if "vision_parser" in results:
        sections.append(_vision_parser_section(results["vision_parser"]))
    if "activity_map" in results:
        sections.append(_activity_map_section(results["activity_map"]))
    if "scan_diff" in results:
        sections.append(_scan_diff_section(results["scan_diff"]))
    if "activity_map" in results:
        # Legacy results file may still carry this key; ignore silently.
        pass
    if "intent" in results:
        sections.append(_intent_section(results["intent"]))
    if "react_parser" in results:
        sections.append(_react_parser_section(results["react_parser"]))
    if "latency" in results:
        sections.append(_latency_section(results["latency"]))

    body = "\n".join(sections)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>3DAgent Evaluation Report</title>
  <style>{_CSS}</style>
</head>
<body>
  <header>
    <h1>3DAgent &mdash; Evaluation Report</h1>
    <p>Generated: {_e(ts)}</p>
  </header>
  <nav>{nav_links}</nav>
  <main>{body}</main>
  <script>{_JS}</script>
</body>
</html>"""
