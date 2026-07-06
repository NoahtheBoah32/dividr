// Drive the REAL running DiviDr dev app over CDP: inject varied clips, type prompts
// to the REAL EDITH (claude in the main process), capture her responses + emitted ops
// + status events, let the REAL python bake run, and screenshot the live preview so we
// can SEE the edit take effect.
//
// Verification is STORE-based (robust): after EDITH runs we read the track's
// selectiveFreeze / regionalSpeed fields and the playhead, not just the raw IPC op.
//
// Usage: node tests/visual/drive-real.mjs [skill] [limit] [offset]
//   skill:  freeze | speed | find | all   (default all)
//   limit:  max cases to run               (default all)
//   offset: skip the first N cases         (default 0)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = 'C:/tmp/skills-test/real-run';
fs.mkdirSync(OUT, { recursive: true });
const C = 'C:/tmp/skills-test';

// id -> {path, fps, frames}
const CLIP = {
  person:  { path: `${C}/walk2.mp4`,   fps: 25, frames: 175 }, // locked, one person walking
  car:     { path: `${C}/walk3.mp4`,   fps: 30, frames: 210 }, // locked, a car driving
  dancer:  { path: `${C}/dance.mp4`,   fps: 30, frames: 210 }, // locked, a dancer
  ball:    { path: `${C}/obj_ball.mp4`,fps: 30, frames: 150 }, // round OBJECT rolling
  fall:    { path: `${C}/obj_fall.mp4`,fps: 30, frames: 150 }, // OBJECT falling top->bottom
  two:     { path: `${C}/obj_two.mp4`, fps: 30, frames: 150 }, // TWO objects (ambiguous subject)
  pan:     { path: `${C}/cam_pan.mp4`, fps: 30, frames: 150 }, // MOVING camera (should decline)
};

// expect helpers
const isFreeze = (m) => (o) => o && o.type === 'selectiveFreeze' && (m === undefined || o.mode === m || (!o.mode && m === 'world-frozen'));
const isSpeed  = (o) => o && o.type === 'regionalSpeed';
const isFind   = (o) => o && o.type === 'findMoment' && (!!o.target || !!o.query);

