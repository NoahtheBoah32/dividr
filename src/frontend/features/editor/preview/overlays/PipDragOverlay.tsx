import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor';

interface PipDragOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

export const PipDragOverlay: React.FC<PipDragOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
}) => {
  const tracks = useVideoEditorStore(s => s.tracks);
  const updateTrack = useVideoEditorStore(s => s.updateTrack);
  const currentFrame = useVideoEditorStore(s => s.timeline.currentFrame);

  const draggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ctrl+Shift activates PiP positioning mode — overrides TransformBoundaryLayer z-index
  const [pipModeActive, setPipModeActive] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      setPipModeActive(e.ctrlKey && e.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  // Find the main video track that has an active PiP config
  const mainTrack = tracks.find(t =>
    t.type === 'video' &&
    (t as any).trackRowIndex === 0 &&
    (t as any).pipFrame?.style &&
    (t as any).pipFrame.style !== 'none',
  );

  // Only show the drag handle when B-roll is active at this frame
  const hasBroll = tracks.some(t =>
    t.type === 'video' &&
    (t as any).trackRowIndex > 0 &&
    t.startFrame <= currentFrame &&
    t.endFrame > currentFrame,
  );

  const pip = mainTrack ? ((mainTrack as any).pipFrame as {
    style: string; x: number; y: number; size: number; borderColor: string; borderWidth: number;
  }) : null;

  const shiftHeldRef = useRef(false);

  // All hooks must be called before any conditional return
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    shiftHeldRef.current = true;
    draggingRef.current = true;
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !containerRef.current || !mainTrack || !pip) return;
    e.preventDefault();
    // Use container rect — works whether dragging from handle or anywhere in pip mode
    const rect = containerRef.current.getBoundingClientRect();
    const newX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    const newY = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
    // Bypass React entirely for silky drag — write to window override, compositor reads it directly
    (window as any).__pipDragOverride = { trackId: mainTrack.id, x: newX, y: newY };
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  }, [mainTrack, pip, actualWidth, actualHeight]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    shiftHeldRef.current = false;
    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    // Commit final position to store, keep override alive until React flushes
    const override = (window as any).__pipDragOverride;
    if (override && mainTrack && pip) {
      updateTrack(mainTrack.id, { pipFrame: { ...pip, x: override.x, y: override.y } } as any);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      delete (window as any).__pipDragOverride;
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    }));
  }, [mainTrack, pip, updateTrack]);

  if (!mainTrack || !hasBroll || !pip) return null;

  const pipPixelX = pip.x * actualWidth;
  const pipPixelY = pip.y * actualHeight;
  const pipDiam = pip.size * actualWidth;

  return (
    <div
      ref={containerRef}
      onPointerDown={pipModeActive ? handlePointerDown : undefined}
      onPointerMove={pipModeActive ? handlePointerMove : undefined}
      onPointerUp={pipModeActive ? handlePointerUp : undefined}
      style={{
        position: 'absolute',
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        width: actualWidth,
        height: actualHeight,
        zIndex: pipModeActive ? 50000 : 100,
        pointerEvents: pipModeActive ? 'all' : 'none',
        cursor: pipModeActive ? 'crosshair' : 'default',
      }}
    >
      {/* Draggable handle — hide during drag so it doesn't ghost against the canvas */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="Drag to reposition frame"
        style={{
          position: 'absolute',
          left: pipPixelX - pipDiam / 2,
          top: pipPixelY - pipDiam / 2,
          width: pipDiam,
          height: pipDiam,
          borderRadius: pip.style === 'circle' ? '50%' : pip.style === 'rounded-square' ? '18%' : '4px',
          cursor: 'grab',
          pointerEvents: 'all',
          border: '2px solid transparent',
          boxSizing: 'border-box',
          transition: 'border-color 0.12s, opacity 0.05s',
          opacity: isDragging ? 0 : 1,
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.borderColor = `${pip.borderColor}99`;
          (e.currentTarget as HTMLElement).style.cursor = 'grab';
        }}
        onMouseLeave={e => {
          if (!draggingRef.current) {
            (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
          }
        }}
      >
        {/* "Shift+drag" badge — shows on hover near bottom of the pip */}
        <div style={{
          position: 'absolute',
          bottom: -22,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)',
          color: '#FFB800',
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.03em',
          padding: '2px 6px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          opacity: 0,
          transition: 'opacity 0.15s',
        }}
          className="pip-hint"
        >
          Ctrl+Shift+drag to move
        </div>
      </div>
      <style>{`.pip-hint { opacity: 0; } div:hover > .pip-hint { opacity: 1 !important; }`}</style>

      {/* Corner resize handles — only visible in Ctrl+Shift mode */}
      {pipModeActive && !isDragging && (() => {
        const r = pipDiam / 2;
        const cx = pipPixelX;
        const cy = pipPixelY;
        const hs = 8; // handle size px
        const corners = [
          { dx: -1, dy: -1, cursor: 'nw-resize' },
          { dx:  1, dy: -1, cursor: 'ne-resize' },
          { dx: -1, dy:  1, cursor: 'sw-resize' },
          { dx:  1, dy:  1, cursor: 'se-resize' },
        ];
        return corners.map(({ dx, dy, cursor }) => (
          <div
            key={cursor}
            style={{
              position: 'absolute',
              left: cx + dx * r - hs / 2,
              top:  cy + dy * r - hs / 2,
              width: hs,
              height: hs,
              background: '#ffffff',
              border: '2px solid rgba(0,0,0,0.5)',
              borderRadius: 2,
              cursor,
              pointerEvents: 'all',
              zIndex: 1,
            }}
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              draggingRef.current = true;
              setIsDragging(true);
              const rect = containerRef.current!.getBoundingClientRect();
              const onMove = (ev: PointerEvent) => {
                const mx = (ev.clientX - rect.left);
                const my = (ev.clientY - rect.top);
                // New radius = distance from pip center to pointer
                const dist = Math.sqrt(Math.pow(mx - cx, 2) + Math.pow(my - cy, 2));
                const newSize = Math.max(0.06, Math.min(0.45, (dist * 2) / actualWidth));
                (window as any).__pipDragOverride = {
                  trackId: mainTrack!.id,
                  x: pip.x,
                  y: pip.y,
                  size: newSize,
                };
                window.dispatchEvent(new CustomEvent('dividr:forceRender'));
              };
              const onUp = (ev: PointerEvent) => {
                draggingRef.current = false;
                setIsDragging(false);
                const override = (window as any).__pipDragOverride;
                if (override && mainTrack) {
                  updateTrack(mainTrack.id, { pipFrame: { ...pip, size: override.size } } as any);
                }
                // Keep override alive until React flushes the store update to avoid snap-back flash
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  delete (window as any).__pipDragOverride;
                  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
                }));
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
            }}
          />
        ));
      })()}
    </div>
  );
};
