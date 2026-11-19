"""Shared test setup: heavy ML libraries are mocked and the app uses the *_test database.

Import this module BEFORE importing `app`.
"""

import os
import sys
from unittest.mock import MagicMock

import db  # loads .env

for _name in ("ollama", "torch", "transformers", "transformers.audio_utils",
              "transformers.models.cohere_asr", "pyannote.audio", "torchaudio.pipelines"):
    sys.modules.setdefault(_name, MagicMock())

_url = os.environ.get("TEST_DATABASE_URL", "")
if not _url.split("?")[0].rsplit("/", 1)[-1].endswith("_test"):
    raise RuntimeError("Set TEST_DATABASE_URL to a database whose name ends in _test (see .env.example).")
os.environ["DATABASE_URL"] = _url  # the app and tests use the test DB, never the real one


def reset():
    """Empty every table (safe: only ever runs against the *_test database)."""
    assert db.database_url().split("?")[0].rsplit("/", 1)[-1].endswith("_test")
    with db.connect() as conn:
        conn.execute("TRUNCATE audit_log, action_items, decisions, transcripts, speakers, meetings, users RESTART IDENTITY CASCADE")
