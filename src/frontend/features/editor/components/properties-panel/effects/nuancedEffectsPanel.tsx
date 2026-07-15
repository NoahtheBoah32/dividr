import { Button } from '@/frontend/components/ui/button';
import { Input } from '@/frontend/components/ui/input';
import { Separator } from '@/frontend/components/ui/separator';
import { Slider } from '@/frontend/components/ui/slider';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor/index';
import { operationEngine } from '@/frontend/features/mycelium/operationEngine';
import { cn } from '@/frontend/utils/utils';
import { FlipHorizontal, FlipVertical, Gauge, Loader2, RotateCw, Snowflake, Sun } from 'lucide-react';
import {
  RelightConfig,
  defaultRelight,
  relightFromLegacy,
} from '@/frontend/features/editor/preview/utils/paintedLightUtils';
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Manual controls for the three nuanced skills. Each Apply enqueues the exact
 * same op EDITH emits, so the manual and AI paths run identical code. Styled to
 * match DiviDr — monochrome with the green --secondary accent, shared Slider /
 * Button / Input primitives.
 */

const REGION_PRESETS: { label: string; value: string }[] = [
  { label: 'Left', value: '0,0,0.5,1' },
  { label: 'Right', value: '0.5,0,0.5,1' },
  { label: 'Top', value: '0,0,1,0.5' },
  { label: 'Bottom', value: '0,0.5,1,0.5' },
  { label: 'Center', value: 'ellipse:0.5,0.5,0.28,0.4' },
];

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

const Seg: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }> = ({
  active, onClick, children, disabled,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex-1 h-8 rounded-md text-xs font-medium transition-colors border',
      active
        ? 'bg-[hsl(var(--secondary))] text-white border-transparent'
        : 'bg-transparent text-muted-foreground border-border hover:bg-muted',
      disabled && 'opacity-50 pointer-events-none',
    )}
  >
    {children}
  </button>
);

interface Props {
  selectedTrackIds: string[];
}

