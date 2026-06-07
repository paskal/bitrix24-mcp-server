#!/usr/bin/env python3
"""Max-quality call transcription — GigaAM + Whisper(antihall+hotwords) + pyannote diarization.

Returns BOTH transcripts plus speaker-tagged segments as JSON, for the calling model to reconcile
(take Whisper for punctuation/proper-nouns, GigaAM as the hallucination-free backbone, assign
Менеджер/Клиент per speaker from content). This script does NOT call an LLM — the reconcile is
the caller's job.

Heavy deps: faster-whisper, gigaam, pyannote.audio, soundfile, torch. Point B24_MAX_PYTHON at a
venv that has them. Needs HF_TOKEN env + the pyannote gated models accepted by that token's account.

Output: a single JSON object on stdout. On any setup problem it is {"error","error_type"} so the
MCP can surface a clear, actionable message. error_type ∈
  missing_hf_token | missing_deps | model_not_approved | bad_args | runtime_error
"""
import os, sys, json, re, tempfile


def fail(error_type, msg):
    print(json.dumps({"error": msg, "error_type": error_type}, ensure_ascii=False))
    sys.exit(0)


HF = os.environ.get("HF_TOKEN", "").strip()
if not HF:
    fail("missing_hf_token",
         "HF_TOKEN is not set. The max pipeline needs a HuggingFace token for pyannote diarization. "
         "Create a free token at https://huggingface.co/settings/tokens, then accept the model terms "
         "at https://huggingface.co/pyannote/speaker-diarization-community-1 and "
         "https://huggingface.co/pyannote/segmentation-3.0 with that account, and set HF_TOKEN.")

if len(sys.argv) < 2:
    fail("bad_args", "usage: transcribe_max.py <audio-file>")
audio = sys.argv[1]

DOMAIN = ("мансардное окно, Факро, Велюкс, фальцевая кровля, металлочерепица, снегозадержатели, "
          "водосток, оклад, профнастил, чердачная лестница, кликфальц, фальцевая кровля")
# brand normalisation — both engines mangle these; canonical form on the right.
# applied to BOTH transcripts (Whisper writes "V-LUX", GigaAM writes "вилюкс" — both → Velux).
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
    from faster_whisper import WhisperModel
    import gigaam
    from pyannote.audio import Pipeline
    import torch
except Exception as e:  # noqa: BLE001
    fail("missing_deps",
         f"max-pipeline Python deps missing ({e}). Need: faster-whisper gigaam pyannote.audio "
         "soundfile torch. Point B24_MAX_PYTHON at a venv that has them.")


def whisper_pass():
    m = WhisperModel("large-v3", "cpu", compute_type="int8")
    segs, _ = m.transcribe(audio, language="ru", beam_size=5,
                           condition_on_previous_text=False, hotwords=DOMAIN)
    return [(float(s.start), float(s.end), s.text.strip()) for s in segs]


def gigaam_pass():
    g = gigaam.load_model("v2_rnnt")
    a, sr = sf.read(audio, dtype="float32")
    if getattr(a, "ndim", 1) > 1:
        a = a[:, 0]
    parts = []
    for i in range(0, len(a), 20 * sr):
        sf.write("/tmp/_gmax.wav", a[i:i + 20 * sr], sr)
        try:
            parts.append(g.transcribe("/tmp/_gmax.wav"))
        except Exception:  # noqa: BLE001
            pass
    return brand_normalize(" ".join(parts))


def diarize():
    try:
        pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=HF)
    except Exception as e:  # noqa: BLE001
        m = str(e).lower()
        if any(x in m for x in ("gated", "restricted", "401", "403", "awaiting", "authorized", "access")):
            fail("model_not_approved",
                 "The pyannote diarization model is not approved for this HF token. Accept the terms "
                 "at https://huggingface.co/pyannote/speaker-diarization-community-1 and "
                 "https://huggingface.co/pyannote/segmentation-3.0 with the account that owns the token.")
        fail("runtime_error", f"pyannote load failed: {e}")
    if pipe is None:
        fail("model_not_approved",
             "pyannote returned no pipeline — the token lacks access. Accept the model terms at "
             "https://huggingface.co/pyannote/speaker-diarization-community-1.")
    pipe.to(torch.device("cpu"))
    out = pipe(audio, num_speakers=2)
    ann = getattr(out, "speaker_diarization", out)
    return [(round(s.start, 1), round(s.end, 1), lbl) for s, _, lbl in ann.itertracks(yield_label=True)]


try:
    w = whisper_pass()
    g = gigaam_pass()
    turns = diarize()
except SystemExit:
    raise
except Exception as e:  # noqa: BLE001
    fail("runtime_error", f"max pipeline failed: {e}")


def speaker_at(mid):
    for s, e, l in turns:
        if s <= mid <= e:
            return l
    return min(turns, key=lambda x: abs((x[0] + x[1]) / 2 - mid))[2] if turns else "?"


segments = [{"start": round(s, 1), "speaker": speaker_at(s + 0.4), "text": brand_normalize(t)} for s, e, t in w]
print(json.dumps({
    "whisper_text": brand_normalize(" ".join(t for _, _, t in w)),
    "gigaam_text": g,
    "segments": segments,
    "speakers": sorted({t[2] for t in turns}),
    "reconcile_hint": ("Two transcripts + acoustic speaker turns. Reconcile: keep Whisper for "
                       "punctuation and proper nouns; trust GigaAM where Whisper diverges into "
                       "non-Russian garbage (hallucination); assign Менеджер/Клиент per speaker "
                       "from dialogue content and fix any diarization turn-flips."),
}, ensure_ascii=False))
