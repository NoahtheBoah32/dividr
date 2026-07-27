/**
 * J-cut unit tests — the pure reconcile planner every consumer (EDITH op,
 * panel toggle, lead box) leans on. Run: npx tsx tests/edith/jcut-unit.mjs
 */
import {
  planJCut,
  jcutClampLead,
  JCUT_DEFAULT_LEAD,
  JCUT_MIN_LEAD,
  JCUT_MAX_LEAD,
} from '../../src/frontend/features/editor/stores/videoEditor/utils/jCutUtils.ts';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const FPS = 30;
// The user's scenario: clip1 [0,300] with audio, clip2 [300,900] (20s Jesko)
const mkTracks = () => {
  const v1 = { id: 'v1', type: 'video', startFrame: 0, endFrame: 300, duration: 300, sourceStartTime: 0, trackRowIndex: 0 };
  const a1 = { id: 'a1', type: 'audio', startFrame: 0, endFrame: 300, duration: 300, sourceStartTime: 0, trackRowIndex: 0 };
  const v2 = { id: 'v2', type: 'video', startFrame: 300, endFrame: 900, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const a2 = { id: 'a2', type: 'audio', startFrame: 300, endFrame: 900, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  return { v1, a1, v2, a2, all: [v1, a1, v2, a2] };
};

// 1 ── clamp helper
check('lead clamps low', jcutClampLead(0.1) === JCUT_MIN_LEAD);
check('lead clamps high', jcutClampLead(99) === JCUT_MAX_LEAD);
check('lead default on NaN', jcutClampLead(NaN) === JCUT_DEFAULT_LEAD);

// 2 ── baseline apply: 3s lead
{
  const { v2, a2, all } = mkTracks();
  const p = planJCut({ video: v2, audio: a2, tracks: all, fps: FPS, enabled: true, leadSeconds: 3, markEdith: true });
  check('apply: audio slides left 90 frames', p.audioPatch.startFrame === 210 && p.audioPatch.endFrame === 810,
    `audio [${p.audioPatch.startFrame},${p.audioPatch.endFrame}]`);
  check('apply: video keeps cut, joins 3s in', p.videoPatch.sourceStartTime === 3 && p.videoPatch.endFrame === 810 && p.videoPatch.duration === 510,
    `src=${p.videoPatch.sourceStartTime} end=${p.videoPatch.endFrame} dur=${p.videoPatch.duration}`);
  check('apply: audio bumped to a free lane (overlaps a1)', p.audioPatch.trackRowIndex === 1, `row ${p.audioPatch.trackRowIndex}`);
  check('apply: state records exact frames + edith flag', p.videoPatch.jCut.appliedLeadFrames === 90 && p.videoPatch.jCut.appliedByEdith === true && p.videoPatch.jCut.enabled === true);
  check('apply: reports applied seconds', Math.abs(p.appliedSeconds - 3) < 1e-9);
}

// 3 ── SYNC INVARIANT: at the cut frame, audio source time == video source time
{
  const { v2, a2, all } = mkTracks();
  const p = planJCut({ video: v2, audio: a2, tracks: all, fps: FPS, enabled: true, leadSeconds: 3 });
  const audioSrcAtCut = (300 - p.audioPatch.startFrame) / FPS + 0; // sourceStartTime 0
  check('sync: audio at the cut == video in-point', Math.abs(audioSrcAtCut - p.videoPatch.sourceStartTime) < 1e-9,
    `audio@cut=${audioSrcAtCut}s video-in=${p.videoPatch.sourceStartTime}s`);
}

// 4 ── revert restores everything exactly
{
  const { v1, a1, v2, a2 } = mkTracks();
  const p1 = planJCut({ video: v2, audio: a2, tracks: [v1, a1, v2, a2], fps: FPS, enabled: true, leadSeconds: 3 });
  const v2b = { ...v2, ...p1.videoPatch };
  const a2b = { ...a2, ...p1.audioPatch };
  const p2 = planJCut({ video: v2b, audio: a2b, tracks: [v1, a1, v2b, a2b], fps: FPS, enabled: false });
  check('revert: audio home again', p2.audioPatch.startFrame === 300 && p2.audioPatch.endFrame === 900 && p2.audioPatch.trackRowIndex === 0,
    `audio [${p2.audioPatch.startFrame},${p2.audioPatch.endFrame}] row ${p2.audioPatch.trackRowIndex}`);
  check('revert: video whole again', p2.videoPatch.sourceStartTime === 0 && p2.videoPatch.endFrame === 900 && p2.videoPatch.duration === 600);
  check('revert: applied frames zeroed, pref kept', p2.videoPatch.jCut.appliedLeadFrames === 0 && p2.videoPatch.jCut.enabled === false && p2.videoPatch.jCut.leadSeconds === 3);
}

// 5 ── retime 3s → 5s in one hop (no intermediate revert state needed)
{
  const { v1, a1, v2, a2 } = mkTracks();
  const p1 = planJCut({ video: v2, audio: a2, tracks: [v1, a1, v2, a2], fps: FPS, enabled: true, leadSeconds: 3 });
  const v2b = { ...v2, ...p1.videoPatch };
  const a2b = { ...a2, ...p1.audioPatch };
  const p2 = planJCut({ video: v2b, audio: a2b, tracks: [v1, a1, v2b, a2b], fps: FPS, enabled: true, leadSeconds: 5 });
  check('retime: audio at 5s lead', p2.audioPatch.startFrame === 150 && p2.audioPatch.endFrame === 750);
  check('retime: video at 5s lead', p2.videoPatch.sourceStartTime === 5 && p2.videoPatch.endFrame === 750 && p2.videoPatch.duration === 450);
  check('retime: lane stays put (no climb)', p2.audioPatch.trackRowIndex === 1, `row ${p2.audioPatch.trackRowIndex}`);
}

// 6 ── clamp: lead can't run past the timeline start
{
  const { v1, a1 } = mkTracks();
  const v2 = { id: 'v2', type: 'video', startFrame: 60, endFrame: 660, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const a2 = { id: 'a2', type: 'audio', startFrame: 60, endFrame: 660, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const p = planJCut({ video: v2, audio: a2, tracks: [v1, a1, v2, a2], fps: FPS, enabled: true, leadSeconds: 5 });
  check('clamp: lead limited to clip start (2s not 5s)', p.audioPatch.startFrame === 0 && p.videoPatch.sourceStartTime === 2,
    `audio start ${p.audioPatch.startFrame}, video src ${p.videoPatch.sourceStartTime}`);
}

// 7 ── clamp: picture keeps at least a second of itself
{
  const v2 = { id: 'v2', type: 'video', startFrame: 300, endFrame: 420, duration: 120, sourceStartTime: 0, trackRowIndex: 0 }; // 4s clip
  const a2 = { id: 'a2', type: 'audio', startFrame: 300, endFrame: 420, duration: 120, sourceStartTime: 0, trackRowIndex: 0 };
  const p = planJCut({ video: v2, audio: a2, tracks: [v2, a2], fps: FPS, enabled: true, leadSeconds: 5 });
  check('clamp: 4s clip caps lead at 3s', p.videoPatch.jCut.appliedLeadFrames === 90 && p.videoPatch.endFrame - 300 >= 30,
    `applied ${p.videoPatch.jCut.appliedLeadFrames}f, picture ${p.videoPatch.endFrame - 300}f`);
}

// 8 ── error: clip at timeline 0 has nothing to lead over
{
  const v2 = { id: 'v2', type: 'video', startFrame: 0, endFrame: 600, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const a2 = { id: 'a2', type: 'audio', startFrame: 0, endFrame: 600, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const p = planJCut({ video: v2, audio: a2, tracks: [v2, a2], fps: FPS, enabled: true, leadSeconds: 3 });
  check('error: no room before the clip', 'error' in p && /No room/i.test(p.error), p.error ?? 'no error!?');
}

// 9 ── no lane bump when nothing shares the lane in the lead window
{
  const v2 = { id: 'v2', type: 'video', startFrame: 300, endFrame: 900, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const a2 = { id: 'a2', type: 'audio', startFrame: 300, endFrame: 900, duration: 600, sourceStartTime: 0, trackRowIndex: 0 };
  const p = planJCut({ video: v2, audio: a2, tracks: [v2, a2], fps: FPS, enabled: true, leadSeconds: 3 });
  check('lane: stays home when the lane is free', p.audioPatch.trackRowIndex === 0, `row ${p.audioPatch.trackRowIndex}`);
}

// 10 ── double-apply is idempotent (enabled:true twice with same lead)
{
  const { v1, a1, v2, a2 } = mkTracks();
  const p1 = planJCut({ video: v2, audio: a2, tracks: [v1, a1, v2, a2], fps: FPS, enabled: true, leadSeconds: 3 });
  const v2b = { ...v2, ...p1.videoPatch };
  const a2b = { ...a2, ...p1.audioPatch };
  const p2 = planJCut({ video: v2b, audio: a2b, tracks: [v1, a1, v2b, a2b], fps: FPS, enabled: true, leadSeconds: 3 });
  check('idempotent: re-apply changes nothing',
    p2.audioPatch.startFrame === p1.audioPatch.startFrame &&
    p2.videoPatch.sourceStartTime === p1.videoPatch.sourceStartTime &&
    p2.videoPatch.endFrame === p1.videoPatch.endFrame &&
    p2.audioPatch.trackRowIndex === p1.audioPatch.trackRowIndex);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