// kind: 'apply' (edit must land), 'decline' (EDITH must refuse cleanly), 'ambiguous' (must ask/clarify)
const CASES = [
  // ============ Skill 1: HOLD THE WORLD (20) ============
  // world-frozen, varied subjects + phrasing
  { skill:'freeze', clip:'car',    kind:'apply', mode:'world-frozen', prompt:'freeze the world but let the car keep moving from 0 to 3 seconds' },
  { skill:'freeze', clip:'person', kind:'apply', mode:'world-frozen', prompt:'freeze the background but keep her walking from 1 to 4 seconds' },
  { skill:'freeze', clip:'dancer', kind:'apply', mode:'world-frozen', prompt:'hold the whole world still but let the dancer keep dancing from 0 to 3' },
  { skill:'freeze', clip:'ball',   kind:'apply', mode:'world-frozen', prompt:'freeze everything except the ball from 0 to 3 seconds' },
  { skill:'freeze', clip:'fall',   kind:'apply', mode:'world-frozen', prompt:'keep the falling object moving but freeze the rest from 0 to 3' },
  { skill:'freeze', clip:'car',    kind:'apply', mode:'world-frozen', prompt:'make everything stop except the car, 0 to 3' },
  { skill:'freeze', clip:'ball',   kind:'apply', mode:'world-frozen', prompt:'the ball keeps rolling, the world freezes, first 3 seconds' },
  { skill:'freeze', clip:'dancer', kind:'apply', mode:'world-frozen', prompt:'time-stop everything but the dancer from 0 to 3' },
  // subject-frozen (world keeps moving)
  { skill:'freeze', clip:'person', kind:'apply', mode:'subject-frozen', prompt:'freeze her in place but let the street keep moving from 1 to 4' },
  { skill:'freeze', clip:'car',    kind:'apply', mode:'subject-frozen', prompt:'freeze the car but let the world keep moving from 0 to 3' },
  { skill:'freeze', clip:'dancer', kind:'apply', mode:'subject-frozen', prompt:'lock the dancer still while everything else keeps going, 0 to 3' },
  // full freeze
  { skill:'freeze', clip:'car',    kind:'apply', mode:'full', prompt:'just freeze frame from 1 to 3 seconds' },
  { skill:'freeze', clip:'dancer', kind:'apply', mode:'full', prompt:'hold this frame from 0 to 2 seconds' },
  { skill:'freeze', clip:'person', kind:'apply', mode:'full', prompt:'freeze the whole thing from 2 to 4 seconds' },
  { skill:'freeze', clip:'ball',   kind:'apply', mode:'full', prompt:'full freeze from 0 to 2 seconds' },
  // more world-frozen phrasing variety
  { skill:'freeze', clip:'car',    kind:'apply', mode:'world-frozen', prompt:'give me the frozen-world effect on the car clip, 0 to 3' },
  { skill:'freeze', clip:'dancer', kind:'apply', mode:'world-frozen', prompt:'stop the background, keep the dancer, 1 to 3.5 seconds' },
  { skill:'freeze', clip:'person', kind:'apply', mode:'world-frozen', prompt:'everything around her freezes while she keeps walking, 0 to 3' },
  // decline: moving camera
  { skill:'freeze', clip:'pan',    kind:'decline', declineHint:'camer', prompt:'freeze the world but let the ball keep moving from 0 to 3' },
  // ambiguous: two objects, unclear which is the subject
  { skill:'freeze', clip:'two',    kind:'ambiguous', prompt:'freeze the world but let the object keep moving from 0 to 3' },

  // ============ Skill 2: IN-FRAME SPEED (20) ============
  { skill:'speed', clip:'car',    kind:'apply', region:'left',   slow:true,  prompt:'slow down just the left half to 35% for the first 3 seconds' },
  { skill:'speed', clip:'car',    kind:'apply', region:'right',  slow:true,  prompt:'make the right side of the frame crawl from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'bottom', slow:true,  prompt:'slow the bottom half to half speed for the first 3 seconds' },
  { skill:'speed', clip:'car',    kind:'apply', region:'left',   slow:true,  prompt:'slow only the left third to 25% from 0 to 3' },
  { skill:'speed', clip:'ball',   kind:'apply', region:'top',    slow:true,  prompt:'slow the top half to 40% from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'left',   slow:true,  prompt:'make the left side slow motion at 0.3x for the first 3 seconds' },
  { skill:'speed', clip:'person', kind:'apply', region:'right',  slow:true,  prompt:'retime the right portion to 50% from 0 to 3' },
  { skill:'speed', clip:'car',    kind:'apply', region:'left',   slow:true,  prompt:'left half quarter speed, 0 to 3' },
  { skill:'speed', clip:'fall',   kind:'apply', region:'bottom', slow:true,  prompt:'slow the bottom to 0.4 from 0 to 3' },
  { skill:'speed', clip:'car',    kind:'apply', region:'right',  slow:true,  prompt:'right side at 60% from 0 to 3' },
  { skill:'speed', clip:'person', kind:'apply', region:'top',    slow:true,  prompt:'slow the top half to half speed, first 3 seconds' },
  { skill:'speed', clip:'ball',   kind:'apply', region:'left',   slow:true,  prompt:'slow the left side to 35% from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'right',  slow:true,  prompt:'slow the right third to 25% from 0 to 3' },
  { skill:'speed', clip:'car',    kind:'apply', region:'bottom', slow:true,  prompt:'slow the bottom half to 0.5 from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'left',   slow:true,  prompt:'give the left half a slow-mo at 0.3x, 0 to 3' },
  // invert: keep the subject normal, slow everything else
  { skill:'speed', clip:'person', kind:'apply', invert:true,  slow:true,  prompt:'keep her real-time but slow everything around her from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', invert:true,  slow:true,  prompt:'everything except the dancer slows to 40%, 0 to 3' },
  { skill:'speed', clip:'person', kind:'apply', invert:true,  slow:true,  prompt:'keep him normal speed, slow the rest to 40%, 0 to 3' },
  // speed-up a region
  { skill:'speed', clip:'car',    kind:'apply', region:'right', slow:false, prompt:'speed up the right half to 2x from 0 to 3' },
  { skill:'speed', clip:'ball',   kind:'apply', region:'center',slow:true,  prompt:'slow just the center of the frame to 30% from 0 to 3' },

  // ============ Skill 3: FIND THE MOMENT (20) ============
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'find where the car is' },
  { skill:'find', clip:'car',    kind:'apply', target:'person', prompt:'jump to the person in this clip', mayMiss:true },
  { skill:'find', clip:'dancer', kind:'apply', target:'person', prompt:'where is the person' },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'find the person walking' },
  { skill:'find', clip:'car',    kind:'apply', target:'motion', prompt:'find the busiest moment of motion' },
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'find the car' },
  { skill:'find', clip:'dancer', kind:'apply', target:'person', prompt:'go to where the dancer appears' },
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:"where's the vehicle" },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'locate the person crossing' },
  { skill:'find', clip:'dancer', kind:'apply', target:'person', prompt:'jump to the dancer' },
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'show me the car' },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'find her' },
  { skill:'find', clip:'car',    kind:'apply', target:'motion', prompt:'go to the busiest part of the clip' },
  { skill:'find', clip:'dancer', kind:'apply', target:'person', prompt:'find the figure dancing' },
  { skill:'find', clip:'car',    kind:'apply', target:'person', prompt:'find any people in this', mayMiss:true },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'find the walking person' },
  { skill:'find', clip:'fall',   kind:'apply', target:'motion', prompt:'find the moment with the most motion' },
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'find the car please' },
  { skill:'find', clip:'dancer', kind:'apply', target:'motion', prompt:'jump to the most active moment' },
  // graceful miss: a flat synthetic ball is not a real "sports ball" — expect a clean "couldn't find"
  { skill:'find', clip:'ball',   kind:'apply', target:'ball',   prompt:'find the ball', mayMiss:true },
  // ── extra Find cases (battery → 30) ──
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'find the vehicle' },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'where is the person' },
  { skill:'find', clip:'dancer', kind:'apply', target:'person', prompt:'find the dancer' },
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'show me the car' },
  { skill:'find', clip:'car',    kind:'apply', target:'motion', prompt:'jump to the most movement' },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'find the walking person' },
  { skill:'find', clip:'dancer', kind:'apply', target:'motion', prompt:'find the busiest motion' },
  { skill:'find', clip:'fall',   kind:'apply', target:'motion', prompt:'jump to the action' },
  { skill:'find', clip:'person', kind:'apply', target:'person', prompt:'locate the walker' },
  { skill:'find', clip:'car',    kind:'apply', target:'car',    prompt:'find that car' },

  // ── extra Speed cases (battery → 30) ──
  { skill:'speed', clip:'car',    kind:'apply', region:'left',   slow:true,  prompt:'slow the left half to 20% from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'right',  slow:true,  prompt:'slow the right side to 0.4 from 0 to 3' },
  { skill:'speed', clip:'ball',   kind:'apply', region:'center', slow:true,  prompt:'slow the center to 30% from 0 to 3' },
  { skill:'speed', clip:'person', kind:'apply', region:'bottom', slow:true,  prompt:'slow the bottom half to half speed, 0 to 3' },
  { skill:'speed', clip:'car',    kind:'apply', region:'top',    slow:true,  prompt:'slow the top to 35% from 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'left',   slow:false, prompt:'speed up the left half to 2x from 0 to 3' },
  { skill:'speed', clip:'fall',   kind:'apply', region:'bottom', slow:true,  prompt:'slow the bottom to 25% from 0 to 3' },
  { skill:'speed', clip:'car',    kind:'apply', region:'right',  slow:true,  prompt:'slow the right third to 0.3 from 0 to 3' },
  { skill:'speed', clip:'person', kind:'apply', invert:true,     slow:true,  prompt:'keep her real-time, slow the rest to 40%, 0 to 3' },
  { skill:'speed', clip:'dancer', kind:'apply', region:'top',    slow:true,  prompt:'slow the top half to 0.5 from 0 to 3' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/localhost:5173/.test(p.url())) page = p;
if (!page) { console.log('NO renderer page on 5173'); process.exit(1); }
await page.addInitScript(() => {
  window.__dividrTestMode = true;
  // Pre-grant EDITH consent so the panel renders the input, not the consent gate.
  // Key is per-project (`edith-consent-${projectId ?? 'default'}`); the injected store
  // carries no project id, so 'default' is the live key. Set a few common ids defensively.
  try {
    for (const k of ['default', 'null', 'undefined']) localStorage.setItem(`edith-consent-${k}`, 'true');
  } catch {}
});
// Auto-accept any native dialog (beforeunload / unsaved-changes warning) so navigation never hangs.
page.on('dialog', (d) => { d.accept().catch(() => {}); });

async function gotoEditor() {
  // Direct goto to the hash route doesn't reliably navigate; load base then set the hash.
  // ProjectGuard redirects to the picker unless window.__dividrTestMode is set (addInitScript).
  // Cold-start tolerant timeouts: a freshly (re)launched Vite recompiles deps and can take
  // 30-60s to serve the first load.
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 70000 });
  await page.waitForFunction(() => typeof window.__dividrTest?.ping === 'function', { timeout: 40000 });
  await page.evaluate(() => { window.location.hash = '#/video-editor'; });
  await page.waitForTimeout(1400);
}

