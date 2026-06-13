import base64
import logging
import threading
from io import BytesIO

import torch
from PIL import Image

logger = logging.getLogger(__name__)

_yolo_model = None
_seg_model = None
_seg_unavailable = False
_dino_model = None
_dino_processor = None
_device = None
_dino_unavailable = False
_lock = threading.Lock()

_COCO_TO_APP_LABEL = {
    "dining table": "table",
    "couch":        "sofa",
    "refrigerator": "fridge",
    "potted plant": "plant",
    "cell phone":   "phone",
    "handbag":      "bag",
    # Open-vocabulary (DINO/Scout) synonyms collapsed onto canonical asset names
    # so they don't split into a near-duplicate category alongside the YOLO label.
    "office chair":  "chair",
    "ceiling fan":   "fan",
    "bookshelf":     "shelf",
    "shelving rack": "shelf",
    "examination bed": "bed",
    "hospital bed":  "bed",
    "reception desk": "desk",
    "cardboard box": "box",
}

_EXCLUDE_CLASSES = frozenset({
    "person", "cat", "dog", "bird", "car", "truck", "bus",
    "motorcycle", "bicycle", "airplane", "boat", "train",
})

# Open-vocabulary terms that COCO/YOLOv8 (80 classes) cannot name. Running these
# through Grounding DINO during a scan lets specialised equipment be identified by
# its real name instead of being missed or mapped to the nearest COCO class.
# Kept deliberately free of COCO furniture (chair/table/sofa/tv/…) so the YOLO
# counts for common items stay authoritative and DINO only ADDS new categories.
_SCAN_BASE_VOCAB = (
    "fire extinguisher", "first aid kit", "exit sign", "trash can",
    "whiteboard", "monitor", "printer", "projector", "cabinet",
    "shelf", "desk", "water dispenser", "air conditioner", "ceiling fan",
)

# Extra vocabulary pulled in when the area name hints at a particular setting, so
# a factory floor surfaces forklifts/pallets and a lab surfaces fume hoods, etc.
_SCAN_DOMAIN_VOCAB = {
    "factory":   ("forklift", "pallet", "pallet jack", "workbench", "conveyor belt", "tool cabinet", "ladder", "trolley", "drum", "crate"),
    "workshop":  ("workbench", "tool cabinet", "ladder", "drill press", "vise", "trolley"),
    "warehouse": ("forklift", "pallet", "pallet jack", "shelving rack", "crate", "cardboard box", "trolley", "ladder"),
    "storage":   ("pallet", "shelving rack", "crate", "cardboard box", "ladder"),
    "loading":   ("forklift", "pallet", "pallet jack", "crate", "trolley"),
    "lab":       ("microscope", "fume hood", "lab bench", "test tube rack", "centrifuge", "safety cabinet"),
    "server":    ("server rack", "network switch", "patch panel", "computer tower"),
    "office":    ("filing cabinet", "photocopier", "office chair", "bookshelf"),
    "meeting":   ("whiteboard", "projector screen", "speakerphone"),
    "reception": ("reception desk", "sofa", "display stand"),
    "kitchen":   ("coffee machine", "kettle", "water dispenser", "dishwasher"),
    "canteen":   ("vending machine", "water dispenser", "coffee machine"),
    "retail":    ("shopping cart", "display rack", "mannequin", "shelving rack"),
    "hospital":  ("wheelchair", "stretcher", "hospital bed", "iv stand", "medical cart"),
    "clinic":    ("wheelchair", "examination bed", "iv stand", "medical cart"),
}


def _build_scan_vocab(area_context: str | None) -> list[str]:
    """Curated open-vocabulary term list for a scan, biased by the area name."""
    override = _get_config("CV_HYBRID_VOCAB_TERMS", "")
    if override:
        terms = [t.strip().lower() for t in str(override).split(",") if t.strip()]
        return list(dict.fromkeys(terms))

    terms = list(_SCAN_BASE_VOCAB)
    ctx = (area_context or "").lower()
    for key, extra in _SCAN_DOMAIN_VOCAB.items():
        if key in ctx:
            terms.extend(extra)
    # De-dup while preserving order; cap length so the DINO prompt stays sharp.
    deduped = list(dict.fromkeys(terms))
    return deduped[:18]


def _iou(a: list, b: list) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _nms(scored_boxes: list, iou_thresh: float) -> list:
    """Greedy non-max suppression. scored_boxes: list of (score, bbox)."""
    kept: list = []
    for score, box in sorted(scored_boxes, key=lambda t: t[0], reverse=True):
        if all(_iou(box, kb) < iou_thresh for _, kb in kept):
            kept.append((score, box))
    return kept


