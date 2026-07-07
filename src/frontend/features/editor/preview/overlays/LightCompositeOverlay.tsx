import React, { useEffect, useMemo, useRef } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor/index';
import { lightGradientStops } from '../utils/paintedLightUtils';

/**
 * LightCompositeOverlay — renders the Light Brush (Skill 4) painted lights.
 *
 * A canvas pinned to the centered letterbox, drawn ABOVE the base preview canvas with
 * CSS `mix-blend-mode` so the soft lights composite with the video underneath (screen /
 * soft-light). Purely additive — it never touches FrameDrivenCompositor, so the existing
 * preview path is unchanged; when a clip has no painted lights the canvas stays blank.
 *
 * Lights are stored per track in normalized frame space, so they survive scale/pan. A
 * light may `anchor` to a BlazePose landmark index; when the track has poseLandmarks the
 * light follows that point across the shot (nearest baked frame), giving tracked relight.
 */
interface LightCompositeOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

type Landmark = { x: number; y: number };

function landmarkAtFrame(
  poseLandmarks: { frame: number; lm: Landmark[] }[] | undefined,
  frame: number,
  idx: number,
): [number, number] | null {
  if (!poseLandmarks?.length) return null;
  // Nearest baked frame (cheap; temporal stability comes from the bake itself).
  let best = poseLandmarks[0];
  let bestD = Math.abs(best.frame - frame);
  for (const p of poseLandmarks) {
    const d = Math.abs(p.frame - frame);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  const lm = best.lm?.[idx];
  if (!lm) return null;
  return [lm.x, lm.y];
}

export const LightCompositeOverlay: React.FC<LightCompositeOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tracks = useVideoEditorStore((s) => (s as any).tracks) as any[];
  const currentFrame = useVideoEditorStore(
    (s) => (s as any).currentFrame ?? (s as any).timeline?.currentFrame ?? 0,
  );

  // The (first) video track carrying painted lights.
  const litTrack = useMemo(
    () => tracks?.find((t) => t.type === 'video' && (t.paintedLights?.length ?? 0) > 0),
    [tracks],
  );
  const lights = (litTrack?.paintedLights ?? []) as any[];
  const blend = (lights[0]?.blend ?? 'soft-light') as string;
  const lightsKey = JSON.stringify(lights);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = Math.max(1, Math.round(actualWidth));
    const H = Math.max(1, Math.round(actualHeight));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!lights.length) return;

    const minDim = Math.min(W, H);
    ctx.globalCompositeOperation = 'lighter'; // sum overlapping lights
    for (const light of lights) {
      let [nx, ny] = light.pos as [number, number];
      if (light.anchor != null) {
        const anchored = landmarkAtFrame(litTrack?.poseLandmarks, currentFrame, light.anchor);
        if (anchored) [nx, ny] = anchored;
      }
      const cx = nx * W;
      const cy = ny * H;
      const r = Math.max(2, light.radius * minDim);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const stop of lightGradientStops(light)) grad.addColorStop(stop.offset, stop.color);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, [lightsKey, actualWidth, actualHeight, currentFrame, litTrack]);

  if (!lights.length) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'absolute',
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        width: actualWidth,
        height: actualHeight,
        zIndex: 55,
        pointerEvents: 'none',
        mixBlendMode: blend as any,
      }}
    />
  );
};

export default LightCompositeOverlay;
