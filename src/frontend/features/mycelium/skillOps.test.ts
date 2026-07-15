import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the 12-skill batch (2026-07-11):
 *  - buildFfmpegGradeFilter (white balance / S-M-H / vignette / sharpen / blur bake)
 *  - export presets (resolve + aspect-safe dimension fitting)
 *  - marker utils (YouTube chapter text)
 *  - the new EDITH ops through the REAL applyOp switch:
 *    adjust, exportSettings, exportSrt, addMarker, removeMarker, exportChapters
 */

const h = vi.hoisted(() => {
  const make = () => {
    const updateTrackCalls: any[] = [];
    const markerCalls: any[] = [];
    const exportSettingsCalls: any[] = [];
    const store: any = {
      timeline: { fps: 30, timelineMarkers: [] as any[] },
      preview: { canvasWidth: 1080, canvasHeight: 1920 },
      mediaLibrary: [] as any[],
      tracks: [
        {
          id: 'v1',
          type: 'video',
          name: 'footage.mp4',
          trackRowIndex: 0,
          layer: 0,
          sourceFps: 30,
          visible: true,
          startFrame: 0,
          endFrame: 900,
          colorGrade: { temperature: 10, curves: { r: [], g: [], b: [], ffmpegFilter: 'x' } },
        },
      ] as any[],
      exportSettings: {} as any,
      updateTrack: (id: string, patch: any) => {
        updateTrackCalls.push({ id, patch });
        const t = store.tracks.find((x: any) => x.id === id);
        if (t) Object.assign(t, patch);
      },
      setExportSettings: (patch: any) => {
        exportSettingsCalls.push(patch);
        store.exportSettings = patch === null ? {} : { ...store.exportSettings, ...patch };
      },
      addTimelineMarker: (frame: number, label: string, color?: string) => {
        const id = `mk${markerCalls.length + 1}`;
        markerCalls.push({ op: 'add', frame, label, color });
        store.timeline.timelineMarkers.push({ id, frame, label, color });
        return id;
      },
      removeTimelineMarker: (id: string) => {
        markerCalls.push({ op: 'remove', id });
        store.timeline.timelineMarkers = store.timeline.timelineMarkers.filter(
          (m: any) => m.id !== id,
        );
      },
      _updateTrackCalls: updateTrackCalls,
      _markerCalls: markerCalls,
      _exportSettingsCalls: exportSettingsCalls,
    };
    return store;
  };
  return { store: make(), make };
});

vi.mock('@/frontend/features/editor/stores/videoEditor', () => ({
  useVideoEditorStore: { getState: () => h.store },
}));

// Node env: the ops dispatch status CustomEvents on window and write via electronAPI
const writeCalls: any[] = [];
(globalThis as any).CustomEvent ??= class {
  type: string;
  detail: any;
  constructor(type: string, opts?: any) {
    this.type = type;
    this.detail = opts?.detail;
  }
};
(globalThis as any).window = {
  dispatchEvent: () => true,
  electronAPI: {
    writeSubtitleFile: async (opts: any) => {
      writeCalls.push(opts);
      return { success: true, filePath: `C:/Users/User/Downloads/${opts.filename}` };
    },
  },
};

// Import AFTER mocks are registered.
import { applyOpForTest } from './storeAdapter';
import { buildFfmpegGradeFilter } from '@/frontend/features/editor/preview/utils/colorGradeUtils';
import {
  resolveExportPreset,
  fitPresetDimensions,
  SOCIAL_EXPORT_PRESETS,
} from '@/frontend/features/export/utils/exportPresets';
import {
  formatChapterTime,
  buildYouTubeChapterText,
} from '@/frontend/features/editor/stores/videoEditor/utils/markerUtils';

// ─── buildFfmpegGradeFilter ────────────────────────────────────────────────

