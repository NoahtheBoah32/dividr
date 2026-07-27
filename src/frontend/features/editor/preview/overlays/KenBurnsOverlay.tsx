import React, { useEffect, useRef } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor/index';
import {
  kbClampZoom,
  KB_MIN_ZOOM,
  KB_MAX_ZOOM,
  type KenBurnsState,
} from '../utils/kenBurnsUtils';

/**
 * KenBurnsOverlay — the Final-Cut-style setup UI for the Ken Burns push-in.
 *
 * Shown while the selected video clip has Ken Burns ENABLED and playback is
 * paused: a green "Start" rectangle marks the full frame, a red "End"
 * rectangle with corner brackets marks where the push lands, a red crosshair
 * sits on the focus point, and everything outside the End box is dimmed to
 * show what the zoom leaves behind.
 *
 * Dragging the End box moves the focus centre; dragging a corner bracket
 * resizes it (i.e. changes the end zoom). Writes are rAF-throttled straight
 * onto track.kenBurns, so the paused preview frame answers live.
 *
 * Sibling of GradeSplitOverlay: a div pinned to the centered
 * actualWidth×actualHeight letterbox, window-capture pointer listeners so it
 * wins against the selection hit-test layer. Purely additive.
 */

interface KenBurnsOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
  baseVideoWidth: number;
  baseVideoHeight: number;
  isPlaying: boolean;
}

const RED = '#ff3b30';
const GREEN = 'rgba(80, 210, 120, 0.9)';

