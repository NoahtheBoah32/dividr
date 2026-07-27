// Measures the stability OF THE LIVE PREVIEW ITSELF — the thing the user
// actually looks at. Captures the compositor canvas during real playback with
// stabilization ON and OFF, assembles both captures into videos, and runs the
// same shake metric used everywhere else. Proves (a) the content is steadier
// with the toggle on and (b) the frame rect never moves (a swaying rect would
// explode the ON metric).
//
// Prereqs: DiviDr running with DIVIDR_CDP=9222.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STAB_CLIP = 'C:\\Users\\User\\Downloads\\Unstable video - sagar pandey (360p).mp4';
const STAB_FPS = 25, STAB_FRAMES = 246;
const OUT_DIR = 'C:\\tmp\\stab-test\\preview-cap';
const PY = 'C:\\Users\\User\\Documents\\CLAUDE CODE\\dividr-mycelium\\src\\backend\\python\\venv\\Scripts\\python.exe';
const SCRIPTS = 'C:\\Users\\User\\Documents\\CLAUDE CODE\\dividr-mycelium\\src\\backend\\python\\scripts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO renderer page'); process.exit(1); }
await page.addInitScript(() => { window.__dividrTestMode = true; });

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
await page.evaluate(() => { window.location.hash = '#/video-editor'; });
await sleep(1500);

// Inject the clip and run the real analysis IPC (cached after the first run).
const pv = await page.evaluate(async (fp) => {
  const r = await window.electronAPI.createPreviewUrl(fp);
  return (r && r.url) ? r.url : (typeof r === 'string' ? r : '');
}, STAB_CLIP);
await page.evaluate(({ p, pv, fps, frames }) => {
  const name = p.split(/[\\/]/).pop();
  window.__dividrTest.setStoreState({
    tracks: [{
      id: 'clip_pm', type: 'video', name, source: p, previewUrl: pv,
      startFrame: 0, endFrame: frames, duration: frames, sourceStartTime: 0,
      trackRowIndex: 0, mediaId: 'm1', visible: true, locked: false, muted: false, color: '#4A90D9',
    }],
    mediaLibrary: [{ id: 'm1', name, type: 'video', source: p, previewUrl: pv, duration: frames / fps }],
    preview: { canvasWidth: 1280, canvasHeight: 720 },
    timeline: { currentFrame: 5, fps, selectedTrackIds: ['clip_pm'] },
  });
}, { p: STAB_CLIP, pv, fps: STAB_FPS, frames: STAB_FRAMES });
await sleep(800);

const analysis = await page.evaluate(async (fp) =>
  window.electronAPI.invoke('media:stabilizeAnalyze', { filePath: fp }), STAB_CLIP);
if (!analysis?.success) { console.log('analysis failed:', analysis?.error); process.exit(1); }
console.log(`analysis: shakeBefore=${analysis.shakeBefore} shakeAfter=${analysis.shakeAfter} (${analysis.frames} frames)`);

async function setStab(enabled) {
  await page.evaluate(({ enabled, offsetsPath, fps }) => {
    const store = window.__videoEditorStore;
    const t = store.getState().tracks.find((x) => x.trackRowIndex === 0 && x.type === 'video');
    store.getState().updateTrack(t.id, {
      stabilization: { enabled, offsetsPath, sourceFps: fps },
    });
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  }, { enabled, offsetsPath: analysis.offsetsPath, fps: analysis.fps });
}

// Capture the presented preview: dedup consecutive identical frames so the
// sequence approximates the true 25fps presentation regardless of poll rate.
async function capture(tag, seconds) {
  await page.evaluate(async () => {
    const store = window.__videoEditorStore;
    store.getState().pause?.();
    store.getState().setCurrentFrame(10);
    await new Promise((r) => setTimeout(r, 600));
    store.getState().play();
  });
  await sleep(900); // let playback settle
  const frames = await page.evaluate(async (secs) => {
    // The compositor canvas is the one whose pixels CHANGE during playback —
    // size is not a reliable discriminator (a big static canvas exists).
    const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.width > 100);
    const snap = () => canvases.map((c) => { try { return c.toDataURL('image/png'); } catch { return ''; } });
    const a = snap();
    await new Promise((r) => setTimeout(r, 250));
    const b = snap();
    let canvas = canvases[0];
    for (let i = 0; i < canvases.length; i++) {
      if (a[i] && a[i] !== b[i]) { canvas = canvases[i]; break; }
    }
    const out = [];
    let last = '';
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      const d = canvas.toDataURL('image/png');
      if (d !== last) { out.push(d); last = d; }
      await new Promise((r) => setTimeout(r, 12));
    }
    return out;
  }, seconds);
  await page.evaluate(() => window.__videoEditorStore.getState().pause?.());
  const dir = path.join(OUT_DIR, tag);
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((d, i) => {
    fs.writeFileSync(path.join(dir, `f_${String(i).padStart(4, '0')}.png`), Buffer.from(d.split(',')[1], 'base64'));
  });
  const mp4 = path.join(OUT_DIR, `${tag}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(STAB_FPS), '-i', path.join(dir, 'f_%04d.png'),
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', mp4]);
  return { mp4, n: frames.length };
}

function measure(file) {
  const out = execFileSync(PY, ['-c', `
import sys, argparse
sys.path.insert(0, r'${SCRIPTS}')
import stabilize
stabilize.handle_args(argparse.Namespace(stab_mode='measure', input=r'${file}'))
`]).toString();
  const line = out.split('\n').find((l) => l.startsWith('RESULT|'));
  return JSON.parse(line.slice(7));
}

await setStab(false);
const capOff = await capture('stab_off', 4);
await setStab(true);
await sleep(1200); // lazy offsets load on first compensated frame
const capOn = await capture('stab_on', 4);

const mOff = measure(capOff.mp4);
const mOn = measure(capOn.mp4);
console.log(`preview OFF: ${capOff.n} frames, shake=${mOff.shake}px/f rot=${mOff.rotShake}`);
console.log(`preview ON : ${capOn.n} frames, shake=${mOn.shake}px/f rot=${mOn.rotShake}`);
const cut = 1 - mOn.shake / Math.max(mOff.shake, 1e-9);
console.log(`PREVIEW SHAKE CUT: ${(cut * 100).toFixed(1)}%`);
console.log(cut > 0.5 ? 'PASS preview measurably stabilized' : 'FAIL preview not stabilized enough');
process.exit(cut > 0.5 ? 0 : 1);
