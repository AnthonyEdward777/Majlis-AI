import importlib
import sys
import unittest
from unittest.mock import MagicMock

import numpy as np

# The model itself is not needed: these tests use a fake embedder.
sys.modules.setdefault("torch", MagicMock())

eagle_diar = importlib.import_module("eagle_diar")

SR = eagle_diar.SAMPLE_RATE


def tone(seconds, freq, level=0.1):
    t = np.arange(int(seconds * SR)) / SR
    return (level * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def silence(seconds):
    return np.zeros(int(seconds * SR), dtype=np.float32)


def pitch_embedder(chunks):
    """Fake 'voice' embedding: which of two tones dominates the chunk."""
    rows = []
    for c in chunks:
        spectrum = np.abs(np.fft.rfft(c))
        freqs = np.fft.rfftfreq(len(c), 1 / SR)
        low = spectrum[(freqs > 150) & (freqs < 250)].sum()
        high = spectrum[(freqs > 550) & (freqs < 650)].sum()
        v = np.array([low, high]) + 1e-9
        rows.append(v / np.linalg.norm(v))
    return np.stack(rows)


class EnergyRegionTests(unittest.TestCase):
    def test_finds_speech_and_drops_short_bumps(self):
        audio = np.concatenate([silence(1), tone(2, 200), silence(1), tone(0.2, 200), silence(1)])
        regions = eagle_diar.energy_regions(audio)
        self.assertEqual(len(regions), 1)
        start, end = regions[0]
        self.assertAlmostEqual(start, 1.0, places=1)
        self.assertAlmostEqual(end, 3.0, places=1)

    def test_bridges_tiny_gaps(self):
        audio = np.concatenate([tone(1, 200), silence(0.2), tone(1, 200)])
        self.assertEqual(len(eagle_diar.energy_regions(audio)), 1)

    def test_silence_and_empty_audio(self):
        self.assertEqual(eagle_diar.energy_regions(silence(3)), [])
        self.assertEqual(eagle_diar.energy_regions(np.zeros(10, dtype=np.float32)), [])


class WindowTests(unittest.TestCase):
    def test_sliding_windows_cover_region_with_listening_windows_inside(self):
        units = eagle_diar.sliding_windows(10.0, 15.0)
        self.assertAlmostEqual(units[0][0], 10.0)
        self.assertAlmostEqual(units[-1][1], 15.0)
        for a, b, ls, le in units:
            self.assertGreaterEqual(ls, 10.0 - 1e-9)
            self.assertLessEqual(le, 15.0 + 1e-9)
            self.assertAlmostEqual(le - ls, 2.0)

    def test_short_region_is_heard_whole(self):
        for _, _, ls, le in eagle_diar.sliding_windows(3.0, 4.0):
            self.assertEqual((ls, le), (3.0, 4.0))

    def test_merge_same_speaker_bridges_small_gaps_only(self):
        merged = eagle_diar.merge_same_speaker([(0, 1, "A"), (2, 3, "A"), (5, 6, "A"), (6, 7, "B")])
        self.assertEqual(merged, [(0, 3, "A"), (5, 6, "A"), (6, 7, "B")])


class DiarizeTests(unittest.TestCase):
    def test_labels_each_turn_with_the_enrolled_name(self):
        meeting = np.concatenate([silence(0.5), tone(4, 200), silence(2), tone(4, 600), silence(0.5)])
        enrollments = {"Zein": tone(5, 200), "Malek": tone(5, 600)}

        segments = eagle_diar.diarize(meeting, enrollments, pitch_embedder)

        self.assertEqual([s["speaker"] for s in segments], ["Zein", "Malek"])
        self.assertAlmostEqual(segments[0]["start"], 0.6, delta=0.2)
        self.assertAlmostEqual(segments[0]["end"], 4.5, delta=0.2)
        self.assertAlmostEqual(segments[1]["start"], 6.5, delta=0.2)

    def test_needs_an_enrolled_speaker(self):
        with self.assertRaises(ValueError):
            eagle_diar.diarize(tone(3, 200), {}, pitch_embedder)


if __name__ == "__main__":
    unittest.main()