async function openEdith() {
  // EDITH is the 'friday' dock panel — open it via its toolbar button (title E.D.I.T.H).
  if (await page.locator('textarea[placeholder*="reels"]').count() === 0) {
    try { await page.locator('[title="E.D.I.T.H"]').first().click({ timeout: 5000 }); } catch {}
    await sleep(600);
  }
  // Pass the per-project consent gate if it appears (pre-granted in addInitScript, belt+braces).
  const agree = page.locator('button:has-text("Agree")');
  try { if (await agree.count() > 0) await agree.first().click({ timeout: 3000 }); } catch {}
  const ta = page.locator('textarea[placeholder*="reels"]').first();
  await ta.waitFor({ state: 'visible', timeout: 12000 });
  return ta;
}

async function injectClip(key) {
  const c = CLIP[key];
  const pv = await page.evaluate(async (p) => {
    try { const r = await window.electronAPI.createPreviewUrl(p); return (r && r.url) ? r.url : (typeof r === 'string' ? r : ''); }
    catch { return ''; }
  }, c.path);
  await page.evaluate(({ p, pv, c }) => {
    const name = p.split(/[\\/]/).pop();
    window.__dividrTest.setStoreState({
      tracks: [{
        id: 'clip_a1', type: 'video', name, source: p, previewUrl: pv,
        startFrame: 0, endFrame: c.frames, duration: c.frames, sourceStartTime: 0,
        trackRowIndex: 0, mediaId: 'm1', visible: true, locked: false, muted: false, color: '#4A90D9',
      }],
      mediaLibrary: [{ id: 'm1', name, type: 'video', source: p, previewUrl: pv, duration: c.frames / c.fps }],
      preview: { canvasWidth: 1280, canvasHeight: 720 },
      timeline: { currentFrame: 8, fps: c.fps, selectedTrackIds: ['clip_a1'] },
    });
  }, { p: c.path, pv, c });
}

