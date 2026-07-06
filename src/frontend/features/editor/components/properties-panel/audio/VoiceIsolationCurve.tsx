/**
 * VoiceIsolationCurve — the draggable "separation curve" the user validated in
 * the HTML concept, wired to real audio.
 *
 * x = voiceness (left = noise/ambiance, right = voice); y = keep-gain.
 * Dragging a node updates the live Web Audio EQ immediately (zero latency via
 * VoiceIsolationEngine.updateCurve), and commits to the track on pointer-up as a
 * single undo step. A small scrolling spectrogram (fed by the engine's analyser)
 * shows the isolated OUTPUT in real time while the clip plays.
 *
 * Gating: locked until EDITH runs `isolateVoice` (sets voiceIsolation on the
 * track). Styled to match DiviDr — gray UI, green curve.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Loader2, Waves } from 'lucide-react';
import { Button } from '@/frontend/components/ui/button';
import { Switch } from '@/frontend/components/ui/switch';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import type { VideoTrack } from '../../../stores/videoEditor/index';
import { normalizeSourceId } from '../../../preview/services/FrameResolver';
import { VoiceIsolationEngine } from '../../../preview/services/VoiceIsolationEngine';
import { SeparationCache } from '../../../preview/services/SeparationCache';
import {
  type CurveNode,
  sampleCurve,
  normalizeNodes,
  separationLabel,
  DEFAULT_VOICE_ISOLATION_NODES,
  VOICE_ISOLATION_PRESETS,
} from '../../../preview/utils/voiceIsolationCurve';

interface VoiceIsolationCurveProps {
  track: VideoTrack;
}

// SVG geometry — ported 1:1 from the validated concept.
const padL = 40,
  padR = 20,
  padT = 18,
  padB = 38,
  VW = 440,
  VH = 250;
const plotW = VW - padL - padR;
const plotH = VH - padT - padB;
const sx = (x: number) => padL + x * plotW;
const sy = (y: number) => padT + (1 - y) * plotH;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const PRESET_LABELS: { key: keyof typeof VOICE_ISOLATION_PRESETS; label: string }[] =
  [
    { key: 'studio', label: 'Studio' },
    { key: 'podcast', label: 'Podcast' },
    { key: 'ambiance', label: 'Keep ambiance' },
    { key: 'light', label: 'Light' },
  ];

const VoiceIsolationCurveComponent: React.FC<VoiceIsolationCurveProps> = ({
  track,
}) => {
  const updateTrack = useVideoEditorStore((state) => state.updateTrack);
  const beginGroup = useVideoEditorStore((state) => (state as any).beginGroup);
  const endGroup = useVideoEditorStore((state) => (state as any).endGroup);

  const vi = (track as any).voiceIsolation as
    | { enabled?: boolean; nodes?: CurveNode[]; appliedByEdith?: boolean }
    | undefined;
  const enabled = !!vi?.enabled;

  // The live engine taps AUDIO elements only and export bakes EQ only on audio
  // tracks. On a video track (embedded-audio clip with no separate audio row),
  // the curve would change nothing — so we lock it with an explanatory note
  // rather than present a working-looking control that has no effect.
  const isAudioTrack = track.type === 'audio';

  const sourceId = useMemo(
    () => normalizeSourceId((track as any).previewUrl || track.source),
    [track],
  );

  // Separation bake status (the curve performs TRUE separation once stems are
  // baked; until then it falls back to EQ-only on the full mix).
  const [, forceSep] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!sourceId) return;
    return SeparationCache.subscribe(sourceId, forceSep);
  }, [sourceId]);
  const sepStatus =
    (track as any).separation?.status ?? SeparationCache.getState(sourceId);
  const sepBaking = sepStatus === 'processing';
  const sepReady =
    sepStatus === 'cached' || SeparationCache.hasCached(sourceId);
  const sepProgress = SeparationCache.getProgress(sourceId);
  const sepMessage = SeparationCache.getDisplayMessage(sourceId);

  // Local node state for smooth dragging (committed to the store on pointer-up).
  const [nodes, setNodes] = useState<CurveNode[]>(() =>
    normalizeNodes(vi?.nodes ?? DEFAULT_VOICE_ISOLATION_NODES),
  );
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);

  // Re-sync local nodes when the track's stored curve changes from outside (EDITH / undo).
  const storedKey = JSON.stringify(vi?.nodes ?? null);
  useEffect(() => {
    if (draggingRef.current) return;
    setNodes(normalizeNodes(vi?.nodes ?? DEFAULT_VOICE_ISOLATION_NODES));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  // Push the current curve to the live engine whenever it changes.
  useEffect(() => {
    VoiceIsolationEngine.updateCurve(sourceId, nodes, enabled);
  }, [sourceId, nodes, enabled]);

  const samples = useMemo(() => sampleCurve(nodes), [nodes]);
  const curvePath = useMemo(() => {
    let d = '';
    samples.forEach((p, i) => {
      d += (i ? ' L ' : 'M ') + sx(p.x) + ' ' + sy(p.y);
    });
    return d;
  }, [samples]);
  const fillPath = `${curvePath} L ${sx(1)} ${sy(0)} L ${sx(0)} ${sy(0)} Z`;
  const label = useMemo(() => separationLabel(nodes), [nodes]);

  const commit = useCallback(
    (next: CurveNode[]) => {
      beginGroup?.('Voice isolation curve');
      updateTrack(track.id, {
        voiceIsolation: {
          ...(vi ?? {}),
          enabled: vi?.enabled ?? true,
          appliedByEdith: vi?.appliedByEdith ?? true,
          nodes: next.map((n) => ({ x: n.x, y: n.y })),
        },
      } as any);
      endGroup?.();
    },
    [beginGroup, endGroup, updateTrack, track.id, vi],
  );

  const toData = useCallback((e: React.PointerEvent | PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = (e as PointerEvent).clientX;
    pt.y = (e as PointerEvent).clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const l = pt.matrixTransform(ctm.inverse());
    return {
      x: clamp((l.x - padL) / plotW, 0, 1),
      y: clamp(1 - (l.y - padT) / plotH, 0, 1),
    };
  }, []);

  const onNodePointerDown = useCallback(
    (i: number, e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      setActiveIdx(i);
      svgRef.current?.setPointerCapture(e.pointerId);
      VoiceIsolationEngine.resume();
    },
    [],
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (activeIdx < 0) return;
      const d = toData(e);
      setNodes((prev) => {
        const next = prev.map((n) => ({ ...n }));
        const i = activeIdx;
        next[i].y = d.y;
        // Endpoints keep their x; middle nodes can slide between neighbors.
        if (i > 0 && i < next.length - 1) {
          next[i].x = clamp(d.x, next[i - 1].x + 0.04, next[i + 1].x - 0.04);
        }
        VoiceIsolationEngine.updateCurve(sourceId, next, enabled);
        return next;
      });
    },
    [activeIdx, toData, sourceId, enabled],
  );

  const endDrag = useCallback(() => {
    if (activeIdx < 0) return;
    setActiveIdx(-1);
    draggingRef.current = false;
    commit(nodes);
  }, [activeIdx, nodes, commit]);

  const applyPreset = useCallback(
    (key: keyof typeof VOICE_ISOLATION_PRESETS) => {
      const next = VOICE_ISOLATION_PRESETS[key].map((p) => ({ ...p }));
      setNodes(next);
      VoiceIsolationEngine.updateCurve(sourceId, next, enabled);
      commit(next);
    },
    [sourceId, enabled, commit],
  );

  const toggleEnabled = useCallback(
    (on: boolean) => {
      beginGroup?.('Voice isolation toggle');
      updateTrack(track.id, {
        voiceIsolation: {
          ...(vi ?? {}),
          enabled: on,
          appliedByEdith: vi?.appliedByEdith ?? true,
          nodes: nodes.map((n) => ({ x: n.x, y: n.y })),
        },
      } as any);
      endGroup?.();
      VoiceIsolationEngine.updateCurve(sourceId, nodes, on);
    },
    [beginGroup, endGroup, updateTrack, track.id, vi, nodes, sourceId],
  );

  // ---- Live spectrogram of the isolated output -------------------------------
  // Only spins the rAF loop while the source is actually tapped (i.e. playing
  // through the isolation graph). When idle it re-checks on a slow timer instead
  // of burning a frame every 16ms doing nothing.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;
    const W = 220;
    const H = 54;
    const schedule = (fn: () => void, tapped: boolean) => {
      if (tapped) raf = requestAnimationFrame(fn);
      else idleTimer = setTimeout(fn, 200);
    };
    const draw = () => {
      if (!mounted) return;
      const canvas = canvasRef.current;
      const analyser = VoiceIsolationEngine.getAnalyser(sourceId);
      if (canvas && analyser) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const bins = analyser.frequencyBinCount;
          const data = new Uint8Array(bins);
          analyser.getByteFrequencyData(data);
          // Scroll left 1px by blitting the canvas onto itself — far cheaper than
          // a per-frame getImageData/putImageData CPU readback.
          ctx.drawImage(canvas, -1, 0);
          ctx.clearRect(W - 1, 0, 1, H);
          // draw newest column on the right (low freq at bottom)
          const useBins = Math.min(bins, 256);
          for (let y = 0; y < H; y++) {
            const bi = Math.floor((y / H) * useBins);
            const mag = data[bi] / 255;
            const k = Math.pow(mag, 0.85);
            // green-tinted, on the DiviDr dark gray base
            const r = Math.round(18 + 35 * k);
            const g = Math.round(22 + 205 * k);
            const b = Math.round(28 + 130 * k);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(W - 1, H - 1 - y, 1, 1);
          }
        }
      }
      schedule(draw, VoiceIsolationEngine.isTapped(sourceId));
    };
    schedule(draw, VoiceIsolationEngine.isTapped(sourceId));
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [sourceId]);

  // ---- Gated placeholder -----------------------------------------------------
  // Non-audio (embedded-audio video) tracks can't be isolated — the engine can't
  // tap them and export bakes nothing, so never present a live-looking curve here.
  if (!isAudioTrack) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 py-8 px-4 text-center">
        <Waves className="size-5 text-muted-foreground/70" />
        <p className="text-xs text-muted-foreground">
          Voice isolation needs a separate audio track.
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          Detach this clip&apos;s audio (or use a clip with its own audio row),
          then ask EDITH to isolate the voice.
        </p>
      </div>
    );
  }

  if (!vi?.appliedByEdith && !enabled) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 py-8 px-4 text-center">
        <Waves className="size-5 text-muted-foreground/70" />
        <p className="text-xs text-muted-foreground">
          Ask EDITH to isolate the voice on this clip.
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          The separation curve unlocks once EDITH applies it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Separation</span>
          <span className="font-mono text-[11px] text-green-500">{label}</span>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggleEnabled}
          className="h-4 w-7"
          thumbClassName="size-3.5"
        />
      </div>

      {/* Separation bake status — the curve does TRUE separation once ready */}
      {sepBaking ? (
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span>{sepMessage}</span>
          {sepProgress > 0 && (
            <span className="ml-auto font-mono">{Math.round(sepProgress)}%</span>
          )}
        </div>
      ) : sepReady ? (
        <p className="text-[11px] text-green-600/80">
          Voice and background separated — drag the left side down to remove the
          background.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">
          Cleaning with EQ. Ask EDITH to isolate the voice for a full split.
        </p>
      )}

      {/* Live output spectrogram */}
      <div className="overflow-hidden rounded-md border border-border/60 bg-[#0b1015]">
        <canvas
          ref={canvasRef}
          width={220}
          height={54}
          className="block w-full"
          style={{ height: 54 }}
        />
      </div>

      {/* Draggable separation curve */}
      <div
        className={
          'rounded-md border border-border/60 bg-muted/30 p-2 ' +
          (enabled ? '' : 'opacity-50 pointer-events-none')
        }
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
          className="w-full touch-none select-none"
          onPointerMove={onSvgPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <defs>
            <linearGradient id="vi-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#22c55e" stopOpacity="0.18" />
              <stop offset="1" stopColor="#22c55e" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* grid */}
          <g>
            {[0, 1, 2, 3, 4].map((i) => (
              <line
                key={`h${i}`}
                x1={padL}
                y1={sy(i / 4)}
                x2={VW - padR}
                y2={sy(i / 4)}
                stroke="hsl(var(--border))"
                strokeOpacity={0.5}
              />
            ))}
            {[0, 1, 2, 3, 4].map((j) => (
              <line
                key={`v${j}`}
                x1={sx(j / 4)}
                y1={padT}
                x2={sx(j / 4)}
                y2={padT + plotH}
                stroke="hsl(var(--border))"
                strokeOpacity={0.35}
              />
            ))}
          </g>
          <path d={fillPath} fill="url(#vi-fill)" />
          <path
            d={curvePath}
            fill="none"
            stroke="#22c55e"
            strokeWidth={2.6}
            strokeLinecap="round"
          />
          {/* nodes */}
          <g>
            {nodes.map((p, i) => (
              <g key={i}>
                <circle
                  cx={sx(p.x)}
                  cy={sy(p.y)}
                  r={activeIdx === i ? 8.5 : 6.5}
                  fill="hsl(var(--background))"
                  stroke="#22c55e"
                  strokeWidth={2.3}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => onNodePointerDown(i, e)}
                />
                <circle
                  cx={sx(p.x)}
                  cy={sy(p.y)}
                  r={2}
                  fill="#22c55e"
                  pointerEvents="none"
                />
              </g>
            ))}
          </g>
          {/* axis baseline + labels */}
          <rect
            x={padL}
            y={214}
            width={plotW}
            height={4}
            rx={2}
            fill="hsl(var(--border))"
          />
          <text
            x={padL}
            y={236}
            className="fill-muted-foreground"
            style={{ font: '700 9px ui-monospace, monospace', letterSpacing: 1 }}
          >
            NOISE · AMBIANCE
          </text>
          <text
            x={VW - padR}
            y={236}
            textAnchor="end"
            fill="#22c55e"
            style={{ font: '700 9px ui-monospace, monospace', letterSpacing: 1 }}
          >
            VOICE
          </text>
          <text
            x={10}
            y={26}
            className="fill-muted-foreground"
            style={{ font: '700 9px ui-monospace, monospace' }}
          >
            KEEP
          </text>
          <text
            x={10}
            y={206}
            className="fill-muted-foreground"
            style={{ font: '700 9px ui-monospace, monospace' }}
          >
            CUT
          </text>
        </svg>
      </div>

      {/* Presets + EDITH auto */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_LABELS.map((p) => (
          <Button
            key={p.key}
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => applyPreset(p.key)}
            disabled={!enabled}
          >
            {p.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-muted-foreground"
          onClick={() => applyPreset('podcast')}
          disabled={!enabled}
        >
          ↺ EDITH auto
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        Real-time RNNoise strips the ambiance from under the voice, then this
        chain pushes the voice forward (clearer and louder, not just quieter).
        Drag the right side up to keep the voice, the left side down to cut more
        background; the presets set how hard it works.
      </p>
    </div>
  );
};

VoiceIsolationCurveComponent.displayName = 'VoiceIsolationCurve';
export const VoiceIsolationCurve = React.memo(VoiceIsolationCurveComponent);
