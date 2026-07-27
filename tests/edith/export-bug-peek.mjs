import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
const r = await page.evaluate(() => {
  const s=window.__videoEditorStore.getState();
  return { projectId:s.currentProjectId, fps:s.timeline?.fps,
    media:(s.mediaLibrary||[]).map(m=>({name:m.name, type:m.type,
      source:(m.source||'').split(/[\/]/).pop(),
      extractedAudio:m.extractedAudio??null, tempFilePath:m.tempFilePath??null})),
    tracks:(s.tracks||[]).map(t=>({name:t.name, type:t.type,
      source:(t.source||'').split(/[\/]/).pop(),
      startFrame:t.startFrame, endFrame:t.endFrame, duration:t.duration,
      sourceDuration:t.sourceDuration, sourceStartTime:t.sourceStartTime,
      trackRowIndex:t.trackRowIndex, isLinked:t.isLinked, muted:t.muted })) };
});
console.log(JSON.stringify(r,null,1));
process.exit(0);
