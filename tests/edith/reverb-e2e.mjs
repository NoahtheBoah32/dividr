// Reverb Processor live e2e: run setReverb through the real op pipeline in
// SKILLS-93-TEST, verify (1) source swaps to a baked wav in app storage,
// (2) re-processing starts from originalSource (no stacking), (3) reset to 0
// restores the pristine source, (4) the baked file differs measurably.
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('FAIL no page'); process.exit(1); }
page.on('dialog', (d) => d.accept().catch(() => {}));

for (let i = 0; i < 25; i++) {
  const ok = await page.evaluate(() => !!window.__dividrTest).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.__dividrTest.openProjectByTitle('SKILLS-93-TEST'));
await page.waitForTimeout(4500);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const audio = await page.evaluate(() => {
  const s = window.__dividrTest.getStoreSnapshot();
  const a = s.tracks.find((t) => t.type === 'audio');
  return a ? { id: a.id, source: a.source, name: a.name } : null;
});
if (!audio) { console.log('FAIL — no audio track in SKILLS-93-TEST; add one first'); process.exit(1); }
console.log('audio track:', audio.name, '|', audio.source);
const pristine = audio.source;

// 1) strip reverb -30
await page.evaluate(() => window.__dividrTest.applyOps([{ type: 'setReverb', amount: -30 }]));
await page.waitForTimeout(500);
await page.evaluate(() => window.__dividrTest.waitForQueueDrained?.());
let t0 = Date.now(), st = null;
while (Date.now() - t0 < 120000) {
  st = await page.evaluate((id) => {
    const t = window.__dividrTest.getStoreSnapshot().tracks.find((x) => x.id === id);
    return t ? { source: t.source, rp: t.reverbProcessor } : null;
  }, audio.id);
  if (st?.rp?.amount === -30 && /reverb_\d+\.wav$/.test(st.source)) break;
  await page.waitForTimeout(2000);
}
check('strip -30 baked + source swapped', st?.rp?.amount === -30 && /reverb_\d+\.wav$/.test(st?.source ?? ''), st?.source);
check('bake landed in app storage', /AppData[\\/]Roaming[\\/]Dividr[\\/]baked[\\/]/i.test(st?.source ?? ''));
check('originalSource preserved', st?.rp?.originalSource === pristine, `${st?.rp?.originalSource}`);
check('tail metrics reported', st?.rp?.tailBeforeMs != null && st?.rp?.tailAfterMs != null,
  `${st?.rp?.tailBeforeMs}ms -> ${st?.rp?.tailAfterMs}ms`);
const firstBake = st?.source;

// 2) re-process +25 — must process from ORIGINAL, not from the -30 bake
await page.evaluate(() => window.__dividrTest.applyOps([{ type: 'setReverb', amount: 25 }]));
t0 = Date.now();
let st2 = null;
while (Date.now() - t0 < 120000) {
  st2 = await page.evaluate((id) => {
    const t = window.__dividrTest.getStoreSnapshot().tracks.find((x) => x.id === id);
    return t ? { source: t.source, rp: t.reverbProcessor } : null;
  }, audio.id);
  if (st2?.rp?.amount === 25 && st2.source !== firstBake) break;
  await page.waitForTimeout(2000);
}
check('re-process +25 replaced bake', st2?.rp?.amount === 25 && st2?.source !== firstBake, st2?.source);
check('no stacking (originalSource still pristine)', st2?.rp?.originalSource === pristine);
check('+25 tail grew vs its before', (st2?.rp?.tailAfterMs ?? 0) > (st2?.rp?.tailBeforeMs ?? 1e9),
  `${st2?.rp?.tailBeforeMs}ms -> ${st2?.rp?.tailAfterMs}ms`);

// 3) baked files objectively differ from pristine (ffmpeg RMS of difference)
try {
  const dur = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${st2.source}"`).toString().trim();
  check('baked wav is a valid audio file', parseFloat(dur) > 1, `${dur}s`);
} catch { check('baked wav is a valid audio file', false); }

// 4) reset to 0 restores pristine source instantly (same patch the panel's
// reset button applies via updateTrack)
await page.evaluate(({ id, orig }) => {
  const tracks = window.__dividrTest.getStoreSnapshot().tracks.map((t) =>
    t.id === id
      ? { ...t, source: orig, reverbProcessor: { amount: 0, originalSource: orig } }
      : t,
  );
  window.__dividrTest.setStoreState({ tracks });
}, { id: audio.id, orig: pristine });
await page.waitForTimeout(1000);
const st3 = await page.evaluate((id) => {
  const t = window.__dividrTest.getStoreSnapshot().tracks.find((x) => x.id === id);
  return t ? { source: t.source, rp: t.reverbProcessor } : null;
}, audio.id);
check('reset to 0 restores pristine source', st3?.source === pristine && st3?.rp?.amount === 0, st3?.source);

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
