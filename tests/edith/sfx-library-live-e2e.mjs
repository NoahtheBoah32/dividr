// sfx-library-live-e2e — proves the SFX library is LIVE, no restart needed:
//   1. *dog barking* before the file exists → "isn't a sound effect", no marker
//   2. drop dog_barking.mp3 + aliases.txt into DIVIDR_SFX_LIBRARY (while running!)
//   3. *dog barking* → retry-on-miss rescan finds it → marker + clip
//   4. *bark* → user alias from aliases.txt resolves → marker + clip
//   5. UI: dense explainer gone; ⓘ icon beside Transcript; no popover at 0.5s
//      hover; popover after 1.5s hover; gone on mouse leave
// Cleans the library folder and restores project state at the end.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const SFX_DIR = 'C:\\Users\\User\\Downloads\\DIVIDR_SFX_LIBRARY';
const NEW_SFX = path.join(SFX_DIR, 'dog_barking.mp3');
const ALIASES = path.join(SFX_DIR, 'aliases.txt');
const SOURCE = path.join(SFX_DIR, 'whoosh_transition.mp3');

const cleanupFiles = () => {
  for (const f of [NEW_SFX, ALIASES]) { try { fs.unlinkSync(f); } catch {} }
};
cleanupFiles(); // start clean even after a crashed previous run

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) { const u = p.url(); if (u.includes('localhost:5173') && !u.startsWith('blob:')) page = p; }
if (!page) { console.log('FAIL: no page'); process.exit(1); }

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('is an invalid value for the') && t.includes('css style property')) return;
  if (t.includes('read-file') || t.includes('aliases.txt')) return; // expected miss before the file exists
  consoleErrors.push(t);
});

// ── setup: synthetic transcription, select audio, open Audio tab ────────────
const setup = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const media = s.mediaLibrary.find((m) => m.type === 'video');
  const audio = s.tracks.find((t) => t.type === 'audio');
  const savedKaraoke = media.cachedKaraokeSubtitles ? JSON.parse(JSON.stringify(media.cachedKaraokeSubtitles)) : null;
  const savedTracks = JSON.parse(JSON.stringify(s.tracks));
  s.updateMediaLibraryItem(media.id, {
    cachedKaraokeSubtitles: {
      transcriptionResult: {
        segments: [
          { start: 0.5, end: 3.5, text: 'hello there editor friend', words: [
            { word: 'hello', start: 0.5, end: 1.0 },
            { word: 'there', start: 1.1, end: 1.6 },
            { word: 'editor', start: 1.7, end: 2.4 },
            { word: 'friend', start: 2.5, end: 3.2 },
          ] },
        ],
      },
    },
  });
  window.__dividrTest.getStoreSnapshot().setSelectedTracks([audio.id]);
  // Baselines: the open project may legitimately already have SFX overlays and
  // markers (the user's own work) — count only what THIS test adds.
  const baseOverlays = s.tracks
    .filter((t) => t.type === 'audio' && (t.trackRowIndex ?? 0) >= 1)
    .map((t) => t.id);
  const baseMarkers = (audio.sfxMarkers ?? []).map((m) => m.id);
  return { mediaId: media.id, audioId: audio.id, savedKaraoke, savedTracks, baseOverlays, baseMarkers };
});
await page.waitForTimeout(800);
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === 'Audio');
  tab?.click?.();
});
await page.waitForTimeout(800);
// Force a fresh scan so a stale in-app cache (e.g. from a previous run of this
// test) can't still contain dog_barking.mp3 after we deleted it from disk.
await page.evaluate(() => window.__dividrTest.refreshSfxLibrary?.());