def _get_config(key, default):
    try:
        from flask import current_app
        return current_app.config.get(key, default)
    except RuntimeError:
        return default


def _normalize_label(label: str) -> str:
    label = label.strip().lower()
    return _COCO_TO_APP_LABEL.get(label, label)


def _decode_image(image_b64: str) -> Image.Image:
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    return Image.open(BytesIO(base64.b64decode(image_b64))).convert("RGB")


def _normalize_bbox(box, img_w: int, img_h: int) -> list | None:
    x1, y1, x2, y2 = box
    x1, x2 = sorted([max(0.0, min(1.0, x1 / img_w)), max(0.0, min(1.0, x2 / img_w))])
    y1, y2 = sorted([max(0.0, min(1.0, y1 / img_h)), max(0.0, min(1.0, y2 / img_h))])
    if (x2 - x1) < 0.01 or (y2 - y1) < 0.01:
        return None
    return [round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3)]


def _load_yolo():
    global _yolo_model, _device
    with _lock:
        if _yolo_model is not None:
            return
        import os
        from ultralytics import YOLO
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        model_name = _get_config("CV_YOLO_MODEL", "yolov8s.pt")
        model_dir  = _get_config("CV_MODELS_DIR", "")
        local_path = os.path.join(model_dir, model_name) if model_dir else ""
        path = local_path if local_path and os.path.exists(local_path) else model_name
        logger.info(f"[CV] Loading YOLOv8 from {path!r} on {_device}")
        _yolo_model = YOLO(path)
        _yolo_model.to(_device)
        logger.info("[CV] YOLOv8 ready")


def _load_seg():
    """Lazy-load YOLOv8-seg (instance segmentation) for edge-fitting outlines."""
    global _seg_model, _seg_unavailable, _device
    if _seg_unavailable:
        raise RuntimeError("YOLOv8-seg is unavailable (failed to load earlier)")
    with _lock:
        if _seg_model is not None:
            return
        try:
            import os
            from ultralytics import YOLO
            _device = "cuda" if torch.cuda.is_available() else "cpu"
            model_name = _get_config("CV_SEG_MODEL", "yolov8s-seg.pt")
            model_dir  = _get_config("CV_MODELS_DIR", "")
            local_path = os.path.join(model_dir, model_name) if model_dir else ""
            path = local_path if local_path and os.path.exists(local_path) else model_name
            logger.info(f"[CV] Loading YOLOv8-seg from {path!r} on {_device}")
            _seg_model = YOLO(path)
            _seg_model.to(_device)
            logger.info("[CV] YOLOv8-seg ready")
        except Exception as e:
            _seg_unavailable = True
            logger.exception(f"[CV] YOLOv8-seg failed to load: {e}")
            raise RuntimeError(f"YOLOv8-seg failed to load: {e}") from e


