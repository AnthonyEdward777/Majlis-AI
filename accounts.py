"""Login, first-run setup, role-based access (Admin / Executive / Normal User), teams, and the reports API."""

import os
import secrets
from functools import wraps
from pathlib import Path

from flask import Blueprint, Response, abort, g, jsonify, redirect, render_template, request, session, url_for
from psycopg import errors
from werkzeug.security import check_password_hash, generate_password_hash

from db import audit, connect
from docx_export import build_docx
from insights import generate_insights

bp = Blueprint("accounts", __name__)

ADMIN, EXECUTIVE, NORMAL = 1, 2, 3  # roles.id
ROLE_NAMES = {ADMIN: "Admin", EXECUTIVE: "Executive", NORMAL: "Normal User"}
MIN_PASSWORD = 10
MAX_FAILED_LOGINS = 5
LOCK_MINUTES = 15
PUBLIC_ENDPOINTS = {"accounts.login", "accounts.register", "static"}


def load_secret_key(project_dir):
    """Persist a random secret so sessions survive restarts (file is gitignored)."""
    path = Path(project_dir) / ".secret_key"
    if not path.exists():
        # Owner-only from creation (mode is advisory on Windows).
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    return path.read_text().strip()


@bp.before_app_request
def require_login():
    # CSRF defence on top of SameSite=Lax: browsers send Origin on writes; reject other sites.
    origin = request.headers.get("Origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin != request.host_url.rstrip("/"):
        abort(403)
    g.user = None
    if "uid" in session:
        with connect() as conn:
            g.user = conn.execute(
                "SELECT id, username, role_id, executive_id FROM users WHERE id = %s AND is_active", (session["uid"],)
            ).fetchone()
        if g.user is None:  # deleted or deactivated since they signed in
            session.clear()
    if g.user is None and request.endpoint not in PUBLIC_ENDPOINTS:
        if request.path.startswith(("/api/", "/analyze")):
            return jsonify({"error": "Please sign in."}), 401
        return redirect(url_for("accounts.login"))


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user["role_id"] != ADMIN:
            return jsonify({"error": "Admins only."}), 403
        return view(*args, **kwargs)
    return wrapped


def member_required(view):
    """Executives and Normal Users only: Admins manage accounts and never see meeting content."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user["role_id"] == ADMIN:
            return jsonify({"error": "Administrators manage accounts and teams. Sign in as an Executive or Normal User to work with meetings."}), 403
        return view(*args, **kwargs)
    return wrapped


def _sign_in(user_id):
    session.clear()
    session["uid"] = user_id
    session.permanent = True


def _needs_setup(conn):
    return conn.execute("SELECT NOT EXISTS (SELECT 1 FROM users) AS empty").fetchone()["empty"]


# ---------- login / first-run setup ----------

@bp.route("/login", methods=["GET", "POST"])
def login():
    error = None
    with connect() as conn:
        if _needs_setup(conn):
            return redirect(url_for("accounts.register"))
        if request.method == "POST":
            username = request.form.get("username", "").strip()
            user = conn.execute("SELECT * FROM users WHERE lower(username) = lower(%s)", (username,)).fetchone()
            locked = user and user["locked_until"] and conn.execute(
                "SELECT %s > now() AS locked", (user["locked_until"],)
            ).fetchone()["locked"]
            if locked:
                audit(conn, "login_blocked", f"locked account: {user['username']}")
                error = f"Too many failed attempts. Try again in {LOCK_MINUTES} minutes."
            elif user and user["is_active"] and check_password_hash(user["password_hash"], request.form.get("password", "")):
                conn.execute(
                    "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = %s",
                    (user["id"],),
                )
                audit(conn, "login", actor=user)
                _sign_in(user["id"])
                return redirect(url_for("index"))
            else:
                if user:
                    conn.execute(
                        "UPDATE users SET failed_logins = failed_logins + 1,"
                        " locked_until = CASE WHEN failed_logins + 1 >= %s"
                        "   THEN now() + make_interval(mins => %s) ELSE locked_until END"
                        " WHERE id = %s",
                        (MAX_FAILED_LOGINS, LOCK_MINUTES, user["id"]),
                    )
                audit(conn, "login_failed", f"username: {username[:60]}")
                error = "Wrong username or password."
    return render_template("login.html", mode="login", error=error)


@bp.route("/register", methods=["GET", "POST"])
def register():
    """First-run setup only: creates the first admin. Afterwards admins add users."""
    error = None
    with connect() as conn:
        conn.execute("LOCK TABLE users IN EXCLUSIVE MODE")  # two simultaneous setups can't both win
        if not _needs_setup(conn):
            return redirect(url_for("accounts.login"))
        if request.method == "POST":
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            if not 3 <= len(username) <= 40:
                error = "Username must be 3 to 40 characters."
            elif len(password) < MIN_PASSWORD:
                error = f"Password must be at least {MIN_PASSWORD} characters."
            elif password != request.form.get("confirm", ""):
                error = "Passwords do not match."
            else:
                user = conn.execute(
                    "INSERT INTO users (username, email, password_hash, role_id) VALUES (%s, %s, %s, 1)"
                    " RETURNING id, username",
                    (username, request.form.get("email", "").strip()[:200], generate_password_hash(password)),
                ).fetchone()
                audit(conn, "setup_admin", "first administrator created", actor=user)
                _sign_in(user["id"])
                return redirect(url_for("index"))
    return render_template("login.html", mode="register", error=error)


@bp.route("/logout", methods=["POST"])
def logout():
    if g.user:
        with connect() as conn:
            audit(conn, "logout", actor=g.user)
    session.clear()
    return redirect(url_for("accounts.login"))




# ---------- meetings: owners edit; their Executive can read; Admins see none of the content ----------

def save_meeting(user_id, file_name, result):
    """Store one finished analysis: meeting, speakers, transcript turns, decisions and action items."""
    lines = result.get("speaker_transcript") or result.get("transcript") or []
    ends = [float(l["end"]) for l in lines if l.get("end") is not None]
    with connect() as conn:
        meeting_id = conn.execute(
            "INSERT INTO meetings (user_id, title, audio_file, summary, duration_sec, alignment_error)"
            " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (user_id, Path(file_name).stem[:200] or "Meeting", file_name[:255], result.get("summary", ""),
             max(ends, default=0), result.get("alignment_error")),
        ).fetchone()["id"]
        speaker_ids = {}
        for line in lines:
            label = line.get("speaker") or "UNKNOWN"
            if label not in speaker_ids:
                speaker_ids[label] = conn.execute(
                    "INSERT INTO speakers (meeting_id, speaker_label) VALUES (%s, %s) RETURNING id",
                    (meeting_id, label),
                ).fetchone()["id"]
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO transcripts (meeting_id, speaker_id, seq, text, start_time, end_time)"
                " VALUES (%s, %s, %s, %s, %s, %s)",
                [(meeting_id, speaker_ids[l.get("speaker") or "UNKNOWN"], i, l.get("text") or "",
                  l.get("start"), l.get("end")) for i, l in enumerate(lines)],
            )
        _store_insights(conn, meeting_id, result.get("decisions"), result.get("action_items"))
    return meeting_id


def _store_insights(conn, meeting_id, decisions, action_items):
    conn.execute("DELETE FROM decisions WHERE meeting_id = %s", (meeting_id,))
    conn.execute("DELETE FROM action_items WHERE meeting_id = %s", (meeting_id,))
    with conn.cursor() as cur:
        cur.executemany("INSERT INTO decisions (meeting_id, description) VALUES (%s, %s)",
                        [(meeting_id, d) for d in decisions or []])
        cur.executemany(
            "INSERT INTO action_items (meeting_id, description, responsible_person, deadline)"
            " VALUES (%s, %s, %s, %s)",
            [(meeting_id, i["description"], i.get("responsible_person", ""), i.get("deadline", ""))
             for i in action_items or []],
        )


READABLE = (
    "SELECT m.*, u.username AS owner,"
    " (SELECT count(*) FROM speakers s WHERE s.meeting_id = m.id AND s.speaker_label <> 'UNKNOWN') AS speaker_count"
    " FROM meetings m JOIN users u ON u.id = m.user_id"
    " WHERE (m.user_id = %(me)s OR (%(exec)s AND u.executive_id = %(me)s))"
)


def _readable_args():
    return {"me": g.user["id"], "exec": g.user["role_id"] == EXECUTIVE}


def _meeting_json(row):
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "fileName": row["audio_file"],
        "createdAt": int(row["upload_date"].timestamp() * 1000),
        "summary": row["summary"],
        "duration": row["duration_sec"],
        "speakers": row["speaker_count"],
        "alignmentError": bool(row["alignment_error"]),
        "owner": row["owner"],
        "mine": row["user_id"] == g.user["id"],
    }


def _full_meeting(conn, meeting_id):
    """The meeting with transcript, decisions and action items, or None if this user may not read it."""
    row = conn.execute(READABLE + " AND m.id = %(id)s", {**_readable_args(), "id": meeting_id}).fetchone()
    if row is None:
        return None
    lines = conn.execute(
        'SELECT t.id, t.speaker_id AS "speakerId", s.speaker_label AS speaker,'
        ' t.start_time AS start, t.end_time AS "end", t.text'
        " FROM transcripts t JOIN speakers s ON s.id = t.speaker_id"
        " WHERE t.meeting_id = %s ORDER BY t.seq", (meeting_id,)
    ).fetchall()
    speakers = conn.execute(
        "SELECT id, speaker_label AS label FROM speakers WHERE meeting_id = %s ORDER BY id", (meeting_id,)
    ).fetchall()
    decisions = [d["description"] for d in conn.execute(
        "SELECT description FROM decisions WHERE meeting_id = %s ORDER BY id", (meeting_id,)).fetchall()]
    items = conn.execute(
        'SELECT description, responsible_person AS "responsiblePerson", deadline'
        " FROM action_items WHERE meeting_id = %s ORDER BY id", (meeting_id,)
    ).fetchall()
    return {**_meeting_json(row), "lines": lines, "speakerList": speakers, "decisions": decisions, "actionItems": items}


def _own_meeting(conn, meeting_id):
    """Only the owner may change or delete a meeting (an Executive's access to a team member's is read-only)."""
    return conn.execute(
        "SELECT id FROM meetings WHERE id = %s AND user_id = %s", (meeting_id, g.user["id"])
    ).fetchone()


def _not_found():
    return jsonify({"error": "Report not found."}), 404


@bp.route("/api/reports")
@member_required
def list_reports():
    """Metadata only (own meetings, plus the team's for an Executive); transcripts load one at a time."""
    with connect() as conn:
        rows = conn.execute(READABLE + " ORDER BY m.upload_date DESC", _readable_args()).fetchall()
    return jsonify([_meeting_json(r) for r in rows])


@bp.route("/api/reports/<int:meeting_id>")
@member_required
def get_report(meeting_id):
    with connect() as conn:
        meeting = _full_meeting(conn, meeting_id)
    return jsonify(meeting) if meeting else _not_found()


@bp.route("/api/reports", methods=["DELETE"])
@member_required
def clear_reports():
    with connect() as conn:
        conn.execute("DELETE FROM meetings WHERE user_id = %s", (g.user["id"],))
        audit(conn, "history_cleared", actor=g.user)
    return jsonify({"ok": True})


@bp.route("/api/reports/<int:meeting_id>", methods=["DELETE"])
@member_required
def delete_report(meeting_id):
    with connect() as conn:
        if not _own_meeting(conn, meeting_id):
            return _not_found()
        conn.execute("DELETE FROM meetings WHERE id = %s", (meeting_id,))
        audit(conn, "meeting_deleted", f"meeting {meeting_id}", actor=g.user)
    return jsonify({"ok": True})


def _clean(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ""


@bp.route("/api/reports/<int:meeting_id>", methods=["PATCH"])
@member_required
def edit_report(meeting_id):
    """Correct the title, summary, decisions or action items."""
    body = request.get_json(silent=True) or {}
    with connect() as conn:
        if not _own_meeting(conn, meeting_id):
            return _not_found()
        if "title" in body:
            title = _clean(body["title"], 200)
            if not title:
                return jsonify({"error": "The title can't be empty."}), 400
            conn.execute("UPDATE meetings SET title = %s WHERE id = %s", (title, meeting_id))
        if "summary" in body:
            conn.execute("UPDATE meetings SET summary = %s WHERE id = %s", (_clean(body["summary"], 20000), meeting_id))
        if "decisions" in body or "actionItems" in body:
            # Only replace the list the request actually sent; keep the other as stored.
            if "decisions" in body:
                decisions = [_clean(d, 2000) for d in body["decisions"] if _clean(d, 2000)]
            else:
                decisions = [d["description"] for d in conn.execute(
                    "SELECT description FROM decisions WHERE meeting_id = %s ORDER BY id", (meeting_id,))]
            if "actionItems" in body:
                items = [{"description": _clean(i.get("description"), 2000),
                          "responsible_person": _clean(i.get("responsiblePerson"), 200),
                          "deadline": _clean(i.get("deadline"), 200)}
                         for i in body["actionItems"] if isinstance(i, dict) and _clean(i.get("description"), 2000)]
            else:
                items = conn.execute(
                    "SELECT description, responsible_person, deadline FROM action_items"
                    " WHERE meeting_id = %s ORDER BY id", (meeting_id,)).fetchall()
            _store_insights(conn, meeting_id, decisions, items)
        audit(conn, "meeting_edited", f"meeting {meeting_id}", actor=g.user)
        return jsonify(_full_meeting(conn, meeting_id))


@bp.route("/api/reports/<int:meeting_id>/segments/<int:segment_id>", methods=["PATCH"])
@member_required
def edit_segment(meeting_id, segment_id):
    """Correct what was said, or reassign the turn to another speaker of the same meeting."""
    body = request.get_json(silent=True) or {}
    with connect() as conn:
        if not _own_meeting(conn, meeting_id):
            return _not_found()
        if conn.execute("SELECT 1 FROM transcripts WHERE id = %s AND meeting_id = %s",
                        (segment_id, meeting_id)).fetchone() is None:
            return _not_found()
        if "text" in body:
            text = _clean(body["text"], 20000)
            if not text:
                return jsonify({"error": "The text can't be empty."}), 400
            conn.execute("UPDATE transcripts SET text = %s WHERE id = %s", (text, segment_id))
        if "speakerId" in body:
            if conn.execute("SELECT 1 FROM speakers WHERE id = %s AND meeting_id = %s",
                            (body["speakerId"], meeting_id)).fetchone() is None:
                return jsonify({"error": "That speaker is not in this meeting."}), 400
            conn.execute("UPDATE transcripts SET speaker_id = %s WHERE id = %s", (body["speakerId"], segment_id))
        audit(conn, "transcript_edited", f"meeting {meeting_id}", actor=g.user)
    return jsonify({"ok": True})


@bp.route("/api/reports/<int:meeting_id>/speakers/<int:speaker_id>", methods=["PATCH"])
@member_required
def rename_speaker(meeting_id, speaker_id):
    label = _clean((request.get_json(silent=True) or {}).get("label"), 80)
    if not label:
        return jsonify({"error": "The speaker name can't be empty."}), 400
    with connect() as conn:
        if not _own_meeting(conn, meeting_id):
            return _not_found()
        updated = conn.execute(
            "UPDATE speakers SET speaker_label = %s WHERE id = %s AND meeting_id = %s RETURNING id",
            (label, speaker_id, meeting_id)).fetchone()
        if updated is None:
            return _not_found()
        audit(conn, "speaker_renamed", f"meeting {meeting_id}", actor=g.user)
    return jsonify({"ok": True})


@bp.route("/api/reports/<int:meeting_id>/regenerate", methods=["POST"])
@member_required
def regenerate_report(meeting_id):
    """Re-run the local LLM over the saved (possibly corrected) transcript."""
    with connect() as conn:
        if not _own_meeting(conn, meeting_id):
            return _not_found()
        lines = conn.execute(
            "SELECT s.speaker_label, t.text FROM transcripts t JOIN speakers s ON s.id = t.speaker_id"
            " WHERE t.meeting_id = %s ORDER BY t.seq", (meeting_id,)).fetchall()
    if not lines:
        return jsonify({"error": "This meeting has no transcript to analyze."}), 400
    try:
        insights = generate_insights("\n".join(f"{l['speaker_label']}: {l['text']}" for l in lines))
    except Exception as error:
        return jsonify({"error": f"The local AI model could not be reached ({type(error).__name__})."}), 502
    with connect() as conn:
        conn.execute("UPDATE meetings SET summary = %s WHERE id = %s", (insights["summary"], meeting_id))
        _store_insights(conn, meeting_id, insights["decisions"], insights["action_items"])
        audit(conn, "meeting_regenerated", f"meeting {meeting_id}", actor=g.user)
        return jsonify(_full_meeting(conn, meeting_id))


@bp.route("/api/reports/<int:meeting_id>/export")
@member_required
def export_report(meeting_id):
    """JSON or DOCX download (PDF is produced in the browser from the print view)."""
    fmt = request.args.get("format", "json")
    with connect() as conn:
        meeting = _full_meeting(conn, meeting_id)
    if meeting is None:
        return _not_found()
    name = "".join(c if c.isalnum() or c in " -_" else "_" for c in meeting["title"]).strip() or "meeting"
    if fmt == "docx":
        return Response(build_docx(meeting),
                        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        headers={"Content-Disposition": f'attachment; filename="{name}.docx"'})
    if fmt == "json":
        response = jsonify(meeting)
        response.headers["Content-Disposition"] = f'attachment; filename="{name}.json"'
        return response
    return jsonify({"error": "Unknown format."}), 400


# ---------- admin JSON API: accounts, roles and teams ----------

def _iso(value):
    return value.isoformat() if value else None


def _team_error(conn, role_id, executive_id):
    """Only a Normal User can join a team, and only an active Executive can lead one."""
    if executive_id is None:
        return None
    if role_id != NORMAL:
        return "Only Normal Users can be assigned to an Executive's team."
    boss = conn.execute("SELECT 1 FROM users WHERE id = %s AND role_id = %s AND is_active",
                        (executive_id, EXECUTIVE)).fetchone()
    return None if boss else "The team leader must be an active Executive."


@bp.route("/api/admin/overview")
@admin_required
def admin_overview():
    with connect() as conn:
        stats = conn.execute(
            "SELECT (SELECT COUNT(*) FROM users) AS users,"
            " (SELECT COUNT(*) FROM users WHERE role_id = 2) AS executives,"
            " (SELECT COUNT(*) FROM meetings) AS meetings,"
            " (SELECT COALESCE(SUM(duration_sec), 0) / 3600 FROM meetings) AS hours,"
            " (SELECT COUNT(*) FROM transcripts) AS utterances"
        ).fetchone()
        db = conn.execute(
            "SELECT version() AS version, pg_size_pretty(pg_database_size(current_database())) AS size"
        ).fetchone()
        users = conn.execute(
            "SELECT u.id, u.username, u.email, u.role_id, u.executive_id, x.username AS executive,"
            " u.is_active, u.created_at, u.last_login_at,"
            " (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,"
            " (SELECT COUNT(*) FROM meetings m WHERE m.user_id = u.id) AS meetings,"
            " (SELECT COUNT(*) FROM users t WHERE t.executive_id = u.id) AS team_size"
            " FROM users u LEFT JOIN users x ON x.id = u.executive_id ORDER BY u.id"
        ).fetchall()
        log = conn.execute("SELECT at, actor_name, action, detail FROM audit_log ORDER BY id DESC LIMIT 50").fetchall()
    return jsonify({
        "stats": {**stats, "hours": float(stats["hours"])},
        "database": {"version": db["version"].split(" on ")[0], "size": db["size"]},
        "me": g.user["id"],
        "users": [{
            "id": u["id"], "username": u["username"], "email": u["email"], "roleId": u["role_id"],
            "role": ROLE_NAMES[u["role_id"]], "executiveId": u["executive_id"], "executive": u["executive"],
            "teamSize": u["team_size"], "isActive": u["is_active"],
            "locked": u["locked"], "meetings": u["meetings"],
            "createdAt": _iso(u["created_at"]), "lastLogin": _iso(u["last_login_at"]),
        } for u in users],
        "audit": [{"at": _iso(a["at"]), "actor": a["actor_name"], "action": a["action"], "detail": a["detail"]}
                  for a in log],
    })


@bp.route("/api/admin/users", methods=["POST"])
@admin_required
def admin_create_user():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    role_id = body.get("roleId")
    executive_id = body.get("executiveId") or None
    if not 3 <= len(username) <= 40:
        return jsonify({"error": "Username must be 3 to 40 characters."}), 400
    if len(password) < MIN_PASSWORD:
        return jsonify({"error": f"Password must be at least {MIN_PASSWORD} characters."}), 400
    if role_id not in (EXECUTIVE, NORMAL):
        return jsonify({"error": "Choose Executive or Normal User."}), 400
    try:
        with connect() as conn:
            error = _team_error(conn, role_id, executive_id)
            if error:
                return jsonify({"error": error}), 400
            conn.execute(
                "INSERT INTO users (username, email, password_hash, role_id, executive_id)"
                " VALUES (%s, %s, %s, %s, %s)",
                (username, _clean(body.get("email"), 200), generate_password_hash(password), role_id, executive_id),
            )
            audit(conn, "user_created", f"{username} ({ROLE_NAMES[role_id]})", actor=g.user)
    except errors.UniqueViolation:
        return jsonify({"error": "That username is taken."}), 409
    return jsonify({"ok": True}), 201


@bp.route("/api/admin/users/<int:user_id>", methods=["PATCH"])
@admin_required
def admin_update_user(user_id):
    body = request.get_json(silent=True) or {}
    if user_id == g.user["id"] and ("roleId" in body or "isActive" in body):
        # Keeps at least one working admin: nobody can demote or disable themselves.
        return jsonify({"error": "You can't change your own role or status."}), 400
    with connect() as conn:
        target = conn.execute("SELECT username, role_id, executive_id FROM users WHERE id = %s", (user_id,)).fetchone()
        if target is None:
            return jsonify({"error": "User not found."}), 404
        if "roleId" in body or "executiveId" in body:
            role_id = body.get("roleId", target["role_id"])
            executive_id = body.get("executiveId", target["executive_id"]) or None
            if target["role_id"] == ADMIN or role_id not in (EXECUTIVE, NORMAL):
                return jsonify({"error": "Choose Executive or Normal User."}), 400
            if role_id != NORMAL:
                executive_id = None
            error = _team_error(conn, role_id, executive_id)
            if error:
                return jsonify({"error": error}), 400
            conn.execute("UPDATE users SET role_id = %s, executive_id = %s WHERE id = %s",
                         (role_id, executive_id, user_id))
            if role_id != EXECUTIVE:  # an ex-Executive's team is released
                conn.execute("UPDATE users SET executive_id = NULL WHERE executive_id = %s", (user_id,))
            audit(conn, "user_role_changed", f"{target['username']} -> {ROLE_NAMES[role_id]}", actor=g.user)
        if "isActive" in body:
            conn.execute(
                "UPDATE users SET is_active = %s, failed_logins = 0, locked_until = NULL WHERE id = %s",
                (bool(body["isActive"]), user_id),
            )
            audit(conn, "user_status_changed", f"{target['username']} active={bool(body['isActive'])}", actor=g.user)
        if "password" in body:
            password = str(body["password"])
            if len(password) < MIN_PASSWORD:
                return jsonify({"error": f"Password must be at least {MIN_PASSWORD} characters."}), 400
            conn.execute(
                "UPDATE users SET password_hash = %s, failed_logins = 0, locked_until = NULL WHERE id = %s",
                (generate_password_hash(password), user_id),
            )
            audit(conn, "password_reset", target["username"], actor=g.user)
        if body.get("unlock"):
            conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = %s", (user_id,))
            audit(conn, "user_unlocked", target["username"], actor=g.user)
    return jsonify({"ok": True})


@bp.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id):
    if user_id == g.user["id"]:
        return jsonify({"error": "You can't delete your own account."}), 400
    with connect() as conn:
        target = conn.execute("DELETE FROM users WHERE id = %s RETURNING username", (user_id,)).fetchone()
        if target is None:
            return jsonify({"error": "User not found."}), 404
        audit(conn, "user_deleted", target["username"], actor=g.user)
    return jsonify({"ok": True})
