import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages()){const u=p.url();
  if(u.includes('localhost:5173')&&!u.startsWith('blob:'))page=p;}
const cards = await page.evaluate(()=>{
  // project cards: elements that contain a thumbnail img plus a title
  const imgs=[...document.querySelectorAll('img')].filter(i=>i.getBoundingClientRect().width>80);
  return imgs.map((img,idx)=>{
    let el=img, txt='';
    for(let i=0;i<5 && el;i++){ el=el.parentElement; if(el){const t=el.textContent?.trim()||'';
      if(t.length>txt.length && t.length<200) txt=t; } }
    const r=img.getBoundingClientRect();
    return { idx, title:txt.slice(0,90), x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2) };
  });
});
console.log(JSON.stringify(cards,null,1));
process.exit(0);