interface DragState {
  mode: 'move' | 'resize';
  startClientX: number;
  startClientY: number;
  startCx: number;
  startCy: number;
  startZoom: number;
  /** Draw rect (px, container coords) captured at pointer-down. */
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  /** End-box centre in CLIENT px at pointer-down (resize keeps it fixed). */
  centerClientX: number;
  centerClientY: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export const KenBurnsOverlay: React.FC<KenBurnsOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
  baseVideoWidth,
  baseVideoHeight,
  isPlaying,
}) => {
  const tracks = useVideoEditorStore((s: any) => s.tracks);
  const selectedTrackIds = useVideoEditorStore(
    (s: any) => s.timeline?.selectedTrackIds ?? [],
  );
  const updateTrack = useVideoEditorStore((s: any) => s.updateTrack);

  const track = tracks.find(
    (t: any) =>
      t.type === 'video' &&
      selectedTrackIds.includes(t.id) &&
      (t as any).kenBurns?.enabled,
  ) as any;
  const kb = track?.kenBurns as KenBurnsState | undefined;

  const endRectRef = useRef<HTMLDivElement>(null);
  const cornerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<DragState | null>(null);
  // rAF-throttled store write: the latest pending kb patch and its flush tick.
  const pendingRef = useRef<{ endZoom: number; endCenter: { x: number; y: number } } | null>(null);
  const rafRef = useRef(0);
  // Latest track/kb for the window listeners without re-binding per render.
  const liveRef = useRef({ trackId: track?.id as string | undefined, kb });
  liveRef.current = { trackId: track?.id, kb };

  const visible = !!(track && kb && !isPlaying);

  useEffect(() => {
    if (!visible) return;

    const flush = () => {
      rafRef.current = 0;
      const p = pendingRef.current;
      const { trackId, kb: cur } = liveRef.current;
      if (!p || !trackId || !cur) return;
      pendingRef.current = null;
      updateTrack(trackId, {
        kenBurns: { ...cur, endZoom: p.endZoom, endCenter: p.endCenter },
      });
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    };
    const queue = (endZoom: number, endCenter: { x: number; y: number }) => {
      pendingRef.current = { endZoom, endCenter };
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
    };

    const hit = (el: HTMLElement | null, e: PointerEvent, pad = 4) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left - pad &&
        e.clientX <= r.right + pad &&
        e.clientY >= r.top - pad &&
        e.clientY <= r.bottom + pad
      );
    };

    const onDown = (e: PointerEvent) => {
      const endEl = endRectRef.current;
      const { kb: cur } = liveRef.current;
      if (!endEl || !cur) return;

      const isCorner = Object.values(cornerRefs.current).some((c) => hit(c, e));
      if (!isCorner && !hit(endEl, e, 0)) return;

      e.stopImmediatePropagation();
      e.preventDefault();
      endEl.setPointerCapture(e.pointerId);

      const endR = endEl.getBoundingClientRect();
      const zoom = kbClampZoom(cur.endZoom);
      const half = 0.5 / zoom;
      // Recover the draw rect from the end box (it is the window scaled up).
      const drawW = endR.width * zoom;
      const drawH = endR.height * zoom;
      const cx = clamp(cur.endCenter?.x ?? 0.5, half, 1 - half);
      const cy = clamp(cur.endCenter?.y ?? 0.5, half, 1 - half);
      const drawX = endR.left - (cx - half) * drawW;
      const drawY = endR.top - (cy - half) * drawH;

      dragRef.current = {
        mode: isCorner ? 'resize' : 'move',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCx: cx,
        startCy: cy,
        startZoom: zoom,
        drawX,
        drawY,
        drawW,
        drawH,
        centerClientX: endR.left + endR.width / 2,
        centerClientY: endR.top + endR.height / 2,
      };
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const { kb: cur } = liveRef.current;
      if (!d || !cur) return;
      e.stopImmediatePropagation();
      e.preventDefault();

      if (d.mode === 'move') {
        const half = 0.5 / d.startZoom;
        const nx = clamp(
          d.startCx + (e.clientX - d.startClientX) / d.drawW,
          half,
          1 - half,
        );
        const ny = clamp(
          d.startCy + (e.clientY - d.startClientY) / d.drawH,
          half,
          1 - half,
        );
        queue(d.startZoom, { x: nx, y: ny });
      } else {
        // Corner drag: the box stays centred; the pulled corner sets the size.
        const halfNorm = clamp(
          Math.max(
            Math.abs(e.clientX - d.centerClientX) / d.drawW,
            Math.abs(e.clientY - d.centerClientY) / d.drawH,
          ),
          0.5 / KB_MAX_ZOOM,
          0.5 / KB_MIN_ZOOM,
        );
        const zoom = kbClampZoom(0.5 / halfNorm);
        const half = 0.5 / zoom;
        queue(zoom, {
          x: clamp(d.startCx, half, 1 - half),
          y: clamp(d.startCy, half, 1 - half),
        });
      }
    };

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const endEl = endRectRef.current;
      if (endEl?.hasPointerCapture(e.pointerId)) {
        endEl.releasePointerCapture(e.pointerId);
        e.stopImmediatePropagation();
      }
    };

    window.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      dragRef.current = null;
      pendingRef.current = null;
    };
  }, [visible, updateTrack]);

  if (!visible) return null;

  // ── Geometry: replicate the compositor's fitted draw rect ────────────────
  const tf = track.textTransform || null;
  const scale = Math.min(
    actualWidth / Math.max(1, baseVideoWidth),
    actualHeight / Math.max(1, baseVideoHeight),
  );
  const safeScale = Number.isFinite(tf?.scale) ? tf.scale : 1;
  const srcW = (tf?.width || track.width || baseVideoWidth) as number;
  const srcH = (tf?.height || track.height || baseVideoHeight) as number;
  const drawW = srcW * scale * safeScale;
  const drawH = srcH * scale * safeScale;
  const offX = (Number.isFinite(tf?.x) ? tf.x : 0) * (actualWidth / 2);
  const offY = (Number.isFinite(tf?.y) ? tf.y : 0) * (actualHeight / 2);
  const drawX = actualWidth / 2 + offX - drawW / 2;
  const drawY = actualHeight / 2 + offY - drawH / 2;

  const zoom = kbClampZoom(kb!.endZoom);
  const half = 0.5 / zoom;
  const cx = clamp(kb!.endCenter?.x ?? 0.5, half, 1 - half);
  const cy = clamp(kb!.endCenter?.y ?? 0.5, half, 1 - half);
  const endW = drawW / zoom;
  const endH = drawH / zoom;
  const endX = drawX + (cx - half) * drawW;
  const endY = drawY + (cy - half) * drawH;

  const bracket = (corner: 'tl' | 'tr' | 'bl' | 'br') => {
    const arm = 14;
    const thick = 3;
    const pos: React.CSSProperties = {
      position: 'absolute',
      width: arm,
      height: arm,
      pointerEvents: 'auto',
      touchAction: 'none',
    };
    if (corner === 'tl') Object.assign(pos, { left: -thick, top: -thick, borderLeft: `${thick}px solid ${RED}`, borderTop: `${thick}px solid ${RED}`, cursor: 'nwse-resize' });
    if (corner === 'tr') Object.assign(pos, { right: -thick, top: -thick, borderRight: `${thick}px solid ${RED}`, borderTop: `${thick}px solid ${RED}`, cursor: 'nesw-resize' });
    if (corner === 'bl') Object.assign(pos, { left: -thick, bottom: -thick, borderLeft: `${thick}px solid ${RED}`, borderBottom: `${thick}px solid ${RED}`, cursor: 'nesw-resize' });
    if (corner === 'br') Object.assign(pos, { right: -thick, bottom: -thick, borderRight: `${thick}px solid ${RED}`, borderBottom: `${thick}px solid ${RED}`, cursor: 'nwse-resize' });
    return (
      <div
        key={corner}
        ref={(el) => { cornerRefs.current[corner] = el; }}
        data-testid={`kb-corner-${corner}`}
        style={pos}
      />
    );
  };

  return (
    <div
      data-testid="kb-overlay"
      style={{
        position: 'absolute',
        width: actualWidth,
        height: actualHeight,
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 9998,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Dim everything the end window leaves behind */}
      <svg
        width={actualWidth}
        height={actualHeight}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <path
          fillRule="evenodd"
          fill="rgba(0,0,0,0.4)"
          d={`M${drawX},${drawY} h${drawW} v${drawH} h${-drawW} Z M${endX},${endY} h${endW} v${endH} h${-endW} Z`}
        />
      </svg>

      {/* Start — the full frame */}
      <div
        data-testid="kb-start-rect"
        style={{
          position: 'absolute',
          left: drawX,
          top: drawY,
          width: drawW,
          height: drawH,
          border: `1.5px solid ${GREEN}`,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 4,
            bottom: 3,
            color: 'rgb(80, 210, 120)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textShadow: '0 1px 3px rgba(0,0,0,0.9)',
          }}
        >
          Start
        </span>
      </div>

      {/* End — where the push lands */}
      <div
        ref={endRectRef}
        data-testid="kb-end-rect"
        style={{
          position: 'absolute',
          left: endX,
          top: endY,
          width: endW,
          height: endH,
          border: `1.5px solid ${RED}`,
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          cursor: 'move',
          touchAction: 'none',
        }}
      >
        {bracket('tl')}
        {bracket('tr')}
        {bracket('bl')}
        {bracket('br')}

        {/* Focus crosshair */}
        <div
          data-testid="kb-cross"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 18,
            height: 18,
            pointerEvents: 'none',
          }}
        >
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1.5, marginLeft: -0.75, background: RED }} />
          <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1.5, marginTop: -0.75, background: RED }} />
        </div>

        <span
          style={{
            position: 'absolute',
            left: 3,
            bottom: 2,
            padding: '0 4px',
            background: RED,
            color: 'white',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        >
          End
        </span>
      </div>
    </div>
  );
};
