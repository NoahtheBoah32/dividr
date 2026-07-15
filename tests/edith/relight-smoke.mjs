// Non-destructive live smoke test of the in-app relighter.
// Samples the current DiviDr preview frame READ-ONLY, runs the real relightGL module
// in an offscreen canvas at low + high intensity, and writes PNGs to eyeball the
// glazed-donut fix. Never mutates the user's store/project.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-SANGHIBLAYAN-WEBSITE/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const result = await page.evaluate(async () => {
  const out = { hasBase: false, baseW: 0, baseH: 0, moduleOk: false, glOk: false, err: '', frames: {} };
  try {
    // ---- source frame: real preview if present, else a synthetic dark "bedroom" plate
    const base = document.querySelector('canvas[data-testid="preview-canvas"]');
    let src = base;
    if (base && base.width > 4 && base.height > 4) {
      out.hasBase = true; out.baseW = base.width; out.baseH = base.height;
    } else {
      // synth: dark room + a warm lamp blob on the right + a mid-grey figure block
      const c = document.createElement('canvas'); c.width = 960; c.height = 540;
      const x = c.getContext('2d');
      x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, 960, 540);
      const lamp = x.createRadialGradient(760, 250, 10, 760, 250, 240);
      lamp.addColorStop(0, '#ffdca0'); lamp.addColorStop(0.4, '#5a4326'); lamp.addColorStop(1, '#0a0a0c');
      x.fillStyle = lamp; x.fillRect(0, 0, 960, 540);
      // a dark figure (near-black) — this is where a donut would show
      const fig = x.createRadialGradient(420, 300, 20, 420, 300, 180);
      fig.addColorStop(0, '#2a2622'); fig.addColorStop(1, '#111014');
      x.fillStyle = fig; x.beginPath(); x.ellipse(420, 300, 150, 190, 0, 0, 7); x.fill();
      src = c;
    }

    // ---- load the REAL module and run it
    let Relighter;
    try {
      const mod = await import('/src/frontend/features/editor/preview/utils/relightGL.ts');
      Relighter = mod.Relighter; out.moduleOk = true;
    } catch (e) { out.err = 'import: ' + (e?.message || e); return out; }

    const r = new Relighter();
    out.glOk = !!r.ok;
    if (!r.ok) { out.err = 'relighter not ok (no webgl / shader fail)'; return out; }

    const W = src.width, H = src.height;
    const cfgBase = {
      pos: [0.44, 0.5], height: 0.55, color: [255, 214, 160],
      ambient: 0.28, wrap: 0.5, form: 1.0, detail: 0.8, sheen: 0.4,
      rim: 0.5, spill: 0.6, neg: 0.25, radius: 0.95, mode: 'shape', engaged: true,
    };
    for (const [name, intensity] of [['low', 0.7], ['high', 2.3]]) {
      r.render(src, W, H, { ...cfgBase, intensity });
      out.frames[name] = r.canvas.toDataURL('image/png');
    }
    // also a passthrough check (engaged false must equal source)
    r.render(src, W, H, { ...cfgBase, intensity: 1, engaged: false });
    out.frames.passthrough = r.canvas.toDataURL('image/png');
    r.dispose();
  } catch (e) { out.err = 'outer: ' + (e?.message || e); }
  return out;
});

console.log('hasBase:', result.hasBase, `${result.baseW}x${result.baseH}`);
console.log('moduleOk:', result.moduleOk, '| glOk:', result.glOk);
if (result.err) console.log('ERR:', result.err);
for (const [name, uri] of Object.entries(result.frames || {})) {
  const buf = Buffer.from(uri.split(',')[1], 'base64');
  fs.writeFileSync(`${OUT}/relight-${name}.png`, buf);
  console.log('wrote', `relight-${name}.png`, `(${buf.length} bytes)`);
}
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 8).join('\n'));
else console.log('no console errors');
console.log(result.glOk && !result.err ? '=== RELIGHTER RUNS ===' : '=== CHECK FAILED ===');
process.exit(result.glOk && !result.err ? 0 : 3);
