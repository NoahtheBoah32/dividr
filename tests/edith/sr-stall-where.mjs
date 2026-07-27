/** Dumps the biggest live-preview stalls with the source time on both sides. */
import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
await page.bringToFront();
async function run(dir){
  await page.evaluate(async (dir)=>{
    const { makeRegion, clampRegions, buildProfile } =
      await import('/src/frontend/features/editor/preview/utils/speedRampCurve.ts');
    const s=window.__videoEditorStore.getState(), fps=s.timeline?.fps??30;
    const t=(s.tracks||[]).find(x=>x.type==='video');
    const dur=t.sourceDuration/(t.effectiveFps||fps);
    const regions=clampRegions([makeRegion(3,11,6,'smooth')],dur).map(r=>({...r,dir}));
    const prof=buildProfile(regions,dur);
    s.updateTrack(t.id,{ speedRamp:{enabled:true,appliedByEdith:true,regions,
      sourceDuration:dur,blend:'blend',audio:false,pitch:true},
      endFrame:t.startFrame+Math.max(1,Math.round(prof.outDuration*fps)) });
    s.setCurrentFrame(70);
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  }, dir);
  await sleep(1400);
  await page.evaluate(()=>{ window.__srDraw=[]; window.__srCalls=[];
    window.__videoEditorStore.getState().play(); });
  await sleep(9000);
  const {raw, calls} = await page.evaluate(()=>{ window.__videoEditorStore.getState().pause();
    const d=window.__srDraw||[], c=window.__srCalls||[];
    window.__srDraw=null; window.__srCalls=null; return {raw:d, calls:c}; });
  const pics=[]; let lastPmt=null;
  for(const [t,ct,pmt] of raw){ if(ct===-1||pmt===lastPmt) continue; pics.push([t,ct]); lastPmt=pmt; }
  const t0=pics.length?pics[0][0]:0;
  const gaps=[];
  for(let i=1;i<pics.length;i++)
    gaps.push({ gapMs:+(pics[i][0]-pics[i-1][0]).toFixed(0), fromSrc:+pics[i-1][1].toFixed(2),
                toSrc:+pics[i][1].toFixed(2), atSec:+((pics[i-1][0]-t0)/1000).toFixed(2) });
  gaps.sort((a,b)=>b.gapMs-a.gapMs);
  // how many composite CALLS happened during the worst stall?
  const w=gaps[0];
  const wStart=t0+w.atSec*1000, wEnd=wStart+w.gapMs;
  const callsIn=calls.filter(c=>{const t=Array.isArray(c)?c[0]:c; return t>=wStart&&t<=wEnd;}).length;
  const repeatsIn=raw.filter(r=>r[1]===-1&&r[0]>=wStart&&r[0]<=wEnd).length;
  return { dir, worst:gaps.slice(0,4), callsDuringWorst:callsIn, fallbackRepeatsDuringWorst:repeatsIn };
}
console.log(JSON.stringify(await run('forward')));
console.log(JSON.stringify(await run('reverse')));
process.exit(0);
