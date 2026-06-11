import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    # Warm the vision models in the background, but only in the reloader's worker
    # process (WERKZEUG_RUN_MAIN == "true"). The watcher parent skips this so the
    # models are not loaded twice. Grounding DINO (~2 GB resident) stays lazy to
    # keep the startup memory spike small on low-RAM machines.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        from app.services import blip_service, cv_service
        blip_service.preload()
        cv_service.preload_yolo_only()

    # Exclude the virtualenv from the reloader's watch list. Otherwise the stat
    # reloader watches torch/transformers files inside .venv and triggers a
    # restart (re-importing torch under memory pressure → "DLL load failed").
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True,
        exclude_patterns=[os.path.join(os.path.dirname(__file__), ".venv", "*")],
    )
