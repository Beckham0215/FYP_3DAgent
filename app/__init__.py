import os

from dotenv import load_dotenv
from flask import Flask

from app.extensions import db


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
        import os
        from flask import send_file
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

    from app.routes import api, auth, main

    app.register_blueprint(auth.bp)
    app.register_blueprint(main.bp)
    app.register_blueprint(api.bp)

    with app.app_context():
        db.create_all()

    return app
