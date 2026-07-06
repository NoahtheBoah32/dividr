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

const SEKOND_BROLL_DIR = 'C:/Users/User/Documents/sekond brolls';

export const SCENARIOS = [
  {
    // Renderer-side op plumbing for the three nuanced skills: each op is applied
    // 30x in one page session against the REAL store (main-process result mocked),
    // asserting the store updates correctly every time. Target: 30/30 each.
    name: 'nuanced-op-plumbing',
    description: 'selectiveFreeze / regionalSpeed / findMoment ops update the store 30/30 via the real operationEngine.',
    initialState: {
      tracks: [fakeVideoTrack({ id: 'clip_a1', source: 'C:/clips/test.mp4', previewUrl: '' })],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
      timeline: { currentFrame: 0, fps: 30 },
    },
    ops: [],
    waitMs: 200,
    interact: async (page) => {
      const N = 30;
      const runOnce = async (op) => {
        await page.evaluate((o) => window.__dividrTest.applyOps([o]), op);
        await page.evaluate(() => window.__dividrTest.waitForQueueDrained());
        await page.waitForTimeout(40);
        return page.evaluate(() => {
          const s = window.__dividrTest.getStoreSnapshot();
          const t = s.tracks.find((x) => x.id === 'clip_a1');
          return { source: t?.source, sf: t?.selectiveFreeze, rs: t?.regionalSpeed, frame: s.timeline?.currentFrame };
        });
      };
      const results = { selectiveFreeze: 0, regionalSpeed: 0, findMoment: 0 };
      const fails = [];
      for (let i = 0; i < N; i++) {
        const r1 = await runOnce({ type: 'selectiveFreeze', clipId: 'clip_a1', startSeconds: 1, endSeconds: 4, mode: 'world-frozen' });
        if (r1.source && r1.source.endsWith('__freeze.mp4') && r1.sf && r1.sf.mode === 'world-frozen') results.selectiveFreeze++;
        else fails.push(['selectiveFreeze', i, r1]);

        const r2 = await runOnce({ type: 'regionalSpeed', clipId: 'clip_a1', startSeconds: 0, endSeconds: 3, speed: 0.35, region: '0,0,0.5,1' });
        if (r2.source && r2.source.endsWith('__rs.mp4') && r2.rs && r2.rs.speed === 0.35) results.regionalSpeed++;
        else fails.push(['regionalSpeed', i, r2]);

        await page.evaluate(() => window.__dividrTest.setStoreState({ timeline: { currentFrame: 0 } }));
        const r3 = await runOnce({ type: 'findMoment', clipId: 'clip_a1', target: 'car' });
        if (r3.frame === 90) results.findMoment++;
        else fails.push(['findMoment', i, r3]);
      }
      return { N, results, fails: fails.slice(0, 6) };
    },
  },

  {
    // MANUAL side, 30x: physically click the panel's buttons in the rendered React
    // app (main-process result mocked) and assert the store updates every time.
    name: 'nuanced-manual-ui',
    description: 'The right-panel manual controls (Apply freeze / region speed / Find) work 30/30 via real button clicks.',
    initialState: {
      tracks: [fakeVideoTrack({ id: 'clip_a1', source: 'C:/clips/test.mp4', previewUrl: '' })],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
      timeline: { currentFrame: 0, fps: 30, selectedTrackIds: ['clip_a1'] },
    },
    ops: [],
    waitMs: 200,
    interact: async (page) => {
      // Make sure the clip is selected so the panel renders.
      await page.evaluate(() => window.__dividrTest.setStoreState({ timeline: { selectedTrackIds: ['clip_a1'] } }));
      await page.waitForTimeout(600);
      const freezeBtn = page.locator('[data-testid="freeze-apply"]');
      const visible = await freezeBtn.isVisible().catch(() => false);
      if (!visible) return { error: 'manual panel not rendered (freeze-apply not visible)' };

      const snap = () => page.evaluate(() => {
        const s = window.__dividrTest.getStoreSnapshot();
        const t = s.tracks.find((x) => x.id === 'clip_a1');
        return { source: t?.source, sf: t?.selectiveFreeze, rs: t?.regionalSpeed, frame: s.timeline?.currentFrame };
      });
      const drain = async () => { await page.evaluate(() => window.__dividrTest.waitForQueueDrained()); await page.waitForTimeout(60); };

      const N = 30;
      const res = { freeze: 0, regional: 0, find: 0 };
      const fails = [];
      for (let i = 0; i < N; i++) {
        // Freeze
        await freezeBtn.click({ timeout: 8000 }).catch(() => {});
        await drain();
        let r = await snap();
        if (r.source?.endsWith('__freeze.mp4') && r.sf) res.freeze++; else fails.push(['freeze', i, r]);

        // Region speed
        await page.locator('[data-testid="regional-apply"]').click({ timeout: 8000 }).catch(() => {});
        await drain();
        r = await snap();
        if (r.source?.endsWith('__rs.mp4') && r.rs) res.regional++; else fails.push(['regional', i, r]);

        // Find
        await page.evaluate(() => window.__dividrTest.setStoreState({ timeline: { currentFrame: 0 } }));
        await page.locator('[data-testid="find-input"]').fill('car').catch(() => {});
        await page.locator('[data-testid="find-apply"]').click({ timeout: 8000 }).catch(() => {});
        await drain();
        r = await snap();
        if (r.frame === 90) res.find++; else fails.push(['find', i, r]);
      }
      return { N, res, fails: fails.slice(0, 6) };
    },
  },

  {
    name: 'transition-showcase',
    description: 'Render the dramatic transitions (dip-to-white, zoom, push) on real clips (war -> nuclear) at mid-transition to see which lands hardest and that they actually work.',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'A', name: 'war', source: `${SEKOND_BROLL_DIR}/web-ready/1st broll.mp4`, previewUrl: `${SEKOND_BROLL_DIR}/web-ready/1st broll.mp4`, startFrame: 0, endFrame: 90, duration: 90, sourceStartTime: 0, trackRowIndex: 0 }),
        fakeVideoTrack({ id: 'B', name: 'nuclear', source: `${SEKOND_BROLL_DIR}/web-ready/2nd b-roll.mp4`, previewUrl: `${SEKOND_BROLL_DIR}/web-ready/2nd b-roll.mp4`, startFrame: 90, endFrame: 180, duration: 90, sourceStartTime: 2, trackRowIndex: 0 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [],
    waitMs: 1500,
    interact: async (page, { outDir }) => {
      const canvas = page.locator('[data-testid="preview-canvas"]');
      const apply = (ops) => page.evaluate((o) => window.__dividrTest.applyOps(o), ops);
      const seek = async (f) => {
        await page.evaluate((x) => window.__dividrTest.setStoreState({ timeline: { currentFrame: x } }), f);
        await page.evaluate(() => window.__dividrTest.ping());
        await page.waitForTimeout(2200);
      };
      const shot = async (label) => { await canvas.screenshot({ path: `${outDir}/${label}.png` }).catch(() => {}); };
      const cases = [
        { type: 'dip', color: 'white', frame: 61, label: 'showcase-dip-white' },
        { type: 'zoom', frame: 67, label: 'showcase-zoom' },
        { type: 'push', direction: 'left', frame: 67, label: 'showcase-push' },
      ];
      for (const c of cases) {
        await apply([{ type: 'addTransition', fromClipId: 'A', toClipId: 'B', transitionType: c.type, color: c.color, direction: c.direction, durationSeconds: 1.5 }]);
        await page.waitForTimeout(400);
        await seek(c.frame);
        await shot(c.label);
        await apply([{ type: 'removeTransition', fromClipId: 'A', toClipId: 'B' }]);
        await page.waitForTimeout(300);
      }
      return { rendered: cases.map((c) => c.label) };
    },
  },

  {
    name: 'sekond-broll-render',
    description:
      'Each placed b-roll must actually DECODE + paint on the canvas through the real media-server load path. b1/b2 use the transcoded H.264 (was ProRes/black); 3-5 are the originals.',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'base01', name: 'base', startFrame: 0, endFrame: 1522, duration: 1522, trackRowIndex: 0 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/web-ready/1st broll.mp4`, from: 0.0, to: 5.5 },
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/web-ready/2nd b-roll.mp4`, from: 8.8, to: 11.9 },
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/3rd b-roll john mearsheimer.mp4`, from: 14.2, to: 17.9 },
    ],
    waitMs: 2000,
    interact: async (page, { outDir }) => {
      const canvas = page.locator('[data-testid="preview-canvas"]');
      const checks = [];
      const probe = async (label, frame) => {
        await page.evaluate((f) => window.__dividrTest.setStoreState({ timeline: { currentFrame: f } }), frame);
        await page.evaluate(() => window.__dividrTest.ping());
        await page.waitForTimeout(2500); // let the <video> seek + the compositor draw
        await canvas.screenshot({ path: `${outDir}/${label}.png` }).catch(() => {});
        // Sample the canvas for non-black, non-uniform content (proves a real frame painted)
        const stat = await page.evaluate(() => {
          const c = document.querySelector('[data-testid="preview-canvas"]');
          if (!c) return { ok: false, reason: 'no canvas' };
          try {
            const ctx = c.getContext('2d');
            const { data } = ctx.getImageData(0, 0, c.width, c.height);
            let nonBlack = 0; const seen = new Set();
            for (let i = 0; i < data.length; i += 4 * 997) {
              const r = data[i], g = data[i + 1], b = data[i + 2];
              if (r + g + b > 24) nonBlack++;
              seen.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
            }
            return { ok: nonBlack > 0 && seen.size > 3, nonBlack, distinctColors: seen.size };
          } catch (e) { return { ok: 'taint', reason: String(e).slice(0, 60) }; }
        });
        checks.push({ label, frame, ...stat });
      };
      await probe('render-b1-war', 60);        // 2.0s — b-roll 1 (was ProRes, now H.264)
      await probe('render-b2-nuclear', 300);    // 10.0s — b-roll 2 (was ProRes, now H.264)
      await probe('render-b3-mearsheimer', 480); // 16.0s — b-roll 3 (control, always worked)
      return checks;
    },
  },

  {
    name: 'sekond-broll-placement',
    description:
      'The 5 EDITH broll ops should create 5 muted overlays on layer 1 (trackRowIndex 1), in order, at the cue-sheet times — over the talking-heads base on layer 0',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'base01', name: 'THE TRUE 1 Minute Segment.mp4', startFrame: 0, endFrame: 1522, duration: 1522, trackRowIndex: 0 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/1st broll.mov`, from: 0.0, to: 5.5 },
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/2nd b-roll.mov`, from: 8.8, to: 11.9 },
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/3rd b-roll john mearsheimer.mp4`, from: 14.2, to: 17.9 },
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/Strategic vision b-roll 4.mp4`, from: 22.2, to: 23.6 },
      { type: 'broll', src: `${SEKOND_BROLL_DIR}/5th b-roll - brezinski .mp4`, from: 23.6, to: 29.7 },
    ],
    waitMs: 1500,
  },

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
    name: 'transition-connector',
    description: 'Two adjacent same-row clips with no transition should show a "+" connector at their boundary',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'clip_a1', startFrame: 0, endFrame: 90, duration: 90 }),
        fakeVideoTrack({ id: 'clip_b1', startFrame: 90, endFrame: 180, duration: 90 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [],
    waitMs: 500,
  },

  {
    name: 'match-cut',
    description: 'matchCut op should enable the ghost overlay (MATCH CUT label + ghosted target frame over the canvas)',
    initialState: {
      tracks: [fakeVideoTrack({ id: 'clip_a1', startFrame: 0, endFrame: 300, duration: 300 })],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'matchCut', clipId: 'clip_a1', atSeconds: 1.0, opacity: 0.5 },
    ],
    waitMs: 2000,
  },

  {
    name: 'add-transition-op',
    description: 'addTransition (explicit clips) stores a transition with durationFrames and does NOT move the clips',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'clip_a1', startFrame: 0, endFrame: 90, duration: 90 }),
        fakeVideoTrack({ id: 'clip_b1', startFrame: 90, endFrame: 180, duration: 90 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'addTransition', fromClipId: 'clip_a1', toClipId: 'clip_b1', transitionType: 'dissolve', durationSeconds: 1 },
    ],
    waitMs: 600,
  },

  {
    name: 'add-transition-autopick',
    description: 'addTransition with NO clip fields should auto-pick the leftmost adjacent cut',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'clip_a1', startFrame: 0, endFrame: 90, duration: 90 }),
        fakeVideoTrack({ id: 'clip_b1', startFrame: 90, endFrame: 180, duration: 90 }),
        fakeVideoTrack({ id: 'clip_c1', startFrame: 180, endFrame: 270, duration: 90 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'addTransition', transitionType: 'dissolve' },
    ],
    waitMs: 500,
  },

  {
    name: 'transition-slider-hover',
    description:
      'Hovering the transition badge ~1.5s reveals a DiviDr-styled Length slider that STAYS when the cursor moves onto it',
    initialState: {
      tracks: [
        fakeVideoTrack({ id: 'clip_a1', startFrame: 0, endFrame: 120, duration: 120 }),
        fakeVideoTrack({ id: 'clip_b1', startFrame: 120, endFrame: 240, duration: 120 }),
      ],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'addTransition', fromClipId: 'clip_a1', toClipId: 'clip_b1', transitionType: 'dissolve', durationSeconds: 1.5 },
    ],
    waitMs: 500,
    interact: async (page, { screenshot }) => {
      const badge = page.locator('[data-testid="transition-badge"]').first();
      await badge.waitFor({ state: 'visible', timeout: 5000 });
      // Hover the badge and wait past the 1.5s reveal delay.
      await badge.hover();
      await page.waitForTimeout(1750);
      const popover = page.locator('[data-testid="transition-length-popover"]');
      const appearedOnHover = await popover.isVisible().catch(() => false);
      await screenshot('slider-appeared');
      // Move the cursor UP onto the slider popover — it must NOT disappear.
      await popover.hover().catch(() => {});
      await page.waitForTimeout(500);
      const staysWhenMovedOnto = await popover.isVisible().catch(() => false);
      await screenshot('slider-after-move-onto-it');
      // Move fully away — it should hide after the grace period.
      await page.mouse.move(5, 5);
      await page.waitForTimeout(500);
      const hidesWhenLeft = !(await popover.isVisible().catch(() => false));
      return { appearedOnHover, staysWhenMovedOnto, hidesWhenLeft };
    },
  },

  {
    name: 'cross-dissolve',
    description: 'Two overlapping same-row clips at the overlap midpoint should blend (both ~50% opacity) — a cross dissolve',
    initialState: {
      tracks: [
        // Short clips so the overlap sits near the source start (fast seeks for the in-memory fixture)
        fakeVideoTrack({ id: 'clip_a1', startFrame: 0, endFrame: 90, duration: 90, sourceStartTime: 0 }),
        fakeVideoTrack({ id: 'clip_b1', startFrame: 60, endFrame: 150, duration: 90, sourceStartTime: 0 }),
      ],
      // Playhead at overlap midpoint (frame 75 of overlap [60,90]) → progress 0.5
      timeline: { currentFrame: 75 },
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [],
    waitMs: 3000,
  },

  {
    name: 'scene-detection',
    description: 'After detectScenes, the clip should carry 3 sceneMarkers and amber ticks should render on the timeline clip',
    initialState: {
      tracks: [fakeVideoTrack({ endFrame: 900, duration: 900 })],
      preview: { canvasWidth: 1920, canvasHeight: 1080 },
    },
    ops: [
      { type: 'detectScenes', clipId: 'clip_a1', threshold: 0.4 },
    ],
    waitMs: 800,
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
