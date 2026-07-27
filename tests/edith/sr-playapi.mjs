import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
const keys = await page.evaluate(()=>{
  const s=window.__videoEditorStore.getState();
  return Object.keys(s).filter(k=>/play|pause|isPlaying|toggle/i.test(k));
});
console.log('api:', JSON.stringify(keys));
const probe = await page.evaluate(async ()=>{
  const s=window.__videoEditorStore.getState();
  const before=s.timeline?.currentFrame;
  s.setCurrentFrame(60);
  (s.setIsPlaying||s.play)?.call(s,true);
  await new Promise(r=>setTimeout(r,2000));
  const st=window.__videoEditorStore.getState();
  const after=st.timeline?.currentFrame;
  (st.setIsPlaying||st.pause)?.call(st,false);
  return {before, after, isPlaying: st.timeline?.isPlaying};
});
console.log('probe:', JSON.stringify(probe));
process.exit(0);
