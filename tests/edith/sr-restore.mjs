/** Put the open clip back to a clean, sensible ramp after probing. */
import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
await page.bringToFront();
const res = await page.evaluate(() => {
  const s=window.__videoEditorStore.getState();
  const t=(s.tracks||[]).find(x=>x.type==='video');
  const fps=s.timeline?.fps??30;
  const DUR=36.1;                    // real source length
  const a=3,b=11,peak=6;
  const bounds=[{t0:3.2,t1:4.7},{t0:9.3,t1:10.8}];
  const segs=[1,peak,1];
  const ease=(u)=>u*u*u*(u*(u*6-15)+10);
  const speedAt=(x)=>{
    if(x<a||x>b) return 1;
    for(let i=0;i<bounds.length;i++){
      const {t0,t1}=bounds[i];
      if(x<t0) return segs[i];
      if(x<=t1){const u=(x-t0)/Math.max(1e-4,t1-t0);
        return Math.exp(Math.log(segs[i])+(Math.log(segs[i+1])-Math.log(segs[i]))*ease(u));}
    }
    return segs[segs.length-1];
  };
  const N=4096, dt=DUR/N; let out=0;
  for(let i=0;i<N;i++) out += dt/Math.max(0.02, speedAt((i+0.5)*dt));
  const endFrame = t.startFrame + Math.max(1, Math.round(out*fps));
  s.updateTrack(t.id,{ speedRamp:{ enabled:true, appliedByEdith:true, sourceDuration:DUR,
      blend:'blend', regions:[{a,b,shape:'smooth',dir:'forward',segs,bounds}] }, endFrame });
  s.setSelectedTracks([t.id]);
  s.setCurrentFrame(0);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  return { name:t.name, outSeconds:+out.toFixed(2), endFrame, startFrame:t.startFrame };
});
console.log(JSON.stringify(res));
await sleep(600);
process.exit(0);
