// Quick probe: what the live app's test bridge + store expose for the stabilization tests.
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL no page'); process.exit(1); }

for (let i = 0; i < 30; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest && !!window.__videoEditorStore).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2000);
}

const info = await page.evaluate(() => {
  const bridge = Object.keys(window.__dividrTest ?? {});
  const store = window.__videoEditorStore?.getState?.() ?? {};
  const storeKeys = Object.keys(store).filter((k) => /export|import|addTrack|media|project/i.test(k)).slice(0, 30);
  const projects = (store.projects ?? []).map?.((p) => p.title) ?? 'n/a';
  return { bridge, storeKeys, currentProject: store.currentProject?.title ?? store.projectTitle ?? null };
});
console.log(JSON.stringify(info, null, 1));
process.exit(0);
