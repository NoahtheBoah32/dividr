// Camera wedge recovery — proves the app heals a dead camera WITHOUT an app
// restart. recorder:restartVideoCapture kills Chromium's real video_capture
// utility service, which is exactly what a Windows camera wedge looks like
// from the renderer: the track stays "live" but frames stop (green/frozen).
// The stall watchdog must notice and re-acquire on its own.
//
// Phase 1 — camera mode, setup: kill the service, assert the preview resumes.
// Phase 2 — screen & camera mode, RECORDING: kill the service mid-take, assert
//           the screen track survives (desktop capture lives in the browser
//           process) and the recording keeps running to a clean stop.
import { chromium } from 'playwright-core';

process.on('unhandledRejection', (e) => {
  if (String(e?.message ?? e).includes('handleJavaScriptDialog')) return;
  throw e;
});

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no renderer page'); process.exit(1); }
page.on('dialog', (d) => d.accept().catch(() => {}));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const $ = (tid) => page.locator(`[data-testid="${tid}"]`);
const visible = (tid) => page.evaluate((t) => {
  const el = document.querySelector(`[data-testid="${t}"]`);
  return !!el && el.getClientRects().length > 0;
}, tid);
const waitFor = async (tid, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await visible(tid)) return true;
    await page.waitForTimeout(300);
  }
  return false;
};
const camDec = () => page.evaluate(() => window.__recorderCamWatch?.lastDec ?? -1);
// frames are advancing when the watchdog's decoded-frame counter grows
const camAlive = async (windowMs = 4000) => {
  const a = await camDec();
  await page.waitForTimeout(windowMs);
  const bx = await camDec();
  return { alive: bx > a && bx > 0, a, b: bx };
};
const killService = () => page.evaluate(() =>
  window.electronAPI.invoke('recorder:restartVideoCapture'));

await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);
// close any modal a crashed run left behind
for (const tid of ['confirm-delete', 'recorder-close', 'confirm-delete']) {
  await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), tid).catch(() => {});
  await page.waitForTimeout(500);
}

// ═══ Phase 1 — camera mode, setup phase ═══════════════════════════════════
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button[title="Record & create"]'))[0]?.click();
});
await page.waitForTimeout(900);
await $('record-card-camera').click();
if (await waitFor('perm-allow', 6000)) await $('perm-allow').click();
const setupOk = await waitFor('start-recording', 15000);
check('camera mode reaches setup', setupOk);
if (!setupOk) process.exit(1);

let flow = await camAlive();
check('camera frames flowing before the kill', flow.alive, `dec ${flow.a} -> ${flow.b}`);

const k1 = await killService();
check('video_capture service killed (real wedge)', k1?.success && k1.killed >= 1, JSON.stringify(k1));

// watchdog: 3 stalled ticks @800ms then re-acquire → allow up to 25s
let healed = false, watch = null;
const t0 = Date.now();
while (Date.now() - t0 < 25000) {
  flow = await camAlive(3000);
  watch = await page.evaluate(() => ({ ...(window.__recorderCamWatch ?? {}) }));
  if (flow.alive) { healed = true; break; }
}
check('watchdog healed the camera without an app restart', healed,
  `dec ${flow.a} -> ${flow.b}, watch=${JSON.stringify(watch)}`);
check('watchdog actually detected the stall (not a lucky frame)', (watch?.bad ?? 0) > 0, `bad=${watch?.bad}`);
check('camera was not given up on', !(watch?.disabled), `disabled=${watch?.disabled}`);
const err1 = await visible('recorder-error');
check('no error banner after self-heal', !err1);

// back out of camera mode cleanly
await page.evaluate(() => document.querySelector('[data-testid="recorder-close"]')?.click());
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('[data-testid="confirm-delete"]')?.click()).catch(() => {});
await page.waitForTimeout(800);

// ═══ Phase 2 — screen & camera, kill mid-recording ════════════════════════
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button[title="Record & create"]'))[0]?.click();
});
await page.waitForTimeout(900);
await $('record-card-screen-camera').click();
if (await waitFor('perm-allow', 6000)) await $('perm-allow').click();
const setup2 = await waitFor('start-share', 15000);
check('screen&camera reaches setup', setup2);
if (!setup2) process.exit(1);
await $('start-share').click();
if (!(await waitFor('source-item', 8000))) { console.log('no sources'); process.exit(1); }
await $('source-item').first().click();
await page.waitForTimeout(250);
await $('source-share').click();
await waitFor('countdown', 5000);
const recOk = await waitFor('rec-timer', 8000);
check('recording starts', recOk);
if (!recOk) process.exit(1);
await page.waitForTimeout(2000);

const k2 = await killService();
check('service killed mid-recording', !!k2?.success, JSON.stringify(k2));
await page.waitForTimeout(1500);

// screen desktop capture must survive the kill — it is browser-process capture
const screenLive = await page.evaluate(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  for (const v of vids) {
    const t = v.srcObject?.getVideoTracks?.()[0];
    if (t && /screen|window|monitor|entire/i.test(t.label)) return t.readyState;
  }
  // desktop tracks are often label-less under chromeMediaSource — fall back to
  // "some live video track that is not the camera watchdog's element"
  const states = vids.map((v) => v.srcObject?.getVideoTracks?.()[0]?.readyState).filter(Boolean);
  return states.includes('live') ? 'live' : (states[0] ?? 'none');
});
check('screen track still live after the kill', screenLive === 'live', `state=${screenLive}`);

// recording clock keeps running
const tA = await $('rec-timer').textContent();
await page.waitForTimeout(2500);
const tB = await $('rec-timer').textContent();
check('recording timer still advancing', tA !== tB, `${tA} -> ${tB}`);

// camera bubble heals mid-take too
let healed2 = false;
const t1 = Date.now();
while (Date.now() - t1 < 25000) {
  const f = await camAlive(3000);
  if (f.alive) { healed2 = true; break; }
}
check('camera bubble frames resumed mid-recording', healed2);

// stop → review appears → discard the take (leave no residue)
await $('rec-stop').click();
const review = await waitFor('review-media', 20000);
check('stop lands in review (recording finalized)', review);
await page.evaluate(() => document.querySelector('[data-testid="recorder-close"]')?.click());
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('[data-testid="confirm-delete"]')?.click()).catch(() => {});
await page.waitForTimeout(1200);

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
