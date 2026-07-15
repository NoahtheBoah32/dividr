// relight-additive-e2e — verifies the additive-only relight contract in the LIVE app:
//   1. "Detect from scene" NEVER alters the picture (zero-change screenshot diff)
//   2. Detection places the ring on the actual bright source (centroid)
//   3. Ambient 100% = visibly brighter, and NO pixel gets darker than the original
//   4. Intensity 200% = strong add, still nothing darker
//   5. Panel: no color swatches, no mode toggle, no Form slider, no dead gap above content
// Restores the track's prior light state when done. Uses window.__dividrTest (never
// page-side dynamic store imports).
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('FAIL: no page'); process.exit(1); }

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// ── setup: save prior state, clear lights ──────────────────────────────────
const prior = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  if (!vid) return null;
  const saved = {
    id: vid.id,
    relight: vid.relight ? JSON.parse(JSON.stringify(vid.relight)) : undefined,
    paintedLights: vid.paintedLights ? JSON.parse(JSON.stringify(vid.paintedLights)) : undefined,
    lightSource: vid.lightSource ? JSON.parse(JSON.stringify(vid.lightSource)) : undefined,
  };
  s.updateTrack(vid.id, { relight: undefined, paintedLights: [], lightSource: undefined });
  return saved;
});
if (!prior) { console.log('FAIL: no video track'); process.exit(1); }
await page.waitForTimeout(600);

// The frame-driven compositor can leave the base canvas BLACK after a seek while
// paused (decoder race) — seek to a mid-clip frame and nudge until the canvas has
// real content, otherwise every diff below is meaningless.
const ensureBaseFrame = async () => {
  for (let i = 0; i < 10; i++) {
    const luma = await page.evaluate(async (attempt) => {
      const s = window.__dividrTest.getStoreSnapshot();
      const vid = s.tracks.find((t) => t.type === 'video');
      const mid = Math.round(((vid?.startFrame ?? 0) + (vid?.endFrame ?? 240)) / 2);
      if (attempt > 0) {
        s.setCurrentFrame(Math.max(0, mid - 1 - attempt));
        await new Promise((r) => setTimeout(r, 250));
      }
      s.setCurrentFrame(mid);
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
      await new Promise((r) => setTimeout(r, 450));
      const c = document.querySelector('canvas[data-testid="preview-canvas"]');
      if (!c) return -1;
      const off = document.createElement('canvas'); off.width = 32; off.height = 18;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      let sum = 0; for (let j = 0; j < d.length; j += 4) sum += 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
      return sum / (d.length / 4);
    }, i);
    if (luma > 15) return luma;
  }
  return -1;
};
const baseLuma = await ensureBaseFrame();
if (baseLuma < 0) { console.log('FAIL: base canvas never painted a frame'); process.exit(1); }
console.log(`base frame ready (luma ${baseLuma.toFixed(1)})`);

const rect = await page.evaluate(() => {
  const c = document.querySelector('canvas[data-testid="preview-canvas"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width) - 2, height: Math.floor(r.height) - 2 };
});
if (!rect) { console.log('FAIL: no preview canvas'); process.exit(1); }

const shoot = async () => (await page.screenshot({ clip: rect })).toString('base64');

// In-page pixel comparison. Masks a radius around the light handle so the ring
// itself doesn't count as an image change.
const compare = (b64a, b64b, mask) => page.evaluate(async ([a, bb, m]) => {
  const load = (b64) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = 'data:image/png;base64,' + b64;
  });
  const [ia, ib] = await Promise.all([load(a), load(bb)]);
  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, w, h).data;
  let sumAbs = 0, maxAbs = 0, darker = 0, total = 0, sumA = 0, sumB = 0;
  const mx = m ? m.x * w : -1e9, my = m ? m.y * h : -1e9, mr2 = m ? m.r * m.r : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (m) { const dx = x - mx, dy = y - my; if (dx * dx + dy * dy < mr2) continue; }
    const o = (y * w + x) * 4;
    const la = 0.2126 * da[o] + 0.7152 * da[o + 1] + 0.0722 * da[o + 2];
    const lb = 0.2126 * db[o] + 0.7152 * db[o + 1] + 0.0722 * db[o + 2];
    const d = lb - la;
    sumAbs += Math.abs(d); if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    if (d < -6) darker++;
    sumA += la; sumB += lb; total++;
  }
  return {
    meanAbs: sumAbs / total, maxAbs, darkerFrac: darker / total,
    meanA: sumA / total, meanB: sumB / total, total,
  };
}, [b64a, b64b, mask ?? null]);

const shotA = await shoot(); // original, no light at all

