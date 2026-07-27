import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
const r = await page.evaluate(() => {
  const s=window.__videoEditorStore.getState();
  const t=(s.tracks||[]).find(x=>x.type==='video');
  const out={};
  for(const k of Object.keys(t)) {
    const v=t[k];
    if (v===null||['number','string','boolean'].includes(typeof v)) out[k]=v;
  }
  const el=(window.__dividrCompositor?.videos?.get?.(t.id))?.video;
  out.__elDuration = el?.duration ?? null;
  return out;
});
console.log(JSON.stringify(r,null,1));
process.exit(0);
