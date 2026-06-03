#!/usr/bin/env python3
"""
Speaker diarization using Resemblyzer speaker embeddings + scipy k-means.
Resemblyzer uses a pretrained GE2E speaker encoder (ResNet-style) that produces
256-dim speaker embeddings — far more discriminative than raw MFCCs.
"""

import sys
import json
import os
import subprocess
import tempfile
import numpy as np
from scipy.cluster.vq import kmeans2
from scipy.spatial.distance import cdist


def find_ffmpeg() -> str:
    import shutil
    for candidate in ['ffmpeg']:
        found = shutil.which(candidate)
        if found:
            return found
    return 'ffmpeg'


def extract_mono_wav(input_path: str, output_path: str, sr: int = 16000) -> None:
    ffmpeg = find_ffmpeg()
    subprocess.run(
        [ffmpeg, '-y', '-i', input_path, '-ar', str(sr), '-ac', '1', '-f', 'wav', output_path, '-loglevel', 'quiet'],
        check=True, capture_output=True,
    )


def silhouette_score(X: np.ndarray, labels: np.ndarray) -> float:
    n = min(len(X), 600)
    idx = np.random.choice(len(X), n, replace=False) if len(X) > n else np.arange(len(X))
    Xs, Ls = X[idx], labels[idx]
    D = cdist(Xs, Xs, 'cosine')
    scores = []
    for i in range(len(Xs)):
        same_mask = Ls == Ls[i]
        same_mask[i] = False
        if not np.any(same_mask):
            continue
        a = D[i][same_mask].mean()
        bs = [D[i][Ls == k].mean() for k in np.unique(Ls) if k != Ls[i] and np.any(Ls == k)]
        if not bs:
            continue
        b = min(bs)
        scores.append((b - a) / max(a, b, 1e-8))
    return float(np.mean(scores)) if scores else 0.0


def find_best_k(X: np.ndarray, max_k: int = 5) -> int:
    if len(X) < 8:
        return 1
    best_k, best_score = 2, -1.0
    for k in range(2, min(max_k + 1, len(X) // 3 + 1)):
        try:
            centroids, labels = kmeans2(X, k, iter=30, minit='points', seed=42)
            if len(np.unique(labels)) < k:
                continue
            score = silhouette_score(X, labels)
            if score > best_score:
                best_score, best_k = score, k
        except Exception:
            continue
    return best_k


def diarize(audio_path: str, num_speakers=None, max_speakers: int = 5) -> list:
    from resemblyzer import VoiceEncoder, preprocess_wav
    from pathlib import Path

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    try:
        extract_mono_wav(audio_path, tmp)
        wav = preprocess_wav(Path(tmp))
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

    total_dur = len(wav) / 16000.0

    encoder = VoiceEncoder()

    # Slice audio into overlapping windows for embeddings
    # 1.5s windows, 0.75s hop — good balance of resolution vs stability
    win_sec = 1.5
    hop_sec = 0.75
    sr = 16000
    win_n = int(win_sec * sr)
    hop_n = int(hop_sec * sr)

    windows = []
    timestamps = []
    i = 0
    while i + win_n <= len(wav):
        windows.append(wav[i:i + win_n])
        timestamps.append((i / sr, (i + win_n) / sr))
        i += hop_n

    if not windows:
        return [{'speaker': 'SPEAKER_A', 'start': 0.0, 'end': round(total_dur, 3)}]

    # Get speaker embeddings — 256-dim vectors per window
    embeds = np.array([encoder.embed_utterance(w) for w in windows])

    # Normalize (cosine similarity works better with unit vectors)
    norms = np.linalg.norm(embeds, axis=1, keepdims=True) + 1e-8
    embeds_n = embeds / norms

    if len(embeds_n) < 4:
        return [{'speaker': 'SPEAKER_A', 'start': 0.0, 'end': round(total_dur, 3)}]

    # Find optimal k or use provided value
    k = num_speakers if num_speakers else find_best_k(embeds_n, max_k=min(max_speakers, 5))
    k = max(1, min(k, len(embeds_n) // 2))

    if k == 1:
        return [{'speaker': 'SPEAKER_A', 'start': 0.0, 'end': round(total_dur, 3)}]

    centroids, labels = kmeans2(embeds_n, k, iter=40, minit='points', seed=42)
    speaker_ids = [f'SPEAKER_{chr(65 + i)}' for i in range(k)]

    # Build timeline from window labels
    raw = [(timestamps[i][0], timestamps[i][1], speaker_ids[labels[i]]) for i in range(len(timestamps))]

    # Merge consecutive same-speaker windows; allow small gaps (< 2s)
    merged = []
    for start, end, spk in raw:
        if merged and merged[-1][2] == spk and start - merged[-1][1] < 2.0:
            merged[-1][1] = end
        else:
            merged.append([start, end, spk])

    # Remove very short segments (< 1s) by absorbing into neighbors
    cleaned = []
    for seg in merged:
        if seg[1] - seg[0] < 1.0 and cleaned:
            cleaned[-1][1] = seg[1]
        else:
            cleaned.append(seg)

    # Fill timeline gaps and extend last segment to end
    result = []
    for i, (start, end, spk) in enumerate(cleaned):
        if result:
            result[-1]['end'] = round(start, 3)
        result.append({'speaker': spk, 'start': round(start, 3), 'end': round(end, 3)})
    if result:
        result[-1]['end'] = round(total_dur, 3)

    return result


if __name__ == '__main__':
    args = json.loads(sys.argv[1])
    try:
        segments = diarize(
            audio_path=args['audioPath'],
            num_speakers=args.get('numSpeakers'),
            max_speakers=args.get('maxSpeakers', 5),
        )
        speaker_count = len({s['speaker'] for s in segments})
        print(json.dumps({'success': True, 'segments': segments, 'speakerCount': speaker_count}))
    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'trace': traceback.format_exc()}))
