"""Reverb Processor DSP validation battery — rerunnable offline (no app).

Setup (once): needs C:/tmp/reverb-test with the 10 sources + room_ir.wav +
wet_* files. If missing, see reference_dividr_style_profile_method memory or
regenerate: 3x edge-tts speech, narration mp3s, synthetic pad/claps/pluck/drums,
then wet_* via `ffmpeg -i src -i room_ir.wav -filter_complex afir`.

Checks (all must pass):
  DE-REVERB (wet_* at -50): blind tail decay drops >25% (speech/transients),
    gap-fill ratio drops (pad).
  ADD (dry at +15/+30/+50): tail grows monotonically (speech) or gap-fill
    grows monotonically (pad/claps/pluck); cepstral echo score stays an order
    of magnitude below a real aecho echo (no "doubled word").
"""
import json
import subprocess
import sys

import numpy as np
import soundfile as sf

TESTDIR = r"C:\tmp\reverb-test"
SCRIPT = r"C:\Users\User\Documents\CLAUDE CODE\dividr-mycelium\src\backend\python\scripts\reverb_processor.py"
SOURCES = ["s1_male", "s2_female", "s3_brit", "s4_narration", "s5_pad",
           "s6_claps", "s7_pluck", "s8_drums", "s9_refnarration", "s10_slow"]
EXT = {"s1_male": "mp3", "s2_female": "mp3", "s3_brit": "mp3",
       "s4_narration": "mp3", "s10_slow": "mp3"}
GAP_METRIC = {  # (gap windows, tolerance) for offset-free material
    "s5_pad": [(2.45, 2.55), (4.95, 5.05), (7.45, 7.55)],
    "s6_claps": [(b - 0.28, b - 0.05) for b in np.arange(1.2, 7.4, 0.7)],
    "s7_pluck": [(k * 0.95 - 0.06, k * 0.95 - 0.01) for k in range(2, 8)],
}


def run(inp, out, amount):
    r = subprocess.run([sys.executable, SCRIPT, "--input", inp, "--output", out,
                        "--amount", str(amount)], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.startswith("RESULT|"):
            return json.loads(line[7:])
    return {"success": False, "error": r.stderr[-200:]}


def gap_rms(p, gaps):
    d, sr = sf.read(p, dtype="float32", always_2d=True)
    m = d.mean(axis=1)
    vals = [np.sqrt((m[int(a * sr):int(b * sr)] ** 2).mean())
            for a, b in gaps if int(b * sr) <= len(m)]
    return float(np.mean(vals))


def cepstral_echo(p):
    d, sr = sf.read(p, dtype="float32", always_2d=True)
    m = d.mean(axis=1)
    N = 2 ** 15
    acc, cnt = None, 0
    for i in range(0, len(m) - N, N // 2):
        seg = m[i:i + N] * np.hanning(N)
        ceps = np.abs(np.fft.irfft(np.log(np.abs(np.fft.rfft(seg)) ** 2 + 1e-12)))
        acc = ceps if acc is None else acc + ceps
        cnt += 1
    ceps = acc / cnt
    seg = ceps[int(0.040 * sr):int(0.400 * sr)]
    return float(seg.max() / (np.median(seg) + 1e-12))


def main():
    import os
    os.chdir(TESTDIR)
    passes = fails = 0

    def check(name, ok, detail=""):
        nonlocal passes, fails
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
        passes += ok
        fails += not ok

    # de-reverb
    for s in SOURCES:
        r = run(f"wet_{s}.wav", f"val_{s}_m50.wav", -50)
        if not r.get("success"):
            check(f"dereverb {s}", False, r.get("error", ""))
            continue
        if s in GAP_METRIC:
            gw = gap_rms(f"wet_{s}.wav", GAP_METRIC[s])
            go = gap_rms(f"val_{s}_m50.wav", GAP_METRIC[s])
            dw, _ = sf.read(f"wet_{s}.wav", dtype="float32", always_2d=True)
            do, _ = sf.read(f"val_{s}_m50.wav", dtype="float32", always_2d=True)
            rw = np.sqrt((dw ** 2).mean()); ro = np.sqrt((do ** 2).mean())
            check(f"dereverb {s} (gap-fill)", go / ro < gw / rw,
                  f"{gw/rw:.3f} -> {go/ro:.3f}")
        else:
            check(f"dereverb {s} (tail)",
                  r["tailDecayAfterMs"] < r["tailDecayBeforeMs"] * 0.75,
                  f"{r['tailDecayBeforeMs']:.0f}ms -> {r['tailDecayAfterMs']:.0f}ms")

    # add + echo check
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", "s1_male.mp3",
                    "-af", "aecho=0.8:0.6:180:0.5", "val_bad_echo.wav"],
                   capture_output=True)
    echo_ref = cepstral_echo("val_bad_echo.wav")
    for s in SOURCES:
        dry = f"{s}.{EXT.get(s, 'wav')}"
        vals = []
        for amt in (15, 30, 50):
            r = run(dry, f"val_{s}_p{amt}.wav", amt)
            if not r.get("success"):
                break
            if s in GAP_METRIC:
                vals.append(gap_rms(f"val_{s}_p{amt}.wav", GAP_METRIC[s]))
            else:
                vals.append(r["tailDecayAfterMs"])
        else:
            grew = vals[-1] > vals[0] * 0.9 and vals[-1] > 0
            spike = cepstral_echo(f"val_{s}_p50.wav")
            check(f"add {s}", grew and spike < echo_ref / 3,
                  f"{['%.4g' % v for v in vals]} echo {spike:.1f} (bad ref {echo_ref:.1f})")

    print(f"\n{passes}/{passes + fails} PASS")
    sys.exit(0 if fails == 0 else 1)


if __name__ == "__main__":
    main()
