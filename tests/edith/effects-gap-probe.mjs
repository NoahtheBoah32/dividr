// Probe: what occupies the vertical void in the Effects tab panel?
// Selects the video track, opens the Effects tab, then walks the panel's children
// reporting each section's bounding box + first text content.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

// Select the main video track via the bridge so the properties panel shows video props.
await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const vid = s.tracks.find((t) => t.type === 'video');
  if (vid) s.selectTracks?.([vid.id]) ?? s.setSelectedTracks?.([vid.id]);
  return vid?.id;
});
await page.waitForTimeout(300);

// Click the Effects tab if present.
const clicked = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
  const eff = tabs.find((el) => el.textContent?.trim() === 'Effects');
  if (eff) { eff.click(); return true; }
  return false;
});
await page.waitForTimeout(400);

const report = await page.evaluate(() => {
  // Find the tabpanel that contains "Detect from scene" or the Light section.
  const all = Array.from(document.querySelectorAll('[role="tabpanel"], [data-state="active"]'));
  let panel = all.find((el) => el.textContent?.includes('Detect from scene'))
    ?? all.find((el) => el.textContent?.includes('Hold the World'));
  if (!panel) return { error: 'no effects panel found', clickedTabs: all.length };
  // Drill to the flex column inside.
  const col = panel.querySelector(':scope > div') ?? panel;
  const rows = [];
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect();
    const cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : '';
    const txt = (el.textContent ?? '').trim().slice(0, 40).replace(/\s+/g, ' ');
    rows.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}> h=${Math.round(r.height)} y=${Math.round(r.y)} cls="${cls}" txt="${txt}"`);
    if (depth < 2) for (const ch of el.children) walk(ch, depth + 1);
  };
  walk(col, 0);
  const pr = panel.getBoundingClientRect();
  return { panelH: Math.round(pr.height), panelY: Math.round(pr.y), scrollTop: panel.scrollTop, rows };
});
console.log('clicked Effects tab:', clicked);
console.log(JSON.stringify(report, null, 1));
process.exit(0);
