import type { TimelineMarker } from '../types/timeline.types';

/** 0:00 / 12:05 / 1:02:09 — the format YouTube expects in chapter lists. */
export function formatChapterTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Build a YouTube chapter list from timeline markers (sorted by time, one
 * `M:SS Label` line each). YouTube requires the first chapter at 00:00 —
 * an "Intro" line is prepended when the first marker starts later.
 */
export function buildYouTubeChapterText(
  markers: TimelineMarker[],
  fps: number,
): string {
  if (!markers.length || fps <= 0) return '';
  const sorted = [...markers].sort((a, b) => a.frame - b.frame);
  const lines: string[] = [];
  if (sorted[0].frame / fps >= 1) lines.push('0:00 Intro');
  for (const m of sorted) {
    lines.push(`${formatChapterTime(m.frame / fps)} ${m.label}`);
  }
  return lines.join('\n') + '\n';
}
