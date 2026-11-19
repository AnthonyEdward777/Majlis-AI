
import os
import uuid
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr
import torch
from flask import Flask, g, jsonify, render_template, request, send_from_directory
from transformers import AutoProcessor, CohereAsrForConditionalGeneration
from transformers.audio_utils import mel_filter_bank
from transformers.models.cohere_asr import feature_extraction_cohere_asr
from werkzeug.utils import secure_filename

import eagle_diar
import accounts
from db import init_db
from insights import generate_insights
from alignment import (
    align_transcript_words,
    assign_speakers_to_words,
    group_words_by_speaker_turn,
)


# --------------------------------------------------
# Flask application and configuration
# --------------------------------------------------

app = Flask(__name__)

PROJECT_DIR = Path(__file__).resolve().parent

app.secret_key = accounts.load_secret_key(PROJECT_DIR)
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
init_db()
app.register_blueprint(accounts.bp)

UPLOAD_DIR = PROJECT_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

COHERE_MODEL_ID = "CohereLabs/cohere-transcribe-arabic-07-2026"

COHERE_MODEL_PATH = Path(
    os.environ.get(
        "COHERE_MODEL_PATH",
        str(
            PROJECT_DIR
            / "models"
            / "cohere-transcribe-arabic-07-2026"
        ),
    )
)

TRANSCRIPTION_LANGUAGE = os.environ.get("TRANSCRIPTION_LANGUAGE", "ar")  # the Arabic checkpoint was trained for "ar"
TRANSCRIBE_CHUNKS_PER_BATCH = 2  # audio chunks encoded together; raise it if you have spare RAM
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

MODEL_DTYPE = (
    torch.bfloat16 if DEVICE == "cuda" else torch.float32
)

SAMPLE_RATE = 16000

# EAGLE speaker enrollment limits (each person reads aloud for about 20 s).
MAX_SPEAKERS = 20
MIN_ENROLL_SECONDS = 3.0


# --------------------------------------------------
# Cohere audio feature-extraction compatibility
# --------------------------------------------------

class _NoNumbaLibrosa:
    """
    Cohere's feature extractor needs librosa.filters.mel.
    Use Transformers' mel filter implementation instead.
    """

    class filters:
        @staticmethod
        def mel(sr, n_fft, n_mels, fmin, fmax, norm):
            filters = mel_filter_bank(
                1 + n_fft // 2,
                n_mels,
                fmin,
                fmax,
                sr,
                norm=norm,
                mel_scale="slaney",
            )
            return filters.T.astype(np.float32)


feature_extraction_cohere_asr.librosa = _NoNumbaLibrosa


# --------------------------------------------------
# Audio loading for Cohere
# --------------------------------------------------

def load_audio(audio_path):
    """Load audio as mono, 16 kHz float32 audio."""

    audio, sample_rate = sf.read(
        audio_path,
        dtype="float32",
        always_2d=True,
    )

    # Convert stereo or multichannel audio to mono.
    audio = audio.mean(axis=1)

    # Resample when the input sample rate differs from 16 kHz.
    if sample_rate != SAMPLE_RATE:
        audio = soxr.resample(
            audio,
            sample_rate,
            SAMPLE_RATE,
        )

    return audio


# --------------------------------------------------
# Cohere ASR model
# --------------------------------------------------

@lru_cache(maxsize=1)
def get_transcription_components():
    """Load the Cohere processor and model once."""

    # Without a local copy, load from the Hugging Face cache (still offline).
    model_source = (
        COHERE_MODEL_PATH
        if COHERE_MODEL_PATH.is_dir()
        else COHERE_MODEL_ID
    )

    processor = AutoProcessor.from_pretrained(
    model_source,
    token=True,
    )

    model = CohereAsrForConditionalGeneration.from_pretrained(
    model_source,
    dtype=MODEL_DTYPE,
    token=True,
    )

    model = model.to(DEVICE).eval()

    return processor, model


