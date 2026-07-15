// Read-only probe of the live app: screenshot the current window and dump the store's
// tracks + media so we can confirm the stuck-"Added" recovery without mutating anything.
import { chromium } from 'playwright-core';
const OUT = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Documents-SANGHIBLAYAN-WEBSITE/4b42243e-b537-438d-b50a-750efc6019b4/scratchpad';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) {
    const u = p.url();
    if (u.includes('localhost:5173') && !u.startsWith('blob:') && !u.startsWith('devtools:')) page = p;
  }
if (!page) { console.log('NO_RENDERER'); process.exit(1); }

await page.screenshot({ path: `${OUT}/media-probe.png` }).catch((e) => console.log('shot err', e.message));

// Try the test bridge if present; otherwise best-effort read of any exposed store.
const info = await page.evaluate(() => {
  const out = { bridge: false, tracks: [], media: [] };
  try {
    const snap = window.__dividrTest?.getStoreSnapshot?.();
    if (snap) {
      out.bridge = true;
      out.tracks = (snap.tracks || []).map((t) => ({
        id: t.id, type: t.type, source: (t.source || '').split(/[\\/]/).pop(),
        start: t.startFrame, end: t.endFrame, len: (t.endFrame ?? 0) - (t.startFrame ?? 0),
      }));
      out.media = (snap.mediaLibrary || []).map((m) => ({
        id: m.id, name: (m.name || '').slice(0, 22), duration: m.duration,
      }));
    }
  } catch (e) { out.err = String(e); }
  return out;
});
console.log('bridge:', info.bridge);
if (info.bridge) {
  console.log('TRACKS:', JSON.stringify(info.tracks, null, 0));
  console.log('MEDIA:', JSON.stringify(info.media, null, 0));
  const broken = info.tracks.filter((t) => !(Number.isFinite(t.len) && t.len > 0));
  console.log('broken(zero/NaN-length) tracks:', broken.length, JSON.stringify(broken));
} else {
  console.log('no test bridge in this (non-test) session — see screenshot media-probe.png');
}
console.log('wrote media-probe.png');
process.exit(0);
