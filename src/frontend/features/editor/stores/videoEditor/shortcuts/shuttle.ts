/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDisplayFps } from '../types/timeline.types';

/**
 * J/K/L shuttle transport (industry convention):
 *   J = play backward (tap again: 2x, 4x)
 *   K = stop
 *   L = play forward (tap again: 2x, 4x)
 *
 * Forward shuttle rides the real playback engine via playbackRate.
 * Reverse shuttle steps currentFrame manually — the preview engine
 * cannot decode backwards, so we drive the frame-accurate seek path
 * (same one the arrow keys use) on a timer. Audio stays silent in
 * reverse, which matches how NLEs behave for scrubbed reverse play.
 */

const SPEEDS = [1, 2, 4];

let reverseTimer: ReturnType<typeof setInterval> | null = null;
let reverseSpeed = 0; // 0 = idle
let forwardSpeed = 0; // 0 = idle; tracked so repeated L taps escalate

const clearReverse = () => {
  if (reverseTimer) {
    clearInterval(reverseTimer);
    reverseTimer = null;
  }
  reverseSpeed = 0;
};

export const shuttleStop = (getStore: () => any) => {
  const store = getStore();
  clearReverse();
  forwardSpeed = 0;
  store.setPlaybackRate(1);
  store.pause();
};

export const shuttleForward = (getStore: () => any) => {
  const store = getStore();
  if (store.render?.isRendering) return;
  clearReverse();
  const idx = SPEEDS.indexOf(forwardSpeed);
  forwardSpeed = idx === -1 ? 1 : SPEEDS[Math.min(idx + 1, SPEEDS.length - 1)];
  store.setPlaybackRate(forwardSpeed);
  store.play();
};

export const shuttleReverse = (getStore: () => any) => {
  const store = getStore();
  if (store.render?.isRendering) return;
  store.pause();
  store.setPlaybackRate(1);
  forwardSpeed = 0;

  const idx = SPEEDS.indexOf(reverseSpeed);
  reverseSpeed = idx === -1 ? 1 : SPEEDS[Math.min(idx + 1, SPEEDS.length - 1)];

  if (reverseTimer) clearInterval(reverseTimer);
  let last = performance.now();
  let acc = 0;
  reverseTimer = setInterval(() => {
    const s = getStore();
    // Space/L resumed real playback — the reverse shuttle yields.
    if (s.playback.isPlaying || s.render?.isRendering) {
      clearReverse();
      return;
    }
    const now = performance.now();
    acc += ((now - last) / 1000) * getDisplayFps(s.tracks) * reverseSpeed;
    last = now;
    const step = Math.floor(acc);
    if (step < 1) return;
    acc -= step;
    const next = Math.max(0, s.timeline.currentFrame - step);
    s.setCurrentFrame(next);
    if (next === 0) clearReverse();
  }, 33);
};

/** True while the reverse shuttle timer is running (for tests). */
export const isShuttlingReverse = () => reverseTimer !== null;
