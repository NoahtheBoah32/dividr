import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
console.log(JSON.stringify(await page.evaluate(()=>{
  const s=window.__videoEditorStore?.getState?.()||{};
  return { storeKeys:Object.keys(s).filter(k=>/project|load|open/i.test(k)),
           testBridge:Object.keys(window.__dividrTest||{}) };
}),null,1));
process.exit(0);
