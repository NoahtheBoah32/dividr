import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
const r = await page.evaluate(async ()=>{
  const list = await window.__dividrTest.listProjects();
  const arr = Array.isArray(list)?list:(list?.projects||[]);
  const hit = arr.filter(p=>JSON.stringify(p).includes('d0e81c64'));
  return { count:arr.length, sample:arr.slice(0,2), match:hit };
});
console.log(JSON.stringify(r,null,1).slice(0,2000));
process.exit(0);
