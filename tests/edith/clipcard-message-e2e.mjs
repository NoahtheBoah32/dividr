// Clip-card MESSAGE e2e — verifies Joaquin's second report:
// (1) a sent message with an attached clip renders a Gemini-style card on the
//     bubble (thumbnail + duration pill + times), never raw [clip …] token text;
// (2) leaving/reloading and coming back re-hydrates history as the same clean
//     card (the reported bug: raw token text appeared after returning);
// (3) EDITH still receives the token and performs the op (display-only change).
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }
// The app arms a beforeunload nav-blocker; without a handler playwright's
// auto-dismiss races the dialog teardown and hard-crashes the script.
page.on('dialog', async (d) => { try { await d.accept(); } catch { /* already gone */ } });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const waitBridge = async () => {
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(() => !!window.__dividrTest).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(2500);
  }
  return false;
};

const openTestProject = async () => {
  await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
  await page.waitForTimeout(4500);
  await page.evaluate(() => window.__dividrTest.openPanel('friday'));
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Agree')?.click();
  }).catch(() => {});
  await page.waitForTimeout(1200);
};

// Chat-state probe. Message cards vs input cards are disambiguated by the ×
// remove button: input cards have it, sent-bubble cards don't.
const probeChat = () => page.evaluate(() => {
  const ps = Array.from(document.querySelectorAll('p')).filter((p) => /on timeline/.test(p.textContent ?? ''));
  const inputCards = ps.filter((p) => p.closest('div[style*="width: 148"]')?.querySelector('button[aria-label="Remove clip"]'));
  const rawTokenVisible = Array.from(document.querySelectorAll('span, p, div'))
    .some((el) => el.children.length === 0 && /\[clip "/.test(el.textContent ?? ''));
  const ta = Array.from(document.querySelectorAll('textarea')).find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  return {
    totalCards: ps.length,
    inputCards: inputCards.length,
    messageCards: ps.length - inputCards.length,
    rawTokenVisible,
    inputValue: ta?.value ?? '',
  };
});

// ── Phase 1: reload → hydration path. Prior e2e runs left history entries with
// [clip …] tokens in this project — they must come back as cards, not raw text.
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
if (!(await waitBridge())) { console.log('bridge never came up'); process.exit(1); }
await openTestProject();
let st = await probeChat();
check('hydrated history: raw [clip …] token NOT visible', !st.rawTokenVisible);
check('hydrated history: prior clip message renders as card', st.messageCards >= 1, `${st.messageCards} message cards`);

// ── Phase 2: live send — card must appear ON the sent bubble with clean text ──
const clip = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = s.tracks.find((t) => t.type === 'video');
  return v ? { id: v.id, startFrame: v.startFrame, endFrame: v.endFrame } : null;
});
if (!clip) { console.log('no video clip in scratch project'); process.exit(1); }

const geo = await page.evaluate((clipId) => {
  const el = document.querySelector(`[data-edith-target="track-body:${clipId}"]`);
  const ta = Array.from(document.querySelectorAll('textarea')).find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  if (!el || !ta) return { ok: false };
  const cr = el.getBoundingClientRect();
  const ir = ta.getBoundingClientRect();
  return { ok: true, cx: cr.x + Math.min(50, cr.width / 2), cy: cr.y + cr.height / 2, ix: ir.x + ir.width / 2, iy: ir.y + ir.height / 2 };
}, clip.id);
check('drag geometry resolved', geo.ok);
if (!geo.ok) process.exit(1);

await page.mouse.move(geo.cx, geo.cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(geo.cx + ((geo.ix - geo.cx) * i) / 10, geo.cy + ((geo.iy - geo.cy) * i) / 10, { steps: 3 });
  await page.waitForTimeout(60);
}
await page.mouse.up();
await page.waitForTimeout(900);

st = await probeChat();
check('drop: card appears in INPUT area', st.inputCards === 1, `${st.inputCards} input cards`);
const beforeMsgCards = st.messageCards;

const MSG = 'set this clip\'s label color to green';
await page.evaluate((msg) => {
  const ta = Array.from(document.querySelectorAll('textarea')).find((t) => (t.placeholder ?? '').toLowerCase().includes('reels'));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, msg);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, MSG);
await page.waitForTimeout(300);
await page.locator('textarea[placeholder*="reels" i]').press('Enter');
await page.waitForTimeout(1500);

st = await probeChat();
const bubble = await page.evaluate((msg) => {
  const el = Array.from(document.querySelectorAll('span')).find((x) => (x.textContent ?? '').trim() === msg);
  return !!el;
}, MSG);
check('sent bubble: card moved onto the MESSAGE', st.messageCards === beforeMsgCards + 1 && st.inputCards === 0,
  `msg cards ${beforeMsgCards}→${st.messageCards}, input cards ${st.inputCards}`);
check('sent bubble: clean text shown (no token)', bubble && !st.rawTokenVisible);
check('input cleared after send', st.inputValue === '');
await page.screenshot({ path: 'C:/tmp/clipcard-msg.png' }).catch(() => {});

// ── Phase 3: EDITH still receives the token — she must label THIS clip ──
console.log('waiting for real EDITH to perform the label op…');
let labeled = null;
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  labeled = await page.evaluate((clipId) => {
    const v = window.__dividrTest.getStoreSnapshot().tracks.find((t) => t.id === clipId);
    return v?.labelColor ?? null;
  }, clip.id).catch(() => null);
  if (labeled) break;
  await page.waitForTimeout(3000);
}
check('EDITH read the token and labeled the clip green', /green|#2 ?2c55e|#22c55e/i.test(String(labeled)), String(labeled));

// ── Phase 4: reload AGAIN — the just-sent message must hydrate as a card ──
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
if (!(await waitBridge())) { console.log('bridge lost after reload'); process.exit(1); }
await openTestProject();
st = await probeChat();
const bubbleAfter = await page.evaluate((msg) => {
  return Array.from(document.querySelectorAll('span')).some((x) => (x.textContent ?? '').trim() === msg);
}, MSG);
check('after reload: raw token still NOT visible', !st.rawTokenVisible);
check('after reload: sent message hydrates as card + clean text', st.messageCards >= beforeMsgCards + 1 && bubbleAfter,
  `${st.messageCards} message cards`);
await page.screenshot({ path: 'C:/tmp/clipcard-msg-rehydrated.png' }).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
