import importlib
import unittest

import _testdb

app = importlib.import_module("app")

from db import connect  # noqa: E402

PASSWORD = "correct-horse-battery"


def post_json(client, method, url, body=None):
    return client.open(url, method=method, json=body)


def setup_admin(name="boss"):
    c = app.app.test_client()
    c.post("/register", data={"username": name, "password": PASSWORD, "confirm": PASSWORD})
    return c


def add_user(admin, name, roleId=3, **extra):
    return post_json(admin, "POST", "/api/admin/users", {"username": name, "password": PASSWORD, "roleId": roleId, **extra})


def user_id(name):
    with connect() as conn:
        return conn.execute("SELECT id FROM users WHERE username = %s", (name,)).fetchone()["id"]


LINES = [{"speaker": "SPEAKER_00", "start": 0, "end": 3, "text": "hi"}]


def sign_in(name, password=PASSWORD):
    c = app.app.test_client()
    c.post("/login", data={"username": name, "password": password})
    return c


class AccountTests(unittest.TestCase):
    def setUp(self):
        _testdb.reset()

    def test_everything_requires_login(self):
        setup_admin()
        c = app.app.test_client()
        self.assertEqual(c.get("/").headers["Location"], "/login")
        self.assertEqual(c.get("/api/reports").status_code, 401)
        self.assertEqual(c.post("/analyze").status_code, 401)
        self.assertEqual(c.get("/api/admin/overview").status_code, 401)

    def test_page_loads_only_local_assets(self):
        import re
        html = setup_admin().get("/").get_data(as_text=True)
        self.assertEqual(re.findall(r"(?:src|href)=[\"']https?://", html), [])
        c = app.app.test_client()
        for path in re.findall(r"(?:src|href)=[\"'](/static/vendor/[^\"']+)", html):
            self.assertEqual(c.get(path).status_code, 200, path)

    def test_login_page_script_is_valid_javascript_text(self):
        # Jinja escapes quotes inside <script>; that once broke the sign-in loading state.
        setup_admin()
        html = app.app.test_client().get("/login").get_data(as_text=True)
        script = html.split("<script>")[1].split("</script>")[0]
        self.assertNotIn("&#", script)
        self.assertNotIn("&quot;", script)

    def test_report_list_carries_speaker_names_for_dashboard_and_search(self):
        admin = setup_admin()
        add_user(admin, "dana")
        dana = sign_in("dana")
        import accounts
        accounts.save_meeting(user_id("dana"), "m.wav", {"speaker_transcript": LINES, "summary": "s"})
        listed = dana.get("/api/reports").get_json()
        self.assertEqual(listed[0]["speakerNames"], ["SPEAKER_00"])

    def test_first_run_setup_then_registration_closes(self):
        c = app.app.test_client()
        self.assertEqual(c.get("/login").headers["Location"], "/register")
        c.post("/register", data={"username": "boss", "password": PASSWORD, "confirm": PASSWORD})
        self.assertEqual(c.get("/api/admin/overview").status_code, 200)
        other = app.app.test_client()
        r = other.post("/register", data={"username": "intruder", "password": PASSWORD, "confirm": PASSWORD})
        self.assertEqual(r.headers["Location"], "/login")
        self.assertEqual(sign_in("intruder").get("/api/reports").status_code, 401)

    def test_admin_creates_users_and_reports_stay_private(self):
        admin = setup_admin()
        self.assertEqual(add_user(admin, "worker").status_code, 201)
        self.assertEqual(add_user(admin, "WORKER").status_code, 409)  # usernames are case-insensitive
        worker = sign_in("worker")
        self.assertEqual(worker.get("/api/admin/overview").status_code, 403)
        self.assertEqual(post_json(worker, "POST", "/api/admin/users", {"username": "x" * 5, "password": PASSWORD, "roleId": 3}).status_code, 403)

        import accounts
        with connect() as conn:
            uid = conn.execute("SELECT id FROM users WHERE username = 'worker'").fetchone()["id"]
        mid = accounts.save_meeting(uid, "a.wav", {"summary": "s", "speaker_transcript": [
            {"speaker": "SPEAKER_00", "start": 0, "end": 3, "text": "hi"}]})
        self.assertEqual(len(worker.get("/api/reports").get_json()), 1)
        self.assertEqual(admin.get("/api/reports").status_code, 403)  # admins manage accounts, not meetings
        self.assertEqual(admin.get(f"/api/reports/{mid}").status_code, 403)
        add_user(admin, "peer")
        self.assertEqual(sign_in("peer").get(f"/api/reports/{mid}").status_code, 404)  # another normal user
        self.assertEqual(worker.get(f"/api/reports/{mid}").status_code, 200)

    def test_bad_password_and_lockout(self):
        admin = setup_admin()
        add_user(admin, "bob")
        c = app.app.test_client()
        self.assertIn(b"Wrong username", c.post("/login", data={"username": "bob", "password": "nope"}).data)
        for _ in range(5):
            c.post("/login", data={"username": "bob", "password": "nope"})
        # Locked: even the right password is refused.
        self.assertIn(b"Too many failed", c.post("/login", data={"username": "bob", "password": PASSWORD}).data)
        # An admin can unlock.
        with connect() as conn:
            uid = conn.execute("SELECT id FROM users WHERE username = 'bob'").fetchone()["id"]
        post_json(admin, "PATCH", f"/api/admin/users/{uid}", {"unlock": True})
        self.assertEqual(c.post("/login", data={"username": "bob", "password": PASSWORD}).status_code, 302)

    def test_disabled_user_is_kicked_out_and_cannot_return(self):
        admin = setup_admin()
        add_user(admin, "bob")
        bob = sign_in("bob")
        self.assertEqual(bob.get("/api/reports").status_code, 200)
        with connect() as conn:
            uid = conn.execute("SELECT id FROM users WHERE username = 'bob'").fetchone()["id"]
        post_json(admin, "PATCH", f"/api/admin/users/{uid}", {"isActive": False})
        self.assertEqual(bob.get("/api/reports").status_code, 401)
        self.assertIn(b"Wrong username", app.app.test_client().post("/login", data={"username": "bob", "password": PASSWORD}).data)

    def test_admin_cannot_demote_disable_or_delete_self(self):
        admin = setup_admin()
        me = admin.get("/api/admin/overview").get_json()["me"]
        self.assertEqual(post_json(admin, "PATCH", f"/api/admin/users/{me}", {"roleId": 3}).status_code, 400)
        self.assertEqual(post_json(admin, "PATCH", f"/api/admin/users/{me}", {"isActive": False}).status_code, 400)
        self.assertEqual(post_json(admin, "DELETE", f"/api/admin/users/{me}").status_code, 400)

    def test_password_reset_and_deleting_user_removes_their_meetings(self):
        admin = setup_admin()
        add_user(admin, "bob")
        with connect() as conn:
            uid = conn.execute("SELECT id FROM users WHERE username = 'bob'").fetchone()["id"]
        self.assertEqual(post_json(admin, "PATCH", f"/api/admin/users/{uid}", {"password": "short"}).status_code, 400)
        post_json(admin, "PATCH", f"/api/admin/users/{uid}", {"password": "a-brand-new-password"})
        self.assertEqual(sign_in("bob", "a-brand-new-password").get("/api/reports").status_code, 200)

        import accounts
        accounts.save_meeting(uid, "a.wav", {"speaker_transcript": [{"speaker": "S", "text": "t"}]})
        self.assertEqual(post_json(admin, "DELETE", f"/api/admin/users/{uid}").status_code, 200)
        with connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM transcripts").fetchone()["n"], 0)

    def test_actions_are_audited(self):
        admin = setup_admin()
        add_user(admin, "bob")
        actions = [a["action"] for a in admin.get("/api/admin/overview").get_json()["audit"]]
        self.assertIn("user_created", actions)
        self.assertIn("setup_admin", actions)

    def test_cross_site_post_is_rejected(self):
        r = app.app.test_client().post("/login", data={"username": "x", "password": "y"},
                                       headers={"Origin": "http://evil.example"})
        self.assertEqual(r.status_code, 403)


