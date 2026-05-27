/**
 * Visual test scenarios.
 * Each scenario defines:
 *   - name: used as the output folder name
 *   - description: what we're checking visually
 *   - initialState: partial video editor store state to seed before ops
 *   - ops: array of Op objects to apply via operationEngine
 *   - waitMs: how long to wait after ops before screenshotting (default 600)
 */

/** Minimal video track to place on the timeline — no real video file needed. */
function fakeVideoTrack(overrides = {}) {
  return {
    id: 'clip_a1',
    type: 'video',
    name: 'testsrc.mp4',
    source: '',
    previewUrl: '',
    startFrame: 0,
    endFrame: 900,   // 30s at 30fps
    duration: 900,
    sourceStartTime: 0,
    trackRowIndex: 0,
    visible: true,
    locked: false,
    muted: false,
    color: '#4A90D9',
    ...overrides,
  };
}

export const SCENARIOS = [
  {
    name: 'letterbox-blur-9x16',
    description: 'Blurred letterbox bars should appear top/bottom after setAspectRatio(9:16) + setLetterboxBlur',
    // Only inject tracks + preview — don't touch timeline (keep defaults to avoid missing required fields)
    initialState: {
      tracks: [fakeVideoTrack()],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'setAspectRatio', ratio: '9:16' },
      { type: 'setLetterboxBlur', clipId: 'clip_a1', enabled: true },
    ],
    waitMs: 800,
  },

  {
    name: 'trim-to-15s',
    description: 'Timeline bar should shrink to ~half width after trimClip to 450 frames (15s of 30s total)',
    initialState: {
      tracks: [fakeVideoTrack({ endFrame: 900, duration: 900 })],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'trimClip', clipId: 'clip_a1', newStartFrame: 0, newEndFrame: 450 },
    ],
    waitMs: 600,
  },

  {
    name: 'color-grade-warm',
    description: 'Canvas should look warmer/more saturated after colorGrade',
    initialState: {
      tracks: [fakeVideoTrack()],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'colorGrade', clipId: 'clip_a1', brightness: 1.05, contrast: 1.1, saturation: 1.3 },
    ],
    waitMs: 600,
  },

  {
    name: 'captions-rendered',
    description: 'Caption text should be visible at bottom-center of canvas',
    initialState: {
      tracks: [fakeVideoTrack()],
      preview: { canvasWidth: 1080, canvasHeight: 1920 },
    },
    ops: [
      { type: 'addCaption', startSeconds: 0, endSeconds: 3, text: 'VISUAL TEST', style: { fontFamily: 'Impact', fontSize: 90, fillColor: '#FFFFFF', isBold: false, isUppercase: true, position: 0.65, highlightColor: '#FFD700' } },
      { type: 'addCaption', startSeconds: 3, endSeconds: 6, text: 'CAPTIONS RENDER', style: { fontFamily: 'Impact', fontSize: 90, fillColor: '#FFFFFF', isBold: false, isUppercase: true, position: 0.65, highlightColor: '#FFD700' } },
    ],
    waitMs: 800,
  },
];
