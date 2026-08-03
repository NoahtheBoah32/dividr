// Media-card probe — EDITH's own fetches must land in the chat as playable
// Gemini-style cards (#85): approve → import → card appears; click → full-size
// preview opens; Esc closes the preview (never interrupts EDITH); the card
// survives a project reload via the persisted [fetched …] token.
// Drives the REAL downloadApprovalStore path with a local file — no network.
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

const CARD_TITLE = 'Probe B-roll Card';

// ── Act 1: run a real approve() with an existing local video file ─────────
const approved = await page.evaluate(async (title) => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = (s.mediaLibrary ?? []).find((m) => m.type === 'video' && m.source && !m.source.startsWith('blob:'))
    ?? (s.tracks ?? []).find((t) => t.type === 'video' && t.source && !t.source.startsWith('blob:'));
  if (!v) return { ok: false, why: 'no local video in library or timeline' };
  const store = window.__dividrTest.getDownloadApprovalStore().getState();
  const id = 'probe-' + Math.random().toString(36).slice(2);
  const fileName = v.source.replace(/\\/g, '/').split('/').pop();
  store.enqueue({ id, filePath: v.source, fileName, fileType: 'video', sourceUrl: 'test://media-card-probe', title });
  // triggerContinue=false — must NOT spawn a live EDITH turn
  await window.__dividrTest.getDownloadApprovalStore().getState().approve(id, false);
  return { ok: true, srcFile: fileName };
}, CARD_TITLE);
check('real approve() ran with a local file', approved.ok, approved.why ?? approved.srcFile);
if (!approved.ok) process.exit(1);
await page.waitForTimeout(2500);

// ── Assert 1: card rendered in the chat with title, caption, duration pill ──
const findCard = (title) => page.evaluate((t) => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((x) => x.textContent?.includes(t) && x.textContent?.includes('Fetched by EDITH'));
  if (!btn) return { found: false };
  const pill = Array.from(btn.querySelectorAll('span')).map((sp) => sp.textContent ?? '')
    .find((x) => /^\d+:\d{2}$/.test(x.trim()));
  const hasThumb = !!btn.querySelector('img, video');
  return { found: true, pill: pill ?? null, hasThumb, disabled: btn.disabled };
}, title);
let card = await findCard(CARD_TITLE);
check('card appears in chat', card.found);
if (!card.found) process.exit(1);
check('card shows m:ss duration pill', !!card.pill, String(card.pill));
check('card shows a thumbnail element', card.hasThumb);
check('card is clickable (media resolved)', !card.disabled);
await page.screenshot({ path: 'C:/tmp/media-card.png' }).catch(() => {});

// ── Act 2: click the card → full-size preview overlay ─────────────────────
await page.evaluate((t) => {
  Array.from(document.querySelectorAll('button'))
    .find((x) => x.textContent?.includes(t) && x.textContent?.includes('Fetched by EDITH'))?.click();
}, CARD_TITLE);
await page.waitForTimeout(1800);
const overlay = await page.evaluate(() => {
  const layer = Array.from(document.querySelectorAll('div'))
    .find((d) => d.className.includes('z-[100]') && d.className.includes('fixed'));
  if (!layer) return { open: false };
  const v = layer.querySelector('video');
  return {
    open: true,
    hasVideo: !!v,
    hasControls: !!v?.controls,
    playing: v ? (v.currentTime > 0 || v.readyState >= 2) : false,
  };
});
check('preview overlay opens on click', overlay.open);
check('overlay has a video player with controls', !!overlay.hasVideo && !!overlay.hasControls);
check('video actually loads/plays in the overlay', !!overlay.playing);
await page.screenshot({ path: 'C:/tmp/media-card-preview.png' }).catch(() => {});

// ── Act 3: Esc closes the preview and must NOT print "Interrupted" ────────
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const afterEsc = await page.evaluate(() => ({
  overlayGone: !Array.from(document.querySelectorAll('div'))
    .some((d) => d.className.includes('z-[100]') && d.className.includes('fixed')),
  interrupted: Array.from(document.querySelectorAll('span')).some((s) => s.textContent === 'Interrupted'),
}));
check('Esc closes the preview', afterEsc.overlayGone);
check('Esc on the preview did not interrupt EDITH', !afterEsc.interrupted);

