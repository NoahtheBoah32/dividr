import { Button } from '@/frontend/components/ui/button';
import { Separator } from '@/frontend/components/ui/separator';
import { Slider } from '@/frontend/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/frontend/components/ui/tooltip';
import { cn } from '@/frontend/utils/utils';
import { RotateCcw } from 'lucide-react';
import React, { useCallback } from 'react';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';

interface VideoFramePanelProps {
  selectedTrackIds: string[];
}

type PipStyle = 'none' | 'circle' | 'rounded-square' | 'square';
type PipCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

const CORNER_POSITIONS: Record<PipCorner, { x: number; y: number }> = {
  'top-right':    { x: 0.83, y: 0.14 },
  'top-left':     { x: 0.17, y: 0.14 },
  'bottom-right': { x: 0.83, y: 0.86 },
  'bottom-left':  { x: 0.17, y: 0.86 },
};

const DEFAULT_PIP = {
  style: 'none' as PipStyle,
  x: 0.17,
  y: 0.86,
  size: 0.16,
  borderColor: '#FFB800',
  borderWidth: 4,
};

/** Canva-style landscape thumbnail clipped to the frame shape */
function FrameThumbnail({ style, active }: { style: PipStyle; active: boolean }) {
  if (style === 'none') {
    return (
      <svg viewBox="0 0 60 48" className="w-full h-full">
        <circle cx="30" cy="24" r="19" fill="none" stroke={active ? '#ffffff' : '#6b7280'} strokeWidth="2.5" />
        <line x1="17" y1="11" x2="43" y2="37" stroke={active ? '#ffffff' : '#6b7280'} strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }

  const uid = `pip-clip-${style}`;
  let clipShape: React.ReactNode;
  let borderShape: React.ReactNode;
  const stroke = active ? '#FFB800' : '#6b7280';

  if (style === 'circle') {
    clipShape = <circle cx="30" cy="24" r="20" />;
    borderShape = <circle cx="30" cy="24" r="20" fill="none" stroke={stroke} strokeWidth="2.5" />;
  } else if (style === 'rounded-square') {
    clipShape = <rect x="7" y="4" width="46" height="40" rx="10" />;
    borderShape = <rect x="7" y="4" width="46" height="40" rx="10" fill="none" stroke={stroke} strokeWidth="2.5" />;
  } else {
    clipShape = <rect x="7" y="4" width="46" height="40" rx="2" />;
    borderShape = <rect x="7" y="4" width="46" height="40" rx="2" fill="none" stroke={stroke} strokeWidth="2.5" />;
  }

  return (
    <svg viewBox="0 0 60 48" className="w-full h-full">
      <defs>
        <clipPath id={uid}>{clipShape}</clipPath>
        <linearGradient id={`sky-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#87CEEB" />
          <stop offset="100%" stopColor="#c9eaf7" />
        </linearGradient>
      </defs>
      {/* Sky */}
      <rect x="0" y="0" width="60" height="48" fill={`url(#sky-${uid})`} clipPath={`url(#${uid})`} />
      {/* Cloud */}
      <g clipPath={`url(#${uid})`}>
        <ellipse cx="30" cy="15" rx="9" ry="5" fill="white" opacity="0.95" />
        <ellipse cx="23" cy="17" rx="6" ry="4" fill="white" opacity="0.9" />
        <ellipse cx="37" cy="17" rx="5" ry="3.5" fill="white" opacity="0.9" />
      </g>
      {/* Hills */}
      <ellipse cx="14" cy="48" rx="22" ry="16" fill="#5bb85b" clipPath={`url(#${uid})`} />
      <ellipse cx="50" cy="50" rx="22" ry="15" fill="#4da64d" clipPath={`url(#${uid})`} />
      <ellipse cx="30" cy="52" rx="18" ry="12" fill="#66c266" clipPath={`url(#${uid})`} />
      {/* Border on top */}
      {borderShape}
    </svg>
  );
}

const STYLES: Array<{ key: PipStyle; label: string }> = [
  { key: 'none', label: 'Off' },
  { key: 'square', label: 'Square' },
  { key: 'rounded-square', label: 'Rounded' },
  { key: 'circle', label: 'Circle' },
];

const VideoFramePanelComponent: React.FC<VideoFramePanelProps> = ({ selectedTrackIds }) => {
  const tracks = useVideoEditorStore(s => s.tracks);
  const updateTrack = useVideoEditorStore(s => s.updateTrack);

  // Frame always operates on the main (layer-0) video track — not the currently selected track.
  // The selected track could be a B-roll, which has no effect on PiP rendering.
  const track = tracks.find(t =>
    t.type === 'video' &&
    ((t as any).trackRowIndex ?? 0) === 0 &&
    ((t as any).layer ?? 0) === 0,
  ) ?? tracks.find(t => t.id === selectedTrackIds[0]);
  if (!track) return null;

  const pip = (track as any).pipFrame ?? DEFAULT_PIP;
  const style: PipStyle = pip.style ?? 'none';
  const x: number = pip.x ?? 0.17;
  const y: number = pip.y ?? 0.86;

  const forceRender = useCallback(() => {
    // Delay one animation frame so React flushes the state update before re-compositing
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('dividr:forceRender')));
  }, []);

  const setPip = useCallback((updates: Partial<typeof DEFAULT_PIP>) => {
    updateTrack(track.id, {
      pipFrame: { ...DEFAULT_PIP, ...pip, ...updates },
    } as any);
    forceRender();
  }, [track.id, pip, updateTrack, forceRender]);

  const handleReset = useCallback(() => {
    updateTrack(track.id, { pipFrame: DEFAULT_PIP } as any);
    forceRender();
  }, [track.id, updateTrack, forceRender]);

  const activeCorner = (Object.entries(CORNER_POSITIONS) as Array<[PipCorner, { x: number; y: number }]>)
    .find(([, pos]) => Math.abs(pos.x - x) < 0.05 && Math.abs(pos.y - y) < 0.05)?.[0] ?? 'bottom-left';

  const hasChanges = style !== 'none';

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Frame</h4>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={handleReset} className="h-7 w-7 p-0" disabled={!hasChanges}>
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>Reset frame settings</p></TooltipContent>
        </Tooltip>
      </div>

      {/* Style selector — Canva-style landscape thumbnails */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Style</label>
        <div className="grid grid-cols-4 gap-2">
          {STYLES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPip({ style: key })}
              className={cn(
                'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all',
                style === key
                  ? 'border-green-500 bg-green-500/10'
                  : 'border-border bg-muted/20 hover:border-muted-foreground/40',
              )}
            >
              <div className="w-12 h-10 flex items-center justify-center">
                <FrameThumbnail style={key} active={style === key} />
              </div>
              <span className={cn('text-[10px] font-medium leading-none', style === key ? 'text-green-500' : 'text-muted-foreground')}>
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {style !== 'none' && (
        <>
          <Separator />

          {/* Corner picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Position</label>
              <span className="text-xs text-muted-foreground">Drag in preview to reposition</span>
            </div>
            <div className="w-full aspect-video bg-muted/10 rounded-lg border border-border/40 grid grid-cols-2 grid-rows-2 p-3 gap-2">
              {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as PipCorner[]).map((corner) => {
                const isActive = activeCorner === corner;
                return (
                  <button
                    key={corner}
                    onClick={() => setPip(CORNER_POSITIONS[corner])}
                    className="flex items-center justify-center rounded transition-all hover:bg-muted/30"
                  >
                    <div className={cn(
                      'w-3.5 h-3.5 rounded-full transition-all',
                      isActive
                        ? 'bg-foreground/80 ring-2 ring-foreground/20'
                        : 'bg-muted-foreground/25 hover:bg-muted-foreground/40',
                    )} />
                  </button>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Size slider */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Size</label>
              <span className="text-sm text-muted-foreground">{Math.round((pip.size ?? 0.16) * 100)}%</span>
            </div>
            <div className="space-y-2 px-1">
              <Slider
                min={8}
                max={35}
                step={1}
                value={[Math.round((pip.size ?? 0.16) * 100)]}
                onValueChange={([v]) => setPip({ size: v / 100 })}
                className="w-full"
              />
              <div className="flex justify-between px-1">
                <span className="text-xs text-muted-foreground">8%</span>
                <span className="text-xs text-muted-foreground">20%</span>
                <span className="text-xs text-muted-foreground">35%</span>
              </div>
            </div>
          </div>
        </>
      )}

      {style === 'none' && (
        <p className="text-xs text-muted-foreground pt-1">
          Select a frame style to show the main video as picture-in-picture when B-roll is playing.
        </p>
      )}
    </div>
  );
};

VideoFramePanelComponent.displayName = 'VideoFramePanel';
export const VideoFramePanel = React.memo(VideoFramePanelComponent);
