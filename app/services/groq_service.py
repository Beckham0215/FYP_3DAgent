import json
import re

from groq import Groq, APIError as GroqAPIError

from flask import current_app


def _groq_create(**kwargs):
    """Call chat.completions.create with automatic fallback to GROQ_API_KEY_2 on rate-limit."""
    from groq import RateLimitError
    keys = [
        current_app.config.get("GROQ_API_KEY") or "",
        current_app.config.get("GROQ_API_KEY_2") or "",
    ]
    keys = [k for k in keys if k]
    if not keys:
        raise RuntimeError("GROQ_API_KEY is not set.")
    last_err = None
    for key in keys:
        try:
            return Groq(api_key=key).chat.completions.create(**kwargs)
        except RateLimitError as e:
            last_err = e
            continue
    raise last_err


def route_intent(user_message: str, asset_labels: list[str], last_queried_area: str | None = None, history: list | None = None) -> dict:
    """
    Returns dict with keys: intent (navigate|visual|conversational|mark_asset|activity|query_assets),
    destination_label (optional), asset_name (optional), reply (optional), query_area (optional).
    """
    labels_text = ", ".join(asset_labels) if asset_labels else "(none - add assets in the dashboard)"

    context_instruction = ""
    if last_queried_area:
        context_instruction = f"MEMORY CONTEXT: The user recently asked about '{last_queried_area}'. If they ask a follow-up without naming a room, assume they mean '{last_queried_area}'.\n\n"

    history_context = ""
    if history:
        recent = history[-6:]  # last 3 exchanges
        lines = []
        for msg in recent:
            role = "User" if msg.get("role") == "user" else "Agent"
            content = (msg.get("content") or "").strip()
            if content:
                lines.append(f"{role}: {content}")
        if lines:
            history_context = "RECENT CONVERSATION:\n" + "\n".join(lines) + "\n\n"

    system = (
        "You are the semantic router for 3DAgent in a Matterport 3D space.\n"
        f"Available navigation labels (exact strings users may want to visit): {labels_text}\n\n"
        f"{history_context}"
        f"{context_instruction}"
        "Classify the user message into exactly one intent:\n"
        "- where_am_i: user asks about their current location, which room or area they are in right now (e.g. 'where am I', 'what room is this', 'which location am I in', 'what place is this', 'tell me my current location').\n"
        "- react_query: user has a complex multi-step planning request requiring room suitability verification (e.g. 'I need a meeting room for 10 people', 'find a room that fits 15 people', 'which room has enough chairs for a seminar', 'I need to host a dinner for 8 people', 'set up a conference for 20 attendees').\n"
        "- query_assets: user asks WHAT items are in a room/area OR HOW MANY of a specific item there are (e.g. 'what are the assets in bedroom 1', 'how many chairs in the kitchen', 'how many chairs in this location', 'how many tables are here', 'what furniture is in the living room', 'how many chairs in total'). Put the specific item (SINGULAR, e.g. 'chair') in asset_name when they ask about one item type, else null.\n"
        "- list_locations: user asks what locations/rooms/areas exist or are tagged (e.g. 'what locations are there', 'list all rooms', 'what areas have been tagged', 'show me all tagged locations', 'how many rooms are there').\n"
        "- report_issue: user wants to report a fault, damage, or maintenance problem with a specific asset/equipment (e.g. 'report chair #1 has a broken leg', 'the elevator is not working', 'log a maintenance issue for the AC unit', 'chair 2 is damaged and wobbly', 'mark the projector as faulty').\n"
        "- list_problems: user asks which assets/equipment have problems, faults, or pending maintenance (e.g. 'what assets have problems', 'show faulty equipment', 'any maintenance issues', 'what needs fixing', 'list reported problems').\n"
        "- scan_area: user wants to scan/detect the assets in the current area or a room (e.g. 'scan this area', 'scan the room for assets', 'detect the objects here', 'run a scan', 'scan for items').\n"
        "- auto_tag: user wants to automatically tag/label all the locations (e.g. 'auto tag all locations', 'auto-tag this floor', 'automatically label all the rooms', 'auto tag everything').\n"
        "- show_floorplan: user wants the floor plan / map / minimap (e.g. 'show the floor plan', 'open the map', 'show me the minimap', 'display the floor map').\n"
        "- navigate: user wants to go to a place, room, tagged sweep, OR a specific physical object/asset (e.g. 'take me to the kitchen', 'go to bedroom', 'bring me to the fire extinguisher', 'navigate to forklift', 'take me to the nearest chair').\n"
        "- visual: user asks about what is visible in the current view, colors, objects, 'what do you see', 'is there a chair', 'describe this view'.\n"
        "- mark_asset: user wants to tag or mark the CURRENT location with a name (e.g. 'mark this as kitchen', 'tag this place as bedroom', 'help me mark this location as office').\n"
        "- activity: user wants to do an activity that requires going to a specific location (e.g. 'I want to cook', 'I want to sleep', 'I need to work').\n"
        "- conversational: greetings, small talk, general questions not about the current view or moving in the space.\n\n"
        "Respond with ONLY valid JSON (no markdown fences):\n"
        '{"intent":"navigate"|"visual"|"mark_asset"|"activity"|"conversational"|"query_assets"|"react_query"|"where_am_i"|"report_issue"|"list_problems"|"list_locations"|"scan_area"|"auto_tag"|"show_floorplan","destination_label":string or null,"asset_name":string or null,"query_area":string or null,"reply":string or null}\n'
        "Rules:\n"
        "- For report_issue: put the faulty asset/equipment name (including any number, e.g. 'chair #1') in asset_name. Set the other fields to null.\n"
        "- For list_problems, list_locations, scan_area, auto_tag, show_floorplan: set all other fields to null.\n"
        "- For where_am_i: set all other fields to null. This triggers a database lookup of the user's current location.\n"
        "- For react_query: set all other fields to null. This triggers multi-step agentic reasoning.\n"
        "- For query_assets: put the specific item type (SINGULAR, e.g. 'chair') in asset_name if they ask about ONE item type, else null. For the area in query_area: a named room -> that exact name; 'here'/'this location'/'this room'/'this area'/'current' -> '__current__'; whole space/'in total'/'overall'/'anywhere'/'all rooms' -> '__all__'; if no area is mentioned use the MEMORY CONTEXT area, otherwise '__current__'. Set destination_label to null.\n"
        "- For navigate: if the destination is a room or area, set destination_label to the best matching label from the available navigation labels list. "
        "If the destination is a specific physical object or item type (e.g. 'fire extinguisher', 'forklift', 'first aid kit', 'fire hose', 'chair'), "
        "ALWAYS use navigate intent and set destination_label to the object name as given — even if it is not in the navigation labels list. "
        "Only fall back to conversational if the destination is completely unclear.\n"
        "- For mark_asset: extract the asset name (e.g., 'Kitchen', 'Bedroom') and put it in asset_name. Set destination_label to null.\n"
        "- For activity: determine the required location (e.g., 'cook' -> 'kitchen'), then strictly match it against the 'Available navigation labels' provided above. Put the closest matching available label in destination_label.\n"
        "- For visual, conversational, or mark_asset: destination_label must be null unless it's activity or query_assets.\n"
        "- For conversational: put a short helpful reply in reply when appropriate.\n"
    )
    model = current_app.config.get("GROQ_MODEL", "llama-3.3-70b-versatile")

    tools = [
        {
            "type": "function",
            "function": {
                "name": "route_prompt",
                "description": "Classify the user's request for 3DAgent into navigate, visual, mark_asset, activity, query_assets, or conversational.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "intent": {
                            "type": "string",
                            "enum": ["navigate", "visual", "mark_asset", "activity", "conversational", "query_assets", "react_query", "where_am_i", "report_issue", "list_problems", "list_locations", "scan_area", "auto_tag", "show_floorplan"],
                        },
                        "destination_label": {
                            "anyOf": [{"type": "string"}, {"type": "null"}],
                        },
                        "asset_name": {
                            "anyOf": [{"type": "string"}, {"type": "null"}],
                        },
                        "query_area": {
                            "anyOf": [{"type": "string"}, {"type": "null"}],
                        },
                        "reply": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    },
                    "required": ["intent", "destination_label", "asset_name", "reply"],
                },
            },
        }
    ]

    # Prefer tool-calling for structured output. If the Groq SDK/model
    # returns plain text instead, we fall back to JSON parsing.
    try:
        completion = _groq_create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_message},
            ],
            tools=tools,
            temperature=0.2,
            max_tokens=512,
        )
        msg = completion.choices[0].message
        tool_calls = getattr(msg, "tool_calls", None)
        if tool_calls:
            first = tool_calls[0]
            fn = getattr(first, "function", None)
            if fn is None and isinstance(first, dict):
                fn = first.get("function")
            args = None
            if fn is not None:
                args = getattr(fn, "arguments", None)
                if args is None and isinstance(fn, dict):
                    args = fn.get("arguments")
            if args:
                try:
                    if isinstance(args, str):
                        parsed = json.loads(args)
                    else:
                        parsed = args
                    return _parse_router_json(json.dumps(parsed))
                except Exception:
                    pass

        text = (getattr(msg, "content", "") or "").strip()
        return _parse_router_json(text)
    except GroqAPIError:
        raise  # rate limit / auth / network — don't burn a second API call
    except Exception:
        # Tool-calling format issue (AttributeError, KeyError, JSONDecodeError).
        # Retry once without tools so the model returns plain JSON text.
        completion = _groq_create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_tokens=512,
        )
        text = (completion.choices[0].message.content or "").strip()
        return _parse_router_json(text)


