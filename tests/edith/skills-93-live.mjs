// Live verification for the 92-skill batch: J/K/L + I/O shortcuts, setClipColor,
// setCurves, applyLook, adjust.grain, stinger, beatSync.
// Runs in a DEDICATED test project (SKILLS-93-TEST) so user projects stay untouched;
// reopens the user's project at the end.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 0. Fresh bundle ──────────────────────────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(7000);

// After a reload the app can land on the picker — open the user's project via
// the bridge, read the video path from its library, then switch to the test project.
await page.evaluate(() => window.__dividrTest.openProjectByTitle('snow')).catch(() => {});
await page.waitForTimeout(3000);

// Remember the video source from the user's project (for the test import).
// Project restore is async — poll until the media library hydrates.
let videoPath = null;
for (let i = 0; i < 12 && !videoPath; i++) {
  videoPath = await page.evaluate(() => {
    const s = window.__dividrTest?.getStoreSnapshot?.();
    const vid = (s?.mediaLibrary ?? []).find((m) => m.type === 'video' && /snow/i.test(m.name));
    return vid?.source ?? (s?.mediaLibrary ?? []).find((m) => m.type === 'video')?.source ?? null;
  }).catch(() => null);
  if (!videoPath) await page.waitForTimeout(2500);
}
if (!videoPath) { console.log('no video in media library to test with'); process.exit(1); }
console.log('test video:', videoPath);

const userProjectTitle = await page.evaluate(() => {
  const s = window.__dividrTest?.getStoreSnapshot?.();
  return s?.projectTitle ?? s?.currentProject?.title ?? null;
});

// ── 1. Isolated test project ─────────────────────────────────────────────
const existing = await page.evaluate(async () => {
  const list = await window.__dividrTest.listProjects();
  return list.find((p) => p.title === 'SKILLS-93-TEST')?.id ?? null;
});
if (existing) {
  await page.evaluate((id) => window.__dividrTest.openProjectByTitle(id), existing);
} else {
  await page.evaluate(() => window.__dividrTest.createAndOpenProject('SKILLS-93-TEST'));
}
await page.waitForTimeout(4000);

// Clear any leftovers from a previous run, then import the video fresh
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  for (const t of [...(s.tracks ?? [])]) s.removeTrack?.(t.id) ?? s.deleteTrack?.(t.id);
  const tl = s.timeline?.timelineMarkers ?? [];
  for (const m of [...tl]) s.removeTimelineMarker?.(m.id);
});
await page.evaluate(async (src) => {
  window.__dividrTest.applyOps([
    { type: 'insertClip', src, trackType: 'video', startFrame: 0, inSeconds: 0, outSeconds: 45 },
  ]);
  await window.__dividrTest.waitForQueueDrained();
}, videoPath);
await page.waitForTimeout(3500);

const setup = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  return { hasVideo: !!v, name: v?.name, frames: v ? v.endFrame - v.startFrame : 0 };
});
check('setup: video imported into test project', setup.hasVideo, `${setup.name} (${setup.frames} frames)`);
if (!setup.hasVideo) process.exit(1);

// ── 2. J/K/L + I/O shortcuts ─────────────────────────────────────────────
await page.evaluate(() => {
  document.body.focus();
  const s = window.__dividrTest.getStoreSnapshot();
  s.setCurrentFrame(300);
  s.pause?.();
});
await page.waitForTimeout(300);

await page.keyboard.press('l');
await page.waitForTimeout(400);
let st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return { playing: s.playback.isPlaying, rate: s.playback.playbackRate };
});
check('L plays forward', st.playing && st.rate === 1, `rate ${st.rate}`);

await page.keyboard.press('l');
await page.waitForTimeout(200);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return { playing: s.playback.isPlaying, rate: s.playback.playbackRate };
});
check('L again shuttles 2x', st.playing && st.rate === 2, `rate ${st.rate}`);

await page.keyboard.press('k');
await page.waitForTimeout(200);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return { playing: s.playback.isPlaying, rate: s.playback.playbackRate };
});
check('K stops + resets rate', !st.playing && st.rate === 1, `rate ${st.rate}`);

