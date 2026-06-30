import json
import re
from functools import wraps

from flask import Blueprint, current_app, jsonify, request, session

from app.asset_canon import canonicalize_detection
from app.extensions import db
from app.label_match import resolve_asset
from app.models import Asset, AssetsSummary, ChatHistoryLog, MaintenanceReport, MatterportSpace, ScanHistory, User
from app.services import blip_service, groq_service

bp = Blueprint("api", __name__, url_prefix="/api")

def api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        return f(*args, **kwargs)

    return decorated


def _find_scanned_asset_instances(map_id: int, name: str) -> list:
    """Return all AssetsSummary rows whose asset_name fuzzy-matches name, as serialisable dicts."""
    if not name:
        return []
    from difflib import get_close_matches
    name_lower = name.strip().lower()
    rows = AssetsSummary.query.filter_by(map_id=map_id).all()
    if not rows:
        return []

    all_names = list({r.asset_name for r in rows if r.asset_name})
    exact = [n for n in all_names if n.lower() == name_lower]
    if exact:
        matched_names = {n.lower() for n in exact}
    else:
        close = get_close_matches(name_lower, [n.lower() for n in all_names], n=3, cutoff=0.4)
        matched_names = set(close)
        if not matched_names:
            matched_names = {n.lower() for n in all_names if name_lower in n.lower() or n.lower() in name_lower}

    if not matched_names:
        return []

    matched_rows = [r for r in rows if r.asset_name and r.asset_name.lower() in matched_names]
    with_sweep = [r for r in matched_rows if r.sweep_uuid]
    result_rows = with_sweep if with_sweep else matched_rows[:5]

    return [
        {
            "sweep_uuid": r.sweep_uuid,
            "best_angle": r.best_angle,
            "bbox_json": json.loads(r.bbox_json) if r.bbox_json else None,
            "serial_number": r.serial_number or 1,
            "area_name": r.area_name or "",
            "asset_name": r.asset_name,
        }
        for r in result_rows
    ]


def _log_chat(user_id: int, map_id: int, prompt: str, response: str):
    row = ChatHistoryLog(
        user_id=user_id,
        map_id=map_id,
        user_prompt=prompt,
        ai_response=response,
    )
    db.session.add(row)
    db.session.commit()


def _extract_count_from_answer(answer: str) -> int:
    """Extract a number from BLIP's answer.

    Handles answers like:
    - "There are 8 chairs"
    - "8 chairs"
    - "There are 8"
    - "8"
    """
    if not answer:
        return 0
    
    # Try to find any number in the answer
    match = re.search(r'\b(\d+)\b', answer)
    if match:
        return int(match.group(1))
    
    # If "no", "none", "zero" in answer, return 0
    if any(word in answer.lower() for word in ["no", "none", "zero", "no chairs", "no table"]):
        return 0
    
    return 0


def _detect_objects_with_vision_and_positions(image_b64: str, area_context: str | None = None, mode: str | None = None) -> tuple:
    """
    Returns (counts_dict, positions_dict, positions_all_dict).
    positions_dict maps name → [x1,y1,x2,y2] (the prominent instance);
    positions_all_dict maps name → [[x1,y1,x2,y2], ...] (every instance).
    Positions are only available when the CV (YOLO) path is used.
    ``mode`` (fast / normal / complex) selects the detector's speed/accuracy
    trade-off.
    """
    if not image_b64:
        return {}, {}, {}
    try:
        if current_app.config.get("GROQ_API_KEY"):
            result = groq_service.detect_objects_from_image_with_positions(image_b64, area_context, mode)
            counts        = result.get("counts", {})
            positions     = result.get("positions", {})
            positions_all = result.get("positions_all", {})
            current_app.logger.info(f"[Vision] Groq vision detected: {counts}")
            if counts:
                return counts, positions, positions_all
            # With the CV detector active, an empty result means nothing was
            # clearly detected in this frame. Don't fall back to box-less BLIP
            # guesses — every listed item must be outline-able, so return empty.
            if current_app.config.get("CV_ENABLED", True):
                return {}, {}, {}
            current_app.logger.warning("[Vision] Groq vision returned empty, falling back to BLIP")

        answer = blip_service.answer_visual_question(
            image_b64, "What furniture and objects are in this room?"
        )
        current_app.logger.info(f"[Vision] BLIP fallback response: {answer}")
        return _parse_blip_detection_response(answer), {}, {}

    except Exception as e:
        current_app.logger.exception(f"[Vision] Detection failed: {e}")
        return {}, {}, {}


def _parse_blip_detection_response(response: str) -> dict:
    counts = {}
    if not response:
        return counts

    response_lower = response.lower()

    # Pattern 1: "chair: 2" or "chair : 2"
    pattern_colon = r'([\w\s]+?)\s*:\s*(\d+)'
    for item, count in re.findall(pattern_colon, response_lower):
        item = item.strip()
        count = int(count)
        if item and count > 0:
            counts[item] = max(counts.get(item, 0), count)

    # Pattern 2: "2 chairs" or "a sofa" or "one table"
    word_to_num = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3,
                   "four": 4, "five": 5, "six": 6, "several": 3, "many": 4}
    pattern_num_word = r'\b(\d+|a|an|one|two|three|four|five|six|several|many)\s+([\w]+(?:\s[\w]+)?)'
    for num_str, item in re.findall(pattern_num_word, response_lower):
        item = item.strip().rstrip('s') if not item.endswith('ss') else item.strip()
        try:
            count = int(num_str)
        except ValueError:
            count = word_to_num.get(num_str, 1)
        if item and count > 0:
            counts[item] = max(counts.get(item, 0), count)

    # Pattern 3: freeform "I can see a sofa and a table" — extract known furniture words
    if not counts:
        furniture_keywords = [
            "chair", "table", "sofa", "couch", "tv", "television", "bed",
            "lamp", "desk", "shelf", "bookcase", "cabinet", "wardrobe",
            "plant", "fan", "fridge", "sink", "toilet", "bath", "shower"
        ]
        for word in furniture_keywords:
            if word in response_lower:
                counts[word] = counts.get(word, 1)

    current_app.logger.info(f"[Vision] Parsed counts from response: {counts}")
    return counts


