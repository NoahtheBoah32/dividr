// Live full-chain EDITH test: type real messages into the actual chat panel,
// let the real agent runtime run, and verify the ops LAND in the store.
// Covers: chat → agentRuntime (claude CLI) → OP parse → operationEngine → store.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

for (let i = 0; i < 10; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2000);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await page.waitForTimeout(2000);
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => x.textContent?.trim() === 'Agree')?.click();
}).catch(() => {});
await page.waitForTimeout(1500);

const sendChat = async (msg) => {
  const ok = await page.evaluate((text) => {
    const ta = Array.from(document.querySelectorAll('textarea'))
      .find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, msg);
  if (!ok) return false;
  await page.waitForTimeout(400);
  // send = the enter key on the textarea (the app's primary path)
  const ta = page.locator('textarea[placeholder*="reels" i]');
  await ta.press('Enter');
  return true;
};

const waitFor = async (predicate, timeoutMs = 150000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const val = await page.evaluate(predicate).catch(() => null);
    if (val) return val;
    await page.waitForTimeout(2500);
  }
  return null;
};

// clean slate for the two probes
await page.evaluate(async () => {
  window.__dividrTest.applyOps([
    { type: 'setClipColor', clear: true },
    { type: 'adjust', reset: true },
  ]);
  await window.__dividrTest.waitForQueueDrained();
});
await page.waitForTimeout(600);

// ── chat 1: Labels/Colors through the real EDITH ─────────────────────────
console.log('chat: "label this clip orange" (real EDITH run — up to ~2 min)');
const sent1 = await sendChat('label this clip orange');
check('chat message 1 sent', sent1);
const label = await waitFor(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  return v?.labelColor ?? null;
});
check('EDITH labels the clip via setClipColor', label === '#f97316', String(label));

// ── chat 2: film grain through the real EDITH ────────────────────────────
console.log('chat: "add heavy film grain" (real EDITH run)');
const sent2 = await sendChat('add heavy film grain');
check('chat message 2 sent', sent2);
const grain = await waitFor(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  const g = v?.colorGrade?.grain ?? 0;
  return g > 0 ? g : null;
});
check('EDITH bakes grain via adjust', !!grain && grain > 0, `grain=${grain}`);

// integrity: her last replies must not be empty/trailing off
const replies = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('[data-role="edith"], [class*="message"]'));
  return nodes.slice(-6).map((n) => (n.textContent ?? '').trim()).filter(Boolean);
});
check('EDITH replied with real text (no trail-off)', replies.some((r) => r.length > 10),
  (replies[replies.length - 1] ?? '').slice(0, 80));

await page.screenshot({ path: 'C:/tmp/skills93-chat.png' }).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
