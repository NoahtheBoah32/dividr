"""Reverb Processor — bidirectional reverb control for audio clips.

amount < 0  → DE-REVERB: single-channel late-reverb suppression (Lebart-style
              spectral subtraction with an exponential decay model). Pure
              numpy/scipy STFT — no ML models, no downloads, no API.
amount > 0  → ADD REVERB: convolution with a synthetic diffuse impulse
              response (decorrelated stereo noise tail, exponential decay,
              air-absorption tilt, short predelay). True convolution reverb —
              physically cannot produce a discrete "word repeated twice" echo
              because the IR has no isolated taps.

Reports objective before/after metrics (RT60-style tail estimate) in RESULT
JSON so callers can verify the effect actually happened.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf
from scipy.signal import oaconvolve, stft, istft


def _progress(msg: str) -> None:
    print(f"PROGRESS|{msg}", flush=True)


def _result(payload: dict) -> None:
    print("RESULT|" + json.dumps(payload), flush=True)


def _find_ffmpeg():
    return shutil.which("ffmpeg") or "ffmpeg"


def _decode(input_path: str, sr: int = 48000) -> tuple[np.ndarray, int]:
    """Decode any container to float32 stereo via ffmpeg."""
    tmp = tempfile.mktemp(suffix=".wav")
    proc = subprocess.run(
        [_find_ffmpeg(), "-y", "-i", input_path, "-vn",
         "-ac", "2", "-ar", str(sr), "-c:a", "pcm_f32le", tmp],
        capture_output=True,
    )
    if proc.returncode != 0 or not os.path.exists(tmp):
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr[-300:].decode(errors='replace')}")
    data, got_sr = sf.read(tmp, dtype="float32", always_2d=True)
    os.remove(tmp)
    return data, got_sr


# ---------------------------------------------------------------------------
# Objective reverberance metric (blind, no ground truth needed)
# ---------------------------------------------------------------------------

def measure_tail_decay(x: np.ndarray, sr: int) -> float:
    """Median decay time (seconds) of energy tails after envelope offsets.

    Finds drops in the smoothed energy envelope (word/note offsets) and
    measures how long energy takes to fall 20 dB after each. Reverberant
    audio has long tails; dry audio decays almost instantly. This is a
    blind RT-proxy: higher = more reverberant.
    """
    mono = x.mean(axis=1) if x.ndim == 2 else x
    hop = int(sr * 0.010)
    win = int(sr * 0.030)
    n = (len(mono) - win) // hop
    if n < 20:
        return 0.0
    frames = np.lib.stride_tricks.sliding_window_view(mono, win)[::hop][:n]
    env = np.sqrt((frames ** 2).mean(axis=1)) + 1e-10
    env_db = 20 * np.log10(env)
    env_db -= env_db.max()

    # smooth lightly to stabilise offset detection
    k = np.ones(3) / 3
    sm = np.convolve(env_db, k, mode="same")

    decays = []
    peak_floor = -35.0
    i = 1
    while i < n - 5:
        # an offset = local peak above floor followed by a falling stretch
        if sm[i] > peak_floor and sm[i] >= sm[i - 1] and sm[i] > sm[i + 1]:
            start_db = sm[i]
            target = start_db - 20.0
            j = i + 1
            while j < n and sm[j] > target:
                if sm[j] > sm[i]:  # next word started before we decayed 20 dB
                    break
                j += 1
            if j < n and sm[j] <= target:
                decays.append((j - i) * hop / sr)
            i = j
        i += 1
    if not decays:
        return 0.0
    return float(np.median(decays))


# ---------------------------------------------------------------------------
# ADD reverb — synthetic diffuse IR + overlap-add convolution
# ---------------------------------------------------------------------------

def synth_ir(sr: int, rt60: float, tilt: float, predelay_ms: float, seed: int = 7) -> np.ndarray:
    """Diffuse stereo IR: decorrelated gaussian noise shaped by exp decay.

    No discrete taps → no audible "double word" echo, ever. tilt applies a
    progressive lowpass over the tail (air absorption) so the reverb darkens
    as it decays, which is what real rooms do.
    """
    length = int(sr * max(0.15, rt60 * 1.1))
    rng = np.random.default_rng(seed)
    ir = rng.standard_normal((length, 2)).astype(np.float32)

    t = np.arange(length) / sr
    decay = np.exp(-6.908 * t / rt60)  # -60 dB at rt60
    ir *= decay[:, None]

    # progressive one-pole lowpass along the tail (air absorption)
    alpha_start, alpha_end = 0.02, min(0.6, 0.08 + tilt)
    alphas = np.linspace(alpha_start, alpha_end, length).astype(np.float32)
    for ch in range(2):
        prev = 0.0
        col = ir[:, ch]
        for idx in range(length):
            a = alphas[idx]
            prev = (1 - a) * col[idx] + a * prev
            col[idx] = prev

    # predelay gap (silence before the tail starts)
    pre = np.zeros((int(sr * predelay_ms / 1000), 2), dtype=np.float32)
    ir = np.concatenate([pre, ir])

    # normalise IR energy so wet loudness is stable across rt60 settings
    ir /= np.sqrt((ir ** 2).sum(axis=0)).max() + 1e-9
    return ir


def add_reverb(x: np.ndarray, sr: int, amount: int) -> np.ndarray:
    """amount 1..50 → rt60 0.25s..2.6s, wet mix 10%..45%."""
    a = amount / 50.0
    rt60 = 0.25 + 2.35 * a
    wet_gain = 0.10 + 0.35 * a
    predelay = 10 + 25 * a          # bigger rooms start later
    tilt = 0.30 * a

    ir = synth_ir(sr, rt60, tilt, predelay)
    _progress(f"convolving with {ir.shape[0] / sr:.2f}s diffuse IR (rt60={rt60:.2f}s)")
    wet = np.stack(
        [oaconvolve(x[:, ch], ir[:, ch], mode="full")[: len(x)] for ch in range(2)],
        axis=1,
    )
    # equal-loudness-ish mix: keep dry at full, add scaled wet
    wet_rms = np.sqrt((wet ** 2).mean()) + 1e-9
    dry_rms = np.sqrt((x ** 2).mean()) + 1e-9
    out = x + wet * (dry_rms / wet_rms) * wet_gain
    peak = np.abs(out).max()
    if peak > 0.985:
        out *= 0.985 / peak
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# DE-reverb — late-reverb spectral suppression (Lebart / Habets style)
# ---------------------------------------------------------------------------

def de_reverb(x: np.ndarray, sr: int, amount: int) -> np.ndarray:
    """amount 1..50 → progressively stronger late-reverb suppression.

    Model: late reverb PSD ≈ e^{-2Δ·6.9/T60} · PSD of the signal Δ seconds ago.
    Wiener-style gain with a floor. Runs per channel; pure numpy/scipy.
    """
    a = amount / 50.0
    t60_assumed = 0.9            # generic room assumption for the decay model
    delta_s = 0.048              # late reverb starts ~50 ms after direct sound
    max_att_db = 6 + 12 * a      # gain floor: -6 dB (gentle) .. -18 dB (strong)
    overest = 0.8 + 1.4 * a      # subtraction over-estimation factor

    nper = 1024
    hop = nper // 4
    floor = 10 ** (-max_att_db / 20)
    delay_frames = max(1, int(round(delta_s * sr / hop)))
    decay = np.exp(-2 * 6.908 * delta_s / t60_assumed)

    out = np.zeros_like(x)
    for ch in range(x.shape[1]):
        f, t, Z = stft(x[:, ch], fs=sr, nperseg=nper, noverlap=nper - hop)
        P = np.abs(Z) ** 2

        # recursive late-reverb PSD estimate
        late = np.zeros_like(P)
        for m in range(delay_frames, P.shape[1]):
            late[:, m] = decay * (P[:, m - delay_frames] + late[:, m - delay_frames])

        gain = 1.0 - overest * (late / (P + 1e-12))
        gain = np.clip(gain, floor, 1.0)
        # smooth gain over time to avoid musical noise
        for m in range(1, gain.shape[1]):
            gain[:, m] = np.maximum(gain[:, m], gain[:, m - 1] * 0.5)

        _, rec = istft(Z * gain, fs=sr, nperseg=nper, noverlap=nper - hop)
        out[:, ch] = rec[: len(x)]

    # Loudness preservation: on sustained material the Wiener gain rides its
    # floor and attenuates EVERYTHING (measured -16 dB on a chord pad). The
    # user asked for drier, not quieter — match output RMS back to the input.
    in_rms = np.sqrt((x ** 2).mean()) + 1e-9
    out_rms = np.sqrt((out ** 2).mean()) + 1e-9
    out *= min(in_rms / out_rms, 8.0)
    peak = np.abs(out).max()
    if peak > 0.985:
        out *= 0.985 / peak
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def handle_args(args) -> None:
    try:
        amount = int(round(float(args.amount)))
        amount = max(-50, min(50, amount))
        if amount == 0:
            _result({"success": False, "error": "amount 0 = no processing requested"})
            return

        _progress(f"decoding {os.path.basename(args.input)}")
        x, sr = _decode(args.input)
        dur = len(x) / sr

        tail_before = measure_tail_decay(x, sr)
        _progress(f"tail decay before: {tail_before * 1000:.0f} ms")

        if amount > 0:
            y = add_reverb(x, sr, amount)
            mode = "add"
        else:
            y = de_reverb(x, sr, -amount)
            mode = "remove"

        tail_after = measure_tail_decay(y, sr)
        _progress(f"tail decay after: {tail_after * 1000:.0f} ms")

        sf.write(args.output, y, sr, subtype="PCM_16")
        _result({
            "success": True,
            "filePath": args.output,
            "mode": mode,
            "amount": amount,
            "duration": round(dur, 3),
            "tailDecayBeforeMs": round(tail_before * 1000, 1),
            "tailDecayAfterMs": round(tail_after * 1000, 1),
        })
    except Exception as e:  # noqa: BLE001
        _result({"success": False, "error": str(e)})


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--amount", type=float, required=True)
    handle_args(p.parse_args())
