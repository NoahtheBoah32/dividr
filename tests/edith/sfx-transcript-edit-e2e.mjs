// sfx-transcript-edit-e2e — REAL keystrokes against the transcript SFX editing fixes:
//   1. Typing *whoosh* places the clip + yellow committed marker (baseline)
//   2. ONE backspace melts the marker: text block survives, buffer shows "*whoosh",
//      clip lifts off the timeline (no more nuke-the-whole-block)
//   3. Further backspaces delete ONE character at a time
//   4. Retyping the closing * re-places the sound (reversible)
//   5. Tab away / switch tabs: the pending buffer SURVIVES
//   6. Clicking the committed yellow token, then backspace, edits it (re-click works)
// Injects a synthetic transcription into the media item; restores everything after.
import { chromium } from 'playwright-core';

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
  consoleErrors.push(t);
});

// ── setup: synthetic transcription on the media item, select audio track ────
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
  const s2 = window.__dividrTest.getStoreSnapshot();
  s2.setSelectedTracks([audio.id]);
  // Baselines: the open project may already have SFX overlays/markers (the user's
  // own work) — this test must only count what it adds itself.
  const baseOverlays = s.tracks
    .filter((t) => t.type === 'audio' && (t.trackRowIndex ?? 0) >= 1)
    .map((t) => t.id);
  const baseMarkers = (audio.sfxMarkers ?? []).map((m) => m.id);
  return { mediaId: media.id, audioId: audio.id, savedKaraoke, savedTracks, baseOverlays, baseMarkers };
});
await page.waitForTimeout(800);

// Open the Audio tab if there's a tab bar (audio track selected → audio props directly)
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === 'Audio');
  tab?.click?.();
});
await page.waitForTimeout(600);

// Find the word "there" in the transcript, click at its end, and VERIFY focus
// actually landed inside the editor (the app can drop clicks under load).
let focused = false;
for (let attempt = 0; attempt < 6 && !focused; attempt++) {
  const wordBox = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('[data-wid]'));
    const el = spans.find((x) => x.textContent?.trim() === 'there');
    if (!el) return { found: spans.length, texts: spans.slice(0, 4).map((x) => x.textContent) };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width - 2, y: r.y + r.height / 2, ok: true };
  });
  if (!wordBox.ok) {
    if (attempt === 5) { console.log('FAIL: transcript words not rendered', JSON.stringify(wordBox)); process.exit(1); }
    await page.waitForTimeout(1500);
    continue;
  }
  await page.mouse.click(wordBox.x, wordBox.y);
  await page.waitForTimeout(600);
  focused = await page.evaluate(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return false;
    const sel = window.getSelection();
    const inEditor = document.activeElement === ed || ed.contains(document.activeElement);
    const caretIn = !!sel && sel.rangeCount > 0 && ed.contains(sel.getRangeAt(0).startContainer);
    return inEditor && caretIn;
  });
  if (!focused) await page.waitForTimeout(1000);
}
if (!focused) { console.log('FAIL: could not focus the transcript editor'); process.exit(1); }

const trackState = () => page.evaluate(({ audioId, baseOverlays, baseMarkers }) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const t = s.tracks.find((x) => x.id === audioId);
  const markers = (t?.sfxMarkers ?? [])
    .filter((m) => !baseMarkers.includes(m.id))
    .map((m) => ({ word: m.word, atFrame: m.atFrame }));
  const sfxClips = s.tracks.filter(
    (x) => x.type === 'audio' && (x.trackRowIndex ?? 0) >= 1 && !baseOverlays.includes(x.id),
  ).length;
  const typingEl = document.querySelector('[data-typing]');
  // Count only OUR tokens ('bell') — the user's own markers may render too.
  const mkEls = Array.from(document.querySelectorAll('[data-mk-sfx]')).filter((el) =>
    el.textContent?.includes('bell'),
  ).length;
  const wordCount = document.querySelectorAll('[data-wid]').length;
  return { markers, sfxClips, typingText: typingEl?.textContent ?? null, mkEls, wordCount };
}, { audioId: setup.audioId, baseOverlays: setup.baseOverlays, baseMarkers: setup.baseMarkers });

// Placement after *word* completes is ASYNC (library scan + op pipeline) — poll
// instead of guessing a fixed wait.
const waitFor = async (cond, timeoutMs = 15000, step = 500) => {
  const t0 = Date.now();
  let last = await trackState();
  while (!cond(last) && Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(step);
    last = await trackState();
  }
  return last;
};

