/**
 * reverb-suppressor-processor — real-time late-reverb suppression AudioWorklet.
 *
 * Same algorithm as the export bake (scripts/reverb_processor.py de_reverb):
 * STFT (1024-pt frame, 256 hop, Hann), a recursive late-reverb PSD estimate
 * delayed ~48 ms with an exponential room-decay model, and a floored
 * Wiener-style gain per bin. Pure JS, no wasm, no dependency — mirrors the
 * formantShiftWorklet packaging.
 *
 * AudioParam `strength`: 0 = identity gains (transparent, still ~21 ms OLA
 * latency once attached — attach only ever happens when the user first drags
 * negative). 1 = strongest suppression (-18 dB floor, 2.2x over-subtraction).
 */

const FRAME = 1024;
const HOP = 256;
const DELAY_FRAMES = 9; // 9 * 256 / 48000 ≈ 48 ms — where "late" reverb starts
const T60_ASSUMED = 0.9;

class ReverbSuppressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'strength', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
    }
    // Hann with 4x overlap sums to a constant 1.5 — normalize synthesis by it.
    this.olaNorm = 1.5;
    // decay of the late-reverb model across the DELAY_FRAMES gap
    this.decay = Math.exp((-2 * 6.908 * (DELAY_FRAMES * HOP / 48000)) / T60_ASSUMED);

    const bins = FRAME / 2 + 1;
    const FIFO = 4096; // fixed output FIFO — no allocations on the audio thread
    this.ch = [];
    for (let c = 0; c < 2; c++) {
      this.ch.push({
        inBuf: new Float32Array(FRAME),      // sliding analysis buffer
        inFill: 0,                            // samples until first full frame
        outBuf: new Float32Array(FRAME + HOP), // OLA accumulator
        fifo: new Float32Array(FIFO),
        fifoR: 0,
        fifoW: 0,
        fifoN: 0,
        psdRing: Array.from({ length: DELAY_FRAMES }, () => new Float32Array(bins)),
        lateRing: Array.from({ length: DELAY_FRAMES }, () => new Float32Array(bins)),
        ringIdx: 0,
        primed: 0,                            // frames seen (ring not valid until >= DELAY_FRAMES)
      });
    }
    this.FIFO = FIFO;
    // scratch FFT arrays
    this.re = new Float32Array(FRAME);
    this.im = new Float32Array(FRAME);
  }

  // In-place iterative radix-2 complex FFT (inverse when inv=true).
  fft(re, im, inv) {
    const n = FRAME;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inv ? 1 : -1) * 2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
    if (inv) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  processFrame(st, strength) {
    const bins = FRAME / 2 + 1;
    const re = this.re, im = this.im;
    for (let i = 0; i < FRAME; i++) {
      re[i] = st.inBuf[i] * this.win[i];
      im[i] = 0;
    }
    this.fft(re, im, false);

    // params from strength (matches python mapping at amount = strength*50)
    const maxAttDb = 6 + 12 * strength;
    const floor = Math.pow(10, -maxAttDb / 20);
    const overest = 0.8 + 1.4 * strength;

    const psd = st.psdRing[st.ringIdx];
    const late = st.lateRing[st.ringIdx];
    const delayedPsd = st.psdRing[(st.ringIdx + 1) % DELAY_FRAMES];
    const delayedLate = st.lateRing[(st.ringIdx + 1) % DELAY_FRAMES];
    const primed = st.primed >= DELAY_FRAMES;

    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const lateEst = primed ? this.decay * (delayedPsd[k] + delayedLate[k]) : 0;
      psd[k] = p;
      late[k] = lateEst;
      let g = 1;
      if (strength > 0 && primed) {
        g = 1 - (overest * lateEst) / (p + 1e-12);
        if (g < floor) g = floor;
        if (g > 1) g = 1;
      }
      // apply to bin k and its conjugate mirror
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < FRAME / 2) {
        re[FRAME - k] *= g; im[FRAME - k] *= g;
      }
    }
    st.ringIdx = (st.ringIdx + 1) % DELAY_FRAMES;
    st.primed++;

    this.fft(re, im, true);
    // overlap-add the synthesized (windowed) frame
    for (let i = 0; i < FRAME; i++) {
      st.outBuf[i] += (re[i] * this.win[i]) / this.olaNorm;
    }
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const strength = params.strength[0];
    const nCh = Math.min(2, input.length, output.length);

    for (let c = 0; c < nCh; c++) {
      const st = this.ch[c];
      const inData = input[c];
      const outData = output[c];
      const q = inData.length; // 128-sample quantum

      // shift new samples into the sliding frame buffer
      st.inBuf.copyWithin(0, q);
      st.inBuf.set(inData, FRAME - q);
      st.inFill += q;

      // every HOP samples, process one STFT frame
      if (st.inFill % HOP === 0 && st.inFill >= FRAME) {
        this.processFrame(st, strength);
        // emit HOP samples from the OLA accumulator into the fixed FIFO
        for (let i = 0; i < HOP; i++) {
          if (st.fifoN < this.FIFO) {
            st.fifo[st.fifoW] = st.outBuf[i];
            st.fifoW = (st.fifoW + 1) % this.FIFO;
            st.fifoN++;
          }
        }
        st.outBuf.copyWithin(0, HOP);
        st.outBuf.fill(0, FRAME);
      }

      // serve the output from the FIFO (constant latency once primed)
      if (st.fifoN >= q) {
        for (let i = 0; i < q; i++) {
          outData[i] = st.fifo[st.fifoR];
          st.fifoR = (st.fifoR + 1) % this.FIFO;
        }
        st.fifoN -= q;
      } else {
        outData.fill(0); // still priming
      }
    }
    // mirror channel 0 if the output has more channels than input
    for (let c = nCh; c < output.length; c++) output[c].set(output[0]);
    return true;
  }
}

registerProcessor('reverb-suppressor-processor', ReverbSuppressorProcessor);
