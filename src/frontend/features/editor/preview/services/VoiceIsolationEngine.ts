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
import { createFormantShiftNode, type FormantShiftNode } from './voiceAgerNode';
import type { AgeParams } from '../utils/voiceAgeParams';

/**
 * Voice Ager (Skill 3) nodes, spliced AFTER makeup: makeup -> input -> [formant]
 * -> body -> tilt -> brilliance -> throat -> comp -> analyser. Transparent (all
 * gains 0, ratio 1) when disabled, so toggling never causes a reconnect race.
 */
interface AgerNodes {
  input: GainNode;
  formant: FormantShiftNode | null;
  body: BiquadFilterNode;
  tilt: BiquadFilterNode;
  brilliance: BiquadFilterNode;
  throat: BiquadFilterNode;
  comp: DynamicsCompressorNode;
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
  /** Optional real-time aging stage, spliced makeup -> [ager] -> analyser. */
  ager?: AgerNodes;
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
  /** Last age params applied per source (null = disabled), so a late formant node catches up. */
  private lastAge = new Map<string, AgeParams | null>();
  /** Sources whose formant worklet is mid-load (avoid double-attaching). */
  private agerLoading = new Set<string>();

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

  // ── Voice Ager (Skill 3) ───────────────────────────────────────────────────
  // A real-time pitch+formant shift + timbre morph spliced AFTER makeup, so it
  // warps the FINAL voice. Built lazily and kept connected (transparent when off)
  // so toggling never causes a reconnect race — the exact denoiser discipline.

  private buildAgerNodes(ctx: AudioContext): AgerNodes {
    const input = ctx.createGain();
    const body = ctx.createBiquadFilter();
    body.type = 'lowshelf'; body.frequency.value = 180; body.gain.value = 0;
    const tilt = ctx.createBiquadFilter();
    tilt.type = 'highshelf'; tilt.frequency.value = 6000; tilt.gain.value = 0;
    const brilliance = ctx.createBiquadFilter();
    brilliance.type = 'peaking'; brilliance.frequency.value = 8000; brilliance.Q.value = 1; brilliance.gain.value = 0;
    const throat = ctx.createBiquadFilter();
    throat.type = 'peaking'; throat.frequency.value = 2200; throat.Q.value = 1.4; throat.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0; comp.ratio.value = 1; comp.knee.value = 6; comp.attack.value = 0.006; comp.release.value = 0.25;
    // input -> body -> tilt -> brilliance -> throat -> comp (formant splices before body)
    input.connect(body);
    body.connect(tilt);
    tilt.connect(brilliance);
    brilliance.connect(throat);
    throat.connect(comp);
    return { input, formant: null, body, tilt, brilliance, throat, comp };
  }

  /** Splice the ager between makeup and analyser (idempotent, never silences). */
  private attachAger(graph: SourceGraph, ctx: AudioContext): void {
    if (graph.ager) return;
    const ager = this.buildAgerNodes(ctx);
    try {
      graph.makeup.disconnect();          // was makeup -> analyser
      graph.makeup.connect(ager.input);
      ager.comp.connect(graph.analyser);  // ... -> comp -> analyser -> destination
      graph.ager = ager;
    } catch (e) {
      try { graph.makeup.disconnect(); graph.makeup.connect(graph.analyser); } catch { /* best effort */ }
      console.warn('[VoiceAger] attach failed:', e);
    }
  }

  /** Splice the formant worklet in front of the ager EQ: input -> formant -> body. */
  private ensureFormant(sourceId: string, ctx: AudioContext): void {
    const graph = this.graphs.get(sourceId);
    if (!graph?.ager || graph.ager.formant || this.agerLoading.has(sourceId)) return;
    this.agerLoading.add(sourceId);
    createFormantShiftNode(ctx)
      .then((node) => {
        this.agerLoading.delete(sourceId);
        const g = this.graphs.get(sourceId);
        if (!node || !g?.ager || g.ager.formant) return;
        try {
          g.ager.input.disconnect();
          g.ager.input.connect(node);
          node.connect(g.ager.body);
          g.ager.formant = node;
          const p = this.lastAge.get(sourceId);
          if (p) this.setFormantParams(ctx, node, p); // catch the worklet up
        } catch (e) {
          try { g.ager.input.disconnect(); g.ager.input.connect(g.ager.body); } catch { /* best effort */ }
          console.warn('[VoiceAger] formant splice failed:', e);
        }
      })
      .catch(() => this.agerLoading.delete(sourceId));
  }

