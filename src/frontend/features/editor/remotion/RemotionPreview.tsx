/**
 * RemotionPreview — the live Dividr view of what Remotion is editing behind the scenes.
 * As EDITH applies ops (captions, cuts, grades), this Player updates in real-time.
 * The user sees edits materializing as a "ghost editor" effect.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Player, PlayerRef } from '@remotion/player';
import { useVideoEditorStore } from '../stores/videoEditor';
import { MyceliumComposition } from './MyceliumComposition';
import { useCompositionTracks } from './useCompositionTracks';

export const RemotionPreview: React.FC<{ className?: string }> = ({ className }) => {
  const playerRef = useRef<PlayerRef>(null);

  const currentFrame = useVideoEditorStore((s) => s.timeline.currentFrame);
  const totalFrames = useVideoEditorStore((s) => s.timeline.totalFrames ?? 900);
  const fps = useVideoEditorStore((s) => s.timeline.fps ?? 30);
  const isPlaying = useVideoEditorStore((s) => s.playback.isPlaying);
  const canvasWidth = useVideoEditorStore((s) => s.preview.canvasWidth ?? 1080);
  const canvasHeight = useVideoEditorStore((s) => s.preview.canvasHeight ?? 1920);

  const tracks = useCompositionTracks();

  // Keep Remotion Player in sync with Dividr's playhead
  useEffect(() => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.play();
    } else {
      playerRef.current.pause();
      playerRef.current.seekTo(currentFrame);
    }
  }, [currentFrame, isPlaying]);

  // Forward Remotion's frame changes back to Dividr's store
  const setCurrentFrame = useVideoEditorStore((s) => s.setCurrentFrame);
  const handleFrameUpdate = useCallback(
    (e: { detail: { frame: number } }) => {
      setCurrentFrame(e.detail.frame);
    },
    [setCurrentFrame],
  );

  if (tracks.filter((t) => t.type === 'video').length === 0) {
    return null; // No video tracks yet — don't show empty player
  }

  return (
    <div
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}
    >
      <Player
        ref={playerRef}
        component={MyceliumComposition}
        inputProps={{ tracks, canvasWidth, canvasHeight }}
        durationInFrames={Math.max(totalFrames, 1)}
        fps={fps}
        compositionWidth={canvasWidth}
        compositionHeight={canvasHeight}
        style={{
          width: '100%',
          height: '100%',
        }}
        controls={false}
        loop={false}
        showVolumeControls={false}
        // @ts-ignore — onTimeUpdate is a valid event but not typed in older @remotion/player
        onTimeUpdate={handleFrameUpdate}
      />
    </div>
  );
};
