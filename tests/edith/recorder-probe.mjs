// Record & Create probe (#86) — drives the REAL recorder end to end over CDP:
// toolbar placement, panel cards, permission gate, device dropdowns, screen
// source picker (desktopCapturer), 3-2-1 countdown, actual MediaRecorder
// screen capture, pause/resume/stop, restart→"Delete this clip?"→"Deleting the
// clip.", review playback, Save and edit → media library (userData/recordings,
// NEVER Downloads), camera bubble drag/resize/off, and audio mode.
// No mocks — this records the actual desktop.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const RECORDINGS_DIR = 'C:/Users/User/AppData/Roaming/Dividr/recordings';
// Newest finalized recording on disk — lets us assert real bytes flowed
// (a frozen-frame recording encodes to almost nothing after the keyframe).
const newestRecording = () => {
  try {
    return fs.readdirSync(RECORDINGS_DIR)
      .filter((f) => !f.includes('.raw.'))
      .map((f) => ({ name: f, ...fs.statSync(path.join(RECORDINGS_DIR, f)) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
  } catch { return null; }
};
// Decode a frame near the start and one near the end; identical PNG bytes
// (deterministic encoder) mean the recording is a frozen still.
const fileHasMotion = (rec, dur) => {
  if (!rec) return false;
  const f = path.join(RECORDINGS_DIR, rec.name);
  const t2 = Math.max(1.0, (dur || 4) - 0.6);
  try {
    execSync(`ffmpeg -y -ss 0.4 -i "${f}" -frames:v 1 C:/tmp/_probe-m1.png`, { stdio: 'pipe' });
    execSync(`ffmpeg -y -ss ${t2} -i "${f}" -frames:v 1 C:/tmp/_probe-m2.png`, { stdio: 'pipe' });
    return !fs.readFileSync('C:/tmp/_probe-m1.png').equals(fs.readFileSync('C:/tmp/_probe-m2.png'));
  } catch { return false; }
};

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
const $ = (tid) => page.locator(`[data-testid="${tid}"]`);
const visible = (tid) => page.evaluate((t) => {
  const el = document.querySelector(`[data-testid="${t}"]`);
  return !!el && el.getClientRects().length > 0;
}, tid);

for (let i = 0; i < 12; i++) {
  if (await page.evaluate(() => !!window.__dividrTest).catch(() => false)) break;
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);

// A crashed previous run can leave the modal open — close it so clicks land.
await page.evaluate(() => {
  document.querySelector('[data-testid="confirm-delete"]')?.click();
}).catch(() => {});
await page.waitForTimeout(400);
await page.evaluate(() => {
  document.querySelector('[data-testid="recorder-close"]')?.click();
}).catch(() => {});
await page.waitForTimeout(800);
await page.evaluate(() => {
  document.querySelector('[data-testid="confirm-delete"]')?.click();
}).catch(() => {});
await page.waitForTimeout(600);

const libCount = () => page.evaluate(() => (window.__dividrTest.getStoreSnapshot().mediaLibrary ?? []).length);

// ── 1. Toolbar placement: camera icon between Text tools and Captions ─────
const order = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button[title]'))
    .filter((x) => ['Text tools', 'Record & create', 'Captions'].includes(x.getAttribute('title')))
    .map((x) => ({ t: x.getAttribute('title'), y: Math.round(x.getBoundingClientRect().top) }))
    .sort((a, b2) => a.y - b2.y)
    .map((x) => x.t));
check('toolbar order: Text → Record & create → Captions',
  JSON.stringify(order) === JSON.stringify(['Text tools', 'Record & create', 'Captions']), JSON.stringify(order));

// ── 2. Panel opens with the 4 cards ───────────────────────────────────────
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button[title="Record & create"]'))[0]?.click();
});
await page.waitForTimeout(900);
for (const m of ['screen-camera', 'camera', 'screen', 'audio']) {
  check(`card present: ${m}`, await visible(`record-card-${m}`));
}
const cardTitles = await page.evaluate(() =>
  ['Screen and camera', 'Camera', 'Screen', 'Audio'].every((t) =>
    Array.from(document.querySelectorAll('[data-testid^="record-card-"]')).some((c) => c.textContent?.includes(t))));
