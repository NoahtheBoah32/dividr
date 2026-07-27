/**
 * VoiceIsolationEngine — real-time voice isolation for preview playback.
 *
 * DiviDr plays timeline audio through one HTMLAudioElement per source
 * (MultiAudioOverlay). To change the audio LIVE while it plays, we tap that
 * element with the Web Audio API and route it through a graphic-EQ graph whose
 * per-band gains come from the user's separation curve
 * (see voiceIsolationCurve.ts). Dragging the curve updates the band gains
 * immediately, so the change is audible in real time.
 *
 * Robustness rules (this guards a live presentation):
 * - We only tap an element when isolation is ENABLED for its source. Tapping is
 *   irreversible (createMediaElementSource captures the element), so once tapped
 *   we keep it tapped; "disabled" simply applies a flat 0 dB curve (transparent).
 *   There is never a disconnect/reconnect race.
 * - Existing controls keep working: element.volume / element.muted are applied
 *   BEFORE the graph tap, so volume, mute and ducking are unaffected.
 * - If the tap ever throws, we leave the element on its native output (audio
 *   still plays, just without isolation) and log — never silence.
 *
 * The same band mapping is baked at export by ffmpeg (buildFfmpegEqChain), so
 * preview and export stay consistent.
 */

import {
  type CurveNode,
  computeBandGains,
  voiceForwardParams,
  stemMixGains,
  EQ_BANDS,
} from '../utils/voiceIsolationCurve';
import { createRnnoiseNode } from './rnnoiseDenoiser';
import {
  createReverbSuppressorNode,
  generateReverbIR,
  reverbAddParams,
} from './reverbStageNode';

/**
 * Reverb Processor stage, spliced at the very END of the chain (after makeup)
 * so it hears the fully processed voice:
 *
 *   tail -> input -> [suppressor] -> core -> dry ────────────┐
 *                                    core -> predelay ->      ├-> sum -> analyser
 *                                    convolver -> wet ────────┘
 *
 * amount > 0: wet gain up (genuine convolution with a diffuse synthetic IR).
 * amount < 0: suppressor strength up (live STFT late-reverb suppression), wet 0.
 * amount = 0: wet 0 + strength 0 = transparent. All three states are pure
 * parameter changes — dragging the slider never reconnects anything.
 */
interface ReverbNodes {
  input: GainNode;
  /** After the optional suppressor splice: input -> [suppressor] -> core. */
  core: GainNode;
  suppressor: AudioWorkletNode | null;
  dry: GainNode;
  predelay: DelayNode;
  convolver: ConvolverNode;
  wet: GainNode;
  sum: GainNode;
  /** Quantized amount the current IR was generated for (avoid per-frame regen). */
  irKey: number;
}

interface SourceGraph {
  element: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  /**
   * Passthrough gain that is the FIRST node after the (irreversible) element
   * tap. The real-time RNNoise denoiser worklet is spliced in here later without
   * ever re-tapping the element: preGain -> [denoiser] -> highpass.
   */
  preGain: GainNode;
  /** Real-time RNNoise denoiser (null until/unless the worklet attaches). */
  denoiser: AudioNode | null;
  /** Sub-bass / rumble high-pass (mud removal). */
  highpass: BiquadFilterNode;
  /** Graphic-EQ bands driven by the separation curve. */
  filters: BiquadFilterNode[];
  /** Presence lift (~2.8 kHz) for clarity. */
  presence: BiquadFilterNode;
  /** Brings the voice forward / evens dynamics. */
  compressor: DynamicsCompressorNode;
  /** Makeup gain so the voice gets LOUDER, not only quieter. */
  makeup: GainNode;
  analyser: AnalyserNode;
  /** Optional real-time reverb stage, spliced at the chain tail. */
  reverb?: ReverbNodes;
}

