# 3DAgent

An AI assistant for **Matterport 3D digital twins**. 3DAgent layers conversational AI and computer-vision asset scanning on top of a Matterport space so you can ask questions about a building, automatically detect and catalogue equipment, locate objects in 3D, and file maintenance reports pinned to real locations.

Built with Flask, the Matterport Showcase SDK, Groq LLMs, and on-device vision models (BLIP, YOLOv8, Grounding DINO).

---

## Features

- **Conversational agent (VLA)** — ask natural-language questions about a space; answers are grounded in the space's scanned assets and current view.
- **Automatic asset scanning** — YOLOv8 segmentation + (optional) Grounding DINO open-vocabulary detection catalogue equipment per area, with counts, bounding boxes and best camera angle.
- **Object location** — locate a single object or every instance of an asset and deep-link the viewer to the right sweep.
- **Maintenance reporting** — workers file issues pinned to a sweep/area; admins triage by severity and assign mechanics (`open → assigned → in_progress → resolved`).
- **Asset management** — manually mark, edit, and organise assets by location.
- **Exports** — per-space asset and location reports as CSV and PDF (including a floor-plan PDF).
- **Roles** — `worker` (reports issues) and `admin` (triages and assigns).

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Flask, Flask-SQLAlchemy, Flask-WTF |
| Database | SQLite (default) via SQLAlchemy |
| LLM | Groq (`llama-3.3-70b-versatile` by default) |
| Vision | BLIP (VQA), YOLOv8-seg, Grounding DINO — PyTorch / Transformers / Ultralytics |
| 3D viewer | Matterport Showcase SDK (vendored in `bundle/`) |

---

## Getting started

### Prerequisites

- Python 3.10+
- A [Groq API key](https://console.groq.com/)
- A [Matterport SDK key](https://matterport.com/) and a Matterport space SID
- ~3 GB free RAM (Grounding DINO is loaded lazily and is the heaviest model)

### 1. Clone and create a virtual environment

```bash
git clone https://github.com/Beckham0215/FYP_3DAgent.git
cd FYP_3DAgent
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure environment variables

Create a `.env` file in the project root (it is git-ignored):

```ini
SECRET_KEY=replace-with-a-random-string
GROQ_API_KEY=your-groq-api-key
GROQ_API_KEY_2=optional-second-key-for-rate-limit-fallback
GROQ_MODEL=llama-3.3-70b-versatile
MATTERPORT_SDK_KEY=your-matterport-sdk-key
```

### 4. Model weights

The YOLO weights (`yolov8s.pt`, `yolov8s-seg.pt`) are **not** committed to the repo. Ultralytics downloads them automatically on first use, or you can place them in the project root manually. Grounding DINO (`IDEA-Research/grounding-dino-base`) and BLIP download from Hugging Face on first run.

### 5. Run

```bash
python run.py
```

The app starts at **http://127.0.0.1:5000**. The SQLite database (`instance/3dagent.db`) and its schema are created automatically on first launch.

---

## Configuration

All settings are read from environment variables (see [`app/config.py`](app/config.py)). Notable options:

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq chat model |
| `CV_ENABLED` | `true` | Master switch for computer-vision features |
| `CV_YOLO_MODEL` | `yolov8s.pt` | YOLO weights to load |
| `CV_HYBRID_VOCAB` | `true` | Augment YOLO's 80 COCO classes with Grounding DINO open-vocabulary terms |
| `CV_YOLO_CONFIDENCE` | `0.35` | YOLO detection threshold |
| `CV_DINO_CONFIDENCE` | `0.25` | Grounding DINO detection threshold |
| `DATABASE_URL` | local SQLite | SQLAlchemy connection string |

See `app/config.py` for the full list of CV tuning knobs.

---

## Project structure

```
app/
  __init__.py        App factory, blueprint registration, lightweight migrations
  config.py          Environment-driven configuration
  models.py          SQLAlchemy models (User, Space, Asset, Maintenance, …)
  routes/            Blueprints: auth, main, api, maintenance
  services/          blip_service, cv_service, groq_service (lazy-loaded models)
bundle/              Vendored Matterport Showcase SDK (served at /bundle)
templates/           Jinja2 templates
static/              JS / CSS / images
eval/                Evaluation suite (see below)
run.py               Dev entrypoint (warms vision models, runs Flask)
```

## Evaluation

An evaluation suite lives in [`eval/`](eval/):

```bash
# Unit tests only (no external API calls)
python eval/run_eval.py

# Include Groq API-dependent tests
python eval/run_eval.py --integration

# Run a single evaluator and write an HTML report
python eval/run_eval.py --only label_match --output eval/eval_report.html
```

See [`eval/EVALUATION_REPORT.md`](eval/EVALUATION_REPORT.md) for results and methodology.

---

## Notes

- Vision models are loaded **lazily** and warmed in the worker process only; the first scan or chat after startup may take a few seconds.
- API endpoints use session auth with JSON bodies and are exempt from cookie CSRF; form-based pages use Flask-WTF CSRF protection.
- This project was developed as a Final Year Project.