  private setFormantParams(ctx: AudioContext, node: FormantShiftNode, params: AgeParams | null): void {
    const now = ctx.currentTime;
    node.parameters.get('ratio')?.setTargetAtTime(params ? params.shiftRatio : 1, now, 0.03);
    node.parameters.get('jitter')?.setTargetAtTime(params ? Math.min(0.1, params.jitterPct / 100) : 0, now, 0.05);
  }

  private setAgerParams(ctx: AudioContext, graph: SourceGraph, params: AgeParams | null): void {
    const ager = graph.ager;
    if (!ager) return;
    const now = ctx.currentTime;
    const S = 0.03; // click-free while dragging
    if (!params) {
      ager.body.gain.setTargetAtTime(0, now, S);
      ager.tilt.gain.setTargetAtTime(0, now, S);
      ager.brilliance.gain.setTargetAtTime(0, now, S);
      ager.throat.gain.setTargetAtTime(0, now, S);
      ager.comp.threshold.setValueAtTime(0, now);
      ager.comp.ratio.setValueAtTime(1, now);
    } else {
      ager.body.gain.setTargetAtTime(params.bodyDb, now, S);
      ager.tilt.gain.setTargetAtTime(params.tiltDb, now, S);
      ager.brilliance.gain.setTargetAtTime(params.brillianceDb, now, S);
      ager.throat.gain.setTargetAtTime(params.throatDb, now, S);
      ager.comp.threshold.setValueAtTime(params.compThresholdDb, now);
      ager.comp.ratio.setValueAtTime(params.compRatio, now);
    }
    if (ager.formant) this.setFormantParams(ctx, ager.formant, params);
  }

  /**
   * Real-time Voice Ager. Ensures the source is tapped + the ager is spliced, then
   * applies `params` (or transparent when disabled). Idempotent — safe every frame.
   * Works whether or not voice isolation is on: both share this one owned tap.
   */
  applyAge(sourceId: string, element: HTMLMediaElement, params: AgeParams | null, enabled: boolean): void {
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
    this.attachAger(graph, ctx);
    const eff = enabled ? params : null;
    this.lastAge.set(sourceId, eff);
    this.setAgerParams(ctx, graph, eff);
    if (enabled) this.ensureFormant(sourceId, ctx);
  }

  /** Zero-latency drag path — update the ager on an already-tapped source. */
  updateAge(sourceId: string, params: AgeParams | null, enabled: boolean): void {
    const eff = enabled ? params : null;
    this.lastAge.set(sourceId, eff);
    const ctx = this.ctx;
    if (!ctx) return;
    const graph = this.graphs.get(sourceId);
    if (graph?.ager) this.setAgerParams(ctx, graph, eff);
  }

  /** DEV/test read-back: the live ager params actually on the graph. Null if none. */
  debugAgerState(
    sourceId: string,
  ): { bodyDb: number; tiltDb: number; brillianceDb: number; ratio: number | null } | null {
    const ager = this.graphs.get(sourceId)?.ager;
    if (!ager) return null;
    return {
      bodyDb: ager.body.gain.value,
      tiltDb: ager.tilt.gain.value,
      brillianceDb: ager.brilliance.gain.value,
      ratio: ager.formant ? ager.formant.parameters.get('ratio')?.value ?? null : null,
    };
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
      graph.ager?.input.disconnect();
      graph.ager?.formant?.disconnect();
      graph.ager?.body.disconnect();
      graph.ager?.tilt.disconnect();
      graph.ager?.brilliance.disconnect();
      graph.ager?.throat.disconnect();
      graph.ager?.comp.disconnect();
      graph.analyser.disconnect();
    } catch {
      /* already gone */
    }
    this.graphs.delete(sourceId);
    this.denoiserLoading.delete(sourceId);
    this.agerLoading.delete(sourceId);
    this.lastAge.delete(sourceId);
  }
}

export const VoiceIsolationEngine = new VoiceIsolationEngineImpl();

// DEV-only handle so the visual test harness can read live band gains and prove
// the curve reached the audio (mirrors the __videoEditorStore exposure).
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  (window as any).__voiceIsolationEngine = VoiceIsolationEngine;
}

export type { CurveNode };
