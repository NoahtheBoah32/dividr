import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
await page.addInitScript(() => { window.__dividrTestMode = true; });
await page.goto('http://localhost:5173/#/video-editor', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
// find a smiley/assistant toggle and click it to open EDITH's chat
const smileSel = ['button:has(svg.lucide-smile)', 'button:has(svg.lucide-smile-plus)', 'button:has(svg.lucide-message-circle)', 'button:has(svg.lucide-bot)', 'button:has(svg.lucide-sparkles)'];
let clicked = '';
for (const sel of smileSel) {
  const loc = page.locator(sel).first();
  if (await loc.count() > 0) { try { await loc.click({ timeout: 3000 }); clicked = sel; break; } catch {} }
}
await new Promise((r) => setTimeout(r, 1200));
const info = await page.evaluate((clicked) => {
  const allIcons = [...new Set(Array.from(document.querySelectorAll('svg')).map((s) => (s.getAttribute('class') || '').split(' ').find((c) => c.startsWith('lucide-'))).filter(Boolean))];
  // any leftmost-column clickable with an icon (the vertical sidebar)
  const leftSidebar = Array.from(document.querySelectorAll('button, [role="button"], a')).map((el) => {
    const r = el.getBoundingClientRect();
    const icon = Array.from(el.querySelectorAll('svg')).map((s) => (s.getAttribute('class') || '').split(' ').find((c) => c.startsWith('lucide-'))).filter(Boolean).join(',');
    return { x: Math.round(r.left), y: Math.round(r.top), icon, title: el.getAttribute('title') || el.getAttribute('aria-label') || '' };
  }).filter((e) => e.x < 70 && (e.icon || e.title)).sort((a, b) => a.y - b.y);
  return {
    clicked,
    textareas: Array.from(document.querySelectorAll('textarea')).map((t) => t.placeholder),
    allIcons,
    leftSidebar,
  };
}, clicked);
console.log(JSON.stringify(info, null, 2));
process.exit(0);
