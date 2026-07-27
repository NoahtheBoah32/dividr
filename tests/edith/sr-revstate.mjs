import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
await page.bringToFront();
await page.evaluate(async ()=>{
  const { makeRegion, clampRegions, buildProfile } =
    await import('/src/frontend/features/editor/preview/utils/speedRampCurve.ts');
  const s=window.__videoEditorStore.getState(), fps=s.timeline?.fps??30;
  const t=(s.tracks||[]).find(x=>x.type==='video');
  const dur=t.sourceDuration/(t.effectiveFps||fps);
  const regions=clampRegions([makeRegion(3,11,6,'smooth')],dur).map(r=>({...r,dir:'reverse'}));
  const prof=buildProfile(regions,dur);
  s.updateTrack(t.id,{ speedRamp:{enabled:true,appliedByEdith:true,regions,
    sourceDuration:dur,blend:'blend',audio:false,pitch:true},
    endFrame:t.startFrame+Math.max(1,Math.round(prof.outDuration*fps)) });
  s.setCurrentFrame(70); window.dispatchEvent(new CustomEvent('dividr:forceRender'));
});
await sleep(1200);
console.log('BEFORE play:', JSON.stringify(await page.evaluate(()=>window.__dividrCompositor.videos())));
await page.evaluate(()=>window.__videoEditorStore.getState().play());
for (const ms of [700,1500,3000,5000]) {
  await sleep(ms===700?700:ms-700);
  console.log(`t+${ms}ms:`, JSON.stringify(await page.evaluate(()=>window.__dividrCompositor.videos())));
}
await page.evaluate(()=>window.__videoEditorStore.getState().pause());
process.exit(0);
