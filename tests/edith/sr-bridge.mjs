import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
console.log(JSON.stringify(await page.evaluate(()=>{
  const c=window.__dividrCompositor;
  const shape={};
  for(const k of Object.keys(c||{})){ const v=c[k];
    shape[k]= v instanceof Map ? `Map(${v.size})` : Array.isArray(v)? `Array(${v.length})` : typeof v; }
  return shape;
}),null,1));
process.exit(0);
