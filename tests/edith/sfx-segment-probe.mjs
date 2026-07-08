// Live layout probe — priority by recency. An earlier SFX, then a LATER overlapping
// SFX: the newer takes row 1 at its exact frame, the older is pushed up a layer. Every
// clip keeps its exact moment; nothing merges into a block.
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
// library-ready probe uses 'bell' (NOT one of the three test sounds) so it can't collide.
for (let i=0;i<16;i++){ await sleep(1500); const ok = await page.evaluate(async()=>{ try{ window.__dividrTest.applyOps([{type:'placeSFX',file:'bell.mp3',atTime:59,volume:-9,color:'#22c55e',trackName:'__probe__'}]); await new Promise(r=>setTimeout(r,700)); return window.__dividrTest.getStoreSnapshot().tracks.some(t=>t.name==='__probe__'); }catch{return false;} }); if(ok) break; }
await sleep(400);

// Only look at overlay SFX in the test region (frames 100..600), so the far-away
// library-ready probe never interferes.
async function testSfx() {
  return page.evaluate(()=>window.__dividrTest.getStoreSnapshot().tracks
    .filter(t=>t.type==='audio' && (t.trackRowIndex??0)>=1 && t.startFrame>=100 && t.startFrame<=600)
    .map(t=>({name:(t.source||'').split(/[\\/]/).pop(), row:t.trackRowIndex, start:t.startFrame, end:t.endFrame, color:t.color})));
}
async function placeAndWait(file, atTime) {
  const stem = file.replace('.mp3','');
  await page.evaluate(({file,atTime})=>window.__dividrTest.applyOps([{type:'placeSFX',file,atTime,volume:-3,color:'#22c55e'}]), {file,atTime});
  for (let i=0;i<14;i++){ await sleep(300); const s=await testSfx(); if (s.some(c=>c.name===file)) return; }
}

// applause @5s (frame 150), then LATER whoosh @7s (frame 210, overlaps applause),
// then LATER vine_boom @8s (frame 240, overlaps whoosh).
await placeAndWait('applause_clap.mp3', 5);
console.log('after applause @150:'); (await testSfx()).sort((a,b)=>a.row-b.row).forEach(c=>console.log(`  row ${c.row} [${c.start}..${c.end}] ${c.name}`));
await placeAndWait('whoosh_transition.mp3', 7);
console.log('after LATER whoosh @210 (overlaps applause):'); (await testSfx()).sort((a,b)=>a.row-b.row).forEach(c=>console.log(`  row ${c.row} [${c.start}..${c.end}] ${c.name}`));
await placeAndWait('vine_boom.mp3', 8);
const rows = await testSfx();
console.log('after LATER vine_boom @240 (overlaps whoosh):'); rows.slice().sort((a,b)=>a.row-b.row).forEach(c=>console.log(`  row ${c.row} [${c.start}..${c.end}] ${c.name}`));

const by = Object.fromEntries(rows.map(c=>[c.name, c]));
const applauseExact = by['applause_clap.mp3']?.start === 150;
const whooshExact = by['whoosh_transition.mp3']?.start === 210;
const vineExact = by['vine_boom.mp3']?.start === 240;
const newestRow1 = by['vine_boom.mp3']?.row === 1;
const applausePushed = (by['applause_clap.mp3']?.row ?? 0) >= 2;
let noOverlapPerRow = true;
const byRow = {};
for (const c of rows) (byRow[c.row] ||= []).push(c);
for (const r of Object.values(byRow)) { r.sort((a,b)=>a.start-b.start); for (let i=1;i<r.length;i++) if (r[i].start < r[i-1].end) noOverlapPerRow=false; }
console.log(`\nexact frames kept: applause@150=${applauseExact} whoosh@210=${whooshExact} vine@240=${vineExact}`);
console.log(`newest (vine_boom) on row 1: ${newestRow1} | applause pushed up: ${applausePushed} | no overlap within a row: ${noOverlapPerRow} | all green: ${rows.every(c=>c.color===GREEN)}`);
console.log((applauseExact && whooshExact && vineExact && newestRow1 && applausePushed && noOverlapPerRow) ? 'LAYOUT OK' : 'LAYOUT FAIL');
process.exit(0);
