import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
const r = await page.evaluate(() => {
  const s=window.__videoEditorStore.getState();
  const out=[];
  for (const t of (s.tracks||[])) {
    if (t.type==='video' && t.speedRamp) {
      const fps=s.timeline?.fps??30;
      const full=Math.max(1, Math.round((t.speedRamp.sourceDuration||0)*fps));
      s.updateTrack(t.id,{ speedRamp: undefined, endFrame: t.startFrame+full });
      out.push({name:t.name, restoredTo:t.startFrame+full});
    }
  }
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  return out;
});
console.log(JSON.stringify(r));
process.exit(0);
