import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * LassoOverlay — manual region selector for the nuanced skills (In-Frame Speed, and
 * Hold-the-World when un-paused). Sibling of PipDragOverlay: a div pinned to the centered
 * actualWidth×actualHeight letterbox so pointer coords map 1:1 to the source frame.
 *
 * Armed by the properties panel (`dividr:lassoArm` {shape}); on a closed, valid selection it
 * emits `dividr:lassoComplete` {shape, points(normalized 0..1), bbox} and disarms. The panel
 * turns the polygon into a `lasso:[[x,y],…]` region on the op. Three shapes via the panel's Seg
 * control (default Box). Closed-loop only: box/ellipse close by construction, freehand auto-closes
 * on pointer-up; a degenerate selection (area < 0.0008 or < 3 pts) flashes red and is discarded.
 *
 * Palette: DiviDr gray/green — the selection stroke is the green --secondary, the area OUTSIDE
 * the selection is dimmed with a neutral gray scrim so the kept region reads clearly.
 */

interface LassoOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

type Shape = 'box' | 'ellipse' | 'poly';
type Pt = [number, number];

function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export const LassoOverlay: React.FC<LassoOverlayProps> = ({ actualWidth, actualHeight, panX, panY }) => {
  const [armed, setArmed] = useState(false);
  const [shape, setShape] = useState<Shape>('box');
  const [pts, setPts] = useState<Pt[]>([]); // pixel coords within the overlay box
  const [flash, setFlash] = useState(false);
  const drawing = useRef(false);
  const startRef = useRef<Pt | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onArm = (e: any) => {
      setShape(((e.detail?.shape as Shape) || 'box'));
      setPts([]);
      drawing.current = false;
      setArmed(true);
    };
    const onDisarm = () => { setArmed(false); setPts([]); drawing.current = false; };
    // Escape is the universal cancel — without it an armed full-frame scrim traps the user
    // until they draw a valid selection (the disarm event was otherwise never dispatched).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDisarm(); };
    window.addEventListener('dividr:lassoArm', onArm);
    window.addEventListener('dividr:lassoDisarm', onDisarm);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dividr:lassoArm', onArm);
      window.removeEventListener('dividr:lassoDisarm', onDisarm);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const toLocal = useCallback((e: React.PointerEvent): Pt => {
    const r = containerRef.current!.getBoundingClientRect();
    return [
      Math.max(0, Math.min(r.width, e.clientX - r.left)),
      Math.max(0, Math.min(r.height, e.clientY - r.top)),
    ];
  }, []);

  const commit = useCallback((raw: Pt[]) => {
    const norm: Pt[] = raw.map(([x, y]) => [x / actualWidth, y / actualHeight]);
    if (norm.length < 3 || polyArea(norm) < 0.0008) {
      setFlash(true); setTimeout(() => setFlash(false), 400); setPts([]); drawing.current = false; return;
    }
    const xs = norm.map((p) => p[0]); const ys = norm.map((p) => p[1]);
    const bbox: [number, number, number, number] = [
      Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
    ];
    window.dispatchEvent(new CustomEvent('dividr:lassoComplete', { detail: { shape, points: norm, bbox } }));
    setArmed(false); setPts([]); drawing.current = false;
  }, [actualWidth, actualHeight, shape]);

  const onDown = useCallback((e: React.PointerEvent) => {
    if (!armed) return;
    e.preventDefault(); e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = toLocal(e);
    startRef.current = p;
    setPts([p]);
  }, [armed, toLocal]);

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!armed || !drawing.current) return;
    const p = toLocal(e);
    setPts((prev) => (shape === 'poly' ? [...prev, p] : [startRef.current!, p]));
  }, [armed, shape, toLocal]);

  const onUp = useCallback((e: React.PointerEvent) => {
    if (!armed || !drawing.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const p = toLocal(e);
    if (shape === 'poly') { commit([...pts, p]); return; }
    const [sx, sy] = startRef.current!; const [ex, ey] = p;
    if (shape === 'box') {
      commit([[sx, sy], [ex, sy], [ex, ey], [sx, ey]]);
    } else {
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2, rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
      const poly: Pt[] = [];
      for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; poly.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
      commit(poly);
    }
  }, [armed, shape, pts, toLocal, commit]);

  if (!armed) return null;

  const GREEN = 'hsl(var(--secondary))';
  const pointsAttr = pts.map(([x, y]) => `${x},${y}`).join(' ');
  let shapeEl: React.ReactNode = null;
  if (pts.length >= 2 && shape !== 'poly') {
    const [sx, sy] = pts[0]; const [ex, ey] = pts[1];
    const x = Math.min(sx, ex), y = Math.min(sy, ey), w = Math.abs(ex - sx), h = Math.abs(ey - sy);
    shapeEl = shape === 'box'
      ? <rect x={x} y={y} width={w} height={h} fill={GREEN} fillOpacity={0.14} stroke={GREEN} strokeWidth={2} />
      : <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={GREEN} fillOpacity={0.14} stroke={GREEN} strokeWidth={2} />;
  } else if (shape === 'poly' && pts.length >= 2) {
    shapeEl = <polyline points={pointsAttr} fill={GREEN} fillOpacity={0.14} stroke={GREEN} strokeWidth={2} strokeLinejoin="round" />;
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      style={{
        position: 'absolute',
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        width: actualWidth,
        height: actualHeight,
        zIndex: 60000,
        cursor: 'crosshair',
        pointerEvents: 'all',
        outline: flash ? '2px solid hsl(var(--destructive))' : 'none',
        background: 'rgba(20,20,20,0.28)', // gray scrim so the kept region pops
      }}
    >
      <svg width={actualWidth} height={actualHeight} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {shapeEl}
      </svg>
      <div style={{
        position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.7)', color: '#e5e7eb', fontSize: 11, fontWeight: 600,
        padding: '3px 9px', borderRadius: 5, whiteSpace: 'nowrap', pointerEvents: 'none',
        letterSpacing: '0.02em',
      }}>
        {(shape === 'poly' ? 'Draw around the region — release to close' : `Drag a ${shape} over the region`) + '  ·  Esc cancels'}
      </div>
    </div>
  );
};

export default LassoOverlay;
