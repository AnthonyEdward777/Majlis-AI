"""PostgreSQL storage: users, meetings, per-speaker utterances and an audit log.

Connection comes from DATABASE_URL (environment or the gitignored .env file).
"""

import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ENV_FILE = Path(__file__).resolve().parent / ".env"


def _load_env_file():
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not line.lstrip().startswith("#") and value.strip():
            os.environ.setdefault(key.strip(), value.strip())


_load_env_file()

SCHEMA = """
-- Matches the SRS ER diagram: Role, User, Meeting, Speaker, Transcript, Decision, Action_Item.
CREATE TABLE IF NOT EXISTS roles (
    id   SMALLINT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);
INSERT INTO roles (id, name) VALUES (1, 'Admin'), (2, 'Executive'), (3, 'Normal User')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL,
    email         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role_id       SMALLINT NOT NULL REFERENCES roles(id),
    -- A Normal User belongs to the team of one Executive (NULL for everyone else).
    executive_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_executive ON users (executive_id);

CREATE TABLE IF NOT EXISTS meetings (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    audio_file      TEXT NOT NULL,  -- original file name; the recording itself is deleted after processing
    summary         TEXT NOT NULL DEFAULT '',
    duration_sec    REAL NOT NULL DEFAULT 0,
    alignment_error TEXT,
    upload_date     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_user ON meetings (user_id, upload_date DESC);

CREATE TABLE IF NOT EXISTS speakers (
    id            BIGSERIAL PRIMARY KEY,
    meeting_id    BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_label TEXT NOT NULL  -- diarization label (SPEAKER_00) until a user renames it
);
CREATE INDEX IF NOT EXISTS speakers_meeting ON speakers (meeting_id);

-- One row per speaker turn: who said what, and when.
CREATE TABLE IF NOT EXISTS transcripts (
    id         BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_id BIGINT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    start_time REAL,
    end_time   REAL
);
CREATE INDEX IF NOT EXISTS transcripts_meeting ON transcripts (meeting_id, seq);

CREATE TABLE IF NOT EXISTS decisions (
    id          BIGSERIAL PRIMARY KEY,
    meeting_id  BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    description TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_meeting ON decisions (meeting_id);

CREATE TABLE IF NOT EXISTS action_items (
    id                 BIGSERIAL PRIMARY KEY,
    meeting_id         BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    description        TEXT NOT NULL,
    responsible_person TEXT NOT NULL DEFAULT '',
    deadline           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS action_items_meeting ON action_items (meeting_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at DESC);
"""

# Databases created by the earlier prototype (users.is_admin, utterances) are rebuilt once.
# Only the prototype's tables are touched, and only when nothing real was stored in them.
LEGACY_CHECK = "SELECT to_regclass('utterances') IS NOT NULL AS legacy"

# Prototype users had users.is_admin; keep the accounts and give them a role.
USERS_UPGRADE = """
CREATE TABLE IF NOT EXISTS roles (id SMALLINT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
INSERT INTO roles (id, name) VALUES (1, 'Admin'), (2, 'Executive'), (3, 'Normal User') ON CONFLICT DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id SMALLINT REFERENCES roles(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS executive_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
UPDATE users SET role_id = CASE WHEN is_admin THEN 1 ELSE 3 END;
ALTER TABLE users ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE users DROP COLUMN is_admin;
"""


def database_url():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")
    return url


def connect():
    # shortcut: one connection per call; add psycopg_pool when concurrency grows.
    # `with connect() as conn:` commits on success and rolls back on error.
    return psycopg.connect(database_url(), row_factory=dict_row)


def init_db():
    with connect() as conn:
        if conn.execute(LEGACY_CHECK).fetchone()["legacy"]:
            if conn.execute("SELECT count(*) AS n FROM meetings").fetchone()["n"]:
                raise RuntimeError("Old-format meetings found; export them before upgrading the schema.")
            conn.execute("DROP TABLE utterances, meetings CASCADE")
        has_is_admin = conn.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns"
            " WHERE table_name = 'users' AND column_name = 'is_admin') AS x"
        ).fetchone()["x"]
        if has_is_admin:
            conn.execute(USERS_UPGRADE)
        conn.execute(SCHEMA)


def audit(conn, action, detail="", actor=None):
    """Record a security-relevant event. `actor` is a user row or None."""
    conn.execute(
        "INSERT INTO audit_log (actor_id, actor_name, action, detail) VALUES (%s, %s, %s, %s)",
        (actor["id"] if actor else None, actor["username"] if actor else None, action, detail),
    )