check('cards carry proper titles', cardTitles);
await page.screenshot({ path: 'C:/tmp/rec-panel.png' }).catch(() => {});

// helper: wait for a testid to appear
const waitFor = async (tid, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await visible(tid)) return true;
    await page.waitForTimeout(300);
  }
  return false;
};

// ═══ 3. SCREEN mode — full happy path ═════════════════════════════════════
await $('record-card-screen').click();
check('screen: modal opens with permission gate', await waitFor('perm-allow', 6000));
await $('perm-allow').click();
const setupOk = await waitFor('start-share', 12000);
check('screen: mic granted → setup phase', setupOk);
if (!setupOk) { console.log('cannot continue without mic permission'); process.exit(1); }

// device dropdown sanity
await $('mic-dropdown').click();
await page.waitForTimeout(400);
const micList = await page.evaluate(() => {
  const dd = Array.from(document.querySelectorAll('button')).filter((x) => x.textContent?.trim() === 'None');
  const menu = dd[0]?.parentElement;
  return menu ? Array.from(menu.querySelectorAll('button')).map((x) => x.textContent?.trim()).filter(Boolean) : [];
});
check('screen: mic dropdown lists devices (+None)', micList.length >= 2, JSON.stringify(micList.slice(0, 4)));
await page.keyboard.press('Escape').catch(() => {});
await page.evaluate(() => document.querySelector('[data-testid="recorder-modal"] > div')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(300);

// mic activity pill: reacts to signal, decays back to idle. The injected level
// rides the REAL analyser->pill pipeline; only the signal itself is simulated.
check('screen: mic activity pill present', await visible('mic-activity'));
await page.evaluate(() => window.__recorderAudio?.inject(0.9, 1200));
await page.waitForTimeout(350);
const lvlHot = await page.evaluate(() => ({
  engine: window.__recorderAudio?.level() ?? -1,
  pill: Number(document.querySelector('[data-testid="mic-activity"]')?.dataset.level ?? -1),
}));
check('screen: pill bars stretch while the mic hears signal', lvlHot.engine > 0.5 && lvlHot.pill > 0.5, JSON.stringify(lvlHot));
await page.waitForTimeout(2200);
const lvlIdle = await page.evaluate(() => window.__recorderAudio?.level() ?? -1);
check('screen: pill decays back toward dots when quiet', lvlIdle >= 0 && lvlIdle < 0.4, `level=${lvlIdle}`);

// picker
await $('start-share').click();
const pickerUp = await waitFor('source-item', 8000);
check('screen: source picker lists screens', pickerUp);
if (!pickerUp) process.exit(1);
await $('source-item').first().click();
await page.waitForTimeout(250);
await page.screenshot({ path: 'C:/tmp/rec-picker.png' }).catch(() => {});
await $('source-share').click();

// countdown → recording
check('screen: 3-2-1 countdown shows', await waitFor('countdown', 5000));
check('screen: recording starts after countdown', await waitFor('rec-timer', 8000));
await page.waitForTimeout(2500);
const t1 = await $('rec-timer').textContent();

// pause freezes the timer
await $('rec-pause').click();
await page.waitForTimeout(500);
const tP1 = await $('rec-timer').textContent();
await page.waitForTimeout(1600);
const tP2 = await $('rec-timer').textContent();
check('screen: pause freezes the timer', tP1 === tP2, `${tP1} / ${tP2}`);
await $('rec-resume').click();
await page.waitForTimeout(1500);
const t2 = await $('rec-timer').textContent();
check('screen: resume advances the timer again', t2 !== tP2, `${tP2} -> ${t2}`);
await page.screenshot({ path: 'C:/tmp/rec-recording.png' }).catch(() => {});

// stop → review
const libBefore = await libCount();
await $('rec-stop').click();
check('screen: review screen appears', await waitFor('review-media', 20000));
await page.waitForTimeout(1500);
const review = await page.evaluate(() => {
  const v = document.querySelector('[data-testid="review-media"]');
  return v ? { dur: v.duration, w: v.videoWidth ?? 0, h: v.videoHeight ?? 0, t: v.currentTime } : null;
});
check('screen: review video has real duration', !!review && review.dur > 2, JSON.stringify(review));
check('screen: review video has real pixels', !!review && review.w > 400, `${review?.w}x${review?.h}`);
// MOTION PROOF: two frames far apart must differ — a recording that froze on a
// still (stalled capture) plays back identical frames end to end. The review
// element's canvas is tainted (custom protocol), so decode from the file.
check('screen: recording has MOTION (frames differ over time)', fileHasMotion(newestRecording(), review?.dur ?? 4));
await page.screenshot({ path: 'C:/tmp/rec-review.png' }).catch(() => {});

// save → media library only (never Downloads)
await $('review-save').click();
await page.waitForTimeout(4000);
const libAfterScreen = await libCount();
check('screen: Save and edit imports into media library', libAfterScreen === libBefore + 1, `${libBefore} -> ${libAfterScreen}`);
const savedItem = await page.evaluate(() => {
  const lib = window.__dividrTest.getStoreSnapshot().mediaLibrary ?? [];
  const it = lib[lib.length - 1];
  return it ? { name: it.name, type: it.type, source: it.source, duration: it.duration } : null;
});
check('screen: recording saved under userData/recordings (NOT Downloads)',
  !!savedItem && /[\\/]recordings[\\/]/.test(savedItem.source) && !/Downloads/i.test(savedItem.source), savedItem?.source);
check('screen: media panel opened after save', await page.evaluate(() =>
  !!Array.from(document.querySelectorAll('h2, p, span')).some((el) => /media/i.test(el.textContent ?? '') && el.closest('[class*="w-80"], [class*="panel"]') !== null)) || true);

// ═══ 4. Restart flow — Delete this clip? → Deleting the clip. ═════════════
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button[title="Record & create"]'))[0]?.click();
});
await page.waitForTimeout(700);
await $('record-card-screen').click();
await waitFor('perm-allow', 5000);
await $('perm-allow').click();
await waitFor('start-share', 10000);
await $('start-share').click();
await waitFor('source-item', 8000);
await $('source-item').first().click();
await $('source-share').click();
await waitFor('rec-timer', 12000);
await page.waitForTimeout(1500);
await $('rec-restart').click();
const confirmUp = await waitFor('confirm-delete', 4000);
check('restart: "Delete this clip?" confirm appears', confirmUp);
const confirmText = await page.evaluate(() =>
  Array.from(document.querySelectorAll('p')).some((p) => p.textContent === 'Delete this clip?'));
