import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/frontend/components/ui/tooltip';
import { cn } from '@/frontend/utils/utils';
import { SquareSplitHorizontal } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';
import { ShortcutKbdStack } from '../shortcuts/ShortcutKbdStack';
import { useShortcutKeys } from '../shortcuts/shortcutHooks';

interface TimelinePlayheadProps {
  currentFrame: number;
  frameWidth: number;
  scrollX: number;
  visible: boolean;
  timelineScrollElement?: HTMLElement | null;
  onStartDrag?: (e: React.MouseEvent) => void;
  magneticSnapFrame?: number | null;
  isInteractive?: boolean;
  cutMarkers?: Array<{ key: string; top: number; height: number }>;
}

export const TimelinePlayhead: React.FC<TimelinePlayheadProps> = React.memo(
  ({
    currentFrame,
    frameWidth,
    scrollX,
    visible,
    timelineScrollElement,
    onStartDrag,
    magneticSnapFrame,
    isInteractive = true,
    cutMarkers,
  }) => {
    if (!visible) return null;

    const splitToolKeys = useShortcutKeys('timeline-split-playhead-k', ['k']);

    // Check if playhead is snapping (magneticSnapFrame matches currentFrame)
    const isSnapping =
      magneticSnapFrame !== null && magneticSnapFrame === currentFrame;

    const left = useMemo(
      () =>
        currentFrame * frameWidth -
        (timelineScrollElement?.scrollLeft ?? scrollX),
      [currentFrame, frameWidth, scrollX, timelineScrollElement],
    );
    const cutIconLeft = useMemo(() => left, [left]);

    const styles = useMemo(
      () => ({
        hitbox: {
          left: left - 9, // Centers 20px touch target on the playhead center (approx left+1)
          width: 20,
          transform: 'translate3d(0, 0, 0)',
        },
        handleContainer: {
          left: left - 19, // Centers 40px touch target on the playhead center
          width: 40,
          height: 40,
          top: -32, // Position to align the 24px visual handle correctly (-24px top visual)
          transform: 'translate3d(0, 0, 0)',
          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
        },
        // Keeping for reference if needed
        indicator: {
          left: left + 8,
          transform: 'translate3d(0, 0, 0)',
        },
      }),
      [left],
    );

    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (!isInteractive) return;
        // Only respond to left mouse button
        if (e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        if (onStartDrag) {
          onStartDrag(e);
        }
      },
      [isInteractive, onStartDrag],
    );

    return (
      <>
        {/* Playhead line - Enhanced Hitbox */}
        <div
          className={cn(
            'group absolute top-0 z-30 h-full select-none touch-none',
            isInteractive
              ? 'cursor-ew-resize pointer-events-auto'
              : 'pointer-events-none',
          )}
          style={styles.hitbox}
          onMouseDown={handleMouseDown}
        >
          {/* Visual Line - Centered in hitbox */}
          <div
            className={cn(
              'absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 rounded-full transition-all duration-150 ease-out will-change-transform',
              isSnapping ? 'bg-secondary' : 'bg-primary',
            )}
          />
        </div>

        {cutMarkers && cutMarkers.length > 0 && (
          <TooltipProvider>
            {cutMarkers.map((marker) => (
              <div
                key={marker.key}
                className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto z-[1001] text-foreground"
                style={{
                  left: `${cutIconLeft}px`,
                  top: `${marker.top + marker.height / 2}px`,
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="bg-background rounded-sm p-1">
                      <SquareSplitHorizontal size={18} />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    Split <ShortcutKbdStack combos={splitToolKeys} />
                  </TooltipContent>
                </Tooltip>
              </div>
            ))}
          </TooltipProvider>
        )}

        {/* Playhead handle - Enhanced Hitbox */}
        <div
          className={cn(
            'absolute z-30 flex items-center justify-center will-change-transform',
            isInteractive
              ? 'cursor-grab active:cursor-grabbing pointer-events-auto'
              : 'pointer-events-none',
          )}
          style={styles.handleContainer}
          onMouseDown={handleMouseDown}
        >
          <svg width="24" height="24" viewBox="0 0 24 24">
            <path
              d="M6,8 A2,2 0 0,1 8,6 L16,6 A2,2 0 0,1 18,8 A2,2 0 0,1 17.5,9.5 L12.8,16.2 A1,1 0 0,1 11.2,16.2 L6.5,9.5 A2,2 0 0,1 6,8 Z"
              fill={
                isSnapping ? 'hsl(var(--secondary))' : 'hsl(var(--primary))'
              }
              stroke="none"
            />
          </svg>
        </div>

        {/* Frame indicator - also draggable */}
        {/* <div
          className={cn(
            'absolute top-0.5 px-1.5 py-0.5 rounded-sm text-[10px] font-bold whitespace-nowrap z-30 cursor-grab active:cursor-grabbing will-change-transform pointer-events-auto',
            isSnapping
              ? 'bg-secondary/90 text-secondary-foreground'
              : 'bg-primary/90 text-primary-foreground',
          )}
          style={styles.indicator}
          onMouseDown={handleMouseDown}
        >
          {currentFrame}
        </div> */}
      </>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.currentFrame === nextProps.currentFrame &&
      prevProps.frameWidth === nextProps.frameWidth &&
      prevProps.scrollX === nextProps.scrollX &&
      prevProps.visible === nextProps.visible &&
      prevProps.timelineScrollElement === nextProps.timelineScrollElement &&
      prevProps.onStartDrag === nextProps.onStartDrag &&
      prevProps.magneticSnapFrame === nextProps.magneticSnapFrame &&
      prevProps.isInteractive === nextProps.isInteractive &&
      areCutMarkersEqual(prevProps.cutMarkers, nextProps.cutMarkers)
    );
  },
);

const areCutMarkersEqual = (
  prev?: Array<{ key: string; top: number; height: number }>,
  next?: Array<{ key: string; top: number; height: number }>,
) => {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (
      prev[i].key !== next[i].key ||
      prev[i].top !== next[i].top ||
      prev[i].height !== next[i].height
    ) {
      return false;
    }
  }
  return true;
};
