// Robust Video Matting (RVM) via ONNX Runtime Web
// onnxruntime-web is loaded lazily (dynamic import) to avoid WASM side-effects at
// parse time which crash React's hook system.

import type * as OrtType from 'onnxruntime-web';

// ORT's .wasm/.mjs loaders are served cross-origin from the Electron media server
// (localhost:3001). The browser's dynamic import() of these then bypasses Vite's
// dev server, which refuses to serve them as modules. Fully local, no CDN.
const ORT_ASSET_BASE = 'http://localhost:3001/ort-assets/';

type OrtTensor = OrtType.Tensor;
type OrtModule = typeof OrtType;

let ort: OrtModule | null = null;
let session: OrtType.InferenceSession | null = null;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;
let inferenceFailures = 0;
const MAX_INFERENCE_FAILURES = 3;

// Recurrent hidden states — passed frame-to-frame for temporal edge consistency
let r1: OrtTensor | null = null;
let r2: OrtTensor | null = null;
let r3: OrtTensor | null = null;
let r4: OrtTensor | null = null;

// Cached alpha from last completed inference — applied synchronously on next paint
let cachedAlpha: Float32Array | null = null;
let cachedW = 0;
let cachedH = 0;
let inferenceRunning = false;

// Persistent canvases
let inputCanvas: HTMLCanvasElement | null = null;
let inputCtx: CanvasRenderingContext2D | null = null;
let smallMaskCanvas: HTMLCanvasElement | null = null;
let smallMaskCtx: CanvasRenderingContext2D | null = null;
let fullMaskCanvas: HTMLCanvasElement | null = null;
let fullMaskCtx: CanvasRenderingContext2D | null = null;
let frameCanvas: HTMLCanvasElement | null = null;
let frameCtx: CanvasRenderingContext2D | null = null;

const INPUT_SCALE = 0.5;
const DOWNSAMPLE_RATIO = 0.25;

// RVM's documented initial recurrent state: a single [1,1,1,1] zero tensor.
// The model produces correctly-shaped states (16/20/40/64 channels) on the
// first pass, which are then fed back in subsequent frames.
function makeZeroState(): OrtTensor {
  return new ort!.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
}

function disposeSafe(t: OrtTensor | null): void {
  try { t?.dispose(); } catch {}
}

// Surface runtime state to the properties panel (no console needed)
function emitBgStatus(text: string): void {
  try {
    window.dispatchEvent(new CustomEvent('dividr:bgStatus', { detail: text }));
  } catch {}
}

export function initBackgroundSegmenter(): Promise<void> {
  if (initPromise) return initPromise;

  initError = null;
  initPromise = (async () => {
    ort = await import('onnxruntime-web');
    ort.env.wasm.wasmPaths = {
      wasm: `${ORT_ASSET_BASE}ort-wasm-simd-threaded.jsep.wasm`,
      mjs: `${ORT_ASSET_BASE}ort-wasm-simd-threaded.jsep.mjs`,
    };

    // WASM (CPU) execution provider — supports all RVM ops reliably. WebGPU often
    // throws at run() on unsupported ops even when create() succeeds, so we avoid it.
    // Inference runs async + frame-cached, so CPU latency doesn't block the UI.
    session = await ort.InferenceSession.create('/rvm_mobilenetv3_fp32.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    console.log('[RVM] Session ready (wasm) —', session.inputNames.join(', '));
  })().catch((err) => {
    console.error('[RVM] init failed:', err);
    initError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    initPromise = null;
    session = null;
    ort = null;
  }) as Promise<void>;

  return initPromise;
}

export function isBackgroundSegmenterReady(): boolean {
  return session !== null;
}

export function getInitError(): string | null {
  return initError;
}

export function resetRecurrentStates(): void {
  disposeSafe(r1); disposeSafe(r2); disposeSafe(r3); disposeSafe(r4);
  r1 = r2 = r3 = r4 = null;
  cachedAlpha = null;
}

async function runInference(video: HTMLVideoElement): Promise<void> {
  if (!session || !ort) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const iw = Math.max(2, Math.round(vw * INPUT_SCALE));
  const ih = Math.max(2, Math.round(vh * INPUT_SCALE));

  if (!inputCanvas || inputCanvas.width !== iw || inputCanvas.height !== ih) {
    inputCanvas = document.createElement('canvas');
    inputCanvas.width = iw;
    inputCanvas.height = ih;
    inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true })!;
  }
  inputCtx!.drawImage(video, 0, 0, iw, ih);
  const imgData = inputCtx!.getImageData(0, 0, iw, ih);

  const size = iw * ih;
  const float32 = new Float32Array(3 * size);
  const d = imgData.data;
  for (let i = 0; i < size; i++) {
    float32[i]            = d[i * 4]     / 255;
    float32[size + i]     = d[i * 4 + 1] / 255;
    float32[2 * size + i] = d[i * 4 + 2] / 255;
  }

  const src = new ort.Tensor('float32', float32, [1, 3, ih, iw]);
  const dsRatio = new ort.Tensor('float32', new Float32Array([DOWNSAMPLE_RATIO]), [1]);

  const prevR1 = r1, prevR2 = r2, prevR3 = r3, prevR4 = r4;
  const feeds: Record<string, OrtTensor> = {
    src,
    r1i: prevR1 ?? makeZeroState(),
    r2i: prevR2 ?? makeZeroState(),
    r3i: prevR3 ?? makeZeroState(),
    r4i: prevR4 ?? makeZeroState(),
    downsample_ratio: dsRatio,
  };

  const results = await session.run(feeds);

  r1 = results.r1o; r2 = results.r2o; r3 = results.r3o; r4 = results.r4o;
  if (!prevR1) {
    disposeSafe(feeds.r1i); disposeSafe(feeds.r2i);
    disposeSafe(feeds.r3i); disposeSafe(feeds.r4i);
  } else {
    disposeSafe(prevR1); disposeSafe(prevR2); disposeSafe(prevR3); disposeSafe(prevR4);
  }
  disposeSafe(src); disposeSafe(dsRatio);

  cachedAlpha = results.pha.data as Float32Array;
  cachedW = iw;
  cachedH = ih;
  disposeSafe(results.fgr);
}

