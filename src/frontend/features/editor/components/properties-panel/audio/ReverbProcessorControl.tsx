import { Slider } from '@/frontend/components/ui/slider';
import { RotateCcw } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import type { VideoTrack } from '../../../stores/videoEditor/index';

/**
 * Reverb Processor — ONE bidirectional slider, resting at 0 (center).
 *   drag LEFT  (to -50): strip reverb — live STFT late-reverb suppression
 *   drag RIGHT (to +50): add reverb — live ConvolverNode with a diffuse IR
 *
 * LIVE like Motion Blur: every drag tick writes the amount to the track and
 * the preview engine hears it the same animation frame — no bake, no wait.
 * Export bakes the identical DSP via the python reverb-process pre-pass so
 * the file matches what preview played.
 */
export const ReverbProcessorControl: React.FC<{ track: VideoTrack }> = ({
  track,
}) => {
  const updateTrack = useVideoEditorStore((s) => s.updateTrack);
  const committedAmount = track.reverbProcessor?.amount ?? 0;
  const [amount, setAmount] = useState(committedAmount);

  // Track changed under us (undo, EDITH op, different clip selected) — follow it.
  useEffect(() => {
    setAmount(committedAmount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, committedAmount]);

  const apply = (v: number) => {
    const amt = Math.max(-50, Math.min(50, Math.round(v)));
    setAmount(amt);
    updateTrack(track.id, {
      reverbProcessor: { ...(track.reverbProcessor ?? {}), amount: amt },
    } as Partial<VideoTrack>);
  };

  const label = amount === 0 ? '0' : amount > 0 ? `+${amount}` : `${amount}`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">
          {amount < 0 ? 'Removing reverb' : amount > 0 ? 'Adding reverb' : 'Reverb'}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{label}</span>
          {amount !== 0 && (
            <button
              type="button"
              title="Reset to 0 (original audio)"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => apply(0)}
            >
              <RotateCcw className="size-3" />
            </button>
          )}
        </div>
      </div>
      <Slider
        value={[amount]}
        onValueChange={([v]) => apply(v)}
        min={-50}
        max={50}
        step={1}
        className="flex-1"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground/70">
        <span>Strip -50</span>
        <span>0</span>
        <span>Add +50</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Live in preview · baked identically on export
      </p>
    </div>
  );
};
