/**
 * voiceAgerNode — lazily loads the dependency-free formant-shift AudioWorklet and
 * creates a real-time pitch+formant shifter node for the Voice Ager (Skill 3).
 *
 * Mirrors rnnoiseDenoiser.ts exactly: one addModule per context (WeakMap-cached),
 * best-effort (null on any failure so the caller keeps the native aging chain and
 * audio is NEVER silenced), and the node is spliced inline into the existing graph
 * without ever re-tapping the element.
 *
 * No wasm, no npm dependency, no API key, no token — the worklet is our own JS,
 * served as an asset via Vite `?url` and loaded with ctx.audioWorklet.addModule().
 */
import formantWorkletUrl from './formantShiftWorklet.js?url';

const perContext = new WeakMap<BaseAudioContext, Promise<boolean>>();

function prepare(ctx: AudioContext): Promise<boolean> {
  const existing = perContext.get(ctx);
  if (existing) return existing;
  const p = (async (): Promise<boolean> => {
    try {
      await ctx.audioWorklet.addModule(formantWorkletUrl);
      return true;
    } catch (e) {
      console.warn('[VoiceAger] formant worklet unavailable:', e);
      return false;
    }
  })();
  perContext.set(ctx, p);
  return p;
}

/** A formant-shift worklet node with `ratio` and `jitter` AudioParams. */
export interface FormantShiftNode extends AudioWorkletNode {}

/**
 * Create a real-time formant/pitch shifter node, or null on any failure. Connect it
 * inline in the graph (… → formant → …). Control it live via node.parameters:
 *   node.parameters.get('ratio').setTargetAtTime(r, ctx.currentTime, 0.02)
 */
export async function createFormantShiftNode(ctx: AudioContext): Promise<FormantShiftNode | null> {
  const ok = await prepare(ctx);
  if (!ok) return null;
  try {
    return new AudioWorkletNode(ctx, 'formant-shift-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
  } catch (e) {
    console.warn('[VoiceAger] formant node creation failed:', e);
    return null;
  }
}
