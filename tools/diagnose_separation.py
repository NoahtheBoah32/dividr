#!/usr/bin/env python3
"""
diagnose_separation — judge a voice/background split as numbers + spectrograms,
so it can be evaluated WITHOUT listening.

Run with the project's python venv:
  src/backend/python/venv/Scripts/python.exe tools/diagnose_separation.py \
      --clip "path/to/clip.mp4" --out tools/_diag --label "atten 100"
or on an already-baked pair:
  ... --voice voice.wav --background background.wav --out tools/_diag

Two failure modes it quantifies:
  1. VOICE BLEED: does the background stem still contain the speaker? Watch for
     horizontal harmonic bands in the BACKGROUND panel, and `spectral_cosine_active`
     / `bg_swing_db`. (For a sharper number, cross-correlate the background against
     the voice stem as a template — see final_measure pattern in the build notes.)
  2. MUSICAL NOISE: does the voice stem ring with tonal "vocoder" birdies in the
     gaps between words? Watch `spectral_flatness_gaps` (low + audible gap energy
     => tonal artifact) and the speckle in the VOICE panel's silent columns.

Context (2026-06-27): on a real -2.7 dB-SNR cafe clip, DeepFilterNet at atten 100
gave the cleanest cheap result. Lowering atten and soft-masking did not beat it.
The residual ghost is fundamental to mix-minus-voice subtraction at low SNR.
"""
import os, sys, json, argparse
import numpy as np
import soundfile as sf

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import librosa
import librosa.display

SR = 44100
N_FFT = 2048
HOP = 512
ACTIVE_DB_BELOW_PEAK = 25.0   # a frame is "speech" if within this many dB of voice peak


def load_wav(path, sr=SR):
    data, file_sr = sf.read(path, dtype='float32', always_2d=True)
    mono = data.mean(axis=1)
    if file_sr != sr:
        mono = librosa.resample(mono, orig_sr=file_sr, target_sr=sr)
    return mono.astype(np.float32)


def rms_dbfs(y):
    return float(20 * np.log10(np.sqrt(np.mean(y ** 2) + 1e-12) + 1e-12))


def peak_dbfs(y):
    return float(20 * np.log10(np.max(np.abs(y)) + 1e-12))


def frame_rms(y):
    return librosa.feature.rms(y=y, frame_length=N_FFT, hop_length=HOP)[0]


def db(x):
    return 20 * np.log10(np.asarray(x) + 1e-9)


def analyze(voice, background, mix=None):
    if mix is None:
        mix = voice + background
    n = min(len(voice), len(background), len(mix))
    voice, background, mix = voice[:n], background[:n], mix[:n]

    ev, eb = frame_rms(voice), frame_rms(background)
    ev_db = db(ev)
    active = ev_db >= (ev_db.max() - ACTIVE_DB_BELOW_PEAK)
    silent = ~active

    bg_speech = float(db(np.mean(eb[active]))) if active.any() else float('nan')
    bg_gap = float(db(np.mean(eb[silent]))) if silent.any() else float('nan')
    vv, bb = ev - ev.mean(), eb - eb.mean()
    env_corr = float(np.sum(vv * bb) / (np.sqrt(np.sum(vv ** 2)) * np.sqrt(np.sum(bb ** 2)) + 1e-12))

    Sv = np.abs(librosa.stft(voice, n_fft=N_FFT, hop_length=HOP))
    Sb = np.abs(librosa.stft(background, n_fft=N_FFT, hop_length=HOP))
    af = active[:Sv.shape[1]]
    if af.any():
        mv, mb = Sv[:, af].mean(axis=1), Sb[:, af].mean(axis=1)
        spec_cos = float(np.dot(mv, mb) / (np.linalg.norm(mv) * np.linalg.norm(mb) + 1e-12))
    else:
        spec_cos = float('nan')

    flat = librosa.feature.spectral_flatness(y=voice, n_fft=N_FFT, hop_length=HOP)[0]
    sl = silent[:len(flat)]
    flat_gap = float(np.mean(flat[sl])) if sl.any() else float('nan')

    metrics = {
        'duration_s': round(n / SR, 2),
        'pct_speech_active': round(float(active.mean() * 100), 1),
        'levels_dbfs': {
            'mix': {'rms': round(rms_dbfs(mix), 1), 'peak': round(peak_dbfs(mix), 1)},
            'voice': {'rms': round(rms_dbfs(voice), 1), 'peak': round(peak_dbfs(voice), 1)},
            'background': {'rms': round(rms_dbfs(background), 1), 'peak': round(peak_dbfs(background), 1)},
        },
        'voice_bleed_into_background': {
            'bg_rms_db_during_speech': round(bg_speech, 1),
            'bg_rms_db_during_gaps': round(bg_gap, 1),
            'bg_swing_db': round(bg_speech - bg_gap, 1),
            'envelope_corr_voice_vs_bg': round(env_corr, 3),
            'spectral_cosine_active': round(spec_cos, 3),
        },
        'musical_noise_on_voice': {
            'voice_rms_db_speech': round(float(db(np.mean(ev[active]))), 1) if active.any() else None,
            'voice_rms_db_gaps': round(float(db(np.mean(ev[silent]))), 1) if silent.any() else None,
            'gap_suppression_db': round(float(db(np.mean(ev[active])) - db(np.mean(ev[silent]))), 1)
                                  if active.any() and silent.any() else None,
            'spectral_flatness_gaps': round(flat_gap, 4),
        },
    }
    return metrics, dict(mix=mix, voice=voice, background=background, active=active)