/**
 * Two-stem graph: the baked VOICE stem runs through the SAME isolation chain as
 * the single-source graph (so the curve EQ cleans residual background bleed from
 * the voice stem), the baked BACKGROUND stem is a clean parallel layer, and the
 * curve's endpoints set each stem's level before they sum:
 *
 *   voiceEl -> voiceSrc -> preGain -> highpass -> eq... -> presence
 *           -> compressor -> makeup -> voiceGain ─┐
 *   bgEl    -> bgSrc -> bgGain ───────────────────┤-> sum -> analyser -> dest
 *
 * Pulling the curve's left (noise) side down drives bgGain toward 0 AND cuts the
 * low-voiceness EQ bands, so the background truly disappears.
 */
interface StemGraph {
  voiceEl: HTMLMediaElement;
  bgEl: HTMLMediaElement;
  voiceSrc: MediaElementAudioSourceNode;
  bgSrc: MediaElementAudioSourceNode;
  preGain: GainNode;
  highpass: BiquadFilterNode;
  filters: BiquadFilterNode[];
  presence: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  makeup: GainNode;
  /** Voice stem level (curve right endpoint). */
  voiceGain: GainNode;
  /** Background stem level (curve left endpoint). */
  bgGain: GainNode;
  /** Summed bus the two stems mix into. */
  sum: GainNode;
  analyser: AnalyserNode;
}