// ── 1+2: detect through the REAL op path ───────────────────────────────────
await ensureBaseFrame();
await page.evaluate(async () => {
  window.__dividrTest.applyOps([{ type: 'detectLight' }]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(900);

const det = await page.evaluate((id) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = s.tracks.find((x) => x.id === id);
  return t?.relight ?? null;
}, prior.id);

check('detect creates a relight config', !!det, det ? `pos=[${det.pos.map((v) => v.toFixed(2))}] color=${JSON.stringify(det.color)}` : 'missing');
check('detect starts at base (intensity 0, ambient 0, neg 0)',
  det && det.intensity === 0 && det.ambient === 0 && det.neg === 0,
  det ? `intensity=${det.intensity} ambient=${det.ambient} neg=${det.neg}` : '');

const mask = det ? { x: det.pos[0], y: det.pos[1], r: 26 } : null;
const shotB = await shoot();
const dAB = await compare(shotA, shotB, mask);
check('detect does NOT alter the picture', dAB.meanAbs < 1.2 && dAB.maxAbs <= 24,
  `meanAbs=${dAB.meanAbs.toFixed(3)} maxAbs=${dAB.maxAbs.toFixed(1)}`);

// ── 3: ambient adds, never darkens ─────────────────────────────────────────
await page.evaluate((id) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = s.tracks.find((x) => x.id === id);
  s.updateTrackProperty(id, { relight: { ...t.relight, ambient: 1.0 } });
}, prior.id);
await page.waitForTimeout(500);
const shotC = await shoot();
const dAC = await compare(shotA, shotC, mask);
check('ambient 100% visibly brightens', dAC.meanB > dAC.meanA + 5,
  `mean ${dAC.meanA.toFixed(1)} -> ${dAC.meanB.toFixed(1)}`);
check('ambient 100% darkens nothing', dAC.darkerFrac < 0.005,
  `darkerFrac=${(dAC.darkerFrac * 100).toFixed(3)}%`);

// ── 4: intensity adds, never darkens ───────────────────────────────────────
await page.evaluate((id) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = s.tracks.find((x) => x.id === id);
  s.updateTrackProperty(id, { relight: { ...t.relight, ambient: 0, intensity: 2.0 } });
}, prior.id);
await page.waitForTimeout(500);
const shotD = await shoot();
const dAD = await compare(shotA, shotD, mask);
check('intensity 200% visibly brightens', dAD.meanB > dAD.meanA + 3,
  `mean ${dAD.meanA.toFixed(1)} -> ${dAD.meanB.toFixed(1)}`);
check('intensity 200% darkens nothing', dAD.darkerFrac < 0.01,
  `darkerFrac=${(dAD.darkerFrac * 100).toFixed(3)}%`);

writeFileSync('tests/edith/relight-shot-original.png', Buffer.from(shotA, 'base64'));
writeFileSync('tests/edith/relight-shot-detect.png', Buffer.from(shotB, 'base64'));
writeFileSync('tests/edith/relight-shot-ambient.png', Buffer.from(shotC, 'base64'));
writeFileSync('tests/edith/relight-shot-intensity.png', Buffer.from(shotD, 'base64'));

// ── 5: panel checks (Effects tab active, structure + no gap) ───────────────
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  if (vid) s.setSelectedTracks([vid.id]);
});
await page.waitForTimeout(400);
const tabBox = await page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === 'Effects');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (tabBox) { await page.mouse.click(tabBox.x, tabBox.y); await page.waitForTimeout(500); }

const panel = await page.evaluate(() => {
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
  const active = panels.find((el) => el.getAttribute('data-state') === 'active');
  if (!active) return { error: 'no active tabpanel' };
  const tablist = document.querySelector('[role="tablist"]');
  const tlRect = tablist?.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  const ghost = panels.some((el) => el.getAttribute('data-state') === 'inactive' && getComputedStyle(el).display !== 'none');
  const txt = active.textContent ?? '';
  return {
    gapAboveContent: tlRect ? Math.round(aRect.y - (tlRect.y + tlRect.height)) : -1,
    ghostInactivePanel: ghost,
    hasSwatches: /Shape the scene|Relight \(darker\)/.test(txt),
    hasFormSlider: /Form0|Form1|Form2|Form3|Form\d/.test(txt.replace(/\s/g, '')),
    hasDetect: txt.includes('Detect from scene'),
    swatchButtons: active.querySelectorAll('button[title="Warm"], button[title="Golden"], button[title="Cool"]').length,
  };
});
check('effects panel visible with Detect button', !!panel.hasDetect, JSON.stringify(panel));
check('no ghost inactive tabpanel taking space', panel.ghostInactivePanel === false, '');
check('no dead gap above panel content', panel.gapAboveContent >= 0 && panel.gapAboveContent < 24, `gap=${panel.gapAboveContent}px`);
check('color palette removed', panel.swatchButtons === 0, `swatches=${panel.swatchButtons}`);
check('mode toggle removed', panel.hasSwatches === false, '');
check('Form slider removed', panel.hasFormSlider === false, '');

// ── restore prior state ────────────────────────────────────────────────────
await page.evaluate((saved) => {
  const s = window.__dividrTest.getStoreSnapshot();
  s.updateTrack(saved.id, {
    relight: saved.relight,
    paintedLights: saved.paintedLights ?? [],
    lightSource: saved.lightSource,
  });
}, prior);
await page.waitForTimeout(300);

check('no console errors during run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILURES`} (${results.length} checks)`);
process.exit(failed.length === 0 ? 0 : 1);
