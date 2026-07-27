import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
const r = await page.evaluate(() => {
  const s=window.__videoEditorStore.getState();
  return { fps:s.timeline?.fps, projectId:s.currentProjectId,
    tracks:(s.tracks||[]).map(t=>({name:t.name,type:t.type,startFrame:t.startFrame,endFrame:t.endFrame,
      duration:t.duration,sourceDuration:t.sourceDuration,hasRamp:!!t.speedRamp})) };
});
console.log(JSON.stringify(r,null,1));
process.exit(0);
