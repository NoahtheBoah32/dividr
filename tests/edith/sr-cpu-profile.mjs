/** Real CPU profile of the renderer during playback. No more guessing. */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts())
  for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
if (!page) {
  console.log('no renderer');
  process.exit(1);
}
await page.bringToFront();

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

await page.evaluate(() => {
  // Cap playhead store writes so React churn cannot mask whatever else is
  // eating the frame.
  globalThis.__srThrottleHz = 0;
  globalThis.__srLastWrite = 0;
  const s = window.__videoEditorStore.getState();
  s.setCurrentFrame(60);
}, );
await page.evaluate((h) => {
  globalThis.__srThrottleHz = h;
}, Number(process.argv[2] || 0));
await sleep(500);
await cdp.send('Profiler.start');
await page.evaluate(() => window.__videoEditorStore.getState().play?.());
await sleep(4000);
await page.evaluate(() => window.__videoEditorStore.getState().pause?.());
const { profile } = await cdp.send('Profiler.stop');

const byId = new Map();
for (const n of profile.nodes) byId.set(n.id, n);
const self = new Map();
const total = profile.samples.length;
for (const sid of profile.samples) {
  const n = byId.get(sid);
  if (!n) continue;
  const f = n.callFrame;
  const key = `${f.functionName || '(anon)'}  ${(f.url || '').split('/').slice(-1)[0]}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + 1);
}
const durMs = (profile.endTime - profile.startTime) / 1000;
console.log(`samples=${total} over ${durMs.toFixed(0)}ms\n`);
const show = (title, filter, n) => {
  const rows = [...self.entries()]
    .filter(([k]) => filter(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
  console.log(`--- ${title} ---`);
  for (const [k, c] of rows) {
    const pct = (c / total) * 100;
    if (pct < 0.2) continue;
    console.log(
      `${pct.toFixed(1).padStart(5)}%  ${((c / total) * durMs).toFixed(0).padStart(5)}ms  ${k}`,
    );
  }
  console.log('');
};
show('everything', () => true, 12);

// Inclusive time: walk each sample's ancestry and credit the first frame that
// matches a bucket. This separates "React re-rendered the editor" from "we
// composited a video frame", which self-time cannot do.
const parent = new Map();
for (const n of profile.nodes)
  for (const c of n.children ?? []) parent.set(c, n.id);
const BUCKETS = [
  ['React render', (f) => /jsxDEV|ReactElement|createElement|\bjsx\b|performWork|flushWork|renderRootSync|beginWork|commitRoot/.test(f.functionName)],
  ['compositeFrame', (f) => /compositeFrame|drawVideoFrame|drawPipFrame|animate/.test(f.functionName)],
  ['canvas ops', (f) => /drawImage|getImageData|putImageData|createImageBitmap/.test(f.functionName)],
  ['GC', (f) => /garbage collector/.test(f.functionName)],
];
const bucket = new Map();
for (const sid of profile.samples) {
  let id = sid;
  let hit = null;
  for (let d = 0; d < 200 && id != null && !hit; d++) {
    const n = byId.get(id);
    if (!n) break;
    for (const [name, test] of BUCKETS)
      if (test(n.callFrame)) {
        hit = name;
        break;
      }
    id = parent.get(id);
  }
  const k = hit ?? 'other';
  bucket.set(k, (bucket.get(k) ?? 0) + 1);
}
// For every sample, find the innermost frame that lives in OUR source. That is
// the component whose render is doing the work, regardless of how deep into
// React internals the sample landed.
const owner = new Map();
for (const sid of profile.samples) {
  let id = sid;
  let hit = null;
  for (let d = 0; d < 300 && id != null && !hit; d++) {
    const n = byId.get(id);
    if (!n) break;
    const f = n.callFrame;
    if (/\.tsx?($|\?)/.test(f.url || ''))
      hit = `${f.functionName || '(anon)'}  ${(f.url || '').split('/').slice(-1)[0].split('?')[0]}:${f.lineNumber + 1}`;
    id = parent.get(id);
  }
  const k = hit ?? '(no project frame)';
  owner.set(k, (owner.get(k) ?? 0) + 1);
}
console.log('--- work attributed to nearest project component ---');
for (const [k, c] of [...owner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const pct = (c / total) * 100;
  if (pct < 0.4) continue;
  console.log(
    `${pct.toFixed(1).padStart(5)}%  ${((c / total) * durMs).toFixed(0).padStart(5)}ms  ${k}`,
  );
}
console.log('');

console.log('--- inclusive, innermost match wins ---');
for (const [k, c] of [...bucket.entries()].sort((a, b) => b[1] - a[1]))
  console.log(
    `${((c / total) * 100).toFixed(1).padStart(5)}%  ${((c / total) * durMs).toFixed(0).padStart(5)}ms  ${k}`,
  );
console.log('');
// Our own source files only: this is the list of things re-rendering per frame.
show('project components (.tsx/.ts)', (k) => /\.tsx?:/.test(k), 30);
process.exit(0);
