/**
 * Live-preview smoothness across the ramp, forward and reverse.
 *
 * Reads the compositor's own draw trace (__srDraw) rather than sampling the
 * canvas: a per-rAF getImageData forces a GPU sync flush and the probe ends up
 * measuring its own interference (it reported 0.7 pics/s against a preview
 * genuinely running at ~12).
 *
 * A "picture" is a draw whose presentedMediaTime differs from the last one —
 * repeats of the same decoded frame don't count.
 */
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
  await sleep(9000);                                  // quiet: no CDP traffic
  const raw = await page.evaluate(()=>{
    window.__videoEditorStore.getState().pause();
    const d=window.__srDraw||[]; window.__srDraw=null; return d;
  });

  const gaps=[]; let lastPmt=null, lastT=null;
  for(const [t,ct,pmt] of raw){
    if(ct===-1) continue;                             // fallback repeat, no new picture
    if(pmt===lastPmt) continue;                       // same decoded frame redrawn
    if(lastT!==null) gaps.push(t-lastT);
    lastPmt=pmt; lastT=t;
  }
  const n=gaps.length; const sorted=[...gaps].sort((a,b)=>a-b);
  return { dir, pictures:n+1, picsPerSec:+((n+1)/9).toFixed(1),
           medianGapMs:+(sorted[n>>1]||0).toFixed(1),
           p95GapMs:+(sorted[Math.floor(n*0.95)]||0).toFixed(0),
           maxGapMs:+(Math.max(...gaps,0)).toFixed(0) };
}
console.log(JSON.stringify(await run('forward')));
console.log(JSON.stringify(await run('reverse')));
process.exit(0);