def segment_object_in_image(image_b64: str, object_name: str, bbox_hint=None, instance_index=None) -> dict | None:
    """Return a tight polygon outline (normalised 0-1) for ONE specific instance
    of ``object_name``, using YOLOv8-seg masks.

    All visible instances are enumerated and ordered left-to-right (then
    top-to-bottom) so numbering is stable. Which one is returned:
      * ``bbox_hint`` (normalised x1,y1,x2,y2)  → the instance nearest that box
        (most accurate — used when the scan stored a per-instance box).
      * else ``instance_index`` (0-based)       → the Nth instance in that order.
      * else                                    → the highest-confidence instance.

    Returns:
      {"ok": True, "polygon": [...], "bbox": [...], "score": f,
       "instance_index": i, "total": n}                    — outline found
      {"ok": False, "reason": "instance_not_visible", "total": n}
                         — object(s) seen, but the requested index isn't in view
      None               — segmentation unavailable, or no matching object at all
    """
    if not image_b64 or not object_name:
        return None
    try:
        _load_seg()
    except Exception as e:
        logger.warning(f"[CV SEG] unavailable: {e}")
        return None

    try:
        image = _decode_image(image_b64)
        img_w, img_h = image.size
        conf = _get_config("CV_SEG_CONFIDENCE", 0.25)
        target = _normalize_label(object_name)
        with torch.no_grad():
            results = _seg_model(image, conf=conf, verbose=False)
    except Exception as e:
        logger.warning(f"[CV SEG] inference failed: {e}")
        return None

    candidates = []  # {poly, bbox, score, cx, cy}
    for r in results:
        if r.masks is None:
            continue
        polys = r.masks.xy  # list of (N,2) pixel-coordinate arrays
        boxes = r.boxes
        for i, poly in enumerate(polys):
            try:
                label = _normalize_label(_seg_model.names[int(boxes.cls[i])])
                score = float(boxes.conf[i])
            except Exception:
                continue
            if not (label == target or target in label or label in target):
                continue
            pts = poly.tolist()
            if len(pts) < 3:
                continue
            npts = [
                [max(0.0, min(1.0, p[0] / img_w)), max(0.0, min(1.0, p[1] / img_h))]
                for p in pts
            ]
            xs = [p[0] for p in npts]
            ys = [p[1] for p in npts]
            bbox_norm = [min(xs), min(ys), max(xs), max(ys)]
            candidates.append({
                "poly": npts,
                "bbox": bbox_norm,
                "score": score,
                "cx": (bbox_norm[0] + bbox_norm[2]) / 2.0,
                "cy": (bbox_norm[1] + bbox_norm[3]) / 2.0,
            })

    if not candidates:
        return None

    # Stable spatial order: left-to-right, then top-to-bottom.
    candidates.sort(key=lambda c: (round(c["cx"], 2), round(c["cy"], 2)))
    total = len(candidates)

    if bbox_hint and len(bbox_hint) == 4:
        hcx = (bbox_hint[0] + bbox_hint[2]) / 2.0
        hcy = (bbox_hint[1] + bbox_hint[3]) / 2.0
        chosen = min(candidates, key=lambda c: (c["cx"] - hcx) ** 2 + (c["cy"] - hcy) ** 2)
    elif instance_index is not None:
        if 0 <= instance_index < total:
            chosen = candidates[instance_index]
        else:
            logger.info(f"[CV SEG] {object_name!r} instance #{instance_index} not in view ({total} seen)")
            return {"ok": False, "reason": "instance_not_visible", "total": total}
    else:
        chosen = max(candidates, key=lambda c: c["score"])

    npts = chosen["poly"]
    if len(npts) > 80:  # keep the payload light
        step = (len(npts) + 79) // 80
        npts = npts[::step]
    npts = [[round(x, 4), round(y, 4)] for x, y in npts]
    logger.info(f"[CV SEG] outline {object_name!r} instance {candidates.index(chosen)}/{total} ({len(npts)} pts)")
    return {
        "ok": True,
        "polygon": npts,
        "bbox": [round(v, 4) for v in chosen["bbox"]],
        "score": round(chosen["score"], 3),
        "instance_index": candidates.index(chosen),
        "total": total,
    }


def _load_dino():
    global _dino_model, _dino_processor, _dino_unavailable, _device
    if _dino_unavailable:
        raise RuntimeError("Grounding DINO is unavailable (failed to load earlier)")
    with _lock:
        if _dino_unavailable:
            raise RuntimeError("Grounding DINO is unavailable (failed to load earlier)")
        if _dino_model is not None:
            return
        try:
            from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
            _device = "cuda" if torch.cuda.is_available() else "cpu"
            model_id = _get_config("CV_DINO_MODEL", "IDEA-Research/grounding-dino-base")
            logger.info(f"[CV] Loading Grounding DINO from {model_id!r} on {_device}")
            _dino_processor = AutoProcessor.from_pretrained(model_id)
            _dino_model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id)
            _dino_model.to(_device)
            _dino_model.eval()
            logger.info("[CV] Grounding DINO ready")
        except Exception as e:
            _dino_unavailable = True
            logger.exception(f"[CV] Grounding DINO failed to load: {e}")
            raise RuntimeError(f"Grounding DINO failed to load: {e}") from e


def _run_dino(image: Image.Image, text: str, box_thresh: float | None = None, text_thresh: float | None = None) -> dict:
    img_w, img_h = image.size
    if box_thresh is None:
        box_thresh = _get_config("CV_DINO_CONFIDENCE", 0.25)
    if text_thresh is None:
        text_thresh = _get_config("CV_DINO_TEXT_THRESHOLD", 0.25)

    inputs = _dino_processor(images=image, text=text, return_tensors="pt")
    inputs = {k: v.to(_device) if hasattr(v, "to") else v for k, v in inputs.items()}

    with torch.no_grad():
        outputs = _dino_model(**inputs)

    results = _dino_processor.post_process_grounded_object_detection(
        outputs,
        inputs["input_ids"],
        box_threshold=box_thresh,
        text_threshold=text_thresh,
        target_sizes=[image.size[::-1]],
    )
    return results[0] if results else {"boxes": [], "scores": [], "labels": []}


