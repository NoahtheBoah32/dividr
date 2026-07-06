// Live, fully-instrumented single EDITH send. Logs every signal every 2s so we can SEE
// exactly when EDITH starts thinking, responds, emits an op, and bakes — or where it stalls.
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO 5173 page'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[t+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = Date.now();

await page.addInitScript(() => { window.__dividrTestMode = true; });
await page.goto('http://localhost:5173/#/video-editor', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 20000 });
log('editor ready');

// inject the car clip
const path = 'C:/tmp/skills-test/walk3.mp4';
const pv = await page.evaluate(async (p) => { try { const r = await window.electronAPI.createPreviewUrl(p); return r?.url || (typeof r === 'string' ? r : ''); } catch { return ''; } }, path);
await page.evaluate(({ p, pv }) => {
  window.__dividrTest.setStoreState({
    tracks: [{ id: 'clip_a1', type: 'video', name: 'walk3.mp4', source: p, previewUrl: pv, startFrame: 0, endFrame: 210, duration: 210, sourceStartTime: 0, trackRowIndex: 0, mediaId: 'm1', visible: true, locked: false, muted: false, color: '#4A90D9' }],
    mediaLibrary: [{ id: 'm1', name: 'walk3.mp4', type: 'video', source: p, previewUrl: pv, duration: 7 }],
    preview: { canvasWidth: 1280, canvasHeight: 720 },
    timeline: { currentFrame: 8, fps: 30, selectedTrackIds: ['clip_a1'] },
  });
}, { p: path, pv });
log('clip injected');

// instrument EVERYTHING
await page.evaluate(() => {
  window.__cap = { messages: [], ops: [], status: [], done: false, invokes: [] };
  const orig = window.electronAPI.invoke.bind(window.electronAPI);
  window.electronAPI.invoke = (ch, ...a) => { window.__cap.invokes.push({ ch, at: Date.now() }); return orig(ch, ...a); };
  window.electronAPI.on('mycelium:message', (_e, d) => window.__cap.messages.push(d?.text ?? JSON.stringify(d)));
  window.electronAPI.on('mycelium:op', (_e, o) => window.__cap.ops.push(typeof o === 'string' ? o : JSON.stringify(o)));
  window.electronAPI.on('mycelium:done', () => { window.__cap.done = true; });
  window.addEventListener('edith:status', (e) => window.__cap.status.push(e.detail?.text || ''));
});

// open EDITH chat
if (await page.locator('textarea[placeholder*="reels"]').count() === 0) {
  try { await page.locator('[title="E.D.I.T.H"]').first().click({ timeout: 5000 }); } catch {}
}
const ta = page.locator('textarea[placeholder*="reels"]').first();
await ta.waitFor({ state: 'visible', timeout: 12000 });
log('EDITH textarea visible:', await ta.count() > 0);

// fill + confirm the React state actually received it
const prompt = 'freeze the world but let the car keep moving from 0 to 3 seconds';
await ta.fill(prompt);
await sleep(200);
const filledVal = await ta.inputValue();
log('after fill, textarea value =', JSON.stringify(filledVal.slice(0, 60)));

await ta.press('Enter');
log('pressed Enter — watching for EDITH to start...');

// poll every 2s for up to 90s
let lastLine = '';
for (let i = 0; i < 45; i++) {
  await sleep(2000);
  const s = await page.evaluate(() => {
    const t = window.__dividrTest.getStoreSnapshot().tracks?.[0];
    const bodyText = document.body.innerText;
    return {
      sendInvoked: window.__cap.invokes.filter((x) => x.ch === 'mycelium:sendMessage').length,
      freezeInvoked: window.__cap.invokes.filter((x) => x.ch === 'media:selectiveFreeze').length,
      msgs: window.__cap.messages.length,
      ops: window.__cap.ops.length,
      lastOp: window.__cap.ops[window.__cap.ops.length - 1] || '',
      status: window.__cap.status.slice(-1)[0] || '',
      done: window.__cap.done,
      thinking: /thinking|E\.D\.I\.T\.H/i.test(bodyText) ? (bodyText.match(/[^\n]*thinking[^\n]*/i)?.[0] || '').slice(0, 40) : '',
      source: (t?.source || '').split(/[\\/]/).pop(),
    };
  });
  const line = `send=${s.sendInvoked} freezeIPC=${s.freezeInvoked} msgs=${s.msgs} ops=${s.ops} done=${s.done} src=${s.source} status="${s.status.slice(0, 40)}"`;
  if (line !== lastLine) { log(line); if (s.lastOp) log('   lastOp:', s.lastOp.slice(0, 120)); lastLine = line; }
  if (s.done && s.source && s.source.includes('mfreeze')) { log('DONE + baked + source swapped'); break; }
}

const final = await page.evaluate(() => window.__cap);
log('FINAL messages:', JSON.stringify(final.messages));
log('FINAL ops:', JSON.stringify(final.ops));
log('FINAL status:', JSON.stringify(final.status));
log('FINAL invokes:', JSON.stringify(final.invokes.map((x) => x.ch)));
process.exit(0);
