#!/usr/bin/env python3
"""Persistent local Whisper transcription worker for Bitrix24 call recordings.

Loads faster-whisper ONCE, then transcribes audio files fed as line-delimited JSON
on stdin — so the (slow) model load is amortised across every call, not paid per call.
Fully offline: audio never leaves the machine. faster-whisper decodes mp3/wav itself
(bundled PyAV), so no system ffmpeg is required.

Protocol — stdout carries ONLY line-delimited JSON; all logs go to stderr:
  on startup:   {"ready": true, "model": "<name>"}        (or {"fatal": "..."} then exit)
  per request:  {"id": <n>, "text": "...", "segments": [{"start": <sec>, "text": "..."}]}
                {"id": <n>, "error": "..."}
  stdin (one JSON per line): {"id": <n>, "path": "/abs/audio.mp3"}

Env:
  B24_WHISPER_MODEL        model name/size (default "large-v3")
  B24_WHISPER_COMPUTE      ctranslate2 compute type (default "int8")
  B24_WHISPER_LANG         language hint (default "ru"); empty = autodetect
  B24_WHISPER_CPU_THREADS  threads per worker (default 0 = ctranslate2 auto)
"""
import sys
import os
import json


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    model_name = os.environ.get("B24_WHISPER_MODEL", "large-v3")
    compute = os.environ.get("B24_WHISPER_COMPUTE", "int8")
    lang = os.environ.get("B24_WHISPER_LANG", "ru") or None
    threads = int(os.environ.get("B24_WHISPER_CPU_THREADS", "0"))

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        emit({"fatal": f"faster-whisper not importable: {e}"})
        return 3

    log(f"loading whisper '{model_name}' (compute={compute}, threads={threads or 'auto'}) — first run downloads the model…")
    try:
        model = WhisperModel(model_name, device="cpu", compute_type=compute, cpu_threads=threads)
    except Exception as e:  # noqa: BLE001
        emit({"fatal": f"model load failed: {e}"})
        return 3
    emit({"ready": True, "model": model_name})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            jid = req["id"]
            path = req["path"]
        except Exception as e:  # noqa: BLE001
            emit({"error": f"bad request: {e}"})
            continue
        try:
            segs, _info = model.transcribe(path, language=lang, vad_filter=True, beam_size=5)
            out = [{"start": round(s.start, 1), "text": s.text.strip()} for s in segs]
            emit({"id": jid, "text": " ".join(x["text"] for x in out if x["text"]), "segments": out})
        except Exception as e:  # noqa: BLE001 — one bad file must not kill the worker
            emit({"id": jid, "error": str(e)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