def _safe_load_yolo():
    try:
        _load_yolo()
    except Exception as e:
        logger.warning(f"[CV] YOLO preload failed (will retry lazily): {e}")


def _safe_load_dino():
    try:
        _load_dino()
    except Exception as e:
        logger.warning(f"[CV] DINO preload failed (will retry lazily): {e}")


def preload_yolo_only():
    """Background-load only YOLO (cheap). Grounding DINO stays lazy to limit the
    startup memory spike on low-RAM machines."""
    threading.Thread(target=_safe_load_yolo, daemon=True, name="cv-yolo-preload").start()


def preload():
    """Start loading YOLO and Grounding DINO in background threads at app startup."""
    threading.Thread(target=_safe_load_yolo, daemon=True, name="cv-yolo-preload").start()
    threading.Thread(target=_safe_load_dino, daemon=True, name="cv-dino-preload").start()


# Per-mode detection tuning. ``hybrid`` toggles the open-vocabulary DINO pass;
# ``yolo_conf``/``dino_conf`` of None fall back to the configured defaults.
#   fast    → YOLO only, higher confidence (quick, shallow vocabulary)
#   normal  → YOLO + open-vocab hybrid at default thresholds (balanced)
#   complex → YOLO + open-vocab hybrid at lower thresholds (slow, most thorough)
_SCAN_MODE_SETTINGS = {
    "fast":    {"hybrid": False, "yolo_conf": 0.45, "dino_conf": None},
    "normal":  {"hybrid": True,  "yolo_conf": None, "dino_conf": None},
    "complex": {"hybrid": True,  "yolo_conf": 0.25, "dino_conf": 0.22},
}


def _mode_settings(mode: str | None) -> dict:
    return _SCAN_MODE_SETTINGS.get((mode or "normal").lower(), _SCAN_MODE_SETTINGS["normal"])


def _yolo_detect_boxes(image: Image.Image, conf: float | None = None) -> dict:
    """YOLO pass: counts plus EVERY instance's box per COCO class."""
    _load_yolo()
    img_w, img_h = image.size
    if conf is None:
        conf = _get_config("CV_YOLO_CONFIDENCE", 0.35)
    with torch.no_grad():
        results = _yolo_model(image, conf=conf, verbose=False)

    # name -> list of (area, bbox) so we can rank instances by prominence
    collected: dict = {}
    for r in results:
        for box in r.boxes:
            raw_label = _yolo_model.names[int(box.cls)]
            label = _normalize_label(raw_label)
            if label in _EXCLUDE_CLASSES:
                continue
            nb = _normalize_bbox(box.xyxy[0].tolist(), img_w, img_h)
            if nb:
                area = (nb[2] - nb[0]) * (nb[3] - nb[1])
                collected.setdefault(label, []).append((area, nb))

    counts: dict = {}
    boxes: dict = {}
    boxes_all: dict = {}
    for label, items in collected.items():
        items.sort(key=lambda t: t[0], reverse=True)  # largest/closest first
        ordered = [bbox for _, bbox in items]
        counts[label] = len(ordered)
        boxes_all[label] = ordered
        boxes[label] = ordered[0]
    return {"counts": counts, "boxes": boxes, "boxes_all": boxes_all}


def _dino_detect_vocab(image: Image.Image, vocab: list[str], box_thresh: float | None = None) -> dict:
    """Open-vocabulary detection of the given terms via Grounding DINO.

    Returns {term: [bbox, ...]} after per-term NMS. Boxes are normalised 0-1.
    """
    if not vocab:
        return {}
    img_w, img_h = image.size
    if box_thresh is None:
        box_thresh = _get_config("CV_HYBRID_DINO_CONFIDENCE", 0.30)
    text_thresh = _get_config("CV_DINO_TEXT_THRESHOLD", 0.25)
    text = " . ".join(vocab) + " ."
    result = _run_dino(image, text, box_thresh=box_thresh, text_thresh=text_thresh)

    boxes  = result.get("boxes", [])
    scores = result.get("scores", [])
    labels = result.get("labels", [])
    if hasattr(boxes, "tolist"):
        boxes = boxes.tolist()
    if hasattr(scores, "tolist"):
        scores = scores.tolist()

    per_term: dict = {}
    for box, score, label in zip(boxes, scores, labels):
        nb = _normalize_bbox(box, img_w, img_h)
        if not nb:
            continue
        lab = (label or "").strip().lower()
        if not lab:
            continue
        # Map DINO's matched phrase back to a vocab term (it may return a substring).
        term = next((v for v in vocab if v in lab or lab in v), lab)
        per_term.setdefault(term, []).append((float(score), nb))

    nms_iou = _get_config("CV_HYBRID_NMS_IOU", 0.5)
    return {term: [b for _, b in _nms(bs, nms_iou)] for term, bs in per_term.items()}