async function capReset() {
  await page.evaluate(() => {
    window.__cap = { messages: [], ops: [], status: [], findResult: null, done: false };
    if (!window.__capHooked) {
      window.electronAPI.on('mycelium:message', (_e, d) => { if (d) window.__cap.messages.push(d); });
      window.electronAPI.on('mycelium:op', (_e, o) => { window.__cap.ops.push(typeof o === 'string' ? o : JSON.stringify(o)); });
      window.electronAPI.on('mycelium:done', () => { window.__cap.done = true; });
      window.addEventListener('edith:status', (e) => window.__cap?.status.push(e.detail?.text || ''));
      window.addEventListener('edith:findMomentResult', (e) => { if (window.__cap) window.__cap.findResult = e.detail; });
      window.__capHooked = true;
    }
  });
}

async function snap() {
  return page.evaluate(() => {
    const s = window.__dividrTest.getStoreSnapshot();
    const t = s.tracks?.[0] || {};
    return {
      source: t.source, originalSource: t.originalSource,
      selectiveFreeze: t.selectiveFreeze || null, regionalSpeed: t.regionalSpeed || null,
      frame: s.timeline?.currentFrame,
    };
  });
}

async function seek(frame) {
  await page.evaluate((f) => window.__dividrTest.setStoreState({ timeline: { currentFrame: f } }), frame);
  await sleep(900); // let the preview decode + redraw the new frame
}

