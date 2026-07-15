// Probe 2 (robust): activate the Effects tab, then measure every ancestor and sibling
// on the path from the ACTIVE tabpanel up to the properties-panel column — find the
// element that owns the vertical dead space.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('no page'); process.exit(1); }

// Click the Effects tab trigger directly (real mouse), then measure.
const tabBox = await page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === 'Effects');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!tabBox) { console.log('no Effects tab trigger visible'); process.exit(1); }
await page.mouse.click(tabBox.x, tabBox.y);
await page.waitForTimeout(500);

const report = await page.evaluate(() => {
  const active = Array.from(document.querySelectorAll('[role="tabpanel"]')).find((el) => el.getAttribute('data-state') === 'active');
  if (!active) return { error: 'no active tabpanel' };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      h: Math.round(r.height), y: Math.round(r.y),
      mt: cs.marginTop, pt: cs.paddingTop, display: cs.display, flex: cs.flex,
      cls: String(el.className).slice(0, 70),
      txt: (el.textContent ?? '').trim().slice(0, 25).replace(/\s+/g, ' '),
    };
  };
  const chain = [];
  let el = active;
  for (let i = 0; i < 6 && el; i++) {
    const d = describe(el);
    d.siblings = el.parentElement
      ? Array.from(el.parentElement.children).filter((s) => s !== el).map(describe)
      : [];
    chain.push(d);
    el = el.parentElement;
  }
  return { activeText: (active.textContent ?? '').slice(0, 60), chain };
});
console.log(JSON.stringify(report, null, 1));
process.exit(0);