def detect_objects_with_boxes(image_b64: str, area_context: str | None = None, mode: str | None = None) -> dict:
    """Detect assets returning counts plus EVERY instance's box per class.

    YOLOv8 handles the 80 COCO classes (reliable counts + boxes). When the hybrid
    open-vocabulary pass is enabled, Grounding DINO additionally names specialised
    equipment COCO cannot (fire extinguisher, forklift, server rack, whiteboard …),
    biased by the area name. DINO boxes that overlap an existing detection are
    dropped (IoU dedup) so the same physical object is never counted twice.

    ``mode`` selects the speed/accuracy trade-off (fast / normal / complex): fast
    skips the open-vocab pass and uses a higher YOLO threshold; complex runs the
    full hybrid at lower thresholds to catch more.

    Returns {
        "counts":    {name: int},
        "boxes":     {name: [x1,y1,x2,y2]},          # most prominent box (instance #1)
        "boxes_all": {name: [[x1,y1,x2,y2], ...]},   # all instances, prominent-first
    }
    All boxes are normalised 0-1.
    """
    if not image_b64:
        return {"counts": {}, "boxes": {}, "boxes_all": {}}
    settings = _mode_settings(mode)
    image = _decode_image(image_b64)

    yolo = _yolo_detect_boxes(image, conf=settings.get("yolo_conf"))
    counts    = dict(yolo["counts"])
    boxes_all = {k: list(v) for k, v in yolo["boxes_all"].items()}

    if settings.get("hybrid") and _get_config("CV_HYBRID_VOCAB", True):
        try:
            _load_dino()
            vocab = _build_scan_vocab(area_context)
            dino_raw = _dino_detect_vocab(image, vocab, box_thresh=settings.get("dino_conf"))
            dedup_iou = _get_config("CV_HYBRID_DEDUP_IOU", 0.5)
            # Flatten all boxes already accepted so cross-label duplicates are caught.
            existing = [b for bxs in boxes_all.values() for b in bxs]
            added_total = 0
            for term, bxs in dino_raw.items():
                label = _normalize_label(term)
                if label in _EXCLUDE_CLASSES:
                    continue
                kept = []
                for b in bxs:
                    if any(_iou(b, e) >= dedup_iou for e in existing):
                        continue
                    kept.append(b)
                    existing.append(b)
                if kept:
                    counts[label] = counts.get(label, 0) + len(kept)
                    boxes_all.setdefault(label, []).extend(kept)
                    added_total += len(kept)
            logger.info(f"[CV Hybrid] DINO vocab added {added_total} instance(s) across {len(dino_raw)} term(s)")
        except Exception as e:
            logger.warning(f"[CV Hybrid] open-vocab pass skipped ({e})")

    # Rebuild prominent-first ordering per label (largest box = closest = instance #1).
    boxes: dict = {}
    for label, items in boxes_all.items():
        items.sort(key=lambda bb: (bb[2] - bb[0]) * (bb[3] - bb[1]), reverse=True)
        boxes_all[label] = items
        boxes[label] = items[0]

    logger.info(f"[CV] Detected: {counts}")
    return {"counts": counts, "boxes": boxes, "boxes_all": boxes_all}


def detect_objects_from_image(image_b64: str, area_context: str | None = None, mode: str | None = None) -> dict:
    return detect_objects_with_boxes(image_b64, area_context, mode)["counts"]


