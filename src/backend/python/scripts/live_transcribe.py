"""
Live streaming transcription for the Record & Create audio mode.

A long-lived process: raw PCM streams in on stdin while the user records, and
transcript events stream out on stdout. Runs on the same faster-whisper stack
as transcribe.py (silero VAD included) — no extra dependencies, no network.

Protocol (PREFIX|{json}, same convention as transcribe.py):
  stdin:  raw PCM16LE mono 16 kHz. EOF (stdin closed) = recording stopped:
          flush the tail, emit FINAL, exit 0.
  stdout: READY|{"model","device"}      model loaded, listening
          PARTIAL|{"text"}              rolling un-committed tail (display only)
          SEGMENT|{"start","end","text","words"}  committed utterance,
                                        seconds absolute to the recording start
          FINAL|{transcriptionResult}   the full cachedKaraokeSubtitles payload
          ERROR|{"message"}

The stdin reader thread starts BEFORE the model loads, so audio fed during
warm-up is buffered, never lost. Committed utterances are re-decoded at beam 5
for accuracy; the rolling PARTIAL uses greedy decoding for latency. Language
is auto-detected per utterance unless --language pins it, so mixed-language
takes (e.g. Taglish) transcribe as spoken.
"""

import argparse
import json
import sys
import threading
import time

from transcribe import _setup_cuda_dlls, resolve_device, _compute_type_for  # noqa: F401

SR = 16000
COMMIT_SILENCE = 0.7   # trailing quiet (s) that seals an utterance
MAX_WINDOW = 28.0      # force a commit before the window outgrows whisper's 30s
MIN_WINDOW = 0.4       # don't decode less than this (s)
TICK = 0.25            # idle poll between decodes (s)


def emit(prefix: str, payload: dict) -> None:
    print(f"{prefix}|{json.dumps(payload, ensure_ascii=False)}", flush=True)


class PcmBuffer:
    """stdin reader — accumulates PCM16 bytes; starts before the model loads."""

    def __init__(self):
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.eof = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        stdin = sys.stdin.buffer
        while True:
            chunk = stdin.read(4096)
            if not chunk:
                break
            with self.lock:
                self.buf += chunk
        with self.lock:
            self.eof = True

    def snapshot(self):
        with self.lock:
            usable = len(self.buf) - (len(self.buf) % 2)
            return bytes(self.buf[:usable]), self.eof


def to_float32(pcm: bytes):
    import numpy as np
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def vad_chunks(audio, vad_options):
    """Speech spans in samples. fw 1.2 keeps the silero VAD in-tree."""
    from faster_whisper.vad import get_speech_timestamps
    try:
        return get_speech_timestamps(audio, vad_options)
    except TypeError:  # older/newer signature drift
        return get_speech_timestamps(audio, vad_options=vad_options)


