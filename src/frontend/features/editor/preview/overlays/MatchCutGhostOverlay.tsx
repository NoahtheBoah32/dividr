/**
 * Match-cut alignment aid. When `timeline.matchCut.enabled`, this ghosts the target clip's
 * chosen frame over the preview canvas at reduced opacity, so the editor can scrub the main
 * clip until the two shots visually rhyme, then cut. Self-contained (own paused <video>) —
 * it never touches the compositor or playback, so it can't break anything.
 */
import { useEffect, useRef } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor/index';

interface Props {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

export const MatchCutGhostOverlay: React.FC<Props> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
}) => {
  const matchCut = useVideoEditorStore((s) => s.timeline.matchCut);
  const tracks = useVideoEditorStore((s) => s.tracks);
  const videoRef = useRef<HTMLVideoElement>(null);

  const target =
    matchCut?.enabled && matchCut.targetClipId
      ? tracks.find((t) => t.id === matchCut.targetClipId)
      : undefined;
  const src = (target as any)?.previewUrl || (target as any)?.source;

  // Seek the ghost video to the chosen target frame (kept paused).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !matchCut?.enabled) return;
    const t = matchCut.targetSourceTime ?? 0;
    const seek = () => {
      try {
        v.currentTime = t;
      } catch {
        /* not ready yet */
      }
    };
    if (v.readyState >= 1) {
      seek();
      return;
    }
    v.addEventListener('loadedmetadata', seek, { once: true });
    // Remove the listener if src/target changes or the overlay unmounts before metadata loads,
    // so a stale seek can't fire against a swapped-out source.
    return () => v.removeEventListener('loadedmetadata', seek);
  }, [matchCut?.enabled, matchCut?.targetSourceTime, src]);

  if (!matchCut?.enabled || !src) return null;
  const opacity = matchCut.opacity ?? 0.45;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        width: actualWidth,
        height: actualHeight,
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        overflow: 'hidden',
        zIndex: 1400,
      }}
    >
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="auto"
        className="absolute inset-0 h-full w-full object-contain"
        style={{ opacity, mixBlendMode: 'screen' }}
      />
      <div
        className="absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-bold"
        style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', letterSpacing: '0.3px' }}
      >
        ◇ MATCH CUT — scrub to align, then cut
      </div>
    </div>
  );
};
