import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Runs in a fresh interpreter: the other test modules replace torch with a mock.
SCRIPT = """
import torch
import alignment as A

class LocalModel:
    # One output frame per 320 samples, depending only on those samples (like a purely local model).
    def __call__(self, x):
        frames = x.shape[1] // 320
        return x[:, : frames * 320].reshape(1, frames, 320).mean(-1, keepdim=True), None

wave = torch.arange(100 * 16000, dtype=torch.float32).unsqueeze(0) % 977
model = LocalModel()
whole = A.compute_emissions(model, wave, "cpu")          # 100 s: windowed by default (30 s windows)
single = model(wave)[0]
assert whole.shape == single.shape, (whole.shape, single.shape)
assert torch.equal(whole, single)

A.WINDOW_SAMPLES, A.CONTEXT_SAMPLES = 7 * 16000, 16000   # odd window size, partial last window
assert torch.equal(A.compute_emissions(model, wave, "cpu"), single)
print("ok")
"""


class WindowedEmissionsTests(unittest.TestCase):
    def test_windowed_emissions_equal_single_pass(self):
        result = subprocess.run(
            [sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {str(ROOT)!r})\n{SCRIPT}"],
            capture_output=True, text=True, timeout=300,
        )
        self.assertEqual(result.stdout.strip(), "ok", result.stderr[-800:])


if __name__ == "__main__":
    unittest.main()
