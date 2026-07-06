import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO 5173 page'); process.exit(1); }
await page.addInitScript(() => { window.__dividrTestMode = true; });
await page.goto('http://localhost:5173/#/video-editor', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// before clicking anything
const pre = await page.evaluate(() => ({
  textareas: Array.from(document.querySelectorAll('textarea')).map((t) => ({ ph: t.placeholder, vis: t.offsetParent !== null })),
  errBoundary: document.body.innerText.includes('Something went wrong') || document.body.innerText.includes('error boundary'),
  bodyHasEdith: /E\.?D\.?I\.?T\.?H/i.test(document.body.innerText),
}));

// find + click the EDITH toggle (try several selectors)
const toggles = ['[title="E.D.I.T.H"]', '[title*="EDITH" i]', '[aria-label*="EDITH" i]', 'button:has(svg.lucide-smile)', 'button:has(svg.lucide-message-circle)', 'button:has(svg.lucide-sparkles)'];
let clicked = '';
for (const sel of toggles) {
  const loc = page.locator(sel).first();
  if (await loc.count() > 0) { try { await loc.click({ timeout: 3000 }); clicked = sel; break; } catch (e) {} }
}
await new Promise((r) => setTimeout(r, 1500));

const post = await page.evaluate(() => {
  const tas = Array.from(document.querySelectorAll('textarea')).map((t) => ({ ph: t.placeholder, vis: t.offsetParent !== null, id: t.id, cls: (t.className || '').slice(0, 60) }));
  // left sidebar buttons (x < 80)
  const left = Array.from(document.querySelectorAll('button,[role="button"]')).map((el) => {
    const r = el.getBoundingClientRect();
    const icon = Array.from(el.querySelectorAll('svg')).map((s) => (s.getAttribute('class') || '').split(' ').find((c) => c.startsWith('lucide-'))).filter(Boolean).join(',');
    return { x: Math.round(r.left), y: Math.round(r.top), icon, title: el.getAttribute('title') || el.getAttribute('aria-label') || '' };
  }).filter((e) => e.x < 80 && (e.icon || e.title)).sort((a, b) => a.y - b.y);
  return { textareas: tas, leftSidebar: left };
});
console.log(JSON.stringify({ pre, clicked, post }, null, 2));
process.exit(0);