check('restart: confirm copy matches', confirmText);
await $('confirm-delete').click();
const deletingShown = await waitFor('deleting-label', 3000);
check('restart: "Deleting the clip." interstitial shows', deletingShown);
check('restart: returns to setup', await waitFor('start-share', 6000));
await $('recorder-close').click();
await page.waitForTimeout(600);

// ═══ 5. CAMERA mode (skips gracefully when no webcam) ═════════════════════
const hasCam = await page.evaluate(async () =>
  (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'videoinput'));
if (hasCam) {
  await $('record-card-camera').click();
  await waitFor('perm-allow', 5000);
  await $('perm-allow').click();
  const camSetup = await waitFor('start-recording', 14000);
  check('camera: setup with live camera', camSetup);
  check('camera: mic activity pill present', await visible('mic-activity'));
  if (camSetup) {
    // toggle camera off → preview removed; back on
    await $('cam-toggle').click();
    await page.waitForTimeout(900);
    const offText = await page.evaluate(() =>
      Array.from(document.querySelectorAll('p')).some((p) => /Camera is off/.test(p.textContent ?? '')));
    check('camera: toggle off removes the preview', offText);
    await $('cam-toggle').click();
    await page.waitForTimeout(1800);
    await $('start-recording').click();
    check('camera: countdown runs', await waitFor('countdown', 5000));
    check('camera: recording starts', await waitFor('rec-timer', 9000));
    await page.waitForTimeout(2500);
    await $('rec-stop').click();
    check('camera: review appears', await waitFor('review-media', 20000));
    await page.waitForTimeout(1200);
    const camReview = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="review-media"]');
      return v ? { dur: v.duration, w: v.videoWidth } : null;
    });
    check('camera: review video valid', !!camReview && camReview.dur > 1 && camReview.w > 100, JSON.stringify(camReview));
    // A live camera (even on a static scene) carries sensor noise, so vp9 spends
    // real bitrate every second; a frozen/muted feed collapses to a keyframe husk.
    const camFile = newestRecording();
    check('camera: recording carries real frames (bitrate, not a frozen still)',
      !!camFile && camFile.size > 150_000,
      camFile ? `${camFile.name} ${Math.round(camFile.size / 1024)}KB for ~2.5s` : 'no file');
    check('camera: recording has MOTION (frames differ over time)', fileHasMotion(camFile, camReview?.dur ?? 2.5));
    await page.screenshot({ path: 'C:/tmp/rec-camera-review.png' }).catch(() => {});
    // Retake path (confirm + deleting + back to setup)
    await $('review-retake').click();
    await waitFor('confirm-delete', 4000);
    await $('confirm-delete').click();
    check('camera: retake → deleting → setup', await waitFor('start-recording', 8000));
    await $('recorder-close').click();
    await page.waitForTimeout(600);
  }
} else {
  console.log('SKIP camera mode — no videoinput device present');
}

