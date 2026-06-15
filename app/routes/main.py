import csv
import io
from collections import defaultdict
from datetime import datetime
import os
from flask import Blueprint, Response, current_app, flash, redirect, render_template, request, session, url_for

from app.extensions import db
from app.models import Asset, AssetsSummary, MatterportSpace
from app.routes.auth import login_required

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    if session.get("user_id"):
        return redirect(url_for("main.dashboard"))
    return redirect(url_for("auth.login"))


@bp.route("/dashboard")
@login_required
def dashboard():
    uid = session["user_id"]
    spaces = MatterportSpace.query.filter_by(user_id=uid).order_by(MatterportSpace.created_date.desc()).all()
    if not spaces:
        return render_template("dashboard.html", spaces=[], space_stats={})

    map_ids = [s.map_id for s in spaces]

    # One query for all assets (tagged locations + categories)
    all_assets = Asset.query.filter(Asset.map_id.in_(map_ids)).all()
    assets_by_space = defaultdict(list)
    for a in all_assets:
        assets_by_space[a.map_id].append(a)

    # One aggregated query for inventory stats (total items, distinct areas, latest scan)
    summary_rows = (
        db.session.query(
            AssetsSummary.map_id,
            db.func.sum(AssetsSummary.count).label("total_items"),
            db.func.count(db.func.distinct(AssetsSummary.area_name)).label("scanned_areas"),
            db.func.max(AssetsSummary.created_at).label("last_scanned"),
        )
        .filter(AssetsSummary.map_id.in_(map_ids))
        .group_by(AssetsSummary.map_id)
        .all()
    )
    summary_by_space = {r.map_id: r for r in summary_rows}

    space_stats = {}
    for space in spaces:
        assets_all = assets_by_space.get(space.map_id, [])
        categories = sorted({a.category for a in assets_all if a.category})
        summary = summary_by_space.get(space.map_id)
        space_stats[space.map_id] = {
            "tagged_count": len(assets_all),
            "categories": categories,
            "total_items": int(summary.total_items or 0) if summary else 0,
            "scanned_areas": summary.scanned_areas if summary else 0,
            "last_scanned": summary.last_scanned if summary else None,
        }

    return render_template("dashboard.html", spaces=spaces, space_stats=space_stats)


@bp.route("/spaces/new", methods=["GET", "POST"])
@login_required
def new_space():
    if request.method == "POST":
        sid = (request.form.get("matterport_sid") or "").strip()
        name = (request.form.get("map_name") or "").strip() or "My space"
        if not sid:
            flash("Matterport Space ID (SID) is required.", "danger")
            return render_template("space_form.html")
        space = MatterportSpace(
            user_id=session["user_id"],
            matterport_sid=sid,
            map_name=name,
            created_date=datetime.utcnow(),
        )
        db.session.add(space)
        db.session.commit()
        flash("Space saved. Open the viewer to connect the SDK.", "success")
        return redirect(url_for("main.dashboard"))
    return render_template("space_form.html")


@bp.route("/spaces/<int:map_id>/viewer")
@login_required
def viewer(map_id):
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    sdk_key = current_app.config.get("MATTERPORT_SDK_KEY", "")
    assets = Asset.query.filter_by(map_id=map_id).all()
    return render_template(
        "viewer.html",
        space=space,
        matterport_sdk_key=sdk_key,
        assets=assets,
    )


@bp.route("/spaces/<int:map_id>/locations", methods=["GET", "POST"])
@login_required
def manage_locations(map_id):
    """Navigation locations (tagged sweeps) — separate from scanned assets."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    if request.method == "POST":
        label = (request.form.get("label_name") or "").strip()
        sweep = (request.form.get("sweep_uuid") or "").strip()
        desc = (request.form.get("description") or "").strip()
        cat = (request.form.get("category") or "").strip()
        if not label or not sweep:
            flash("Location name and Sweep UUID are required.", "danger")
        else:
            db.session.add(Asset(
                map_id=map_id,
                label_name=label,
                sweep_uuid=sweep,
                description=desc or None,
                category=cat or None,
            ))
            db.session.commit()
            flash("Location added.", "success")
        return redirect(url_for("main.manage_locations", map_id=map_id))

    assets = (
        Asset.query.filter_by(map_id=map_id)
        .order_by(Asset.category.asc(), Asset.label_name.asc())
        .all()
    )
    return render_template("locations.html", space=space, assets=assets)


@bp.route("/spaces/<int:map_id>/assets")
@login_required
def manage_assets(map_id):
    """Scanned asset inventory only — locations live on the Locations page."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    asset_summaries = _ordered_summaries(map_id)
    summary_locations = sorted(
        {(row.area_name or "Unspecified Area").strip() for row in asset_summaries if (row.area_name or "Unspecified Area").strip()}
    )
    return render_template(
        "assets.html",
        space=space,
        asset_summaries=asset_summaries,
        summary_locations=summary_locations,
    )


