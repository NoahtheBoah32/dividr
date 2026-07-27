/**
 * Audio fade unit — the pure gain math shared by preview and panel.
 * Run: npx tsx tests/edith/fade-unit.mjs
 */
import {
  audioFadeGain,
  clampFadeSeconds,
  FADE_MAX_SECONDS,
} from '../../src/frontend/features/editor/stores/videoEditor/utils/audioFadeUtils.ts';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── clamping ──
check('negative clamps to 0 (off)', clampFadeSeconds(-3) === 0);
check('NaN clamps to 0', clampFadeSeconds(NaN) === 0);
check('Infinity clamps to max', clampFadeSeconds(Infinity) === FADE_MAX_SECONDS);
check('in-range value passes through', clampFadeSeconds(2.5) === 2.5);
check('99 clamps to max', clampFadeSeconds(99) === FADE_MAX_SECONDS);

// ── fade-in, clip [0,300) @30fps, 2s ramp ──
check('fade-in: silent at the first frame', audioFadeGain(0, 0, 300, 30, 2) === 0);
check('fade-in: half gain at 1s', near(audioFadeGain(30, 0, 300, 30, 2), 0.5));
check('fade-in: full gain at 2s', audioFadeGain(60, 0, 300, 30, 2) === 1);
check('fade-in: full gain mid-clip', audioFadeGain(150, 0, 300, 30, 2) === 1);

// ── fade-out, clip [0,300) @30fps, 2s ramp ──
check('fade-out: full gain before the ramp', audioFadeGain(240, 0, 300, 30, undefined, 2) === 1);
check('fade-out: half gain 1s from the end', near(audioFadeGain(270, 0, 300, 30, undefined, 2), 0.5));
check('fade-out: silent at the clip end', audioFadeGain(300, 0, 300, 30, undefined, 2) === 0);

// ── delayed clip (the J-cut Jesko case: audio starts at frame 214) ──
check('delayed clip: ramp starts at ITS OWN head, not timeline 0',
  audioFadeGain(214, 214, 514, 30, 2) === 0 && near(audioFadeGain(244, 214, 514, 30, 2), 0.5));

// ── overlapping ramps multiply (matches two chained afade filters) ──
check('short clip, both fades: gains multiply',
  near(audioFadeGain(30, 0, 60, 30, 2, 2), 0.25), `got ${audioFadeGain(30, 0, 60, 30, 2, 2)}`);

// ── no fades = unity ──
check('no fades: unity gain', audioFadeGain(150, 0, 300, 30) === 1);
check('zero-length fades: unity gain', audioFadeGain(150, 0, 300, 30, 0, 0) === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
