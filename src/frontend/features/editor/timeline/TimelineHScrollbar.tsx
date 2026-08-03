import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Premiere-style horizontal scrollbar for the timeline tracks area.
 * The native webkit bar is a 5px sliver that editors can't find or grab —
 * this is a proper draggable bar that lives under the tracks viewport.
 *
 * Purely additive: it reads scroll state from the tracks element and writes
 * back via scrollLeft, so the existing onScroll → setScrollX pipeline stays
 * the single source of truth.
 */

const MIN_THUMB_PX = 40;
const BAR_HEIGHT_PX = 14;

interface TimelineHScrollbarProps {
  /** The horizontally scrollable tracks container */
  tracksRef: React.RefObject<HTMLDivElement | null>;
  /** Content width in px (timelineWidth) — reactive to zoom changes */
  contentWidth: number;
  /** Current scroll offset from the store (kept in sync by the tracks' onScroll) */
  scrollX: number;
}

export const TimelineHScrollbar: React.FC<TimelineHScrollbarProps> = ({
  tracksRef,
  contentWidth,
  scrollX,
}) => {
  const [viewportW, setViewportW] = useState(0);
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startClientX: number; startScrollLeft: number } | null>(null);

  // Track the viewport width of the scrollable element
  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    setViewportW(el.clientWidth);
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tracksRef]);

  const maxScroll = Math.max(0, contentWidth - viewportW);
  const overflowing = viewportW > 0 && maxScroll > 1;

  const thumbW = overflowing
    ? Math.max(MIN_THUMB_PX, (viewportW / contentWidth) * viewportW)
    : 0;
  const thumbRange = Math.max(0, viewportW - thumbW);
  const thumbX = overflowing
    ? Math.min(thumbRange, (Math.min(scrollX, maxScroll) / maxScroll) * thumbRange)
    : 0;

  const scrollTo = useCallback(
    (left: number) => {
      const el = tracksRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, Math.min(left, el.scrollWidth - el.clientWidth));
    },
    [tracksRef],
  );

  const onThumbMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = tracksRef.current;
      if (!el) return;
      dragRef.current = { startClientX: e.clientX, startScrollLeft: el.scrollLeft };

      const onMove = (me: MouseEvent) => {
        if (!dragRef.current || thumbRange <= 0) return;
        const dx = me.clientX - dragRef.current.startClientX;
        scrollTo(dragRef.current.startScrollLeft + (dx / thumbRange) * maxScroll);
      };
      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [tracksRef, thumbRange, maxScroll, scrollTo],
  );

  // Click on the empty rail: center the thumb (and therefore the view) on the click
  const onRailMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== barRef.current) return; // thumb handles its own drag
      const rail = barRef.current;
      if (!rail || thumbRange <= 0) return;
      const rect = rail.getBoundingClientRect();
      const targetThumbX = Math.max(
        0,
        Math.min(e.clientX - rect.left - thumbW / 2, thumbRange),
      );
      scrollTo((targetThumbX / thumbRange) * maxScroll);
    },
    [thumbRange, thumbW, maxScroll, scrollTo],
  );

  if (!overflowing) return null;

  return (
    <div
      ref={barRef}
      className="relative flex-shrink-0 w-full border-t border-neutral-800 bg-neutral-900/60 cursor-default select-none"
      style={{ height: BAR_HEIGHT_PX }}
      onMouseDown={onRailMouseDown}
      title="Scroll timeline"
    >
      <div
        className="absolute top-[2px] rounded-full bg-neutral-600 hover:bg-neutral-500 active:bg-neutral-400 cursor-grab active:cursor-grabbing"
        style={{
          height: BAR_HEIGHT_PX - 4,
          width: thumbW,
          transform: `translateX(${thumbX}px)`,
        }}
        onMouseDown={onThumbMouseDown}
      />
    </div>
  );
};
