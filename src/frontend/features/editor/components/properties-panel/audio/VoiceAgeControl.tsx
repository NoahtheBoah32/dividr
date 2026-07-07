/**
 * VoiceAgeControl — the manual counterpart to EDITH's `ageVoice` op (Skill 3).
 *
 * One slider (20–90 years) that ages/de-ages the speaker's voice in real time via
 * the VoiceIsolationEngine ager stage (pitch+formant shift + timbre morph). Dragging
 * pushes params to the live engine with zero latency (updateAge) and commits to the
 * track on release as a single undo step — the exact pattern VoiceIsolationCurve uses.
 *
 * Gating: locked until EDITH runs `ageVoice` once (sets voiceAge.appliedByEdith),
 * mirroring the isolation curve. Purely additive — nothing existing is changed.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Lock } from 'lucide-react';
import { Switch } from '@/frontend/components/ui/switch';
import { Slider } from '@/frontend/components/ui/slider';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import type { VideoTrack } from '../../../stores/videoEditor/index';
import { normalizeSourceId } from '../../../preview/services/FrameResolver';
import { VoiceIsolationEngine } from '../../../preview/services/VoiceIsolationEngine';
import {
  ageToParams,
  ageLabel,
  AGE_PRESETS,
  DEFAULT_AGE_YEARS,
} from '../../../preview/utils/voiceAgeParams';

interface VoiceAgeControlProps {
  track: VideoTrack;
}

const VoiceAgeControlComponent: React.FC<VoiceAgeControlProps> = ({ track }) => {
  const updateTrack = useVideoEditorStore((s) => s.updateTrack);
  const beginGroup = useVideoEditorStore((s) => (s as any).beginGroup);
  const endGroup = useVideoEditorStore((s) => (s as any).endGroup);

  const va = (track as any).voiceAge as
    | { enabled?: boolean; ageYears?: number; appliedByEdith?: boolean }
    | undefined;
  const enabled = !!va?.enabled;
  const unlocked = !!va?.appliedByEdith;

  // The live ager taps AUDIO elements only (same as isolation), so on an
  // embedded-audio video track the slider would change nothing — lock with a note.
  const isAudioTrack = track.type === 'audio';

  const sourceId = useMemo(
    () => normalizeSourceId((track as any).previewUrl || track.source),
    [track],
  );

  const [years, setYears] = useState<number>(va?.ageYears ?? DEFAULT_AGE_YEARS);

  // Re-sync from the store when it changes from outside (EDITH / undo) and we're not dragging.
  const storedKey = `${va?.ageYears ?? ''}|${enabled}`;
  useEffect(() => {
    setYears(va?.ageYears ?? DEFAULT_AGE_YEARS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  // Push to the live engine whenever the value or enabled flips.
  useEffect(() => {
    if (!sourceId) return;
    VoiceIsolationEngine.updateAge(sourceId, enabled ? ageToParams(years) : null, enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, enabled]);

  const pushLive = useCallback(
    (y: number) => {
      if (sourceId) VoiceIsolationEngine.updateAge(sourceId, ageToParams(y), enabled);
    },
    [sourceId, enabled],
  );

  const commit = useCallback(
    (y: number, nextEnabled = enabled) => {
      beginGroup?.('Voice age');
      updateTrack(track.id, {
        voiceAge: {
          enabled: nextEnabled,
          ageYears: y,
          appliedByEdith: unlocked,
        },
      } as any);
      endGroup?.();
    },
    [track.id, enabled, unlocked, updateTrack, beginGroup, endGroup],
  );

  if (!isAudioTrack) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        Voice aging works on a separate audio track. This clip's audio is embedded in
        the video, so there's nothing to age here.
      </p>
    );
  }

  if (!unlocked) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 p-2.5">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Ask EDITH to “make him sound older” (or “age the voice to 60”) to unlock the
          Voice Age slider.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="size-3.5 text-muted-foreground" />
          <span className="text-[12px] tabular-nums text-foreground">{ageLabel(years)}</span>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(on) => {
            if (sourceId) VoiceIsolationEngine.updateAge(sourceId, on ? ageToParams(years) : null, on);
            commit(years, on);
          }}
        />
      </div>

      <Slider
        min={20}
        max={90}
        step={1}
        value={[years]}
        disabled={!enabled}
        onValueChange={(v) => {
          const y = v[0] ?? years;
          setYears(y);
          pushLive(y);
        }}
        onValueCommit={(v) => commit(v[0] ?? years)}
      />

      <div className="flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>younger</span>
        <span>older</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {AGE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={!enabled}
            onClick={() => {
              setYears(p.years);
              pushLive(p.years);
              commit(p.years);
            }}
            className="rounded bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export const VoiceAgeControl = React.memo(VoiceAgeControlComponent);
export default VoiceAgeControl;