const beforeJ = await page.evaluate(() => window.__dividrTest.getStoreSnapshot().timeline.currentFrame);
await page.keyboard.press('j');
await page.waitForTimeout(800);
const afterJ = await page.evaluate(() => window.__dividrTest.getStoreSnapshot().timeline.currentFrame);
await page.keyboard.press('k');
check('J shuttles backward', afterJ < beforeJ, `${beforeJ} → ${afterJ}`);

await page.evaluate(() => window.__dividrTest.getStoreSnapshot().setCurrentFrame(120));
await page.keyboard.press('i');
await page.waitForTimeout(150);
await page.evaluate(() => window.__dividrTest.getStoreSnapshot().setCurrentFrame(240));
await page.keyboard.press('o');
await page.waitForTimeout(150);
st = await page.evaluate(() => {
  const t = window.__dividrTest.getStoreSnapshot().timeline;
  return { inP: t.inPoint, outP: t.outPoint };
});
check('I/O set in/out points at playhead', st.inP === 120 && st.outP === 240, `in ${st.inP}, out ${st.outP}`);
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  s.setInPoint(undefined);
  s.setOutPoint(undefined);
});

// ── 3. setClipColor (Labels/Colors) ──────────────────────────────────────
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'setClipColor', color: 'teal' }]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(1500);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video' && t.labelColor)
    ?? s.tracks.find((t) => t.type === 'video');
  const body = document.querySelector(`[data-edith-target="track-body:${v.id}"]`);
  const stripe = body && Array.from(body.querySelectorAll('div')).find(
    (el) => el.style && el.style.height === '3px' && el.style.background,
  );
  return { labelColor: v.labelColor, stripeRendered: !!stripe };
});
check('setClipColor writes labelColor', st.labelColor === '#14b8a6', st.labelColor);
check('label stripe renders on the clip', st.stripeRendered);

// ── 4. setCurves (RGB Curves) ────────────────────────────────────────────
await page.evaluate(async () => {
  window.__dividrTest.applyOps([
    { type: 'setCurves', master: [[0, 0.18], [0.5, 0.5], [1, 0.88]] },
  ]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(800);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  const canvas = document.querySelector('canvas[data-testid="frame-compositor"], canvas');
  return {
    hasCurves: !!v.colorGrade?.curves,
    lutStart: v.colorGrade?.curves?.r?.[0],
    lutEnd: v.colorGrade?.curves?.r?.[255],
    filter: canvas?.style?.filter ?? '',
  };
});
check(
  'setCurves builds the 256-LUT',
  st.hasCurves && st.lutStart === Math.round(0.18 * 255) && st.lutEnd === Math.round(0.88 * 255),
  `lut[0]=${st.lutStart} lut[255]=${st.lutEnd}`,
);
check('curves drive the live SVG grade filter', st.filter.includes('dividr-grade'), st.filter);

// ── 5. applyLook (Filters/LUTs) — B&W is the most blatant ────────────────
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'applyLook', look: 'noir' }]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(900);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  const canvas = Array.from(document.querySelectorAll('canvas')).find((c) => c.style.filter.includes('dividr-grade'));
  return {
    look: v.colorGrade?.look,
    saturation: v.colorGrade?.saturation,
    grain: v.colorGrade?.grain,
    filter: canvas?.style?.filter ?? '',
    grainOverlay: !!document.getElementById('dividr-grain-overlay'),
  };
});
check('applyLook resolves "noir" → bw', st.look === 'bw', `look=${st.look}`);
check('bw look zeroes saturation', st.saturation === 0, `saturation=${st.saturation}`);
check('saturate(0) in the live filter', st.filter.includes('saturate(0)'), st.filter);
check('bw grain renders the animated overlay', st.grainOverlay, `grain=${st.grain}`);
await page.screenshot({ path: 'C:/tmp/skills93-bw-look.png' }).catch(() => {});