def locate_boxes_for_labels(image_b64: str, labels: list, use_dino: bool = False) -> dict:
    """Guided localisation — boxes only, no counts.

    Given the item names a vision model (Scout) already detected, find bounding
    boxes for each: YOLOv8 supplies boxes for the 80 COCO classes, and — when
    ``use_dino`` is set — Grounding DINO is prompted with exactly the remaining
    names (guided open-vocab detection, no curated list needed).

    Returns {"positions": {name: bbox}, "positions_all": {name: [bbox, ...]}}
    keyed by the SAME label strings passed in, so they line up with the counts.
    Names that can't be localised are simply absent (they stay in the list,
    just without a highlight).
    """
    if not image_b64 or not labels:
        return {"positions": {}, "positions_all": {}}
    image = _decode_image(image_b64)

    want = []
    for lbl in labels:
        s = str(lbl).strip().lower()
        if s and s not in want:
            want.append(s)
    boxes_all = {name: [] for name in want}

    # YOLO once — match its COCO detections to the requested names.
    try:
        yolo = _yolo_detect_boxes(image)
        for ylabel, ybxs in yolo["boxes_all"].items():
            for name in want:
                if ylabel == name or ylabel in name or name in ylabel:
                    boxes_all[name].extend(ybxs)
    except Exception as e:
        logger.warning(f"[CV guided] YOLO pass failed: {e}")

    # Grounding DINO — guided detection for the names YOLO didn't cover.
    if use_dino:
        missing = [n for n in want if not boxes_all.get(n)]
        if missing:
            try:
                _load_dino()
                dino = _dino_detect_vocab(image, missing)
                for term, dbxs in dino.items():
                    boxes_all.setdefault(term, []).extend(dbxs)
            except Exception as e:
                logger.warning(f"[CV guided] DINO pass failed: {e}")

    positions, positions_all = {}, {}
    for name, bxs in boxes_all.items():
        if not bxs:
            continue
        bxs = sorted(bxs, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        positions_all[name] = bxs
        positions[name] = bxs[0]
    logger.info(f"[CV guided] located boxes for {len(positions)}/{len(want)} label(s)")
    return {"positions": positions, "positions_all": positions_all}


def locate_object_in_image(image_b64: str, object_name: str) -> list | None:
    if not image_b64 or not object_name:
        return None
    _load_dino()
    image = _decode_image(image_b64)
    img_w, img_h = image.size
    text = object_name.lower().strip().rstrip(".").replace(".", "") + " ."
    result = _run_dino(image, text)

    boxes  = result.get("boxes", [])
    scores = result.get("scores", [])
    if hasattr(boxes, "tolist"):
        boxes = boxes.tolist()
    if hasattr(scores, "tolist"):
        scores = scores.tolist()
    if not boxes:
        return None

    best_idx = scores.index(max(scores)) if scores else 0
    return _normalize_bbox(boxes[best_idx], img_w, img_h)


def locate_all_objects_in_image(image_b64: str, object_names: list) -> dict:
    if not image_b64 or not object_names:
        return {}
    _load_dino()
    image = _decode_image(image_b64)
    img_w, img_h = image.size

    clean_names = [n.strip().lower().rstrip(".").replace(".", "") for n in object_names[:15]]
    text = " . ".join(clean_names) + " ."
    result = _run_dino(image, text)

    boxes  = result.get("boxes", [])
    scores = result.get("scores", [])
    labels = result.get("labels", [])
    if hasattr(boxes, "tolist"):
        boxes = boxes.tolist()
    if hasattr(scores, "tolist"):
        scores = scores.tolist()
    if not boxes:
        return {}

    output = {}
    for name in clean_names:
        best_score = -1.0
        best_box   = None
        for box, score, label in zip(boxes, scores, labels):
            label_str = (label or "").strip().lower()
            if name in label_str or label_str in name:
                if score > best_score:
                    best_score = score
                    best_box   = box
        if best_box is not None:
            normalized = _normalize_bbox(best_box, img_w, img_h)
            if normalized:
                output[name] = normalized

    logger.info(f"[CV DINO] Located {len(output)}/{len(clean_names)} objects")
    return output


def locate_all_instances_in_image(image_b64: str, object_name: str, expected_count: int) -> list:
    if not image_b64 or not object_name or expected_count < 1:
        return []
    _load_dino()
    image = _decode_image(image_b64)
    img_w, img_h = image.size
    text = object_name.lower().strip().rstrip(".").replace(".", "") + " ."
    result = _run_dino(image, text)

    boxes  = result.get("boxes", [])
    scores = result.get("scores", [])
    if hasattr(boxes, "tolist"):
        boxes = boxes.tolist()
    if hasattr(scores, "tolist"):
        scores = scores.tolist()
    if not boxes:
        return []

    sorted_pairs = sorted(zip(scores, boxes), key=lambda x: x[0], reverse=True)
    output = []
    for _, box in sorted_pairs[:expected_count]:
        normalized = _normalize_bbox(box, img_w, img_h)
        if normalized:
            output.append(normalized)

    logger.info(f"[CV DINO] Located {len(output)} instance(s) of '{object_name}'")
    return output