class VoiceIsolationEngineImpl {
  private ctx: AudioContext | null = null;
  private graphs = new Map<string, SourceGraph>();
  /** Two-stem mixers, keyed by the SAME (original) sourceId as the EQ graph. */
  private stemGraphs = new Map<string, StemGraph>();
  /** Last curve applied per source, so a freshly (re)tapped element catches up. */
  private lastNodes = new Map<string, CurveNode[]>();
  /** Sources whose real-time RNNoise node is mid-load (avoid double-attaching). */
  private denoiserLoading = new Set<string>();
  /** Last reverb amount per source, so a late suppressor worklet catches up. */
  private lastReverb = new Map<string, number>();
  /** Sources whose suppressor worklet is mid-load (avoid double-attaching). */
  private reverbLoading = new Set<string>();

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const Ctor =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    // RNNoise is trained at 48 kHz only, so request a 48 kHz context. The
    // element audio is resampled into the graph automatically. Fall back to the
    // default rate if 48 kHz is refused (rare) — the native voice-forward chain
    // still works, only the live RNNoise denoise is gated off.
    try {
      this.ctx = new Ctor({ sampleRate: 48000 });
    } catch {
      try {
        this.ctx = new Ctor();
      } catch (e) {
        console.warn('[VoiceIsolation] AudioContext unavailable:', e);
        return null;
      }
    }
    return this.ctx;
  }

  /** Resume the context (call on a user gesture / play). Safe to call often. */
  resume(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  /**
   * Ensure the given element (playing `sourceId`) is tapped and routed through
   * the isolation graph, then apply `nodes` (or a flat curve when disabled).
   * Idempotent: safe to call every animation frame.
   */
  apply(
    sourceId: string,
    element: HTMLMediaElement,
    nodes: CurveNode[],
    enabled: boolean,
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    let graph = this.graphs.get(sourceId);

    // If the element for this source changed (MultiAudioOverlay recreated it),
    // tear down the stale graph and re-tap the new element.
    if (graph && graph.element !== element) {
      this.teardown(sourceId);
      graph = undefined;
    }

    if (!graph) {
      graph = this.buildGraph(ctx, element);
      if (!graph) return; // tap failed — element stays on native output
      this.graphs.set(sourceId, graph);
    }

    this.resume();
    this.lastNodes.set(sourceId, nodes);
    this.setBandGains(ctx, graph, enabled ? nodes : null);

    // Real-time RNNoise denoise: attach when enabled, bypass when off. This is
    // what actually strips ambiance from UNDER the voice (the EQ/compressor
    // alone can't). Best-effort and async — the native chain carries the audio
    // until (or unless) the worklet attaches.
    if (enabled) this.ensureDenoiser(sourceId, ctx);
    else this.detachDenoiser(sourceId);
  }

  /**
   * Two-stem live mix. Plays the baked VOICE + BACKGROUND stems (two separate
   * elements) through the stem graph and drives the mix + the voice-stem EQ from
   * the curve. Idempotent — safe to call every animation frame. When the stem
   * elements change (re-baked / different clip) the graph is rebuilt.
   */
  applyStems(
    sourceId: string,
    voiceEl: HTMLMediaElement,
    bgEl: HTMLMediaElement,
    nodes: CurveNode[],
    enabled: boolean,
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    let graph = this.stemGraphs.get(sourceId);
    if (graph && (graph.voiceEl !== voiceEl || graph.bgEl !== bgEl)) {
      this.teardownStems(sourceId);
      graph = undefined;
    }
    if (!graph) {
      graph = this.buildStemGraph(ctx, voiceEl, bgEl);
      if (!graph) return; // tap failed — elements stay on native output
      this.stemGraphs.set(sourceId, graph);
    }

    this.resume();
    this.lastNodes.set(sourceId, nodes);
    this.setStemGains(ctx, graph, enabled ? nodes : null);
  }

  private buildStemGraph(
    ctx: AudioContext,
    voiceEl: HTMLMediaElement,
    bgEl: HTMLMediaElement,
  ): StemGraph | null {
    let voiceSrc: MediaElementAudioSourceNode;
    let bgSrc: MediaElementAudioSourceNode;
    try {
      voiceSrc = ctx.createMediaElementSource(voiceEl);
    } catch (e) {
      console.warn('[VoiceIsolation] could not tap voice stem:', e);
      return null;
    }
    try {
      bgSrc = ctx.createMediaElementSource(bgEl);
    } catch (e) {
      // Voice tapped but bg failed — leave both on native output to avoid a
      // half-wired graph that only sums one stem.
      console.warn('[VoiceIsolation] could not tap background stem:', e);
      return null;
    }

    const preGain = ctx.createGain();
    preGain.gain.value = 1;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 20;
    highpass.Q.value = 0.707;

    const filters: BiquadFilterNode[] = EQ_BANDS.map((band) => {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      f.Q.value = band.q;
      f.gain.value = 0;
      return f;
    });

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2800;
    presence.Q.value = 1;
    presence.gain.value = 0;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = 0;
    compressor.ratio.value = 1;
    compressor.knee.value = 0;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.18;

    const makeup = ctx.createGain();
    makeup.gain.value = 1;
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 1;
    const bgGain = ctx.createGain();
    bgGain.gain.value = 1;
    const sum = ctx.createGain();
    sum.gain.value = 1;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;

    // Voice stem -> full isolation chain -> voiceGain -> sum
    voiceSrc.connect(preGain);
    preGain.connect(highpass);
    let node: AudioNode = highpass;
    for (const f of filters) {
      node.connect(f);
      node = f;
    }
    node.connect(presence);
    presence.connect(compressor);
    compressor.connect(makeup);
    makeup.connect(voiceGain);
    voiceGain.connect(sum);
    // Background stem -> bgGain -> sum (clean parallel layer)
    bgSrc.connect(bgGain);
    bgGain.connect(sum);
    sum.connect(analyser);
    analyser.connect(ctx.destination);

    return {
      voiceEl,
      bgEl,
      voiceSrc,
      bgSrc,
      preGain,
      highpass,
      filters,
      presence,
      compressor,
      makeup,
      voiceGain,
      bgGain,
      sum,
      analyser,
    };
  }

  /**
   * Apply the curve to a stem graph (smoothed). `null` => transparent original
   * mix (flat, both stems at unity), so "disabled" sums the two stems back to the
   * untouched clip.
   *
   * The voice stem is ALREADY cleaned by DeepFilterNet at bake time, so we do NOT
   * run the curve's cutting EQ on it — that scooped the mids out of the voice and
   * made it sound muffled ("eating a towel") as the user pulled the background
   * down. Instead the voice path stays essentially transparent with only a gentle
   * fixed clarity touch (sub-bass high-pass + small presence lift), and the curve
   * controls the MIX: its right endpoint = voice level, left endpoint = background
   * level. So dragging the left side down removes the background WITHOUT degrading
   * the voice.
   */
  private setStemGains(
    ctx: AudioContext,
    graph: StemGraph,
    nodes: CurveNode[] | null,
  ): void {
    const now = ctx.currentTime;
    const S = 0.02;

    // Voice path is always near-transparent (filters flat, compressor off). The
    // only difference between enabled/disabled is the stem mix levels.
    for (const f of graph.filters) f.gain.setTargetAtTime(0, now, S);
    graph.compressor.threshold.setValueAtTime(0, now);
    graph.compressor.ratio.setValueAtTime(1, now);
    graph.compressor.knee.setValueAtTime(0, now);

    if (!nodes) {
      graph.highpass.frequency.setTargetAtTime(20, now, S);
      graph.presence.gain.setTargetAtTime(0, now, S);
      graph.makeup.gain.setTargetAtTime(1, now, S);
      graph.voiceGain.gain.setTargetAtTime(1, now, S);
      graph.bgGain.gain.setTargetAtTime(1, now, S);
      return;
    }

    // Gentle, FIXED clarity touch on the clean voice (does not muffle).
    graph.highpass.frequency.setTargetAtTime(60, now, S); // drop sub-bass rumble only
    graph.presence.frequency.setTargetAtTime(3000, now, S);
    graph.presence.gain.setTargetAtTime(1.5, now, S); // light intelligibility lift
    graph.makeup.gain.setTargetAtTime(1, now, S);

    // Curve endpoints set the mix (voice = right, background = left).
    const mix = stemMixGains(nodes);
    graph.voiceGain.gain.setTargetAtTime(mix.voice, now, S);
    graph.bgGain.gain.setTargetAtTime(mix.bg, now, S);
  }

  /** Disconnect + forget a source's stem graph. */
  teardownStems(sourceId: string): void {
    const g = this.stemGraphs.get(sourceId);
    if (!g) return;
    try {
      g.voiceSrc.disconnect();
      g.bgSrc.disconnect();
      g.preGain.disconnect();
      g.highpass.disconnect();
      g.filters.forEach((f) => f.disconnect());
      g.presence.disconnect();
      g.compressor.disconnect();
      g.makeup.disconnect();
      g.voiceGain.disconnect();
      g.bgGain.disconnect();
      g.sum.disconnect();
      g.analyser.disconnect();
    } catch {
      /* already gone */
    }
    this.stemGraphs.delete(sourceId);
  }

  /**
   * Kick off (once) the async load + splice of the real-time RNNoise denoiser
   * for a tapped, enabled source. Idempotent: no-op if already attached or
   * loading. Never throws into the caller.
   */
  private ensureDenoiser(sourceId: string, ctx: AudioContext): void {
    const graph = this.graphs.get(sourceId);
    if (!graph || graph.denoiser || this.denoiserLoading.has(sourceId)) return;
    if (ctx.sampleRate !== 48000) return; // can't denoise correctly off-48k
    this.denoiserLoading.add(sourceId);
    createRnnoiseNode(ctx)
      .then((node) => {
        if (!node) return;
        // The graph may have been torn down (or the source re-tapped) while the
        // worklet loaded — only attach if this exact graph still exists.
        const g = this.graphs.get(sourceId);
        if (!g || g.denoiser) {
          try {
            (node as any).disconnect?.();
          } catch {
            /* noop */
          }
          return;
        }
        this.attachDenoiser(sourceId, node);
      })
      .catch((e) =>
        console.warn('[VoiceIsolation] RNNoise load failed:', e),
      )
      .finally(() => this.denoiserLoading.delete(sourceId));
  }

  /** Remove the denoiser from the chain (clean bypass): preGain -> highpass. */
  detachDenoiser(sourceId: string): void {
    const graph = this.graphs.get(sourceId);
    if (!graph || !graph.denoiser) return;
    try {
      graph.preGain.disconnect();
      graph.denoiser.disconnect();
      graph.preGain.connect(graph.highpass);
    } catch (e) {
      console.warn('[VoiceIsolation] denoiser detach failed:', e);
    }
    graph.denoiser = null;
  }

  private buildGraph(
    ctx: AudioContext,
    element: HTMLMediaElement,
  ): SourceGraph | null {
    let source: MediaElementAudioSourceNode;
    try {
      source = ctx.createMediaElementSource(element);
    } catch (e) {
      // Most likely the element was already tapped elsewhere. Don't risk
      // silencing it — bail and let it play natively.
      console.warn('[VoiceIsolation] could not tap element:', e);
      return null;
    }

    const preGain = ctx.createGain();
    preGain.gain.value = 1;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 20; // no-op until enabled
    highpass.Q.value = 0.707;

    const filters: BiquadFilterNode[] = EQ_BANDS.map((band) => {
      const f = ctx.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      f.Q.value = band.q;
      f.gain.value = 0;
      return f;
    });

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2800;
    presence.Q.value = 1;
    presence.gain.value = 0;

    const compressor = ctx.createDynamicsCompressor();
    // Transparent until enabled (ratio 1 = no compression).
    compressor.threshold.value = 0;
    compressor.ratio.value = 1;
    compressor.knee.value = 0;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.18;

    const makeup = ctx.createGain();
    makeup.gain.value = 1;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;

    // source -> preGain -> [denoiser slot] -> highpass -> eq... -> presence
    //        -> compressor -> makeup -> analyser -> destination
    source.connect(preGain);
    let node: AudioNode = preGain; // denoiser splices between preGain and highpass
    node.connect(highpass);
    node = highpass;
    for (const f of filters) {
      node.connect(f);
      node = f;
    }
    node.connect(presence);
    presence.connect(compressor);
    compressor.connect(makeup);
    makeup.connect(analyser);
    analyser.connect(ctx.destination);

    return {
      element,
      source,
      preGain,
      denoiser: null,
      highpass,
      filters,
      presence,
      compressor,
      makeup,
      analyser,
    };
  }

  /**
   * Splice a real-time denoiser node (the RNNoise AudioWorklet) into an
   * already-tapped graph: preGain -> denoiser -> highpass. This never re-taps the
   * element (createMediaElementSource is irreversible), so it's safe to call once
   * the worklet finishes its async load. No-op if already attached or untapped.
   */
  attachDenoiser(sourceId: string, node: AudioNode): boolean {
    const graph = this.graphs.get(sourceId);
    if (!graph || graph.denoiser) return false;
    try {
      graph.preGain.disconnect();
      graph.preGain.connect(node);
      node.connect(graph.highpass);
      graph.denoiser = node;
      return true;
    } catch (e) {
      // Restore the direct path so audio is never broken.
      try {
        graph.preGain.disconnect();
        graph.preGain.connect(graph.highpass);
      } catch {
        /* best effort */
      }
      console.warn('[VoiceIsolation] denoiser attach failed:', e);
      return false;
    }
  }

  hasDenoiser(sourceId: string): boolean {
    return !!this.graphs.get(sourceId)?.denoiser;
  }

  /**
   * Apply the full chain from the curve (smoothed). `null` => transparent
   * (flat EQ, no presence, no compression, unity makeup, high-pass disabled), so
   * toggling the effect off is audibly a clean bypass while the tap stays put.
   */
  private setBandGains(
    ctx: AudioContext,
    graph: SourceGraph,
    nodes: CurveNode[] | null,
  ): void {
    const now = ctx.currentTime;
    const S = 0.02; // ~20ms smoothing -> click-free while dragging

    if (!nodes) {
      for (const f of graph.filters) f.gain.setTargetAtTime(0, now, S);
      graph.highpass.frequency.setTargetAtTime(20, now, S);
      graph.presence.gain.setTargetAtTime(0, now, S);
      graph.makeup.gain.setTargetAtTime(1, now, S);
      // Compressor params can't be smoothed the same way; set transparent.
      graph.compressor.threshold.setValueAtTime(0, now);
      graph.compressor.ratio.setValueAtTime(1, now);
      graph.compressor.knee.setValueAtTime(0, now);
      return;
    }

    // Separation-curve EQ bands.
    const gains = computeBandGains(nodes);
    for (let i = 0; i < graph.filters.length; i++) {
      graph.filters[i].gain.setTargetAtTime(gains[i]?.db ?? 0, now, S);
    }

    // Voice-forward chain (high-pass + presence + compressor + makeup) — this is
    // what actually pushes the voice forward (louder + clearer), which an EQ that
    // only cuts can never do.
    const p = voiceForwardParams(nodes);
    graph.highpass.frequency.setTargetAtTime(p.highpassHz, now, S);
    graph.presence.frequency.setTargetAtTime(p.presenceHz, now, S);
    graph.presence.gain.setTargetAtTime(p.presenceDb, now, S);
    graph.makeup.gain.setTargetAtTime(Math.pow(10, p.makeupDb / 20), now, S);
    graph.compressor.threshold.setValueAtTime(p.compressor.thresholdDb, now);
    graph.compressor.ratio.setValueAtTime(p.compressor.ratio, now);
    graph.compressor.knee.setValueAtTime(p.compressor.knee, now);
    graph.compressor.attack.setValueAtTime(p.compressor.attack, now);
    graph.compressor.release.setValueAtTime(p.compressor.release, now);
  }

  /**
   * Update only the curve for an already-tapped source — zero-latency path the
   * panel calls on every drag tick (no React re-render needed). If the source
   * isn't tapped yet (not playing), the nodes are remembered for the next apply.
   */
  updateCurve(sourceId: string, nodes: CurveNode[], enabled: boolean): void {
    this.lastNodes.set(sourceId, nodes);
    const ctx = this.ctx;
    if (!ctx) return;
    // Route to whichever graph is live for this source. In stem mode the EQ
    // graph (if any) is paused/silent, so updating the stem graph is what the
    // user hears; updating both is harmless and keeps either path in sync.
    const stem = this.stemGraphs.get(sourceId);
    if (stem) this.setStemGains(ctx, stem, enabled ? nodes : null);
    const graph = this.graphs.get(sourceId);
    if (graph) this.setBandGains(ctx, graph, enabled ? nodes : null);
  }

  /** Analyser for the live spectrogram in the panel (null if not tapped yet). */
  getAnalyser(sourceId: string): AnalyserNode | null {
    return (
      this.stemGraphs.get(sourceId)?.analyser ??
      this.graphs.get(sourceId)?.analyser ??
      null
    );
  }

  isTapped(sourceId: string): boolean {
    return this.graphs.has(sourceId) || this.stemGraphs.has(sourceId);
  }

  // -------------------------------------------------------------------------
  // Reverb Processor (live) — same lazy-splice discipline as the denoiser.
  // -------------------------------------------------------------------------

  /** Splice the reverb stage at the tail of the chain (after makeup). */
  private attachReverb(graph: SourceGraph, ctx: AudioContext): void {
    if (graph.reverb) return;
    try {
      const input = ctx.createGain();
      const core = ctx.createGain();
      const dry = ctx.createGain();
      dry.gain.value = 1;
      const predelay = ctx.createDelay(0.12);
      predelay.delayTime.value = 0.01;
      const convolver = ctx.createConvolver();
      // We energy-normalize the IR ourselves so wet loudness tracks the bake.
      convolver.normalize = false;
      const wet = ctx.createGain();
      wet.gain.value = 0;
      const sum = ctx.createGain();

      input.connect(core); // suppressor splices between input and core later
      core.connect(dry);
      dry.connect(sum);
      core.connect(predelay);
      predelay.connect(convolver);
      convolver.connect(wet);
      wet.connect(sum);

      const tail: AudioNode = graph.makeup;
      tail.disconnect(); // was makeup -> analyser
      tail.connect(input);
      sum.connect(graph.analyser);

      graph.reverb = { input, core, suppressor: null, dry, predelay, convolver, wet, sum, irKey: 0 };
    } catch (e) {
      try {
        graph.makeup.disconnect();
        graph.makeup.connect(graph.analyser);
      } catch { /* best effort */ }
      console.warn('[ReverbStage] attach failed:', e);
    }
  }

  /** Splice the de-reverb worklet: input -> suppressor -> core (async load). */
  private ensureSuppressor(sourceId: string, ctx: AudioContext): void {
    const graph = this.graphs.get(sourceId);
    if (!graph?.reverb || graph.reverb.suppressor || this.reverbLoading.has(sourceId)) return;
    this.reverbLoading.add(sourceId);
    createReverbSuppressorNode(ctx)
      .then((node) => {
        this.reverbLoading.delete(sourceId);
        const g = this.graphs.get(sourceId);
        if (!node || !g?.reverb || g.reverb.suppressor) return;
        try {
          g.reverb.input.disconnect();
          g.reverb.input.connect(node);
          node.connect(g.reverb.core);
          g.reverb.suppressor = node;
          // catch the freshly loaded worklet up with the current amount
          const amt = this.lastReverb.get(sourceId) ?? 0;
          this.setReverbParams(ctx, g, amt);
        } catch (e) {
          console.warn('[ReverbStage] suppressor splice failed:', e);
        }
      })
      .catch(() => this.reverbLoading.delete(sourceId));
  }

  /** Apply the slider amount as pure parameter changes (safe every frame). */
  private setReverbParams(ctx: AudioContext, graph: SourceGraph, amount: number): void {
    const rev = graph.reverb;
    if (!rev) return;
    const t = ctx.currentTime;
    const strengthParam = rev.suppressor?.parameters.get('strength');

    if (amount > 0) {
      const p = reverbAddParams(amount);
      // IR regen only when the quantized room size changes (drag stays smooth:
      // wet gain + predelay glide continuously, the IR steps in 5-unit buckets).
      const irKey = Math.max(5, Math.round(amount / 5) * 5);
      if (rev.irKey !== irKey) {
        const q = reverbAddParams(irKey);
        rev.convolver.buffer = generateReverbIR(ctx, q.rt60, q.tilt, 0);
        rev.irKey = irKey;
      }
      rev.wet.gain.setTargetAtTime(p.wetGain, t, 0.03);
      rev.predelay.delayTime.setTargetAtTime(p.predelayMs / 1000, t, 0.03);
      strengthParam?.setValueAtTime(0, t);
    } else if (amount < 0) {
      rev.wet.gain.setTargetAtTime(0, t, 0.03);
      strengthParam?.setValueAtTime(Math.min(1, -amount / 50), t);
    } else {
      rev.wet.gain.setTargetAtTime(0, t, 0.03);
      strengthParam?.setValueAtTime(0, t);
    }
  }

  /**
   * Real-time Reverb Processor. Ensures the source is tapped + the stage is
   * spliced, then applies `amount` (-50..+50, 0 = transparent). Idempotent —
   * safe every frame. Shares the one owned element tap with isolation.
   */
  applyReverb(sourceId: string, element: HTMLMediaElement, amount: number, enabled: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    let graph = this.graphs.get(sourceId);
    if (graph && graph.element !== element) { this.teardown(sourceId); graph = undefined; }
    if (!graph) {
      graph = this.buildGraph(ctx, element) ?? undefined;
      if (!graph) return; // tap failed — element stays on native output
      this.graphs.set(sourceId, graph);
    }
    this.resume();
    this.attachReverb(graph, ctx);
    const eff = enabled ? Math.max(-50, Math.min(50, Math.round(amount))) : 0;
    this.lastReverb.set(sourceId, eff);
    this.setReverbParams(ctx, graph, eff);
    if (eff < 0) this.ensureSuppressor(sourceId, ctx);
  }

  /** True once the reverb stage is spliced for this source. */
  isReverbAttached(sourceId: string): boolean {
    return !!this.graphs.get(sourceId)?.reverb;
  }

  /** DEV/test read-back: live reverb node state. Null if the stage isn't spliced. */
  debugReverbState(sourceId: string): {
    wetGain: number;
    strength: number | null;
    suppressorAttached: boolean;
    irSeconds: number | null;
    predelayMs: number;
  } | null {
    const rev = this.graphs.get(sourceId)?.reverb;
    if (!rev) return null;
    return {
      wetGain: rev.wet.gain.value,
      strength: rev.suppressor?.parameters.get('strength')?.value ?? null,
      suppressorAttached: !!rev.suppressor,
      irSeconds: rev.convolver.buffer ? rev.convolver.buffer.duration : null,
      predelayMs: rev.predelay.delayTime.value * 1000,
    };
  }

  /**
   * DEV/test: record the live graph OUTPUT (post-reverb) for `ms` milliseconds
   * and return mono PCM. Proves what's audibly reaching the speakers.
   */
  async debugCaptureOutput(sourceId: string, ms: number): Promise<Float32Array | null> {
    const ctx = this.ctx;
    const graph = this.graphs.get(sourceId);
    if (!ctx || !graph) return null;
    const tapFrom = graph.reverb ? graph.reverb.sum : graph.makeup;
    const dest = ctx.createMediaStreamDestination();
    tapFrom.connect(dest);
    const rec = new MediaRecorder(dest.stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, ms));
    await new Promise<void>((r) => { rec.onstop = () => r(); rec.stop(); });
    try { tapFrom.disconnect(dest); } catch { /* fine */ }
    const buf = await new Blob(chunks).arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    return decoded.getChannelData(0);
  }

  /**
   * Current per-band gains (dB) actually live on the graph — for DEV/tests to
   * objectively confirm the curve reached the audio. Null when not tapped.
   */
  debugBandGainsDb(sourceId: string): number[] | null {
    const graph = this.graphs.get(sourceId);
    if (!graph) return null;
    return graph.filters.map((f) => f.gain.value);
  }

  /** Disconnect and forget a source's graph(s) (elements are being destroyed). */
  teardown(sourceId: string): void {
    this.teardownStems(sourceId);
    const graph = this.graphs.get(sourceId);
    if (!graph) return;
    try {
      graph.source.disconnect();
      graph.preGain.disconnect();
      graph.denoiser?.disconnect();
      graph.highpass.disconnect();
      graph.filters.forEach((f) => f.disconnect());
      graph.presence.disconnect();
      graph.compressor.disconnect();
      graph.makeup.disconnect();
      graph.reverb?.input.disconnect();
      graph.reverb?.suppressor?.disconnect();
      graph.reverb?.core.disconnect();
      graph.reverb?.dry.disconnect();
      graph.reverb?.predelay.disconnect();
      graph.reverb?.convolver.disconnect();
      graph.reverb?.wet.disconnect();
      graph.reverb?.sum.disconnect();
      graph.analyser.disconnect();
    } catch {
      /* already gone */
    }
    this.graphs.delete(sourceId);
    this.denoiserLoading.delete(sourceId);
    this.lastReverb.delete(sourceId);
    this.reverbLoading.delete(sourceId);
  }
}

export const VoiceIsolationEngine = new VoiceIsolationEngineImpl();

// DEV-only handle so the visual test harness can read live band gains and prove
// the curve reached the audio (mirrors the __videoEditorStore exposure).
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  (window as any).__voiceIsolationEngine = VoiceIsolationEngine;
}

export type { CurveNode };
