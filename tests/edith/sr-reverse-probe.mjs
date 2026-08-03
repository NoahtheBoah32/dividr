/**
 * Reverse drive probe — does the reverse frame cache actually fill, and is the
 * frame the curve asks for ever IN it? Measured during real playback through a
 * reverse region. If `stepping` stays true while `revWant` moves, the cache is
 * missing and every picture is coming from a backward seek (the wild stutter).
 * Run: node tests/edith/sr-reverse-probe.mjs ["Project Title"]
 */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = process.argv[2] || 'J-cut DEMO';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no dev app page'); process.exit(1); }
page.setDefaultTimeout(25000);

for (let i = 0; i < 30; i++) {
  const st = await page.evaluate(() => {
    const s = window.__videoEditorStore?.getState?.();
    return s ? { ready: (s.tracks || []).length > 0 } : { ready: false };
  }).catch(() => ({ ready: false }));
  if (st.ready) break;
  await page.evaluate(async (t) => {
    try { await window.__dividrTest.openProjectByTitle(t); } catch (e) {}
  }, TITLE).catch(() => {});
  await sleep(1000);
}

const clip = await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const v = s.tracks.filter((t) => t.type === 'video').sort((a, b) => a.startFrame - b.startFrame)[0];
  return v ? { id: v.id, name: v.name } : null;
});
if (!clip) { console.log('no clip'); process.exit(1); }

const applyOp = (op) => page.evaluate(async (o) => {
  await window.__dividrTest.applyOps([o]);
  await window.__dividrTest.waitForQueueDrained();
}, op);

await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  if (st.playback?.isPlaying) st.togglePlayback?.();
});
try { await applyOp({ type: 'speedRamp', enabled: false }); } catch {}
await sleep(300);
await applyOp({ type: 'speedRamp', speed: 2 });
await sleep(500);

// Flip every region to reverse
const flipped = await page.evaluate(({ id }) => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find((x) => x.id === id);
  const sr = t?.speedRamp;
  if (!sr?.regions?.length) return null;
  st.updateTrack(id, { speedRamp: { ...sr, regions: sr.regions.map((r) => ({ ...r, dir: 'reverse' })) } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  return sr.regions.map((r) => ({ a: r.a, b: r.b, span: +(r.b - r.a).toFixed(2) }));
}, { id: clip.id });
console.log(`clip "${clip.name}" reverse regions: ${JSON.stringify(flipped)}`);

const g = await page.evaluate(({ id }) => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find((x) => x.id === id);
  return { start: t.startFrame, end: t.endFrame, fps: s.timeline?.fps ?? 30 };
}, { id: clip.id });

// Give the fill a head start (it begins as soon as the region exists and a
// frame is composited), then watch it during playback.
await page.evaluate((f) => {
  const st = window.__videoEditorStore.getState();
  st.setCurrentFrame?.(f);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, g.start + 2);
await sleep(2500);

const pre = await page.evaluate(() => (window.__dividrCompositor?.videos?.() ?? [])[0]?.revCaches ?? []);
console.log(`cache after 2.5s idle: ${JSON.stringify(pre)}`);

await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  for (const fn of ['togglePlayback', 'setIsPlaying', 'play'])
    if (typeof st[fn] === 'function') { fn === 'setIsPlaying' ? st[fn](true) : st[fn](); break; }
});

const samples = await page.evaluate(async (dur) => {
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < dur) {
    const v = (window.__dividrCompositor?.videos?.() ?? [])[0];
    if (v) out.push({
      t: Math.round(performance.now() - t0),
      p: v.presentedMediaTime, stepping: v.stepping, revWant: v.revWant,
      seeking: v.seeking, caches: (v.revCaches ?? []).map((c) => `${c.frames}${c.done ? 'D' : ''}`).join(','),
    });
    await new Promise((r) => setTimeout(r, 60));
  }
  return out;
}, 3000);

await page.evaluate(() => {
  const st = window.__videoEditorStore.getState();
  if (st.playback?.isPlaying) st.togglePlayback?.();
});

const withWant = samples.filter((s) => s.revWant !== null && s.revWant !== undefined);
const steppingN = samples.filter((s) => s.stepping).length;
const distinct = new Set(samples.map((s) => s.p)).size;
console.log(`\nsamples=${samples.length} distinctPictures=${distinct} stepping=${Math.round(100 * steppingN / samples.length)}% cacheHits(revWant set)=${withWant.length}`);
console.log(`final caches: ${samples[samples.length - 1]?.caches}`);
console.log('\nfirst 14 samples:');
for (const s of samples.slice(0, 14)) console.log(`  t=${s.t} p=${s.p?.toFixed?.(3)} stepping=${s.stepping} revWant=${s.revWant} seeking=${s.seeking} caches=[${s.caches}]`);

try { await applyOp({ type: 'speedRamp', enabled: false }); } catch {}
process.exit(0);
