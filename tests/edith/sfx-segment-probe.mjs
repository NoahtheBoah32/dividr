// Segmentation probe — drop several SFX at the SAME moment and confirm they land as
// separate clips on ONE overlay row (row 1), butted sequentially (no merged block).
import { chromium } from 'playwright-core';
const FPS = 30, GREEN = '#22c55e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:') && !u.startsWith('devtools:')) page = p; }
if (!page) { console.log('no renderer'); process.exit(1); }
await page.addInitScript(() => { window.__dividrTestMode = true; try { for (const k of ['default','null','undefined']) localStorage.setItem(`edith-consent-${k}`,'true'); } catch {} });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);
await page.evaluate((f) => window.__dividrTest.setStoreState({
  tracks: [{ id:'clip_v1', type:'video', name:'base.mp4', source:'C:/base.mp4', startFrame:0, endFrame:1800, duration:1800, sourceStartTime:0, trackRowIndex:0, layer:0, mediaId:'m1', visible:true, muted:false, color:'#4A90D9' }],
  mediaLibrary: [{ id:'m1', name:'base.mp4', type:'video', source:'C:/base.mp4', duration:60 }],
  preview: { canvasWidth:1280, canvasHeight:720 },
  timeline: { currentFrame:0, fps:f, totalFrames:1800, selectedTrackIds:['clip_v1'] },
}), FPS);
try { await page.evaluate(() => window.__dividrTest.openPanel?.('friday')); } catch {}
// wait for lib
for (let i=0;i<16;i++){ await sleep(1500); const ok = await page.evaluate(async()=>{ try{ window.__dividrTest.applyOps([{type:'placeSFX',file:'whoosh_transition.mp3',atTime:59,volume:-9,color:'#22c55e',trackName:'__p__'}]); await new Promise(r=>setTimeout(r,700)); const s=window.__dividrTest.getStoreSnapshot(); const has=s.tracks.some(t=>t.name==='__p__'); if(has) window.__dividrTest.setStoreState({tracks:s.tracks.filter(t=>t.name!=='__p__')}); return has; }catch{return false;} }); if(ok) break; }
await page.evaluate((f)=>window.__dividrTest.setStoreState({ tracks:[{ id:'clip_v1', type:'video', name:'base.mp4', source:'C:/base.mp4', startFrame:0, endFrame:1800, duration:1800, sourceStartTime:0, trackRowIndex:0, layer:0, mediaId:'m1', visible:true, muted:false, color:'#4A90D9' }], timeline:{ currentFrame:0, fps:f, totalFrames:1800, selectedTrackIds:['clip_v1'] } }), FPS);
await sleep(400);

// Drop 6 different SFX all at the SAME time (5s).
const files = ['boom_impact.mp3','vine_boom.mp3','riser.mp3','cash_register.mp3','crickets.mp3','whoosh_transition.mp3'];
for (const file of files) {
  await page.evaluate(({file})=>window.__dividrTest.applyOps([{type:'placeSFX',file,atTime:5,volume:-3,color:'#22c55e'}]), {file});
  await sleep(600);
}
await sleep(800);
const sfx = await page.evaluate(()=>window.__dividrTest.getStoreSnapshot().tracks
  .filter(t=>t.type==='audio' && (t.trackRowIndex??0)>=1)
  .map(t=>({name:t.name, row:t.trackRowIndex, start:t.startFrame, end:t.endFrame, color:t.color}))
  .sort((a,b)=>a.start-b.start));
console.log('placed SFX (all dropped at 5s / frame 150):');
sfx.forEach(c=>console.log(`  row ${c.row}  [${c.start}..${c.end}]  ${c.name}  ${c.color}`));
const allRow1 = sfx.every(c=>c.row===1);
const firstExact = sfx[0]?.start===150;
let noOverlap = true;
for (let i=1;i<sfx.length;i++){ if (sfx[i].start < sfx[i-1].end) noOverlap=false; }
console.log(`\nall on row 1: ${allRow1}  |  first at exact frame 150: ${firstExact}  |  none overlapping: ${noOverlap}  |  green: ${sfx.every(c=>c.color===GREEN)}`);
console.log((allRow1 && firstExact && noOverlap) ? 'SEGMENTATION OK' : 'SEGMENTATION FAIL');
process.exit(0);