def decode(model, audio, beam: int, language, lang_votes: dict):
    """One whisper pass → (segments, text). Times are window-relative."""
    seg_gen, info = model.transcribe(
        audio,
        beam_size=beam,
        language=language,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    segs = []
    for s in seg_gen:
        words = [
            {"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3),
             "confidence": round(getattr(w, "probability", 1.0), 3)}
            for w in (s.words or [])
        ]
        segs.append({"start": round(s.start, 3), "end": round(s.end, 3),
                     "text": s.text, "words": words})
    if segs and info.language:
        lang_votes[info.language] = lang_votes.get(info.language, 0) + 1
        lang_votes.setdefault("_prob", {})[info.language] = info.language_probability
    return segs


def offset_segs(segs, off: float):
    out = []
    for s in segs:
        out.append({
            "start": round(s["start"] + off, 3),
            "end": round(s["end"] + off, 3),
            "text": s["text"],
            "words": [
                {"word": w["word"], "start": round(w["start"] + off, 3),
                 "end": round(w["end"] + off, 3), "confidence": w["confidence"]}
                for w in s["words"]
            ],
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="auto",
                    help="auto = large-v3 on GPU, small on CPU fallback")
    ap.add_argument("--language", default=None,
                    help="pin a language code; default auto-detects per utterance")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    pcm = PcmBuffer()  # listening from the very first byte
    t0 = time.time()

    from faster_whisper import WhisperModel
    from faster_whisper.vad import VadOptions

    device = resolve_device(args.device)
    model_size = args.model if args.model != "auto" else ("large-v3" if device == "cuda" else "small")
    compute = _compute_type_for(device, "auto")
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute,
                             cpu_threads=2, num_workers=1)
    except Exception:
        if device == "cuda":  # GPU wedged mid-session — degrade, don't die
            device, model_size, compute = "cpu", "small", "int8"
            model = WhisperModel(model_size, device=device, compute_type=compute,
                                 cpu_threads=2, num_workers=1)
        else:
            raise
    vad_options = VadOptions(min_silence_duration_ms=450, speech_pad_ms=120)
    emit("READY", {"model": model_size, "device": device,
                   "load_time": round(time.time() - t0, 2)})

    committed = 0          # samples already sealed into SEGMENTs
    all_segments = []
    lang_votes = {}
    last_partial = None

    def send_partial(text: str):
        nonlocal last_partial
        if text != last_partial:
            last_partial = text
            emit("PARTIAL", {"text": text})

    while True:
        raw, eof = pcm.snapshot()
        total = len(raw) // 2
        window = total - committed

        if window < int(MIN_WINDOW * SR):
            if eof:
                break
            time.sleep(TICK)
            continue

        audio = to_float32(raw[committed * 2: total * 2])
        speech = vad_chunks(audio, vad_options)

        if not speech:
            # dead air — keep a 1s tail so the window never grows unbounded
            if window > SR:
                committed = total - SR
            send_partial("")
            if eof:
                break
            time.sleep(TICK)
            continue

        win_dur = window / SR
        # An utterance is sealed by the pause AFTER it — scan for the last
        # speech chunk followed by >= COMMIT_SILENCE of quiet, even when new
        # speech is already flowing at the window tail (a tail-only check
        # misses every pause shorter than one decode tick).
        seal_end = None
        for i, ch in enumerate(speech):
            nxt_start = speech[i + 1]["start"] if i + 1 < len(speech) else window
            if (nxt_start - ch["end"]) / SR >= COMMIT_SILENCE:
                seal_end = min(ch["end"] + int(0.2 * SR), nxt_start)
        if eof:
            seal_end = window
        elif seal_end is None and win_dur >= MAX_WINDOW:
            seal_end = min(window, speech[-1]["end"])  # mid-speech backstop cut

        if seal_end:
            # utterance finished (or window full) — final-quality decode
            commit_samples = seal_end
            segs = decode(model, audio[:commit_samples], 5, args.language, lang_votes)
            off = committed / SR
            for s in offset_segs(segs, off):
                all_segments.append(s)
                emit("SEGMENT", s)
            committed += commit_samples
            send_partial("")
            if eof:
                raw, _ = pcm.snapshot()
                if len(raw) // 2 - committed < int(MIN_WINDOW * SR):
                    break
        else:
            segs = decode(model, audio, 1, args.language, lang_votes)
            send_partial(" ".join(s["text"].strip() for s in segs).strip())

    lang_probs = lang_votes.pop("_prob", {})
    language = max(lang_votes, key=lang_votes.get) if lang_votes else (args.language or "en")
    total_samples = len(pcm.snapshot()[0]) // 2
    emit("FINAL", {
        "success": True,
        "segments": all_segments,
        "language": language,
        "language_probability": round(lang_probs.get(language, 1.0), 3),
        "duration": round(total_samples / SR, 3),
        "text": " ".join(s["text"].strip() for s in all_segments).strip(),
        "processing_time": round(time.time() - t0, 2),
        "model": model_size,
        "device": device,
        "segment_count": len(all_segments),
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — protocol demands a terminal ERROR line
        emit("ERROR", {"message": str(e)})
        sys.exit(1)