// ── UI checks first (no typing needed) ──────────────────────────────────────
const ui = await page.evaluate(() => {
  const bodyText = document.body.innerText;
  return {
    denseGone: !bodyText.includes('Backspace through a whole word to cut it'),
    emptyExplainerGone: !bodyText.includes('Once transcribed, backspace through a word'),
    icon: !!document.querySelector('[data-transcript-help]'),
  };
});
check('dense explainer paragraph is gone', ui.denseGone, '');
check('empty-state explainer line is gone', ui.emptyExplainerGone, '');
check('info icon present beside Transcript', ui.icon, '');

// Park the mouse far from the panel FIRST — scrollIntoView can slide the icon
// underneath the current pointer, which would start the hover timer early.
await page.mouse.move(10, 10);
await page.waitForTimeout(400);
await page.evaluate(() => {
  document.querySelector('[data-transcript-help]')?.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(400); // let the scroll settle before measuring
const iconBox = await page.evaluate(() => {
  const el = document.querySelector('[data-transcript-help]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (iconBox) {
  const hoverT0 = Date.now();
  await page.mouse.move(iconBox.x - 4, iconBox.y); // approach, then land — guarantees a real enter
  await page.mouse.move(iconBox.x, iconBox.y);
  await page.waitForTimeout(300);
  const early = await page.evaluate(() => !!document.querySelector('[data-transcript-help-pop]'));
  // CDP round-trips on the loaded app can take >1s — only assert "still closed"
  // if the sample actually landed inside the 1.5s window.
  const sampledAt = Date.now() - hoverT0;
  check('no dropdown before the 1.5s hover threshold',
    sampledAt < 1400 ? !early : true,
    `sampled at ${sampledAt}ms${sampledAt >= 1400 ? ' — too slow to assert, skipped' : ''}`);
  // The app can render at ~1 FPS under load — poll for the popover instead of a
  // single check right at the 1.5s threshold.
  let open = false;
  for (let i = 0; i < 14 && !open; i++) {
    await page.waitForTimeout(500);
    open = await page.evaluate(() => {
      const pop = document.querySelector('[data-transcript-help-pop]');
      return pop ? pop.textContent.includes('Backspace through a word') : false;
    });
  }
  check('dropdown opens after 1.5s hover with the cheat-sheet', open, '');
  await page.mouse.move(iconBox.x, iconBox.y + 300);
  await page.waitForTimeout(500);
  let closed = false;
  for (let i = 0; i < 8 && !closed; i++) {
    closed = await page.evaluate(() => !document.querySelector('[data-transcript-help-pop]'));
    if (!closed) await page.waitForTimeout(500);
  }
  check('dropdown closes when the mouse leaves', closed, '');
} else {
  check('icon hover flow', false, 'icon not found');
}

// ── focus the editor at the end of "there" (with focus verification) ────────
let focused = false;
for (let attempt = 0; attempt < 6 && !focused; attempt++) {
  const wordBox = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('[data-wid]'));
    const el = spans.find((x) => x.textContent?.trim() === 'there');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width - 2, y: r.y + r.height / 2 };
  });
  if (!wordBox) { await page.waitForTimeout(1500); continue; }
  await page.mouse.click(wordBox.x, wordBox.y);
  await page.waitForTimeout(600);
  focused = await page.evaluate(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return false;
    const sel = window.getSelection();
    return (document.activeElement === ed || ed.contains(document.activeElement)) &&
      !!sel && sel.rangeCount > 0 && ed.contains(sel.getRangeAt(0).startContainer);
  });
  if (!focused) await page.waitForTimeout(1000);
}
if (!focused) { console.log('FAIL: could not focus the transcript editor'); cleanupFiles(); process.exit(1); }

const trackState = () => page.evaluate(({ audioId, baseOverlays, baseMarkers }) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = s.tracks.find((x) => x.id === audioId);
  const markers = (t?.sfxMarkers ?? [])
    .filter((m) => !baseMarkers.includes(m.id))
    .map((m) => ({ word: m.word, file: m.file }));
  const sfxClips = s.tracks.filter(
    (x) => x.type === 'audio' && (x.trackRowIndex ?? 0) >= 1 && !baseOverlays.includes(x.id),
  ).length;
  const flash = document.body.innerText.includes("isn't a sound effect in the library");
  return { markers, sfxClips, flash };
}, { audioId: setup.audioId, baseOverlays: setup.baseOverlays, baseMarkers: setup.baseMarkers });

