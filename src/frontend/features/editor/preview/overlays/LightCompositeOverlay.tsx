import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor/index';
import {
  RelightConfig,
  defaultRelight,
  relightFromLegacy,
} from '../utils/paintedLightUtils';
import { Relighter } from '../utils/relightGL';

/**
 * LightCompositeOverlay — the screen-space relighter (Light Brush v2).
 *
 * Replaces the old flat radial-gradient glow. A WebGL canvas pinned to the same letterbox
 * box as the base compositor canvas: every frame it samples the composited preview
 * (`[data-testid="preview-canvas"]`) as a texture, reconstructs per-pixel surface normals
 * from the image's own luminance, and shades them with a light you drag inside the scene
 * (see relightGL.ts). The whole environment is lit — no subject matte, no isolation — so
 * it reads as real in-scene light instead of a sticker. Opaque, drawn above the base
 * canvas (zIndex 55) and below text/handles, so captions stay crisp on top.
 *
 * Config is per clip on `track.relight`; legacy `paintedLights` are auto-adapted so old
 * projects still light through the new engine. A draggable handle moves the key light; it
 * writes `window.__relightDragPos` for zero-lag drag and commits to the store on release.
 */
interface LightCompositeOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

interface RelightDragOverride {
  trackId: string;
  pos: [number, number];
}
declare global {
  // eslint-disable-next-line no-var
  var __relightDragPos: RelightDragOverride | undefined;
}

/** Resolve the relight config for a track: explicit `relight`, else adapted legacy lights. */
function resolveRelight(track: any): RelightConfig | null {
  const r = track?.relight as RelightConfig | undefined;
  if (r && r.enabled) return r;
  return relightFromLegacy(track?.paintedLights, track?.lightSource);
}

