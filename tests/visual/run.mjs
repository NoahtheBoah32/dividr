#!/usr/bin/env node
/**
 * Visual verification runner.
 *
 * Usage:
 *   node tests/visual/run.mjs                    # run all scenarios
 *   node tests/visual/run.mjs letterbox-blur-9x16  # run one scenario
 *   node tests/visual/run.mjs --start-server      # auto-start Vite on port 5174
 *
 * The Vite dev server must be running on port 5174 (or pass --start-server).
 * Start it with:  npx vite --config vite.renderer.config.ts --port 5174 --strictPort
 *
 * Output:
 *   tests/visual/frames/<scenario>/<timestamp>/baseline-canvas.png
 *   tests/visual/frames/<scenario>/<timestamp>/after-ops-canvas.png
 *   tests/visual/frames/<scenario>/<timestamp>/after-ops-full.png
 *   tests/visual/frames/<scenario>/<timestamp>/state.json
 *
 * The paths are printed at the end so the assistant can Read them.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(__dirname, 'frames');
const FIXTURE_DIR = join(__dirname, 'fixtures');
const FIXTURE_PATH = join(FIXTURE_DIR, 'testsrc-30s.mp4');
const BASE_URL = 'http://localhost:5174';
const VITE_PORT = 5174;
const FIXTURE_URL = `${BASE_URL}/__test-fixture.mp4`;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const filterName = args.find((a) => !a.startsWith('--'));
const startServer = args.includes('--start-server');

// ── Fixture generation ────────────────────────────────────────────────────────
function getFfmpeg() {
  try {
    const require = createRequire(import.meta.url);
    const p = require('ffmpeg-static');
    if (p && existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

async function ensureFixture() {
  if (existsSync(FIXTURE_PATH)) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const ffmpeg = getFfmpeg();
  console.log(`[runner] generating test fixture via ${ffmpeg} ...`);
  execSync(
    `"${ffmpeg}" -y -f lavfi -i "testsrc=duration=30:size=1920x1080:rate=30" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${FIXTURE_PATH}"`,
    { stdio: 'inherit', timeout: 60_000 },
  );
  console.log('[runner] fixture ready:', FIXTURE_PATH);
}

// ── Vite server management ────────────────────────────────────────────────────
let viteProc = null;

async function startViteServer() {
  return new Promise((resolve) => {
    console.log('[runner] Starting Vite dev server on port', VITE_PORT, '...');
    viteProc = spawn('npx', ['vite', '--config', 'vite.renderer.config.ts', '--port', String(VITE_PORT), '--strictPort'], {
      cwd: join(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development' },
      shell: true,
    });
    viteProc.stdout?.on('data', (d) => {
      const text = d.toString();
      process.stdout.write(`[vite] ${text}`);
      if (text.includes('Local') || text.includes('ready')) resolve(null);
    });
    viteProc.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    setTimeout(() => resolve(null), 10_000);
  });
}

async function waitForVite(maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(BASE_URL, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Vite dev server not reachable at ${BASE_URL} after ${maxMs}ms`);
}

// ── Scenario runner ───────────────────────────────────────────────────────────
async function runScenario(browser, scenario, fixtureBuffer) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(FRAMES_DIR, scenario.name, ts);
  mkdirSync(outDir, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Route the fixture video so it's loadable by the browser
  if (fixtureBuffer) {
    await page.route(FIXTURE_URL, (route) => {
      route.fulfill({ body: fixtureBuffer, contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes' } });
    });
  }

  // Local media server emulation: serve real files from disk WITH HTTP range support, exactly
  // like the real app's media server (port 3001). Lets us test that a b-roll placed by EDITH
  // actually decodes + renders in the canvas through the true load path.
  await page.route('**/__media/**', (route) => {
    try {
      const u = new URL(route.request().url());
      const filePath = decodeURIComponent(u.pathname.split('/__media/')[1] || '');
      if (!existsSync(filePath)) return route.fulfill({ status: 404, body: '' });
      const size = statSync(filePath).size;
      const rangeHeader = route.request().headers()['range'];
      const m = rangeHeader && /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      const start = m ? parseInt(m[1], 10) : 0;
      const CHUNK = 6 * 1024 * 1024;
      const end = m && m[2] ? parseInt(m[2], 10) : Math.min(start + CHUNK, size - 1);
      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(end - start + 1);
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
      route.fulfill({
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(buf.length),
          'Content-Type': 'video/mp4',
        },
        body: buf,
      });
    } catch (e) {
      route.fulfill({ status: 500, body: String(e) });
    }
  });

  // Inject test mode flag + electronAPI mock BEFORE navigation.
  // Uses a Proxy so ANY method the app calls (removeListener, onTranscodeProgress, etc.)
  // resolves to a harmless noop instead of crashing a render hook.
  await page.addInitScript(() => {
    window.__dividrTestMode = true;
    const noop = () => Promise.resolve(null);
    const overrides = {
      getProjects: () => Promise.resolve([]),
      getProject: () => Promise.resolve(null),
      getDuration: () => Promise.resolve(30),
      getVideoDimensions: () => Promise.resolve({ width: 1920, height: 1080 }),
      // Mirror the real app: a file path becomes a media-server URL the browser can stream.
      createPreviewUrl: (p) =>
        Promise.resolve(
          /^https?:|^blob:|^data:/.test(p)
            ? p
            : `http://localhost:5174/__media/${encodeURIComponent(p)}`,
        ),
      // Channel-aware IPC mock — return canned results for media ops so ops that hit the
      // main process (which doesn't exist headless) still apply against the store.
      invoke: (channel, args) => {
        if (channel === 'media:detectScenes') {
          return Promise.resolve({ success: true, scenes: [7.5, 15, 22.5] });
        }
        // New nuanced skills — canned main-process results so the renderer op path
        // (invoke → store update) can be exercised headless.
        if (channel === 'media:selectiveFreeze') {
          return Promise.resolve({
            success: true, filePath: (args?.filePath || 'clip') + '__freeze.mp4',
            mode: args?.mode || 'world-frozen',
            regionStart: args?.startSeconds ?? 0, regionEnd: args?.endSeconds ?? 0, duration: 9,
          });
        }
        if (channel === 'media:regionalSpeed') {
          return Promise.resolve({
            success: true, filePath: (args?.filePath || 'clip') + '__rs.mp4',
            speed: args?.speed ?? 0.5,
            regionStart: args?.startSeconds ?? 0, regionEnd: args?.endSeconds ?? 0, duration: 9,
          });
        }
        if (channel === 'media:findMoment') {
          return Promise.resolve({ success: true, foundAtSec: 3.0, label: args?.target || 'car' });
        }
        return Promise.resolve(null);
      },
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      platform: 'win32',
    };
    const makeProxy = () =>
      new Proxy(overrides, {
        get(target, prop) {
          if (prop in target) return target[prop];
          // Unknown property → a no-op function (covers on/off/removeListener/onX/invoke/send/etc.)
          return noop;
        },
      });
    window.electronAPI = makeProxy();
    window.appControl = new Proxy(
      {},
      { get: () => () => {} },
    );
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page] ${msg.text().slice(0, 120)}`);
  });

  try {
    // Navigate to the editor (ProjectGuard bypassed via __dividrTestMode)
    await page.goto(`${BASE_URL}/#/video-editor`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // Confirm test bridge is available
    const bridgeReady = await page.evaluate(() => typeof window.__dividrTest?.ping === 'function');
    if (!bridgeReady) {
      throw new Error('window.__dividrTest not available — ensure testBridge is imported in renderer.tsx and Vite is in DEV mode');
    }

    // Inject initial state — substitute fixture URL into any previewUrl fields
    const state = JSON.parse(JSON.stringify(scenario.initialState ?? {}));
    if (fixtureBuffer && state.tracks) {
      for (const t of state.tracks) {
        if (t.type === 'video' && (!t.previewUrl || t.previewUrl === '')) {
          t.previewUrl = FIXTURE_URL;
          t.source = FIXTURE_URL;
        }
      }
    }

    if (Object.keys(state).length > 0) {
      await page.evaluate((s) => window.__dividrTest.setStoreState(s), state);
      await page.waitForTimeout(500);
    }

    // Wait for video to reach readyState >= 2 (needed for blur/grade visual rendering)
    if (fixtureBuffer) {
      await page.waitForFunction(
        () => {
          const videos = document.querySelectorAll('video');
          return Array.from(videos).some((v) => v.readyState >= 2);
        },
        { timeout: 10_000 },
      ).catch(() => console.log(`  [runner] video didn't reach readyState >= 2 — screenshots may show black canvas`));
    }

    // Screenshot baseline
    const canvas = page.locator('[data-testid="preview-canvas"]');
    const canvasVisible = await canvas.isVisible().catch(() => false);
    if (canvasVisible) {
      await canvas.screenshot({ path: join(outDir, 'baseline-canvas.png') });
    }
    await page.screenshot({ path: join(outDir, 'baseline-full.png') });

    // Apply ops
    if (scenario.ops?.length) {
      await page.evaluate((ops) => window.__dividrTest.applyOps(ops), scenario.ops);
      await page.evaluate(() => window.__dividrTest.waitForQueueDrained());
      await page.waitForTimeout(scenario.waitMs ?? 600);
    }

    // Screenshot after ops
    if (canvasVisible) {
      await canvas.screenshot({ path: join(outDir, 'after-ops-canvas.png') });
    }
    await page.screenshot({ path: join(outDir, 'after-ops-full.png') });

    // Optional interaction step (hover/click sequences that ops can't express).
    if (typeof scenario.interact === 'function') {
      const screenshot = async (name) => {
        await page.screenshot({ path: join(outDir, `${name}.png`) });
      };
      try {
        const interactResult = await scenario.interact(page, { outDir, screenshot });
        if (interactResult) {
          writeFileSync(
            join(outDir, 'interact.json'),
            JSON.stringify(interactResult, null, 2),
          );
          console.log(`  [interact] ${JSON.stringify(interactResult)}`);
        }
      } catch (err) {
        console.log(`  [interact] FAILED: ${err.message}`);
      }
    }

    // Save store snapshot (serializable subset)
    const snapshot = await page.evaluate(() => {
      const s = window.__dividrTest.getStoreSnapshot();
      return {
        tracks: (s.tracks ?? []).map((t) => ({
          id: t.id, type: t.type, name: t.name,
          startFrame: t.startFrame, endFrame: t.endFrame,
          trackRowIndex: t.trackRowIndex, layer: t.layer, muted: t.muted,
          filter: t.filter, proxyBlockedMessage: t.proxyBlockedMessage,
          // New-feature fields for verification:
          sceneMarkers: t.sceneMarkers, reversed: t.reversed,
          reverseSegments: t.reverseSegments, transitionType: t.transitionType,
        })),
        transitions: s.timeline?.transitions ?? null,
        matchCut: s.timeline?.matchCut ?? null,
        preview: s.preview ? { canvasWidth: s.preview.canvasWidth, canvasHeight: s.preview.canvasHeight } : null,
      };
    });
    writeFileSync(join(outDir, 'state.json'), JSON.stringify(snapshot, null, 2));

    return { dir: outDir };
  } finally {
    await ctx.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { SCENARIOS } = await import('./scenarios.mjs');

  const toRun = filterName
    ? SCENARIOS.filter((s) => s.name === filterName)
    : SCENARIOS;

  if (!toRun.length) {
    console.error(`No scenario matching "${filterName}". Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  // Generate fixture if needed
  await ensureFixture().catch((err) => console.warn('[runner] fixture gen skipped:', err.message));
  const fixtureBuffer = existsSync(FIXTURE_PATH) ? readFileSync(FIXTURE_PATH) : null;
  if (!fixtureBuffer) console.warn('[runner] no fixture — video tracks will render black');

  if (startServer) await startViteServer();
  await waitForVite();
  console.log(`[runner] Vite reachable at ${BASE_URL}`);

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const scenario of toRun) {
      console.log(`\n[runner] ── ${scenario.name} ──`);
      console.log(`         ${scenario.description}`);
      try {
        const { dir } = await runScenario(browser, scenario, fixtureBuffer);
        results.push({ name: scenario.name, dir });
        console.log(`  saved → ${dir}`);
      } catch (err) {
        console.error(`  FAILED: ${err.message}`);
        results.push({ name: scenario.name, dir: null, error: err.message });
      }
    }
  } finally {
    await browser.close();
    if (viteProc) viteProc.kill();
  }

  // Print output summary for the assistant to Read
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('VISUAL TEST OUTPUTS — paste these paths into the Read tool:');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const { name, dir, error } of results) {
    if (error || !dir) {
      console.log(`\n❌ ${name} — ${error ?? 'no output'}`);
      continue;
    }
    console.log(`\n✅ ${name}`);
    for (const f of ['baseline-canvas.png', 'after-ops-canvas.png', 'after-ops-full.png', 'state.json']) {
      const p = join(dir, f);
      if (existsSync(p)) console.log(`   ${p}`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('[runner] fatal:', err);
  if (viteProc) viteProc.kill();
  process.exit(1);
});