export function applyBackgroundRemoval(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  if (!vw || !vh) {
    ctx.drawImage(video, destX, destY, destW, destH);
    return;
  }

  // If a prior inference error tore the session down, re-bootstrap it (idempotent
  // via initPromise). Without this the matte stays dead for the rest of the session.
  // initError guards against a hard, deterministic failure retry-looping forever.
  if (!session && !initPromise && !initError) {
    initBackgroundSegmenter();
  }

  if (!inferenceRunning) {
    inferenceRunning = true;
    const hadAlpha = cachedAlpha !== null;
    runInference(video)
      .then(() => {
        inferenceRunning = false;
        inferenceFailures = 0;
        // First successful mask on a paused frame: nothing else will redraw,
        // so trigger one recomposite to reveal the matte immediately.
        if (!hadAlpha && cachedAlpha) {
          emitBgStatus('Matte active');
          window.dispatchEvent(new CustomEvent('dividr:forceRender'));
        }
      })
      .catch((err) => {
        console.warn('[RVM] inference error, resetting:', err);
        inferenceRunning = false;
        resetRecurrentStates();
        session = null;
        initPromise = null;
        ort = null;
        inferenceFailures += 1;
        if (inferenceFailures >= MAX_INFERENCE_FAILURES) {
          // Deterministic failure (e.g. unsupported op) — stop re-bootstrapping every frame.
          initError = `Inference failed ${inferenceFailures}x: ${err instanceof Error ? err.message : String(err)}`;
          emitBgStatus('Background removal unavailable — inference kept failing');
        } else {
          emitBgStatus(`Inference failed (retry ${inferenceFailures}/${MAX_INFERENCE_FAILURES})`);
        }
      });
  }

  if (!cachedAlpha) {
    ctx.drawImage(video, destX, destY, destW, destH);
    return;
  }

  if (!frameCanvas || frameCanvas.width !== vw || frameCanvas.height !== vh) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = vw; frameCanvas.height = vh;
    frameCtx = frameCanvas.getContext('2d')!;
    fullMaskCanvas = document.createElement('canvas');
    fullMaskCanvas.width = vw; fullMaskCanvas.height = vh;
    fullMaskCtx = fullMaskCanvas.getContext('2d')!;
  }

  // Alpha is at inference resolution (cachedW×cachedH); write it to a small canvas
  // then scale up to full video resolution so edges stay smooth.
  if (!smallMaskCanvas || smallMaskCanvas.width !== cachedW || smallMaskCanvas.height !== cachedH) {
    smallMaskCanvas = document.createElement('canvas');
    smallMaskCanvas.width = cachedW; smallMaskCanvas.height = cachedH;
    smallMaskCtx = smallMaskCanvas.getContext('2d')!;
  }

  const alphaPixels = new Uint8ClampedArray(cachedW * cachedH * 4);
  const a = cachedAlpha;
  for (let i = 0; i < cachedW * cachedH; i++) {
    alphaPixels[i * 4]     = 255;
    alphaPixels[i * 4 + 1] = 255;
    alphaPixels[i * 4 + 2] = 255;
    alphaPixels[i * 4 + 3] = Math.min(255, Math.round(a[i] * 255));
  }
  smallMaskCtx!.putImageData(new ImageData(alphaPixels, cachedW, cachedH), 0, 0);

  fullMaskCtx!.clearRect(0, 0, vw, vh);
  fullMaskCtx!.imageSmoothingEnabled = true;
  fullMaskCtx!.drawImage(smallMaskCanvas!, 0, 0, vw, vh);

  frameCtx!.clearRect(0, 0, vw, vh);
  frameCtx!.drawImage(video, 0, 0, vw, vh);
  frameCtx!.globalCompositeOperation = 'destination-in';
  frameCtx!.drawImage(fullMaskCanvas!, 0, 0);
  frameCtx!.globalCompositeOperation = 'source-over';

  ctx.drawImage(frameCanvas!, 0, 0, vw, vh, destX, destY, destW, destH);
}