@bp.route("/vla", methods=["POST"])
@api_login_required
def vla():
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    map_id = data.get("map_id")
    image_b64 = data.get("image_base64")
    chat_history = data.get("history") or []  # [{role, content}, ...]
    current_sweep_uuid = (data.get("current_sweep_uuid") or "").strip()
    intent_override = (data.get("intent_override") or "").strip()

    if not message:
        return jsonify({"ok": False, "error": "message is required"}), 400
    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    assets = Asset.query.filter_by(map_id=map_id).all()
    labels = [a.label_name for a in assets]

    # WHERE AM I — second pass: image provided to suggest a location name
    if intent_override == "where_am_i" and image_b64 and current_sweep_uuid:
        suggested_name = None
        if current_app.config.get("GROQ_API_KEY"):
            try:
                suggested_name = groq_service.suggest_location_name_from_image(image_b64)
            except Exception:
                current_app.logger.exception("[where_am_i] suggest_location_name_from_image failed")
        return jsonify({
            "ok": True,
            "intent": "where_am_i",
            "found": False,
            "suggested_name": suggested_name,
            "current_sweep_uuid": current_sweep_uuid,
        })

    # Vision path: image provided → BLIP VQA
    if image_b64:
        try:
            vqa = blip_service.answer_visual_question(image_b64, message)
        except Exception as e:
            current_app.logger.exception("BLIP error")
            return jsonify({"ok": False, "error": f"Vision model error: {e!s}"}), 500
        reply = vqa
        if current_app.config.get("GROQ_API_KEY"):
            try:
                reply = groq_service.chat_reply(
                    f"The user asked about the current Matterport view: {message}\n"
                    f"A vision model answered: {vqa}\n"
                    "Give one short, natural sentence that answers the user (do not contradict the vision answer).",
                )
            except Exception:
                reply = vqa
        _log_chat(uid, map_id, message, reply)
        return jsonify({"ok": True, "intent": "visual", "response": reply})

    # Text-only: route with Groq
    if not current_app.config.get("GROQ_API_KEY"):
        return jsonify(
            {
                "ok": False,
                "error": "GROQ_API_KEY is not configured. Set it in your environment.",
            }
        ), 503

    try:
        # Get context from session (last queried area)
        last_queried_area = session.get(f"last_queried_area_{map_id}")
        routed = groq_service.route_intent(message, labels, last_queried_area, history=chat_history)
    except Exception as e:
        current_app.logger.exception("Groq routing error")
        return jsonify({"ok": False, "error": f"Router error: {e!s}"}), 503

    intent = routed.get("intent", "conversational")

    if intent == "where_am_i":
        if not current_sweep_uuid:
            reply = "I'm not sure where you are — the sweep location hasn't been detected yet. Try moving around the space first."
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})

        asset = Asset.query.filter_by(map_id=map_id, sweep_uuid=current_sweep_uuid).first()
        if asset:
            reply = f"You are currently in {asset.label_name}."
            _log_chat(uid, map_id, message, reply)
            return jsonify({
                "ok": True,
                "intent": "where_am_i",
                "found": True,
                "label": asset.label_name,
                "category": asset.category,
                "response": reply,
            })
        else:
            return jsonify({
                "ok": True,
                "intent": "where_am_i",
                "found": False,
                "needs_capture": True,
                "current_sweep_uuid": current_sweep_uuid,
            })

    if intent == "react_query":
        react_spec = groq_service.parse_react_request(message)
        target_asset = react_spec.get("asset", "chair")
        min_count = react_spec.get("min_count", 1)
        reasoning = react_spec.get("reasoning", f"Looking for rooms with ≥ {min_count} {target_asset}s")

        def _area_totals(rows):
            """Sum counts per area across per-instance rows (each stored with count=1)."""
            from collections import defaultdict
            totals = defaultdict(int)
            first_row = {}
            for r in rows:
                area = r.area_name or ""
                totals[area] += r.count
                if area not in first_row:
                    first_row[area] = r
            return [
                (first_row[area], totals[area])
                for area, total in totals.items()
                if total >= min_count
            ]

        # Exact match first
        summaries = AssetsSummary.query.filter(
            AssetsSummary.map_id == map_id,
            AssetsSummary.asset_name == target_asset,
        ).all()
        candidates = _area_totals(summaries)

        if not candidates:
            # Partial match: "chair" matches "office chair", "arm chair", etc.
            summaries = AssetsSummary.query.filter(
                AssetsSummary.map_id == map_id,
                AssetsSummary.asset_name.like(f"%{target_asset}%"),
            ).all()
            candidates = _area_totals(summaries)

        if not candidates:
            reply = (
                f"I reasoned that you need ≥ {min_count} {target_asset}(s), "
                f"but no scanned rooms meet that requirement. "
                f"Try scanning rooms first using the Scan Area button."
            )
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "react_query", "reasoning": reasoning,
                            "candidates": [], "response": reply})

        candidate_list = []
        for summary, recorded_count in candidates:
            asset_tag = Asset.query.filter_by(map_id=map_id, label_name=summary.area_name).first()
            candidate_list.append({
                "label": summary.area_name,
                "sweep_uuid": asset_tag.sweep_uuid if asset_tag else None,
                "target_asset": target_asset,
                "recorded_count": recorded_count,
            })

        _log_chat(uid, map_id, message,
                  f"[ReAct] {reasoning} — found {len(candidate_list)} candidate(s)")
        return jsonify({
            "ok": True,
            "intent": "react_query",
            "reasoning": reasoning,
            "target_asset": target_asset,
            "min_count": min_count,
            "candidates": candidate_list,
        })

    if intent == "query_assets":
        query_area = (routed.get("query_area") or "").strip()
        asked_asset = (routed.get("asset_name") or "").strip().lower()

        # ── Resolve the area scope (named room / current location / whole space) ──
        scope_all = query_area.lower() in ("__all__", "all", "everywhere", "anywhere", "whole space")
        area_name = None
        if not scope_all:
            if query_area.lower() in ("", "__current__", "here", "current", "this location", "this room", "this area"):
                if current_sweep_uuid:
                    tag = Asset.query.filter_by(map_id=map_id, sweep_uuid=current_sweep_uuid).first()
                    if tag:
                        area_name = tag.label_name
                    else:
                        row = AssetsSummary.query.filter_by(map_id=map_id, sweep_uuid=current_sweep_uuid).first()
                        area_name = row.area_name if row else None
                if not area_name:
                    scope_all = True  # can't resolve "here" → answer for the whole space
            else:
                area_name = query_area

        all_rows = AssetsSummary.query.filter_by(map_id=map_id).all()
        if scope_all:
            rows = all_rows
            area_label = "the whole space"
        else:
            an = (area_name or "").lower()
            rows = [r for r in all_rows if (r.area_name or "").lower() == an]
            if not rows:
                rows = [r for r in all_rows if an and an in (r.area_name or "").lower()]
            area_label = area_name or "this location"
            if area_name:
                session[f"last_queried_area_{map_id}"] = area_name

        from difflib import get_close_matches

        def _match_names(row_set):
            """Names in row_set that match asked_asset (exact → substring → fuzzy)."""
            names = list({(r.asset_name or "").lower() for r in row_set if r.asset_name})
            target = asked_asset.rstrip("s")
            m = [n for n in names if n == asked_asset or n == target or (target and (target in n or n in target))]
            if not m:
                m = get_close_matches(target, names, n=3, cutoff=0.6)
            return set(m), (target or asked_asset)

        def _breakdown(row_set, matched):
            """(total, {area_name: count}) for rows whose name is in `matched`."""
            per_area = {}
            for r in row_set:
                if (r.asset_name or "").lower() in matched:
                    a = r.area_name or "an unspecified area"
                    per_area[a] = per_area.get(a, 0) + (r.count or 0)
            return sum(per_area.values()), per_area

        # ── Specific-item question, e.g. "how many chairs" / "is there a fire extinguisher" ──
        if asked_asset:
            matched, label = _match_names(rows)

            # Found in the requested area → answer for that area.
            if matched:
                total, _ = _breakdown(rows, matched)
                if total == 1:
                    reply = f"There is 1 {label} in {area_label}."
                else:
                    reply = f"There are {total} {label}s in {area_label}."
                _log_chat(uid, map_id, message, reply)
                return jsonify({"ok": True, "intent": "chat", "response": reply})

            # Not in the requested area → look across the WHOLE space before giving
            # up, so "is there a fire extinguisher" finds it even if the current
            # room has none (or hasn't been scanned).
            if not scope_all:
                all_matched, _ = _match_names(all_rows)
                if all_matched:
                    total, per_area = _breakdown(all_rows, all_matched)
                    where = ", ".join(f"{c} in {a}" for a, c in sorted(per_area.items()))
                    here = area_label if rows else f"{area_label} (not scanned yet)"
                    reply = (
                        f"There are no {label}s in {here}, but I found {total} "
                        f"elsewhere in this space: {where}."
                    )
                    _log_chat(uid, map_id, message, reply)
                    return jsonify({"ok": True, "intent": "chat", "response": reply})

            # No name match anywhere → maybe a PROPERTY/CATEGORY question
            # ("flammable", "electronics", "anything dangerous"). Let the LLM
            # filter the scanned items by concept — first in the requested area,
            # then across the whole space.
            for scope_rows, scope_label in ((rows, area_label), (all_rows, "the whole space")):
                names = list({(r.asset_name or "").lower() for r in scope_rows if r.asset_name})
                if not names:
                    continue
                sem = groq_service.filter_assets_semantically(message, names)
                sem_matched = set(sem.get("matched") or [])
                concept = sem.get("concept") or label
                if sem_matched:
                    totals = {}
                    for r in scope_rows:
                        nm = (r.asset_name or "").lower()
                        if nm in sem_matched:
                            totals[nm] = totals.get(nm, 0) + (r.count or 0)
                    parts = [f"{cnt} {nm}" + ("" if cnt == 1 else "s")
                             for nm, cnt in sorted(totals.items()) if cnt > 0]
                    reply = (
                        f"Potentially {concept} items in {scope_label}: {', '.join(parts)}. "
                        f"(Inferred from the scanned object names — please verify on site.)"
                    )
                    _log_chat(uid, map_id, message, reply)
                    return jsonify({"ok": True, "intent": "chat", "response": reply})
                if scope_rows is all_rows:  # exhausted both scopes
                    break

            reply = f"I couldn't find any {label} in the scanned assets for this space."
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})

        # ── No specific item: list what's in the requested area ──
        if not rows:
            reply = f"No assets have been recorded for {area_label}. Try scanning it first with the Scan Area tool."
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})

        totals = {}
        for r in rows:
            if r.asset_name:
                totals[r.asset_name] = totals.get(r.asset_name, 0) + (r.count or 0)
        parts = [f"{cnt} {name}" + ("" if cnt == 1 else "s") for name, cnt in sorted(totals.items())]
        reply = (f"In {area_label}: {', '.join(parts)}." if parts else f"No assets detected in {area_label}.")
        _log_chat(uid, map_id, message, reply)
        return jsonify({"ok": True, "intent": "chat", "response": reply})

    if intent == "list_locations":
        if not assets:
            reply = "No locations have been tagged yet. Use the Location tool (or Auto-Tag) in the viewer to add some."
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})
        by_cat = {}
        for a in assets:
            by_cat.setdefault(a.category or "Uncategorized", []).append(a.label_name)
        parts = [f"{cat} ({', '.join(sorted(v))})" for cat, v in sorted(by_cat.items())]
        reply = f"{len(assets)} tagged location(s) — " + "; ".join(parts) + "."
        _log_chat(uid, map_id, message, reply)
        return jsonify({"ok": True, "intent": "chat", "response": reply})

    if intent in ("scan_area", "auto_tag", "show_floorplan"):
        action_msgs = {
            "scan_area": "Opening the scanner — choose what to scan.",
            "auto_tag": "Opening Auto-Tag — pick the sweeps to tag.",
            "show_floorplan": "Opening the floor plan.",
        }
        _log_chat(uid, map_id, message, action_msgs[intent])
        return jsonify({"ok": True, "intent": intent, "response": action_msgs[intent]})

    if intent == "visual":
        return jsonify(
            {
                "ok": True,
                "intent": "visual",
                "needs_capture": True,
                "hint": "Capture the viewport and send the same message with image_base64.",
            }
        )

    if intent == "mark_asset":
        # User wants to mark the current location
        asset_name = routed.get("asset_name")
        if not asset_name:
            fallback = "I understand you want to mark a location, but I couldn't extract the asset name. Please try: 'Mark this as [name]'"
            _log_chat(uid, map_id, message, fallback)
            return jsonify({"ok": True, "intent": "chat", "response": fallback})
        return jsonify(
            {
                "ok": True,
                "intent": "mark_asset",
                "asset_name": asset_name,
                "needs_capture": False,
                "hint": "Send the current sweep UUID to complete the marking.",
            }
        )

    if intent == "activity":
        # User wants to do an activity, map to a location
        dest = routed.get("destination_label")
        asset = resolve_asset(assets, dest) if dest else None
        if asset:
            msg = json.dumps({"label": asset.label_name, "sweep": asset.sweep_uuid, "activity": True})
            _log_chat(uid, map_id, message, msg)
            return jsonify(
                {
                    "ok": True,
                    "intent": "navigate",
                    "sweep_uuid": asset.sweep_uuid,
                    "label": asset.label_name,
                }
            )
        # Try to map activity to location if we have it
        if dest:
            fallback = f"I'd love to help you {message.lower()}, but I haven't tagged a '{dest}' location yet. You can mark one in the viewer by saying 'mark this as {dest}'."
        else:
            fallback = routed.get("reply") or "I'm not sure where to take you for that activity. Can you be more specific?"
        _log_chat(uid, map_id, message, fallback)
        return jsonify({"ok": True, "intent": "chat", "response": fallback})

    if intent == "navigate":
        dest = routed.get("destination_label")

        # If the LLM didn't extract a destination (common for non-room objects), pull it
        # directly from the raw message using navigation-phrasing patterns.
        if not dest:
            _nav_re = re.compile(
                r"(?:bring|take|navigate|go|show|lead)\s+(?:me\s+)?to\s+"
                r"(?:the\s+)?(?:nearest\s+)?(.+?)(?:\s+please)?$",
                re.IGNORECASE,
            )
            m = _nav_re.search(message.strip())
            if m:
                dest = m.group(1).strip()

        asset = resolve_asset(assets, dest) if dest else None
        if asset:
            msg = json.dumps({"label": asset.label_name, "sweep": asset.sweep_uuid})
            _log_chat(uid, map_id, message, msg)
            return jsonify(
                {
                    "ok": True,
                    "intent": "navigate",
                    "sweep_uuid": asset.sweep_uuid,
                    "label": asset.label_name,
                }
            )

        # Fallback: search scanned inventory (AssetsSummary) for the object
        if dest:
            instances = _find_scanned_asset_instances(map_id, dest)
            if instances:
                _log_chat(uid, map_id, message,
                          f"[navigate_asset] {len(instances)} instance(s) of '{dest}'")
                return jsonify({
                    "ok": True,
                    "intent": "navigate_asset",
                    "asset_name": dest,
                    "instances": instances,
                })

        fallback = (
            f"No navigation labels or scanned instances found for "
            f"'{dest or 'that destination'}'. "
            "Try scanning the area first using the Scan Area button, or add a tagged location."
        )
        _log_chat(uid, map_id, message, fallback)
        return jsonify({"ok": True, "intent": "chat", "response": fallback})

    if intent == "report_issue":
        spec = groq_service.parse_report_request(message)
        equipment = (spec.get("asset") or routed.get("asset_name") or "").strip()
        description = (spec.get("description") or "").strip()
        severity = spec.get("severity") or "medium"
        if not equipment:
            reply = "I can file a maintenance report, but I couldn't tell which asset. Try: 'report chair #1 has a broken leg'."
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})

        # Locate the asset in the scanned inventory so the report pins to its exact spot.
        m = re.match(r"^(.*?)\s*#?\s*(\d+)\s*$", equipment)
        base = (m.group(1) if m else equipment).strip().lower()
        serial = int(m.group(2)) if m else None
        rows = AssetsSummary.query.filter_by(map_id=map_id).all()
        match = next((r for r in rows if (r.asset_name or "").lower() == base and (serial is None or r.serial_number == serial)), None)
        if not match and base:
            match = next((r for r in rows if base in (r.asset_name or "").lower() and (serial is None or r.serial_number == serial)), None)

        sweep_uuid = match.sweep_uuid if match else (current_sweep_uuid or None)
        area_name = match.area_name if match else None
        best_angle = match.best_angle if match else None
        bbox_json = (json.loads(match.bbox_json) if (match and match.bbox_json) else None)
        if not area_name and current_sweep_uuid:
            tag = Asset.query.filter_by(map_id=map_id, sweep_uuid=current_sweep_uuid).first()
            if tag:
                area_name = tag.label_name

        equipment_label = f"{base.title()} #{serial}" if serial else equipment
        user = db.session.get(User, uid)
        report = MaintenanceReport(
            map_id=map_id,
            sweep_uuid=sweep_uuid,
            area_name=area_name,
            equipment_name=equipment_label,
            description=description or None,
            severity=severity,
            status="open",
            reported_by=uid,
            reporter_name=user.username if user else None,
        )
        db.session.add(report)
        db.session.commit()

        loc_txt = f" in {area_name}" if area_name else ""
        reply = (f"✓ Logged a {severity} maintenance report for {equipment_label}{loc_txt}"
                 + (f": {description}." if description else "."))
        _log_chat(uid, map_id, message, reply)
        return jsonify({
            "ok": True,
            "intent": "report_issue",
            "response": reply,
            "report_id": report.id,
            "equipment_name": equipment_label,
            "severity": severity,
            "navigate": ({
                "sweep_uuid": sweep_uuid,
                "equipment_name": equipment_label,
                "best_angle": best_angle,
                "bbox": bbox_json,
            } if sweep_uuid else None),
        })

    if intent == "list_problems":
        rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        reports = MaintenanceReport.query.filter(
            MaintenanceReport.map_id == map_id,
            MaintenanceReport.status != "resolved",
        ).all()
        if not reports:
            reply = "No open maintenance problems have been reported in this space. 🎉"
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})
        reports.sort(key=lambda r: (-rank.get(r.severity, 2), -r.id))
        parts = []
        for r in reports[:20]:
            loc = f" ({r.area_name})" if r.area_name else ""
            status_txt = "" if r.status == "open" else f" / {r.status}"
            parts.append(f"{r.equipment_name}{loc} — {r.severity}{status_txt}")
        reply = (f"{len(reports)} reported problem(s): " + "; ".join(parts)
                 + ". Open “Problem Equipment” in the tools menu to fly to each one.")
        _log_chat(uid, map_id, message, reply)
        return jsonify({
            "ok": True,
            "intent": "list_problems",
            "response": reply,
            "problems": [
                {"equipment_name": r.equipment_name, "area_name": r.area_name,
                 "sweep_uuid": r.sweep_uuid, "severity": r.severity, "status": r.status}
                for r in reports
            ],
        })

    # conversational
    reply = routed.get("reply")
    if not reply:
        try:
            reply = groq_service.chat_reply(message, history=chat_history)
        except Exception as e:
            return jsonify({"ok": False, "error": f"Chat error: {e!s}"}), 503
    _log_chat(uid, map_id, message, reply)
    return jsonify({"ok": True, "intent": "chat", "response": reply})


