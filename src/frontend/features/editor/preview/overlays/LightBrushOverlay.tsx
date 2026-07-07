import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * LightBrushOverlay — the manual painting harness for the Light Brush (Skill 4).
 *
 * Sibling of LassoOverlay: a div pinned to the centered actualWidth×actualHeight
 * letterbox so pointer coords map 1:1 to source-frame space. Armed by the Light Brush
 * panel (`dividr:lightBrushArm`); pointer-down sets the light's centre, dragging sets
 * its radius. On release it emits `dividr:lightBrushComplete` {pos(0..1), radius(0..1
 * of the smaller dimension)} and disarms — the panel appends the light using its
 * current colour/intensity/blend. Escape cancels. Purely additive; nothing else changes.
 */

interface LightBrushOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
  /** Preview color of the brush (for the live ring), 0..255 RGB. */
  brushColor?: [number, number, number];
}

type Pt = [number, number];

export const LightBrushOverlay: React.FC<LightBrushOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
  brushColor = [255, 224, 170],
}) => {
  const [armed, setArmed] = useState(false);
  const [center, setCenter] = useState<Pt | null>(null);
  const [radiusPx, setRadiusPx] = useState(0);
  const drawing = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const minDim = Math.max(1, Math.min(actualWidth, actualHeight));

  useEffect(() => {
    const onArm = () => {
      setCenter(null);
      setRadiusPx(0);
      drawing.current = false;
      setArmed(true);
    };
    const onDisarm = () => {
      setArmed(false);
      setCenter(null);
      drawing.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDisarm();
    };
    window.addEventListener('dividr:lightBrushArm', onArm);
    window.addEventListener('dividr:lightBrushDisarm', onDisarm);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dividr:lightBrushArm', onArm);
      window.removeEventListener('dividr:lightBrushDisarm', onDisarm);
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

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      if (!armed) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drawing.current = true;
      const p = toLocal(e);
      setCenter(p);
      setRadiusPx(minDim * 0.25); // sensible default until they drag
    },
    [armed, toLocal, minDim],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      if (!armed || !drawing.current || !center) return;
      const [x, y] = toLocal(e);
      setRadiusPx(Math.max(minDim * 0.05, Math.hypot(x - center[0], y - center[1])));
    },
    [armed, center, toLocal, minDim],
  );

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      if (!armed || !drawing.current || !center) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      const pos: Pt = [center[0] / actualWidth, center[1] / actualHeight];
      const radius = Math.max(0.05, Math.min(1.2, radiusPx / minDim));
      window.dispatchEvent(
        new CustomEvent('dividr:lightBrushComplete', { detail: { pos, radius } }),
      );
      setArmed(false);
      setCenter(null);
      drawing.current = false;
    },
    [armed, center, radiusPx, actualWidth, actualHeight, minDim],
  );

  if (!armed) return null;

  const [cr, cg, cb] = brushColor;
  const tint = `rgb(${cr},${cg},${cb})`;

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
        zIndex: 60001,
        cursor: 'crosshair',
        pointerEvents: 'all',
        background: 'rgba(20,20,20,0.22)',
      }}
    >
      <svg
        width={actualWidth}
        height={actualHeight}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        {center && (
          <>
            <defs>
              <radialGradient id="light-brush-preview">
                <stop offset="0%" stopColor={tint} stopOpacity={0.85} />
                <stop offset="60%" stopColor={tint} stopOpacity={0.3} />
                <stop offset="100%" stopColor={tint} stopOpacity={0} />
              </radialGradient>
            </defs>
            <circle cx={center[0]} cy={center[1]} r={radiusPx} fill="url(#light-brush-preview)" />
            <circle
              cx={center[0]}
              cy={center[1]}
              r={radiusPx}
              fill="none"
              stroke={tint}
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          </>
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)',
          color: '#e5e7eb',
          fontSize: 11,
          fontWeight: 600,
          padding: '3px 9px',
          borderRadius: 5,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        Click where the light should fall, drag out its size · Esc cancels
      </div>
    </div>
  );
};

export default LightBrushOverlay;
