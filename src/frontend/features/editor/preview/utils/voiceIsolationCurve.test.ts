import { describe, it, expect } from 'vitest';
import {
  VOICE_ISOLATION_PRESETS,
  PASSTHROUGH_NODES,
  DEFAULT_VOICE_ISOLATION_NODES,
  normalizeNodes,
  sampleCurve,
  gainAtVoiceness,
  computeBandGains,
  curveHasEffect,
  buildFfmpegEqChain,
  buildFfmpegVoiceForwardChain,
  buildFfmpegVoiceChain,
  voiceForwardParams,
  stemMixGains,
  curveStrength,
  keepToDb,
  separationLabel,
  EQ_BANDS,
} from './voiceIsolationCurve';

describe('voiceIsolationCurve', () => {
  it('samples an ascending, clamped curve', () => {
    const s = sampleCurve(VOICE_ISOLATION_PRESETS.podcast);
    expect(s.length).toBeGreaterThan(10);
    for (const p of s) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('gainAtVoiceness honors the endpoints (podcast: noise low, voice high)', () => {
    const s = sampleCurve(VOICE_ISOLATION_PRESETS.podcast);
    expect(gainAtVoiceness(s, 0)).toBeCloseTo(0.1, 1); // noise/ambiance kept low
    expect(gainAtVoiceness(s, 1)).toBeCloseTo(0.94, 1); // voice kept high
    // voice end keeps more than noise end
    expect(gainAtVoiceness(s, 1)).toBeGreaterThan(gainAtVoiceness(s, 0));
  });

  it('cuts low-voiceness bands more than speech bands', () => {
    const bands = computeBandGains(VOICE_ISOLATION_PRESETS.podcast);
    const rumble = bands.find((b) => b.freq === 70)!;
    const speech = bands.find((b) => b.freq === 1000)!;
    const hiss = bands.find((b) => b.freq === 12000)!;
    expect(rumble.db).toBeLessThan(speech.db); // rumble cut more
    expect(hiss.db).toBeLessThan(speech.db); // hiss cut more
    expect(speech.db).toBeGreaterThan(-3); // voice largely preserved
    expect(rumble.db).toBeLessThan(-10); // background clearly attenuated
  });

  it('keepToDb clamps to [-40, 0] and never returns -Infinity', () => {
    expect(keepToDb(1)).toBeCloseTo(0, 5);
    expect(keepToDb(0)).toBe(-40);
    expect(keepToDb(-5)).toBe(-40);
    expect(Number.isFinite(keepToDb(0))).toBe(true);
  });

  it('passthrough curve has no effect and emits no ffmpeg chain', () => {
    expect(curveHasEffect(PASSTHROUGH_NODES)).toBe(false);
    expect(buildFfmpegEqChain(PASSTHROUGH_NODES)).toBe('');
  });

  it('podcast curve has effect and emits a valid ffmpeg chain', () => {
    expect(curveHasEffect(VOICE_ISOLATION_PRESETS.podcast)).toBe(true);
    const chain = buildFfmpegEqChain(VOICE_ISOLATION_PRESETS.podcast);
    expect(chain).toContain('bass=g=');
    expect(chain).toContain('equalizer=f=');
    // every fragment is well-formed
    for (const frag of chain.split(',')) {
      expect(frag).toMatch(/^(bass|treble|equalizer)=/);
      expect(frag).not.toContain('NaN');
      expect(frag).not.toContain('Infinity');
    }
  });

  it('shelf bands pin an explicit slope so preview/export roll-offs match', () => {
    // Studio cuts both extremes hard, guaranteeing a low- and high-shelf fragment.
    const chain = buildFfmpegEqChain(VOICE_ISOLATION_PRESETS.studio);
    const bassFrag = chain.split(',').find((f) => f.startsWith('bass='));
    const trebleFrag = chain.split(',').find((f) => f.startsWith('treble='));
    expect(bassFrag).toBeDefined();
    expect(trebleFrag).toBeDefined();
    // Web Audio shelves use a fixed slope (S=1); export must say so explicitly,
    // not fall back to ffmpeg's default width_type=q w=0.5.
    expect(bassFrag).toContain('width_type=s');
    expect(bassFrag).toContain('w=1');
    expect(trebleFrag).toContain('width_type=s');
    expect(trebleFrag).toContain('w=1');
  });

  it('normalizeNodes repairs garbage input', () => {
    expect(normalizeNodes(null)).toEqual(DEFAULT_VOICE_ISOLATION_NODES);
    expect(normalizeNodes([])).toEqual(DEFAULT_VOICE_ISOLATION_NODES);
    const repaired = normalizeNodes([
      { x: 2, y: -1 },
      { x: 0.5, y: 0.5 },
      { x: NaN, y: 0.2 },
    ] as any);
    // out-of-range clamped, NaN dropped, sorted ascending
    expect(repaired.every((n) => n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1)).toBe(
      true,
    );
    for (let i = 1; i < repaired.length; i++)
      expect(repaired[i].x).toBeGreaterThanOrEqual(repaired[i - 1].x);
  });

  it('separationLabel reflects aggressiveness', () => {
    expect(separationLabel(VOICE_ISOLATION_PRESETS.studio)).toBe('Aggressive');
    expect(['Natural', 'Gentle']).toContain(
      separationLabel(VOICE_ISOLATION_PRESETS.ambiance),
    );
  });

  it('curveStrength rises with aggressiveness (Light < Ambiance < Podcast < Studio)', () => {
    const light = curveStrength(VOICE_ISOLATION_PRESETS.light);
    const amb = curveStrength(VOICE_ISOLATION_PRESETS.ambiance);
    const pod = curveStrength(VOICE_ISOLATION_PRESETS.podcast);
    const studio = curveStrength(VOICE_ISOLATION_PRESETS.studio);
    expect(light).toBeLessThan(amb);
    expect(amb).toBeLessThan(pod);
    expect(pod).toBeLessThan(studio);
    for (const s of [light, amb, pod, studio]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('voiceForwardParams brings the voice forward (positive makeup + presence)', () => {
    const p = voiceForwardParams(VOICE_ISOLATION_PRESETS.podcast);
    // The voice must get LOUDER and CLEARER, never only quieter.
    expect(p.makeupDb).toBeGreaterThan(0);
    expect(p.presenceDb).toBeGreaterThan(0);
    expect(p.highpassHz).toBeGreaterThanOrEqual(70);
    expect(p.compressor.ratio).toBeGreaterThan(1);
    // Makeup must more than offset the compressor's gain reduction at speech
    // level (~-18 dB RMS), otherwise the net result is quieter (the bug).
    const speechRms = -18;
    const overThresh = speechRms - p.compressor.thresholdDb;
    const reductionDb =
      overThresh > 0 ? overThresh * (1 - 1 / p.compressor.ratio) : 0;
    expect(p.makeupDb).toBeGreaterThan(reductionDb);
  });

  it('buildFfmpegVoiceForwardChain emits highpass + presence + compressor', () => {
    const chain = buildFfmpegVoiceForwardChain(VOICE_ISOLATION_PRESETS.podcast);
    expect(chain).toContain('highpass=f=');
    expect(chain).toContain('equalizer=f=2800');
    expect(chain).toContain('acompressor=');
    for (const frag of chain.split(',')) {
      expect(frag).not.toContain('NaN');
      expect(frag).not.toContain('Infinity');
    }
  });

  it('buildFfmpegVoiceChain includes the voice-forward chain even when the curve EQ is flat', () => {
    // Passthrough => EQ chain is empty, but isolation still pushes the voice
    // forward, so the full chain must NOT be empty.
    const full = buildFfmpegVoiceChain(PASSTHROUGH_NODES);
    expect(buildFfmpegEqChain(PASSTHROUGH_NODES)).toBe('');
    expect(full).toContain('highpass=f=');
    expect(full).toContain('acompressor=');
    // Podcast => EQ + voice-forward, EQ first.
    const pod = buildFfmpegVoiceChain(VOICE_ISOLATION_PRESETS.podcast);
    expect(pod.indexOf('equalizer=f=1000')).toBeLessThan(pod.indexOf('highpass='));
  });

  it('stemMixGains maps curve endpoints to stem levels (voice=right, bg=left)', () => {
    // Podcast: left endpoint low (background mostly out), right endpoint high (voice kept).
    const pod = stemMixGains(VOICE_ISOLATION_PRESETS.podcast);
    expect(pod.voice).toBeGreaterThan(pod.bg);
    expect(pod.voice).toBeGreaterThan(0.8);
    expect(pod.bg).toBeLessThan(0.2);
    // Pulling the left node to zero fully mutes the background stem.
    const isolate = stemMixGains([
      { x: 0, y: 0 },
      { x: 0.34, y: 0.1 },
      { x: 0.66, y: 0.9 },
      { x: 1, y: 1 },
    ]);
    expect(isolate.bg).toBe(0);
    expect(isolate.voice).toBeCloseTo(1, 5);
    // Passthrough keeps both stems full (original mix).
    const orig = stemMixGains(PASSTHROUGH_NODES);
    expect(orig.voice).toBeCloseTo(1, 5);
    expect(orig.bg).toBeCloseTo(1, 5);
    // Always clamped to [0,1].
    for (const g of [pod, isolate, orig]) {
      expect(g.voice).toBeGreaterThanOrEqual(0);
      expect(g.voice).toBeLessThanOrEqual(1);
      expect(g.bg).toBeGreaterThanOrEqual(0);
      expect(g.bg).toBeLessThanOrEqual(1);
    }
  });

  it('EQ band table is monotone in frequency and covers speech', () => {
    for (let i = 1; i < EQ_BANDS.length; i++)
      expect(EQ_BANDS[i].freq).toBeGreaterThan(EQ_BANDS[i - 1].freq);
    expect(EQ_BANDS.some((b) => b.voiceness >= 0.99)).toBe(true);
    expect(EQ_BANDS[0].type).toBe('lowshelf');
    expect(EQ_BANDS[EQ_BANDS.length - 1].type).toBe('highshelf');
  });
});
