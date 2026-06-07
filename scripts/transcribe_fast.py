#!/usr/bin/env python3
"""Fast call transcription — GigaAM v2 only (Russian-native RNNT).

The fastest tier: one model, ~5x real-time on CPU (RTF ~0.2), never hallucinates, gets Russian
domain terms right. Trade-off vs the default Whisper tier: raw lowercase, minimal punctuation, no
speaker labels. Use when you want the gist quickly/cheaply and don't need Whisper's punctuation or
the max tier's dual-transcript + diarization.

Single light dep set: gigaam + soundfile + torch (no pyannote, no HF token, no whisper). Point
B24_FAST_PYTHON at a venv that has them.

Output: a single JSON object on stdout. On any setup problem it is {"error","error_type"} so the
MCP can surface a clear message. error_type ∈ missing_deps | bad_args | runtime_error
"""
import os, sys, json, re


def fail(error_type, msg):
    print(json.dumps({"error": msg, "error_type": error_type}, ensure_ascii=False))
    sys.exit(0)


if len(sys.argv) < 2:
    fail("bad_args", "usage: transcribe_fast.py <audio-file>")
audio = sys.argv[1]

# brand normalisation — GigaAM writes "вилюкс"/"факра"; canonical form on the right.
BRANDS = {
    r"\bфест групп\b": "ФС-Групп",
    r"\bвилюкс\w*": "Velux", r"\bv[-\s]?lux\b": "Velux", r"\bвелюкс\w*": "Velux",
    r"\bфакра\b": "Факро", r"\bfakr\w*": "Факро",
}


def brand_normalize(text):
    for pat, repl in BRANDS.items():
        text = re.sub(pat, repl, text, flags=re.I)
    return text


try:
    import soundfile as sf
    import gigaam
except Exception as e:  # noqa: BLE001
    fail("missing_deps",
         f"fast-pipeline Python deps missing ({e}). Need: gigaam soundfile torch. "
         "Point B24_FAST_PYTHON at a venv that has them.")

try:
    g = gigaam.load_model("v2_rnnt")
    a, sr = sf.read(audio, dtype="float32")
    if getattr(a, "ndim", 1) > 1:
        a = a[:, 0]
    parts = []
    # GigaAM's RNNT export caps at ~20s of audio per call → chunk.
    for i in range(0, len(a), 20 * sr):
        sf.write("/tmp/_gfast.wav", a[i:i + 20 * sr], sr)
        try:
            parts.append(g.transcribe("/tmp/_gfast.wav"))
        except Exception:  # noqa: BLE001
            pass
    text = brand_normalize(" ".join(p for p in parts if p).strip())
except Exception as e:  # noqa: BLE001
    fail("runtime_error", f"fast pipeline failed: {e}")

print(json.dumps({"text": text, "engine": "gigaam-v2-rnnt"}, ensure_ascii=False))
