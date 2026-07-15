// End-to-end relight verification in the LIVE app (via window.__dividrTest bridge —
// dynamic import of the store gets a DIFFERENT Vite module instance, the bridge is
// bound to the real one):
//  1. enable relight on the current video track (restored afterward)
//  2. assert the drag handle exists in its elevated layer and actually WINS the
//     pointer at its center (elementFromPoint), i.e. the selection layer no longer eats it
//  3. real mouse drag on the handle -> store pos must change
//  4. Ctrl+Shift+drag anywhere on the preview -> store pos must change again
//  5. slider live-change (intensity low vs high) -> screenshot pixels must differ
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-SANGHIBLAYAN-WEBSITE/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) {
    const u = p.url();
    if (u.includes('localhost:5173') && !u.startsWith('blob:') && !u.startsWith('devtools:')) page = p;
  }
if (!page) { console.log('NO_RENDERER'); process.exit(1); }
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const fail = (msg) => { console.log('FAIL:', msg); process.exit(3); };

// -- setup: enable relight on the video track through the app's real store -----
const setup = await page.evaluate(() => {
  const s = window.__dividrTest?.getStoreSnapshot?.();
  if (!s) return { ok: false, why: 'no test bridge' };
  const vid = s.tracks.find((t) => t.type === 'video');
  if (!vid) return { ok: false, why: 'no video track' };
  const hadRelight = vid.relight ? JSON.parse(JSON.stringify(vid.relight)) : null;
  const cfg = {
    enabled: true, intensity: 1.2, ambient: 0.26, wrap: 0.5, form: 0.45,
    detail: 1.0, sheen: 0.35, rim: 0.4, spill: 0.4, neg: 0.25, radius: 0.95,
    height: 0.55, pos: [0.5, 0.42], color: [255, 224, 170], mode: 'shape',
  };
  s.updateTrack(vid.id, { relight: cfg });
  window.__relightTest = { trackId: vid.id, hadRelight };
  return { ok: true, trackId: vid.id, hadRelight: !!hadRelight };
});
if (!setup.ok) fail('setup: ' + setup.why);
console.log('setup ok — relight enabled on', setup.trackId, '| pre-existing relight:', setup.hadRelight);
await page.waitForTimeout(600); // let the overlay mount + first renders happen

// -- 2: handle exists, elevated, and wins the pointer ---------------------------
const hit = await page.evaluate(() => {
  const h = document.querySelector('[title^="Drag to move the light"]');
  if (!h) return { ok: false, why: 'handle not in DOM' };
  const r = h.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const layerZ = getComputedStyle(h.parentElement).zIndex;
  const at = document.elementFromPoint(cx, cy);
  return {
    ok: at === h,
    layerZ,
    cx, cy,
    atDesc: at ? `${at.tagName}.${(at.className || '').toString().slice(0, 40)} title=${at.getAttribute?.('title') || ''}` : 'null',
  };
});
console.log('handle layer zIndex:', hit.layerZ, '| elementFromPoint hits handle:', hit.ok, hit.ok ? '' : `(got ${hit.atDesc})`);
if (!hit.ok) fail('handle does not win the pointer: ' + (hit.why || hit.atDesc));
if (hit.layerZ !== '60002') fail('handle layer zIndex is ' + hit.layerZ + ' (HMR may not have applied — reload needed)');

const readPos = () => page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = s.tracks.find((x) => x.id === window.__relightTest.trackId);
  return t?.relight?.pos ?? null;
});

// -- 3: real mouse drag on the handle ------------------------------------------
const posBefore = await readPos();
await page.mouse.move(hit.cx, hit.cy);
await page.mouse.down();
await page.mouse.move(hit.cx + 80, hit.cy + 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const posAfterDrag = await readPos();
const moved = posBefore && posAfterDrag && (Math.abs(posAfterDrag[0] - posBefore[0]) > 0.01 || Math.abs(posAfterDrag[1] - posBefore[1]) > 0.01);
console.log('handle drag: pos', JSON.stringify(posBefore), '->', JSON.stringify(posAfterDrag), '| moved:', !!moved);
if (!moved) fail('handle drag did not commit a new light position');

// -- 4: Ctrl+Shift+drag anywhere on the preview ---------------------------------
const box = await page.evaluate(() => {
  const c = document.querySelector('canvas[data-testid="preview-canvas"]');
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
const sx = box.x + box.w * 0.25, sy = box.y + box.h * 0.6;
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.mouse.move(sx, sy);
await page.mouse.down();
await page.mouse.move(sx + box.w * 0.3, sy - box.h * 0.15, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await page.waitForTimeout(250);
const posAfterCsDrag = await readPos();
const csMoved = posAfterCsDrag && (Math.abs(posAfterCsDrag[0] - posAfterDrag[0]) > 0.01 || Math.abs(posAfterCsDrag[1] - posAfterDrag[1]) > 0.01);
console.log('ctrl+shift drag: pos', JSON.stringify(posAfterDrag), '->', JSON.stringify(posAfterCsDrag), '| moved:', !!csMoved);
if (!csMoved) fail('ctrl+shift+drag did not move the light');

// -- 5: sliders visibly change the preview --------------------------------------
async function shotAt(intensity, name) {
  await page.evaluate((i) => {
    const s = window.__dividrTest.getStoreSnapshot();
    const t = s.tracks.find((x) => x.id === window.__relightTest.trackId);
    s.updateTrackProperty(t.id, { relight: { ...t.relight, intensity: i } });
  }, intensity);
  await page.waitForTimeout(350);
  const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  fs.writeFileSync(`${OUT}/${name}.png`, buf);
  return buf;
}
const lowBuf = await shotAt(0.05, 'e2e-low');
const highBuf = await shotAt(2.3, 'e2e-high');
let diff = 0;
const n = Math.min(lowBuf.length, highBuf.length);
for (let i = 0; i < n; i += 97) if (lowBuf[i] !== highBuf[i]) diff++;
console.log(`slider visibility: sampled-byte diffs low-vs-high = ${diff} (need > 50)`);
if (diff <= 50) fail('intensity slider produced no visible change in the preview');

// -- restore original state ------------------------------------------------------
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const { trackId, hadRelight } = window.__relightTest;
  s.updateTrack(trackId, { relight: hadRelight ?? undefined });
  delete window.__relightTest;
});
console.log('restored original relight state');
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 6).join('\n') : 'no console errors');
console.log('ALL RELIGHT E2E CHECKS PASSED');
process.exit(0);