def chat_reply(user_message: str, context: str | None = None, history: list | None = None) -> str:
    system = (
        "You are 3DAgent, a concise assistant for navigating and understanding Matterport 3D spaces. "
        "Keep answers short unless the user asks for detail."
    )
    if context:
        system += f"\nContext: {context}"
    model = current_app.config.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    messages = [{"role": "system", "content": system}]
    if history:
        for msg in history[-8:]:  # last 4 exchanges
            role = msg.get("role", "user")
            content = (msg.get("content") or "").strip()
            if content and role in ("user", "assistant"):
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_message})
    completion = _groq_create(
        model=model,
        messages=messages,
        temperature=0.2,
        max_tokens=512,
    )
    return (completion.choices[0].message.content or "").strip()


def _parse_router_json(text: str) -> dict:
    text = text.strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        text = m.group(0)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {
            "intent": "conversational",
            "destination_label": None,
            "asset_name": None,
            "query_area": None,
            "reply": "I could not parse the routing response. Please try rephrasing.",
        }
    intent = data.get("intent", "conversational")
    if intent not in ("navigate", "visual", "conversational", "mark_asset", "activity", "query_assets", "react_query", "where_am_i", "report_issue", "list_problems", "list_locations", "scan_area", "auto_tag", "show_floorplan"):
        intent = "conversational"
    return {
        "intent": intent,
        "destination_label": data.get("destination_label"),
        "asset_name": data.get("asset_name"),
        "query_area": data.get("query_area"),
        "reply": data.get("reply"),
    }

