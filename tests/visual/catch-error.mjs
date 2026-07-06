import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + (e.stack || e.message)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 300)); });
await page.addInitScript(() => { window.__dividrTestMode = true; });
await page.goto('http://localhost:5173/#/video-editor', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3500));
const startsWith = errs.filter((e) => /startsWith/.test(e));
console.log('total console/page errors:', errs.length);
console.log('startsWith errors:', startsWith.length);
for (const e of startsWith.slice(0, 3)) console.log('---\n' + e.slice(0, 600));
if (!startsWith.length) { console.log('NO startsWith error on a clean editor load. Other errors:'); for (const e of errs.slice(0,5)) console.log(' - ' + e.slice(0,160)); }
process.exit(0);
