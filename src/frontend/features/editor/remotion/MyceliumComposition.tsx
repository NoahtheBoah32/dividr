/**
 * MyceliumComposition — Remotion composition that mirrors Dividr's timeline state.
 * This is the hidden rendering layer: EDITH edits this, Dividr shows it live.
 * Captions, color grades, and video segments all render here with Remotion quality.
 */

import React from 'react';
import { AbsoluteFill, Sequence, Video, useCurrentFrame, useVideoConfig } from 'remotion';

export interface CompositionTrack {
  id: string;
  type: 'video' | 'audio' | 'subtitle' | 'image';
  source: string;         // file:// URL or blob URL
  startFrame: number;
  endFrame: number;
  sourceStartTime: number; // seconds into the source file
  visible: boolean;
  filter?: string;         // CSS filter string for color grade
  subtitleText?: string;
  subtitleStyle?: {
    fontFamily?: string;
    fontSize?: number;
    fillColor?: string;
    highlightColor?: string;
    highlightWordIndex?: number;
    isBold?: boolean;
    textTransform?: string;
  };
  subtitleTransform?: {
    x: number; // -1 to 1
    y: number; // -1 to 1 (0 = center, 0.3 = below center)
  };
}

interface MyceliumCompositionProps {
  tracks: CompositionTrack[];
  canvasWidth: number;
  canvasHeight: number;
}

const KaraokeCaption: React.FC<{
  track: CompositionTrack;
  frame: number;
  fps: number;
  height: number;
}> = ({ track, frame, fps, height }) => {
  const style = track.subtitleStyle ?? {};
  const transform = track.subtitleTransform ?? { x: 0, y: 0.3 };

  // Vertical position: transform.y is -1 to 1 where 0 = center
  // Convert to a percentage of canvas height from top
  const topPct = 50 + transform.y * 50;

  const words = (track.subtitleText ?? '').split(' ');
  const hlIdx = style.highlightWordIndex ?? -1;

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingTop: `${topPct}%`,
        paddingLeft: '24px',
        paddingRight: '24px',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '4px',
          textAlign: 'center',
        }}
      >
        {words.map((word, i) => (
          <span
            key={i}
            style={{
              fontFamily: style.fontFamily ?? 'Inter, sans-serif',
              fontSize: `${style.fontSize ?? 52}px`,
              fontWeight: style.isBold ? 700 : 400,
              textTransform: (style.textTransform as any) ?? 'uppercase',
              color: i === hlIdx ? (style.highlightColor ?? '#FFD700') : (style.fillColor ?? '#FFFFFF'),
              textShadow: '0 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.6)',
              lineHeight: 1.15,
              letterSpacing: '0.02em',
              WebkitTextStroke: '0.5px rgba(0,0,0,0.3)',
            }}
          >
            {word}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const MyceliumComposition: React.FC<MyceliumCompositionProps> = ({
  tracks,
  canvasWidth,
  canvasHeight,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const videoTracks = tracks.filter(
    (t) => (t.type === 'video' || t.type === 'image') && t.visible,
  );
  const subtitleTracks = tracks.filter(
    (t) =>
      t.type === 'subtitle' &&
      t.visible &&
      frame >= t.startFrame &&
      frame < t.endFrame,
  );

  return (
    <AbsoluteFill style={{ background: '#000', width: canvasWidth, height: canvasHeight }}>
      {videoTracks.map((track) => {
        if (frame < track.startFrame || frame >= track.endFrame) return null;
        const durationInFrames = track.endFrame - track.startFrame;
        const startFrom = Math.round((track.sourceStartTime ?? 0) * fps);

        return (
          <Sequence
            key={track.id}
            from={track.startFrame}
            durationInFrames={durationInFrames}
          >
            <AbsoluteFill
              style={{
                filter: track.filter ?? undefined,
              }}
            >
              <Video
                src={track.source}
                startFrom={startFrom}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {subtitleTracks.map((track) => (
        <KaraokeCaption
          key={track.id}
          track={track}
          frame={frame}
          fps={fps}
          height={canvasHeight}
        />
      ))}
    </AbsoluteFill>
  );
};
