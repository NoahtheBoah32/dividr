/** Opens the Eiffel project BY ID and refuses to settle for any other. */
import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const WANT='d0e81c64-b3b3-4a54-8a66-d9298bdb0973';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
const cur = await page.evaluate(()=>window.__videoEditorStore?.getState?.().currentProjectId ?? null);
if(cur!==WANT){
  await page.evaluate(async ()=>{ await window.__dividrTest.openProjectByTitle('Untitled Project'); });
  for(let i=0;i<20;i++){ await sleep(1000);
    const s=await page.evaluate(()=>{const st=window.__videoEditorStore?.getState?.();
      return {id:st?.currentProjectId??null, v:(st?.tracks||[]).filter(t=>t.type==='video').length};});
    if(s.id===WANT && s.v>=1) break;
  }
}
const out = await page.evaluate(()=>{
  const s=window.__videoEditorStore.getState();
  const t=(s.tracks||[]).find(x=>x.type==='video');
  return { projectId:s.currentProjectId, clip:t?.name??null,
           startFrame:t?.startFrame, endFrame:t?.endFrame, hasRamp:!!t?.speedRamp };
});
console.log(JSON.stringify(out));
process.exit(out.projectId===WANT ? 0 : 1);
