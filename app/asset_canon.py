"""Canonicalise free-text object labels coming out of the open-vocabulary
vision model so the same physical thing isn't counted under several names.

The scan pipeline keys counts on the raw label string the vision model returns,
so one chair shows up as "chair", "office chairs", "blue chair", "teal chair"…
and inflates the inventory. This module folds those variants together with a
*conservative* policy:

  - lower-case, de-punctuate, collapse whitespace
  - drop leading colour / material / pattern / size adjectives
    ("blue armchair" -> "armchair", "wooden counter" -> "counter")
  - singularise the head (last) noun ("office chairs" -> "office chair")
  - apply a small hand-checked synonym map ("sofa" -> "couch", …)

Conservative means functional type words are KEPT: "office chair", "dining
chair" and "armchair" stay distinct; "coffee table" and "side table" stay
distinct. Only pure descriptors (colour/material/pattern/size) are stripped.
"""

import re

# Leading descriptor words that don't change WHAT a thing is — safe to strip.
# Deliberately excludes functional modifiers like "office", "dining", "coffee",
# "side", "end", "console", "reception", "filing", "shelving", "potted".
_QUALIFIERS = {
    # colours
    "black", "white", "gray", "grey", "silver", "gold", "golden", "blue",
    "navy", "red", "maroon", "green", "teal", "cyan", "yellow", "orange",
    "purple", "violet", "pink", "brown", "beige", "tan", "cream", "ivory",
    "dark", "light",
    # materials
    "wooden", "wood", "metal", "metallic", "steel", "iron", "aluminium",
    "aluminum", "glass", "plastic", "leather", "fabric", "ceramic", "marble",
    "granite", "chrome", "stone", "concrete",
    # patterns
    "patterned", "striped", "checkered", "checked", "floral", "plain", "solid",
    # size / generic descriptors
    "large", "small", "big", "little", "tall", "short", "wide", "narrow",
    "modern", "vintage", "old", "new", "antique", "decorative", "rectangular",
    "round", "square", "oval",
}

# Full-phrase synonyms, matched after normalisation. Keys and values are the
# normalised (lower, singular, de-punctuated) forms. Kept deliberately small and
# only for clear, non-controversial equivalences.
_SYNONYMS = {
    "sofa": "couch",
    "settee": "couch",
    "computer mouse": "mouse",
    "computer keyboard": "keyboard",
    "vase with flowers": "vase",
    "vase with flower": "vase",
    "vase of flowers": "vase",
    "flower vase": "vase",
    "planter box": "planter",
    "plant pot": "planter",
    "flower pot": "planter",
    "tv": "television",
    "telly": "television",
}


def _normalize(name: str) -> str:
    """Lower-case, drop punctuation, collapse whitespace."""
    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _singularize(word: str) -> str:
    """Best-effort English singularisation of a single token."""
    if len(word) <= 3:
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"          # batteries -> battery
    if word.endswith("ves"):
        return word[:-3] + "f"          # shelves -> shelf
    if word.endswith(("ses", "xes", "zes", "ches", "shes")):
        return word[:-2]                # boxes -> box, benches -> bench
    if word.endswith("ss"):
        return word                     # glass, mattress -> unchanged
    if word.endswith("s"):
        return word[:-1]                # chairs -> chair
    return word


def canonicalize_label(name: str) -> str:
    """Return the canonical form of a single object label (may be empty)."""
    s = _normalize(name)
    if not s:
        return ""
    if s in _SYNONYMS:
        return _SYNONYMS[s]

    tokens = s.split()
    # Strip leading descriptor words, but never the final noun.
    while len(tokens) > 1 and tokens[0] in _QUALIFIERS:
        tokens = tokens[1:]
    # Singularise the head (last) noun only — "office chairs" -> "office chair".
    tokens[-1] = _singularize(tokens[-1])
    s = " ".join(tokens)

    # Second pass: a synonym may only surface after stripping/singularising
    # (e.g. "leather sofas" -> "sofa" -> "couch").
    return _SYNONYMS.get(s, s)


def _bbox_area(b) -> float:
    if not b or len(b) != 4:
        return 0.0
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def canonicalize_detection(counts: dict, positions: dict | None = None,
                           positions_all: dict | None = None) -> tuple[dict, dict, dict]:
    """Fold a single view's detections onto canonical labels.

    Counts for merged labels are SUMMED (the model listed them as separate
    items in this frame, so they're distinct instances); the prominent box is
    the largest of the merged boxes; per-instance boxes are concatenated so the
    downstream spatial-dedup still sees every instance.
    """
    positions = positions or {}
    positions_all = positions_all or {}

    merged_counts: dict = {}
    merged_pos: dict = {}
    merged_pos_all: dict = {}

    for name, count in (counts or {}).items():
        try:
            count = int(count)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue
        canon = canonicalize_label(name)
        if not canon:
            continue

        merged_counts[canon] = merged_counts.get(canon, 0) + count

        box = positions.get(name)
        if box and (canon not in merged_pos or _bbox_area(box) > _bbox_area(merged_pos[canon])):
            merged_pos[canon] = box

        boxes = positions_all.get(name)
        if isinstance(boxes, list) and boxes:
            merged_pos_all.setdefault(canon, []).extend(boxes)

    return merged_counts, merged_pos, merged_pos_all