_VISION_SKIP_WORDS = frozenset({
    "image", "photo", "picture", "room", "floor", "wall",
    "ceiling", "window", "door", "light", "none", "area",
})


def parse_groq_vision_response(text: str) -> dict:
    """Parse the structured 'item: count' response from Llama 4 Scout vision.

    Expected format: ``chair: 2, table: 1, sofa: 1``
    Returns an empty dict for "none" / "nothing" or unparseable input.
    """
    if not text or text.lower().strip() in ("none", "nothing", "no objects", ""):
        return {}
    counts: dict = {}
    for match in re.finditer(r'([\w][\w\s]*?)\s*:\s*(\d+)', text.lower()):
        item  = match.group(1).strip()
        count = int(match.group(2))
        if item and count > 0 and item not in _VISION_SKIP_WORDS and len(item) > 1:
            counts[item] = count
    return counts


def detect_objects_from_image(image_b64: str, area_context: str | None = None) -> dict:
    if not image_b64:
        return {}
    if not current_app.config.get("CV_ENABLED", True):
        return _scout_detect_objects(image_b64, area_context)
    try:
        from app.services import cv_service
        result = cv_service.detect_objects_from_image(image_b64, area_context)
        if result:
            return result
        current_app.logger.warning("[CV] YOLO returned empty, falling back to Scout")
    except Exception as e:
        current_app.logger.warning(f"[CV] YOLO failed ({e}), falling back to Scout")
    if not current_app.config.get("CV_FALLBACK_TO_SCOUT", True):
        return {}
    return _scout_detect_objects(image_b64, area_context)


