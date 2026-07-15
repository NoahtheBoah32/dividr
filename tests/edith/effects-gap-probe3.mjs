// Probe 3: debug — what tabs/tabpanels exist right now, what's selected?
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

const info = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const sel = s.selectedTrackIds ?? s.selectedTracks ?? [];
  const storeKeys = Object.keys(s).filter((k) => /select/i.test(k));
  const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((t) => ({
    txt: t.textContent?.trim(), state: t.getAttribute('data-state'),
  }));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]')).map((t) => ({
    state: t.getAttribute('data-state'), hidden: t.hidden,
    h: Math.round(t.getBoundingClientRect().height),
    txt: (t.textContent ?? '').trim().slice(0, 50).replace(/\s+/g, ' '),
  }));
  return { sel, storeKeys, tabs, panels, tracks: s.tracks.map((t) => ({ id: t.id, type: t.type })) };
});
console.log(JSON.stringify(info, null, 1));
process.exit(0);