// ── 1. type *bell* → committed marker + clip ('bell' can't collide with any
//      marker the user already placed themselves) ─────────────────────────────
await page.keyboard.type('*bell*', { delay: 60 });
let st = await waitFor((s) => s.markers.length === 1 && s.sfxClips === 1);
check('typing *bell* commits a yellow marker', st.markers.length === 1 && st.mkEls === 1,
  JSON.stringify(st.markers));
check('typing *bell* places a clip on the timeline', st.sfxClips === 1, `sfxClips=${st.sfxClips}`);
const wordCountBefore = st.wordCount;

// ── 2. ONE backspace melts (no block nuke) ──────────────────────────────────
await page.keyboard.press('Backspace');
st = await waitFor((s) => s.markers.length === 0 && s.sfxClips === 0, 6000);
check('one backspace melts the marker into editable text', st.markers.length === 0 && st.typingText === '*bell',
  `markers=${st.markers.length} typing=${JSON.stringify(st.typingText)}`);
check('melt lifts the clip off the timeline', st.sfxClips === 0, `sfxClips=${st.sfxClips}`);
check('the transcript text block SURVIVES the backspace', st.wordCount === wordCountBefore,
  `${st.wordCount}/${wordCountBefore} words`);

// ── 3. char-by-char backspace ───────────────────────────────────────────────
await page.keyboard.press('Backspace');
await page.keyboard.press('Backspace');
await page.waitForTimeout(400);
st = await trackState();
check('further backspaces delete one character at a time', st.typingText === '*be',
  `typing=${JSON.stringify(st.typingText)}`);

// ── 4. retype to completion → re-places ─────────────────────────────────────
await page.keyboard.type('ll*', { delay: 60 });
st = await waitFor((s) => s.markers.length === 1 && s.sfxClips === 1);
check('retyping the closing * re-places the sound', st.markers.length === 1 && st.sfxClips === 1,
  `markers=${st.markers.length} clips=${st.sfxClips}`);

// ── 5. pending buffer survives switching tabs ───────────────────────────────
await page.keyboard.type('*bel', { delay: 50 }); // new pending annotation
await page.waitForTimeout(300);
await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.find((el) => el.textContent?.trim() === 'Video')?.click?.();
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.find((el) => el.textContent?.trim() === 'Audio')?.click?.();
});
await page.waitForTimeout(800);
st = await trackState();
check('pending *bel survives switching tabs', st.typingText === '*bel',
  `typing=${JSON.stringify(st.typingText)}`);
// Clear the pending buffer so it can't contaminate the next checks: click at the
// END of the typing span, then backspace exactly its current length.
const typingLen = await page.evaluate(() => {
  const span = document.querySelector('[data-typing]');
  if (!span) return { len: 0 };
  span.scrollIntoView({ block: 'center' });
  const r = span.getBoundingClientRect();
  return { len: span.textContent?.length ?? 0, x: r.x + r.width - 1, y: r.y + r.height / 2 };
});
if (typingLen.len > 0) {
  await page.mouse.click(typingLen.x, typingLen.y);
  await page.waitForTimeout(300);
  for (let i = 0; i < typingLen.len; i++) {
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(120);
  }
}
await page.waitForTimeout(400);
st = await trackState();
check('pending buffer cleared without touching words', st.typingText === null && st.wordCount === wordCountBefore,
  `typing=${JSON.stringify(st.typingText)} words=${st.wordCount}/${wordCountBefore}`);

// ── 6. click the committed token → backspace edits it ───────────────────────
const tokenBox = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('[data-mk-sfx]')).find((x) =>
    x.textContent?.includes('bell'),
  );
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2 - 8, y: r.y + r.height / 2 }; // avoid the × at the right edge
});
check('committed token present for click test', !!tokenBox, '');
if (tokenBox) {
  await page.mouse.click(tokenBox.x, tokenBox.y);
  await page.waitForTimeout(400);
  await page.keyboard.press('Backspace');
  st = await waitFor((s) => s.markers.length === 0 && s.sfxClips === 0, 6000);
  check('click token + backspace melts it (re-click works)',
    st.markers.length === 0 && st.typingText === '*bell' && st.sfxClips === 0,
    `markers=${st.markers.length} typing=${JSON.stringify(st.typingText)} clips=${st.sfxClips}`);
}

// Cancel the leftover '*bell' pending buffer (Escape → cancelTyping clears the
// survive-unmount cache too) so nothing lingers on the user's real transcript.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ── restore everything (and persist) ────────────────────────────────────────
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
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`}`);
process.exit(failed === 0 ? 0 : 1);