@bp.route("/spaces/<int:map_id>/scanned-assets/<int:summary_id>/edit", methods=["GET", "POST"])
@login_required
def edit_scanned_asset(map_id, summary_id):
    """Edit scanned asset summary row."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()

    row = AssetsSummary.query.filter_by(id=summary_id, map_id=map_id).first_or_404()
    if request.method == "GET":
        return render_template("edit_scanned_asset.html", space=space, row=row)

    area_name = (request.form.get("area_name") or "").strip()
    asset_name = (request.form.get("asset_name") or "").strip().lower()
    count_raw = (request.form.get("count") or "").strip()

    if not asset_name:
        flash("Asset name is required for scanned asset row.", "danger")
        return redirect(url_for("main.manage_assets", map_id=map_id))

    try:
        count_val = int(count_raw)
        if count_val < 0:
            raise ValueError("count must be non-negative")
    except (TypeError, ValueError):
        flash("Count must be a non-negative integer.", "danger")
        return redirect(url_for("main.manage_assets", map_id=map_id))

    row.area_name = area_name or None
    row.asset_name = asset_name
    row.count = count_val
    db.session.commit()
    flash("Scanned asset updated.", "success")
    return redirect(url_for("main.manage_assets", map_id=map_id))


@bp.route("/spaces/<int:map_id>/scanned-assets/<int:summary_id>/delete", methods=["POST"])
@login_required
def delete_scanned_asset(map_id, summary_id):
    """Delete scanned asset summary row."""
    uid = session["user_id"]
    MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()

    row = AssetsSummary.query.filter_by(id=summary_id, map_id=map_id).first_or_404()
    db.session.delete(row)
    db.session.commit()
    flash("Scanned asset deleted.", "success")
    return redirect(url_for("main.manage_assets", map_id=map_id))


@bp.route("/spaces/<int:map_id>/scanned-assets/delete-room", methods=["POST"])
@login_required
def delete_scanned_assets_by_room(map_id):
    """Delete all scanned asset rows for a specific room/location."""
    uid = session["user_id"]
    MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()

    area_name = (request.form.get("area_name") or "").strip() or None
    rows = AssetsSummary.query.filter_by(map_id=map_id, area_name=area_name).all()
    count = len(rows)
    for row in rows:
        db.session.delete(row)
    db.session.commit()
    label = area_name or "Unspecified"
    flash(f"Deleted {count} asset record(s) from '{label}'.", "success")
    return redirect(url_for("main.manage_assets", map_id=map_id))


@bp.route("/spaces/<int:map_id>/scanned-assets/delete-all", methods=["POST"])
@login_required
def delete_all_scanned_assets(map_id):
    """Delete every scanned asset record for this space."""
    uid = session["user_id"]
    MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()

    count = AssetsSummary.query.filter_by(map_id=map_id).delete()
    db.session.commit()
    flash(f"Deleted all {count} scanned asset record(s) from this space.", "success")
    return redirect(url_for("main.manage_assets", map_id=map_id))


@bp.route("/spaces/<int:map_id>/assets/<int:asset_id>/delete", methods=["POST"])
@login_required
def delete_asset(map_id, asset_id):
    """Delete an asset from the management page."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()

    asset = Asset.query.filter_by(asset_id=asset_id, map_id=map_id).first_or_404()
    asset_name = asset.label_name

    db.session.delete(asset)
    db.session.commit()
    flash(f"Location '{asset_name}' deleted successfully.", "success")

    return redirect(url_for("main.manage_locations", map_id=map_id))


@bp.route("/spaces/<int:map_id>/locations/delete-all", methods=["POST"])
@login_required
def delete_all_locations(map_id):
    """Delete every tagged navigation location for this space."""
    uid = session["user_id"]
    MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()

    count = Asset.query.filter_by(map_id=map_id).delete()
    db.session.commit()
    flash(f"Deleted all {count} location(s) from this space.", "success")
    return redirect(url_for("main.manage_locations", map_id=map_id))


