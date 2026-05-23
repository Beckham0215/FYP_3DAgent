import json
import re

from groq import Groq

from flask import current_app


def _client():
    key = current_app.config.get("GROQ_API_KEY") or ""
    if not key:
        raise RuntimeError("GROQ_API_KEY is not set.")
    return Groq(api_key=key)


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
        "- query_assets: user asks about what assets/items are in a specific room or area (e.g. 'what are the assets in bedroom 1', 'how many closets are in bedroom 1', 'what furniture is in the kitchen', 'list items in living room').\n"
        "- navigate: user wants to go to a place, room, or tagged sweep (e.g. 'take me to the kitchen', 'go to bedroom').\n"
        "- visual: user asks about what is visible in the current view, colors, objects, 'what do you see', 'is there a chair', 'describe this view'.\n"
        "- mark_asset: user wants to tag or mark the CURRENT location with a name (e.g. 'mark this as kitchen', 'tag this place as bedroom', 'help me mark this location as office').\n"
        "- activity: user wants to do an activity that requires going to a specific location (e.g. 'I want to cook', 'I want to sleep', 'I need to work').\n"
        "- conversational: greetings, small talk, general questions not about the current view or moving in the space.\n\n"
        "Respond with ONLY valid JSON (no markdown fences):\n"
        '{"intent":"navigate"|"visual"|"mark_asset"|"activity"|"conversational"|"query_assets"|"react_query"|"where_am_i","destination_label":string or null,"asset_name":string or null,"query_area":string or null,"reply":string or null}\n'
        "Rules:\n"
        "- For where_am_i: set all other fields to null. This triggers a database lookup of the user's current location.\n"
        "- For react_query: set all other fields to null. This triggers multi-step agentic reasoning.\n"
        "- For query_assets: extract the room/area name and put it in query_area. If no room is mentioned, use the MEMORY CONTEXT area. Set destination_label and asset_name to null.\n"
        "- For navigate: set destination_label to the best matching label from the list (case-insensitive match). "
        "If the list is empty or no reasonable match, set intent to conversational and reply explaining they need to add tagged destinations first.\n"
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
                            "enum": ["navigate", "visual", "mark_asset", "activity", "conversational", "query_assets", "react_query", "where_am_i"],
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
        completion = _client().chat.completions.create(
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
    except Exception:
        completion = _client().chat.completions.create(
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
    completion = _client().chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.2,
        max_tokens=512,
    )
    return (completion.choices[0].message.content or "").strip()


# Activity-to-location mapping for semantic understanding
ACTIVITY_LOCATION_MAP = {
    "cook": "kitchen",
    "cooking": "kitchen",
    "prepare food": "kitchen",
    "eat": "dining room",
    "eating": "dining room",
    "dine": "dining room",
    "have breakfast": "kitchen",
    "have lunch": "dining room",
    "have dinner": "dining room",
    "sleep": "bedroom",
    "sleeping": "bedroom",
    "rest": "bedroom",
    "work": "office",
    "working": "office",
    "study": "office",
    "studying": "office",
    "read": "office",
    "reading": "office",
    "shower": "bathroom",
    "bathe": "bathroom",
    "bath": "bathroom",
    "wash": "bathroom",
    "watch tv": "living room",
    "relax": "living room",
    "sitting": "living room",
    "socialize": "living room",
    "entertain": "living room",
}


def get_location_for_activity(activity: str) -> str | None:
    """Map an activity to a likely location. Returns None if no clear match."""
    activity_lower = activity.lower().strip()
    return ACTIVITY_LOCATION_MAP.get(activity_lower)


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
    if intent not in ("navigate", "visual", "conversational", "mark_asset", "activity", "query_assets", "react_query", "where_am_i"):
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
    """
    Use Groq vision (Llama 4 Scout) to detect and count objects CLOSE to the camera.
    Uses the reliable comma-separated text format so the model returns the full object list.
    area_context: optional room name to help the model filter relevant objects.
    """
    if not image_b64:
        return {}

    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    area_hint = f" This image is from a '{area_context}'." if area_context else ""

    prompt = (
        f"Look at this room image carefully.{area_hint} "
        "IMPORTANT: Only list objects that are CLEARLY VISIBLE and CLOSE to the camera — "
        "items in the foreground or middle ground of this specific room. "
        "Do NOT include objects that are far away, blurry, through doorways, "
        "in adjacent rooms, or barely visible. "
        "List EVERY piece of furniture and object you can clearly see with their counts. "
        "Reply ONLY as a comma-separated list in this exact format: "
        "chair: 2, table: 1, sofa: 1, tv: 1, lamp: 2. "
        "No other text, no sentences, just the list. "
        "If you see nothing clearly, reply with: none"
    )

    try:
        completion = _client().chat.completions.create(
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


def detect_objects_from_image_with_positions(image_b64: str, area_context: str | None = None) -> dict:
    """Thin wrapper — scan flow only needs counts; positions fetched on-demand via locate_object_in_image."""
    counts = detect_objects_from_image(image_b64, area_context)
    return {"counts": counts, "positions": {}}


def locate_object_in_image(image_b64: str, object_name: str) -> list | None:
    """
    Ask the vision model for a tight bounding box of one specific object in the image.
    Returns [x1, y1, x2, y2] normalized 0–1, or None if the object is not visible.
    Called on-demand when the user clicks an asset name in the review panel.
    """
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
        completion = _client().chat.completions.create(
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
    """
    Locate multiple objects using a 3×3 zone grid description rather than pixel
    coordinates.  Zone descriptions ("right bottom") are far more reliable for
    general vision LLMs than predicting exact bounding-box numbers.
    Returns {name: [x1, y1, x2, y2]} as zone boundary fractions (0-1).
    Called during scan so zones are pre-computed and highlight feedback is instant.
    """
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
        completion = _client().chat.completions.create(
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


def suggest_location_name_from_image(image_b64: str) -> str | None:
    """Use vision model to suggest a room/area name from a 360° screenshot."""
    if not image_b64:
        return None
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    prompt = (
        "Look at this image from a 3D space. Identify what type of room or area this is. "
        "Reply with ONLY the room name — nothing else. "
        "Examples: Kitchen, Bedroom 1, Living Room, Office, Bathroom, Conference Room, Hallway, Dining Room. "
        "If multiple rooms are plausible, pick the most specific one. No explanations."
    )
    try:
        completion = _client().chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }],
            max_tokens=30,
            temperature=0.2,
        )
        name = (completion.choices[0].message.content or "").strip()
        name = name.split("\n")[0].strip("\"'").strip()
        return name if name else None
    except Exception as e:
        current_app.logger.exception(f"[Groq Vision] suggest_location_name_from_image failed: {e}")
        return None


def suggest_location_name_from_objects(detected_objects: dict) -> str | None:
    """Infer a room/area name from a dict of detected objects using the LLM."""
    if not detected_objects:
        return None
    objects_str = ", ".join(f"{count} {name}" for name, count in detected_objects.items())
    prompt = (
        f"A room contains: {objects_str}.\n"
        "What is the most likely room type? Reply with ONLY the room name — no explanation. "
        "Examples: Kitchen, Bedroom, Living Room, Office, Bathroom, Conference Room, Dining Room."
    )
    model = current_app.config.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    try:
        completion = _client().chat.completions.create(
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
        completion = _client().chat.completions.create(
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