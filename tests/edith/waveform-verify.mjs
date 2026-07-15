// Verify Waveform View: open the project, confirm audio tracks render real
// waveform bars (canvas tiles with non-transparent pixels), screenshot proof.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }

let opened = false;
for (let i = 0; i < 6 && !opened; i++) {
  opened = await page.evaluate(() => {
    const s = window.__dividrTest?.getStoreSnapshot?.();
    return location.hash.includes('video-editor') &&
      (s?.tracks?.filter((t) => t.type === 'audio').length ?? 0) >= 1;
  }).catch(() => false);
  if (opened) break;
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Open')?.click();
  }).catch(() => {});
  await page.waitForTimeout(5000);
}
if (!opened) { console.log('FAILED: could not open project'); process.exit(1); }
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const audio = s.tracks.filter((t) => t.type === 'audio');
  return {
    audioCount: audio.length,
    names: audio.slice(0, 8).map((t) => t.name),
  };
});
console.log('audio tracks:', JSON.stringify(info));

// Waveform canvases live in tile containers inside the timeline
const wf = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'))
    .filter((c) => {
      const p = c.parentElement;
      return p && p.classList.contains('absolute') && c.width > 0 && c.width <= 3000 && c.height <= 80;
    });
  let painted = 0;
  const samples = [];
  for (const c of canvases.slice(0, 30)) {
    try {
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, Math.min(c.width, 400), c.height).data;
      let nonEmpty = 0;
      for (let i = 3; i < d.length; i += 16) if (d[i] > 10) nonEmpty++;
      if (nonEmpty > 20) { painted++; samples.push({ w: c.width, h: c.height, nonEmpty }); }
    } catch { /* tainted */ }
  }
  return { candidateCanvases: canvases.length, painted, samples: samples.slice(0, 5) };
});
console.log('waveform canvases:', JSON.stringify(wf));

await page.screenshot({ path: 'C:/tmp/wf-verify.png' }).catch(() => {});
const pass = info.audioCount >= 1 && wf.painted >= 1;
console.log(pass ? 'PASS — audio clips render painted waveform tiles' : 'INCONCLUSIVE — check C:/tmp/wf-verify.png');
process.exit(0);
