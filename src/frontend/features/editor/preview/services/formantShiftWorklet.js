/**
 * formantShiftWorklet — a self-contained, dependency-free AudioWorklet that shifts
 * pitch AND formants together by a ratio (used by the Voice Ager, Skill 3).
 *
 * Algorithm: a cross-faded variable delay-line pitch shifter (the standard
 * click-free technique). A ramping read offset resamples the signal by `ratio`;
 * two read taps 180° out of phase are cross-faded with a constant-power window so
 * the wrap discontinuity is always hidden under the other tap's zero-crossing.
 *
 * ratio < 1  → deeper + longer vocal tract (older).
 * ratio > 1  → thinner + shorter vocal tract (younger).
 *
 * `jitter` adds a small, slow random walk to the ratio for the pitch-period
 * instability of an aged voice. No wasm, no token, ~48kHz-agnostic, mono or stereo.
 *
 * This is a plain AudioWorkletGlobalScope script (no imports) served via Vite `?url`
 * and loaded with ctx.audioWorklet.addModule(...), exactly like the RNNoise worklet.
 */
class FormantShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' },
      { name: 'jitter', defaultValue: 0, minValue: 0, maxValue: 0.1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.N = 2048; // delay-buffer length (samples)
    this.bufs = [new Float32Array(this.N), new Float32Array(this.N)];
    this.writeIdx = 0;
    this.phase = 0; // 0..1 sawtooth read offset
    this.jit = 0; // current smoothed jitter offset
    this.jitTarget = 0;
    this.jitCountdown = 0;
  }

  // Fractional read with linear interpolation, wrapping into [0, N).
  read(buf, idx) {
    const N = this.N;
    let i = idx % N;
    if (i < 0) i += N;
    const i0 = i | 0;
    const frac = i - i0;
    const i1 = i0 + 1 >= N ? 0 : i0 + 1;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    // No input (source not connected yet) → emit silence but stay alive.
    if (!input || input.length === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const ratio = parameters.ratio.length > 1 ? parameters.ratio[0] : parameters.ratio[0];
    const jitterAmt = parameters.jitter.length > 1 ? parameters.jitter[0] : parameters.jitter[0];
    const N = this.N;
    const maxDelay = N - 2;
    const frames = output[0].length;
    const nCh = Math.min(output.length, this.bufs.length);

    for (let s = 0; s < frames; s++) {
      // Slow random walk for pitch-period jitter (retargets a few times per second).
      if (this.jitCountdown-- <= 0) {
        this.jitTarget = (Math.random() * 2 - 1) * jitterAmt;
        this.jitCountdown = 1024;
      }
      this.jit += (this.jitTarget - this.jit) * 0.002;
      const p = Math.max(0.5, Math.min(2, ratio + this.jit));

      // Advance read phase; a ratio != 1 makes the delay ramp, resampling the signal.
      this.phase += (1 - p) / maxDelay;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;

      const ph1 = this.phase;
      const ph2 = ph1 >= 0.5 ? ph1 - 0.5 : ph1 + 0.5;
      const w1 = Math.sin(Math.PI * ph1); // constant-power cross-fade
      const w2 = Math.sin(Math.PI * ph2);
      const d1 = ph1 * maxDelay;
      const d2 = ph2 * maxDelay;

      for (let ch = 0; ch < nCh; ch++) {
        const buf = this.bufs[ch];
        const inCh = input[ch] || input[0];
        buf[this.writeIdx] = inCh ? inCh[s] : 0;
        const base = this.writeIdx;
        output[ch][s] = w1 * this.read(buf, base - d1) + w2 * this.read(buf, base - d2);
      }
      // Any extra output channels beyond our buffers: copy channel 0.
      for (let ch = nCh; ch < output.length; ch++) output[ch][s] = output[0][s];

      this.writeIdx = this.writeIdx + 1 >= N ? 0 : this.writeIdx + 1;
    }
    return true;
  }
}

registerProcessor('formant-shift-processor', FormantShiftProcessor);
