"""Ground truth test cases for 3DAgent evaluation.

Components covered:
  - Intent classification  (route_intent)
  - Label resolution       (resolve_asset)
  - BLIP count extraction  (_extract_count_from_answer)
  - Activity mapping       (get_location_for_activity)
  - Scan diff              (_compute_scan_diff)
  - ReAct request parsing  (parse_react_request)
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional


# ── Intent Classification ─────────────────────────────────────────────────────

@dataclass
class IntentCase:
    message: str
    expected_intent: str
    labels: List[str] = field(default_factory=list)
    expected_destination: Optional[str] = None
    expected_asset_name: Optional[str] = None
    expected_query_area: Optional[str] = None


# Full intent taxonomy as routed by route_intent() in groq_service.py.
# NOTE: this list was previously only 8 classes; the live router added 6 more
# (list_locations, report_issue, list_problems, scan_area, auto_tag,
# show_floorplan).  Keeping it in sync is required for the confusion matrix
# and per-class metrics to be meaningful.
INTENT_CLASSES = [
    "navigate", "visual", "mark_asset", "activity",
    "conversational", "query_assets", "react_query", "where_am_i",
    "list_locations", "report_issue", "list_problems",
    "scan_area", "auto_tag", "show_floorplan",
]

INTENT_CASES: List[IntentCase] = [
    # where_am_i (5)
    IntentCase("where am I", "where_am_i"),
    IntentCase("what room is this", "where_am_i"),
    IntentCase("which location am I in", "where_am_i"),
    IntentCase("what place is this", "where_am_i"),
    IntentCase("tell me my current location", "where_am_i"),

    # navigate (5)
    IntentCase("take me to the kitchen", "navigate",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Kitchen 1"),
    IntentCase("go to bedroom 1", "navigate",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Bedroom 1"),
    IntentCase("navigate to the office", "navigate",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1"),
    IntentCase("bring me to the living room", "navigate",
               ["Kitchen 1", "Living Room 1", "Office 1"], "Living Room 1"),
    IntentCase("I want to visit the bathroom", "navigate",
               ["Kitchen 1", "Bathroom 1", "Office 1"], "Bathroom 1"),

    # mark_asset (5)
    IntentCase("mark this as kitchen", "mark_asset", [], None, "kitchen"),
    IntentCase("tag this place as bedroom", "mark_asset", [], None, "bedroom"),
    IntentCase("help me mark this location as office", "mark_asset", [], None, "office"),
    IntentCase("label this as conference room", "mark_asset", [], None, "conference room"),
    IntentCase("save this spot as bathroom", "mark_asset", [], None, "bathroom"),

    # visual (5)
    IntentCase("what do you see", "visual"),
    IntentCase("describe this view", "visual"),
    IntentCase("is there a chair here", "visual"),
    IntentCase("what objects are in this room", "visual"),
    IntentCase("what color is the wall", "visual"),

    # query_assets (5)
    IntentCase("what furniture is in the kitchen", "query_assets",
               [], None, None, "kitchen"),
    IntentCase("how many chairs are in bedroom 1", "query_assets",
               [], None, None, "bedroom 1"),
    IntentCase("list items in living room", "query_assets",
               [], None, None, "living room"),
    IntentCase("what are the assets in the office", "query_assets",
               [], None, None, "office"),
    IntentCase("what is in bedroom 2", "query_assets",
               [], None, None, "bedroom 2"),

    # activity (5)
    IntentCase("I want to cook", "activity",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Kitchen 1"),
    IntentCase("I want to sleep", "activity",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Bedroom 1"),
    IntentCase("I need to work", "activity",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1"),
    IntentCase("I want to relax", "activity",
               ["Kitchen 1", "Bedroom 1", "Living Room 1"], "Living Room 1"),
    IntentCase("I want to shower", "activity",
               ["Kitchen 1", "Bedroom 1", "Bathroom 1"], "Bathroom 1"),

    # react_query (5)
    IntentCase("I need a meeting room for 10 people", "react_query"),
    IntentCase("find a room that fits 15 people", "react_query"),
    IntentCase("which room has enough chairs for a seminar", "react_query"),
    IntentCase("I need to host a dinner for 8 people", "react_query"),
    IntentCase("set up a conference for 20 attendees", "react_query"),

    # conversational (5)
    IntentCase("hello", "conversational"),
    IntentCase("how are you", "conversational"),
    IntentCase("what is the weather like", "conversational"),
    IntentCase("what can you do", "conversational"),
    IntentCase("tell me about 3DAgent", "conversational"),

    # list_locations (5)
    IntentCase("what locations are there", "list_locations"),
    IntentCase("list all rooms", "list_locations"),
    IntentCase("what areas have been tagged", "list_locations"),
    IntentCase("show me all tagged locations", "list_locations"),
    IntentCase("how many rooms are there", "list_locations"),

    # report_issue (5)
    IntentCase("report chair #1 has a broken leg", "report_issue",
               [], None, "chair #1"),
    IntentCase("the elevator is not working", "report_issue",
               [], None, "elevator"),
    IntentCase("log a maintenance issue for the AC unit", "report_issue",
               [], None, "AC unit"),
    IntentCase("chair 2 is damaged and wobbly", "report_issue",
               [], None, "chair 2"),
    IntentCase("mark the projector as faulty", "report_issue",
               [], None, "projector"),

    # list_problems (5)
    IntentCase("what assets have problems", "list_problems"),
    IntentCase("show faulty equipment", "list_problems"),
    IntentCase("any maintenance issues", "list_problems"),
    IntentCase("what needs fixing", "list_problems"),
    IntentCase("list reported problems", "list_problems"),

    # scan_area (5)
    IntentCase("scan this area", "scan_area"),
    IntentCase("scan the room for assets", "scan_area"),
    IntentCase("detect the objects here", "scan_area"),
    IntentCase("run a scan", "scan_area"),
    IntentCase("scan for items", "scan_area"),

    # auto_tag (5)
    IntentCase("auto tag all locations", "auto_tag"),
    IntentCase("auto-tag this floor", "auto_tag"),
    IntentCase("automatically label all the rooms", "auto_tag"),
    IntentCase("auto tag everything", "auto_tag"),
    IntentCase("automatically tag all the locations for me", "auto_tag"),

    # show_floorplan (5)
    IntentCase("show the floor plan", "show_floorplan"),
    IntentCase("open the map", "show_floorplan"),
    IntentCase("show me the minimap", "show_floorplan"),
    IntentCase("display the floor map", "show_floorplan"),
    IntentCase("bring up the floorplan", "show_floorplan"),
]


# ── Intent Robustness Probes ──────────────────────────────────────────────────
# Same intents expressed with typos, casual phrasing, and indirect wording.
# These deliberately differ from the prompt's canonical examples to test
# generalisation rather than memorisation of the few-shot exemplars.

INTENT_ROBUSTNESS_CASES: List[IntentCase] = [
    IntentCase("yo where am i rn", "where_am_i"),
    IntentCase("whats this room called", "where_am_i"),
    IntentCase("can u take me 2 the kitchen pls", "navigate",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Kitchen 1"),
    IntentCase("head over to the office", "navigate",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1"),
    IntentCase("im hungry and wanna make food", "activity",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Kitchen 1"),
    IntentCase("i'm sleepy", "activity",
               ["Kitchen 1", "Bedroom 1", "Office 1"], "Bedroom 1"),
    IntentCase("how many chairs we got in bedroom 1", "query_assets",
               [], None, None, "bedroom 1"),
    IntentCase("whats in the living room", "query_assets",
               [], None, None, "living room"),
    IntentCase("the printer is jammed again", "report_issue",
               [], None, "printer"),
    IntentCase("anything broken around here", "list_problems"),
    IntentCase("gimme the map", "show_floorplan"),
    IntentCase("check this room for stuff", "scan_area"),
    IntentCase("which rooms do we have", "list_locations"),
    IntentCase("need space for a 12 person workshop", "react_query"),
    IntentCase("sup", "conversational"),
]


# ── Label Resolution ──────────────────────────────────────────────────────────

@dataclass
class LabelMatchCase:
    label_guess: Optional[str]
    available_labels: List[str]
    expected_match: Optional[str]
    category: str  # exact | case_insensitive | partial | fuzzy | no_match


LABEL_MATCH_CASES: List[LabelMatchCase] = [
    # Exact match
    LabelMatchCase("Kitchen 1", ["Kitchen 1", "Bedroom 1", "Office 1"], "Kitchen 1", "exact"),
    LabelMatchCase("Bedroom 1", ["Kitchen 1", "Bedroom 1", "Office 1"], "Bedroom 1", "exact"),
    LabelMatchCase("Office 1",  ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1",  "exact"),

    # Case-insensitive
    LabelMatchCase("kitchen 1", ["Kitchen 1", "Bedroom 1"], "Kitchen 1", "case_insensitive"),
    LabelMatchCase("BEDROOM 1", ["Kitchen 1", "Bedroom 1"], "Bedroom 1", "case_insensitive"),
    LabelMatchCase("OFFICE 1",  ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1",  "case_insensitive"),

    # Partial / substring
    LabelMatchCase("kitchen", ["Kitchen 1", "Bedroom 1", "Office 1"], "Kitchen 1", "partial"),
    LabelMatchCase("bedroom", ["Kitchen 1", "Bedroom 1", "Office 1"], "Bedroom 1", "partial"),
    LabelMatchCase("office",  ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1",  "partial"),
    LabelMatchCase("living",  ["Kitchen 1", "Living Room 1", "Office 1"], "Living Room 1", "partial"),
    LabelMatchCase("bed",     ["Kitchen 1", "Bedroom 1", "Office 1"], "Bedroom 1", "partial"),

    # Fuzzy (typos)
    LabelMatchCase("Kitchin",  ["Kitchen 1", "Bedroom 1"], "Kitchen 1", "fuzzy"),
    LabelMatchCase("Bedrroom", ["Kitchen 1", "Bedroom 1"], "Bedroom 1", "fuzzy"),
    LabelMatchCase("Offiec",   ["Kitchen 1", "Bedroom 1", "Office 1"], "Office 1", "fuzzy"),
    LabelMatchCase("Kicten",   ["Kitchen 1", "Bedroom 1"], "Kitchen 1", "fuzzy"),

    # No match
    LabelMatchCase("garage",          ["Kitchen 1", "Bedroom 1", "Office 1"], None, "no_match"),
    LabelMatchCase("xyz unknown room", ["Kitchen 1", "Bedroom 1"],            None, "no_match"),
    LabelMatchCase(None, ["Kitchen 1", "Bedroom 1"], None, "no_match"),
    LabelMatchCase("",   ["Kitchen 1", "Bedroom 1"], None, "no_match"),
    LabelMatchCase("kitchen", [],                    None, "no_match"),
]


# ── Groq Vision (Llama 4 Scout) Response Parser ───────────────────────────────
# parse_groq_vision_response() in groq_service.py
# Expected input format: "chair: 2, table: 1, sofa: 1"

@dataclass
class GroqVisionParseCase:
    raw_response: str
    expected_counts: Dict[str, int]
    description: str = ""


GROQ_VISION_PARSE_CASES: List[GroqVisionParseCase] = [
    # Standard well-formed response
    GroqVisionParseCase("chair: 2, table: 1",
                        {"chair": 2, "table": 1}, "basic"),
    GroqVisionParseCase("chair: 3, sofa: 1, lamp: 2, tv: 1",
                        {"chair": 3, "sofa": 1, "lamp": 2, "tv": 1}, "multi-item"),
    GroqVisionParseCase("desk: 4, monitor: 2, plant: 1",
                        {"desk": 4, "monitor": 2, "plant": 1}, "office"),
    # Single item
    GroqVisionParseCase("bed: 1", {"bed": 1}, "single item"),
    # Empty / nothing visible
    GroqVisionParseCase("none",    {}, "none keyword"),
    GroqVisionParseCase("nothing", {}, "nothing keyword"),
    GroqVisionParseCase("",        {}, "empty string"),
    GroqVisionParseCase("no objects", {}, "no objects phrase"),
    # Skip words — these should be filtered out
    GroqVisionParseCase("room: 2, chair: 3, wall: 1, floor: 1",
                        {"chair": 3}, "skip words filtered"),
    GroqVisionParseCase("image: 1, photo: 2, desk: 2",
                        {"desk": 2}, "image/photo filtered"),
    # Zero counts must be excluded
    GroqVisionParseCase("chair: 0, table: 2", {"table": 2}, "zero count excluded"),
    # Single-character item names filtered (len > 1 rule)
    GroqVisionParseCase("a: 3, tv: 1, bed: 2", {"tv": 1, "bed": 2}, "single-char filtered"),
    # Extra whitespace / capitalisation (lowercased internally)
    GroqVisionParseCase("Chair: 2,  Table:  1", {"chair": 2, "table": 1}, "capitalised"),
    # Multi-word item names
    GroqVisionParseCase("coffee table: 1, arm chair: 3",
                        {"coffee table": 1, "arm chair": 3}, "multi-word items"),
]


# ── BLIP Fallback Detection Parser ────────────────────────────────────────────
# _parse_blip_detection_response() in api.py
# BLIP returns free-form text; the parser extracts item counts via three patterns.
# NOTE: Pattern 2 uses a greedy regex ([\w]+(?:\s[\w]+)?) that captures the
# following word too — "chairs and" instead of "chairs".  Cases marked
# "greedy_bug" document that known defect so regressions don't go undetected.

@dataclass
class BlipParseCase:
    response: str
    expected_counts: Dict[str, int]
    description: str = ""


BLIP_PARSE_CASES: List[BlipParseCase] = [
    # Pattern 1: "item: N" colon format — clean and reliable
    BlipParseCase("chair: 2, table: 1",     {"chair": 2, "table": 1},       "colon format"),
    BlipParseCase("sofa: 1, tv: 1, lamp: 3",{"sofa": 1, "tv": 1, "lamp": 3},"multi colon"),
    # Pattern 2: "N items" single-word plurals — works correctly
    BlipParseCase("2 chairs",  {"chair": 2}, "numeric plural singular"),
    BlipParseCase("3 sofas",   {"sofa": 3},  "numeric plural singular 2"),
    # Pattern 3: keyword fallback — triggers when Patterns 1&2 find nothing
    BlipParseCase("sofa table chair", {"chair": 1, "table": 1, "sofa": 1}, "keyword fallback"),
    # Known greedy-regex defect: "and"/"with" after item gets absorbed
    BlipParseCase("2 chairs and 1 table", {"chairs and": 2, "table": 1}, "greedy_bug: and absorbed"),
    # Empty
    BlipParseCase("", {}, "empty"),
]


# ── Activity-to-Location Mapping ──────────────────────────────────────────────

@dataclass
class ActivityMapCase:
    activity: str
    expected_location: Optional[str]


ACTIVITY_MAP_CASES: List[ActivityMapCase] = [
    ActivityMapCase("cook",          "kitchen"),
    ActivityMapCase("cooking",       "kitchen"),
    ActivityMapCase("COOK",          "kitchen"),  # uppercase → lowercased
    ActivityMapCase("Cook",          "kitchen"),  # mixed case
    ActivityMapCase("prepare food",  "kitchen"),
    ActivityMapCase("eat",           "dining room"),
    ActivityMapCase("eating",        "dining room"),
    ActivityMapCase("dine",          "dining room"),
    ActivityMapCase("have breakfast","kitchen"),
    ActivityMapCase("have lunch",    "dining room"),
    ActivityMapCase("have dinner",   "dining room"),
    ActivityMapCase("sleep",         "bedroom"),
    ActivityMapCase("sleeping",      "bedroom"),
    ActivityMapCase("rest",          "bedroom"),
    ActivityMapCase("work",          "office"),
    ActivityMapCase("working",       "office"),
    ActivityMapCase("study",         "office"),
    ActivityMapCase("studying",      "office"),
    ActivityMapCase("read",          "office"),
    ActivityMapCase("reading",       "office"),
    ActivityMapCase("shower",        "bathroom"),
    ActivityMapCase("bathe",         "bathroom"),
    ActivityMapCase("bath",          "bathroom"),
    ActivityMapCase("wash",          "bathroom"),
    ActivityMapCase("watch tv",      "living room"),
    ActivityMapCase("relax",         "living room"),
    ActivityMapCase("sitting",       "living room"),
    ActivityMapCase("socialize",     "living room"),
    ActivityMapCase("entertain",     "living room"),
    # Unknown / edge cases
    ActivityMapCase("fly",              None),
    ActivityMapCase("swim",             None),
    ActivityMapCase("unknown activity", None),
    ActivityMapCase("",                 None),
    ActivityMapCase("  cook  ",         "kitchen"),  # surrounding whitespace
]


# ── Scan Change Detection ─────────────────────────────────────────────────────

@dataclass
class ScanDiffCase:
    current: Dict[str, int]
    previous: Dict[str, int]
    expected_changes: List[Dict]  # sorted by item name, only changed items


SCAN_DIFF_CASES: List[ScanDiffCase] = [
    # Nothing changed
    ScanDiffCase({"chair": 3, "table": 2}, {"chair": 3, "table": 2}, []),

    # Both dicts empty
    ScanDiffCase({}, {}, []),

    # Count increase
    ScanDiffCase({"chair": 4}, {"chair": 3},
                 [{"item": "chair", "previous": 3, "current": 4, "delta": 1}]),

    # Count decrease
    ScanDiffCase({"chair": 2}, {"chair": 5},
                 [{"item": "chair", "previous": 5, "current": 2, "delta": -3}]),

    # New item appeared
    ScanDiffCase({"chair": 3, "desk": 2}, {"chair": 3},
                 [{"item": "desk", "previous": 0, "current": 2, "delta": 2}]),

    # Item disappeared
    ScanDiffCase({"chair": 3}, {"chair": 3, "sofa": 1},
                 [{"item": "sofa", "previous": 1, "current": 0, "delta": -1}]),

    # Multiple changes (sorted alphabetically by item)
    ScanDiffCase(
        {"chair": 4, "table": 2, "desk": 1},
        {"chair": 3, "table": 2, "lamp": 2},
        [
            {"item": "chair", "previous": 3, "current": 4, "delta":  1},
            {"item": "desk",  "previous": 0, "current": 1, "delta":  1},
            {"item": "lamp",  "previous": 2, "current": 0, "delta": -2},
        ],
    ),
]


# ── ReAct Request Parsing ─────────────────────────────────────────────────────

@dataclass
class ReactParserCase:
    request: str
    expected_asset: str
    expected_min_count: int


REACT_PARSER_CASES: List[ReactParserCase] = [
    ReactParserCase("I need a meeting room for 10 people",          "chair", 10),
    ReactParserCase("find a room that fits 15 people",              "chair", 15),
    ReactParserCase("which room has enough chairs for 20 attendees","chair", 20),
    ReactParserCase("I need to host a dinner for 8 people",         "chair",  8),
    ReactParserCase("set up a conference for 12 attendees",         "chair", 12),
    ReactParserCase("I want a room with at least 5 tables",         "table",  5),
    ReactParserCase("find a room with 3 desks for studying",        "desk",   3),
    ReactParserCase("we need seating for 25 people",                "chair", 25),
    ReactParserCase("a workshop for 6 participants",                "chair",  6),
    ReactParserCase("find somewhere with 4 whiteboards",           "whiteboard", 4),
    ReactParserCase("book a space for a team of 9",                 "chair",  9),
]
