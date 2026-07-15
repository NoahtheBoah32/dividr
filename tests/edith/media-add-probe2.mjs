import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u=p.url(); if (u.includes('localhost:5173')&&!u.startsWith('blob:')&&!u.startsWith('devtools:')) page=p; }
if (!page){console.log('NO_RENDERER');process.exit(1);}
const info = await page.evaluate(() => {
  const snap = window.__dividrTest?.getStoreSnapshot?.();
  if (!snap) return { bridge:false };
  return {
    bridge:true,
    tracks: (snap.tracks||[]).map(t=>({id:t.id,type:t.type,src:(t.source||'').split(/[\/]/).pop(),prev:(t.previewUrl||'').slice(-30),start:t.startFrame,end:t.endFrame,len:(t.endFrame??0)-(t.startFrame??0),visible:t.visible,row:t.trackRowIndex})),
    media: (snap.mediaLibrary||[]).map(m=>({id:m.id,name:(m.name||'').slice(0,20),type:m.type,dur:m.duration,src:(m.source||'').split(/[\/]/).pop(),prev:(m.previewUrl||'').split(/[\/]/).pop(),proxy:m.proxy?.status,transcoding:m.transcoding?.status})),
  };
});
console.log(JSON.stringify(info,null,1));
process.exit(0);