def _scout_detect_objects(image_b64: str, area_context: str | None = None) -> dict:
    if not image_b64:
        return {}

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    area_hint = f" This image is from a '{area_context}'." if area_context else ""

    prompt = (
        f"You are an asset-inventory inspector. Look at this image carefully.{area_hint} "
        "List the physical assets and equipment you can CLEARLY see, with exact counts.\n"
        "RULES:\n"
        "- Only count items CLEARLY VISIBLE and CLOSE to the camera (foreground/middle ground "
        "of this room). Ignore anything far away, blurry, through a doorway, or in an adjacent room.\n"
        "- Name each item with its MOST SPECIFIC real-world name, not a vague category. "
        "Prefer 'fire extinguisher', 'office chair', 'filing cabinet', 'forklift', 'pallet', "
        "'server rack', 'whiteboard', 'monitor', 'printer', 'water dispenser', 'workbench', "
        "'microscope', 'fume hood', 'shelving rack' over generic words like 'object', 'equipment', "
        "'furniture', 'thing', or 'machine'.\n"
        "- Use the SINGULAR noun as the key (chair, not chairs) and count the instances.\n"
        "- Do NOT list the room itself, walls, floor, ceiling, windows, or doors.\n"
        "Reply ONLY as a comma-separated 'item: count' list, e.g.: "
        "office chair: 4, desk: 2, monitor: 2, fire extinguisher: 1. "
        "No other text, no sentences. If you see no countable assets, reply with: none"
    )

    try:
        completion = _groq_create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            max_tokens=300,
            temperature=0.1,
        )
        answer = (completion.choices[0].message.content or "").strip()
        current_app.logger.info(f"[Groq Vision] Raw response: {answer}")
        counts = parse_groq_vision_response(answer)
        current_app.logger.info(f"[Groq Vision] Parsed counts: {counts}")
        return counts

    except Exception as e:
        current_app.logger.exception(f"[Groq Vision] Detection failed: {e}")
        return {}


def detect_objects_from_image_with_positions(image_b64: str, area_context: str | None = None, mode: str | None = None) -> dict:
    """Scout-primary hybrid detection.

    Step 1 — Llama-4 Scout names everything in the frame (open vocabulary) with
             per-item counts. Scout is the source of truth for WHAT is here, so
             specific items (microscope, centrifuge, fire extinguisher, …) are
             named properly instead of being squeezed into COCO's 80 classes.
    Step 2 — local CV finds bounding boxes for EXACTLY the items Scout named —
             guided detection, which is far more reliable than asking an LLM for
             coordinates. YOLOv8 covers the COCO classes; Grounding DINO (complex
             mode) is prompted with the remaining names.
    Step 3 — merge: Scout's counts + CV's boxes.

    Modes:  fast    → Scout counts only (no boxes / no highlight, fastest)
            normal  → Scout counts + YOLOv8 boxes
            complex → Scout counts + YOLOv8 + Grounding DINO boxes
    An item Scout names but CV can't localise still appears in the list — it just
    has no highlight box (clean fallback).
    """
    if not image_b64:
        return {"counts": {}, "positions": {}, "positions_all": {}}
    mode = (mode or "normal").strip().lower()

    # ── Step 1: Scout names everything (PRIMARY, open vocabulary) ──────────────
    counts: dict = {}
    try:
        counts = _scout_detect_objects(image_b64, area_context) or {}
    except Exception as e:
        current_app.logger.warning(f"[Scout] primary detection failed ({e})")

    # If Scout produced nothing, fall back to local CV (counts + boxes) so a scan
    # still works without the cloud model.
    if not counts:
        if current_app.config.get("CV_ENABLED", True):
            try:
                from app.services import cv_service
                result = cv_service.detect_objects_with_boxes(image_b64, area_context, mode)
                return {
                    "counts": result.get("counts", {}),
                    "positions": result.get("boxes", {}),
                    "positions_all": result.get("boxes_all", {}),
                }
            except Exception as e:
                current_app.logger.warning(f"[CV] fallback detection failed ({e})")
        return {"counts": {}, "positions": {}, "positions_all": {}}

    # ── Step 2: local CV finds boxes for exactly what Scout named ──────────────
    positions: dict = {}
    positions_all: dict = {}
    if mode != "fast" and current_app.config.get("CV_ENABLED", True):
        try:
            from app.services import cv_service
            boxes = cv_service.locate_boxes_for_labels(
                image_b64, list(counts.keys()), use_dino=(mode == "complex")
            )
            positions = boxes.get("positions", {})
            positions_all = boxes.get("positions_all", {})
        except Exception as e:
            current_app.logger.warning(f"[CV guided] box-finding failed ({e}); counts only")

    # ── Step 3: merge — Scout counts + CV boxes ────────────────────────────────
    return {"counts": counts, "positions": positions, "positions_all": positions_all}


