/**
 * Hard-reload the renderer (the HMR socket dies in this long-lived Electron
 * window) and come back to the SAME project.
 *
 * Two traps this avoids:
 *  - goto(currentHref) is a SAME-DOCUMENT navigation when only the hash differs,
 *    so the document never reloads and the stale modules stay live. Must be
 *    reload(), not goto().
 *  - reload-reopen.mjs then clicks the FIRST card in the picker, which is
 *    whatever project is newest. That is how a probe run warped the wrong clip.
 *    This matches the card by project name instead.
 */
import { chromium } from 'playwright-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
if(!page){console.log('no page');process.exit(1);}

const before = await page.evaluate(()=>{
  const s=window.__videoEditorStore?.getState?.();
  return { projectId:s?.currentProjectId ?? null,
           projectName:s?.projectName ?? s?.currentProjectName ?? null,
           clip:(s?.tracks||[]).find(t=>t.type==='video')?.name ?? null };
});
console.log('before:', JSON.stringify(before));

await page.reload({ waitUntil:'domcontentloaded' });
await sleep(6000);

const read = () => page.evaluate(()=>{
  const s=window.__videoEditorStore?.getState?.();
  return { projectId:s?.currentProjectId ?? null,
           clip:(s?.tracks||[]).find(t=>t.type==='video')?.name ?? null,
           video:(s?.tracks||[]).filter(t=>t.type==='video').length ?? 0,
           hash:location.hash };
});

let state = await read();
if (state.projectId !== before.projectId || state.video < 1) {
  // Landed on the picker. Find the card for THIS project by its clip/project
  // name and click that one specifically.
  for (let attempt=0; attempt<12 && (state.projectId!==before.projectId||state.video<1); attempt++) {
    const hit = await page.evaluate((want)=>{
      const stem = (want||'').replace(/\.[^.]+$/,'').toLowerCase();
      const els=[...document.querySelectorAll('*')].filter(e=>{
        const txt=(e.textContent||'').trim().toLowerCase();
        if(!txt || txt.length>120) return false;
        if(e.children.length>2) return false;
        return stem && txt.includes(stem.slice(0,12));
      });
      const el=els[0]; if(!el) return null;
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return { x:r.x+r.width/2, y:r.y+r.height/2, text:el.textContent.trim().slice(0,60) };
    }, before.clip);
    if (hit) {
      await page.mouse.move(hit.x, hit.y); await sleep(300);
      await page.mouse.dblclick(hit.x, hit.y);
      console.log('clicked card:', hit.text);
    }
    await sleep(2000);
    state = await read();
  }
}
console.log('after: ', JSON.stringify(state));
process.exit(state?.projectId===before.projectId && state.video>=1 ? 0 : 1);