async function shot(name) {
  if (process.env.NOSHOT) return 0; // reliability runs skip screenshots (store-based verdicts) to cut memory
  const cv = page.locator('[data-testid="preview-canvas"]');
  try { const buf = await cv.screenshot({ path: `${OUT}/${name}.png` }); return buf.length; } catch { return 0; }
}

const onlySkill = process.argv[2] || 'all';
const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 999;
const offset = process.argv[4] ? parseInt(process.argv[4], 10) : 0;

const selected = CASES.filter((tc) => onlySkill === 'all' || tc.skill === onlySkill).slice(offset, offset + limit);
const results = [];

// Navigate + open EDITH ONCE. A full page reload per test leaks ~200MB each in the renderer
// (detached resources never GC'd), draining RAM to OOM by ~test 20. We reset state per test
// (re-inject the clip, reset capture, reseek) instead of reloading. Retry the one-time setup —
// Vite/5173 may still be warming right after an app (re)launch.
let ta;
for (let attempt = 0; ; attempt++) {
  try { await gotoEditor(); ta = await openEdith(); break; }
  catch (e) {
    if (attempt >= 6) throw e;
    console.log(`setup retry ${attempt + 1}: ${String(e).slice(0, 70)}`);
    await sleep(3500);
  }
}

for (let i = 0; i < selected.length; i++) {
  const tc = selected[i];
  const id = `${tc.skill}-${String(offset + i + 1).padStart(2, '0')}-${tc.clip}`;
  try {
    // Periodic reset every 10 tests: reloads the page to clear EDITH's accumulated chat
    // history (speed uses a real LLM turn) and flush any renderer memory. Cheap at 2-3x/run.
    if (i > 0 && i % 10 === 0) { await gotoEditor(); ta = await openEdith(); }
    await injectClip(tc.clip);
    if (await page.locator('textarea[placeholder*="reels"]').count() === 0) ta = await openEdith();
    await capReset();
    await seek(40);
    const beforeShot = await shot(`${id}-before`);
    const before = await snap();

    const beforeSource = before.source;
    const t0 = Date.now();
    await ta.fill(tc.prompt);
    await ta.press('Enter');

    // Poll for EDITH's op and the edit taking effect, timestamping each. ONE op runs at a
    // time, so this submit->effect span is the real per-skill latency the user cares about:
    // freeze/speed must be <=60s, find <=10s (goal <=5s).
    let opMs = null, effectMs = null, doneMs = null;
    while (Date.now() - t0 < 120000) {
      const st = await page.evaluate(() => {
        const s = window.__dividrTest.getStoreSnapshot();
        const t = s.tracks?.[0] || {};
        return { ops: window.__cap.ops.length, done: window.__cap.done, find: window.__cap.findResult,
                 source: t.source, statusN: window.__cap.status.length,
                 statusText: (window.__cap.status || []).join(' | ') };
      });
      if (opMs === null && st.ops > 0) opMs = Date.now() - t0;
      if (doneMs === null && st.done) doneMs = Date.now() - t0;
      const findResolved = st.find != null || /Jumped to|Couldn.?t find|Could not find/i.test(st.statusText);
      const effected = tc.skill === 'find'
        ? findResolved                                        // playhead jumped OR a clean miss
        : (st.source && st.source !== beforeSource);          // bake swapped the source
      if (effected) { effectMs = Date.now() - t0; break; }
      // a clean decline/ambiguity resolves with a status line + done, no bake
      if (st.done && (tc.kind === 'decline' || tc.kind === 'ambiguous') && st.statusN > 0 && Date.now() - t0 > (opMs || 0) + 3500) {
        effectMs = Date.now() - t0; break;
      }
      await sleep(400);
    }
    await page.evaluate(() => window.__dividrTest.waitForQueueDrained?.()).catch(() => {});
    await sleep(400);

    const cap = await page.evaluate(() => window.__cap);
    const after = await snap();

    // screenshots that SHOW the result
    let afterShot = 0, afterShot2 = 0;
    if (tc.skill === 'find') {
      afterShot = await shot(`${id}-after`); // playhead already at the found frame
    } else {
      await seek(40); afterShot = await shot(`${id}-after`);
      await seek(12); afterShot2 = await shot(`${id}-after2`); // freeze proof: bg should match -after
    }

    const ops = (cap.ops || []).map((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return { raw: s }; } });
    const edithText = (cap.messages || []).map((m) => (typeof m === 'string' ? m : (m?.text ?? ''))).filter(Boolean).join(' | ');
    const status = (cap.status || []).join(' | ');
    const baked = !!(after.source && before.source && after.source !== before.source);

    // Verdict is STORE-authoritative: storeAdapter only writes selectiveFreeze/regionalSpeed
    // (or seeks via findMoment) when it actually processed that op. Raw IPC op is informational.
    let emittedRight = false, editTookEffect = false, verdict = 'FAIL';
    if (tc.skill === 'freeze') {
      if (tc.kind === 'apply') {
        const modeOk = !!(after.selectiveFreeze && after.selectiveFreeze.mode === tc.mode);
        editTookEffect = baked && /mfreeze/i.test(after.source || '');
        emittedRight = modeOk; // correct mode in store == EDITH emitted the right freeze op
        verdict = (modeOk && editTookEffect) ? 'PASS' : 'FAIL';
      } else if (tc.kind === 'decline') {
        const declined = !baked && new RegExp(tc.declineHint, 'i').test(status + ' ' + edithText);
        emittedRight = !!ops.find((o) => o && o.type === 'selectiveFreeze');
        editTookEffect = declined; // "took effect" = correctly refused, source untouched
        verdict = declined ? 'PASS' : 'FAIL';
      } else { // ambiguous
        const asked = /which|unclear|specify|lasso|clarif|both|two|which one|can't tell/i.test(edithText + ' ' + status);
        emittedRight = !!ops.find((o) => o && o.type === 'selectiveFreeze');
        editTookEffect = asked || !baked;
        verdict = asked ? 'PASS' : (!baked ? 'PASS-no-blind-apply' : 'WARN-applied-anyway');
      }
    } else if (tc.skill === 'speed') {
      const rs = after.regionalSpeed;
      editTookEffect = baked && !!rs;
      emittedRight = !!rs;
      const speedDirOk = !rs ? false : (tc.slow ? rs.speed < 0.95 : rs.speed > 1.05);
      verdict = (editTookEffect && speedDirOk) ? 'PASS' : 'FAIL';
    } else { // find — status line ("Jumped to.."/"Couldn't find..") is the reliable signal
      const op = ops.find(isFind);
      emittedRight = !!op;
      const fr = cap.findResult;
      const jumped = /Jumped to/i.test(status);
      const missed = /Couldn.?t find|Could not find/i.test(status);
      const found = (fr && fr.found === true) || jumped;
      if (found) { editTookEffect = true; verdict = 'PASS'; }
      else if (tc.mayMiss && (missed || (fr && fr.found === false))) { editTookEffect = true; verdict = 'PASS-graceful-miss'; }
      else { editTookEffect = false; verdict = 'FAIL'; }
    }

    // SLA: freeze/speed must be <=60s; find <=10s (goal <=5s). One op runs at a time.
    const slaMs = tc.skill === 'find' ? 10000 : 60000;
    const slaOk = effectMs != null && effectMs <= slaMs;
    const findGoalOk = tc.skill === 'find' && effectMs != null && effectMs <= 5000;
    const row = {
      id, skill: tc.skill, clip: tc.clip, kind: tc.kind, prompt: tc.prompt,
      expect: tc.mode || tc.region || (tc.invert ? 'invert' : '') || tc.target || '',
      verdict, emittedRight, editTookEffect, baked,
      timing: { opMs, doneMs, effectMs, slaMs, slaOk, findGoalOk },
      opsTypes: ops.map((o) => (o?.type || '?') + (o?.mode ? `:${o.mode}` : '') + (o?.region ? `:${o.region}` : '') + (o?.speed != null ? `@${o.speed}` : '')),
      storeMode: after.selectiveFreeze?.mode || after.regionalSpeed?.region || null,
      storeSpeed: after.regionalSpeed?.speed ?? null,
      findResult: cap.findResult || null, afterFrame: after.frame,
      status, edithText: edithText.slice(0, 300),
      before: (before.source || '').split(/[\\/]/).pop(), after: (after.source || '').split(/[\\/]/).pop(),
      shots: { before: beforeShot, after: afterShot, after2: afterShot2 },
    };
    results.push(row);
    const tStr = `op=${opMs ?? '-'}ms effect=${effectMs ?? '-'}ms SLA(${slaMs / 1000}s)=${slaOk ? 'OK' : 'OVER'}${tc.skill === 'find' ? ` goal5s=${findGoalOk ? 'OK' : 'no'}` : ''}`;
    console.log(`[${verdict}] ${id} :: "${tc.prompt.slice(0, 46)}"`);
    console.log(`   ops=${JSON.stringify(row.opsTypes)} store=${row.storeMode ?? row.storeSpeed ?? JSON.stringify(row.findResult)} baked=${baked}`);
    console.log(`   timing: ${tStr}`);
    console.log(`   EDITH: ${(edithText || status).slice(0, 110)}`);
  } catch (e) {
    results.push({ id, prompt: tc.prompt, verdict: 'ERR', error: String(e).slice(0, 220) });
    console.log(`[ERR ] ${id}: ${String(e).slice(0, 140)}`);
  }
  fs.writeFileSync(`${OUT}/results-${onlySkill}.json`, JSON.stringify(results, null, 2));
}

const pass = results.filter((r) => String(r.verdict).startsWith('PASS')).length;
const timed = results.filter((r) => r.timing?.effectMs != null);
const effects = timed.map((r) => r.timing.effectMs).sort((a, b) => a - b);
const slaOver = timed.filter((r) => !r.timing.slaOk);
const med = effects.length ? effects[Math.floor(effects.length / 2)] : null;
console.log(`\n=== ${onlySkill.toUpperCase()}: ${pass}/${results.length} passed ===`);
if (effects.length) {
  console.log(`timing: median=${med}ms  min=${effects[0]}ms  max=${effects[effects.length - 1]}ms  (n=${effects.length})`);
  console.log(`SLA breaches (>${timed[0]?.timing.slaMs / 1000}s): ${slaOver.length} ${slaOver.map((r) => `${r.id}=${r.timing.effectMs}ms`).join(', ')}`);
  if (onlySkill === 'find') console.log(`find <=5s goal met: ${timed.filter((r) => r.timing.findGoalOk).length}/${timed.length}`);
}
console.log(`artifacts: ${OUT}/results-${onlySkill}.json + per-case PNGs`);
process.exit(0);