class TeamAndRoleTests(unittest.TestCase):
    def setUp(self):
        _testdb.reset()
        self.admin = setup_admin()
        add_user(self.admin, "boss1", roleId=2)
        add_user(self.admin, "boss2", roleId=2)
        add_user(self.admin, "ann", executiveId=user_id("boss1"))
        add_user(self.admin, "ben", executiveId=user_id("boss2"))
        import accounts
        self.mid = accounts.save_meeting(user_id("ann"), "ann.wav", {"speaker_transcript": LINES})

    def test_only_valid_teams_are_accepted(self):
        self.assertEqual(add_user(self.admin, "x1", roleId=3, executiveId=user_id("ann")).status_code, 400)  # leader not an executive
        self.assertEqual(add_user(self.admin, "x2", roleId=2, executiveId=user_id("boss1")).status_code, 400)  # executives have no leader
        self.assertEqual(add_user(self.admin, "x3", roleId=1).status_code, 400)  # no new admins via the API

    def test_executive_reads_own_team_only_and_cannot_edit(self):
        boss1, boss2 = sign_in("boss1"), sign_in("boss2")
        self.assertEqual([m["owner"] for m in boss1.get("/api/reports").get_json()], ["ann"])
        self.assertEqual(boss2.get("/api/reports").get_json(), [])
        self.assertEqual(boss1.get(f"/api/reports/{self.mid}").status_code, 200)
        self.assertEqual(boss2.get(f"/api/reports/{self.mid}").status_code, 404)
        self.assertEqual(post_json(boss1, "PATCH", f"/api/reports/{self.mid}", {"title": "x"}).status_code, 404)
        self.assertEqual(post_json(boss1, "DELETE", f"/api/reports/{self.mid}").status_code, 404)
        self.assertEqual(sign_in("ben").get(f"/api/reports/{self.mid}").status_code, 404)

    def test_owner_can_correct_rename_export_and_delete(self):
        ann = sign_in("ann")
        full = ann.get(f"/api/reports/{self.mid}").get_json()
        seg, spk = full["lines"][0]["id"], full["lines"][0]["speakerId"]
        self.assertEqual(post_json(ann, "PATCH", f"/api/reports/{self.mid}/segments/{seg}", {"text": "fixed"}).status_code, 200)
        self.assertEqual(post_json(ann, "PATCH", f"/api/reports/{self.mid}/speakers/{spk}", {"label": "Ann"}).status_code, 200)
        post_json(ann, "PATCH", f"/api/reports/{self.mid}", {"title": "Kickoff", "decisions": ["Ship it"],
                  "actionItems": [{"description": "Write docs", "responsiblePerson": "Ann", "deadline": "Friday"}]})
        full = ann.get(f"/api/reports/{self.mid}").get_json()
        self.assertEqual((full["title"], full["lines"][0]["text"], full["lines"][0]["speaker"]), ("Kickoff", "fixed", "Ann"))
        self.assertEqual((full["decisions"], full["actionItems"][0]["deadline"]), (["Ship it"], "Friday"))
        self.assertEqual(ann.get(f"/api/reports/{self.mid}/export?format=json").status_code, 200)
        self.assertEqual(ann.get(f"/api/reports/{self.mid}/export?format=docx").data[:2], b"PK")
        self.assertEqual(post_json(ann, "DELETE", f"/api/reports/{self.mid}").status_code, 200)
        self.assertEqual(ann.get(f"/api/reports/{self.mid}").status_code, 404)

    def test_admin_cannot_upload_and_role_change_releases_team(self):
        self.assertEqual(self.admin.post("/analyze", data={}).status_code, 403)
        post_json(self.admin, "PATCH", f"/api/admin/users/{user_id('boss1')}", {"roleId": 3})
        with connect() as conn:
            self.assertIsNone(conn.execute("SELECT executive_id FROM users WHERE username = 'ann'").fetchone()["executive_id"])

    def test_regenerate_uses_saved_transcript(self):
        from unittest.mock import patch
        ann = sign_in("ann")
        fake = {"summary": "new", "decisions": ["d"], "action_items": [{"description": "a", "responsible_person": "", "deadline": ""}]}
        with patch("accounts.generate_insights", return_value=fake) as gen:
            full = post_json(ann, "POST", f"/api/reports/{self.mid}/regenerate").get_json()
        self.assertIn("SPEAKER_00: hi", gen.call_args.args[0])
        self.assertEqual((full["summary"], full["decisions"]), ("new", ["d"]))


if __name__ == "__main__":
    unittest.main()