def locate_object_in_image(image_b64: str, object_name: str) -> list | None:
    if not image_b64 or not object_name:
        return None
    if not current_app.config.get("CV_ENABLED", True):
        return _scout_locate_object(image_b64, object_name)
    try:
        from app.services import cv_service
        result = cv_service.locate_object_in_image(image_b64, object_name)
        if result:
            return result
        current_app.logger.warning(f"[CV] DINO found no bbox for '{object_name}', falling back to Scout")
    except Exception as e:
        current_app.logger.warning(f"[CV] DINO failed ({e}), falling back to Scout")
    if not current_app.config.get("CV_FALLBACK_TO_SCOUT", True):
        return None
    return _scout_locate_object(image_b64, object_name)


def _scout_locate_object(image_b64: str, object_name: str) -> list | None:
    if not image_b64 or not object_name:
        return None

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    prompt = (
        f"Find the '{object_name}' in this image. "
        "Output ONLY a JSON array [x1, y1, x2, y2] with four decimal numbers between 0 and 1, "
        "where (0,0) is the top-left corner and (1,1) is the bottom-right corner of the image. "
        "The coordinates must be normalized fractions, NOT pixel values. "
        "Draw a tight box around the object. Example: [0.12, 0.45, 0.55, 0.90]. "
        f"If '{object_name}' is not clearly visible, reply exactly: null"
    )

    try:
        completion = _groq_create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            max_tokens=60,
            temperature=0.1,
        )
        answer = (completion.choices[0].message.content or "").strip()
        current_app.logger.info(f"[Groq Locate '{object_name}'] Raw: {answer}")

        if answer.lower() in ("null", "none", "not visible", ""):
            return None

        # Extract [x1, y1, x2, y2] array
        m = re.search(r'\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]', answer)
        if not m:
            return None

        x1, y1, x2, y2 = [float(m.group(i)) for i in range(1, 5)]

        # Auto-detect coordinate system: model may return 0-1 normalized,
        # 0-1000 range (Llama visual grounding), or raw pixel coordinates.
        max_val = max(x1, y1, x2, y2)
        if max_val > 1.5:
            if max_val <= 1000:
                x1, y1, x2, y2 = x1 / 1000, y1 / 1000, x2 / 1000, y2 / 1000
            else:
                # Pixel coordinates — screenshot captured at 1280×720
                x1, x2 = x1 / 1280, x2 / 1280
                y1, y2 = y1 / 720,  y2 / 720

        x1, x2 = sorted([max(0.0, min(1.0, x1)), max(0.0, min(1.0, x2))])
        y1, y2 = sorted([max(0.0, min(1.0, y1)), max(0.0, min(1.0, y2))])
        if (x2 - x1) < 0.01 or (y2 - y1) < 0.01:
            return None

        bbox = [round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3)]
        current_app.logger.info(f"[Groq Locate '{object_name}'] BBox: {bbox}")
        return bbox

    except Exception as e:
        current_app.logger.exception(f"[Groq Locate] Failed for '{object_name}': {e}")
        return None


# Zone boundaries — overlapping slightly so the highlighted region doesn't feel
# like it's cut off at the edge of a zone.
_COL_ZONES = {
    "left":   (0.0,  0.38),
    "center": (0.31, 0.69),
    "right":  (0.62, 1.0),
}
_ROW_ZONES = {
    "top":    (0.0,  0.40),
    "middle": (0.30, 0.70),
    "bottom": (0.60, 1.0),
}


