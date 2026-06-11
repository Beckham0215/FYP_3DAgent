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
}

_EXCLUDE_CLASSES = frozenset({
    "person", "cat", "dog", "bird", "car", "truck", "bus",
    "motorcycle", "bicycle", "airplane", "boat", "train",
})


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


def segment_object_in_image(image_b64: str, object_name: str, bbox_hint=None) -> dict | None:
    """Return a tight polygon outline (normalised 0-1) hugging the edges of the
    best-matching instance of ``object_name`` in the image, using YOLOv8-seg
    masks. ``bbox_hint`` (normalised x1,y1,x2,y2) disambiguates which instance to
    pick when several are visible. Returns None if segmentation is unavailable or
    no matching object is found — callers fall back to the bounding box.
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

    hint_cx = hint_cy = None
    if bbox_hint and len(bbox_hint) == 4:
        hint_cx = (bbox_hint[0] + bbox_hint[2]) / 2.0
        hint_cy = (bbox_hint[1] + bbox_hint[3]) / 2.0

    best = None  # (key, polygon_norm, bbox_norm, score)
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
            if hint_cx is not None:
                cx = (bbox_norm[0] + bbox_norm[2]) / 2.0
                cy = (bbox_norm[1] + bbox_norm[3]) / 2.0
                key = -((cx - hint_cx) ** 2 + (cy - hint_cy) ** 2)  # nearer instance wins
            else:
                key = score
            if best is None or key > best[0]:
                best = (key, npts, bbox_norm, score)

    if best is None:
        return None

    _, npts, bbox_norm, score = best
    if len(npts) > 80:  # keep the payload light
        step = (len(npts) + 79) // 80
        npts = npts[::step]
    npts = [[round(x, 4), round(y, 4)] for x, y in npts]
    bbox_norm = [round(v, 4) for v in bbox_norm]
    logger.info(f"[CV SEG] outline for {object_name!r}: {len(npts)} pts (score {score:.2f})")
    return {"polygon": npts, "bbox": bbox_norm, "score": round(score, 3)}


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


def _run_dino(image: Image.Image, text: str) -> dict:
    img_w, img_h = image.size
    box_thresh  = _get_config("CV_DINO_CONFIDENCE",     0.25)
    text_thresh = _get_config("CV_DINO_TEXT_THRESHOLD",  0.25)

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


def detect_objects_with_boxes(image_b64: str, area_context: str | None = None) -> dict:
    """Single YOLO pass returning counts plus EVERY instance's box per class.

    Returns {
        "counts":    {name: int},
        "boxes":     {name: [x1,y1,x2,y2]},          # most prominent box (instance #1)
        "boxes_all": {name: [[x1,y1,x2,y2], ...]},   # all instances, prominent-first
    }
    All boxes are normalised 0-1. boxes_all powers per-instance audit/highlight;
    boxes (the first/largest) is the default single highlight.
    """
    if not image_b64:
        return {"counts": {}, "boxes": {}, "boxes_all": {}}
    _load_yolo()
    image = _decode_image(image_b64)
    img_w, img_h = image.size
    conf = _get_config("CV_YOLO_CONFIDENCE", 0.35)
    with torch.no_grad():
        results = _yolo_model(image, conf=conf, verbose=False)

    counts: dict = {}
    # name -> list of (area, bbox) so we can rank instances by prominence
    collected: dict = {}
    for r in results:
        for box in r.boxes:
            raw_label = _yolo_model.names[int(box.cls)]
            label = _normalize_label(raw_label)
            if label in _EXCLUDE_CLASSES:
                continue
            counts[label] = counts.get(label, 0) + 1
            nb = _normalize_bbox(box.xyxy[0].tolist(), img_w, img_h)
            if nb:
                area = (nb[2] - nb[0]) * (nb[3] - nb[1])
                collected.setdefault(label, []).append((area, nb))

    boxes: dict = {}
    boxes_all: dict = {}
    for label, items in collected.items():
        items.sort(key=lambda t: t[0], reverse=True)  # largest/closest first
        ordered = [bbox for _, bbox in items]
        boxes_all[label] = ordered
        boxes[label] = ordered[0]
    logger.info(f"[CV YOLO] Detected: {counts}")
    return {"counts": counts, "boxes": boxes, "boxes_all": boxes_all}


def detect_objects_from_image(image_b64: str, area_context: str | None = None) -> dict:
    return detect_objects_with_boxes(image_b64, area_context)["counts"]


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
