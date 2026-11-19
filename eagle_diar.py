"""EAGLE-Diar: energy-guided, enrollment-based speaker diarization.

Ported from the graduation-project benchmark (diar-bench/run_eagle.py) with the
best benchmarked settings, "eagle_slide05" (10.0 % DER on the ESLSCA Arabic
diarization benchmark, against 24.4 % for pyannote community-1):

  16 kHz mono; 0.2 s energy frames; speech if frame RMS > -55 dBFS; merge
  bumps separated by <= 0.2 s; keep bumps >= 0.5 s; label every 0.5 s step
  from a 2 s listening window centred on it; embed each window with
  ReDimNet2-B6; give it the most similar (cosine) enrolled speaker; join
  same-speaker segments separated by <= 1.2 s.

Unlike pyannote, EAGLE needs a voice sample of every speaker (about 20 s each)
before it can diarize. It never invents speakers: every speech region is
labelled with one of the enrolled names.
"""

from __future__ import annotations

import os
from functools import lru_cache

import numpy as np
import torch

SAMPLE_RATE = 16000

FRAME_SECONDS = 0.2
THRESHOLD_DB = -55.0
MERGE_GAP = 0.2
MIN_BUMP = 0.5
WINDOW = 2.0
HOP = 0.5
BRIDGE = 1.2
BATCH = 64

REDIMNET_MODEL = os.environ.get("EAGLE_MODEL", "b6")


# --------------------------------------------------
# Voice activity (energy gate) and windows
# --------------------------------------------------

def energy_regions(audio, frame_s=FRAME_SECONDS, threshold_db=THRESHOLD_DB,
                   merge_gap=MERGE_GAP, min_len=MIN_BUMP):
    """Return (start, end) speech regions in seconds from frame energy."""

    n = int(frame_s * SAMPLE_RATE)
    m = len(audio) // n
    if m == 0:
        return []

    frames = np.asarray(audio[: m * n], dtype=np.float64).reshape(m, n)
    db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-12)
    active = db > threshold_db

    regions, start = [], None
    for i, is_active in enumerate(np.append(active, False)):
        if is_active and start is None:
            start = i
        elif not is_active and start is not None:
            regions.append([start * frame_s, i * frame_s])
            start = None

    merged = []
    for s, e in regions:
        if merged and s - merged[-1][1] <= merge_gap + 1e-9:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    return [(s, e) for s, e in merged if e - s >= min_len - 1e-9]


def split_windows(s, e, win):
    """Split [s, e] into about win-long, non-overlapping windows."""

    n = max(1, int(round((e - s) / win)))
    edges = np.linspace(s, e, n + 1)
    return list(zip(edges[:-1], edges[1:]))


def sliding_windows(s, e, win=WINDOW, hop=HOP):
    """Label hop-sized steps, each heard through a win-long window centred on it.

    Returns (label_start, label_end, listen_start, listen_end). Listening
    windows stay inside the region; a region shorter than win is heard whole.
    """

    out = []
    for a, b in split_windows(s, e, hop):
        if e - s <= win:
            ws = s
        else:
            ws = min(max((a + b) / 2 - win / 2, s), e - win)
        out.append((a, b, ws, min(ws + win, e)))
    return out


def merge_same_speaker(segs, max_gap=BRIDGE):
    """Join consecutive same-speaker segments separated by at most max_gap seconds."""

    out = []
    for s, e, spk in sorted(segs):
        if out and out[-1][2] == spk and s - out[-1][1] <= max_gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e, spk])
    return [tuple(x) for x in out]


# --------------------------------------------------
# ReDimNet2 speaker embeddings
# --------------------------------------------------

@lru_cache(maxsize=1)
def get_embedding_model(device):
    """Load ReDimNet2 once (downloaded through torch.hub on first use)."""

    model = torch.hub.load(
        "PalabraAI/redimnet2",
        "redimnet2",
        model_name=REDIMNET_MODEL,
        train_type="lm",
        dataset="vox2",
        pretrained=True,
        trust_repo=True,  # the official ReDimNet2 repo; avoids an interactive prompt
    )
    return model.to(device).eval()


def make_embedder(device):
    """Return embed(chunks) -> L2-normalised (n, dim) array for equal-length chunks."""

    model = get_embedding_model(device)

    def embed(chunks):
        out = []
        with torch.inference_mode():
            for i in range(0, len(chunks), BATCH):
                x = torch.from_numpy(
                    np.stack(chunks[i: i + BATCH]).astype(np.float32)
                ).to(device)
                emb = torch.nn.functional.normalize(model(x).float(), dim=-1)
                out.append(emb.cpu().numpy())
        return np.concatenate(out)

    return embed


# --------------------------------------------------
# Diarization
# --------------------------------------------------

def diarize(audio, enrollments, embed):
    """Diarize 16 kHz mono audio against enrolled voices.

    enrollments: {speaker name: 16 kHz mono voice sample}, in display order.
    embed: function from a list of equal-length chunks to an (n, dim) array of
    L2-normalised embeddings, so a dot product is the cosine similarity.
    Returns [{"start", "end", "speaker"}] sorted by time.
    """

    names = list(enrollments)
    if not names:
        raise ValueError("EAGLE needs at least one enrolled speaker.")

    enroll = np.concatenate([embed([enrollments[name]]) for name in names])

    segs = []
    for s, e in energy_regions(audio):
        units = sliding_windows(s, e)

        # Listening windows inside one region have equal length up to a
        # sample; trim them to the shortest so they batch together.
        length = min(
            int(round(le * SAMPLE_RATE)) - int(round(ls * SAMPLE_RATE))
            for _, _, ls, le in units
        )
        if length < int(0.1 * SAMPLE_RATE):
            continue

        chunks = [
            audio[int(round(ls * SAMPLE_RATE)): int(round(ls * SAMPLE_RATE)) + length]
            for _, _, ls, _ in units
        ]
        labels = (embed(chunks) @ enroll.T).argmax(axis=1).tolist()
        segs += [(a, b, names[k]) for (a, b, _, _), k in zip(units, labels)]

    return [
        {"start": round(float(s), 2), "end": round(float(e), 2), "speaker": spk}
        for s, e, spk in merge_same_speaker(segs)
    ]