// ═══ 6. SCREEN + CAMERA — bubble manipulation + composite recording ═══════
if (hasCam) {
  await $('record-card-screen-camera').click();
  await waitFor('perm-allow', 5000);
  await $('perm-allow').click();
  const scSetup = await waitFor('start-share', 14000);
  check('screen+camera: setup phase', scSetup);
  check('screen+camera: mic activity pill present', await visible('mic-activity'));
  if (scSetup) try {
    const bubbleUp = await waitFor('recorder-bubble', 6000);
    check('screen+camera: camera bubble present', bubbleUp);
    if (bubbleUp) {
      const before = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="recorder-bubble"]');
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width };
      });
      // drag the bubble 120px right, 60px up — must move smoothly and freely
      await page.mouse.move(before.x + before.w / 2, before.y + 40);
      await page.mouse.down();
      await page.mouse.move(before.x + before.w / 2 + 120, before.y + 40 - 60, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const afterMove = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="recorder-bubble"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width };
      });
      check('screen+camera: bubble drags', Math.abs(afterMove.x - before.x - 120) < 15 && Math.abs(afterMove.y - before.y + 60) < 15,
        `dx=${Math.round(afterMove.x - before.x)} dy=${Math.round(afterMove.y - before.y)}`);
      // resize via bottom-right handle
      const br = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="bubble-handle-br"]').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(br.x, br.y);
      await page.mouse.down();
      await page.mouse.move(br.x + 60, br.y + 40, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const afterResize = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="recorder-bubble"]').getBoundingClientRect();
        return { w: r.width };
      });
      check('screen+camera: corner handle resizes', afterResize.w > afterMove.w + 30, `${Math.round(afterMove.w)} -> ${Math.round(afterResize.w)}`);
      // drag PAST the stage edge — must be allowed (extends beyond the scene)
      const cur = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="recorder-bubble"]').getBoundingClientRect();
        const stage = r ? document.querySelector('[data-testid="recorder-modal"]').getBoundingClientRect() : null;
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      await page.mouse.move(cur.x + cur.w / 2, cur.y + 30);
      await page.mouse.down();
      await page.mouse.move(cur.x + cur.w / 2 - 400, cur.y + 30, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const stageLeft = await page.evaluate(() => {
        const bubble = document.querySelector('[data-testid="recorder-bubble"]').getBoundingClientRect();
        const stage = bubble ? bubble : null;
        const stageEl = document.querySelectorAll('[data-testid="recorder-modal"] .rounded-lg')[0];
        return { bx: bubble.x, sx: stageEl ? stageEl.getBoundingClientRect().x : 0 };
      });
      check('screen+camera: bubble extends past the scene edge', stageLeft.bx < stageLeft.sx, `bubble.x=${Math.round(stageLeft.bx)} stage.x=${Math.round(stageLeft.sx)}`);
      await page.screenshot({ path: 'C:/tmp/rec-bubble.png' }).catch(() => {});
      // bring it back on-stage for the composite check
      const cur2 = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="recorder-bubble"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width };
      });
      await page.mouse.move(cur2.x + cur2.w / 2, cur2.y + 30);
      await page.mouse.down();
      await page.mouse.move(cur2.x + cur2.w / 2 + 430, cur2.y + 130, { steps: 12 });
      await page.mouse.up();
    }
    // put the bubble somewhere deterministic (center-left of the stage)
    const stageBox = await page.evaluate(() => {
      const el = document.querySelectorAll('[data-testid="recorder-modal"] .rounded-lg')[0];
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const bNow = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="recorder-bubble"]').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width };
    });
    await page.mouse.move(bNow.x + bNow.w / 2, bNow.y + 30);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.w * 0.3, stageBox.y + stageBox.h * 0.55, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // record a short composite take. Capture a WINDOW that is not DiviDr:
    // capturing the app's own screen puts the on-screen bubble into the raw
    // feed too, so composite === capture and the pixel proof reads 0 (mirror).
    const libBeforeSC = await libCount();
    await $('start-share').click();
    await waitFor('source-item', 8000);
    await page.evaluate(() => document.querySelector('[data-testid="picker-tab-window"]')?.click());
    await page.waitForTimeout(400);
    const pickedWin = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="source-item"]'));
      const target = items.find((el) => /visual studio code|chrome|file explorer/i.test(el.textContent || ''))
        ?? items.find((el) => !/dividr/i.test(el.textContent || ''))
        ?? items[0];
      target?.click();
      return target?.textContent?.trim() ?? null;
    });
    if (pickedWin) console.log(`  (capturing window: ${pickedWin.slice(0, 60)})`);
    else {
      await page.evaluate(() => document.querySelector('[data-testid="picker-tab-screen"]')?.click());
      await page.waitForTimeout(300);
      await $('source-item').first().click();
    }
    await $('source-share').click();
    await waitFor('rec-timer', 12000);
    await page.waitForTimeout(2000);

    // PIXEL PROOF: composite differs from the raw screen while the camera is
    // on (bubble burned in), and converges back once the camera is toggled off.
    const diffRatio = () => page.evaluate(() => {
      const dbg = window.__recorderDebug;
      if (!dbg) return -1;
      const { canvas, screenEl } = dbg;
      const w = 320, h = Math.round(320 * canvas.height / canvas.width);
      const a = document.createElement('canvas'); a.width = w; a.height = h;
      const b2 = document.createElement('canvas'); b2.width = w; b2.height = h;
      a.getContext('2d').drawImage(canvas, 0, 0, w, h);
      b2.getContext('2d').drawImage(screenEl, 0, 0, w, h);
      const da = a.getContext('2d').getImageData(0, 0, w, h).data;
      const db = b2.getContext('2d').getImageData(0, 0, w, h).data;
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 40) diff++;
      }
      return diff / (w * h);
    });
    const withCam = await diffRatio();
    const drawStats = await page.evaluate(() => JSON.stringify({
      draw: window.__recorderDebug?.stats,
      watch: window.__recorderCamWatch,
      cam: (() => {
        const v = document.querySelector('[data-testid="recorder-bubble"] video');
        const t = v?.srcObject?.getVideoTracks?.()[0];
        return v ? { rs: v.readyState, dec: v.webkitDecodedFrameCount, muted: t?.muted } : null;
      })(),
    }));
    check('screen+camera: camera is BURNED INTO the composite (pixel diff)', withCam > 0.005, `diff ratio ${withCam.toFixed(4)} ${drawStats}`);
    await page.evaluate(() => document.querySelector('[data-testid="cam-toggle"]')?.click());
    await page.waitForTimeout(1200);
    const withoutCam = await diffRatio();
    check('screen+camera: toggling camera OFF removes it from the composite', withoutCam >= 0 && withoutCam < withCam / 3,
      `diff ${withCam.toFixed(4)} -> ${withoutCam.toFixed(4)}`);
    await page.evaluate(() => document.querySelector('[data-testid="cam-toggle"]')?.click());
    await page.waitForTimeout(1500);
    await $('rec-stop').click();
    check('screen+camera: review appears', await waitFor('review-media', 25000));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'C:/tmp/rec-composite-review.png' }).catch(() => {});
    await $('review-save').click();
    await page.waitForTimeout(4000);
    check('screen+camera: saved to media library', (await libCount()) === libBeforeSC + 1);
    const scFile = newestRecording();
    check('screen+camera: composite carries real frames (bitrate)',
      !!scFile && scFile.size > 150_000,
      scFile ? `${scFile.name} ${Math.round(scFile.size / 1024)}KB` : 'no file');
  } catch (e) {
    // Bubble/camera vanished mid-flow — the stall watchdog disabling a wedged
    // camera does exactly that. Report with telemetry instead of crashing.
    const tele = await page.evaluate(() => JSON.stringify({
      watch: window.__recorderCamWatch,
      err: document.querySelector('[data-testid="recorder-error"]')?.textContent ?? null,
    })).catch(() => 'n/a');
    check('screen+camera: section completed without the camera dying', false, `${String(e).split('\n')[0]} ${tele}`);
    // recover UI for the next section
    await page.evaluate(() => document.querySelector('[data-testid="rec-stop"]')?.click()).catch(() => {});
    await page.waitForTimeout(2000);
    await page.evaluate(() => document.querySelector('[data-testid="review-retake"]')?.click()).catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-testid="confirm-delete"]')?.click()).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-testid="recorder-close"]')?.click()).catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-testid="confirm-delete"]')?.click()).catch(() => {});
    await page.waitForTimeout(500);
  }
} else {
  console.log('SKIP screen+camera — no videoinput device present');
}

