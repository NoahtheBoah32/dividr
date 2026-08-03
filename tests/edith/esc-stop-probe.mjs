// Esc-stop probe — verifies the killTree fix: pressing Escape mid-response must
// actually silence EDITH (no further message bubbles), not just print "Interrupted".
// Repro of Joaquin's report: shell:true wrapper meant .kill() only took down
// cmd.exe while the claude grandchild kept streaming.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }
page.on('dialog', async (d) => { try { await d.accept(); } catch {} });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

for (let i = 0; i < 12; i++) {
  if (await page.evaluate(() => !!window.__dividrTest).catch(() => false)) break;
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await page.waitForTimeout(2000);
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Agree')?.click();
}).catch(() => {});
await page.waitForTimeout(1000);

const countMsgs = () => page.evaluate(() => {
  // Text length, not child count — merged bubbles grow in place while streaming.
  const panel = Array.from(document.querySelectorAll('span'))
    .find((s) => s.textContent === 'EDITH' && s.className.includes('font-semibold'))
    ?.closest('.flex.flex-col.h-full');
  const scroller = panel?.querySelector('.overflow-y-auto');
  return scroller ? (scroller.textContent ?? '').length : -1;
});

// Kick off a turn that produces a LONG multi-line answer
await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'Do not use any OP or PLAN lines. Just talk: give me a very long, 15-paragraph explanation of documentary pacing, one paragraph at a time.');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(200);
await page.locator('textarea[placeholder*="edith" i]').press('Enter');

// Wait until the turn is actually RUNNING (Stop button visible), then Esc a few
// seconds in — mid-turn, before the answer can land. Waiting for visible text is
// a race: the whole answer can flush in one chunk, finishing before Esc arrives.
let running = false;
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  running = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some((x) => x.textContent?.trim() === 'Stop'));
  if (running) break;
  await page.waitForTimeout(500);
}
check('turn is running (Stop button visible)', running);
if (!running) process.exit(1);
await page.waitForTimeout(3000); // let the claude child actually spawn + stream
const base = await countMsgs();

// ESC — focus body first so the document-level handler fires
await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
await page.keyboard.press('Escape');
await page.waitForTimeout(1500);

const interrupted = await page.evaluate(() =>
  Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'Interrupted'));
check('Interrupted marker shown', interrupted);

// The real assertion: message count must FREEZE after Esc
const at2s = await countMsgs();
await page.waitForTimeout(8000);
const at10s = await countMsgs();
await page.waitForTimeout(12000);
const at22s = await countMsgs();
check('EDITH went silent after Esc', at2s === at10s && at10s === at22s, `counts ${at2s}/${at10s}/${at22s}`);

// No orphaned claude process left streaming
const status = await page.evaluate(() => ({
  idle: !Array.from(document.querySelectorAll('button')).some((x) => x.textContent?.trim() === 'Stop'),
}));
check('agent status back to idle (no Stop button)', status.idle);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
