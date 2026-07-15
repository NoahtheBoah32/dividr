// Rack focus e2e: op-level bake (depth model → source swap), preview proof
// screenshots, and the drag-a-clip-into-the-chatbar token. Runs in the
// SKILLS-93-TEST project; user projects untouched.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }
page.setDefaultTimeout(30000);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// bridge may need a beat after a cold boot
for (let i = 0; i < 10; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2000);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4000);

// Neutral canvas: clear the grade left over from the skills suite
await page.evaluate(async () => {
  window.__dividrTest.applyOps([
    { type: 'adjust', reset: true },
    { type: 'setCurves', reset: true },
  ]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(800);

const before = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  return v ? { id: v.id, source: v.source, startFrame: v.startFrame } : null;
});
if (!before) { console.log('no video clip in test project'); process.exit(1); }

// ── 1. rackFocus op — bake over source seconds 2..8 ─────────────────────
console.log('racking focus (depth model runs per frame — this takes ~1 min)…');
await page.evaluate(async () => {
  window.__dividrTest.applyOps([
    { type: 'rackFocus', startSeconds: 2, endSeconds: 8, direction: 'near-to-far' },
  ]);
  await window.__dividrTest.waitForQueueDrained();
});

let st = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  const errs = (window.__dividrTest.getOpQueue?.() ?? []).filter((q) => q.status === 'failed');
  return {
    source: v.source,
    meta: v.rackFocus ?? null,
    original: v.originalSource ?? null,
    startFrame: v.startFrame,
    errs,
  };
});
check(
  'rackFocus bakes + swaps the clip source',
  /rackfocus_\d+/.test(st.source) && !!st.meta && st.errs.length === 0,
  st.errs.length ? JSON.stringify(st.errs) : `${st.source.split(/[\\/]/).pop()} meta=${JSON.stringify(st.meta)}`,
);
check('originalSource spine preserved', !!st.original && !/rackfocus_/.test(st.original));
check('clip did not move', st.startFrame === before.startFrame, `frame ${st.startFrame}`);

// ── 2. Preview proof: sharp-subject start vs melted-subject end ─────────
const fps = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  return s.timeline?.fps ?? 30;
});
await page.evaluate((f) => window.__dividrTest.getStoreSnapshot().setCurrentFrame(f), Math.round(2.4 * fps));
await page.waitForTimeout(1800);
await page.screenshot({ path: 'C:/tmp/rf-app-start.png' }).catch(() => {});
await page.evaluate((f) => window.__dividrTest.getStoreSnapshot().setCurrentFrame(f), Math.round(7.6 * fps));
await page.waitForTimeout(1800);
await page.screenshot({ path: 'C:/tmp/rf-app-end.png' }).catch(() => {});
console.log('preview screenshots: C:/tmp/rf-app-start.png / rf-app-end.png');

// ── 3. Drag a timeline clip INTO the chatbar ────────────────────────────
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await page.waitForTimeout(2500);
// First open shows the consent dialog — agree so the chat input mounts.
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => x.textContent?.trim() === 'Agree')?.click();
}).catch(() => {});
await page.waitForTimeout(1500);

const geo = await page.evaluate((clipId) => {
  const clip = document.querySelector(`[data-edith-target="track-body:${clipId}"]`);
  const inputBox = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  if (!clip || !inputBox) return { ok: false, clip: !!clip, input: !!inputBox };
  const cr = clip.getBoundingClientRect();
  const ir = inputBox.getBoundingClientRect();
  return {
    ok: true,
    cx: cr.x + Math.min(60, cr.width / 2), cy: cr.y + cr.height / 2,
    ix: ir.x + ir.width / 2, iy: ir.y + ir.height / 2,
  };
}, before.id);
check('drag geometry resolved (clip + chat input visible)', geo.ok, JSON.stringify(geo));

if (geo.ok) {
  await page.mouse.move(geo.cx, geo.cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(
      geo.cx + ((geo.ix - geo.cx) * i) / 10,
      geo.cy + ((geo.iy - geo.cy) * i) / 10,
      { steps: 3 },
    );
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(800);

  st = await page.evaluate(() => {
    const inputBox = Array.from(document.querySelectorAll('textarea'))
      .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
    const s = window.__dividrTest.getStoreSnapshot();
    const v = s.tracks.find((t) => t.type === 'video');
    return {
      value: inputBox?.value ?? '',
      clipStart: v.startFrame,
      ghost: s.playback.dragGhost,
    };
  });
  const tokenOk = /\[clip ".+" id:.+ at [\d.]+s-[\d.]+s on the timeline\]/.test(st.value);
  check('drop inserts the clip token into the chat input', tokenOk, st.value.slice(0, 90));
  check('clip stays in place after the chat drop', st.clipStart === before.startFrame);
  check('drag ghost cleaned up', !st.ghost);
  await page.screenshot({ path: 'C:/tmp/rf-chatdrop.png' }).catch(() => {});

  // clear the input so nothing stray gets sent later
  await page.evaluate(() => {
    const inputBox = Array.from(document.querySelectorAll('textarea'))
      .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
    if (!inputBox) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(inputBox, '');
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
