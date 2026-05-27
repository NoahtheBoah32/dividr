import React, { useEffect, useState } from 'react';
import { useEdithCursorStore, SegmentHighlight } from '../stores/edithCursorStore';

// Renders a green highlight over a specific clip's body element on the timeline.
// Positions itself using getBoundingClientRect on the data-edith-target element.
const SegmentHighlightOverlay: React.FC<SegmentHighlight> = ({ clipId, startFrac, endFrac, label }) => {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    function measure() {
      const el = document.querySelector(`[data-edith-target="track-body:${clipId}"]`);
      if (el) setRect(el.getBoundingClientRect());
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [clipId]);

  if (!rect) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: rect.left + startFrac * rect.width,
        top: rect.top + 4,
        width: (endFrac - startFrac) * rect.width,
        height: rect.height - 8,
        borderRadius: 4,
        background: 'rgba(30, 215, 96, 0.18)',
        border: '1px solid rgba(30, 215, 96, 0.7)',
        boxShadow: '0 0 14px rgba(30, 215, 96, 0.25)',
        pointerEvents: 'none',
        zIndex: 9997,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        fontSize: 11,
        fontWeight: 600,
        color: '#1ED760',
        fontFamily: 'Inter, system-ui, sans-serif',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {label}
    </div>
  );
};

export const EdithCursor: React.FC = () => {
  const visible    = useEdithCursorStore((s) => s.visible);
  const x          = useEdithCursorStore((s) => s.x);
  const y          = useEdithCursorStore((s) => s.y);
  const animate    = useEdithCursorStore((s) => s.animate);
  const clicking   = useEdithCursorStore((s) => s.clicking);
  const dragging   = useEdithCursorStore((s) => s.dragging);
  const dragLabel  = useEdithCursorStore((s) => s.dragLabel);
  const highlights = useEdithCursorStore((s) => s.highlights);

  // Build transition string — left/top only when animating, transform always for click feel
  const transition = [
    animate ? 'left 0.55s cubic-bezier(0.4,0,0.2,1)' : '',
    animate ? 'top 0.55s cubic-bezier(0.4,0,0.2,1)'  : '',
    'transform 0.08s ease',
  ].filter(Boolean).join(', ');

  return (
    <>
      {/* Green cursor arrow */}
      {visible && (
        <div
          style={{
            position: 'fixed',
            left: x,
            top: y,
            pointerEvents: 'none',
            zIndex: 10000,
            transition,
            filter:
              'drop-shadow(0 0 6px rgba(30,215,96,0.5)) drop-shadow(1px 2px 3px rgba(0,0,0,0.9))',
            transform: clicking ? 'scale(0.82)' : 'scale(1)',
            transformOrigin: 'top left',
          }}
        >
          <svg width="22" height="26" viewBox="0 0 22 26" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M3 1 L3 20 L7 16 L10 24 L13 23 L10 15 L16 15 Z"
              fill="#1ED760"
              stroke="#0a3318"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      {/* Drag ghost — follows cursor with offset */}
      {visible && dragging && (
        <div
          style={{
            position: 'fixed',
            left: x + 14,
            top: y + 12,
            pointerEvents: 'none',
            zIndex: 9999,
            background: '#1e1c10',
            border: '1px solid rgba(255, 210, 0, 0.6)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            borderRadius: 6,
            padding: '6px 12px 6px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: '#e0cc80',
            whiteSpace: 'nowrap',
            fontFamily: 'Inter, system-ui, sans-serif',
            transition,
          }}
        >
          <div
            style={{
              width: 32,
              height: 20,
              background: '#302c00',
              borderRadius: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: '#ffd700',
              flexShrink: 0,
            }}
          >
            ▶
          </div>
          {dragLabel}
        </div>
      )}

      {/* Green segment highlights over source clip sections */}
      {highlights.map((h) => (
        <SegmentHighlightOverlay key={h.id} {...h} />
      ))}
    </>
  );
};