@bp.route("/spaces/<int:map_id>/assets/<int:asset_id>/edit", methods=["GET", "POST"])
@login_required
def edit_asset(map_id, asset_id):
    """Edit an asset."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    asset = Asset.query.filter_by(asset_id=asset_id, map_id=map_id).first_or_404()
    
    if request.method == "POST":
        label = (request.form.get("label_name") or "").strip()
        sweep = (request.form.get("sweep_uuid") or "").strip()
        desc = (request.form.get("description") or "").strip()
        cat = (request.form.get("category") or "").strip()
        
        if not label or not sweep:
            flash("Label name and Sweep UUID are required.", "danger")
        else:
            asset.label_name = label
            asset.sweep_uuid = sweep
            asset.description = desc or None
            asset.category = cat or None
            db.session.commit()
            flash(f"Location '{label}' updated successfully.", "success")
            return redirect(url_for("main.manage_locations", map_id=map_id))

    return render_template("edit_asset.html", space=space, asset=asset)


@bp.route("/spaces/<int:map_id>/delete", methods=["POST"])
@login_required
def delete_space(map_id):
    """Delete a space from the dashboard."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    
    space_name = space.map_name

    db.session.delete(space)
    db.session.commit()
    flash(f"Space '{space_name}' deleted successfully.", "success")

    return redirect(url_for("main.dashboard"))


@bp.route("/export")
@login_required
def export_hub():
    """Export center — pick any space and download its locations or assets."""
    uid = session["user_id"]
    spaces = (
        MatterportSpace.query.filter_by(user_id=uid)
        .order_by(MatterportSpace.map_name.asc())
        .all()
    )
    map_ids = [s.map_id for s in spaces]
    loc_counts, asset_counts = {}, {}
    if map_ids:
        for mid, cnt in (
            db.session.query(Asset.map_id, db.func.count(Asset.asset_id))
            .filter(Asset.map_id.in_(map_ids)).group_by(Asset.map_id).all()
        ):
            loc_counts[mid] = cnt
        for mid, total in (
            db.session.query(AssetsSummary.map_id, db.func.sum(AssetsSummary.count))
            .filter(AssetsSummary.map_id.in_(map_ids)).group_by(AssetsSummary.map_id).all()
        ):
            asset_counts[mid] = int(total or 0)
    return render_template(
        "export.html", spaces=spaces, loc_counts=loc_counts, asset_counts=asset_counts
    )


def _ordered_summaries(map_id):
    return (
        AssetsSummary.query.filter_by(map_id=map_id)
        .order_by(
            AssetsSummary.area_name.asc(),
            AssetsSummary.asset_name.asc(),
            AssetsSummary.serial_number.asc(),
        )
        .all()
    )


def _instance_rows(summaries):
    """Yield (area, display_name, count, created_at) for each scanned row using
    the per-instance serial numbers exactly as stored in the database — e.g.
    "Chair #1", "Chair #2" — so exports match the asset list, not an aggregate."""
    counters = {}
    rows = []
    for row in summaries:
        area = row.area_name or "Unspecified"
        name = (row.asset_name or "item").strip()
        key = (area, name.lower())
        counters[key] = counters.get(key, 0) + 1
        serial = row.serial_number or counters[key]   # fall back for legacy rows
        rows.append((area, f"{name.title()} #{serial}", row.count, row.created_at))
    return rows


