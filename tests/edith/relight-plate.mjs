// Validate the real relightGL module on the actual bedroom plate (real dark footage
// with an existing practical lamp). Loads the PNG into the renderer, runs the module at
// low + high intensity, in both modes, and writes PNGs. Non-destructive (no store writes).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-SANGHIBLAYAN-WEBSITE/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const PLATE = 'C:/tmp/pastes/shot_20260708142241458.png';
const dataUri = 'data:image/png;base64,' + fs.readFileSync(PLATE).toString('base64');

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

const result = await page.evaluate(async (uri) => {
  const out = { moduleOk: false, glOk: false, err: '', frames: {} };
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img load')); img.src = uri; });
    // downscale to a realistic preview size (long edge ~900) so it mirrors the editor
    const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
    const src = document.createElement('canvas'); src.width = W; src.height = H;
    src.getContext('2d').drawImage(img, 0, 0, W, H);

    let Relighter;
    try { Relighter = (await import('/src/frontend/features/editor/preview/utils/relightGL.ts')).Relighter; out.moduleOk = true; }
    catch (e) { out.err = 'import: ' + (e?.message || e); return out; }

    const r = new Relighter();
    out.glOk = !!r.ok;
    if (!r.ok) { out.err = 'relighter not ok'; return out; }

    // place the key on the LEFT (the figure), opposite the existing lamp on the right
    const cfg = {
      pos: [0.4, 0.42], height: 0.55, color: [255, 210, 155],
      ambient: 0.26, wrap: 0.5, form: 0.45, detail: 1.0, sheen: 0.35,
      rim: 0.4, spill: 0.4, neg: 0.25, radius: 0.95, mode: 'shape', engaged: true,
    };
    const shots = [
      ['orig', { ...cfg, engaged: false }],
      ['shape-low', { ...cfg, intensity: 0.7 }],
      ['shape-high', { ...cfg, intensity: 2.3 }],       // <- the glazed-donut test
      ['faux-mid', { ...cfg, intensity: 1.4, mode: 'faux', ambient: 0.16 }],
    ];
    for (const [name, c] of shots) { r.render(src, W, H, c); out.frames[name] = r.canvas.toDataURL('image/png'); }
    r.dispose();
  } catch (e) { out.err = 'outer: ' + (e?.message || e); }
  return out;
}, dataUri);

console.log('moduleOk:', result.moduleOk, '| glOk:', result.glOk);
if (result.err) console.log('ERR:', result.err);
for (const [name, uri] of Object.entries(result.frames || {})) {
  const buf = Buffer.from(uri.split(',')[1], 'base64');
  fs.writeFileSync(`${OUT}/plate-${name}.png`, buf);
  console.log('wrote', `plate-${name}.png`, `(${buf.length} bytes)`);
}
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.slice(0, 6).join('\n') : 'no console errors');
process.exit(result.glOk && !result.err ? 0 : 3);
