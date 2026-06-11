import os


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-change-me-in-production")
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL",
        "sqlite:///" + os.path.join(os.path.dirname(os.path.dirname(__file__)), "instance", "3dagent.db"),
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    WTF_CSRF_ENABLED = True
    GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
    GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    MATTERPORT_SDK_KEY = os.environ.get("MATTERPORT_SDK_KEY", "")

    # CV model settings
    CV_ENABLED            = os.environ.get("CV_ENABLED", "true").lower() != "false"
    CV_YOLO_MODEL         = os.environ.get("CV_YOLO_MODEL", "yolov8s.pt")
    CV_MODELS_DIR         = os.environ.get("CV_MODELS_DIR", "")
    CV_DINO_MODEL         = os.environ.get("CV_DINO_MODEL", "IDEA-Research/grounding-dino-base")
    CV_YOLO_CONFIDENCE    = float(os.environ.get("CV_YOLO_CONFIDENCE", "0.35"))
    CV_DINO_CONFIDENCE    = float(os.environ.get("CV_DINO_CONFIDENCE", "0.25"))
    CV_DINO_TEXT_THRESHOLD = float(os.environ.get("CV_DINO_TEXT_THRESHOLD", "0.25"))
    CV_FALLBACK_TO_SCOUT  = os.environ.get("CV_FALLBACK_TO_SCOUT", "true").lower() != "false"
