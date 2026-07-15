// Clip-drop accuracy e2e — verifies the exact bug Joaquin reported:
// a clip trimmed + placed at a KNOWN timeline window must drop into the chat
// as a CARD whose times match the ruler EXACTLY (not the mid-drag position),
// and the clip must snap back to its origin. Then the message goes through the
// REAL EDITH and she must target that clip with the right source window.
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
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

for (let i = 0; i < 12; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);

// ── Arrange: fresh import — clip trimmed to source 10s..16s, PLACED at 20s ──
const FPS = 30;
const srcPath = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video') ?? s.mediaLibrary.find((m) => m.type === 'video');
  const raw = v?.originalSource ?? v?.source;
  return raw && !/rackfocus_/.test(raw) ? raw : (v?.originalSource ?? raw);
});
if (!srcPath) { console.log('no source video available'); process.exit(1); }
const arranged = await page.evaluate(async ({ src, fps }) => {
  const s = window.__dividrTest.getStoreSnapshot();
  for (const t of [...s.tracks]) s.removeTrack?.(t.id) ?? s.deleteTrack?.(t.id);
  for (const m of [...(s.timeline?.timelineMarkers ?? [])]) s.removeTimelineMarker?.(m.id);
  window.__dividrTest.applyOps([
    { type: 'insertClip', src, trackType: 'video', startFrame: 20 * fps, inSeconds: 10, outSeconds: 16 },
  ]);
  await window.__dividrTest.waitForQueueDrained();
  await new Promise((r) => setTimeout(r, 2500));
  const fresh = window.__dividrTest.getStoreSnapshot().tracks.find((t) => t.type === 'video');
  return fresh ? { id: fresh.id, startFrame: fresh.startFrame, endFrame: fresh.endFrame, sst: fresh.sourceStartTime } : null;
}, { src: srcPath, fps: FPS });
if (!arranged) { console.log('arrange failed'); process.exit(1); }
check(
  'arrange: clip at timeline 20s–26s (source 10s–16s)',
  arranged.startFrame === 600 && arranged.endFrame === 780 && arranged.sst === 10,
  JSON.stringify(arranged),
);

// EDITH panel + consent
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await page.waitForTimeout(2200);
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Agree')?.click();
}).catch(() => {});
await page.waitForTimeout(1200);

// ── Act: real mouse drag from the clip into the chat input ────────────────
const geo = await page.evaluate((clipId) => {
  const clip = document.querySelector(`[data-edith-target="track-body:${clipId}"]`);
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  if (!clip || !ta) return { ok: false, clip: !!clip, input: !!ta };
  const cr = clip.getBoundingClientRect();
  const ir = ta.getBoundingClientRect();
  return { ok: true, cx: cr.x + Math.min(50, cr.width / 2), cy: cr.y + cr.height / 2, ix: ir.x + ir.width / 2, iy: ir.y + ir.height / 2 };
}, arranged.id);
check('drag geometry resolved', geo.ok, JSON.stringify(geo));
if (!geo.ok) process.exit(1);

await page.mouse.move(geo.cx, geo.cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(geo.cx + ((geo.ix - geo.cx) * i) / 10, geo.cy + ((geo.iy - geo.cy) * i) / 10, { steps: 3 });
  await page.waitForTimeout(60);
}
await page.mouse.up();
await page.waitForTimeout(900);

// ── Assert: card present, times EXACT, textarea clean, clip snapped back ──
let st = await page.evaluate((clipId) => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  const cardTimes = Array.from(document.querySelectorAll('p'))
    .map((p) => p.textContent ?? '')
    .find((t) => /on timeline/.test(t)) ?? null;
  const durationPill = Array.from(document.querySelectorAll('span'))
    .map((sp) => sp.textContent ?? '')
    .find((t) => /^\d+(\.\d+)?s$/.test(t.trim())) ?? null;
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.id === clipId);
  return {
    inputValue: ta?.value ?? '',
    cardTimes,
    durationPill,
    clipStart: v.startFrame,
    clipEnd: v.endFrame,
  };
}, arranged.id);
check('card shows EXACT timeline times', st.cardTimes === '20s – 26s on timeline', String(st.cardTimes));
check('duration pill reads 6.0s', (st.durationPill ?? '').trim() === '6.0s', String(st.durationPill));
check('input box stays clean (no raw token text)', !st.inputValue.includes('[clip'), st.inputValue.slice(0, 40));
check('clip snapped back to 20s–26s', st.clipStart === 600 && st.clipEnd === 780, `frames ${st.clipStart}-${st.clipEnd}`);
await page.screenshot({ path: 'C:/tmp/clipcard.png' }).catch(() => {});

// ── Act 2: send "apply a rack focus to this clip" through the REAL EDITH ──
console.log('sending to real EDITH (bake ~1-2 min)…');
await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'apply a rack focus to this clip');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
await page.locator('textarea[placeholder*="reels" i]').press('Enter');

// wait for the bake to land: source swaps to rackfocus_*.mp4
let baked = null;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  baked = await page.evaluate((clipId) => {
    const s = window.__dividrTest.getStoreSnapshot();
    const v = s.tracks.find((t) => t.id === clipId);
    if (!/rackfocus_\d+/.test(v?.source ?? '')) return null;
    return { source: v.source, meta: v.rackFocus, startFrame: v.startFrame, endFrame: v.endFrame };
  }, arranged.id).catch(() => null);
  if (baked) break;
  await page.waitForTimeout(4000);
}
check('EDITH read the card token and baked rack focus', !!baked, baked ? baked.source.split(/[\\/]/).pop() : 'timed out');
if (baked) {
  // The clip's own trimmed source window is 10s..16s — the bake region must match it.
  check(
    'bake region matches the clip\'s own source window (10s–16s)',
    Math.abs(baked.meta.start - 10) < 0.6 && Math.abs(baked.meta.end - 16) < 0.6,
    `region ${baked.meta.start}s-${baked.meta.end}s`,
  );
  check('clip position untouched by the bake', baked.startFrame === 600 && baked.endFrame === 780);
}

// card should be consumed by the send
st = await page.evaluate(() => ({
  cardGone: !Array.from(document.querySelectorAll('p')).some((p) => /on timeline/.test(p.textContent ?? '')),
}));
check('card consumed after sending', st.cardGone);

await page.screenshot({ path: 'C:/tmp/clipcard-after.png' }).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
