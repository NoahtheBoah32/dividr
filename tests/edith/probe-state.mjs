// Final sanity: project tracks + media transcription back to original.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }
const r = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const media = s.mediaLibrary.find((m) => m.type === 'video');
  return {
    tracks: s.tracks.map((t) => ({
      type: t.type, row: t.trackRowIndex ?? 0, sf: t.startFrame, ef: t.endFrame,
      markers: (t.sfxMarkers ?? []).length,
    })),
    karaoke: media?.cachedKaraokeSubtitles ? 'present' : 'none',
  };
});
console.log(JSON.stringify(r, null, 1));
process.exit(0);
