"""Maintenance reporting system.

Workers pin a problem to a location in a space (via the 3D viewer); this
blueprint is the admin/triage side — a prioritised report list where issues
are ranked by severity, mechanics get assigned, and status is tracked through
to resolution.

Roles:
  * ``admin``  — sees every report, can assign mechanics and change status.
  * ``worker`` — sees the reports they filed.

Bootstrap rule: until at least one admin account exists, any logged-in user
may manage reports, so the system is usable straight away on a fresh install.
"""
from datetime import datetime

from flask import (
    Blueprint, flash, redirect, render_template, request, session, url_for,
)

from app.extensions import db
from app.models import MaintenanceReport, MatterportSpace, User
from app.routes.auth import login_required

bp = Blueprint("maintenance", __name__)

SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}


# ── role / permission helpers ────────────────────────────────────────────────

def _current_user():
    uid = session.get("user_id")
    return db.session.get(User, uid) if uid else None


def _is_admin():
    user = _current_user()
    return bool(user and (user.role or "worker") == "admin")


def _admin_exists():
    return db.session.query(
        User.query.filter_by(role="admin").exists()
    ).scalar()


def _can_manage():
    """Admins always manage; before any admin exists, everyone can (bootstrap)."""
    return _is_admin() or not _admin_exists()


def _scoped_reports_query():
    """All reports for admins, otherwise just the current user's own."""
    q = MaintenanceReport.query
    if not _is_admin():
        q = q.filter(MaintenanceReport.reported_by == session.get("user_id"))
    return q


# ── sidebar badge (open-report count) injected into every template ───────────

@bp.app_context_processor
def inject_maintenance_context():
    if not session.get("user_id"):
        return {}
    try:
        open_count = _scoped_reports_query().filter(
            MaintenanceReport.status != "resolved"
        ).count()
    except Exception:
        # Table may not exist yet on a brand-new DB mid-migration.
        open_count = 0
    return {
        "maintenance_open_count": open_count,
        "maintenance_can_manage": _can_manage(),
        "maintenance_is_admin": _is_admin(),
    }


# ── pages ────────────────────────────────────────────────────────────────────

@bp.route("/maintenance")
@login_required
def maintenance():
    status_filter = (request.args.get("status") or "").strip().lower()
    severity_filter = (request.args.get("severity") or "").strip().lower()

    base_q = _scoped_reports_query()

    # Counts for the header stats / filter chips (computed before filtering).
    all_reports = base_q.all()
    stats = {
        "total": len(all_reports),
        "open": sum(1 for r in all_reports if r.status == "open"),
        "assigned": sum(1 for r in all_reports if r.status in ("assigned", "in_progress")),
        "resolved": sum(1 for r in all_reports if r.status == "resolved"),
        "critical": sum(1 for r in all_reports if r.severity == "critical" and r.status != "resolved"),
        "high": sum(1 for r in all_reports if r.severity == "high" and r.status != "resolved"),
    }

    reports = all_reports
    if status_filter in MaintenanceReport.STATUSES:
        reports = [r for r in reports if r.status == status_filter]
    if severity_filter in SEVERITY_RANK:
        reports = [r for r in reports if r.severity == severity_filter]

    # Priority order: unresolved first, then severity desc, then newest first.
    reports.sort(
        key=lambda r: (
            r.status == "resolved",
            -SEVERITY_RANK.get(r.severity, 2),
            -(r.created_at or datetime.min).timestamp(),
        )
    )

    # Resolve space names for display (avoid N+1).
    map_ids = {r.map_id for r in all_reports}
    spaces = {
        s.map_id: s
        for s in MatterportSpace.query.filter(MatterportSpace.map_id.in_(map_ids)).all()
    } if map_ids else {}

    return render_template(
        "maintenance.html",
        reports=reports,
        spaces=spaces,
        stats=stats,
        status_filter=status_filter,
        severity_filter=severity_filter,
        can_manage=_can_manage(),
        is_admin=_is_admin(),
    )


# ── management actions (admin / bootstrap) ───────────────────────────────────

def _guard_manage():
    if not _can_manage():
        flash("Only admins can manage maintenance reports.", "danger")
        return False
    return True


@bp.route("/maintenance/<int:report_id>/assign", methods=["POST"])
@login_required
def assign_report(report_id):
    if not _guard_manage():
        return redirect(url_for("maintenance.maintenance"))
    report = MaintenanceReport.query.get_or_404(report_id)
    mechanic = (request.form.get("assigned_to") or "").strip()
    if not mechanic:
        flash("Enter a mechanic name to assign.", "warning")
        return redirect(url_for("maintenance.maintenance"))
    report.assigned_to = mechanic
    report.assigned_at = datetime.utcnow()
    if report.status == "open":
        report.status = "assigned"
    db.session.commit()
    flash(f"Assigned to {mechanic}.", "success")
    return redirect(url_for("maintenance.maintenance"))


@bp.route("/maintenance/<int:report_id>/status", methods=["POST"])
@login_required
def update_status(report_id):
    if not _guard_manage():
        return redirect(url_for("maintenance.maintenance"))
    report = MaintenanceReport.query.get_or_404(report_id)
    new_status = (request.form.get("status") or "").strip().lower()
    if new_status not in MaintenanceReport.STATUSES:
        flash("Unknown status.", "danger")
        return redirect(url_for("maintenance.maintenance"))
    report.status = new_status
    report.resolved_at = datetime.utcnow() if new_status == "resolved" else None
    db.session.commit()
    flash("Report status updated.", "success")
    return redirect(url_for("maintenance.maintenance"))


@bp.route("/maintenance/<int:report_id>/delete", methods=["POST"])
@login_required
def delete_report(report_id):
    report = MaintenanceReport.query.get_or_404(report_id)
    # Managers can delete anything; otherwise only the original reporter.
    if not (_can_manage() or report.reported_by == session.get("user_id")):
        flash("You can only delete your own reports.", "danger")
        return redirect(url_for("maintenance.maintenance"))
    db.session.delete(report)
    db.session.commit()
    flash("Report deleted.", "success")
    return redirect(url_for("maintenance.maintenance"))