def transcribe_audio(audio_path):
    """Transcribe the meeting audio using Cohere."""

    processor, model = get_transcription_components()

    audio = load_audio(audio_path)

    inputs = processor(
        audio,
        sampling_rate=SAMPLE_RATE,
        return_tensors="pt",
        language=TRANSCRIPTION_LANGUAGE,
    )

    audio_chunk_index = inputs.pop("audio_chunk_index", None)

    inputs = inputs.to(
        model.device,
        dtype=model.dtype,
    )

    # Long audio arrives as many chunks. Encoding them all at once needs memory
    # proportional to the recording length, so run a couple at a time.
    pieces = []
    with torch.inference_mode():
        for start in range(0, len(inputs["input_features"]), TRANSCRIBE_CHUNKS_PER_BATCH):
            batch = {
                name: value[start:start + TRANSCRIBE_CHUNKS_PER_BATCH]
                for name, value in inputs.items()
            }
            pieces.append(model.generate(**batch, max_new_tokens=448))

    if len(pieces) == 1:
        output_tokens = pieces[0]
    else:
        # Batches can stop at different lengths: pad to one width, then stack.
        width = max(piece.shape[1] for piece in pieces)
        output_tokens = torch.cat([
            torch.nn.functional.pad(
                piece, (0, width - piece.shape[1]), value=model.config.pad_token_id
            )
            for piece in pieces
        ])

    if audio_chunk_index is not None:
        decoded = processor.decode(
            output_tokens,
            skip_special_tokens=True,
            audio_chunk_index=audio_chunk_index,
            language=TRANSCRIPTION_LANGUAGE,
        )
    else:
        decoded = processor.decode(
            output_tokens,
            skip_special_tokens=True,
        )

    if isinstance(decoded, list):
        return " ".join(
            text.strip() for text in decoded
        ).strip()

    return decoded.strip()


# --------------------------------------------------
# EAGLE speaker diarization (enrolled voices)
# --------------------------------------------------

def diarize_audio(audio_path, enrollment_paths):
    """Return speaker turns with start/end timestamps.

    enrollment_paths maps each speaker's name to a short recording of
    their voice; every detected turn is labelled with one of those names.
    """

    enrollments = {
        name: load_audio(path)
        for name, path in enrollment_paths.items()
    }

    for name, sample in enrollments.items():
        if len(sample) < MIN_ENROLL_SECONDS * SAMPLE_RATE:
            raise ValueError(
                f"The voice sample for {name} is shorter than "
                f"{MIN_ENROLL_SECONDS:g} seconds."
            )

    return eagle_diar.diarize(
        load_audio(audio_path),
        enrollments,
        eagle_diar.make_embedder(torch.device(DEVICE)),
    )


def read_enrollment_form(form, files):
    """Read speaker names and voice samples from the upload form.

    Returns (speakers, error). speakers is a list of (name, file).
    """

    names = [name.strip() for name in form.getlist("speaker_name")]
    samples = files.getlist("speaker_sample")

    if not names:
        return None, "Record a voice sample for at least one speaker."

    if len(names) > MAX_SPEAKERS:
        return None, f"At most {MAX_SPEAKERS} speakers are supported."

    if len(samples) != len(names) or not all(s and s.filename for s in samples):
        return None, "Every speaker needs a recorded voice sample."

    if not all(names):
        return None, "Every speaker needs a name."

    if len({name.casefold() for name in names}) != len(names):
        return None, "Speaker names must be different."

    return list(zip(names, samples)), None


# --------------------------------------------------
# Flask pages and JavaScript
# --------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/script.js")
def script():
    return send_from_directory(
        str(PROJECT_DIR / "templates"),
        "script.js",
    )


# --------------------------------------------------
# Main meeting-analysis endpoint
# --------------------------------------------------

