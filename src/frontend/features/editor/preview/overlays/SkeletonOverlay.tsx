import React, { useEffect, useRef } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor';

// BlazePose 33-landmark connections [a, b] — matches skeletonrender.py
const POSE_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12],
  [11, 13], [13, 15],
  [15, 17], [17, 19], [19, 15], [15, 21],
  [12, 14], [14, 16],
  [16, 18], [18, 20], [20, 16], [16, 22],
  [11, 23], [12, 24],
  [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [31, 27],
  [24, 26], [26, 28], [28, 30], [30, 32], [32, 28],
];

const BONE_COLOR = '#00ff50';
const VIS_THRESHOLD = 0.4;

const JOINT_COLORS: Record<string, string> = {
  face:   '#b4ffb4',
  arm_l:  '#00c8ff',
  arm_r:  '#ffc800',
  torso:  '#ffffff',
  leg_l:  '#7864ff',
  leg_r:  '#ff64b4',
};

const IDX_REGION: Record<number, string> = {
  0: 'face', 1: 'face', 2: 'face', 3: 'face', 4: 'face',
  5: 'face', 6: 'face', 7: 'face', 8: 'face', 9: 'face', 10: 'face',
  11: 'torso', 12: 'torso',
  13: 'arm_l', 15: 'arm_l', 17: 'arm_l', 19: 'arm_l', 21: 'arm_l',
  14: 'arm_r', 16: 'arm_r', 18: 'arm_r', 20: 'arm_r', 22: 'arm_r',
  23: 'torso', 24: 'torso',
  25: 'leg_l', 27: 'leg_l', 29: 'leg_l', 31: 'leg_l',
  26: 'leg_r', 28: 'leg_r', 30: 'leg_r', 32: 'leg_r',
};

interface SkeletonOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

type LmEntry = [number, number, number];

function isInFrame(p: LmEntry): boolean {
  return p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
}

function isSkeletonValid(lm: LmEntry[]): boolean {
  const visible = lm.filter(p => p[2] >= VIS_THRESHOLD && isInFrame(p));
  if (visible.length < 8) return false;
  const xs = visible.map(p => p[0]);
  const spanX = Math.max(...xs) - Math.min(...xs);
  if (spanX > 0.85) return false;
  return true;
}

export const SkeletonOverlay: React.FC<SkeletonOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const currentFrame = useVideoEditorStore((s) => s.timeline.currentFrame);
  const tracks = useVideoEditorStore((s) => s.tracks);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const activeTrack = tracks.find(
      (t) =>
        t.type === 'video' &&
        t.visible &&
        (t as any).poseLandmarks?.length > 0 &&
        t.startFrame <= currentFrame &&
        t.endFrame > currentFrame,
    );

    if (!activeTrack) return;

    const landmarks: Array<{ frame: number; lm: LmEntry[] }> =
      (activeTrack as any).poseLandmarks ?? [];
    if (!landmarks.length) return;

    const sourceStartTime = activeTrack.sourceStartTime ?? 0;
    const sourceFps = (activeTrack as any).sourceFps ?? 30;
    const framesFromStart = currentFrame - activeTrack.startFrame;
    const sourceFrame = Math.round(sourceStartTime * sourceFps + framesFromStart);

    // Binary search for surrounding keyframes
    let lo = 0, hi = landmarks.length - 1, beforeIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (landmarks[mid].frame <= sourceFrame) { beforeIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    const afterIdx = beforeIdx + 1;
    const before = beforeIdx >= 0 ? landmarks[beforeIdx] : null;
    const after = afterIdx < landmarks.length ? landmarks[afterIdx] : null;

    if (!before && !after) return;
    if (before && after && (after.frame - before.frame) > 90) return;

    let lm: LmEntry[];
    if (!before) {
      lm = after!.lm;
    } else if (!after) {
      lm = before.lm;
    } else if (before.frame === after.frame) {
      lm = before.lm;
    } else {
      const t = (sourceFrame - before.frame) / (after.frame - before.frame);
      lm = before.lm.map((b, i) => {
        const a = after.lm[i];
        if (!a) return b;
        return [
          b[0] + (a[0] - b[0]) * t,
          b[1] + (a[1] - b[1]) * t,
          Math.min(b[2], a[2]),
        ];
      });
    }

    if (!isSkeletonValid(lm)) return;

    const w = canvas.width;
    const h = canvas.height;

    // Draw bones
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = BONE_COLOR;
    ctx.shadowColor = BONE_COLOR;
    ctx.shadowBlur = 6;

    for (const [a, b] of POSE_CONNECTIONS) {
      if (!lm[a] || !lm[b]) continue;
      if (lm[a][2] < VIS_THRESHOLD || lm[b][2] < VIS_THRESHOLD) continue;
      if (!isInFrame(lm[a]) || !isInFrame(lm[b])) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a][0] * w, lm[a][1] * h);
      ctx.lineTo(lm[b][0] * w, lm[b][1] * h);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;

    // Draw joints
    for (let i = 0; i < lm.length; i++) {
      if (!lm[i] || lm[i][2] < VIS_THRESHOLD) continue;
      if (!isInFrame(lm[i])) continue;
      const px = lm[i][0] * w;
      const py = lm[i][1] * h;
      const region = IDX_REGION[i] ?? 'torso';
      const color = JOINT_COLORS[region] ?? '#ffffff';

      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#000000';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }, [currentFrame, tracks, actualWidth, actualHeight]);

  return (
    <canvas
      ref={canvasRef}
      width={actualWidth}
      height={actualHeight}
      style={{
        position: 'absolute',
        left: `calc(50% + ${panX}px)`,
        top: `calc(50% + ${panY}px)`,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    />
  );
};
