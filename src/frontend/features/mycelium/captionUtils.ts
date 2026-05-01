/** Pure helpers — no Electron or store dependencies, safe to unit-test. */

export function pickSubtitleRow(
  existingSubtitleTracks: Array<{ trackRowIndex?: number; startFrame?: number; endFrame?: number }>,
  newStartFrame: number,
  newEndFrame: number,
): number {
  const usedRows = [
    ...new Set(existingSubtitleTracks.map((t) => t.trackRowIndex ?? 1)),
  ].sort((a, b) => a - b);

  if (usedRows.length === 0) return 1;

  for (const row of usedRows) {
    const rowTracks = existingSubtitleTracks.filter((t) => (t.trackRowIndex ?? 1) === row);
    const collides = rowTracks.some(
      (t) => newStartFrame < (t.endFrame ?? 0) && newEndFrame > (t.startFrame ?? 0),
    );
    if (!collides) return row;
  }

  return Math.max(...usedRows) + 1;
}
