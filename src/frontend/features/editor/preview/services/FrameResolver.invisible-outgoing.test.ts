// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveFrameRequests } from './FrameResolver';

const track = (id: string, s: number, e: number, srcStart = 0, row = 0, visible = true) =>
  ({
    id,
    type: 'video',
    name: id,
    source: `http://x/${id}.mp4`,
    previewUrl: `http://x/${id}.mp4`,
    startFrame: s,
    endFrame: e,
    duration: e - s,
    sourceStartTime: srcStart,
    trackRowIndex: row,
    visible,
    locked: false,
  }) as any;

describe('resolveFrameRequests — INVISIBLE OUTGOING CLIP', () => {
  it('BUG: invisible outgoing clip does NOT participate in transition', () => {
    // Outgoing clip 'a' is invisible, incoming clip 'b' is visible
    const tracks = [track('a', 0, 90, 0, 0, false), track('b', 90, 180, 2)];
    const dissolve = [
      { id: 't1', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationFrames: 30 },
    ] as any;

    // During transition window (frame 75)
    const reqs = resolveFrameRequests(75, tracks, 30, dissolve);

    console.log('Debug: Requests at frame 75:', reqs.map(r => ({ clipId: r.clipId, tfx: r.tfx?.opacity })));

    const hasOutgoing = reqs.some((r) => r.clipId === 'a');
    const outgoingTfx = reqs.find((r) => r.clipId === 'a')?.tfx;
    const hasIncoming = reqs.some((r) => r.clipId === 'b');

    console.log(`Outgoing clip in requests: ${hasOutgoing}`);
    console.log(`Outgoing clip has tfx: ${outgoingTfx !== undefined}`);
    console.log(`Incoming clip in requests: ${hasIncoming}`);

    // This test documents the bug:
    // - Outgoing 'a' should NOT be in requests (it's invisible)
    // - But the transition effect SHOULD still apply IF a transition is defined
    // - Currently: outgoing is not in requests AND no tfx is applied
    expect(hasOutgoing).toBe(false); // Expected: clip is invisible, so not rendered
    expect(hasIncoming).toBe(true); // Expected: incoming clip is present
    
    // The problem: if outgoing is not in requests, how can we apply the fade-out tfx?
    // The code at line 237-238 silently skips it with if(fromReq)
  });
});
