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
  'tests/edith/verify-hscrollbar.mjs',       // #74 timeline horizontal scrollbar
  'tests/edith/verify-sfx-panel.mjs',        // #75 SFX library panel + drag payload
  'tests/edith/verify-doc-attachments.mjs',  // #76 chat file attachments intake
  'tests/edith/verify-direct-url-download.mjs', // #77 direct-url download plumbing
  'tests/edith/media-card-probe.mjs',        // #85 fetched-media chat cards + preview overlay
];

// Slow / live-EDITH end-to-end turns. Real API spend + minutes each. Run with --deep.
const DEEP_GATE = [
  'tests/edith/verify-attach-read.mjs',      // EDITH actually Reads an attached file
  'tests/edith/verify-web-sourcing-3.mjs',   // EDITH WebFetches Commons + downloads
  'tests/edith/verify-image-sourcing.mjs',   // eBay IMAGE request → imagesearch → media library
  'tests/edith/esc-stop-probe.mjs',          // Esc mid-response actually silences EDITH (killTree)
  'tests/edith/recorder-probe.mjs',          // #86 Record & Create — records the real desktop/camera/mic.
                                             // NOTE: needs a fresh-ish app session; dozens of rapid camera
                                             // open/close cycles wedge Chromium's capture service (frozen
                                             // frames) until the app restarts.
];

const PER_SCRIPT_TIMEOUT_MS = 8 * 60 * 1000;
const scripts = process.argv.includes('--deep') ? [...GATE, ...DEEP_GATE] : GATE;

// Pre-flight: is the app up with CDP?
try {
  const res = await fetch('http://localhost:9222/json/version');
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.error('GATE ABORTED — app is not running with CDP on :9222.');
  console.error("Start it first:  $env:DIVIDR_CDP='9222'; npm start");
  process.exit(2);
}

const results = [];
for (const script of scripts) {
  console.log(`\n══ ${script} ══`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { cwd: repoRoot, stdio: 'inherit' });
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
