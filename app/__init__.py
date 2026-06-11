import os
import logging

from dotenv import load_dotenv
from flask import Flask, send_file

from app.extensions import db, csrf

logger = logging.getLogger(__name__)


def create_app():
    load_dotenv(override=True)
    base = os.path.dirname(os.path.dirname(__file__))  # FYP2_Codes folder
    instance = os.path.join(base, "instance")
    bundle = os.path.join(base, "bundle")  # FYP2_Codes/bundle
    os.makedirs(instance, exist_ok=True)

    app = Flask(
        __name__,
        template_folder=os.path.join(base, "templates"),
        static_folder=os.path.join(base, "static"),
        instance_path=instance,
    )

    # Add bundle folder as a static folder accessible at /bundle
    app.static_folder_bundle = os.path.abspath(bundle)

    @app.route("/bundle/<path:filename>")
    def serve_bundle(filename):
        """Serve files from the /bundle folder"""
        file_path = os.path.join(app.static_folder_bundle, filename)

        # Security check
        if not os.path.abspath(file_path).startswith(os.path.abspath(app.static_folder_bundle)):
            return "Forbidden", 403
        if not os.path.exists(file_path):
            return "Not Found", 404
        if os.path.isdir(file_path):
            return "Forbidden", 403

        return send_file(file_path)

    app.config.from_object("app.config.Config")

    db.init_app(app)
    csrf.init_app(app)

    from app.routes import api, auth, main, maintenance

    app.register_blueprint(auth.bp)
    app.register_blueprint(main.bp)
    app.register_blueprint(api.bp)
    app.register_blueprint(maintenance.bp)

    # API endpoints use session auth + JSON bodies; exempt from cookie-based CSRF.
    csrf.exempt(api.bp)

    with app.app_context():
        db.create_all()
        # Migrate columns added after the initial schema for existing databases.
        # db.create_all() already handles these for fresh installs.
        _MIGRATION_DDLS = [
            "ALTER TABLE assets_summary ADD COLUMN sweep_uuid VARCHAR(64)",
            "ALTER TABLE assets_summary ADD COLUMN bbox_json TEXT",
            "ALTER TABLE assets_summary ADD COLUMN best_angle REAL",
            "ALTER TABLE assets_summary ADD COLUMN serial_number INTEGER DEFAULT 1",
            "ALTER TABLE user ADD COLUMN role VARCHAR(20) DEFAULT 'worker'",
        ]
        for _ddl in _MIGRATION_DDLS:
            try:
                with db.engine.connect() as conn:
                    conn.execute(db.text(_ddl))
                    conn.commit()
            except Exception as e:
                msg = str(e).lower()
                # SQLite: "duplicate column name" / "already has column"
                if "duplicate column" in msg or "already has column" in msg:
                    pass  # expected for databases that already have the column
                else:
                    logger.warning("Schema migration DDL failed unexpectedly: %s — %s", _ddl, e)

    # NOTE: heavy vision models (BLIP, YOLO, Grounding DINO) are NOT preloaded
    # here. Under the Werkzeug debug reloader create_app() runs in both the
    # watcher and the worker, so preloading here would load every model twice
    # and can exhaust the Windows commit limit (paging-file "os error 1455").
    # The dev entrypoint (run.py) warms the models in the worker process only;
    # the lazy loaders inside each service cover production (single process).

    return app
