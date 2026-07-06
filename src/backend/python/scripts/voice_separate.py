#!/usr/bin/env python3
"""
voice_separate — split a clip into a clean VOICE stem and a BACKGROUND stem.

The voice stem is produced by DeepFilterNet (the `deep-filter` standalone
binary), a full-band (48 kHz) speech-enhancement model purpose-built to remove
room / cafe / babble noise from a voice WITHOUT muffling it. Earlier attempts
used a music-separation model + ffmpeg denoisers; those fail here because cafe
ambiance is not "music" (so the music model leaves it in the voice) and spectral
denoisers scoop out the voice's highs ("underwater" sound). DeepFilterNet is the
right tool for noise-vs-speech and is what this app already uses in production.

  voice stem      = DeepFilterNet(mix)          # clean speech, noise removed
  background stem = mix - voice                 # exactly what was removed

So the two stems sum back to the original mix (Voice 100% + Background 100% ==
untouched clip), and the editor mixes them live with the separation curve.

DeepFilterNet runs faster than real time on a single CPU core, needs no GPU, no
API keys, and no Python dependencies — it's a self-contained binary cached next
to this script (downloaded once, like the other models).

stdout protocol:
  PROGRESS|{"stage":"...","progress":<0-100>,"message":"..."}
  RESULT|{"success":true,"filePath":"<voice.wav>","instrumentalPath":"<bg.wav>",
          "duration":<s>,"sampleRate":44100}
"""

import os
import sys
import json
import subprocess
import tempfile

SR = 44100

# ── Voice naturalness dial ───────────────────────────────────────────────────
# DeepFilterNet attenuation limit, in dB. This is the ONE knob that trades "how
# much background is removed" against "how natural the voice sounds".
#
#   higher (e.g. 100) = removes essentially ALL background, but pushes the model
#                       into noise-only frequency bins and carves them so hard
#                       that isolated spectral peaks survive and ring — the
#                       occasional metallic "musical noise" / vocoder / auto-tune
#                       (Daft-Punk) quality on the voice.
#   lower  (e.g. 30)  = caps the carving, so far fewer of those artifacts; the
#                       voice stays natural at the cost of a faint, quiet trace
#                       of room ambiance under the speech.
#
# MEASURED (2026-06-27, tools/diagnose_separation.py on a real -2.7 dB-SNR clip):
# lowering atten to 30 did NOT reduce the vocoder artifact and left the background
# slightly dirtier (more tonal gaps, more voice ghost) than 100. 100 is cleaner on
# both counts AND is the version the user praised, so 100 is the live setting.
# Frozen copy also at _fallbacks/voice_separate_100db.py.bak.
# NEVER add --pf (post-filter): it suppresses harder and makes the vocoder
# artifact WORSE.
# NOTE: the remaining ghost is fundamental to mix-minus-voice subtraction at low
# SNR; a real fix needs a learned 2-stem separator, not a tweak to this knob.
ATTEN_LIM_DB = 100
DF_BIN_WIN = 'deep-filter.exe'
DF_BIN_NIX = 'deep-filter'
DF_URL = (
    'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/'
    'deep-filter-0.5.6-x86_64-pc-windows-msvc.exe'
)


def _progress(stage: str, progress: float, message: str = '') -> None:
    print(
        f"PROGRESS|{json.dumps({'stage': stage, 'progress': round(progress, 1), 'message': message})}",
        flush=True,
    )


def _find_ffmpeg() -> str:
    import shutil
    return shutil.which('ffmpeg') or 'ffmpeg'