// ── Assert 2: card survives a project reload (token round-trip) ───────────
const other = await page.evaluate(async () => {
  const list = await window.__dividrTest.listProjects();
  const away = list.find((p) => !p.title?.includes('SKILLS-93-TEST'));
  if (!away) return false;
  await window.__dividrTest.openProjectByTitle(away.id);
  return true;
});
if (other) {
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
  await page.waitForTimeout(4500);
  await page.evaluate(() => window.__dividrTest.openPanel('friday'));
  await page.waitForTimeout(2000);
  card = await findCard(CARD_TITLE);
  check('card survives project reload (persisted token)', card.found && !card.disabled,
    JSON.stringify(card));
} else {
  check('card survives project reload (persisted token)', false, 'no second project to switch through');
}

// ═══ Clip-attachment cards (user's own media) must open the same preview ═══
// Arrange two trimmed clips, drag BOTH into the chat, then: chips sit side by
// side (Gemini), chip click opens the player seeked to the clip's in-point,
// and after sending, the message-echo cards do the same.
const FPS = 30;
const srcPath = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const v = (s.tracks ?? []).find((t) => t.type === 'video' && t.source && !t.source.startsWith('blob:'))
    ?? (s.mediaLibrary ?? []).find((m) => m.type === 'video' && m.source && !m.source.startsWith('blob:'));
  return v?.originalSource ?? v?.source ?? null;
});
if (!srcPath) { console.log('no source video for clip section'); process.exit(1); }
const clips = await page.evaluate(async ({ src, fps }) => {
  const s = window.__dividrTest.getStoreSnapshot();
  for (const t of [...s.tracks]) s.removeTrack?.(t.id) ?? s.deleteTrack?.(t.id);
  window.__dividrTest.applyOps([
    { type: 'insertClip', src, trackType: 'video', startFrame: 0, inSeconds: 5, outSeconds: 11 },
    { type: 'insertClip', src, trackType: 'video', startFrame: 20 * fps, inSeconds: 30, outSeconds: 36 },
  ]);
  await window.__dividrTest.waitForQueueDrained();
  await new Promise((r) => setTimeout(r, 2500));
  return window.__dividrTest.getStoreSnapshot().tracks
    .filter((t) => t.type === 'video')
    .map((t) => ({ id: t.id, sst: t.sourceStartTime }));
}, { src: srcPath, fps: FPS });
check('arrange: two clips on the timeline', clips.length === 2, JSON.stringify(clips));

for (const clip of clips) {
  const geo = await page.evaluate((clipId) => {
    const el = document.querySelector(`[data-edith-target="track-body:${clipId}"]`);
    const ta = Array.from(document.querySelectorAll('textarea'))
      .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
    if (!el || !ta) return null;
    const cr = el.getBoundingClientRect();
    const ir = ta.getBoundingClientRect();
    return { cx: cr.x + Math.min(40, cr.width / 2), cy: cr.y + cr.height / 2, ix: ir.x + ir.width / 2, iy: ir.y + ir.height / 2 };
  }, clip.id);
  if (!geo) { check('drag geometry for both clips', false, `clip ${clip.id}`); process.exit(1); }
  await page.mouse.move(geo.cx, geo.cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(geo.cx + ((geo.ix - geo.cx) * i) / 10, geo.cy + ((geo.iy - geo.cy) * i) / 10, { steps: 3 });
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

// chips: two, SIDE BY SIDE (same row — equal top coordinate)
const chips = await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  const composer = ta?.closest('div.border-t');
  const cards = Array.from(composer?.querySelectorAll('[title="Click to preview"]') ?? []);
  return cards.map((c) => { const r = c.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
});
check('both clips attached as chips', chips.length === 2, JSON.stringify(chips));
check('chips sit SIDE BY SIDE (Gemini row)', chips.length === 2 && chips[0].top === chips[1].top && chips[0].left !== chips[1].left,
  JSON.stringify(chips));
await page.screenshot({ path: 'C:/tmp/clip-chips-row.png' }).catch(() => {});

// chip click → preview opens, plays, and is seeked to the clip's source in-point
await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  ta?.closest('div.border-t')?.querySelector('[title="Click to preview"]')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(2000);
const chipPreview = await page.evaluate(() => {
  const layer = Array.from(document.querySelectorAll('div'))
    .find((d) => d.className.includes('z-[100]') && d.className.includes('fixed'));
  const v = layer?.querySelector('video');
  return v ? { open: true, playing: v.currentTime > 0 || v.readyState >= 2, t: v.currentTime } : { open: false };
});
check('chip click opens the video preview', chipPreview.open);
check('chip preview loads/plays', !!chipPreview.playing, `currentTime ${chipPreview.t}`);
check('chip preview seeked to clip in-point (~5s)', chipPreview.open && Math.abs(chipPreview.t - 5) < 3, `t=${chipPreview.t}`);
await page.screenshot({ path: 'C:/tmp/clip-chip-preview.png' }).catch(() => {});
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const chipsAfterEsc = await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  return (ta?.closest('div.border-t')?.querySelectorAll('[title="Click to preview"]') ?? []).length;
});
check('Esc closed preview, chips still attached', chipsAfterEsc === 2, `${chipsAfterEsc} chips`);

