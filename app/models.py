from datetime import datetime

from app.extensions import db


class User(db.Model):
    __tablename__ = "user"

    user_id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)

    spaces = db.relationship("MatterportSpace", backref="owner", lazy=True)
    chat_logs = db.relationship("ChatHistoryLog", backref="user", lazy=True)


class MatterportSpace(db.Model):
    __tablename__ = "matterport_space"

    map_id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.user_id"), nullable=False, index=True)
    matterport_sid = db.Column(db.String(64), nullable=False)
    map_name = db.Column(db.String(200), nullable=False)
    created_date = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    assets = db.relationship("Asset", backref="space", lazy=True, cascade="all, delete-orphan")
    chat_logs = db.relationship("ChatHistoryLog", backref="space", lazy=True, cascade="all, delete-orphan")


class Asset(db.Model):
    __tablename__ = "assets"

    asset_id = db.Column(db.Integer, primary_key=True)
    map_id = db.Column(db.Integer, db.ForeignKey("matterport_space.map_id"), nullable=False, index=True)
    label_name = db.Column(db.String(200), nullable=False)
    sweep_uuid = db.Column(db.String(64), nullable=False)
    description = db.Column(db.Text)
    category = db.Column(db.String(100))


class ChatHistoryLog(db.Model):
    __tablename__ = "chat_history_logs"

    log_id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.user_id"), nullable=False, index=True)
    map_id = db.Column(db.Integer, db.ForeignKey("matterport_space.map_id"), nullable=False, index=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    user_prompt = db.Column(db.Text, nullable=False)
    ai_response = db.Column(db.Text, nullable=False)


class AssetsSummary(db.Model):
    __tablename__ = "assets_summary"

    id = db.Column(db.Integer, primary_key=True)
    map_id = db.Column(db.Integer, db.ForeignKey("matterport_space.map_id"), nullable=False, index=True)
    area_name = db.Column(db.String(200), nullable=True)
    asset_name = db.Column(db.String(100), nullable=False, index=True)
    count = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class ScanHistory(db.Model):
    __tablename__ = "scan_history"

    id = db.Column(db.Integer, primary_key=True)
    map_id = db.Column(db.Integer, db.ForeignKey("matterport_space.map_id"), nullable=False, index=True)
    area_name = db.Column(db.String(200), nullable=True, index=True)
    scanned_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    snapshot = db.Column(db.Text, nullable=False)  # JSON: {"chair": 3, "table": 1}