export const LightCompositeOverlay: React.FC<LightCompositeOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const relighterRef = useRef<Relighter | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragging = useRef(false);
  // Live handle position while dragging (store only updates on release).
  const [dragPos, setDragPos] = useState<[number, number] | null>(null);

  const tracks = useVideoEditorStore((s) => (s as any).tracks) as any[];
  const updateTrack = useVideoEditorStore((s) => (s as any).updateTrack);
  const beginGroup = useVideoEditorStore((s) => (s as any).beginGroup);
  const endGroup = useVideoEditorStore((s) => (s as any).endGroup);

  // The (first) video track that carries an active relight.
  const litTrack = useMemo(
    () => tracks?.find((t) => t.type === 'video' && resolveRelight(t)),
    [tracks],
  );
  const cfg = litTrack ? resolveRelight(litTrack) : null;
  const engaged = !!cfg;

  // Render loop + relighter lifecycle. The WebGL context is a SCARCE resource in this
  // app (the browser evicts the oldest context when too many exist — "Too many active
  // WebGL contexts"), so we only hold one while a light is actually active, and if ours
  // gets evicted anyway and isn't auto-restored, we rebuild it after a grace period.
  // Params are read live from the store each tick so slider/handle changes apply
  // without restarting the loop.
  useEffect(() => {
    if (!engaged) return;

    let running = true;
    let relighter: Relighter | null = null;
    let lostSince = 0;

    const mount = () => {
      relighter = new Relighter();
      relighterRef.current = relighter;
      const c = relighter.canvas;
      c.style.position = 'absolute';
      c.style.inset = '0';
      c.style.width = '100%';
      c.style.height = '100%';
      c.style.display = 'block';
      c.style.pointerEvents = 'none';
      containerRef.current?.appendChild(c);
    };
    const unmount = () => {
      if (!relighter) return;
      relighter.canvas.parentNode?.removeChild(relighter.canvas);
      relighter.dispose();
      relighter = null;
      relighterRef.current = null;
    };
    mount();

    const tick = () => {
      if (!running) return;

      // Context evicted and the automatic restore never came? Rebuild wholesale.
      if (relighter && relighter.lost) {
        if (!lostSince) lostSince = performance.now();
        if (performance.now() - lostSince > 1500) {
          unmount();
          mount();
          lostSince = 0;
        }
      } else {
        lostSince = 0;
      }

      const state = useVideoEditorStore.getState() as any;
      const live =
        state.tracks?.find((t: any) => t.type === 'video' && resolveRelight(t)) ?? null;
      const rc = live ? resolveRelight(live) : null;
      const base = document.querySelector(
        'canvas[data-testid="preview-canvas"]',
      ) as HTMLCanvasElement | null;

      if (relighter && rc && base && base.width > 0 && base.height > 0) {
        const drag = globalThis.__relightDragPos;
        const pos =
          drag && live && drag.trackId === live.id ? drag.pos : rc.pos;
        relighter.render(base, base.width, base.height, {
          ...rc,
          pos,
          engaged: true,
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      unmount();
    };
  }, [engaged]);

  // ---- draggable in-scene light handle ------------------------------------
  const commitPos = (pos: [number, number]) => {
    if (!litTrack) return;
    const current = (resolveRelight(litTrack) ?? defaultRelight());
    beginGroup?.('Move light');
    updateTrack(litTrack.id, { relight: { ...current, enabled: true, pos } } as any);
    endGroup?.();
  };

  const onHandleDown = (e: React.PointerEvent) => {
    if (!litTrack) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragging.current || !litTrack) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const pos: [number, number] = [
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    ];
    globalThis.__relightDragPos = { trackId: litTrack.id, pos };
    setDragPos(pos);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const drag = globalThis.__relightDragPos;
    if (drag && litTrack && drag.trackId === litTrack.id) commitPos(drag.pos);
    globalThis.__relightDragPos = undefined;
    setDragPos(null);
  };

  // Ctrl+Shift+drag ANYWHERE on the preview moves the light, even though plain
  // clicks/drags belong to video selection (the app's tool-override convention).
  // Window-capture listeners fire before the selection/transform layers can claim
  // the pointer, so this wins regardless of z-order.
  useEffect(() => {
    if (!engaged) return;
    let active = false;

    const posFrom = (e: PointerEvent): [number, number] | null => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return null;
      if (
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom
      ) return null;
      return [
        Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      ];
    };

    const down = (e: PointerEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.button !== 0) return;
      const pos = posFrom(e);
      if (!pos) return;
      const state = useVideoEditorStore.getState() as any;
      const live = state.tracks?.find((t: any) => t.type === 'video' && resolveRelight(t));
      if (!live) return;
      e.preventDefault();
      e.stopPropagation();
      active = true;
      globalThis.__relightDragPos = { trackId: live.id, pos };
      setDragPos(pos);
    };
    const move = (e: PointerEvent) => {
      if (!active) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const pos: [number, number] = [
        Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      ];
      const drag = globalThis.__relightDragPos;
      if (drag) globalThis.__relightDragPos = { ...drag, pos };
      setDragPos(pos);
      e.preventDefault();
      e.stopPropagation();
    };
    const up = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      e.preventDefault();
      e.stopPropagation();
      const drag = globalThis.__relightDragPos;
      if (drag) {
        // Commit from FRESH store state (not render-time closure) so slider
        // changes made since this effect mounted aren't reverted.
        const state = useVideoEditorStore.getState() as any;
        const live = state.tracks?.find((t: any) => t.id === drag.trackId);
        const current = (live ? resolveRelight(live) : null) ?? defaultRelight();
        state.beginGroup?.('Move light');
        state.updateTrack?.(drag.trackId, {
          relight: { ...current, enabled: true, pos: drag.pos },
        });
        state.endGroup?.();
      }
      globalThis.__relightDragPos = undefined;
      setDragPos(null);
    };

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      globalThis.__relightDragPos = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, litTrack?.id]);

  const handlePos = dragPos ?? cfg?.pos ?? [0.5, 0.42];
  const [hr, hg, hb] = cfg?.color ?? [255, 224, 170];

  // Shared letterbox geometry: the WebGL canvas stays low (zIndex 55, under
  // captions/text), but the drag handle lives in its OWN sibling layer above the
  // selection/transform stack (SelectionHitTestLayer 9000, TransformBoundary 10000,
  // lasso/brush 60000-60001). The container at 55 is a stacking context, so a
  // child zIndex can never escape it — the handle must be a sibling to win the pointer.
  const letterboxStyle: React.CSSProperties = {
    position: 'absolute',
    left: `calc(50% + ${panX}px)`,
    top: `calc(50% + ${panY}px)`,
    transform: 'translate(-50%, -50%)',
    width: actualWidth,
    height: actualHeight,
    pointerEvents: 'none',
  };

  return (
    <>
      <div
        ref={containerRef}
        aria-hidden
        style={{ ...letterboxStyle, zIndex: 55, overflow: 'hidden' }}
      />
      {engaged && (
        <div style={{ ...letterboxStyle, zIndex: 60002 }}>
          <div
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            title="Drag to move the light (Ctrl+Shift+drag works anywhere)"
            style={{
              position: 'absolute',
              left: `${handlePos[0] * 100}%`,
              top: `${handlePos[1] * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 26,
              height: 26,
              borderRadius: '50%',
              border: '2px solid rgba(255,255,255,0.95)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.55), 0 0 10px 3px rgba(0,0,0,0.35)',
              background: `radial-gradient(circle, rgb(${hr},${hg},${hb}) 0%, rgba(${hr},${hg},${hb},0.35) 55%, transparent 72%)`,
              cursor: dragging.current || dragPos ? 'grabbing' : 'grab',
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          />
        </div>
      )}
    </>
  );
};

export default LightCompositeOverlay;


