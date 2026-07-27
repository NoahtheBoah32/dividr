import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
console.log(JSON.stringify(await page.evaluate(async ()=>{
  const t0=performance.now(); let n=0;
  await new Promise(r=>{ const tick=()=>{n++; if(performance.now()-t0<2000) requestAnimationFrame(tick); else r();}; requestAnimationFrame(tick); });
  return { visibility:document.visibilityState, hasFocus:document.hasFocus(),
           hidden:document.hidden, rafHz:+(n/2).toFixed(1) };
})));
process.exit(0);