def locate_all_objects_in_image(image_b64: str, object_names: list) -> dict:
    if not image_b64 or not object_names:
        return {}
    if not current_app.config.get("CV_ENABLED", True):
        return _scout_locate_all_objects(image_b64, object_names)
    try:
        from app.services import cv_service
        result = cv_service.locate_all_objects_in_image(image_b64, object_names)
        if result:
            return result
        current_app.logger.warning("[CV] DINO returned no locations, falling back to Scout")
    except Exception as e:
        current_app.logger.warning(f"[CV] DINO failed ({e}), falling back to Scout")
    if not current_app.config.get("CV_FALLBACK_TO_SCOUT", True):
        return {}
    return _scout_locate_all_objects(image_b64, object_names)


def _scout_locate_all_objects(image_b64: str, object_names: list) -> dict:
    if not image_b64 or not object_names:
        return {}

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    names_str = ", ".join(list(object_names)[:15])
    prompt = (
        "For each visible object listed below, output its position on a new line as:\n"
        "name: COLUMN ROW\n"
        "COLUMN must be one of: left, center, right  (horizontal thirds of the image)\n"
        "ROW must be one of: top, middle, bottom  (vertical thirds of the image)\n"
        "Example:  chair: right bottom\n"
        "Skip objects that are not clearly visible. Output ONLY these lines, nothing else.\n"
        f"Objects: {names_str}"
    )

    try:
        completion = _groq_create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }],
            max_tokens=150,
            temperature=0.1,
        )
        answer = (completion.choices[0].message.content or "").strip()
        current_app.logger.info(f"[Groq LocateZones] Raw: {answer}")

        pattern = re.compile(
            r'([\w][\w\s/\-]*):\s*(left|center|right)\s+(top|middle|bottom)',
            re.IGNORECASE,
        )
        result = {}
        for m in pattern.finditer(answer):
            name = m.group(1).strip().lower()
            col  = m.group(2).lower()
            row  = m.group(3).lower()
            x1, x2 = _COL_ZONES.get(col, (0.2, 0.8))
            y1, y2 = _ROW_ZONES.get(row, (0.2, 0.8))
            result[name] = [x1, y1, x2, y2]

        current_app.logger.info(f"[Groq LocateZones] Parsed: {result}")
        return result

    except Exception as e:
        current_app.logger.exception(f"[Groq LocateZones] Failed: {e}")
        return {}


def locate_all_instances_in_image(image_b64: str, object_name: str, expected_count: int) -> list:
    if not image_b64 or not object_name or expected_count < 1:
        return []
    if not current_app.config.get("CV_ENABLED", True):
        return _scout_locate_all_instances(image_b64, object_name, expected_count)
    try:
        from app.services import cv_service
        result = cv_service.locate_all_instances_in_image(image_b64, object_name, expected_count)
        if result:
            return result
        current_app.logger.warning(f"[CV] DINO found no instances of '{object_name}', falling back to Scout")
    except Exception as e:
        current_app.logger.warning(f"[CV] DINO failed ({e}), falling back to Scout")
    if not current_app.config.get("CV_FALLBACK_TO_SCOUT", True):
        return []
    return _scout_locate_all_instances(image_b64, object_name, expected_count)


def _scout_locate_all_instances(image_b64: str, object_name: str, expected_count: int) -> list:
    if not image_b64 or not object_name or expected_count < 1:
        return []

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    prompt = (
        f"Find ALL visible '{object_name}' objects in this image. "
        f"There may be up to {expected_count} of them. "
        "For each one you can clearly see, output a tight bounding box as a JSON array "
        "[x1, y1, x2, y2] with normalised coordinates 0.0–1.0 where (0,0) is top-left. "
        f"Return ONLY a JSON array of arrays, e.g. [[0.1,0.2,0.5,0.8],[0.6,0.1,0.9,0.7]]. "
        f"If none are visible reply with exactly: []"
    )

    try:
        completion = _groq_create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }],
            max_tokens=200,
            temperature=0.1,
        )
        answer = (completion.choices[0].message.content or "").strip()
        current_app.logger.info(f"[Groq AllInstances '{object_name}'] Raw: {answer}")

        # Extract outer JSON array
        m = re.search(r'\[\s*(?:\[[\d.,\s]+\]\s*,?\s*)*\]', answer)
        if not m:
            return []

        raw = json.loads(m.group(0))
        results = []
        for bbox in raw[:expected_count]:
            if not isinstance(bbox, list) or len(bbox) != 4:
                continue
            x1, y1, x2, y2 = [float(v) for v in bbox]
            max_val = max(x1, y1, x2, y2)
            if max_val > 1.5:
                if max_val <= 1000:
                    x1, y1, x2, y2 = x1 / 1000, y1 / 1000, x2 / 1000, y2 / 1000
                else:
                    x1, x2 = x1 / 1280, x2 / 1280
                    y1, y2 = y1 / 720, y2 / 720
            x1, x2 = sorted([max(0.0, min(1.0, x1)), max(0.0, min(1.0, x2))])
            y1, y2 = sorted([max(0.0, min(1.0, y1)), max(0.0, min(1.0, y2))])
            if (x2 - x1) >= 0.01 and (y2 - y1) >= 0.01:
                results.append([round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3)])

        current_app.logger.info(f"[Groq AllInstances '{object_name}'] Parsed {len(results)} bbox(es)")
        return results

    except Exception as e:
        current_app.logger.exception(f"[Groq AllInstances] Failed for '{object_name}': {e}")
        return []


