import { Button } from '@/frontend/components/ui/button';
import { Separator } from '@/frontend/components/ui/separator';
import { Slider } from '@/frontend/components/ui/slider';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor/index';
import { operationEngine } from '@/frontend/features/mycelium/operationEngine';
import { cn } from '@/frontend/utils/utils';
import { FlipHorizontal, FlipVertical, RotateCw, Sun } from 'lucide-react';
import {
  RelightConfig,
  defaultRelight,
  relightFromLegacy,
} from '@/frontend/features/editor/preview/utils/paintedLightUtils';
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Manual controls for the nuanced skills. Each Apply enqueues the exact
 * same op EDITH emits, so the manual and AI paths run identical code. Styled to
 * match DiviDr — monochrome with the green --secondary accent, shared Slider /
 * Button primitives.
 */

// The relight sliders. Each binds live to one field of `track.relight`; drag = live
// preview, release = one undo step. The engine is additive-only: every slider at zero
// = the original video exactly; raising them only ADDS light. (Form was removed — at
// high values it embossed the whole frame into a glaze; the engine now fixes it at a
// sane internal value.)
const RELIGHT_SLIDERS: {
  label: string;
  field: keyof RelightConfig;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}[] = [
  { label: 'Intensity', field: 'intensity', min: 0, max: 2.5, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: 'Ambient (scene)', field: 'ambient', min: 0, max: 1, step: 0.02, fmt: (v) => `${Math.round(v * 100)}%` },
  { label: 'Softness', field: 'wrap', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
  { label: 'Detail', field: 'detail', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  { label: 'Sheen', field: 'sheen', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { label: 'Rim', field: 'rim', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { label: 'Spill', field: 'spill', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { label: 'Negative fill', field: 'neg', min: 0, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
  { label: 'Reach', field: 'radius', min: 0.2, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { label: 'Light height', field: 'height', min: 0.15, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
];

const SectionHeading: React.FC<{ icon: React.ReactNode; title: string; hint: string }> = ({ icon, title, hint }) => (
  <div className="space-y-1">
    <div className="flex items-center gap-2">
      <span className="text-[hsl(var(--secondary))]">{icon}</span>
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
    </div>
    <p className="text-xs text-muted-foreground leading-snug">{hint}</p>
  </div>
);

interface Props {
  selectedTrackIds: string[];
}

export const NuancedEffectsPanel: React.FC<Props> = ({ selectedTrackIds }) => {
  const tracks = useVideoEditorStore((s) => s.tracks);
  const updateTrack = useVideoEditorStore((s) => s.updateTrack);
  const updateTrackProperty = useVideoEditorStore((s) => (s as any).updateTrackProperty);
  const beginGroup = useVideoEditorStore((s) => (s as any).beginGroup);
  const endGroup = useVideoEditorStore((s) => (s as any).endGroup);

  const clip = useMemo(
    () => tracks.find((t: any) => t.type === 'video' && selectedTrackIds.includes(t.id)),
    [tracks, selectedTrackIds],
  );

  const [running, setRunning] = useState<string | null>(null);

  // A click in the preview (LightBrushOverlay) repositions the relight and enables it —
  // an alternative to dragging the ring handle. Keeps the whole-scene relight model.
  useEffect(() => {
    const onLight = (e: any) => {
      const d = e.detail;
      if (!clip || !d?.pos) return;
      const cur = ((clip as any).relight as RelightConfig | undefined)
        ?? relightFromLegacy((clip as any).paintedLights, (clip as any).lightSource)
        ?? defaultRelight();
      beginGroup?.('Place light');
      updateTrack(clip.id, { relight: { ...cur, enabled: true, pos: d.pos as [number, number] } } as any);
      endGroup?.();
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    };
    window.addEventListener('dividr:lightBrushComplete', onLight);
    return () => window.removeEventListener('dividr:lightBrushComplete', onLight);
  }, [clip, updateTrack, beginGroup, endGroup]);

  // Clear the running state when an op reports completion.
  useEffect(() => {
    const onStatus = (e: any) => {
      const t = e.detail?.text ?? '';
      if (/applied|retimed|failed|No clear|produced/i.test(t)) setRunning(null);
    };
    window.addEventListener('edith:status', onStatus);
    return () => window.removeEventListener('edith:status', onStatus);
  }, []);

  if (!clip) return null;

  // ── Relight (Light Brush v2) — the screen-space relighter, driven by track.relight ──
  // The active config: an explicit relight, else legacy paintedLights adapted to the
  // new engine, else null (nothing lit yet). `rc` is that config or a sensible default.
  const activeRelight: RelightConfig | null =
    ((clip as any)?.relight?.enabled ? ((clip as any).relight as RelightConfig) : null)
    ?? relightFromLegacy((clip as any)?.paintedLights, (clip as any)?.lightSource);
  const isRelightActive = !!activeRelight;
  const rc: RelightConfig = activeRelight ?? defaultRelight();

  // Detect enqueues the SAME op EDITH emits (now seeds a relight from the scene).
  const detectLight = () => { if (clip) operationEngine.enqueue({ type: 'detectLight' } as any); };
  const addRelight = () => {
    if (!clip) return;
    const seed = (clip as any).lightSource?.color as [number, number, number] | undefined;
    beginGroup?.('Add light');
    updateTrack(clip.id, { relight: { ...defaultRelight(), ...(seed ? { color: seed } : {}) } } as any);
    endGroup?.();
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  };
  const resetRelight = () => {
    if (!clip) return;
    beginGroup?.('Reset light');
    updateTrack(clip.id, { relight: undefined, paintedLights: [], lightSource: undefined } as any);
    endGroup?.();
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  };
  // Live drag (no undo entry) vs committed change (one undo entry) — same target field.
  const liveRelight = (patch: Partial<RelightConfig>) => {
    if (!clip) return;
    updateTrackProperty(clip.id, { relight: { ...rc, enabled: true, ...patch } } as any);
  };
  const commitRelight = (patch: Partial<RelightConfig>) => {
    if (!clip) return;
    beginGroup?.('Adjust light');
    updateTrack(clip.id, { relight: { ...rc, enabled: true, ...patch } } as any);
    endGroup?.();
  };

  // Transform (flip / rotate) — standard editor features DiviDr was missing. Manual
  // buttons here enqueue nothing heavy: they toggle/set the same fields EDITH's
  // flipClip / rotateClip ops write, so the compositor mirrors/rotates the clip live.
  const flipClip = (axis: 'horizontal' | 'vertical') => {
    if (!clip) return;
    beginGroup?.('Flip');
    updateTrack(
      clip.id,
      (axis === 'horizontal'
        ? { flipH: !(clip as any).flipH }
        : { flipV: !(clip as any).flipV }) as any,
    );
    endGroup?.();
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  };
  const rotate90 = () => {
    if (!clip) return;
    const tf = (((clip as any).textTransform ?? {}) as any);
    const next = ((((tf.rotation ?? 0) + 90) % 360) + 360) % 360;
    beginGroup?.('Rotate');
    updateTrack(
      clip.id,
      {
        textTransform: {
          x: tf.x ?? 0, y: tf.y ?? 0, scale: tf.scale ?? 1,
          width: tf.width, height: tf.height, ...tf, rotation: next,
        },
      } as any,
    );
    endGroup?.();
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {/* ── Transform (flip / rotate) ───────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={<FlipHorizontal className="size-4" />} title="Transform"
          hint="Mirror or rotate the clip — the standard flip/rotate DiviDr was missing." />
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => flipClip('horizontal')}
            className={cn('flex-1 h-8', (clip as any).flipH && 'bg-[hsl(var(--secondary))] text-white border-transparent')}>
            <FlipHorizontal className="size-3.5 mr-1.5" />Flip H
          </Button>
          <Button variant="outline" onClick={() => flipClip('vertical')}
            className={cn('flex-1 h-8', (clip as any).flipV && 'bg-[hsl(var(--secondary))] text-white border-transparent')}>
            <FlipVertical className="size-3.5 mr-1.5" />Flip V
          </Button>
          <Button variant="outline" onClick={rotate90} className="flex-1 h-8">
            <RotateCw className="size-3.5 mr-1.5" />90°
          </Button>
        </div>
      </div>

      <Separator />

      {/* ── Light (screen-space relight) ────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={<Sun className="size-4" />} title="Light"
          hint="Add light to the shot from a lamp you drag inside the frame. It reads the scene's own shapes and only ever ADDS — the original footage is never darkened." />
        <div className="flex gap-2">
          <Button onClick={detectLight} disabled={!!running}
            className="flex-1 h-8 bg-[hsl(var(--secondary))] text-white hover:bg-[hsl(var(--secondary))]/90">
            Detect from scene
          </Button>
          {isRelightActive ? (
            <Button variant="outline" onClick={resetRelight} className="flex-1 h-8">Reset light</Button>
          ) : (
            <Button variant="outline" onClick={addRelight} className="flex-1 h-8">Add light</Button>
          )}
        </div>

        {isRelightActive && (
          <>
            <p className="text-[11px] leading-snug text-[hsl(var(--secondary))]">
              ● Drag the ring in the preview to move the light. Raise Intensity or
              Ambient to add light — at zero the video stays exactly as shot.
            </p>

            {RELIGHT_SLIDERS.map((sl) => (
              <div key={sl.field} className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{sl.label}</span>
                  <span className="tabular-nums">{sl.fmt(rc[sl.field] as number)}</span>
                </div>
                <Slider min={sl.min} max={sl.max} step={sl.step} value={[rc[sl.field] as number]}
                  onValueChange={(v) => liveRelight({ [sl.field]: v[0] } as Partial<RelightConfig>)}
                  onValueCommit={(v) => commitRelight({ [sl.field]: v[0] } as Partial<RelightConfig>)} />
              </div>
            ))}
          </>
        )}
      </div>

    </div>
  );
};

export default NuancedEffectsPanel;
