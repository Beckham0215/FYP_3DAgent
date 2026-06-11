from datetime import datetime

from app.extensions import db


class User(db.Model):
    __tablename__ = "user"

    user_id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    # "worker" (default) reports issues; "admin" triages & assigns mechanics.
    role = db.Column(db.String(20), nullable=False, default="worker")

    spaces = db.relationship("MatterportSpace", backref="owner", lazy=True)
    chat_logs = db.relationship("ChatHistoryLog", backref="user", lazy=True)
    reports = db.relationship("MaintenanceReport", backref="reporter", lazy=True)


class MatterportSpace(db.Model):
    __tablename__ = "matterport_space"

    map_id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.user_id"), nullable=False, index=True)
    matterport_sid = db.Column(db.String(64), nullable=False)
    map_name = db.Column(db.String(200), nullable=False)
    created_date = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    assets = db.relationship("Asset", backref="space", lazy=True, cascade="all, delete-orphan")
    chat_logs = db.relationship("ChatHistoryLog", backref="space", lazy=True, cascade="all, delete-orphan")
    reports = db.relationship("MaintenanceReport", backref="space", lazy=True, cascade="all, delete-orphan")


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
    sweep_uuid = db.Column(db.String(64), nullable=True)
    serial_number = db.Column(db.Integer, nullable=True, default=1)  # 1-indexed per asset_name per area
    bbox_json = db.Column(db.Text, nullable=True)    # JSON: [x1,y1,x2,y2] normalised 0-1
    best_angle = db.Column(db.Float, nullable=True)  # absolute camera yaw in degrees
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)


class ScanHistory(db.Model):
    __tablename__ = "scan_history"

    id = db.Column(db.Integer, primary_key=True)
    map_id = db.Column(db.Integer, db.ForeignKey("matterport_space.map_id"), nullable=False, index=True)
    area_name = db.Column(db.String(200), nullable=True, index=True)
    scanned_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    snapshot = db.Column(db.Text, nullable=False)  # JSON: {"chair": 3, "table": 1}


class MaintenanceReport(db.Model):
    """A worker-filed maintenance issue pinned to a location in a space.

    Lifecycle: open → assigned (mechanic set) → in_progress → resolved.
    Triage is driven by `severity` (low / medium / high / critical).
    """

    __tablename__ = "maintenance_reports"

    SEVERITIES = ("low", "medium", "high", "critical")
    STATUSES = ("open", "assigned", "in_progress", "resolved")

    id = db.Column(db.Integer, primary_key=True)
    map_id = db.Column(db.Integer, db.ForeignKey("matterport_space.map_id"), nullable=False, index=True)

    # Where in the space the issue is — sweep_uuid lets the viewer deep-link to it.
    sweep_uuid = db.Column(db.String(64), nullable=True)
    area_name = db.Column(db.String(200), nullable=True)

    equipment_name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    severity = db.Column(db.String(20), nullable=False, default="medium", index=True)
    status = db.Column(db.String(20), nullable=False, default="open", index=True)

    reported_by = db.Column(db.Integer, db.ForeignKey("user.user_id"), nullable=True, index=True)
    reporter_name = db.Column(db.String(80), nullable=True)  # snapshot, survives user deletion

    assigned_to = db.Column(db.String(120), nullable=True)   # mechanic name
    assigned_at = db.Column(db.DateTime, nullable=True)
    resolved_at = db.Column(db.DateTime, nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