def suggest_location_name_from_image(
    image_b64: str,
    building_context: str | None = None,
    nearby_names: list | None = None,
) -> str | None:
    """Use a vision model to name the area shown in a screenshot.

    The label is chosen from the *visible evidence* across many domains
    (industrial, lab, warehouse, office, retail, healthcare, residential), not a
    fixed residential list — so a factory floor isn't mislabelled "Office" and a
    lab isn't called "Canteen". ``building_context`` (the space/site name) anchors
    the likely setting. ``nearby_names`` lists labels already given to adjacent
    sweeps so the model stays consistent within a single room instead of renaming
    the same room on every step.
    """
    if not image_b64:
        return None
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    context_line = ""
    if building_context:
        context_line = (
            f'This area is inside a site/building named "{building_context}". '
            "Use that to judge the likely setting (e.g. factory, laboratory, warehouse, "
            "office, hospital, school, retail store, or home).\n"
        )

    nearby_line = ""
    if nearby_names:
        uniq = ", ".join(dict.fromkeys(n for n in nearby_names if n))
        if uniq:
            nearby_line = (
                f"NEARBY POINTS in this same area were already labelled: {uniq}.\n"
                "If this view is clearly the SAME room/area as one of those, reply with that "
                "EXACT existing name (so one room keeps one name). Only give a different name "
                "if this is clearly a separate area.\n"
            )

    prompt = (
        "You are labelling areas in a 3D walkthrough of a REAL building.\n"
        f"{context_line}"
        f"{nearby_line}"
        "Look carefully at the VISIBLE evidence — equipment, machinery, furniture, "
        "fixtures, signage and layout — and name THIS specific area accordingly. "
        "Match the label to what you actually see, for example:\n"
        "- Heavy machinery, assembly lines, conveyors, workbenches, pallets -> Factory Floor or Workshop\n"
        "- Lab benches, fume hoods, microscopes, test/measurement equipment -> Laboratory\n"
        "- Server racks, network cabling -> Server Room\n"
        "- Tall shelving racks stacked with boxes/goods -> Warehouse or Storage\n"
        "- Desks, monitors, office chairs -> Office\n"
        "- A large table ringed with chairs and a screen -> Meeting Room\n"
        "- Dining tables with a serving counter -> Canteen or Cafeteria\n"
        "- Cooking appliances -> Kitchen; beds -> Bedroom; toilets/sinks -> Restroom\n"
        "- Loading docks / roller shutter doors -> Loading Bay; a reception desk -> Reception\n"
        "- A plain connecting passage with doors -> Corridor\n"
        "Do NOT default to Office, Canteen, or a home room unless the evidence clearly "
        "supports it. If unsure, choose the label that best fits the MOST PROMINENT "
        "equipment visible.\n"
        "Reply with ONLY the area name (1-3 words). No explanation, no punctuation."
    )
    try:
        completion = _groq_create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }],
            max_tokens=30,
            temperature=0.0,
        )
        name = (completion.choices[0].message.content or "").strip()
        name = name.split("\n")[0].strip("\"'").strip().rstrip(".")
        return name if name else None
    except Exception as e:
        current_app.logger.exception(f"[Groq Vision] suggest_location_name_from_image failed: {e}")
        return None


