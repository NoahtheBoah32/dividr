import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
const r = await page.evaluate(() => {
  const s=window.__videoEditorStore.getState();
  const t=(s.tracks||[]).find(x=>x.type==='video');
  return { name:t.name, startFrame:t.startFrame, endFrame:t.endFrame,
           selected:(s.selectedTrackIds||[]).includes(t.id), ramp:t.speedRamp };
});
console.log(JSON.stringify(r,null,1));
process.exit(0);
