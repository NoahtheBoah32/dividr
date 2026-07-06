import React, { useEffect, useRef, useState } from 'react';
import { gradeCompare, setGradeCompare } from '../utils/gradeCompareState';

interface GradeSplitOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

export function GradeSplitOverlay({ actualWidth, actualHeight, panX, panY }: GradeSplitOverlayProps) {
  const [enabled, setEnabled] = useState(() => gradeCompare.enabled);
  const [split, setSplit] = useState(() => gradeCompare.split);
  const [isHovering, setIsHovering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const hasDraggedRef = useRef(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const { enabled: en, split: sp } = (e as CustomEvent).detail;
      setEnabled(en);
      setSplit(sp);
    };
    window.addEventListener('dividr:gradeCompare', handler);
    return () => window.removeEventListener('dividr:gradeCompare', handler);
  }, []);

  // Window-level capture phase listeners — fire before SelectionHitTestLayer and pan handler
  useEffect(() => {
    if (!enabled) return;

    const onDown = (e: PointerEvent) => {
      const handle = handleRef.current;
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      const inHandle =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inHandle) return;

      e.stopImmediatePropagation();
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      isDraggingRef.current = true;
      hasDraggedRef.current = false;
    };

    const onMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const handle = handleRef.current;
      if (!handle || !handle.hasPointerCapture(e.pointerId)) return;

      e.stopImmediatePropagation();
      hasDraggedRef.current = true;

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newSplit = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
      setSplit(newSplit);
      setGradeCompare(true, newSplit);
    };

    const onUp = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const handle = handleRef.current;
      if (handle && handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
        e.stopImmediatePropagation();
      }
      if (!hasDraggedRef.current) {
        setGradeCompare(false);
      }
    };

    window.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
    };
  }, [enabled]);

  if (!enabled) return null;

  const splitPct = `${(split * 100).toFixed(2)}%`;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        width: actualWidth,
        height: actualHeight,
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    >
      {/* Drag handle */}
      <div
        ref={handleRef}
        style={{
          position: 'absolute',
          left: splitPct,
          top: '50%',
          transform: `translate(-50%, -50%) scale(${isHovering ? 1.15 : 1})`,
          transition: 'transform 0.12s ease',
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'white',
          boxShadow: isHovering
            ? '0 2px 16px rgba(0,0,0,0.65)'
            : '0 2px 10px rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'auto',
          cursor: 'ew-resize',
          userSelect: 'none',
          touchAction: 'none',
        }}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
          <path d="M1 5h14M1 5l4-4M1 5l4 4M15 5l-4-4M15 5l-4 4" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Labels */}
      <div style={{ position: 'absolute', left: '2%', top: 12, color: 'white', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', textShadow: '0 1px 4px rgba(0,0,0,0.9)', pointerEvents: 'none', fontFamily: 'system-ui, sans-serif' }}>
        Graded
      </div>
      <div style={{ position: 'absolute', right: '2%', top: 12, color: 'white', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', textShadow: '0 1px 4px rgba(0,0,0,0.9)', pointerEvents: 'none', fontFamily: 'system-ui, sans-serif' }}>
        Original
      </div>
    </div>
  );
}