def _get_deepfilter_bin() -> str:
    """Resolve the deep-filter binary next to this script; download once if
    missing (Windows). Atomic .part download so an interruption can't leave a
    truncated executable."""
    here = os.path.dirname(os.path.abspath(__file__))
    name = DF_BIN_WIN if sys.platform == 'win32' else DF_BIN_NIX
    path = os.path.join(here, name)
    if os.path.exists(path):
        return path
    if sys.platform != 'win32':
        raise RuntimeError(
            'deep-filter binary not found and auto-download is Windows-only; '
            'install DeepFilterNet for this platform'
        )
    import urllib.request
    _progress('loading', 2, 'Downloading speech model (one-time)…')
    tmp = path + '.part'
    urllib.request.urlretrieve(DF_URL, tmp)
    if os.path.getsize(tmp) < 5_000_000:
        os.unlink(tmp)
        raise RuntimeError('deep-filter download incomplete')
    os.replace(tmp, path)
    return path


def _decode_audio(input_path: str, sr: int = SR):
    """Decode any media to float32 stereo at `sr` -> (wav_path, np[2, n]).

    Returns BOTH the on-disk wav (DeepFilterNet needs a file) and the samples
    (for the residual). Caller deletes wav_path."""
    import soundfile as sf
    import numpy as np
    ffmpeg = _find_ffmpeg()
    fd, wav_path = tempfile.mkstemp(suffix='.wav')
    os.close(fd)
    subprocess.run(
        [ffmpeg, '-y', '-i', input_path, '-ac', '2', '-ar', str(sr),
         '-c:a', 'pcm_f32le', '-f', 'wav', wav_path, '-loglevel', 'error'],
        check=True, capture_output=True,
    )
    data, _ = sf.read(wav_path, dtype='float32', always_2d=True)  # [n, 2]
    return wav_path, np.ascontiguousarray(data.T)  # [2, n]


def separate(input_path: str, voice_out: str, bg_out: str) -> dict:
    import numpy as np
    import soundfile as sf

    df_bin = _get_deepfilter_bin()

    _progress('loading', 8, 'Loading audio…')
    mix_wav, mix = _decode_audio(input_path, SR)  # mix: [2, n]
    n = mix.shape[1]
    duration = n / SR

    out_dir = tempfile.mkdtemp(prefix='dfout_')
    try:
        _progress('processing', 20, 'Removing background from voice…')
        # -D compensates the model's lookahead/STFT delay so the enhanced voice
        # stays time-aligned with the original (needed for a clean residual).
        proc = subprocess.run(
            [df_bin, '-D', '-a', str(ATTEN_LIM_DB), '-o', out_dir, mix_wav],
            capture_output=True, text=True,
        )
        produced = os.path.join(out_dir, os.path.basename(mix_wav))
        if proc.returncode != 0 or not os.path.exists(produced):
            raise RuntimeError(
                f'deep-filter failed (exit {proc.returncode}): {proc.stderr[-300:]}'
            )

        _progress('processing', 85, 'Building stems…')
        voice_data, _ = sf.read(produced, dtype='float32', always_2d=True)  # [m, 2]
        voice = voice_data.T  # [2, m]

        # DeepFilterNet trims a few ms off the tail; pad/trim the voice to the
        # mix length so voice + background == mix sample-for-sample.
        voice_full = np.zeros((2, n), dtype=np.float32)
        m = min(voice.shape[1], n)
        voice_full[:, :m] = voice[:, :m]
        background = mix - voice_full
    finally:
        for p in (mix_wav,):
            try:
                os.unlink(p)
            except OSError:
                pass
        try:
            for f in os.listdir(out_dir):
                os.unlink(os.path.join(out_dir, f))
            os.rmdir(out_dir)
        except OSError:
            pass

    _progress('saving', 97, 'Writing stems…')
    sf.write(voice_out, voice_full.T, SR, subtype='FLOAT')
    sf.write(bg_out, background.T, SR, subtype='FLOAT')

    return {
        'success': True,
        'filePath': voice_out,
        'instrumentalPath': bg_out,
        'duration': round(duration, 3),
        'sampleRate': SR,
    }


def handle_args(args) -> None:
    voice_out = args.output
    bg_out = args.instrumental or (
        os.path.splitext(args.output)[0] + '_background.wav'
    )
    result = separate(args.input, voice_out, bg_out)
    _progress('complete', 100, 'Done')
    print(f"RESULT|{json.dumps(result)}", flush=True)
