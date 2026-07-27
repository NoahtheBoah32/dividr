/** Reverse twice with the SAME cache: pass 1 overlaps the fill, pass 2 is warm. */
import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
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
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
});
async function pass(label){
  await page.evaluate(()=>{ window.__videoEditorStore.getState().setCurrentFrame(70);
    window.dispatchEvent(new CustomEvent('dividr:forceRender')); });
  await sleep(1200);
  const cacheBefore = await page.evaluate(()=>window.__dividrCompositor.videos()[0]?.revCaches);
  await page.evaluate(()=>{ window.__srDraw=[]; window.__srCalls=[];
    window.__videoEditorStore.getState().play(); });
  await sleep(9000);
  const {raw,calls} = await page.evaluate(()=>{ window.__videoEditorStore.getState().pause();
    const d=window.__srDraw||[],c=window.__srCalls||[]; window.__srDraw=null; window.__srCalls=null;
    return {raw:d,calls:c}; });
  const pics=[]; let lastPmt=null;
  for(const [t,ct,pmt] of raw){ if(ct===-1||pmt===lastPmt) continue; pics.push([t,ct]); lastPmt=pmt; }
  const g=[]; for(let i=1;i<pics.length;i++){ const ct=pics[i][1];
    if(ct>=3&&ct<=11) g.push(pics[i][0]-pics[i-1][0]); }
  const sorted=[...g].sort((a,b)=>a-b);
  console.log(label, JSON.stringify({ cacheBefore, insideRamp:{n:g.length,
    med:+(sorted[g.length>>1]||0).toFixed(1), p95:+(sorted[Math.floor(g.length*0.95)]||0).toFixed(0),
    max:+Math.max(...g,0).toFixed(0)}, totalCalls:calls.length }));
}
await pass('pass1(filling):');
await pass('pass2(warm)  :');
process.exit(0);