export const NuancedEffectsPanel: React.FC<Props> = ({ selectedTrackIds }) => {
  const tracks = useVideoEditorStore((s) => s.tracks);
  const fps = useVideoEditorStore((s) => s.timeline?.fps ?? 30);
  const updateTrack = useVideoEditorStore((s) => s.updateTrack);
  const updateTrackProperty = useVideoEditorStore((s) => (s as any).updateTrackProperty);
  const beginGroup = useVideoEditorStore((s) => (s as any).beginGroup);
  const endGroup = useVideoEditorStore((s) => (s as any).endGroup);

  const clip = useMemo(
    () => tracks.find((t: any) => t.type === 'video' && selectedTrackIds.includes(t.id)),
    [tracks, selectedTrackIds],
  );
  const clipDurSec = clip ? Math.max(1, (((clip as any).endFrame ?? 0) - ((clip as any).startFrame ?? 0)) / fps) : 0;

  const [running, setRunning] = useState<string | null>(null);

  // Hold the world
  const [fzMode, setFzMode] = useState<'world-frozen' | 'subject-frozen' | 'full'>('world-frozen');
  const [fzStart, setFzStart] = useState(0);
  const [fzEnd, setFzEnd] = useState(2);

  // In-frame speed
  const [rsSpeed, setRsSpeed] = useState(0.4);
  const [rsRegion, setRsRegion] = useState(REGION_PRESETS[0].value);
  const [rsStart, setRsStart] = useState(0);
  const [rsEnd, setRsEnd] = useState(2);
  const [rsInvert, setRsInvert] = useState(false);
  const [rsLasso, setRsLasso] = useState<Array<[number, number]> | null>(null); // normalized polygon from LassoOverlay
  const [rsShape, setRsShape] = useState<'box' | 'ellipse' | 'poly' | null>(null); // which draw tool is active (for highlight)

  // Reset region defaults when the selected clip changes.
  useEffect(() => {
    if (!clip) return;
    const end = Math.max(1, Math.min(4, Math.round(clipDurSec)));
    setFzStart(0); setFzEnd(end);
    setRsStart(0); setRsEnd(end);
    setRsInvert(false); setRsLasso(null); setRsShape(null);
  }, [clip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A completed lasso selection (from LassoOverlay) becomes the speed region.
  useEffect(() => {
    const onLasso = (e: any) => {
      const pts = e.detail?.points;
      if (Array.isArray(pts) && pts.length >= 3) {
        setRsLasso(pts); setRsRegion('lasso');
        if (e.detail?.shape) setRsShape(e.detail.shape); // keep the drawn tool highlighted after release
      }
    };
    window.addEventListener('dividr:lassoComplete', onLasso);
    return () => window.removeEventListener('dividr:lassoComplete', onLasso);
  }, []);

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

  // When a region-speed effect is applied (by EDITH or manually), sync the slider/region to it
  // so the manual controls pick up exactly where EDITH left off.
  const appliedRs = (clip as any)?.regionalSpeed;
  useEffect(() => {
    if (!appliedRs) return;
    if (typeof appliedRs.speed === 'number') setRsSpeed(appliedRs.speed);
    if (typeof appliedRs.invert === 'boolean') setRsInvert(appliedRs.invert);
    const region: string = appliedRs.region ?? '';
    const preset = REGION_PRESETS.find((p) => p.value === region);
    if (preset) { setRsRegion(preset.value); setRsLasso(null); }
    else if (region.startsWith('lasso:')) {
      // A drawn region persists as `lasso:[[x,y],…]` — parse it back so the chip, the
      // "Apply to drawn region" label, and the active descriptor all rehydrate on re-select.
      try {
        const pts = JSON.parse(region.slice('lasso:'.length));
        if (Array.isArray(pts) && pts.length >= 3) { setRsLasso(pts as Array<[number, number]>); setRsRegion('lasso'); }
      } catch { /* ignore malformed */ }
    }
  }, [clip?.id, appliedRs?.speed, appliedRs?.region, appliedRs?.invert]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const applyFreeze = () => {
    setRunning('freeze');
    operationEngine.enqueue({
      type: 'selectiveFreeze', clipId: clip.id,
      startSeconds: fzStart, endSeconds: fzEnd, mode: fzMode,
    } as any);
  };
  const applyRegional = () => {
    setRunning('speed');
    const op: any = {
      type: 'regionalSpeed', clipId: clip.id,
      startSeconds: rsStart, endSeconds: rsEnd, speed: rsSpeed, invert: rsInvert,
    };
    // A drawn lasso wins over the preset region; the storeAdapter turns it into lasso:[...].
    if (rsLasso && rsLasso.length >= 3) op.lasso = rsLasso;
    else op.region = rsRegion;
    operationEngine.enqueue(op);
  };
  const armLasso = (shape: 'box' | 'ellipse' | 'poly') => {
    setRsShape(shape); // remember the chosen tool so its button highlights (not always Lasso)
    window.dispatchEvent(new CustomEvent('dividr:lassoArm', { detail: { shape } }));
  };

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

  const num = (v: string) => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.max(0, n); };

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {/* ── Hold the World ───────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={<Snowflake className="size-4" />} title="Hold the World"
          hint="Freeze the scene while one thing keeps moving — or freeze the subject while the world rushes past." />
        <div className="flex gap-2">
          <Seg active={fzMode === 'world-frozen'} onClick={() => setFzMode('world-frozen')} disabled={!!running}>World freezes</Seg>
          <Seg active={fzMode === 'subject-frozen'} onClick={() => setFzMode('subject-frozen')} disabled={!!running}>Subject freezes</Seg>
          <Seg active={fzMode === 'full'} onClick={() => setFzMode('full')} disabled={!!running}>Whole frame</Seg>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">From (s)</label>
            <Input type="number" min={0} step={0.1} value={fzStart}
              onChange={(e) => setFzStart(num(e.target.value))} className="h-8 text-xs" disabled={!!running} />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">To (s)</label>
            <Input type="number" min={0} step={0.1} value={fzEnd}
              onChange={(e) => setFzEnd(num(e.target.value))} className="h-8 text-xs" disabled={!!running} />
          </div>
        </div>
        <Button data-testid="freeze-apply" onClick={applyFreeze} disabled={!!running || fzEnd <= fzStart}
          className="w-full h-8 bg-[hsl(var(--secondary))] text-white hover:bg-[hsl(var(--secondary))]/90">
          {running === 'freeze' ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Freezing…</> : 'Apply freeze'}
        </Button>
      </div>

      <Separator />

      {/* ── In-Frame Speed ───────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={<Gauge className="size-4" />} title="In-Frame Speed"
          hint="Run one painted region at its own speed while the rest stays real-time." />
        <p className="text-[11px] leading-snug">
          {appliedRs?.appliedByEdith
            ? <span className="text-[hsl(var(--secondary))]">● Active{rsLasso ? ' · drawn region' : (REGION_PRESETS.find((p) => p.value === appliedRs.region) ? ` · ${REGION_PRESETS.find((p) => p.value === appliedRs.region)!.label.toLowerCase()}` : '')} — adjust and re-apply.</span>
            : <span className="text-muted-foreground">Pick or draw a region, set the speed, and Apply — or ask EDITH.</span>}
        </p>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">Region speed</label>
            <span className="text-xs tabular-nums text-muted-foreground">{rsSpeed < 1 ? `${Math.round(rsSpeed * 100)}%` : `${rsSpeed}×`}</span>
          </div>
          <Slider value={[rsSpeed]} min={0.1} max={2} step={0.05}
            onValueChange={(v) => setRsSpeed(v[0])} disabled={!!running} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Region</label>
          <div className="flex gap-1.5">
            {REGION_PRESETS.map((p) => (
              <Seg key={p.label} active={rsRegion === p.value && !rsLasso} onClick={() => { setRsRegion(p.value); setRsLasso(null); setRsShape(null); window.dispatchEvent(new CustomEvent('dividr:lassoDisarm')); }} disabled={!!running}>
                {p.label}
              </Seg>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Seg active={rsShape === 'box'} onClick={() => armLasso('box')} disabled={!!running}>{'▱ Box'}</Seg>
            <Seg active={rsShape === 'ellipse'} onClick={() => armLasso('ellipse')} disabled={!!running}>{'◯ Oval'}</Seg>
            <Seg active={rsShape === 'poly'} onClick={() => armLasso('poly')} disabled={!!running}>{'✎ Lasso'}</Seg>
          </div>
          {rsLasso && (
            <p className="text-[10px] text-[hsl(var(--secondary))]">
              Custom region drawn ·{' '}
              <button type="button" className="underline" onClick={() => { setRsLasso(null); setRsRegion(REGION_PRESETS[0].value); setRsShape(null); window.dispatchEvent(new CustomEvent('dividr:lassoDisarm')); }}>clear</button>
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" checked={rsInvert} onChange={(e) => setRsInvert(e.target.checked)} disabled={!!running}
            className="accent-[hsl(var(--secondary))] size-3.5" />
          Invert — keep the region real-time, slow the rest
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">From (s)</label>
            <Input type="number" min={0} step={0.1} value={rsStart}
              onChange={(e) => setRsStart(num(e.target.value))} className="h-8 text-xs" disabled={!!running} />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">To (s)</label>
            <Input type="number" min={0} step={0.1} value={rsEnd}
              onChange={(e) => setRsEnd(num(e.target.value))} className="h-8 text-xs" disabled={!!running} />
          </div>
        </div>
        <Button data-testid="regional-apply" onClick={applyRegional} disabled={!!running || rsEnd <= rsStart}
          className="w-full h-8 bg-[hsl(var(--secondary))] text-white hover:bg-[hsl(var(--secondary))]/90">
          {running === 'speed' ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Retiming…</> : (rsLasso ? 'Apply to drawn region' : 'Apply region speed')}
        </Button>
      </div>

      <Separator />

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
