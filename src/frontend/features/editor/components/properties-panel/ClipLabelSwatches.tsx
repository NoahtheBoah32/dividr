import React from 'react';
import { CLIP_LABEL_COLORS } from '@/frontend/features/mycelium/colorLooks';
import { useVideoEditorStore } from '../../stores/videoEditor/index';

/**
 * Labels/Colors — compact swatch row to color-code the selected clip(s).
 * Lives inside the Color tab (ColorGradePanel) and matches its section idiom.
 * Writes `labelColor` on every selected track; the timeline renders it as a
 * stripe + tint. EDITH drives the same field via the `setClipColor` op.
 */
export const ClipLabelSwatches: React.FC<{ selectedTrackIds: string[] }> = ({
  selectedTrackIds,
}) => {
  const tracks = useVideoEditorStore((state) => state.tracks);
  const updateTrack = useVideoEditorStore((state) => state.updateTrack);

  const selected = tracks.filter((t) => selectedTrackIds.includes(t.id));
  if (selected.length === 0) return null;
  const current = (selected[0] as any).labelColor as string | undefined;

  const setAll = (labelColor: string | undefined) => {
    for (const t of selected) updateTrack(t.id, { labelColor } as any);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Clip Label
        </label>
        {current && (
          <button
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setAll(undefined)}
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {Object.entries(CLIP_LABEL_COLORS).map(([name, hex]) => (
          <button
            key={name}
            title={name}
            aria-label={`Label ${name}`}
            onClick={() => setAll(hex)}
            className="rounded-full transition-transform hover:scale-110"
            style={{
              width: 15,
              height: 15,
              background: hex,
              border: current === hex ? '2px solid #fff' : '2px solid transparent',
              boxShadow: current === hex ? '0 0 0 1px rgba(0,0,0,0.6)' : 'none',
            }}
          />
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/50">
        Color-codes the clip on the timeline — not the footage.
      </p>
    </div>
  );
};
