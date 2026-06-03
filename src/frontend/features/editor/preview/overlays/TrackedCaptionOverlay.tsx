import React, { useEffect, useRef, useState } from 'react';
import { useVideoEditorStore } from '../../stores/videoEditor';

type LmEntry = [number, number, number];

const VIS_THRESHOLD = 0.3;
const NOSE = 0;
const L_EYE = 2;
const R_EYE = 5;
const L_EAR = 7;
const R_EAR = 8;
const L_SHOULDER = 11;
const R_SHOULDER = 12;

// EMA for position + tilt only — size comes from frame height, NOT skeleton
const SMOOTH_ALPHA = 0.72;

interface SmoothedPos { x: number; y: number; crownY: number; tilt: number }

function interpolateLandmarks(
  landmarks: Array<{ frame: number; lm: LmEntry[] }>,
  sourceFrame: number,
): LmEntry[] | null {
  if (!landmarks.length) return null;

  let lo = 0, hi = landmarks.length - 1, beforeIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (landmarks[mid].frame <= sourceFrame) { beforeIdx = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  const afterIdx = beforeIdx + 1;
  const before = beforeIdx >= 0 ? landmarks[beforeIdx] : null;
  const after = afterIdx < landmarks.length ? landmarks[afterIdx] : null;

  if (!before && !after) return null;
  if (before && after && (after.frame - before.frame) > 90) return null;

  if (!before) return after!.lm;
  if (!after) return before.lm;
  if (before.frame === after.frame) return before.lm;

  // Scene cut detection: nose jump > 15% of frame = BlazePose morphing across a cut
  const noseBefore = before.lm[0];
  const noseAfter  = after.lm[0];
  if (noseBefore && noseAfter) {
    const dx = Math.abs(noseAfter[0] - noseBefore[0]);
    const dy = Math.abs(noseAfter[1] - noseBefore[1]);
    if (dx > 0.15 || dy > 0.15) return null;
  }

  const t = (sourceFrame - before.frame) / (after.frame - before.frame);
  return before.lm.map((b, i) => {
    const a = after.lm[i];
    if (!a) return b;
    return [
      b[0] + (a[0] - b[0]) * t,
      b[1] + (a[1] - b[1]) * t,
      Math.min(b[2], a[2]),
    ] as LmEntry;
  });
}

interface TrackedCaptionOverlayProps {
  actualWidth: number;
  actualHeight: number;
  panX: number;
  panY: number;
}

export const TrackedCaptionOverlay: React.FC<TrackedCaptionOverlayProps> = ({
  actualWidth,
  actualHeight,
  panX,
  panY,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const smoothedPositions = useRef<Map<string, SmoothedPos>>(new Map());
  // After a scene cut (lm returns null), blank for this many frames before re-attaching.
  // Prevents the caption snapping onto the wrong person immediately after a camera cut.
  const postCutBlank = useRef<Map<string, number>>(new Map());
  const POST_CUT_BLANK_FRAMES = 18; // ~0.6s at 30fps
  // Trigger a re-draw once Bangers finishes loading so we don't fall back to Impact
  const [bangersReady, setBangersReady] = useState(false);
  const currentFrame = useVideoEditorStore((s) => s.timeline.currentFrame);
  const tracks = useVideoEditorStore((s) => s.tracks);

  useEffect(() => {
    if (document.fonts.check('1em Bangers')) { setBangersReady(true); return; }
    new FontFace(
      'Bangers',
      'url(https://fonts.gstatic.com/s/bangers/v24/FeVQS0BTqb0h60ACL5la2bxii28wYQ.woff2)',
    ).load()
      .then((f) => { document.fonts.add(f); setBangersReady(true); })
      .catch(() => setBangersReady(true)); // fall through to Impact on error — still re-draws
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    const h = canvas.height;

    const trackedSubs = tracks.filter(
      (t) =>
        (t as any).subtitleTracked === true &&
        t.type === 'subtitle' &&
        t.subtitleText &&
        t.startFrame <= currentFrame &&
        t.endFrame > currentFrame,
    );

    if (!trackedSubs.length) return;

    // Font size is a fixed % of frame height — skeleton controls WHERE and TILT only,
    // never HOW BIG. This matches MrBeast's captions which stay consistent regardless
    // of how close or far the person is from camera.
    const BASE_FONT_SIZE = Math.round(h * 0.085);

    for (const sub of trackedSubs) {
      const videoTrackId = (sub as any).trackedLinkedVideoTrackId as string | undefined;
      const videoTrack = videoTrackId
        ? tracks.find((t) => t.id === videoTrackId)
        : tracks.find(
            (t) =>
              t.type === 'video' &&
              (t as any).poseLandmarks?.length > 0 &&
              t.startFrame <= currentFrame &&
              t.endFrame > currentFrame,
          );

      if (!videoTrack) continue;

      const landmarks: Array<{ frame: number; lm: LmEntry[] }> =
        (videoTrack as any).poseLandmarks ?? [];
      if (!landmarks.length) continue;

      const sourceStartTime = (videoTrack as any).sourceStartTime ?? 0;
      const sourceFps = (videoTrack as any).sourceFps ?? 30;
      const framesFromStart = currentFrame - videoTrack.startFrame;
      const sourceFrame = Math.round(sourceStartTime * sourceFps + framesFromStart);

      const lm = interpolateLandmarks(landmarks, sourceFrame);
      if (!lm) {
        smoothedPositions.current.delete(sub.id);
        postCutBlank.current.set(sub.id, currentFrame);
        continue;
      }

      // Post-cut blank window — don't snap to wrong person right after a camera cut
      const cutFrame = postCutBlank.current.get(sub.id);
      if (cutFrame !== undefined) {
        if (currentFrame - cutFrame < POST_CUT_BLANK_FRAMES) continue;
        postCutBlank.current.delete(sub.id);
      }

      const nose = lm[NOSE];
      const lEye  = lm[L_EYE];
      const rEye  = lm[R_EYE];
      const lEar  = lm[L_EAR];
      const rEar  = lm[R_EAR];

      if (!nose || nose[2] < VIS_THRESHOLD) continue;
      if (nose[0] < 0 || nose[0] > 1 || nose[1] < 0 || nose[1] > 1) continue;

      // Eye-line tilt with profile guard and ±15° cap
      const MAX_TILT = 0.26;
      let rawTilt = 0;
      const eyesValid =
        lEye && rEye &&
        lEye[2] >= VIS_THRESHOLD && rEye[2] >= VIS_THRESHOLD &&
        lEye[0] < rEye[0];
      if (eyesValid) {
        const t = Math.atan2(rEye[1] - lEye[1], rEye[0] - lEye[0]);
        rawTilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, t));
      }

      // Crown Y: extrapolate above the highest visible face landmark.
      // Eyes/ears are at the MID-face level (~20-30% from crown to chin), so just taking
      // their min Y gives a forehead position, not the crown. We scale up using the
      // nose-to-topLandmark distance as a proxy for face height.
      const noseYpx = nose[1] * h;
      const topFaceLm = [lEar, rEar, lEye, rEye]
        .filter((p): p is LmEntry => !!p && p[2] >= VIS_THRESHOLD && p[1] >= 0 && p[1] <= 1);
      let rawCrownY: number;
      if (topFaceLm.length > 0) {
        const topLmYpx = Math.min(...topFaceLm.map(p => p[1])) * h;
        // Eyes/ears are ~25-40% from crown to chin; nose is ~55-65%.
        // Crown ≈ topLandmark - 0.7 * (nose - topLandmark)
        const dist = Math.max(noseYpx - topLmYpx, h * 0.03);
        rawCrownY = topLmYpx - dist * 0.7;
      } else {
        rawCrownY = noseYpx - h * 0.22;
      }
      rawCrownY = Math.max(rawCrownY, 2); // never above the canvas edge

      // EMA smoothing with person-lock.
      // Any jump > 10% of frame per frame is a skeleton person-switch, not real head movement
      // (genuine head movement is < 2% per frame at 30fps). On a jump: hold the last valid
      // position instead of following — caption stays on the correct person.
      const rawX = nose[0];
      const rawY = nose[1];
      const prev = smoothedPositions.current.get(sub.id);
      const isPersonSwitch = prev && (Math.abs(rawX - prev.x) > 0.10 || Math.abs(rawY - prev.y) > 0.10);

      let smX: number, smY: number, smCrownY: number, smTilt: number;
      if (isPersonSwitch) {
        // Hold — don't follow the skeleton to the wrong person
        smX = prev!.x; smY = prev!.y; smCrownY = prev!.crownY; smTilt = prev!.tilt;
      } else {
        const sp = smoothedPositions.current.get(sub.id);
        smX      = sp ? sp.x      * SMOOTH_ALPHA + rawX      * (1 - SMOOTH_ALPHA) : rawX;
        smY      = sp ? sp.y      * SMOOTH_ALPHA + rawY      * (1 - SMOOTH_ALPHA) : rawY;
        smCrownY = sp ? sp.crownY * SMOOTH_ALPHA + rawCrownY * (1 - SMOOTH_ALPHA) : rawCrownY;
        smTilt   = sp ? sp.tilt   * SMOOTH_ALPHA + rawTilt   * (1 - SMOOTH_ALPHA) : rawTilt;
        smoothedPositions.current.set(sub.id, { x: smX, y: smY, crownY: smCrownY, tilt: smTilt });
      }

      // Style — override with per-track style if set, else MrBeast defaults
      const style = (sub as any).style ?? {};
      const text = ((sub.subtitleText ?? '') as string).toUpperCase();
      const fontSize = style.fontSize ? Math.round(style.fontSize) : BASE_FONT_SIZE;
      const fontFamily = (style.fontFamily ?? 'Bangers') as string;
      const strokeWidth = Math.round(fontSize * 0.17); // softer than 0.22 — less harsh
      const fillColor = (style.color ?? '#FFFFFF') as string;

      ctx.save();
      ctx.translate(smX * w, smCrownY);
      ctx.rotate(smTilt);

      ctx.font = `${fontSize}px "${fontFamily}", Impact, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      const yOffset = -(Math.round(strokeWidth / 2) + 6);

      // Drop shadow behind stroke — gives depth and softness, less "stamped on" look
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = Math.round(fontSize * 0.12);
      ctx.shadowOffsetX = Math.round(fontSize * 0.04);
      ctx.shadowOffsetY = Math.round(fontSize * 0.05);

      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = '#000000';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeText(text, 0, yOffset);

      // Clear shadow before fill — shadow only on the stroke, fill stays crisp
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = fillColor;
      ctx.fillText(text, 0, yOffset);

      ctx.restore();
    }
  }, [currentFrame, tracks, actualWidth, actualHeight, bangersReady]);

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
        zIndex: 15,
      }}
    />
  );
};
