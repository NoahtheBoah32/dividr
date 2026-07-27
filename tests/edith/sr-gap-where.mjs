/** Buckets live-preview picture gaps by where they land in the source. */
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
  await page.evaluate(()=>{ window.__srDraw=[]; window.__videoEditorStore.getState().play(); });
  await sleep(9000);
  const raw = await page.evaluate(()=>{ window.__videoEditorStore.getState().pause();
    const d=window.__srDraw||[]; window.__srDraw=null; return d; });

  const pics=[]; let lastPmt=null;
  for(const [t,ct,pmt] of raw){ if(ct===-1||pmt===lastPmt) continue; pics.push([t,ct]); lastPmt=pmt; }
  const t0=pics.length?pics[0][0]:0;
  const buckets={ warmup:[], before:[], ramp:[], after:[] };
  for(let i=1;i<pics.length;i++){
    const gap=pics[i][0]-pics[i-1][0], ct=pics[i][1], since=pics[i][0]-t0;
    if(since<600) buckets.warmup.push(gap);
    else if(ct<3) buckets.before.push(gap);
    else if(ct<=11) buckets.ramp.push(gap);
    else buckets.after.push(gap);
  }
  const stat=(a)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y);
    return { n:a.length, med:+s[s.length>>1].toFixed(1), max:+Math.max(...a).toFixed(0) }; };
  return { dir, warmup:stat(buckets.warmup), beforeRamp:stat(buckets.before),
           insideRamp:stat(buckets.ramp), afterRamp:stat(buckets.after) };
}
console.log(JSON.stringify(await run('forward'),null,0));
console.log(JSON.stringify(await run('reverse'),null,0));
process.exit(0);
