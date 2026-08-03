import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

// 1. Open the audio tools panel and force a library scan — on a fresh boot the
//    SFX cache is empty and the panel mounts before the scan lands (race).
const opened = await page.evaluate(async () => {
  try { return await window.__dividrTest.openPanel('audio-tools'); } catch (e) { return 'err: ' + e.message; }
});
console.log('openPanel(audio):', JSON.stringify(opened));
await page.evaluate(async () => { try { await window.__dividrTest.refreshSfxLibrary(); } catch {} });
await sleep(2500);

// 2. SFX section rendered with entries — poll up to 20s for the list to populate
let section = null;
for (let i = 0; i < 10; i++) {
  section = await page.evaluate(() => {
    const search = document.querySelector('input[placeholder="Search sounds…"]');
    if (!search) return null;
    const rows = document.querySelectorAll('[title$="drag onto the timeline"]');
    const select = search.parentElement.querySelector('select');
    return { rows: rows.length, categories: select ? select.options.length : 0 };
  });
  if (section && section.rows > 0) break;
  await sleep(2000);
}
check('SFX section renders', !!section, JSON.stringify(section));
if (!section || section.rows === 0) { await page.screenshot({ path: 'C:/tmp/dividr-demo-research/sfx_fail.png' }); console.log('no rows — shot: C:/tmp/dividr-demo-research/sfx_fail.png'); process.exit(1); }
check('library entries listed', section.rows > 50, `${section.rows} rows`);
check('category dropdown populated', section.categories > 2, `${section.categories} options`);

// 3. Preview: click the first play button, confirm an <audio> is actually playing
const playing = await page.evaluate(async () => {
  const row = document.querySelector('[title$="drag onto the timeline"]');
  const btn = row.querySelector('button');
  btn.click();
  await new Promise((r) => setTimeout(r, 1200));
  // The section keeps one Audio() alive — not in DOM, so probe via the button icon flip
  const iconNow = btn.innerHTML.includes('lucide-pause') || btn.title === 'Stop preview';
  btn.click(); // stop it again
  return iconNow;
});
check('play-preview toggles to playing state', playing);

// 4. Search filters
const filtered = await page.evaluate(async () => {
  const search = document.querySelector('input[placeholder="Search sounds…"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(search, 'whoosh');
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const rows = document.querySelectorAll('[title$="drag onto the timeline"]');
  const names = [...rows].slice(0, 3).map((r) => r.getAttribute('title'));
  setter.call(search, '');
  search.dispatchEvent(new Event('input', { bubbles: true }));
  return { count: rows.length, names };
});
check('search filters the list', filtered.count > 0 && filtered.count < section.rows, JSON.stringify(filtered));

// 5. Drop simulation: synthetic drop on the tracks area with the SFX mime
const drop = await page.evaluate(async () => {
  const s = window.__videoEditorStore.getState();
  const before = s.tracks.filter((t) => t.type === 'audio').length;
  const row = document.querySelector('[title$="drag onto the timeline"]');
  // Recover the real entry name: title strips extension, so read from cache via a drag event
  const dt = new DataTransfer();
  const dragStart = new DragEvent('dragstart', { dataTransfer: dt, bubbles: true });
  row.dispatchEvent(dragStart);
  const payload = dt.getData('application/x-dividr-sfx');
  if (!payload) return { error: 'dragstart set no payload' };

  const tracksEl = document.querySelector('.timeline-tracks-scroll');
  const rect = tracksEl.getBoundingClientRect();
  const dropEvt = new DragEvent('drop', {
    dataTransfer: dt,
    bubbles: true,
    cancelable: true,
    clientX: rect.left + 300,
    clientY: rect.top + 40,
  });
  tracksEl.dispatchEvent(dropEvt);
  await new Promise((r) => setTimeout(r, 2500));
  const s2 = window.__videoEditorStore.getState();
  const after = s2.tracks.filter((t) => t.type === 'audio');
  const newClip = after.find((t) => t.trackRowIndex === 1 && t.type === 'audio');
  return {
    payload: JSON.parse(payload).name,
    before,
    afterCount: after.length,
    newClip: newClip ? { name: newClip.name, start: newClip.startFrame, end: newClip.endFrame, duration: newClip.duration, row: newClip.trackRowIndex } : null,
  };
});
console.log('drop result:', JSON.stringify(drop));
check('drag payload carries entry name', !!drop.payload);
check('drop placed an SFX clip on row 1', !!drop.newClip && drop.afterCount > drop.before, JSON.stringify(drop.newClip));
check('placed clip has export-safe duration', !!drop.newClip && Number.isFinite(drop.newClip.duration) && drop.newClip.duration > 0);

// 6. Undo the drop so the project is left clean
await page.evaluate(() => {
  const s = window.__videoEditorStore.getState();
  const clip = s.tracks.find((t) => t.type === 'audio' && t.trackRowIndex === 1);
  if (clip) s.removeTrack(clip.id);
});

await page.screenshot({ path: 'C:/tmp/dividr-demo-research/sfx_panel.png' });
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} passed — shot: C:/tmp/dividr-demo-research/sfx_panel.png`);
process.exit(passed === results.length ? 0 : 1);