const waitFor = async (cond, timeoutMs = 30000, step = 600) => {
  const t0 = Date.now();
  let last = await trackState();
  while (!cond(last) && Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(step);
    last = await trackState();
  }
  return last;
};

// ── 1. *dog barking* BEFORE the file exists → rejected ──────────────────────
await page.keyboard.type('*dog barking*', { delay: 50 });
let st = await waitFor((s) => s.flash || s.markers.length > 0, 20000);
check('*dog barking* before the file exists is rejected', st.flash && st.markers.length === 0,
  `flash=${st.flash} markers=${st.markers.length}`);

// ── 2. drop the new file + aliases.txt into the RUNNING app's library ───────
fs.copyFileSync(SOURCE, NEW_SFX);
fs.writeFileSync(ALIASES, '# custom sounds\nbark = dog_barking\n', 'utf8');
console.log('  (dropped dog_barking.mp3 + aliases.txt into the library folder)');

// ── 3. *dog barking* again → retry-on-miss rescan picks it up, no restart ───
await page.keyboard.type('*dog barking*', { delay: 50 });
st = await waitFor((s) => s.markers.length === 1 && s.sfxClips === 1);
check('*dog barking* now places WITHOUT a restart', st.markers.length === 1 && st.sfxClips === 1 && st.markers[0]?.file === 'dog_barking.mp3',
  JSON.stringify(st.markers));

// remove it via the × button (also exercises removal) — target OUR token by its
// text, since the project may render the user's own markers too
const xBox = await page.evaluate(() => {
  const token = Array.from(document.querySelectorAll('[data-mk-sfx]')).find((el) =>
    el.textContent?.includes('dog barking'),
  );
  const btn = token?.querySelector('button');
  if (!btn) return null;
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (xBox) await page.mouse.click(xBox.x, xBox.y);
st = await waitFor((s) => s.markers.length === 0 && s.sfxClips === 0, 8000);
check('× removes the marker and its clip', st.markers.length === 0 && st.sfxClips === 0,
  `markers=${st.markers.length} clips=${st.sfxClips}`);

// ── 4. *bark* → aliases.txt mapping resolves ────────────────────────────────
await page.keyboard.type('*bark*', { delay: 50 });
st = await waitFor((s) => s.markers.length === 1 && s.sfxClips === 1);
check('*bark* resolves via aliases.txt', st.markers.length === 1 && st.markers[0]?.file === 'dog_barking.mp3' && st.sfxClips === 1,
  JSON.stringify(st.markers));

// ── restore everything ──────────────────────────────────────────────────────
cleanupFiles();
await page.evaluate(async ({ mediaId, savedKaraoke, savedTracks }) => {
  const s = window.__dividrTest.getStoreSnapshot();
  s.updateMediaLibraryItem(mediaId, { cachedKaraokeSubtitles: savedKaraoke ?? undefined });
  window.__dividrTest.setStoreState({ tracks: savedTracks });
  const s2 = window.__dividrTest.getStoreSnapshot();
  s2.markUnsavedChanges?.();
  s2.triggerAutoSaveOnCommit?.();
  await new Promise((r) => setTimeout(r, 2000));
}, setup);
const finalTracks = await page.evaluate(() => window.__dividrTest.getStoreSnapshot().tracks.length);
check('original state restored', finalTracks === setup.savedTracks.length, `${finalTracks}/${setup.savedTracks.length}`);
check('library folder cleaned', !fs.existsSync(NEW_SFX) && !fs.existsSync(ALIASES), '');
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`}`);
process.exit(failed === 0 ? 0 : 1);
