import json
import re
import random
import hashlib
from functools import wraps

from flask import Blueprint, current_app, jsonify, request, session

from app.extensions import db
from app.label_match import resolve_asset
from app.models import Asset, AssetsSummary, ChatHistoryLog, MatterportSpace
from app.services import blip_service, groq_service

bp = Blueprint("api", __name__, url_prefix="/api")

ALLOWED_SCAN_OBJECTS = {"chair", "table", "tv", "sofa", "desk", "bed", "lamp", "plant", "closet"}


def api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        return f(*args, **kwargs)

    return decorated


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
    import re
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


def _detect_objects_with_vision(image_b64: str, area_context: str | None = None) -> dict:
    """
    Primary: Groq vision (proximity-aware, filters out far/adjacent-room objects).
    Fallback: BLIP keyword scan.
    """
    if not image_b64:
        return {}
    try:
        if current_app.config.get("GROQ_API_KEY"):
            counts = groq_service.detect_objects_from_image(image_b64, area_context)
            current_app.logger.info(f"[Vision] Groq vision detected: {counts}")
            if counts:
                return counts
            current_app.logger.warning("[Vision] Groq vision returned empty, falling back to BLIP")

        answer = blip_service.answer_visual_question(
            image_b64, "What furniture and objects are in this room?"
        )
        current_app.logger.info(f"[Vision] BLIP fallback response: {answer}")
        return _parse_blip_detection_response(answer)

    except Exception as e:
        current_app.logger.exception(f"[Vision] Detection failed: {e}")
        return {}


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
        routed = groq_service.route_intent(message, labels, last_queried_area)
    except Exception as e:
        current_app.logger.exception("Groq routing error")
        return jsonify({"ok": False, "error": f"Router error: {e!s}"}), 503

    intent = routed.get("intent", "conversational")

    if intent == "query_assets":
        # User is asking about assets in a specific room/area
        query_area = routed.get("query_area")
        if not query_area:
            fallback = "I understand you're asking about assets in a location, but I couldn't identify which room. Please try: 'What are the assets in [room name]?'"
            _log_chat(uid, map_id, message, fallback)
            return jsonify({"ok": True, "intent": "chat", "response": fallback})
        
        # Store the queried area in session for context (full session context)
        session[f"last_queried_area_{map_id}"] = query_area
        
        # Query the AssetsSummary table for the specified area
        asset_summaries = AssetsSummary.query.filter_by(
            map_id=map_id,
            area_name=query_area
        ).all()
        
        if not asset_summaries:
            # Try case-insensitive search if exact match fails
            all_summaries = AssetsSummary.query.filter_by(map_id=map_id).all()
            query_area_lower = query_area.lower()
            asset_summaries = [
                s for s in all_summaries 
                if s.area_name and s.area_name.lower() == query_area_lower
            ]
        
        if not asset_summaries:
            reply = f"No assets have been recorded for {query_area}. Try scanning it first using the viewer."
            _log_chat(uid, map_id, message, reply)
            return jsonify({"ok": True, "intent": "chat", "response": reply})
        
        # Build a natural language response from the asset summary
        asset_list = {}
        for summary in asset_summaries:
            asset_name = summary.asset_name
            count = summary.count
            if asset_name:
                asset_list[asset_name] = count
        
        if asset_list:
            reply_parts = []
            for asset_name, count in sorted(asset_list.items()):
                if count == 1:
                    reply_parts.append(f"1 {asset_name}")
                else:
                    reply_parts.append(f"{count} {asset_name}s")
            
            reply = f"In {query_area}: {', '.join(reply_parts)}."
        else:
            reply = f"No assets detected in {query_area}."
        
        _log_chat(uid, map_id, message, reply)
        return jsonify({"ok": True, "intent": "chat", "response": reply})

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
        fallback = routed.get("reply") or (
            "No matching tagged destination. Add labels and sweep UUIDs under Manage assets."
        )
        _log_chat(uid, map_id, message, fallback)
        return jsonify({"ok": True, "intent": "chat", "response": fallback})

    # conversational
    reply = routed.get("reply")
    if not reply:
        try:
            reply = groq_service.chat_reply(message)
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
    category = (data.get("category") or "").strip()

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
        object_counts = _detect_objects_with_vision(image_b64, area_context)
    except Exception as e:
        current_app.logger.exception("Scan assets vision detector failed")
        return jsonify({"ok": False, "error": f"Vision detection failed: {e!s}"}), 500

    # Return all detected objects (no hardcoded filtering - allow dynamic detection)
    cleaned_counts = {}
    for name, count in object_counts.items():
        label = (name or "").strip().lower()
        if not label or count <= 0:
            continue
        cleaned_counts[label] = count
    
    current_app.logger.info(f"[Scan] Detected {len(cleaned_counts)} unique items: {list(cleaned_counts.keys())}")
    return jsonify({"ok": True, "objects": cleaned_counts})


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
        if cleaned_count < 0:
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
        if cleaned_count <= 0:  # Skip items with 0 or negative count
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
    current_app.logger.info(f"[Scan] User confirmed and saved {len(saved_rows)} assets for {area_name}")
    return jsonify({"ok": True, "saved": saved_rows, "message": f"Confirmed {len(saved_rows)} assets for {area_name}"})


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