def _specshow(ax, y, title):
    S = librosa.amplitude_to_db(np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP)), ref=np.max)
    img = librosa.display.specshow(S, sr=SR, hop_length=HOP, x_axis='time', y_axis='log',
                                   ax=ax, vmin=-80, vmax=0, cmap='magma')
    ax.set_title(title, fontsize=11, loc='left')
    ax.set_ylim(60, SR / 2)
    return img


def render(stems, out_png, zoom=None, label=''):
    titles = {'mix': 'MIX (voice + background)', 'voice': 'VOICE stem (isolated)',
              'background': 'BACKGROUND stem (mix - voice)'}
    fig, axes = plt.subplots(3, 1, figsize=(13, 9), sharex=True)
    for ax, key in zip(axes, ['mix', 'voice', 'background']):
        y = stems[key]
        if zoom:
            y = y[int(zoom[0] * SR):int(zoom[1] * SR)]
        img = _specshow(ax, y, titles[key])
    fig.colorbar(img, ax=axes, format='%+2.0f dB', location='right', shrink=0.6, pad=0.01)
    sub = f'  [zoom {zoom[0]:.1f}-{zoom[1]:.1f}s]' if zoom else '  [full length]'
    fig.suptitle(f'Separation diagnostic{(" - " + label) if label else ""}{sub}', fontsize=13, x=0.01, ha='left')
    fig.savefig(out_png, dpi=110, bbox_inches='tight')
    plt.close(fig)


def pick_zoom(active, dur):
    times = np.linspace(0, dur, len(active))
    if active.any() and (~active).any():
        start = max(0.0, times[np.argmax(active)] - 0.5)
    else:
        start = 0.0
    return (round(start, 2), round(min(dur, start + 6.0), 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice'); ap.add_argument('--background')
    ap.add_argument('--clip')
    ap.add_argument('--out', required=True)
    ap.add_argument('--label', default='')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    if args.clip:
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, os.path.join(here, '..', 'src', 'backend', 'python', 'scripts'))
        import voice_separate as vs
        v_out = os.path.join(args.out, 'bake_voice.wav')
        b_out = os.path.join(args.out, 'bake_bg.wav')
        print('BAKE', json.dumps(vs.separate(args.clip, v_out, b_out)))
        voice, background = load_wav(v_out), load_wav(b_out)
    else:
        voice, background = load_wav(args.voice), load_wav(args.background)

    metrics, stems = analyze(voice, background)
    zoom = pick_zoom(stems['active'], metrics['duration_s'])
    render(stems, os.path.join(args.out, 'spec_full.png'), zoom=None, label=args.label)
    render(stems, os.path.join(args.out, 'spec_zoom.png'), zoom=zoom, label=args.label)
    with open(os.path.join(args.out, 'metrics.json'), 'w') as f:
        json.dump(metrics, f, indent=2)
    print('METRICS', json.dumps(metrics, indent=2))


if __name__ == '__main__':
    main()
