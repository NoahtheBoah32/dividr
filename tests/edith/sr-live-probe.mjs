import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for (const c of b.contexts()) for (const p of c.pages()) if (/localhost:5173/.test(p.url())) page=p;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

// make sure a ramp exists on the clip and we're paused mid-ramp
await page.evaluate(async () => {
  const st = window.__videoEditorStore.getState();
  const m = await import('/src/frontend/features/editor/preview/utils/speedRampCurve.ts');
  const regions = m.clampRegions([m.makeRegion(6,13,30)], 31.5);
  st.updateTrack('clip_sr1', { speedRamp:{enabled:true,appliedByEdith:true,regions,sourceDuration:31.5,blend:'flow',audio:false,pitch:true},
    endFrame: Math.round(m.buildProfile(regions,31.5).outDuration*30) });
  st.setSelectedTracks(['clip_sr1']);
  st.pause?.(); st.setCurrentFrame(270);   // 9s into the OUTPUT = deep in the ramp
});
await sleep(1500);

const readVideoTime = () => page.evaluate(() => {
  const vids=[...document.querySelectorAll('video')].filter(v=>v.src && v.readyState>=1);
  return vids.map(v=>+v.currentTime.toFixed(3));
});

const before = await readVideoTime();

// Change ONLY the ramp (steepen it), leave the playhead exactly where it is.
await page.evaluate(async () => {
  const st = window.__videoEditorStore.getState();
  const m = await import('/src/frontend/features/editor/preview/utils/speedRampCurve.ts');
  const t = st.tracks.find(x=>x.id==='clip_sr1');
  const regions = JSON.parse(JSON.stringify(t.speedRamp.regions));
  regions[0].segs[1] = 4;                       // 30x -> 4x : source time at this frame must change a LOT
  st.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, regions } });
});
await sleep(1200);
const afterNoEvent = await readVideoTime();

// Now the same change, but with the forceRender the panel's commit() dispatches
await page.evaluate(async () => {
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find(x=>x.id==='clip_sr1');
  const regions = JSON.parse(JSON.stringify(t.speedRamp.regions));
  regions[0].segs[1] = 12;
  st.updateTrack('clip_sr1', { speedRamp: { ...t.speedRamp, regions } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
});
await sleep(1200);
const afterEvent = await readVideoTime();

// What SHOULD the source time be at frame 270 for each?
const expected = await page.evaluate(async () => {
  const m = await import('/src/frontend/features/editor/preview/services/FrameResolver.ts');
  const st = window.__videoEditorStore.getState();
  const t = st.tracks.find(x=>x.id==='clip_sr1');
  const clip = m.extractClipMetadata(t, 30);
  return +m.calculateSourceTime(270, clip, 30).toFixed(3);
});

console.log('video.currentTime BEFORE change      :', JSON.stringify(before));
console.log('after ramp change, NO forceRender    :', JSON.stringify(afterNoEvent));
console.log('after ramp change, WITH forceRender  :', JSON.stringify(afterEvent));
console.log('resolver says frame 270 should be at :', expected);
process.exit(0);
