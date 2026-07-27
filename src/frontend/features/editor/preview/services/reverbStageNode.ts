/**
 * reverbStageNode — loader for the live reverb-suppressor AudioWorklet plus the
 * synthetic impulse-response generator for the live ConvolverNode (add side).
 *
 * One addModule per context (WeakMap-cached),
 * best-effort null on failure so audio is never silenced, no wasm, no npm dep,
 * no API key — the worklet is our own JS served via Vite `?url`.
 *
 * The IR recipe is a port of scripts/reverb_processor.py `synth_ir` so preview
 * and export sound the same: decorrelated stereo gaussian noise, exponential
 * decay (-60 dB at rt60), progressive one-pole lowpass (air absorption), and
 * energy normalization for stable wet loudness across room sizes.
 */

const perContext = new WeakMap<BaseAudioContext, Promise<boolean>>();

import suppressorWorkletUrl from './reverbSuppressorWorklet.js?url';

function prepare(ctx: AudioContext): Promise<boolean> {
  const existing = perContext.get(ctx);
  if (existing) return existing;
  const p = (async (): Promise<boolean> => {
    try {
      await ctx.audioWorklet.addModule(suppressorWorkletUrl);
      return true;
    } catch (e) {
      console.warn('[ReverbStage] suppressor worklet unavailable:', e);
      return false;
    }
  })();
  perContext.set(ctx, p);
  return p;
}

/** Expose the worklet URL for offline (test) contexts. */
export function getSuppressorWorkletUrl(): string {
  return suppressorWorkletUrl;
}

/** Create the live de-reverb worklet node, or null on any failure. */
export async function createReverbSuppressorNode(
  ctx: AudioContext,
): Promise<AudioWorkletNode | null> {
  const ok = await prepare(ctx);
  if (!ok) return null;
  try {
    return new AudioWorkletNode(ctx, 'reverb-suppressor-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
  } catch (e) {
    console.warn('[ReverbStage] suppressor node creation failed:', e);
    return null;
  }
}

/** Mulberry32 — deterministic PRNG so the IR is identical across regenerations. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic diffuse stereo IR — port of reverb_processor.py synth_ir.
 * No discrete taps → physically cannot produce a "word repeated twice" echo.
 */
export function generateReverbIR(
  ctx: BaseAudioContext,
  rt60: number,
  tilt: number,
  predelayMs: number,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const tail = Math.round(sr * Math.max(0.15, rt60 * 1.1));
  const pre = Math.round((sr * predelayMs) / 1000);
  const buf = ctx.createBuffer(2, pre + tail, sr);

  const alphaStart = 0.02;
  const alphaEnd = Math.min(0.6, 0.08 + tilt);
  let maxEnergy = 0;
  const chans: Float32Array[] = [];

  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(7 + ch * 1013);
    const data = new Float32Array(pre + tail);
    let prev = 0;
    let energy = 0;
    for (let i = 0; i < tail; i++) {
      const t = i / sr;
      // Box-Muller gaussian
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const decay = Math.exp((-6.908 * t) / rt60);
      const alpha = alphaStart + ((alphaEnd - alphaStart) * i) / tail;
      prev = (1 - alpha) * g * decay + alpha * prev;
      data[pre + i] = prev;
      energy += prev * prev;
    }
    if (energy > maxEnergy) maxEnergy = energy;
    chans.push(data);
  }
  const norm = 1 / (Math.sqrt(maxEnergy) + 1e-9);
  for (let ch = 0; ch < 2; ch++) {
    const data = chans[ch];
    for (let i = 0; i < data.length; i++) data[i] *= norm;
    buf.copyToChannel(data as any, ch);
  }
  return buf;
}

/** Slider-amount (1..50) → IR + mix parameters. Matches the python bake mapping. */
export function reverbAddParams(amount: number): {
  rt60: number;
  wetGain: number;
  predelayMs: number;
  tilt: number;
} {
  const a = Math.min(50, Math.max(1, amount)) / 50;
  return {
    rt60: 0.25 + 2.35 * a,
    wetGain: 0.10 + 0.35 * a,
    predelayMs: 10 + 25 * a,
    tilt: 0.3 * a,
  };
}