// send with the clips, stop the turn immediately (the echo is what we test).
// The message is deliberately MULTILINE: the composer must grow with it and
// snap back to one line the moment it sends (regression: it stayed tall until
// the next typed letter).
await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'noted — do nothing with these\nline two\nline three\nline four\nline five');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const taHeight = () => page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  return ta ? Math.round(ta.getBoundingClientRect().height) : -1;
});
const hTall = await taHeight();
check('composer grows for a multiline draft', hTall > 60, `${hTall}px`);
await page.locator('textarea[placeholder*="edith" i]').press('Enter');
await page.waitForTimeout(1200);
const hAfterSend = await taHeight();
check('composer snaps back to one line after send (no typing needed)', hAfterSend < 40 && hAfterSend < hTall, `${hTall}px -> ${hAfterSend}px`);
await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
await page.keyboard.press('Escape'); // stop the live turn — echo cards are already in the transcript
await page.waitForTimeout(1200);

const echo = await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  const composer = ta?.closest('div.border-t');
  const cards = Array.from(document.querySelectorAll('button[title="Click to preview"]'))
    .filter((b) => !composer?.contains(b) && (b.textContent ?? '').includes('on timeline'));
  return cards.map((c) => { const r = c.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; });
});
check('sent message echoes both clip cards', echo.length === 2, JSON.stringify(echo));
check('echo cards sit SIDE BY SIDE', echo.length === 2 && echo[0].top === echo[1].top && echo[0].left !== echo[1].left,
  JSON.stringify(echo));

// message-echo card click → same preview player
await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('textarea'))
    .find((t) => (t.placeholder ?? '').toLowerCase().includes('edith'));
  const composer = ta?.closest('div.border-t');
  Array.from(document.querySelectorAll('button[title="Click to preview"]'))
    .filter((b) => !composer?.contains(b) && (b.textContent ?? '').includes('on timeline'))[0]?.click();
});
await page.waitForTimeout(2000);
const echoPreview = await page.evaluate(() => {
  const layer = Array.from(document.querySelectorAll('div'))
    .find((d) => d.className.includes('z-[100]') && d.className.includes('fixed'));
  const v = layer?.querySelector('video');
  return v ? { open: true, playing: v.currentTime > 0 || v.readyState >= 2, t: v.currentTime } : { open: false };
});
check('message card click opens the video preview', echoPreview.open);
check('message card preview loads/plays', !!echoPreview.playing, `currentTime ${echoPreview.t}`);
await page.screenshot({ path: 'C:/tmp/clip-echo-preview.png' }).catch(() => {});
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Leave the test project's chat clean — accumulated probe cards would trip the
// document-wide "on timeline" queries in the deep clipdrop tests.
await page.evaluate(() => window.electronAPI.invoke('mycelium:clearHistory')).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
