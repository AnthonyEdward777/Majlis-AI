# Database (PostgreSQL)

Majlis stores users, meetings, speaker turns and an audit log in **PostgreSQL 17**. It runs on your own
server (on-premise); nothing leaves the network.

## Connect to it
Everything is configured in `.env` (gitignored; copy `.env.example`):

| Variable | Used for |
|---|---|
| `DATABASE_URL` | the app, as role `majlis` (owns the `majlis` database, not a superuser) |
| `TEST_DATABASE_URL` | the test suite; the database name **must** end in `_test` (it is wiped each run) |

Use any client with the same details: `psql "$DATABASE_URL"`, pgAdmin, DBeaver, DataGrip.
Host `localhost`, port `5432`, database `majlis`, user `majlis`.

## Tables
They follow the ER diagram in the SRS presentation.
- `roles`: 1 Admin, 2 Executive, 3 Normal User (seeded automatically).
- `users`: username, email, password hash, `role_id`, `executive_id` (a Normal User's Executive, empty otherwise), active flag, failed-login counter and lockout.
- `meetings`: one row per analysis (owner, title, original file name, summary, duration, upload date). The audio file itself is deleted after processing.
- `speakers`: one row per speaker in a meeting; `speaker_label` is the diarization label until a user renames it.
- `transcripts`: one row per speaker turn (`meeting_id`, `speaker_id`, `seq`, `text`, `start_time`, `end_time`), i.e. who said what and when.
- `decisions` and `action_items` (description, responsible person, deadline): extracted by the local LLM.
- `audit_log`: sign-ins, failed sign-ins, account, role and team changes, meeting edits and deletions.

Example, who said what in meeting 12:
```sql
SELECT s.speaker_label, t.start_time, t.end_time, t.text
FROM transcripts t JOIN speakers s ON s.id = t.speaker_id
WHERE t.meeting_id = 12 ORDER BY t.seq;
```

Databases from the earlier prototype (`users.is_admin`, `utterances`) are upgraded on startup: accounts are kept
(admins stay admins, everyone else becomes a Normal User). If old-format meetings exist the app stops and asks you to export them first.

## First run
The schema is created automatically on startup. The first visit to the site shows a one-time setup page
that creates the administrator; after that, registration is closed and the admin adds users
(Admin page in the sidebar). The first account is an Admin; Admins manage accounts, roles and teams but do not upload or read meetings.

## Local development server (Windows, no admin rights needed)
The dev machine runs Postgres from the official binary zip in `C:\dev\majlis-postgres`:
```powershell
powershell -File C:\dev\majlis-postgres\start.ps1          # start
C:\dev\majlis-postgres\pgsql\bin\pg_ctl.exe -D C:\dev\majlis-postgres\data stop   # stop
```
Each teammate needs their own Postgres 17 (or a shared server) and a `.env`.

## Production notes
Install Postgres as a service, create the `majlis` role and database, keep `listen_addresses` on the
internal network only, turn on TLS (`sslmode=require` in `DATABASE_URL`) and schedule `pg_dump` backups.
Run the app behind a production WSGI server (for example waitress) and HTTPS, and set
`SESSION_COOKIE_SECURE=True` once it is served over HTTPS.
