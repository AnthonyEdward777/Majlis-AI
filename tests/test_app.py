import importlib
import io
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import _testdb

app = importlib.import_module("app")

PASSWORD = "correct-horse-battery"


def wav_bytes(seconds=0.1):
    """A tiny but valid WAV file (uploads are validated)."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buffer.getvalue()


def logged_in_client():
    """A client signed in as a Normal User (Admins can't upload); every route needs a login."""
    _testdb.reset()
    admin = app.app.test_client()
    admin.post("/register", data={"username": "boss", "password": PASSWORD, "confirm": PASSWORD})
    admin.post("/api/admin/users", json={"username": "tester", "password": PASSWORD, "roleId": 3})
    client = app.app.test_client()
    client.post("/login", data={"username": "tester", "password": PASSWORD})
    return client


class FakeInputs(dict):
    def to(self, *_args, **_kwargs):
        return self


class CohereTranscriptionTests(unittest.TestCase):
    def test_transcribe_audio_returns_decoded_local_cohere_text(self):
        self.assertTrue(hasattr(app, "transcribe_audio"))

        processor = MagicMock()
        processor.return_value = FakeInputs(input_features=["audio-features"])
        processor.decode.return_value = "هذا اجتماع تجريبي"
        model = SimpleNamespace(device="cpu", dtype="float32", generate=MagicMock(return_value="tokens"))

        with (
            patch.object(app, "get_transcription_components", return_value=(processor, model)),
            patch.object(app, "load_audio", return_value=[0.1, 0.2]),
        ):
            transcription = app.transcribe_audio("meeting.wav")

        self.assertEqual(transcription, "هذا اجتماع تجريبي")
        processor.assert_called_once_with(
            [0.1, 0.2], sampling_rate=16000, return_tensors="pt", language="ar"
        )
        model.generate.assert_called_once_with(
            input_features=["audio-features"], max_new_tokens=448
        )

    def test_long_audio_chunks_are_encoded_two_at_a_time(self):
        processor = MagicMock()
        processor.return_value = FakeInputs(
            input_features=list("abcde"), audio_chunk_index=[(0, i) for i in range(5)]
        )
        processor.decode.return_value = "نص"
        generate = MagicMock(return_value=SimpleNamespace(shape=(1, 7)))
        model = SimpleNamespace(
            device="cpu", dtype="float32", generate=generate, config=SimpleNamespace(pad_token_id=2)
        )

        with (
            patch.object(app, "get_transcription_components", return_value=(processor, model)),
            patch.object(app, "load_audio", return_value=[0.1]),
        ):
            app.transcribe_audio("long.wav")

        self.assertEqual([c.kwargs["input_features"] for c in generate.call_args_list],
                         [["a", "b"], ["c", "d"], ["e"]])


class AnalyzeRouteTests(unittest.TestCase):
    def test_upload_is_saved_inside_upload_dir_and_removed_on_error(self):
        saved_paths = []

        def fake_transcribe(path):
            saved_paths.append(path)
            self.assertTrue(path.exists())
            raise RuntimeError("transcription failed")

        client = logged_in_client()
        with patch.object(app, "transcribe_audio", side_effect=fake_transcribe):
            response = client.post(
                "/analyze",
                data={
                    "audio": (io.BytesIO(wav_bytes()), "../../evil.wav"),
                    "speaker_name": "Anthony",
                    "speaker_sample": (io.BytesIO(b"voice"), "speaker-1.wav"),
                },
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(saved_paths[0].parent, app.UPLOAD_DIR)
        self.assertEqual(saved_paths[0].suffix, ".wav")
        self.assertFalse(saved_paths[0].exists())

    def test_unreadable_or_empty_audio_returns_400(self):
        client = logged_in_client()
        with patch.object(app, "transcribe_audio") as transcribe:
            bad = client.post("/analyze", data={"audio": (io.BytesIO(b"not audio"), "a.wav")})
            empty = client.post("/analyze", data={"audio": (io.BytesIO(wav_bytes(0)), "a.wav")})
        self.assertEqual((bad.status_code, empty.status_code), (400, 400))
        transcribe.assert_not_called()

    def test_missing_file_returns_400(self):
        response = logged_in_client().post("/analyze", data={})
        self.assertEqual(response.status_code, 400)

    def test_missing_voice_samples_returns_400(self):
        response = logged_in_client().post(
            "/analyze",
            data={"audio": (io.BytesIO(wav_bytes()), "a.wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_invalid_enrollment_returns_400(self):
        cases = {
            "blank name": [("", "x.wav")],
            "duplicate names": [("Zein", "x.wav"), ("zein", "y.wav")],
            "name without sample": [("Malek", None)],
        }
        for label, speakers in cases.items():
            data = {"audio": (io.BytesIO(wav_bytes()), "a.wav"), "speaker_name": [], "speaker_sample": []}
            for name, sample in speakers:
                data["speaker_name"].append(name)
                if sample:
                    data["speaker_sample"].append((io.BytesIO(b"voice"), sample))
            response = logged_in_client().post("/analyze", data=data)
            self.assertEqual(response.status_code, 400, label)

    def test_enrolled_voices_are_passed_to_diarization_and_removed(self):
        seen = {}

        def fake_diarize(path, enrollment_paths):
            seen.update(enrollment_paths)
            for sample_path in enrollment_paths.values():
                self.assertTrue(sample_path.exists())
                self.assertEqual(sample_path.parent, app.UPLOAD_DIR)
            raise RuntimeError("stop here")

        with (
            patch.object(app, "transcribe_audio", return_value="x"),
            patch.object(app, "diarize_audio", side_effect=fake_diarize),
        ):
            response = logged_in_client().post(
                "/analyze",
                data={
                    "audio": (io.BytesIO(wav_bytes()), "a.wav"),
                    "speaker_name": ["Anthony", "Vincent"],
                    "speaker_sample": [
                        (io.BytesIO(b"voice 1"), "speaker-1.wav"),
                        (io.BytesIO(b"voice 2"), "speaker-2.wav"),
                    ],
                },
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(list(seen), ["Anthony", "Vincent"])
        self.assertFalse(any(p.exists() for p in seen.values()))

    def test_short_voice_sample_is_rejected(self):
        with patch.object(app, "load_audio", return_value=[0.0] * 16000):
            with self.assertRaises(ValueError):
                app.diarize_audio("meeting.wav", {"Zein": "zein.wav"})


    def test_successful_analysis_is_saved_with_speaker_turns(self):
        turns = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 2.5, "text": "مرحبا"},
            {"speaker": "SPEAKER_01", "start": 2.5, "end": 5.0, "text": "أهلا"},
        ]
        client = logged_in_client()
        with (
            patch.object(app, "transcribe_audio", return_value="مرحبا أهلا"),
            patch.object(app, "diarize_audio", return_value=[]),
            patch.object(app, "generate_insights", return_value={"summary": "ملخص", "decisions": ["نقرر"], "action_items": [{"description": "مهمة", "responsible_person": "سارة", "deadline": "الخميس"}]}),
            patch.object(app, "align_transcript_words", return_value={"words": [], "skipped_words": []}),
            patch.object(app, "assign_speakers_to_words", return_value=[]),
            patch.object(app, "group_words_by_speaker_turn", return_value=turns),
        ):
            response = client.post("/analyze", data={
                "audio": (io.BytesIO(wav_bytes()), "standup.wav"),
                "speaker_name": ["Sara", "Omar"],
                "speaker_sample": [(io.BytesIO(b"v1"), "s1.wav"), (io.BytesIO(b"v2"), "s2.wav")],
            },
        )

        self.assertEqual(response.status_code, 200)
        meeting_id = response.get_json()["meeting_id"]
        saved = client.get(f"/api/reports/{meeting_id}").get_json()
        self.assertEqual(saved["fileName"], "standup.wav")
        self.assertEqual(saved["speakers"], 2)
        self.assertEqual(saved["decisions"], ["نقرر"])
        self.assertEqual(saved["actionItems"][0]["responsiblePerson"], "سارة")
        self.assertEqual(saved["title"], "standup")
        self.assertEqual(saved["duration"], 5.0)
        self.assertEqual([(l["speaker"], l["start"], l["text"]) for l in saved["lines"]],
                         [("SPEAKER_00", 0.0, "مرحبا"), ("SPEAKER_01", 2.5, "أهلا")])


class SpellOutNumbersTests(unittest.TestCase):
    def test_numbers_become_arabic_words(self):
        from alignment import spell_out_numbers

        self.assertEqual(spell_out_numbers("57"), "سبعة و خمسون")
        self.assertEqual(spell_out_numbers("كلمة"), "كلمة")
        # Phone-style numbers are read digit by digit.
        self.assertEqual(spell_out_numbers("012"), "صفر واحد اثنان")


if __name__ == "__main__":
    unittest.main()
