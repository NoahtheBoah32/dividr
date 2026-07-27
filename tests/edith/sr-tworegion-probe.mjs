/** Does a SECOND region (the "+ Add ramp" button) actually affect playback? */
import { chromium } from 'playwright-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if (/5173/.test(p.url())) page = p;
await page.bringToFront();
const clipId = await page.evaluate(() => (window.__videoEditorStore.getState().tracks||[]).find(x=>x.type==='video')?.id);

// region 1: 3-9s at 4x   |   region 2: 12-20s at 0.4x (slow motion)
await page.evaluate(({id}) => {
  const s = window.__videoEditorStore.getState();
  const t = s.tracks.find(x=>x.id===id); const fps = s.timeline?.fps ?? 30;
  s.updateTrack(id, { speedRamp: { enabled:true, appliedByEdith:true,
    sourceDuration:(t.endFrame-t.startFrame)/fps, blend:'blend',
    regions:[
      {a:3,b:9,shape:'smooth',dir:'forward',segs:[1,4,1],bounds:[{t0:3.2,t1:4.4},{t0:7.8,t1:8.8}]},
      {a:12,b:20,shape:'smooth',dir:'forward',segs:[1,0.4,1],bounds:[{t0:12.2,t1:13.4},{t0:18.6,t1:19.8}]},
    ] } });
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
}, {id:clipId});
await sleep(500);
await page.evaluate(() => window.__videoEditorStore.getState().setCurrentFrame(60));
await sleep(900);
await page.evaluate(() => {
  window.__srDraw = [];
  window.__videoEditorStore.getState().play?.();
  setTimeout(()=>window.__videoEditorStore.getState().pause?.(), 22000);
});
await sleep(22600);
const draw = await page.evaluate(() => { const d=window.__srDraw??[]; delete window.__srDraw; return d.filter(r=>r[1]!==-1); });
// local speed per source second
const buckets = new Map();
for (let i=4;i<draw.length;i++){
  const ds=draw[i][1]-draw[i-4][1], dw=(draw[i][0]-draw[i-4][0])/1000;
  if (dw<=1e-4) continue;
  const k=Math.floor(draw[i][1]); const v=buckets.get(k)??[]; v.push(ds/dw); buckets.set(k,v);
}
const rows=[...buckets.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>{v.sort((a,b)=>a-b);return [k, v[Math.floor(v.length/2)]];});
console.log('source second -> measured speed');
console.log(rows.map(([k,v])=>`${k}s:${v.toFixed(1)}x`).join('  '));
const r1 = rows.filter(([k])=>k>=5&&k<=7).map(([,v])=>v);
const r2 = rows.filter(([k])=>k>=14&&k<=18).map(([,v])=>v);
const med=(a)=>a.length?a.sort((x,y)=>x-y)[Math.floor(a.length/2)]:NaN;
console.log(`\nregion 1 (want ~4x): ${med(r1).toFixed(2)}x  -> ${med(r1)>2.5&&med(r1)<6?'PASS':'FAIL'}`);
console.log(`region 2 (want ~0.4x): ${med(r2).toFixed(2)}x  -> ${med(r2)>0.2&&med(r2)<0.8?'PASS':'FAIL'}`);
process.exit(0);
