import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page=null; for(const c of b.contexts())for(const p of c.pages()){const u=p.url(); if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
if(!page){console.log('no page');process.exit(1);}
const snap = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const audio = s.tracks.filter(t=>t.type==='audio').map(t=>({src:(t.source||'').split(/[\\/]/).pop(), row:t.trackRowIndex, sf:t.startFrame, ef:t.endFrame, color:t.color, name:t.name}));
  const markers = (s.tracks.find(t=>Array.isArray(t.sfxMarkers)&&t.sfxMarkers.length)?.sfxMarkers)||[];
  return {audio, markers};
});
console.log('AUDIO TRACKS:'); for(const a of snap.audio) console.log(' ', JSON.stringify(a));
console.log('MARKERS:', JSON.stringify(snap.markers));
process.exit(0);