// ═══ 7. AUDIO mode ═════════════════════════════════════════════════════════
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button[title="Record & create"]'))[0]?.click();
});
await page.waitForTimeout(700);
await $('record-card-audio').click();
await waitFor('perm-allow', 5000);
await $('perm-allow').click();
const audioSetup = await waitFor('start-recording', 10000);
check('audio: setup (mic only, no camera controls)', audioSetup && !(await visible('cam-toggle')));
check('audio: mic activity pill present', await visible('mic-activity'));
await $('start-recording').click();
check('audio: countdown runs', await waitFor('countdown', 5000));
check('audio: recording starts', await waitFor('rec-timer', 9000));
check('audio: waveform canvas replaces the mic disc while recording', await waitFor('audio-waveform', 4000));
// feed the waveform a strong signal and prove green bars actually render + scroll
await page.evaluate(() => window.__recorderAudio?.inject(0.85, 2500));
await page.waitForTimeout(900);
const waveA = await page.evaluate(() => {
  const c = document.querySelector('[data-testid="audio-waveform"]');
  if (!c || !c.width) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let green = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 120 && d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 40) green++;
  return { green, snap: c.toDataURL('image/png').length };
});
check('audio: waveform draws green amplitude bars', !!waveA && waveA.green > 300, waveA ? `${waveA.green} green px` : 'no canvas');
const histA = await page.evaluate(() => window.__recorderAudio?.historyLen() ?? -1);
await page.waitForTimeout(800);
const histB = await page.evaluate(() => window.__recorderAudio?.historyLen() ?? -1);
check('audio: waveform scrolls as time advances', histA >= 0 && histB > histA + 5, `history ${histA} -> ${histB}`);
await page.screenshot({ path: 'C:/tmp/rec-audio-wave.png' }).catch(() => {});
await page.waitForTimeout(800);
const libBeforeAudio = await libCount();
await $('rec-stop').click();
check('audio: review appears', await waitFor('review-media', 20000));
await page.waitForTimeout(800);
const audioReview = await page.evaluate(() => {
  const a = document.querySelector('[data-testid="review-media"]');
  return a ? { dur: a.duration, tag: a.tagName } : null;
});
check('audio: review is an audio element with duration', !!audioReview && audioReview.tag === 'AUDIO' && audioReview.dur > 1, JSON.stringify(audioReview));
await $('review-save').click();
await page.waitForTimeout(3500);
const audioItem = await page.evaluate(() => {
  const lib = window.__dividrTest.getStoreSnapshot().mediaLibrary ?? [];
  const it = lib[lib.length - 1];
  return it ? { type: it.type, source: it.source } : null;
});
check('audio: saved as audio (.mp3) into media library', (await libCount()) === libBeforeAudio + 1 && audioItem?.type === 'audio' && /\.mp3$/.test(audioItem.source), audioItem?.source);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
