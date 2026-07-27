/**
 * Ken Burns unit tests — the pure window math every consumer (compositor,
 * overlay, export bake) leans on. Run: npx tsx tests/edith/kb-unit.mjs
 */
import {
  kenBurnsWindow,
  kbEase,
  kbClampZoom,
  KB_MIN_ZOOM,
  KB_MAX_ZOOM,
  KB_DEFAULT_ZOOM,
} from '../../src/frontend/features/editor/preview/utils/kenBurnsUtils.ts';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const kb = { enabled: true, endZoom: 1.3, endCenter: { x: 0.5, y: 0.5 } };

// Identity at the clip's first frame
{
  const w = kenBurnsWindow(kb, 0, 0, 300);
  check('identity at start', Math.abs(w.zoom - 1) < 1e-9 && Math.abs(w.u0) < 1e-9 && Math.abs(w.v0) < 1e-9,
    `zoom=${w.zoom}`);
}

// Full end zoom at the clip's last frame
{
  const w = kenBurnsWindow(kb, 300, 0, 300);
  check('endZoom at end', Math.abs(w.zoom - 1.3) < 1e-9, `zoom=${w.zoom}`);
}

// Monotonic, and never steeper than the easeInOutSine peak slope
{
  const zooms = [];
  for (let f = 0; f <= 300; f++) zooms.push(kenBurnsWindow(kb, f, 0, 300).zoom);
  let mono = true, maxStep = 0;
  for (let i = 1; i < zooms.length; i++) {
    if (zooms[i] < zooms[i - 1] - 1e-12) mono = false;
    maxStep = Math.max(maxStep, zooms[i] - zooms[i - 1]);
  }
  const peakSlope = (1.3 - 1) * (Math.PI / 2) / 300; // d/dp easeInOutSine peaks at PI/2
  check('zoom strictly non-decreasing', mono);
  check('per-frame step bounded by ease peak', maxStep <= peakSlope * 1.01,
    `max=${maxStep.toFixed(6)} peak=${peakSlope.toFixed(6)}`);
}

// Ease endpoints and midpoint
{
  check('ease(0)=0, ease(1)=1, ease(.5)=.5',
    Math.abs(kbEase(0)) < 1e-12 && Math.abs(kbEase(1) - 1) < 1e-12 && Math.abs(kbEase(0.5) - 0.5) < 1e-12);
}

// Edge focus: window clamped fully inside the frame at every moment
{
  const edge = { enabled: true, endZoom: 1.5, endCenter: { x: 1, y: 0 } };
  let inside = true;
  for (let f = 0; f <= 300; f += 5) {
    const w = kenBurnsWindow(edge, f, 0, 300);
    const size = 1 / w.zoom;
    if (w.u0 < -1e-9 || w.v0 < -1e-9 || w.u0 + size > 1 + 1e-9 || w.v0 + size > 1 + 1e-9) inside = false;
  }
  check('edge-focus window never leaves the frame', inside);
}

// Zoom clamps
{
  check('clamp low/high/default',
    kbClampZoom(0.5) === KB_MIN_ZOOM && kbClampZoom(99) === KB_MAX_ZOOM && kbClampZoom(undefined) === KB_DEFAULT_ZOOM);
}

// Disabled → null, mid-clip progress sane
{
  check('disabled → null', kenBurnsWindow({ ...kb, enabled: false }, 150, 0, 300) === null);
  const w = kenBurnsWindow(kb, 150, 0, 300);
  check('midpoint = half the push', Math.abs(w.zoom - 1.15) < 1e-9, `zoom=${w.zoom}`);
}

// Off-centre focus drifts the window toward it
{
  const oc = { enabled: true, endZoom: 1.3, endCenter: { x: 0.7, y: 0.4 } };
  const a = kenBurnsWindow(oc, 100, 0, 300);
  const b = kenBurnsWindow(oc, 250, 0, 300);
  const ca = a.u0 + 0.5 / a.zoom, cb = b.u0 + 0.5 / b.zoom;
  check('centre drifts toward focus x', cb > ca && cb <= 0.7 + 1e-9, `${ca.toFixed(3)} → ${cb.toFixed(3)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