@bp.route("/spaces/<int:map_id>/assets", methods=["GET"])
@api_login_required
def list_assets_json(map_id):
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Not found"}), 404
    assets = Asset.query.filter_by(map_id=map_id).all()
    return jsonify(
        {
            "ok": True,
            "assets": [
                {
                    "asset_id": a.asset_id,
                    "label_name": a.label_name,
                    "sweep_uuid": a.sweep_uuid,
                    "description": a.description,
                    "category": a.category,
                }
                for a in assets
            ],
        }
    )


@bp.route("/mark-asset", methods=["POST"])
@api_login_required
def mark_asset():
    """Mark the current sweep location with an asset name."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    map_id = data.get("map_id")
    asset_name = (data.get("asset_name") or "").strip()
    sweep_uuid = (data.get("sweep_uuid") or "").strip()
    description = (data.get("description") or "").strip()
    category = (data.get("category") or data.get("asset_category") or "").strip()

    if not asset_name:
        return jsonify({"ok": False, "error": "asset_name is required"}), 400
    if not sweep_uuid:
        return jsonify({"ok": False, "error": "sweep_uuid is required"}), 400

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    # Verify the space exists and belongs to the user
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    # Check if asset with same name already exists
    existing = Asset.query.filter_by(map_id=map_id, label_name=asset_name).first()
    if existing:
        # Update the existing asset
        existing.sweep_uuid = sweep_uuid
        if description:
            existing.description = description
        if category:
            existing.category = category
        db.session.commit()
        _log_chat(uid, map_id, f"Updated asset: {asset_name}", f"Asset '{asset_name}' updated at sweep {sweep_uuid}")
        return jsonify({
            "ok": True,
            "message": f"Asset '{asset_name}' updated",
            "asset_id": existing.asset_id,
        })

    # Create new asset
    asset = Asset(
        map_id=map_id,
        label_name=asset_name,
        sweep_uuid=sweep_uuid,
        description=description or None,
        category=category or None,
    )
    db.session.add(asset)
    db.session.commit()
    _log_chat(uid, map_id, f"Marked location as: {asset_name}", f"Asset '{asset_name}' marked at sweep {sweep_uuid}")
    return jsonify({
        "ok": True,
        "message": f"Location marked as '{asset_name}'",
        "asset_id": asset.asset_id,
    })


@bp.route("/segment-view", methods=["POST"])
@api_login_required
def segment_view():
    """Return an edge-fitting polygon outline for an object in the current view.

    Best-effort: if the segmentation model is unavailable or the object isn't
    found, responds ok=False and the client keeps its bounding-box highlight.
    """
    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image") or data.get("image_b64") or ""
    object_name = (data.get("object_name") or "").strip()
    bbox_hint = data.get("bbox")
    instance_index = data.get("instance_index")
    if instance_index is not None:
        try:
            instance_index = int(instance_index)
        except (TypeError, ValueError):
            instance_index = None
    if not image_b64 or not object_name:
        return jsonify({"ok": False, "error": "image and object_name are required"}), 400
    try:
        from app.services import cv_service
        result = cv_service.segment_object_in_image(image_b64, object_name, bbox_hint, instance_index)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})
    if not result:
        return jsonify({"ok": False, "error": "no outline found"})
    # result already carries ok True/False (+ reason/total or polygon).
    return jsonify(result)


@bp.route("/spaces/<int:map_id>/problem-assets", methods=["GET"])
@api_login_required
def problem_assets(map_id):
    """Unresolved maintenance reports for this space — the viewer's Problem
    Equipment list (click each to fly to it and outline it)."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Not found"}), 404
    rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
    reports = MaintenanceReport.query.filter(
        MaintenanceReport.map_id == map_id,
        MaintenanceReport.status != "resolved",
    ).all()
    reports.sort(key=lambda r: (-rank.get(r.severity, 2), -r.id))
    return jsonify({
        "ok": True,
        "problems": [
            {
                "id": r.id,
                "equipment_name": r.equipment_name,
                "area_name": r.area_name,
                "sweep_uuid": r.sweep_uuid,
                "severity": r.severity,
                "status": r.status,
                "description": r.description,
            }
            for r in reports
        ],
    })


