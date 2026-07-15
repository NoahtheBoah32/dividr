import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let i=0;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u=p.url();
  let dom={}, store={};
  try {
    dom = await p.evaluate(()=>({
      hasAdded: !!Array.from(document.querySelectorAll('*')).find(e=>e.children.length===0 && e.textContent==='Added'),
      libText: (Array.from(document.querySelectorAll('*')).find(e=>/\bitem\b/.test(e.textContent||'') && (e.textContent||'').length<20)||{}).textContent||'',
      title: document.title,
    }));
    store = await p.evaluate(()=>{const s=window.__dividrTest?.getStoreSnapshot?.(); return s?{tracks:(s.tracks||[]).length, media:(s.mediaLibrary||[]).length}:{noBridge:true};});
  } catch(e){ dom={err:String(e).slice(0,60)}; }
  console.log(`[${i++}] ${u.slice(0,50)} | title="${dom.title}" | DOM added=${dom.hasAdded} lib="${(dom.libText||'').trim()}" | store=${JSON.stringify(store)}`);
}
process.exit(0);
