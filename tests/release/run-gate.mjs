// Release gate — run before promoting the dev branch to `stable`.
// Prereq: the app must be running with CDP enabled:
//   $env:DIVIDR_CDP='9222'; npm start
// Usage (from repo root):  node tests/release/run-gate.mjs
//
// Scripts run sequentially (they share one CDP session and one app instance).
// Add new verify scripts here as features stabilize — keep only deterministic
// ones; slow live-EDITH turns belong in DEEP_GATE (opt-in via --deep).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GATE = [
  { script: 'tests/edith/fade-unit.mjs', tsx: true },  // pure gain math (no app needed)
  { script: 'tests/edith/jcut-unit.mjs', tsx: true },  // pure J-cut planner math
  'tests/edith/timeline-contract-e2e.mjs',   // Premiere contract: exact drops, overwrite, no renumber/teleport
  'tests/edith/timeline-realdrag-e2e.mjs',   // real pointer drag lands + overwrites correctly
  'tests/edith/edith-placement-regression.mjs', // broll/placeSFX/addCaption/deleteBroll exact placement
  'tests/edith/verify-hscrollbar.mjs',       // #74 timeline horizontal scrollbar
  'tests/edith/verify-sfx-panel.mjs',        // #75 SFX library panel + drag payload
  'tests/edith/verify-doc-attachments.mjs',  // #76 chat file attachments intake
  'tests/edith/verify-direct-url-download.mjs', // #77 direct-url download plumbing
  'tests/edith/media-card-probe.mjs',        // #85 fetched-media chat cards + preview overlay
  'tests/edith/verify-selection-tool.mjs',   // #88 chat selection tool (arm → click clip → card)
  'tests/edith/verify-send-to-edith-ops.mjs', // #91+#92 audio gate + hand-off + filler pipeline (op level)
];

// Slow / live-EDITH end-to-end turns. Real API spend + minutes each. Run with --deep.
const DEEP_GATE = [
  'tests/edith/verify-attach-read.mjs',      // EDITH actually Reads an attached file
  'tests/edith/verify-web-sourcing-3.mjs',   // EDITH WebFetches Commons + downloads
  'tests/edith/verify-image-sourcing.mjs',   // eBay IMAGE request → imagesearch → media library
  'tests/edith/esc-stop-probe.mjs',          // Esc mid-response actually silences EDITH (killTree)
  'tests/edith/verify-swap-broll-e2e.mjs',   // #89 swap an attached clip without re-asking (live EDITH)
  'tests/edith/verify-filler-removal-e2e.mjs', // #92 "remove my ums" → fresh op → Filler removed import (live EDITH)
  'tests/edith/verify-recorder-send-button.mjs', // #91 review buttons + silent-take warning (records real desktop + mic)
  'tests/edith/recorder-probe.mjs',          // #86 Record & Create — records the real desktop/camera/mic.
                                             // NOTE: needs a fresh-ish app session; dozens of rapid camera
                                             // open/close cycles wedge Chromium's capture service (frozen
                                             // frames) until the app restarts.
];

const PER_SCRIPT_TIMEOUT_MS = 8 * 60 * 1000;
// Every deep script starts from a fresh EDITH conversation — shared history from
// earlier scripts makes live turns slow and non-deterministic.
const deepEntries = DEEP_GATE.map((e) =>
  typeof e === 'string' ? { script: e, clearFirst: true } : { ...e, clearFirst: true });
const scripts = process.argv.includes('--deep') ? [...GATE, ...deepEntries] : GATE;

// Pre-flight: is the app up with CDP?
try {
  const res = await fetch('http://localhost:9222/json/version');
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.error('GATE ABORTED — app is not running with CDP on :9222.');
  console.error("Start it first:  $env:DIVIDR_CDP='9222'; npm start");
  process.exit(2);
}

// Pre-flight 2: wait for the renderer to finish booting — CDP answers long
// before Vite serves the first compile, and every script needs the test bridge.
{
  const { chromium } = await import('playwright-core');
  const deadline = Date.now() + 120000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const b = await chromium.connectOverCDP('http://localhost:9222');
      for (const c of b.contexts()) for (const p of c.pages()) {
        if (p.url().includes('localhost:517') && !p.url().startsWith('blob:')) {
          ready = await p.evaluate(() => !!window.__dividrTest).catch(() => false);
        }
      }
      await b.close();
    } catch { /* app still booting */ }
    if (!ready) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) {
    console.error('GATE ABORTED — renderer never exposed the test bridge (window.__dividrTest) within 120s.');
    process.exit(2);
  }
  console.log('renderer ready — test bridge is up.');
}

const results = [];
for (const entry of scripts) {
  const script = typeof entry === 'string' ? entry : entry.script;
  const useTsx = typeof entry === 'object' && entry.tsx;
  if (typeof entry === 'object' && entry.clearFirst) {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ['tests/release/clear-edith-history.mjs'], { cwd: repoRoot, stdio: 'inherit' });
      const t = setTimeout(() => { p.kill(); resolve(); }, 30000);
      p.on('close', () => { clearTimeout(t); resolve(); });
      p.on('error', () => { clearTimeout(t); resolve(); });
    });
  }
  console.log(`\n══ ${script} ══`);
  const code = await new Promise((resolve) => {
    const p = useTsx
      ? spawn('npx', ['tsx', script], { cwd: repoRoot, stdio: 'inherit', shell: true })
      : spawn(process.execPath, [script], { cwd: repoRoot, stdio: 'inherit' });
    const t = setTimeout(() => { p.kill(); resolve('timeout'); }, PER_SCRIPT_TIMEOUT_MS);
    p.on('close', (c) => { clearTimeout(t); resolve(c); });
    p.on('error', () => { clearTimeout(t); resolve('spawn-error'); });
  });
  results.push({ script, ok: code === 0, code });
}

console.log('\n════════ GATE SUMMARY ════════');
for (const r of results) console.log(`${r.ok ? 'PASS' : `FAIL (${r.code})`}  ${r.script}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nGATE GREEN — ok to promote to stable.' : `\nGATE RED — ${failed} failing. Do NOT promote.`);
process.exit(failed === 0 ? 0 : 1);