@bp.route("/maintenance/report", methods=["POST"])
@api_login_required
def create_maintenance_report():
    """File a maintenance issue pinned to the worker's current location."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}

    equipment = (data.get("equipment_name") or "").strip()
    description = (data.get("description") or "").strip()
    severity = (data.get("severity") or "medium").strip().lower()
    sweep_uuid = (data.get("sweep_uuid") or "").strip()
    area_name = (data.get("area_name") or "").strip()

    if not equipment:
        return jsonify({"ok": False, "error": "Equipment name is required"}), 400
    if severity not in MaintenanceReport.SEVERITIES:
        severity = "medium"

    try:
        map_id = int(data.get("map_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    # Worker must have access to the space (they own it in this app).
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    user = db.session.get(User, uid)
    report = MaintenanceReport(
        map_id=map_id,
        sweep_uuid=sweep_uuid or None,
        area_name=area_name or None,
        equipment_name=equipment,
        description=description or None,
        severity=severity,
        status="open",
        reported_by=uid,
        reporter_name=user.username if user else None,
    )
    db.session.add(report)
    db.session.commit()
    return jsonify({
        "ok": True,
        "message": f"Issue reported: {equipment}",
        "report_id": report.id,
    })


@bp.route("/scan-assets", methods=["POST"])
@api_login_required
def scan_assets():
    """Detect assets from one sweep screenshot."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}

    map_id        = data.get("map_id")
    sweep_uuid    = (data.get("sweep_uuid") or "").strip()
    image_b64     = data.get("image_base64") or ""
    area_context  = (data.get("area_name") or "").strip() or None
    scan_mode     = (data.get("mode") or "normal").strip().lower()
    if scan_mode not in ("fast", "normal", "complex"):
        scan_mode = "normal"

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    if not sweep_uuid:
        return jsonify({"ok": False, "error": "sweep_uuid is required"}), 400
    if not image_b64:
        return jsonify({"ok": False, "error": "image_base64 is required"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    try:
        object_counts, raw_positions, raw_positions_all = _detect_objects_with_vision_and_positions(image_b64, area_context, scan_mode)
    except Exception as e:
        current_app.logger.exception("Scan assets vision detector failed")
        return jsonify({"ok": False, "error": f"Vision detection failed: {e!s}"}), 500

    # Canonicalise object names so the same physical thing isn't split across
    # synonyms/plurals/colour variants ("office chairs", "blue chair" -> "chair"
    # family). Counts, the prominent box, and the per-instance boxes are all
    # remapped together so highlighting keys stay consistent downstream.
    cleaned_counts, positions, positions_all = canonicalize_detection(
        object_counts, raw_positions, raw_positions_all
    )

    current_app.logger.info(f"[Scan] Detected {len(cleaned_counts)} items, located {len(positions)} bboxes")
    return jsonify({"ok": True, "objects": cleaned_counts, "positions": positions, "positions_all": positions_all})


@bp.route("/scan-assets/summary", methods=["POST"])
@api_login_required
def save_scan_assets_summary():
    """Persist aggregated scan counts for a map."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}

    map_id = data.get("map_id")
    area_name = (data.get("area_name") or "").strip() or None
    counts = data.get("asset_counts") or {}

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    if not isinstance(counts, dict) or not counts:
        return jsonify({"ok": False, "error": "asset_counts must be a non-empty object"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    # Replace previous summary rows for the same map/area to keep latest result clean.
    existing_rows = AssetsSummary.query.filter_by(map_id=map_id, area_name=area_name).all()
    for row in existing_rows:
        db.session.delete(row)

    saved_rows = []
    for asset_name, count in counts.items():
        cleaned_name = (asset_name or "").strip().lower()
        if not cleaned_name:
            continue
        try:
            cleaned_count = int(count)
        except (TypeError, ValueError):
            continue
        if cleaned_count <= 0:
            continue

        row = AssetsSummary(
            map_id=map_id,
            area_name=area_name,
            asset_name=cleaned_name,
            count=cleaned_count,
        )
        db.session.add(row)
        saved_rows.append({"asset_name": cleaned_name, "count": cleaned_count})

    db.session.commit()
    return jsonify({"ok": True, "saved": saved_rows})


@bp.route("/scan-assets/confirm-edit", methods=["POST"])
@api_login_required
def confirm_edit_scan_assets():
    """Save user-edited scan results to AssetsSummary."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}

    map_id = data.get("map_id")
    area_name = (data.get("area_name") or "").strip() or None
    edited_counts = data.get("edited_assets") or {}  # User-modified counts
    sweep_uuid = (data.get("sweep_uuid") or "").strip() or None
    # {asset_name: {bbox: [x1,y1,x2,y2], angle: float, sweep_uuid: str}}
    bbox_data = data.get("bbox_data") or {}

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    if not isinstance(edited_counts, dict):
        return jsonify({"ok": False, "error": "edited_assets must be an object"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    # Replace previous summary rows for the same map/area
    existing_rows = AssetsSummary.query.filter_by(map_id=map_id, area_name=area_name).all()
    for row in existing_rows:
        db.session.delete(row)

    saved_rows = []
    for asset_name, count in edited_counts.items():
        cleaned_name = (asset_name or "").strip().lower()
        if not cleaned_name:
            continue
        try:
            cleaned_count = int(count)
        except (TypeError, ValueError):
            continue
        if cleaned_count <= 0:
            continue

        # bbox_data may carry per-instance info: {instances: [{serial, bbox, angle, sweep_uuid}]}
        asset_bbox_info = bbox_data.get(cleaned_name) or {}
        instances = asset_bbox_info.get("instances") or []

        for serial in range(1, cleaned_count + 1):
            inst = instances[serial - 1] if serial - 1 < len(instances) else {}
            raw_bbox  = inst.get("bbox")
            raw_angle = inst.get("angle")
            row_sweep = (inst.get("sweep_uuid") or sweep_uuid or "").strip() or None

            row = AssetsSummary(
                map_id=map_id,
                area_name=area_name,
                asset_name=cleaned_name,
                count=1,
                serial_number=serial,
                sweep_uuid=row_sweep,
                bbox_json=json.dumps(raw_bbox) if isinstance(raw_bbox, list) else None,
                best_angle=float(raw_angle) if raw_angle is not None else None,
            )
            db.session.add(row)

        saved_rows.append({"asset_name": cleaned_name, "count": cleaned_count})

    # Persist a history snapshot (aggregate counts, not per-instance)
    if saved_rows:
        snapshot_dict = {r["asset_name"]: r["count"] for r in saved_rows}
        db.session.add(ScanHistory(
            map_id=map_id,
            area_name=area_name,
            snapshot=json.dumps(snapshot_dict),
        ))

    # Register the area in the Asset (location) table if it doesn't exist yet.
    # This ensures newly-typed area names appear in the location dropdown on future scans.
    if area_name and sweep_uuid:
        existing_location = Asset.query.filter_by(map_id=map_id, label_name=area_name).first()
        if not existing_location:
            db.session.add(Asset(
                map_id=map_id,
                label_name=area_name,
                sweep_uuid=sweep_uuid,
            ))
            current_app.logger.info(f"[Scan] Auto-registered new location '{area_name}' at sweep {sweep_uuid}")

    db.session.commit()

    current_app.logger.info(f"[Scan] User confirmed and saved {len(saved_rows)} assets for {area_name}")
    return jsonify({"ok": True, "saved": saved_rows, "message": f"Confirmed {len(saved_rows)} assets for {area_name}"})


@bp.route("/locate-object", methods=["POST"])
@api_login_required
def locate_object():
    """Return a tight bounding box [x1,y1,x2,y2] for one named object in a screenshot.
    Called on-demand after the camera rotates to the best view angle."""
    data       = request.get_json(silent=True) or {}
    object_name = (data.get("object_name") or "").strip().lower()
    image_b64   = data.get("image_base64") or ""

    if not object_name:
        return jsonify({"ok": False, "error": "object_name required"}), 400
    if not image_b64:
        return jsonify({"ok": False, "error": "image_base64 required"}), 400
    if not current_app.config.get("GROQ_API_KEY"):
        return jsonify({"ok": True, "bbox": None})

    bbox = groq_service.locate_object_in_image(image_b64, object_name)
    return jsonify({"ok": True, "bbox": bbox})


@bp.route("/locate-all-instances", methods=["POST"])
@api_login_required
def locate_all_instances():
    """Return tight bounding boxes for every visible instance of a named object.
    Returns {ok, instances: [[x1,y1,x2,y2], ...]} — up to expected_count entries."""
    data = request.get_json(silent=True) or {}
    object_name    = (data.get("object_name") or "").strip().lower()
    image_b64      = data.get("image_base64") or ""
    expected_count = data.get("expected_count") or 1

    if not object_name:
        return jsonify({"ok": False, "error": "object_name required"}), 400
    if not image_b64:
        return jsonify({"ok": False, "error": "image_base64 required"}), 400
    try:
        expected_count = max(1, int(expected_count))
    except (TypeError, ValueError):
        expected_count = 1

    if not current_app.config.get("GROQ_API_KEY"):
        return jsonify({"ok": True, "instances": []})

    instances = groq_service.locate_all_instances_in_image(image_b64, object_name, expected_count)
    return jsonify({"ok": True, "instances": instances})


@bp.route("/scan-assets/locations", methods=["GET"])
@api_login_required
def list_scan_locations():
    """Return existing location labels for scan-to-location saving."""
    uid = session["user_id"]
    map_id = request.args.get("map_id")
    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    assets = Asset.query.filter_by(map_id=map_id).all()
    names = sorted({(a.label_name or "").strip() for a in assets if (a.label_name or "").strip()})
    return jsonify({"ok": True, "locations": names})


@bp.route("/spaces/<int:map_id>/assets/<int:asset_id>", methods=["DELETE"])
@api_login_required
def delete_asset(map_id, asset_id):
    """Delete an asset by ID."""
    uid = session["user_id"]

    try:
        map_id = int(map_id)
        asset_id = int(asset_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid map_id or asset_id"}), 400

    # Verify the space exists and belongs to the user
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    # Find and delete the asset
    asset = Asset.query.filter_by(asset_id=asset_id, map_id=map_id).first()
    if not asset:
        return jsonify({"ok": False, "error": "Asset not found"}), 404

    asset_name = asset.label_name
    db.session.delete(asset)
    db.session.commit()
    _log_chat(uid, map_id, f"Deleted asset: {asset_name}", f"Asset '{asset_name}' has been deleted")

    return jsonify({
        "ok": True,
        "message": f"Asset '{asset_name}' deleted successfully",
    })


@bp.route("/spaces/<int:map_id>", methods=["DELETE"])
@api_login_required
def delete_space(map_id):
    """Delete a space by ID."""
    uid = session["user_id"]

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid map_id"}), 400

    # Verify the space exists and belongs to the user
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    space_name = space.map_name
    db.session.delete(space)
    db.session.commit()

    return jsonify({
        "ok": True,
        "message": f"Space '{space_name}' deleted successfully",
    })


@bp.route("/spaces/<int:map_id>/assets/<int:asset_id>", methods=["PUT"])
@api_login_required
def edit_asset(map_id, asset_id):
    """Edit an asset by ID."""
    uid = session["user_id"]
    
    data = request.get_json(silent=True) or {}
    
    try:
        map_id = int(map_id)
        asset_id = int(asset_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid map_id or asset_id"}), 400

    # Verify the space exists and belongs to the user
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    # Find the asset
    asset = Asset.query.filter_by(asset_id=asset_id, map_id=map_id).first()
    if not asset:
        return jsonify({"ok": False, "error": "Asset not found"}), 404

    # Update fields if provided
    if "label_name" in data and data["label_name"]:
        asset.label_name = data["label_name"].strip()
    if "sweep_uuid" in data and data["sweep_uuid"]:
        asset.sweep_uuid = data["sweep_uuid"].strip()
    if "description" in data:
        asset.description = data["description"].strip() or None
    if "category" in data:
        asset.category = data["category"].strip() or None

    db.session.commit()

    return jsonify({
        "ok": True,
        "message": f"Asset '{asset.label_name}' updated successfully",
        "asset": {
            "asset_id": asset.asset_id,
            "label_name": asset.label_name,
            "sweep_uuid": asset.sweep_uuid,
            "description": asset.description,
            "category": asset.category,
        },
    })


@bp.route("/suggest-location-name", methods=["POST"])
@api_login_required
def suggest_location_name():
    """Suggest a room/area name from a screenshot or detected objects list."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    map_id = data.get("map_id")
    image_b64 = (data.get("image_base64") or "").strip()
    detected_objects = data.get("detected_objects") or {}
    nearby_names = data.get("nearby_names") or None

    try:
        map_id = int(map_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id is required"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    # The building/site name strongly anchors the likely area types
    # (e.g. "Factory A" -> industrial areas, "BioLab" -> laboratory areas).
    building_context = space.map_name or None

    suggested_name = None
    if image_b64:
        suggested_name = groq_service.suggest_location_name_from_image(
            image_b64, building_context=building_context, nearby_names=nearby_names
        )
    elif detected_objects:
        suggested_name = groq_service.suggest_location_name_from_objects(detected_objects, building_context=building_context)

    return jsonify({"ok": True, "suggested_name": suggested_name})


@bp.route("/react-verify", methods=["POST"])
@api_login_required
def react_verify():
    """Verify the current state of a candidate room using vision."""
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    map_id = data.get("map_id")
    label = (data.get("label") or "").strip()
    target_asset = (data.get("target_asset") or "chair").strip().lower()
    recorded_count = data.get("recorded_count", 0)
    image_b64 = (data.get("image_base64") or "").strip()

    try:
        map_id = int(map_id)
        recorded_count = int(recorded_count)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "map_id and recorded_count must be integers"}), 400

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Space not found"}), 404

    counts = _detect_objects_with_vision_and_positions(image_b64, label)[0] if image_b64 else {}
    verified_count = counts.get(target_asset, 0)

    if verified_count == 0:
        status = "empty"
        note = f"No {target_asset}s currently visible in {label}"
    elif recorded_count > 0 and verified_count < recorded_count * 0.7:
        status = "degraded"
        note = f"{label}: only {verified_count} {target_asset}(s) visible (recorded: {recorded_count})"
    else:
        status = "ok"
        note = f"{label}: {verified_count} {target_asset}(s) confirmed"

    current_app.logger.info(f"[ReAct Verify] {label}: {verified_count} {target_asset}s ({status})")
    return jsonify({
        "ok": True,
        "label": label,
        "verified_count": verified_count,
        "status": status,
        "note": note,
    })


def _compute_scan_diff(current: dict, previous: dict) -> list:
    all_keys = set(current) | set(previous)
    changes = []
    for key in sorted(all_keys):
        cur  = current.get(key, 0)
        prev = previous.get(key, 0)
        if cur != prev:
            changes.append({"item": key, "previous": prev, "current": cur, "delta": cur - prev})
    return changes


@bp.route("/spaces/<int:map_id>/scan-history", methods=["GET"])
@api_login_required
def get_scan_history(map_id):
    """Return scan snapshots for an area and a diff between the two most recent ones."""
    uid = session["user_id"]
    area = request.args.get("area", "").strip() or None

    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Not found"}), 404

    query = ScanHistory.query.filter_by(map_id=map_id)
    if area:
        query = query.filter_by(area_name=area)
    records = query.order_by(ScanHistory.scanned_at.desc()).limit(10).all()

    history = []
    for r in records:
        try:
            snapshot = json.loads(r.snapshot)
        except Exception:
            snapshot = {}
        history.append({
            "id": r.id,
            "area_name": r.area_name,
            "scanned_at": r.scanned_at.strftime("%b %d %Y, %H:%M"),
            "snapshot": snapshot,
        })

    diff = _compute_scan_diff(history[0]["snapshot"], history[1]["snapshot"]) if len(history) >= 2 else []

    return jsonify({"ok": True, "history": history, "diff": diff})


@bp.route("/spaces/<int:map_id>/assets-panel", methods=["GET"])
@api_login_required
def assets_panel_data(map_id):
    """Return tagged assets + scan summaries for the in-viewer assets panel."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Not found"}), 404

    assets = Asset.query.filter_by(map_id=map_id).all()
    summaries = (
        AssetsSummary.query.filter_by(map_id=map_id)
        .order_by(AssetsSummary.area_name.asc(), AssetsSummary.asset_name.asc())
        .all()
    )
    return jsonify({
        "ok": True,
        "assets": [
            {
                "asset_id": a.asset_id,
                "label_name": a.label_name,
                "sweep_uuid": a.sweep_uuid,
                "category": a.category,
                "description": a.description,
            }
            for a in assets
        ],
        "scan_summaries": [
            {
                "id": s.id,
                "area_name": s.area_name or "Unspecified",
                "asset_name": s.asset_name,
                "serial_number": s.serial_number,
                "count": s.count,
                "sweep_uuid": s.sweep_uuid,
                "bbox": json.loads(s.bbox_json) if s.bbox_json else None,
                "best_angle": s.best_angle,
            }
            for s in summaries
        ],
    })



@bp.route("/spaces/<int:map_id>/scanned-assets/<int:summary_id>", methods=["DELETE"])
@api_login_required
def delete_scanned_asset_api(map_id, summary_id):
    """Delete a scanned asset summary row via API."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first()
    if not space:
        return jsonify({"ok": False, "error": "Not found"}), 404
    row = AssetsSummary.query.filter_by(id=summary_id, map_id=map_id).first()
    if not row:
        return jsonify({"ok": False, "error": "Not found"}), 404
    db.session.delete(row)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/export/floorplan-pdf", methods=["POST"])
@api_login_required
def export_floorplan_pdf():
    """Accept a base64-encoded floor plan PNG and return it as a PDF."""
    import base64
    import os
    import tempfile
    from datetime import datetime
    from flask import Response
    from fpdf import FPDF

    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    image_b64 = (data.get("image_base64") or "").strip()
    title = (data.get("title") or "Annotated Floor Plan").strip()

    if not image_b64:
        return jsonify({"ok": False, "error": "image_base64 is required"}), 400

    # Strip data-URL header if present
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(image_b64)
    except Exception:
        return jsonify({"ok": False, "error": "Invalid base64 image data"}), 400

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            f.write(image_bytes)
            tmp_path = f.name

        pdf = FPDF(orientation="L", unit="mm", format="A4")
        pdf.set_auto_page_break(auto=False)
        pdf.add_page()

        # Title
        pdf.set_font("Helvetica", "B", 18)
        pdf.cell(0, 14, title, ln=True, align="C")
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(0, 8, "Generated: " + datetime.now().strftime("%Y-%m-%d %H:%M"), ln=True, align="C")
        pdf.ln(4)

        # Image — fill available page width
        page_w = pdf.w - pdf.l_margin - pdf.r_margin
        pdf.image(tmp_path, x=pdf.l_margin, y=pdf.get_y(), w=page_w)

        pdf_bytes = pdf.output()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return Response(
        bytes(pdf_bytes),
        mimetype="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="floorplan.pdf"'},
    )

