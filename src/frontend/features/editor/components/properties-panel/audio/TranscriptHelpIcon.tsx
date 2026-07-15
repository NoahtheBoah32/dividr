/**
 * TranscriptHelpIcon — the little ⓘ beside the "Transcript" heading. All the
 * transcript how-to lives in its dropdown instead of dense inline paragraphs:
 * hover the icon for 1.5s (or click it) and a compact cheat-sheet opens.
 * Theme-aware via popover/border/foreground tokens, so it works in light mode too.
 *
 * The popover renders in a PORTAL with fixed, viewport-clamped coordinates —
 * anchored absolute it grew past the panel's edge and the panel's overflow
 * container clipped half the text. Because it is no longer a DOM child of the
 * icon, hover-close uses a short grace timer so the pointer can travel from
 * the icon into the popover without it vanishing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { SFX_MARKER_YELLOW, SFX_TIMELINE_GREEN } from './sfxTriggerUtils';

const HOVER_OPEN_DELAY_MS = 1500;
const HOVER_CLOSE_GRACE_MS = 160;
const POP_WIDTH_PX = 288; // keep in sync with the w-72 class below
const EDGE_PAD_PX = 8;

export const TranscriptHelpIcon: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearHoverTimer();
      clearCloseTimer();
    },
    [clearHoverTimer, clearCloseTimer],
  );

  // Right edge stays on the icon when there is room; otherwise clamp fully
  // inside the viewport so no panel/window edge can cut the text off.
  const openAtIcon = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const left = Math.max(
        EDGE_PAD_PX,
        Math.min(r.right - POP_WIDTH_PX, window.innerWidth - POP_WIDTH_PX - EDGE_PAD_PX),
      );
      setPos({ top: r.bottom + 6, left });
    }
    setOpen(true);
  }, []);

  const scheduleClose = useCallback(() => {
    clearHoverTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_GRACE_MS);
  }, [clearHoverTimer, clearCloseTimer]);

  const onIconEnter = useCallback(() => {
    clearCloseTimer();
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(openAtIcon, HOVER_OPEN_DELAY_MS);
  }, [clearCloseTimer, clearHoverTimer, openAtIcon]);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={onIconEnter}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={btnRef}
        type="button"
        data-transcript-help
        aria-label="What you can do in the transcript"
        aria-expanded={open}
        onClick={() => {
          clearHoverTimer();
          clearCloseTimer();
          if (open) setOpen(false);
          else openAtIcon();
        }}
        className="inline-flex items-center text-muted-foreground/60 hover:text-foreground focus-visible:text-foreground outline-none transition-colors"
      >
        <Info className="size-3.5" />
      </button>
      {open && pos &&
        createPortal(
          <div
            data-transcript-help-pop
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
            className="fixed z-[60010] w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
            style={{ top: pos.top, left: pos.left }}
          >
            {/* The colored samples sit on tiny dark chips (like the editor canvas), so
                the yellow/green stay legible on a light-mode popover too. */}
            <ul className="space-y-1.5 text-[11px] leading-snug text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Backspace through a word</span>
                {' '}— cuts it from the video.
              </li>
              <li>
                <span
                  className="rounded bg-neutral-900/85 px-1 font-mono font-medium"
                  style={{ color: SFX_MARKER_YELLOW }}
                >
                  *whoosh*
                </span>
                {' '}— type a sound in asterisks to drop it on the timeline.
              </li>
              <li>
                <span
                  className="rounded bg-neutral-900/85 px-1 font-mono font-medium"
                  style={{ color: SFX_TIMELINE_GREEN }}
                >
                  "a line you said"
                </span>
                {' '}— type a quoted transcript line to duplicate that scene.
              </li>
              <li>
                Click a{' '}
                <span
                  className="rounded bg-neutral-900/85 px-1 font-mono font-medium"
                  style={{ color: SFX_MARKER_YELLOW }}
                >
                  *sound*
                </span>
                {' '}— backspace edits it, × removes it.
              </li>
              <li>Unfinished markers do nothing. ⌘Z undoes any cut.</li>
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
};