@app.route("/analyze", methods=["POST"])
@accounts.member_required
def analyze():
    file = request.files.get("audio")

    if not file or not file.filename:
        return jsonify({
            "error": "No audio file uploaded."
        }), 400

    # EAGLE needs every speaker's name and a short voice sample.
    speakers, error = read_enrollment_form(request.form, request.files)

    if error:
        return jsonify({"error": error}), 400

    # Generate a unique filename for the uploaded recording.
    extension = Path(
        secure_filename(file.filename)
    ).suffix

    filepath = UPLOAD_DIR / f"{uuid.uuid4().hex}{extension}"
    enrollment_paths = {}

    try:
        file.save(filepath)

        for name, sample in speakers:
            sample_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.wav"
            enrollment_paths[name] = sample_path
            sample.save(sample_path)

        # Validate: the file must be readable audio that is not empty.
        try:
            info = sf.info(filepath)
        except Exception:
            return jsonify({"error": "That file isn't readable audio. Upload a WAV or MP3 recording."}), 400
        if info.frames == 0:
            return jsonify({"error": "The recording is empty."}), 400

        # ------------------------------------------
        # Step 1: Transcribe with Cohere
        # ------------------------------------------

        transcript = transcribe_audio(filepath)

        # ------------------------------------------
        # Step 2: Detect speaker turns with EAGLE
        # ------------------------------------------

        speaker_segments = diarize_audio(filepath, enrollment_paths)

        # ------------------------------------------
        # Step 3: Summary, decisions and action items from the local LLM
        # ------------------------------------------

        # The model returns only these small fields, never the transcript itself:
        # asking it to rewrite the whole transcript made long recordings loop.
        insights = generate_insights(transcript)

        result = {
            "summary": insights["summary"],
            "decisions": insights["decisions"],
            "action_items": insights["action_items"],
            # Fallback display when word alignment fails.
            "transcript": [
                {"speaker": "UNKNOWN", "text": transcript}
            ],
        }

        # ------------------------------------------
        # Step 4: Align transcript words with audio
        # ------------------------------------------

        try:
            alignment_result = align_transcript_words(
                filepath,
                transcript,
            )

            # --------------------------------------
            # Step 5: Match words to speaker turns
            # --------------------------------------

            aligned_words = assign_speakers_to_words(
                alignment_result["words"],
                speaker_segments,
            )

            # --------------------------------------
            # Step 6: Group words by speaker turn
            # --------------------------------------

            result["speaker_transcript"] = (
                group_words_by_speaker_turn(
                    aligned_words,
                    speaker_segments,
                )
            )

            # Keep word-level results available for validation.
            result["word_alignment"] = (
                alignment_result["words"]
            )

            if alignment_result["skipped_words"]:
                result["alignment_warning"] = (
                    "Some transcript words could not be normalized: "
                    + ", ".join(
                        alignment_result["skipped_words"]
                    )
                )

        except Exception as error:
            # Alignment failure should not discard the summary.
            app.logger.exception(
                "Word alignment failed"
            )

            result["alignment_error"] = (
                f"{type(error).__name__}: {error}"
            )

            result["speaker_transcript"] = []

        # Preserve the original EAGLE segments and the enrolled names.
        result["speaker_segments"] = speaker_segments
        result["speakers"] = list(enrollment_paths)

        # Save for the signed-in user; a database error must not discard the analysis.
        try:
            result["meeting_id"] = accounts.save_meeting(g.user["id"], file.filename, result)
        except Exception:
            app.logger.exception("Saving the meeting failed")

        return jsonify(result)

    except Exception as error:
        # Report other analysis errors to the frontend.
        app.logger.exception(
            "Meeting analysis failed"
        )

        return jsonify({
            "error": f"{type(error).__name__}: {error}"
        }), 500

    finally:
        # Delete the temporary recording and voice samples.
        filepath.unlink(missing_ok=True)

        for sample_path in enrollment_paths.values():
            sample_path.unlink(missing_ok=True)


# --------------------------------------------------
# Run the Flask application
# --------------------------------------------------

if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)))
