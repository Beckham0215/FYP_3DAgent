import base64
import threading
from io import BytesIO

from PIL import Image
import torch
from transformers import BlipProcessor, BlipForQuestionAnswering

_lock = threading.Lock()
_processor = None
_model = None
_device = None


def _load_model():
    global _processor, _model, _device
    with _lock:
        if _model is None:
            _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            name = "Salesforce/blip-vqa-base"
            _processor = BlipProcessor.from_pretrained(name)
            _model = BlipForQuestionAnswering.from_pretrained(name)
            _model.to(_device)
            _model.eval()


def answer_visual_question(image_b64: str, question: str) -> str:
    """
    image_b64: raw base64 or data URL (data:image/jpeg;base64,...)
    """
    _load_model()
    raw = image_b64
    if "," in raw and raw.strip().startswith("data:"):
        raw = raw.split(",", 1)[1]
    image_bytes = base64.b64decode(raw)
    image = Image.open(BytesIO(image_bytes)).convert("RGB")

    inputs = _processor(image, question, return_tensors="pt")
    inputs = {k: v.to(_device) for k, v in inputs.items()}
    with torch.no_grad():
        out = _model.generate(**inputs, max_length=50)
    text = _processor.decode(out[0], skip_special_tokens=True).strip()
    return text or "(no answer)"
