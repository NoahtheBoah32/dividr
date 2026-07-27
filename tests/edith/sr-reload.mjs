/** Hard reload only — pair with sr-open-eiffel.mjs. reload() not goto(): a goto
 *  to the same hash URL is a same-document navigation and leaves modules stale. */
import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
await page.reload({ waitUntil:'domcontentloaded' });
await new Promise(r=>setTimeout(r,6000));
console.log('reloaded');
process.exit(0);
