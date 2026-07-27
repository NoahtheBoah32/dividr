/**
 * Puts the Eiffel clip back to a clean, correct single ramp:
 * sourceDuration derived from the UNTOUCHED source, endFrame integrated from
 * the curve. Run after any probe suite that left the clip warped.
 */
import { chromium } from 'playwright-core';
const b=await chromium.connectOverCDP('http://localhost:9222');
let page=null;
for(const c of b.contexts())for(const p of c.pages())if(/5173/.test(p.url()))page=p;
const r = await page.evaluate(async () => {
  const { makeRegion, clampRegions, buildProfile } =
    await import('/src/frontend/features/editor/preview/utils/speedRampCurve.ts');
  const s=window.__videoEditorStore.getState();
  const fps=s.timeline?.fps ?? 30;
  const t=(s.tracks||[]).find(x=>x.type==='video');
  const dur = t.sourceDuration / (t.effectiveFps || fps);   // 36.1s
  const regions = clampRegions([makeRegion(3, 11, 6, 'smooth')], dur);
  const prof = buildProfile(regions, dur);
  s.updateTrack(t.id, {
    speedRamp:{ enabled:true, appliedByEdith:true, regions, sourceDuration:dur,
                blend:'blend', audio:false, pitch:true },
    endFrame: t.startFrame + Math.max(1, Math.round(prof.outDuration*fps)),
  });
  s.setSelectedTracks([t.id]);
  window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  return { name:t.name, srcSeconds:+dur.toFixed(3), outSeconds:+prof.outDuration.toFixed(2),
           endFrame:t.startFrame+Math.round(prof.outDuration*fps), regions:regions.length };
});
console.log(JSON.stringify(r));
process.exit(0);