describe('buildFfmpegGradeFilter', () => {
  it('returns null for empty/inactive grades', () => {
    expect(buildFfmpegGradeFilter(undefined)).toBeNull();
    expect(buildFfmpegGradeFilter(null)).toBeNull();
    expect(buildFfmpegGradeFilter({})).toBeNull();
    expect(buildFfmpegGradeFilter({ temperature: 0, vignette: 0 })).toBeNull();
  });

  it('temperature warms red and cools blue in the curves table', () => {
    const f = buildFfmpegGradeFilter({ temperature: 50 })!;
    expect(f).toMatch(/^curves=red='/);
    // midpoint x=0.5: red y must be above 0.5, blue y below
    const red = /red='([^']+)'/.exec(f)![1].split(' ');
    const blue = /blue='([^']+)'/.exec(f)![1].split(' ');
    const midR = parseFloat(red[8].split('/')[1]);
    const midB = parseFloat(blue[8].split('/')[1]);
    expect(midR).toBeGreaterThan(0.5);
    expect(midB).toBeLessThan(0.5);
  });

  it('shadows lift only the low end of the table', () => {
    const f = buildFfmpegGradeFilter({ shadows: 60 })!;
    const red = /red='([^']+)'/.exec(f)![1].split(' ');
    const first = parseFloat(red[0].split('/')[1]);
    const last = parseFloat(red[16].split('/')[1]);
    expect(first).toBeGreaterThan(0);       // lifted at black
    expect(last).toBeCloseTo(1, 3);          // untouched at white
  });

  it('vignette / sharpen / blur / hue map to their ffmpeg filters', () => {
    expect(buildFfmpegGradeFilter({ vignette: 100 })).toBe('vignette=angle=1.5708');
    expect(buildFfmpegGradeFilter({ vignette: 50 })).toBe('vignette=angle=0.7854');
    expect(buildFfmpegGradeFilter({ sharpen: 100 })).toBe('unsharp=5:5:2.50');
    expect(buildFfmpegGradeFilter({ blur: 50 })).toBe('gblur=sigma=10.00');
    expect(buildFfmpegGradeFilter({ hue: 90 })).toBe('hue=h=90');
  });

  it('combines in preview order: curves, hue, unsharp, gblur, vignette', () => {
    const f = buildFfmpegGradeFilter({
      temperature: 20, hue: -15, sharpen: 40, blur: 10, vignette: 30,
    })!;
    const order = ['curves=', 'hue=h=-15', 'unsharp=', 'gblur=', 'vignette='];
    let last = -1;
    for (const part of order) {
      const idx = f.indexOf(part);
      expect(idx, part).toBeGreaterThan(last);
      last = idx;
    }
  });
});

// ─── export presets ────────────────────────────────────────────────────────

describe('export presets', () => {
  it('resolves canonical names and aliases, rejects unknowns', () => {
    expect(resolveExportPreset('tiktok')!.name).toBe('tiktok');
    expect(resolveExportPreset('Instagram Reels')!.name).toBe('reels');
    expect(resolveExportPreset('YT')!.name).toBe('youtube');
    expect(resolveExportPreset('4k')!.name).toBe('youtube-4k');
    expect(resolveExportPreset('mystery')).toBeNull();
    expect(resolveExportPreset(undefined)).toBeNull();
  });

  it('fits preset resolution to canvas aspect without distortion', () => {
    const tiktok = SOCIAL_EXPORT_PRESETS.tiktok;
    // matching aspect → exact preset dims
    expect(fitPresetDimensions(1080, 1920, tiktok)).toEqual({ width: 1080, height: 1920 });
    // landscape canvas on a 9:16 preset → keeps 16:9, pins short edge 1080
    expect(fitPresetDimensions(1920, 1080, tiktok)).toEqual({ width: 1920, height: 1080 });
    // square canvas
    expect(fitPresetDimensions(1080, 1080, SOCIAL_EXPORT_PRESETS.youtube)).toEqual({ width: 1080, height: 1080 });
    // dimensions always even
    const odd = fitPresetDimensions(1001, 1920, tiktok);
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
  });
});

// ─── marker utils ──────────────────────────────────────────────────────────

describe('marker utils', () => {
  it('formats chapter times', () => {
    expect(formatChapterTime(0)).toBe('0:00');
    expect(formatChapterTime(65)).toBe('1:05');
    expect(formatChapterTime(3725)).toBe('1:02:05');
  });

  it('builds sorted YouTube chapter text, prepending 0:00 Intro when needed', () => {
    const markers = [
      { id: 'b', frame: 30 * 95, label: 'Recipe demo' },
      { id: 'a', frame: 30 * 12, label: 'Hook ends' },
    ];
    expect(buildYouTubeChapterText(markers as any, 30)).toBe(
      '0:00 Intro\n0:12 Hook ends\n1:35 Recipe demo\n',
    );
    // first marker at 0 → no Intro prepend
    const fromZero = [{ id: 'a', frame: 0, label: 'Start' }];
    expect(buildYouTubeChapterText(fromZero as any, 30)).toBe('0:00 Start\n');
    expect(buildYouTubeChapterText([], 30)).toBe('');
  });
});

// ─── EDITH ops through the real applyOp switch ─────────────────────────────

describe('adjust op', () => {
  beforeEach(() => { h.store = h.make(); writeCalls.length = 0; });

  it('merges clamped params into the main track colorGrade', async () => {
    await applyOpForTest({ type: 'adjust', temperature: 250, vignette: 30, blur: 15 } as any);
    const call = h.store._updateTrackCalls[0];
    expect(call.id).toBe('v1');
    expect(call.patch.colorGrade.temperature).toBe(100); // clamped
    expect(call.patch.colorGrade.vignette).toBe(30);
    expect(call.patch.colorGrade.blur).toBe(15);
    expect(call.patch.colorGrade.curves).toBeTruthy(); // existing data preserved
  });

  it('reset clears adjustments but keeps extracted curves', async () => {
    await applyOpForTest({ type: 'adjust', reset: true } as any);
    const cg = h.store._updateTrackCalls[0].patch.colorGrade;
    expect(cg.temperature).toBeUndefined();
    expect(cg.curves).toBeTruthy();
  });
});