@bp.route("/spaces/<int:map_id>/export/csv")
@login_required
def export_csv(map_id):
    """Export scanned asset inventory as CSV (per-instance: Chair #1, Chair #2…)."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    summaries = _ordered_summaries(map_id)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Space", "Room / Area", "Asset", "Count", "Recorded Date"])
    for area, display, count, created in _instance_rows(summaries):
        writer.writerow([
            space.map_name,
            area,
            display,
            count,
            created.strftime("%Y-%m-%d %H:%M") if created else "",
        ])
    filename = f"assets_{space.map_name}_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@bp.route("/spaces/<int:map_id>/export/pdf")
@login_required
def export_pdf(map_id):
    """Export scanned asset inventory as PDF (per-instance: Chair #1, Chair #2…)."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    summaries = _ordered_summaries(map_id)

    try:
        from fpdf import FPDF

        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 16)
        pdf.cell(0, 10, "3DAgent - Asset Inventory Report", ln=True, align="C")
        pdf.set_font("Helvetica", "", 11)
        pdf.cell(0, 7, f"Space: {space.map_name}", ln=True, align="C")
        pdf.cell(0, 7, f"Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC", ln=True, align="C")
        pdf.ln(6)

        # Table header
        pdf.set_fill_color(30, 30, 30)
        pdf.set_text_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 10)
        col_w = [55, 75, 30, 30]
        headers = ["Room / Area", "Asset", "Count", "Date"]
        for i, h in enumerate(headers):
            pdf.cell(col_w[i], 8, h, border=1, fill=True)
        pdf.ln()

        # Table rows — one per stored instance (Chair #1, Chair #2, …)
        pdf.set_text_color(0, 0, 0)
        pdf.set_font("Helvetica", "", 10)
        fill = False
        last_area = None
        for area, display, count, created in _instance_rows(summaries):
            if area != last_area:
                fill = not fill
                last_area = area
            pdf.set_fill_color(240, 248, 240) if fill else pdf.set_fill_color(255, 255, 255)
            date_str = created.strftime("%Y-%m-%d") if created else ""
            for val, w in zip([area, display, str(count), date_str], col_w):
                pdf.cell(w, 7, val, border=1, fill=True)
            pdf.ln()

        pdf_bytes = pdf.output()
        filename = f"assets_{space.map_name}_{datetime.utcnow().strftime('%Y%m%d')}.pdf"
        return Response(
            bytes(pdf_bytes),
            mimetype="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ImportError:
        flash("PDF export requires fpdf2. Run: pip install fpdf2", "danger")
        return redirect(url_for("main.manage_assets", map_id=map_id))


@bp.route("/spaces/<int:map_id>/export/locations.csv")
@login_required
def export_locations_csv(map_id):
    """Export tagged navigation locations as CSV."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    assets = (
        Asset.query.filter_by(map_id=map_id)
        .order_by(Asset.category.asc(), Asset.label_name.asc())
        .all()
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Space", "Location Name", "Category", "Sweep UUID", "Description"])
    for a in assets:
        writer.writerow([
            space.map_name,
            a.label_name,
            a.category or "",
            a.sweep_uuid or "",
            a.description or "",
        ])
    filename = f"locations_{space.map_name}_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@bp.route("/spaces/<int:map_id>/export/locations.pdf")
@login_required
def export_locations_pdf(map_id):
    """Export tagged navigation locations as PDF."""
    uid = session["user_id"]
    space = MatterportSpace.query.filter_by(map_id=map_id, user_id=uid).first_or_404()
    assets = (
        Asset.query.filter_by(map_id=map_id)
        .order_by(Asset.category.asc(), Asset.label_name.asc())
        .all()
    )

    try:
        from fpdf import FPDF

        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 16)
        pdf.cell(0, 10, "3DAgent - Navigation Locations", ln=True, align="C")
        pdf.set_font("Helvetica", "", 11)
        pdf.cell(0, 7, f"Space: {space.map_name}", ln=True, align="C")
        pdf.cell(0, 7, f"Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC", ln=True, align="C")
        pdf.ln(6)

        pdf.set_fill_color(30, 30, 30)
        pdf.set_text_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 10)
        col_w = [55, 45, 55, 35]
        for i, h in enumerate(["Location Name", "Category", "Sweep UUID", "Notes"]):
            pdf.cell(col_w[i], 8, h, border=1, fill=True)
        pdf.ln()

        pdf.set_text_color(0, 0, 0)
        pdf.set_font("Helvetica", "", 9)
        fill = False
        last_cat = None
        for a in assets:
            cat = a.category or "Uncategorized"
            if cat != last_cat:
                fill = not fill
                last_cat = cat
            pdf.set_fill_color(240, 248, 240) if fill else pdf.set_fill_color(255, 255, 255)
            uuid_short = (a.sweep_uuid or "")[:18]
            notes = (a.description or "")[:24]
            for val, w in zip([a.label_name, cat, uuid_short, notes], col_w):
                pdf.cell(w, 7, str(val), border=1, fill=True)
            pdf.ln()

        pdf_bytes = pdf.output()
        filename = f"locations_{space.map_name}_{datetime.utcnow().strftime('%Y%m%d')}.pdf"
        return Response(
            bytes(pdf_bytes),
            mimetype="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ImportError:
        flash("PDF export requires fpdf2. Run: pip install fpdf2", "danger")
        return redirect(url_for("main.manage_assets", map_id=map_id))


@bp.route("/quick-tips")
def quick_tips():
    """Display Quick Tips and User Manual page."""
    return render_template("quick_tips.html")
