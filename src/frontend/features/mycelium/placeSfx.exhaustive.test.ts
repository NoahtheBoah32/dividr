import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sfxOpForWord, SFX_TIMELINE_GREEN } from '@/frontend/features/editor/components/properties-panel/audio/sfxTriggerUtils';

/**
 * Exhaustive placeSFX verification for the transcript asterisk-SFX trigger.
 *
 * Drives the REAL applyOp('placeSFX') path (the same one EDITH and the transcript use)
 * for EVERY one of the 41 library SFX, against a mock store, and asserts each one:
 *   - places exactly one audio clip on the timeline OVERLAY (layer 1),
 *   - at the EXACT frame the marker sat on,
 *   - tagged green.
 * Plus: an unknown file is rejected (never silently placed).
 */

const h = vi.hoisted(() => {
  const make = () => {
    const addTrackCalls: any[] = [];
    const updateTrackCalls: any[] = [];
    const tracks: any[] = []; // shared: placement logic reads this, addTrack/updateTrack maintain it
    let idc = 1;
    return {
      timeline: { fps: 30 },
      mediaLibrary: [] as any[],
      tracks,
      addToMediaLibrary: (_m: any) => `m${idc++}`,
      generateWaveformForMedia: () => Promise.resolve(),
      addTrack: async (t: any) => {
        const id = `t${idc++}`;
        const obj = { id, ...t };
        addTrackCalls.push(obj);
        tracks.push(obj); // so subsequent placeSFX see this clip (butt-after collision check)
        return id;
      },
      updateTrack: (id: string, patch: any) => {
        updateTrackCalls.push({ id, patch });
        const c = addTrackCalls.find((x) => x.id === id); // same object is in `tracks`
        if (c) Object.assign(c, patch);
      },
      _addTrackCalls: addTrackCalls,
      _updateTrackCalls: updateTrackCalls,
    };
  };
  return { store: make(), make };
});

vi.mock('@/frontend/features/editor/stores/videoEditor', () => ({
  useVideoEditorStore: { getState: () => h.store },
}));

// Import AFTER the mock is registered.
import { applyOpForTest, setSfxLibraryCache } from './storeAdapter';

const NAMES = [
  'airport_ding', 'applause_clap', 'bass_drop', 'bell', 'boom_impact', 'bubble_pop',
  'camera_shutter', 'cash_register', 'click', 'coins', 'correct_ding', 'crickets',
  'ding_notification', 'drum_roll', 'error_buzzer', 'explosion', 'footsteps', 'game_over',
  'glass_break', 'heartbeat', 'keyboard_typing', 'laugh_track', 'level_up_chime',
  'magic_transition', 'notification_pop', 'page_turn', 'pop', 'punch_whack',
  'record_scratch', 'rewind', 'riser', 'sad_trombone', 'slot_machine_win',
  'sparkle_twinkle', 'suspense_sting', 'swoosh_in', 'swoosh_out', 'typewriter',
  'vine_boom', 'whoosh_transition', 'wrong_answer_buzz',
].map((s) => `${s}.mp3`);

// Register the scanned library (name/path/duration is all placeSFX needs).
setSfxLibraryCache(
  NAMES.map((name) => ({ name, path: `C:/lib/${name}`, durationSec: 1.0, categories: [] as string[] })),
);

const FPS = 30;

describe('placeSFX — every SFX lands on the timeline at the exact frame, green', () => {
  beforeEach(() => {
    h.store = h.make();
  });

  it('all 41 SFX place a green layer-1 audio clip at the marker frame', async () => {
    for (let i = 0; i < NAMES.length; i++) {
      h.store = h.make();
      const filename = NAMES[i];
      const stem = filename.replace('.mp3', '');
      const atFrame = 30 + i * 7; // a distinct non-zero frame per SFX

      const op = sfxOpForWord(stem, atFrame, FPS, NAMES);
      expect(op, `${stem} op`).not.toBeNull();
      await applyOpForTest(op as any);

      const placed = h.store._addTrackCalls;
      expect(placed.length, `${stem}: exactly one clip placed`).toBe(1);
      const clip = placed[0];
      expect(clip.type).toBe('audio');
      expect(clip.trackRowIndex, `${stem}: overlay row`).toBe(1);
      expect(clip.layer).toBe(1);
      expect(clip.startFrame, `${stem}: EXACT frame`).toBe(atFrame);
      expect(clip.endFrame).toBeGreaterThan(clip.startFrame);
      expect(clip.source).toBe(`C:/lib/${filename}`);
      // green (set at add-time and re-asserted via updateTrack over the palette default)
      expect(clip.color, `${stem}: green`).toBe(SFX_TIMELINE_GREEN);
    }
  });

  it('places at frame 0 when the marker sits at the very start', async () => {
    h.store = h.make();
    const op = sfxOpForWord('boom', 0, FPS, NAMES);
    await applyOpForTest(op as any);
    const clip = h.store._addTrackCalls[0];
    expect(clip.startFrame).toBe(0);
    expect(clip.color).toBe(SFX_TIMELINE_GREEN);
  });

  it('rejects an unknown SFX file (never silently places)', async () => {
    h.store = h.make();
    await expect(
      applyOpForTest({ type: 'placeSFX', file: 'divebomb.mp3', atTime: 3, volume: -3 } as any),
    ).rejects.toThrow(/not found in SFX library/i);
    expect(h.store._addTrackCalls.length).toBe(0);
  });

  it('newest SFX takes row 1 at the exact frame; overlapping older ones are pushed up a layer', async () => {
    h.store = h.make();
    // Three overlapping SFX dropped at the SAME moment, in order.
    const order = ['applause_clap.mp3', 'boom_impact.mp3', 'whoosh_transition.mp3'];
    for (const file of order) {
      await applyOpForTest({ type: 'placeSFX', file, atTime: 100 / FPS, volume: -3, color: SFX_TIMELINE_GREEN } as any);
    }
    const audio = h.store.tracks.filter((t: any) => t.type === 'audio');
    expect(audio.length).toBe(3);
    // every clip keeps its EXACT frame — only the row changes
    expect(audio.every((t: any) => t.startFrame === 100)).toBe(true);
    // on distinct rows → no two overlap
    expect(new Set(audio.map((t: any) => t.trackRowIndex)).size).toBe(3);
    // the NEWEST (last placed) sits on row 1, older overlapping ones pushed above
    const onRow1 = audio.filter((t: any) => t.trackRowIndex === 1);
    expect(onRow1.length).toBe(1);
    expect(onRow1[0].source).toContain('whoosh_transition');
    // the applause (oldest) got bumped up off row 1
    const applause = audio.find((t: any) => t.source.includes('applause_clap'));
    expect(applause.trackRowIndex).toBeGreaterThanOrEqual(2);
  });
});