describe('exportSettings op', () => {
  beforeEach(() => { h.store = h.make(); });

  it('applies a preset and explicit overrides with clamping', async () => {
    await applyOpForTest({ type: 'exportSettings', preset: 'tiktok' } as any);
    expect(h.store.exportSettings.preset).toBe('tiktok');
    await applyOpForTest({ type: 'exportSettings', codec: 'hevc', crf: 99, fps: 60 } as any);
    expect(h.store.exportSettings.videoCodec).toBe('hevc');
    expect(h.store.exportSettings.crf).toBe(51); // clamped
    expect(h.store.exportSettings.fps).toBe(60);
    await applyOpForTest({ type: 'exportSettings', reset: true } as any);
    expect(h.store.exportSettings).toEqual({});
  });

  it('rejects unknown presets and codecs', async () => {
    await expect(applyOpForTest({ type: 'exportSettings', preset: 'myspace' } as any)).rejects.toThrow(/unknown preset/);
    await expect(applyOpForTest({ type: 'exportSettings', codec: 'av1' } as any)).rejects.toThrow(/h264/);
  });
});

describe('exportSrt op', () => {
  beforeEach(() => { h.store = h.make(); writeCalls.length = 0; });

  it('writes SRT from timeline subtitle tracks', async () => {
    h.store.tracks.push({
      id: 's1', type: 'subtitle', visible: true, subtitleText: 'hello world',
      subtitleStartTime: 1.0, subtitleEndTime: 2.5, startFrame: 30, endFrame: 75,
    });
    await applyOpForTest({ type: 'exportSrt' } as any);
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0].filename).toBe('captions.srt');
    expect(writeCalls[0].content).toContain('00:00:01,000 --> 00:00:02,500');
    expect(writeCalls[0].content).toContain('hello world');
  });

  it('falls back to the cached transcript and appends .srt to filenames', async () => {
    h.store.mediaLibrary.push({
      id: 'm1',
      cachedKaraokeSubtitles: {
        transcriptionResult: {
          segments: [{ start: 0.5, end: 2.0, text: ' from the transcript ' }],
        },
      },
    });
    await applyOpForTest({ type: 'exportSrt', filename: 'episode-12' } as any);
    expect(writeCalls[0].filename).toBe('episode-12.srt');
    expect(writeCalls[0].content).toContain('from the transcript');
  });

  it('throws when there is nothing to export', async () => {
    await expect(applyOpForTest({ type: 'exportSrt' } as any)).rejects.toThrow(/transcribe first/);
  });
});

describe('marker ops', () => {
  beforeEach(() => { h.store = h.make(); writeCalls.length = 0; });

  it('addMarker converts seconds to display-fps frames', async () => {
    await applyOpForTest({ type: 'addMarker', atSeconds: 12.5, label: 'Hook ends' } as any);
    expect(h.store._markerCalls[0]).toMatchObject({ op: 'add', frame: 375, label: 'Hook ends' });
  });

  it('addMarker requires a label', async () => {
    await expect(applyOpForTest({ type: 'addMarker', atSeconds: 1 } as any)).rejects.toThrow(/label/);
  });

  it('removeMarker matches by fuzzy label and by nearest time within 2s', async () => {
    await applyOpForTest({ type: 'addMarker', atSeconds: 10, label: 'Hook ends' } as any);
    await applyOpForTest({ type: 'addMarker', atSeconds: 50, label: 'Outro' } as any);
    await applyOpForTest({ type: 'removeMarker', label: 'hook' } as any);
    expect(h.store.timeline.timelineMarkers.map((m: any) => m.label)).toEqual(['Outro']);
    await applyOpForTest({ type: 'removeMarker', atSeconds: 51 } as any);
    expect(h.store.timeline.timelineMarkers).toEqual([]);
    await expect(applyOpForTest({ type: 'removeMarker', label: 'ghost' } as any)).rejects.toThrow(/no matching/);
  });

  it('exportChapters writes the chapter list; throws with no markers', async () => {
    await expect(applyOpForTest({ type: 'exportChapters' } as any)).rejects.toThrow(/add markers/);
    await applyOpForTest({ type: 'addMarker', atSeconds: 12, label: 'Hook ends' } as any);
    await applyOpForTest({ type: 'exportChapters' } as any);
    expect(writeCalls[0].filename).toBe('chapters.txt');
    expect(writeCalls[0].content).toBe('0:00 Intro\n0:12 Hook ends\n');
  });
});
