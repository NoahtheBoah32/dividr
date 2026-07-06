/**
 * rnnoiseDenoiser — lazily loads the RNNoise AudioWorklet (sapphi-red) on a
 * shared AudioContext and creates a REAL-TIME denoiser node.
 *
 * RNNoise is the lightweight Xiph speech model already shipped for the ffmpeg
 * export bake (std.rnnn). Here it runs LIVE inside the Web Audio graph so the
 * voice is cleaned with no offline render / no bake step — the denoise itself is
 * real-time, frame by frame.
 *
 * Everything is best-effort: any failure (worklet won't load, wrong sample rate,
 * wasm fetch fails) returns null and the caller keeps the native voice-forward
 * chain. Audio is NEVER silenced because of this.
 *
 * RNNoise is trained at 48 kHz only, so callers must use a 48 kHz AudioContext;
 * this module gates on `ctx.sampleRate === 48000`.
 */

import {
  RnnoiseWorkletNode,
  loadRnnoise,
} from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

/**
 * One-time per-context setup (addModule + fetch the wasm binary), shared by all
 * sources on that context. Resolves to the wasm ArrayBuffer, or null on failure.
 */
const perContext = new WeakMap<BaseAudioContext, Promise<ArrayBuffer | null>>();

function prepare(ctx: AudioContext): Promise<ArrayBuffer | null> {
  const existing = perContext.get(ctx);
  if (existing) return existing;
  const p = (async (): Promise<ArrayBuffer | null> => {
    try {
      const [wasmBinary] = await Promise.all([
        loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
        ctx.audioWorklet.addModule(rnnoiseWorkletUrl),
      ]);
      return wasmBinary;
    } catch (e) {
      console.warn('[VoiceIsolation] RNNoise worklet unavailable:', e);
      return null;
    }
  })();
  perContext.set(ctx, p);
  return p;
}

/**
 * Create a real-time RNNoise denoiser node for `ctx`, or null on any failure or
 * if the context is not 48 kHz. The node is an AudioWorkletNode; connect it
 * inline in the graph (source -> rnnoise -> ...).
 */
export async function createRnnoiseNode(
  ctx: AudioContext,
): Promise<AudioNode | null> {
  if (ctx.sampleRate !== 48000) return null; // RNNoise is 48k-only
  const wasmBinary = await prepare(ctx);
  if (!wasmBinary) return null;
  try {
    return new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 2 });
  } catch (e) {
    console.warn('[VoiceIsolation] RNNoise node creation failed:', e);
    return null;
  }
}