// ── 6. adjust.grain (Film Grain) ─────────────────────────────────────────
await page.evaluate(async () => {
  window.__dividrTest.applyOps([
    { type: 'adjust', reset: true },
    { type: 'adjust', grain: 60 },
  ]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(700);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  const ovl = document.getElementById('dividr-grain-overlay');
  return {
    grain: v.colorGrade?.grain,
    curvesSurvived: !!v.colorGrade?.curves, // reset keeps extracted curves by design
    overlayOpacity: ovl ? parseFloat(ovl.style.opacity) : null,
    animated: ovl ? ovl.style.animation.includes('dividr-grain-jitter') : false,
  };
});
check('adjust.grain=60 stored', st.grain === 60);
check(
  'grain overlay visible + animated',
  st.overlayOpacity !== null && st.overlayOpacity > 0.3 && st.animated,
  `opacity ${st.overlayOpacity}`,
);
await page.screenshot({ path: 'C:/tmp/skills93-grain.png' }).catch(() => {});

// ── 7. stinger ───────────────────────────────────────────────────────────
// Fresh projects have an empty SFX cache (the scan normally runs when the
// EDITH panel opens) — refresh it the way the app does.
await page.evaluate(() => window.__dividrTest.refreshSfxLibrary());
await page.waitForTimeout(500);
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'stinger', atSeconds: 2 }]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(1200);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const fps = s.timeline?.fps ?? 30;
  const sting = s.tracks.find((t) => t.type === 'audio' && /stinger/i.test(t.name));
  return sting
    ? { found: true, name: sting.name, atSec: sting.startFrame / fps, color: sting.color, row: sting.trackRowIndex }
    : { found: false };
});
check('stinger places a hit on the SFX row', st.found && Math.abs(st.atSec - 2) < 0.1 && st.row === 1,
  st.found ? `${st.name} @ ${st.atSec}s row ${st.row} ${st.color}` : 'not found');

// ── 8. beatSync (falls back to main video's audio) ───────────────────────
const markersBefore = await page.evaluate(() =>
  (window.__dividrTest.getStoreSnapshot().timeline?.timelineMarkers ?? []).length);
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'beatSync', sensitivity: 4, maxMarkers: 25 }]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(1500);
st = await page.evaluate(() => {
  const tl = window.__dividrTest.getStoreSnapshot().timeline;
  const beats = (tl?.timelineMarkers ?? []).filter((m) => /^Beat /.test(m.label));
  const errs = (window.__dividrTest.getOpQueue?.() ?? []).filter((q) => q.status === 'failed');
  return { total: (tl?.timelineMarkers ?? []).length, beats: beats.length, first: beats[0]?.label, gold: beats.every((m) => m.color === '#E6A412'), errs };
});
check('beatSync drops gold beat markers', st.beats > 0 && st.gold, `${st.beats} beats (was ${markersBefore} markers)${st.errs.length ? ' | op errors: ' + JSON.stringify(st.errs) : ''}`);
await page.screenshot({ path: 'C:/tmp/skills93-beats.png' }).catch(() => {});

// ── 9. Swatch UI (Labels/Colors panel) ───────────────────────────────────
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  s.setSelectedTracks([v.id]);
});
await page.waitForTimeout(900);
const swatchOk = await page.evaluate(() => {
  const btn = document.querySelector('[aria-label="Label purple"]');
  if (!btn) return { present: false };
  btn.click();
  return { present: true };
});
await page.waitForTimeout(500);
st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  s.setSelectedTracks([]);
  return { labelColor: v.labelColor };
});
check('swatch row present in properties panel', swatchOk.present);
check('clicking a swatch labels the clip', st.labelColor === '#a855f7', st.labelColor);
await page.screenshot({ path: 'C:/tmp/skills93-final.png' }).catch(() => {});

// ── 10. Back to the user's project ───────────────────────────────────────
if (userProjectTitle) {
  await page.evaluate((t) => window.__dividrTest.openProjectByTitle(t), userProjectTitle);
  await page.waitForTimeout(3000);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