def suggest_location_name_from_objects(detected_objects: dict, building_context: str | None = None) -> str | None:
    """Infer an area name from a dict of detected objects using the LLM."""
    if not detected_objects:
        return None
    objects_str = ", ".join(f"{count} {name}" for name, count in detected_objects.items())
    context_line = ""
    if building_context:
        context_line = (
            f'This is inside a site/building named "{building_context}", '
            "so consider industrial, lab, warehouse, retail and office areas too, "
            "not only home rooms.\n"
        )
    prompt = (
        f"{context_line}"
        f"An area contains these detected items: {objects_str}.\n"
        "Based on the items, name the single most likely area type. Consider a wide range: "
        "Factory Floor, Workshop, Laboratory, Server Room, Warehouse, Storage, Loading Bay, "
        "Office, Meeting Room, Reception, Canteen, Kitchen, Restroom, Corridor, Bedroom, "
        "Living Room, etc. Pick the best fit for the items — do not default to Office or a "
        "home room unless the items clearly indicate it.\n"
        "Reply with ONLY the area name (1-3 words). No explanation."
    )
    model = current_app.config.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    try:
        completion = _groq_create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=20,
        )
        name = (completion.choices[0].message.content or "").strip()
        name = name.split("\n")[0].strip("\"'").strip()
        return name if name else None
    except Exception as e:
        current_app.logger.exception(f"[Groq] suggest_location_name_from_objects failed: {e}")
        return None


def parse_report_request(user_message: str) -> dict:
    """Extract the faulty asset, problem description and severity from a spoken
    maintenance report like 'report chair #1 has a broken leg'."""
    prompt = (
        "The user is reporting a maintenance problem with an asset/equipment. Extract:\n"
        "(1) asset: the asset/equipment name INCLUDING any number, e.g. 'chair #1', 'elevator', 'AC unit 2'.\n"
        "(2) description: a short description of what is wrong (e.g. 'broken leg', 'not working').\n"
        "(3) severity: one of low, medium, high, critical. Infer from wording — default medium; "
        "'broken'/'not working'/'leaking'/'damaged' -> high; 'dangerous'/'unsafe'/'fire'/'sparking'/'hazard' -> critical; "
        "'minor'/'scratch'/'cosmetic'/'loose' -> low.\n"
        'Respond ONLY with valid JSON, no markdown: {"asset":"chair #1","description":"broken leg","severity":"high"}\n'
        f"User request: {user_message}"
    )
    model = current_app.config.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    try:
        completion = _groq_create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=150,
        )
        text = (completion.choices[0].message.content or "").strip()
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            parsed = json.loads(m.group(0))
            severity = str(parsed.get("severity", "medium")).lower().strip()
            if severity not in ("low", "medium", "high", "critical"):
                severity = "medium"
            return {
                "asset": str(parsed.get("asset", "")).strip(),
                "description": str(parsed.get("description", "")).strip(),
                "severity": severity,
            }
    except Exception as e:
        current_app.logger.exception(f"[Groq] parse_report_request failed: {e}")
    return {"asset": "", "description": "", "severity": "medium"}


def parse_react_request(user_message: str) -> dict:
    """Extract asset type and minimum count needed from a complex planning request."""
    prompt = (
        "The user is making a planning request about a physical space. "
        "Extract: (1) the asset/furniture type they need, (2) the minimum quantity required. "
        'Respond ONLY with valid JSON, no markdown: {"asset": "chair", "min_count": 10, "reasoning": "Meeting for 10 people requires 10 chairs"}\n'
        f"User request: {user_message}"
    )
    model = current_app.config.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    try:
        completion = _groq_create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=150,
        )
        text = (completion.choices[0].message.content or "").strip()
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            parsed = json.loads(m.group(0))
            return {
                "asset": str(parsed.get("asset", "chair")).lower().strip(),
                "min_count": max(1, int(parsed.get("min_count", 1))),
                "reasoning": str(parsed.get("reasoning", "Looking for suitable space")),
            }
    except Exception as e:
        current_app.logger.exception(f"[Groq] parse_react_request failed: {e}")
    return {"asset": "chair", "min_count": 1, "reasoning": "Looking for a suitable room"}