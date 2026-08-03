/**
 * RecorderModal — the full-screen Record & create studio (Clipchamp-style,
 * DiviDr black/green). Four modes: screen-camera, camera, screen, audio.
 *
 * Flow: permission gate → setup (devices, camera bubble) → [screen picker] →
 * 3-2-1 countdown with beeps → recording (stop / pause / resume / restart with
 * "Delete this clip?" confirm) → review (Retake / Save and edit).
 *
 * Recording chunks stream to the main process as they arrive (recorder:begin /
 * appendChunk / finish), so takes never pile up in renderer memory. The final
 * file lives in userData/recordings and is imported into the media library on
 * save — it is NEVER written to the user's Downloads folder.
 *
 * Screen+camera composites live on a canvas (camera bubble burned in at its
 * on-screen position, including mid-recording moves). Background throttling is
 * disabled for the duration so the composite keeps painting while the user
 * records other apps.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePanelStore } from '@/frontend/features/editor/stores/PanelStore';
import { importFileIntoLibrary } from '@/frontend/features/mycelium/stores/downloadApprovalStore';
import { sendMediaToEdith } from '@/frontend/features/mycelium/sendToEdith';

export type RecorderMode = 'screen-camera' | 'camera' | 'screen' | 'audio';

type Phase =
  | 'permission'
  | 'setup'
  | 'picker'
  | 'countdown'
  | 'recording'
  | 'review'
  | 'deleting';

const MODE_TITLE: Record<RecorderMode, string> = {
  'screen-camera': 'Screen and camera recording',
  camera: 'Camera recording',
  screen: 'Screen recording',
  audio: 'Record audio',
};

const GREEN = '#22c55e';

interface SourceInfo { id: string; name: string; isScreen: boolean; thumbnail: string | null }

interface Bubble { cx: number; cy: number; w: number; rot: number } // stage-relative px, deg

const invoke = (channel: string, ...args: unknown[]) =>
  (window as any).electronAPI.invoke(channel, ...args);

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Short countdown beep — plain WebAudio, no assets.
function beep(ctx: AudioContext, freq: number, durMs = 130) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = freq;
  osc.type = 'sine';
  g.gain.setValueAtTime(0.28, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durMs / 1000);
}

function pickMime(kind: 'video' | 'audio'): string {
  // vp9/vp8 first — they stream-copy into a valid .webm; h264 (last resort)
  // gets boxed into .mp4 by recorder:finish instead.
  const candidates = kind === 'audio'
    ? ['audio/webm;codecs=opus', 'audio/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm'];
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

export function RecorderModal({ mode, onClose }: { mode: RecorderMode; onClose: () => void }) {
  const hasCamera = mode === 'screen-camera' || mode === 'camera';
  const hasScreen = mode === 'screen-camera' || mode === 'screen';
  const isAudioOnly = mode === 'audio';

  const [phase, setPhase] = useState<Phase>('permission');
  const [permError, setPermError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<null | 'restart' | 'retake' | 'close'>(null);

  // Devices
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string>(() => localStorage.getItem('recorder-cam') ?? '');
  const [micId, setMicId] = useState<string>(() => localStorage.getItem('recorder-mic') ?? '');
  const [camOn, setCamOn] = useState(hasCamera);
  const [micOn, setMicOn] = useState(true);
  const [openDropdown, setOpenDropdown] = useState<null | 'cam' | 'mic'>(null);

  // Screen picker
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [pickerTab, setPickerTab] = useState<'screen' | 'window'>('screen');
  const [pickedSource, setPickedSource] = useState<string | null>(null);

  // Camera bubble (screen-camera mode) — free to extend past the stage.
  const [bubble, setBubble] = useState<Bubble>({ cx: 140, cy: 420, w: 240, rot: 0 });

  // Review
  const [finalPath, setFinalPath] = useState<string | null>(null);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingToEdith, setSendingToEdith] = useState(false);
  const [audioWarning, setAudioWarning] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const camVideoRef = useRef<HTMLVideoElement>(null);      // bubble / camera stage
  const screenVideoRef = useRef<HTMLVideoElement>(null);   // live screen preview
  const camStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const appendQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const drawTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef = useRef(0);
  const accumMsRef = useRef(0);
  const camOnRef = useRef(camOn);
  const bubbleRef = useRef(bubble);
  const stoppingRef = useRef<'finish' | 'discard' | null>(null);
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { camOnRef.current = camOn; }, [camOn]);
  useEffect(() => { bubbleRef.current = bubble; }, [bubble]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Live mic level (Meet-style activity pill + audio-mode waveform).
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micLevelRef = useRef(0);
  const micInjectRef = useRef<{ v: number; until: number } | null>(null);
  const levelHistoryRef = useRef<number[]>([]);
  const micOnRef = useRef(micOn);
  const pausedRef = useRef(paused);
  const micPillRef = useRef<HTMLSpanElement>(null);
  const micBar0 = useRef<HTMLSpanElement>(null);
  const micBar1 = useRef<HTMLSpanElement>(null);
  const micBar2 = useRef<HTMLSpanElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const camRetryRef = useRef(0);
  useEffect(() => { micOnRef.current = micOn; }, [micOn]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const getAudioCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };

  // ── Streams ──────────────────────────────────────────────────────────────
  const attachCamPreview = useCallback(() => {
    const el = camVideoRef.current;
    const stream = camStreamRef.current;
    if (!el || !stream) return;
    // Phase changes remount the bubble <video>; a re-attached live stream can
    // stall at readyState 0 (no frames ever decode). Nulling srcObject first
    // forces Chromium to rebuild the media pipeline.
    if (el.srcObject !== stream || el.readyState === 0) {
      el.srcObject = null;
      el.srcObject = stream;
    }
    el.play().catch(() => {});
  }, []);

  const acquireCam = useCallback(async (deviceId?: string) => {
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    attachCamPreview();
  }, [attachCamPreview]);

  const acquireMic = useCallback(async (deviceId?: string) => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    // Analyser for the live activity pill / waveform — rebuilt per acquisition
    // so switching mics immediately reflects the NEW device's signal.
    {
      const actx = getAudioCtx();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
      micAnalyserRef.current?.disconnect();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      actx.createMediaStreamSource(micStreamRef.current).connect(analyser);
      micAnalyserRef.current = analyser;
    }
    // Rebuild the mic branch of the audio graph if it exists (device switch mid-session).
    if (audioDestRef.current) {
      const ctx = getAudioCtx();
      micGainRef.current?.disconnect();
      const src = ctx.createMediaStreamSource(micStreamRef.current);
      const gain = ctx.createGain();
      gain.gain.value = micOn ? 1 : 0;
      src.connect(gain).connect(audioDestRef.current);
      micGainRef.current = gain;
    }
  }, [micOn]);

  // Permission gate → acquire devices → enumerate (labels need a granted stream).
  const handleAllowAccess = useCallback(async () => {
    setPermError(null);
    try {
      await acquireMic(micId || undefined);
      if (hasCamera) await acquireCam(camId || undefined);
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCams(devices.filter((d) => d.kind === 'videoinput'));
      setMics(devices.filter((d) => d.kind === 'audioinput'));
      if (!micId) setMicId(micStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId ?? '');
      if (hasCamera && !camId) setCamId(camStreamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ?? '');
      setPhase('setup');
    } catch (e: any) {
      setPermError(e?.name === 'NotAllowedError'
        ? 'Access was blocked. Check Windows camera & microphone privacy settings for DiviDr.'
        : e?.name === 'NotFoundError'
          ? (hasCamera ? 'No camera or microphone was found on this device.' : 'No microphone was found on this device.')
          : `Could not start devices: ${e?.message ?? e}`);
    }
  }, [acquireCam, acquireMic, camId, micId, hasCamera]);

  // Camera preview element re-attaches whenever phase/layout changes remount it.
  useEffect(() => { attachCamPreview(); }, [phase, camOn, attachCamPreview]);

  // ── Live mic level ───────────────────────────────────────────────────────
  // RMS sampler: fast attack, slow release. Feeds the activity pill (every
  // mode) and, in audio mode, the scrolling waveform history.
  useEffect(() => {
    const iv = setInterval(() => {
      const a = micAnalyserRef.current;
      let level = 0;
      if (a) {
        const buf = new Uint8Array(a.fftSize);
        a.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
        level = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
      }
      const inj = micInjectRef.current;
      if (inj && performance.now() < inj.until) level = Math.max(level, inj.v);
      if (!micOnRef.current) level = 0;
      const prev = micLevelRef.current;
      micLevelRef.current = level > prev ? level : prev * 0.72 + level * 0.28;
      // RAF stalls when the window is occluded — stamp the pill here too so
      // the reported level never goes stale.
      if (micPillRef.current) micPillRef.current.dataset.level = micLevelRef.current.toFixed(2);
      if (isAudioOnly && phaseRef.current === 'recording' && !pausedRef.current) {
        levelHistoryRef.current.push(micLevelRef.current);
        if (levelHistoryRef.current.length > 6000) levelHistoryRef.current.splice(0, 1500);
      }
    }, 66);
    if ((import.meta as any).env?.DEV) {
      (window as any).__recorderAudio = {
        level: () => micLevelRef.current,
        inject: (v: number, ms = 1500) => { micInjectRef.current = { v, until: performance.now() + ms }; },
        historyLen: () => levelHistoryRef.current.length,
      };
    }
    return () => clearInterval(iv);
  }, [isAudioOnly]);

  // Activity pill animator — drives bar heights straight on the DOM so the
  // 60fps motion never re-renders the modal.
  useEffect(() => {
    let raf = 0;
    const bars = [micBar0, micBar1, micBar2];
    const mult = [0.55, 1, 0.7];
    const tick = () => {
      const lv = micOnRef.current ? micLevelRef.current : 0;
      bars.forEach((b, i) => {
        if (b.current) b.current.style.height = `${3 + Math.round(lv * 15 * mult[i])}px`;
      });
      if (micPillRef.current) micPillRef.current.dataset.level = lv.toFixed(2);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Audio-mode waveform: green amplitude bars trailing a playhead, the way
  // every phone voice recorder draws it.
  useEffect(() => {
    if (!isAudioOnly || phase !== 'recording') return;
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(rect.width * dpr));
      const H = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const x2d = canvas.getContext('2d')!;
      x2d.clearRect(0, 0, W, H);
      const mid = H / 2;
      // faint baseline
      x2d.fillStyle = 'rgba(255,255,255,0.08)';
      x2d.fillRect(0, mid - dpr / 2, W, dpr);
      const bw = 3 * dpr, gap = 3 * dpr, step = bw + gap;
      const playheadX = Math.round(W * 0.62);
      const hist = levelHistoryRef.current;
      const n = Math.floor(playheadX / step);
      const slice = hist.slice(-n);
      x2d.fillStyle = GREEN;
      for (let i = 0; i < slice.length; i++) {
        const x = playheadX - (slice.length - i) * step;
        const h = Math.max(2 * dpr, Math.pow(slice[i], 0.75) * H * 0.6);
        x2d.fillRect(x, mid - h / 2, bw, h);
      }
      x2d.fillStyle = 'rgba(255,255,255,0.65)';
      x2d.fillRect(playheadX, H * 0.14, 1.5 * dpr, H * 0.72);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [isAudioOnly, phase]);

  // ── Camera stall watchdog ────────────────────────────────────────────────
  // Windows' camera service sometimes wedges: the track stays "live" but stops
  // delivering frames (frozen still), or hands back empty GPU buffers that
  // paint as a solid green frame. Detect both, silently re-acquire twice, then
  // tell the user what actually happened instead of leaving a green void.
  useEffect(() => {
    if (!hasCamera || !camOn) return;
    if (phase !== 'setup' && phase !== 'countdown' && phase !== 'recording') return;
    let last = -1;
    let stallTicks = 0;
    let busy = false;
    const watch = { ticks: 0, bad: 0, retries: 0, disabled: false, lastDec: -1 };
    if ((import.meta as any).env?.DEV) (window as any).__recorderCamWatch = watch;
    const probe = document.createElement('canvas');
    probe.width = 8; probe.height = 8;
    const px = probe.getContext('2d', { willReadFrequently: true })!;
    const iv = setInterval(async () => {
      if (busy || document.hidden) { stallTicks = 0; return; }
      const el = camVideoRef.current;
      if (!el) return;
      watch.ticks++;
      const dec = (el as any).webkitDecodedFrameCount ?? -1;
      watch.lastDec = dec;
      let bad = dec >= 0 && dec === last;
      last = dec;
      if (!bad && el.readyState >= 2 && el.videoWidth) {
        try {
          px.drawImage(el, 0, 0, 8, 8);
          const d = px.getImageData(0, 0, 8, 8).data;
          let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, rS = 0, gS = 0, bS = 0;
          for (let i = 0; i < d.length; i += 4) {
            rMin = Math.min(rMin, d[i]); rMax = Math.max(rMax, d[i]); rS += d[i];
            gMin = Math.min(gMin, d[i + 1]); gMax = Math.max(gMax, d[i + 1]); gS += d[i + 1];
            bMin = Math.min(bMin, d[i + 2]); bMax = Math.max(bMax, d[i + 2]); bS += d[i + 2];
          }
          const uniform = (rMax - rMin) + (gMax - gMin) + (bMax - bMin) < 24;
          const green = gS / 64 > rS / 64 + 40 && gS / 64 > bS / 64 + 40;
          if (uniform && green) bad = true;
        } catch { /* sampling is best-effort */ }
      }
      if (bad) watch.bad++;
      stallTicks = bad ? stallTicks + 1 : 0;
      if (stallTicks < 3) return;
      stallTicks = 0;
      if (camRetryRef.current < 2) {
        camRetryRef.current += 1;
        watch.retries = camRetryRef.current;
        busy = true;
        try { await acquireCam(camId || undefined); } catch { /* next stall escalates */ }
        busy = false;
        last = -1;
      } else {
        watch.disabled = true;
        setPermError('Your camera stopped delivering frames — that is a Windows camera-service hiccup, not a DiviDr setting. Close other apps that use the camera, or restart DiviDr, then turn the camera back on.');
        setCamOn(false);
        camStreamRef.current?.getTracks().forEach((t) => t.stop());
        camStreamRef.current = null;
      }
    }, 800);
    return () => clearInterval(iv);
  }, [hasCamera, camOn, phase, camId, acquireCam]);

  // ── Screen picker ────────────────────────────────────────────────────────
  const openPicker = useCallback(async () => {
    const r = await invoke('recorder:getSources');
    if (!r?.success) { setPermError(r?.error ?? 'Could not list screens'); return; }
    setSources(r.sources);
    setPickedSource(null);
    setPickerTab('screen');
    setPhase('picker');
  }, []);

  const startScreenStream = useCallback(async (sourceId: string) => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Electron desktop capture — the classic constraint set.
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 3840,
          maxHeight: 2160,
          maxFrameRate: 30,
        },
      },
    } as any);
    const sv = screenVideoRef.current;
    if (sv) {
      sv.srcObject = screenStreamRef.current;
      sv.play().catch(() => {});
      await new Promise<void>((resolve) => {
        if (sv.videoWidth) return resolve();
        const done = () => { sv.removeEventListener('loadedmetadata', done); resolve(); };
        sv.addEventListener('loadedmetadata', done);
        setTimeout(done, 1500);
      });
      // Snap the camera bubble inside the DISPLAYED source area. The recording
      // canvas is the raw source — a bubble parked on the letterbox bars looks
      // fine on stage but maps off-canvas and records nothing (bit us with a
      // narrow window capture: bubble at stage x=140 mapped to canvas x=-231).
      if (hasCamera && stageRef.current && sv.videoWidth) {
        const rect = stageRef.current.getBoundingClientRect();
        const scale = Math.min(rect.width / sv.videoWidth, rect.height / sv.videoHeight);
        const dispW = sv.videoWidth * scale;
        const dispH = sv.videoHeight * scale;
        const offX = (rect.width - dispW) / 2;
        const offY = (rect.height - dispH) / 2;
        setBubble((prev) => {
          const w = Math.min(prev.w, Math.max(120, dispW * 0.5));
          const h = (w * 9) / 16;
          const cx = Math.min(Math.max(prev.cx, offX + w / 2 + 14), offX + dispW - w / 2 - 14);
          const cy = Math.min(Math.max(prev.cy, offY + h / 2 + 14), offY + dispH - h / 2 - 14);
          return { ...prev, w, cx, cy };
        });
      }
    }
  }, [hasCamera]);

  // ── Countdown → record ───────────────────────────────────────────────────
  const runCountdown = useCallback(() => {
    setPhase('countdown');
    setCountdown(3);
    const ctx = getAudioCtx();
    beep(ctx, 700);
    let n = 3;
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(iv);
        beep(ctx, 1050, 220);
        startRecording().catch((e) => { setPermError(String(e?.message ?? e)); setPhase('setup'); });
      } else {
        setCountdown(n);
        beep(ctx, 700);
      }
    }, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Map the bubble's stage coordinates onto the screen source's pixel grid.
  const stageToCanvas = useCallback(() => {
    const stage = stageRef.current;
    const sv = screenVideoRef.current;
    if (!stage || !sv || !sv.videoWidth) return null;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min(rect.width / sv.videoWidth, rect.height / sv.videoHeight);
    const dispW = sv.videoWidth * scale;
    const dispH = sv.videoHeight * scale;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    return { toSrc: sv.videoWidth / dispW, offX, offY };
  }, []);

  const startRecording = useCallback(async () => {
    const kind: 'video' | 'audio' = isAudioOnly ? 'audio' : 'video';
    const begin = await invoke('recorder:begin');
    if (!begin?.success) throw new Error(begin?.error ?? 'begin failed');
    recordingIdRef.current = begin.id;

    // Audio graph: mic → gain (mute switch) → destination.
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    audioDestRef.current = ctx.createMediaStreamDestination();
    micGainRef.current?.disconnect();
    if (micStreamRef.current) {
      const src = ctx.createMediaStreamSource(micStreamRef.current);
      const gain = ctx.createGain();
      // micOnRef, not micOn: runCountdown holds a first-render closure of this
      // callback, so a mute toggled at setup would be invisible to the state here.
      gain.gain.value = micOnRef.current ? 1 : 0;
      src.connect(gain).connect(audioDestRef.current);
      micGainRef.current = gain;
    }
    const audioTrack = audioDestRef.current.stream.getAudioTracks()[0];

    let avStream: MediaStream;
    if (mode === 'screen-camera') {
      const sv = screenVideoRef.current!;
      const canvas = document.createElement('canvas');
      canvas.width = sv.videoWidth || 1920;
      canvas.height = sv.videoHeight || 1080;
      compositeCanvasRef.current = canvas;
      const c2d = canvas.getContext('2d')!;
      // Test bridge (dev builds only): lets the probe pixel-diff the live
      // composite against the raw screen to prove the camera is burned in.
      const dbgStats = { ticks: 0, camDraws: 0, why: '' };
      if ((import.meta as any).env?.DEV) {
        (window as any).__recorderDebug = {
          canvas, screenEl: sv, stats: dbgStats, camRef: camVideoRef,
          getState: () => ({
            camTracks: camStreamRef.current?.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.enabled}`),
            camElPaused: camVideoRef.current?.paused,
            camElSrcIsCurrent: camVideoRef.current?.srcObject === camStreamRef.current,
            bubble: bubbleRef.current,
            map: stageToCanvas(),
            stageRect: stageRef.current?.getBoundingClientRect(),
          }),
        };
      }
      await invoke('recorder:setBackgroundThrottling', false);
      drawTimerRef.current = setInterval(() => {
        dbgStats.ticks++;
        if (sv.readyState >= 2) c2d.drawImage(sv, 0, 0, canvas.width, canvas.height);
        const cam = camVideoRef.current;
        if (!camOnRef.current) dbgStats.why = 'camOff';
        else if (!cam) dbgStats.why = 'noCamEl';
        else if (cam.readyState < 2) dbgStats.why = `readyState=${cam.readyState}`;
        else if (!cam.videoWidth) dbgStats.why = 'videoWidth=0';
        // Watchdog: a stalled bubble element (live track, zero frames) recovers
        // with a srcObject reset — retry with backoff, never every tick.
        if (camOnRef.current && cam && cam.readyState === 0 && camStreamRef.current
            && (dbgStats.ticks === 15 || dbgStats.ticks % 90 === 0)) {
          cam.srcObject = null;
          cam.srcObject = camStreamRef.current;
          cam.play().catch(() => { /* retried next window */ });
        }
        if (camOnRef.current && cam && cam.readyState >= 2 && cam.videoWidth) {
          const map = stageToCanvas();
          if (!map) dbgStats.why = 'mapNull';
          if (map) {
            dbgStats.camDraws++;
            dbgStats.why = 'drawing';
            const b = bubbleRef.current;
            const bw = b.w * map.toSrc;
            const bh = bw * 9 / 16;
            // cover-crop the camera into the bubble's 16:9 frame
            const vw = cam.videoWidth, vh = cam.videoHeight;
            let sx = 0, sy = 0, sw = vw, sh = vh;
            if (vw / vh > 16 / 9) { sw = vh * 16 / 9; sx = (vw - sw) / 2; }
            else { sh = vw * 9 / 16; sy = (vh - sh) / 2; }
            c2d.save();
            c2d.translate((b.cx - map.offX) * map.toSrc, (b.cy - map.offY) * map.toSrc);
            c2d.rotate((b.rot * Math.PI) / 180);
            c2d.drawImage(cam, sx, sy, sw, sh, -bw / 2, -bh / 2, bw, bh);
            c2d.restore();
          }
        }
      }, 33);
      avStream = new MediaStream([canvas.captureStream(30).getVideoTracks()[0], audioTrack]);
    } else if (mode === 'camera') {
      // Never hand MediaRecorder the raw camera track: on Windows, attaching an
      // encoder to a re-acquired camera (after a cam-toggle off/on) mutes the
      // source permanently and the recorder emits zero bytes. The stage <video>
      // keeps flowing regardless, so record a canvas fed from it instead —
      // same pipeline as screen-camera. Bonus: toggling the camera off
      // mid-recording yields black frames instead of a starved, corrupt file.
      const cam = camVideoRef.current;
      if (!cam || !camStreamRef.current) throw new Error('Camera is not available');
      const canvas = document.createElement('canvas');
      canvas.width = cam.videoWidth || 1280;
      canvas.height = cam.videoHeight || 720;
      compositeCanvasRef.current = canvas;
      const c2d = canvas.getContext('2d')!;
      await invoke('recorder:setBackgroundThrottling', false);
      drawTimerRef.current = setInterval(() => {
        const el = camVideoRef.current;
        if (camOnRef.current && el && el.readyState >= 2 && el.videoWidth) {
          c2d.drawImage(el, 0, 0, canvas.width, canvas.height);
        } else {
          c2d.fillStyle = '#000';
          c2d.fillRect(0, 0, canvas.width, canvas.height);
        }
      }, 33);
      avStream = new MediaStream([canvas.captureStream(30).getVideoTracks()[0], audioTrack]);
    } else if (mode === 'screen') {
      const track = screenStreamRef.current?.getVideoTracks()[0];
      if (!track) throw new Error('Screen stream is not available');
      avStream = new MediaStream([track, audioTrack]);
    } else {
      avStream = new MediaStream([audioTrack]);
    }

    const rec = new MediaRecorder(avStream, {
      mimeType: pickMime(kind) || undefined,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 128_000,
    });
    recorderRef.current = rec;
    stoppingRef.current = null;
    const recDbg = { events: 0, chunks: 0, bytes: 0, mime: rec.mimeType, error: '' };
    if ((import.meta as any).env?.DEV) {
      (window as any).__recorderDebug2 = {
        stats: recDbg,
        state: () => ({
          rec: rec.state,
          tracks: avStream.getTracks().map((t) => `${t.kind}:${t.readyState}:muted=${t.muted}`),
        }),
      };
    }
    rec.onerror = (e: any) => { recDbg.error = String(e?.error ?? e); };
    rec.ondataavailable = (e) => {
      recDbg.events++;
      recDbg.chunks += e.data.size ? 1 : 0;
      recDbg.bytes += e.data.size;
      if (!e.data.size || !recordingIdRef.current) return;
      const id = recordingIdRef.current;
      // Serialize chunk writes — invoke() resolutions are not order-guaranteed.
      appendQueueRef.current = appendQueueRef.current
        .then(async () => invoke('recorder:appendChunk', id, await e.data.arrayBuffer()))
        .catch(() => {});
    };
    rec.onstop = async () => {
      const id = recordingIdRef.current;
      recordingIdRef.current = null;
      if (drawTimerRef.current) { clearInterval(drawTimerRef.current); drawTimerRef.current = null; }
      await invoke('recorder:setBackgroundThrottling', true).catch(() => {});
      await appendQueueRef.current;
      if (!id) return;
      if (stoppingRef.current === 'discard') {
        await invoke('recorder:discard', { id }).catch(() => {});
        return;
      }
      const fin = await invoke('recorder:finish', id, kind);
      if (!fin?.success) { setPermError(fin?.error ?? 'Could not finalize the recording'); setPhase('setup'); return; }
      setFinalPath(fin.filePath);
      try {
        const p = await (window as any).electronAPI.createPreviewUrl(fin.filePath);
        setReviewUrl(typeof p === 'string' ? p : p?.url ?? fin.filePath);
      } catch { setReviewUrl(fin.filePath); }
      setPhase('review');
    };
    rec.start(1000);
    levelHistoryRef.current = [];
    accumMsRef.current = 0;
    startTsRef.current = Date.now();
    setElapsedMs(0);
    setPaused(false);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsedMs(accumMsRef.current + (startTsRef.current ? Date.now() - startTsRef.current : 0));
    }, 250);
    setPhase('recording');
  }, [isAudioOnly, micOn, mode, stageToCanvas]);

  const pauseRecording = useCallback(() => {
    if (recorderRef.current?.state !== 'recording') return;
    recorderRef.current.pause();
    accumMsRef.current += Date.now() - startTsRef.current;
    startTsRef.current = 0;
    setPaused(true);
  }, []);

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state !== 'paused') return;
    recorderRef.current.resume();
    startTsRef.current = Date.now();
    setPaused(false);
  }, []);

  const stopRecording = useCallback((how: 'finish' | 'discard') => {
    stoppingRef.current = how;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== 'inactive') rec.stop();
    // Screen share ends with the take; camera/mic stay live for a retake.
    if (how === 'discard' || mode !== 'screen-camera') {
      // (screen track also stops on finish — the review plays the saved file)
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
  }, [mode]);

  // Restart / retake / close-mid-take all funnel through the same delete confirm.
  const performDelete = useCallback(async (which: 'restart' | 'retake' | 'close') => {
    setConfirmDelete(null);
    setAudioWarning(null);
    setSendingToEdith(false);
    if (phaseRef.current === 'recording') stopRecording('discard');
    if (finalPath) {
      await invoke('recorder:discard', { filePath: finalPath }).catch(() => {});
      setFinalPath(null);
      setReviewUrl(null);
    }
    if (which === 'close') { onClose(); return; }
    setPhase('deleting');
    setTimeout(() => { setPhase('setup'); }, 1100);
  }, [finalPath, onClose, stopRecording]);

  // ── Save and edit — media library ONLY, never Downloads ─────────────────
  const handleSave = useCallback(async () => {
    if (!finalPath || saving) return;
    setSaving(true);
    const fileName = finalPath.replace(/\\/g, '/').split('/').pop() ?? 'recording';
    const stamp = new Date();
    const nice = `${MODE_TITLE[mode].replace(' recording', '')} recording ${String(stamp.getHours()).padStart(2, '0')}.${String(stamp.getMinutes()).padStart(2, '0')}`;
    try {
      await importFileIntoLibrary({
        id: Math.random().toString(36).slice(2),
        filePath: finalPath,
        fileName,
        fileType: isAudioOnly ? 'audio' : 'video',
        sourceUrl: `recording://${mode}`,
        title: nice,
        origin: 'recording',
      });
      cleanupAll();
      onClose();
      usePanelStore.getState().showPanel('media-import');
    } catch (e: any) {
      setPermError(`Saving failed: ${e?.message ?? e}`);
      setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalPath, saving, mode, isAudioOnly, onClose]);

  // ── Send to EDITH — audio-gated hand-off into her chat panel ─────────────
  // Same import recipe as Save (media library only, never Downloads, never the
  // timeline), then the file lands as an attachment in EDITH's chat so the user
  // can immediately ask her to clean it (filler removal etc.). Gated on the
  // recording actually containing audible audio — a muted mic writes a silent
  // track, and EDITH can't transcribe silence.
  const handleSendToEdith = useCallback(async () => {
    if (!finalPath || sendingToEdith || saving) return;
    setSendingToEdith(true);
    setAudioWarning(null);
    try {
      const check = await invoke('recorder:hasAudibleAudio', { filePath: finalPath });
      if (!check?.success) throw new Error(check?.error ?? 'audio check failed');
      if (!check.audible) {
        setAudioWarning("Your audio couldn't be heard. Check that your microphone is on, then record again.");
        setSendingToEdith(false);
        return;
      }
      const fileName = finalPath.replace(/\\/g, '/').split('/').pop() ?? 'recording';
      const stamp = new Date();
      const nice = `${MODE_TITLE[mode].replace(' recording', '')} recording ${String(stamp.getHours()).padStart(2, '0')}.${String(stamp.getMinutes()).padStart(2, '0')}`;
      await importFileIntoLibrary({
        id: Math.random().toString(36).slice(2),
        filePath: finalPath,
        fileName,
        fileType: isAudioOnly ? 'audio' : 'video',
        sourceUrl: `recording://${mode}`,
        title: nice,
        origin: 'recording',
      });
      sendMediaToEdith({ name: nice, path: finalPath });
      cleanupAll();
      onClose();
      usePanelStore.getState().showPanel('friday');
    } catch (e: any) {
      setAudioWarning(`Couldn't send to EDITH: ${e?.message ?? e}`);
      setSendingToEdith(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalPath, sendingToEdith, saving, mode, isAudioOnly, onClose]);

  // ── Toggles ──────────────────────────────────────────────────────────────
  const toggleCam = useCallback(async () => {
    if (camOn) {
      setCamOn(false);
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
    } else {
      camRetryRef.current = 0;
      setPermError(null);
      try { await acquireCam(camId || undefined); setCamOn(true); } catch { /* stays off */ }
    }
  }, [camOn, camId, acquireCam]);

  const toggleMic = useCallback(() => {
    const next = !micOn;
    setMicOn(next);
    if (micGainRef.current) micGainRef.current.gain.value = next ? 1 : 0;
  }, [micOn]);

  const switchCam = useCallback(async (id: string) => {
    setCamId(id); localStorage.setItem('recorder-cam', id);
    setOpenDropdown(null);
    if (camOn) { try { await acquireCam(id); } catch { /* keep old */ } }
  }, [camOn, acquireCam]);

  const switchMic = useCallback(async (id: string) => {
    setOpenDropdown(null);
    if (id === '') { setMicOn(false); if (micGainRef.current) micGainRef.current.gain.value = 0; return; }
    setMicId(id); localStorage.setItem('recorder-mic', id);
    try { await acquireMic(id); if (!micOn) { setMicOn(true); if (micGainRef.current) micGainRef.current.gain.value = 1; } } catch { /* keep old */ }
  }, [acquireMic, micOn]);

  // ── Teardown ─────────────────────────────────────────────────────────────
  const cleanupAll = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (drawTimerRef.current) clearInterval(drawTimerRef.current);
    const rec = recorderRef.current;
    recorderRef.current = null;
    stoppingRef.current = 'discard';
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* gone */ } }
    if (recordingIdRef.current) {
      invoke('recorder:discard', { id: recordingIdRef.current }).catch(() => {});
      recordingIdRef.current = null;
    }
    [camStreamRef, micStreamRef, screenStreamRef].forEach((r) => {
      r.current?.getTracks().forEach((t) => t.stop());
      r.current = null;
    });
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    invoke('recorder:setBackgroundThrottling', true).catch(() => {});
  }, []);
  useEffect(() => cleanupAll, [cleanupAll]);

  const handleClose = useCallback(() => {
    if (phase === 'recording' || phase === 'review') { setConfirmDelete('close'); return; }
    cleanupAll();
    onClose();
  }, [phase, cleanupAll, onClose]);

  // ── Camera bubble drag / resize / rotate ────────────────────────────────
  const dragStateRef = useRef<null | {
    kind: 'move' | 'resize' | 'rotate';
    startX: number; startY: number; start: Bubble; corner?: string;
  }>(null);

  const onBubblePointerDown = useCallback((e: React.PointerEvent, kind: 'move' | 'resize' | 'rotate', corner?: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = { kind, startX: e.clientX, startY: e.clientY, start: { ...bubbleRef.current }, corner };
    const onMove = (ev: PointerEvent) => {
      const st = dragStateRef.current;
      const stage = stageRef.current;
      if (!st || !stage) return;
      const rect = stage.getBoundingClientRect();
      if (st.kind === 'move') {
        setBubble({ ...st.start, cx: st.start.cx + (ev.clientX - st.startX), cy: st.start.cy + (ev.clientY - st.startY) });
      } else if (st.kind === 'rotate') {
        const px = ev.clientX - rect.left - st.start.cx;
        const py = ev.clientY - rect.top - st.start.cy;
        const deg = (Math.atan2(py, px) * 180) / Math.PI + 90;
        setBubble({ ...st.start, rot: Math.round(deg) });
      } else {
        // resize: pointer distance from center in the bubble's local (unrotated) frame
        const px = ev.clientX - rect.left - st.start.cx;
        const py = ev.clientY - rect.top - st.start.cy;
        const rad = (-st.start.rot * Math.PI) / 180;
        const lx = px * Math.cos(rad) - py * Math.sin(rad);
        const ly = px * Math.sin(rad) + py * Math.cos(rad);
        const w = Math.max(72, Math.max(Math.abs(lx) * 2, Math.abs(ly) * 2 * (16 / 9)));
        setBubble({ ...st.start, w });
      }
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // ── UI fragments ─────────────────────────────────────────────────────────
  // The bubble stays MOUNTED through the picker phase (only hidden) — remounting
  // its <video> mid-flow permanently stalls the re-attached camera stream at
  // readyState 0 (frames never decode again), which silently broke the composite.
  const bubbleVisible = phase === 'setup' || phase === 'recording' || phase === 'countdown';
  const bubbleEl = hasCamera && camOn && mode === 'screen-camera' && (bubbleVisible || phase === 'picker') && (
    <div
      data-testid="recorder-bubble"
      className="absolute select-none"
      style={{
        left: bubble.cx - bubble.w / 2,
        top: bubble.cy - (bubble.w * 9 / 16) / 2,
        width: bubble.w,
        height: bubble.w * 9 / 16,
        transform: `rotate(${bubble.rot}deg)`,
        cursor: 'grab',
        zIndex: 5,
        visibility: bubbleVisible ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => onBubblePointerDown(e, 'move')}
    >
      <video
        ref={camVideoRef}
        muted
        playsInline
        className="w-full h-full object-cover rounded-md pointer-events-none"
        style={{ outline: `1.5px solid ${GREEN}`, background: '#000' }}
      />
      {/* rotate handle */}
      <span
        data-testid="bubble-rotate"
        onPointerDown={(e) => onBubblePointerDown(e, 'rotate')}
        className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow cursor-crosshair"
        style={{ top: -22 }}
      />
      <span className="absolute left-1/2 -translate-x-1/2 w-px bg-white/70" style={{ top: -10, height: 10 }} />
      {/* corner resize handles */}
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <span
          key={c}
          data-testid={`bubble-handle-${c}`}
          onPointerDown={(e) => onBubblePointerDown(e, 'resize', c)}
          className="absolute w-3 h-3 rounded-full bg-white shadow"
          style={{
            cursor: c === 'tl' || c === 'br' ? 'nwse-resize' : 'nesw-resize',
            left: c.includes('l') ? -6 : undefined,
            right: c.includes('r') ? -6 : undefined,
            top: c.startsWith('t') ? -6 : undefined,
            bottom: c.startsWith('b') ? -6 : undefined,
          }}
        />
      ))}
    </div>
  );

  const deviceButton = (
    which: 'cam' | 'mic',
    on: boolean,
    onToggle: () => void,
    label: string,
  ) => (
    <div className="relative flex items-center">
      <button
        type="button"
        data-testid={`${which}-toggle`}
        onClick={onToggle}
        className="flex flex-col items-center gap-1 px-2 py-1 rounded hover:bg-white/[0.06] transition-colors"
        title={on ? `Turn off ${label.toLowerCase()}` : `Turn on ${label.toLowerCase()}`}
      >
        <span className="relative inline-flex">
          {which === 'cam' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={on ? '#e4e4e7' : '#71717a'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="13" height="12" rx="2.5" />
              <path d="M15 10.5l6-3.5v10l-6-3.5" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={on ? '#e4e4e7' : '#71717a'} strokeWidth="1.8" strokeLinecap="round">
              <rect x="9" y="2.5" width="6" height="11" rx="3" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
            </svg>
          )}
          {!on && <span className="absolute inset-0 flex items-center justify-center"><span className="w-[22px] h-[1.6px] bg-red-400 rotate-45 rounded-full" /></span>}
        </span>
        <span className="text-[10px] text-zinc-400">{label}</span>
      </button>
      <button
        type="button"
        data-testid={`${which}-dropdown`}
        onClick={(e) => { e.stopPropagation(); setOpenDropdown(openDropdown === which ? null : which); }}
        className="px-1 py-2 text-zinc-500 hover:text-zinc-300"
        title={`Choose ${label.toLowerCase()}`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {openDropdown === which && (
        <div
          className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 min-w-[240px] max-w-[320px] rounded-xl border border-white/10 py-1.5 shadow-2xl z-30"
          style={{ background: '#1c1c1c' }}
        >
          {which === 'mic' && (
            <button
              type="button"
              onClick={() => switchMic('')}
              className="w-full text-left px-3.5 py-2 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
            >
              None
            </button>
          )}
          {(which === 'cam' ? cams : mics).map((d) => {
            const selected = (which === 'cam' ? camId : micId) === d.deviceId && (which === 'cam' ? camOn : micOn);
            return (
              <button
                key={d.deviceId}
                type="button"
                onClick={() => (which === 'cam' ? switchCam(d.deviceId) : switchMic(d.deviceId))}
                className={`w-full text-left px-3.5 py-2 text-[11px] hover:bg-white/[0.06] flex items-center gap-2 ${selected ? 'text-white' : 'text-zinc-300'}`}
              >
                <span className="w-3 flex-shrink-0">{selected ? '✓' : ''}</span>
                <span className="truncate">{d.label || `${label} ${d.deviceId.slice(0, 6)}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  // Meet-style activity pill: three dots that stretch into bars while the
  // selected mic hears you — the "is my mic actually working?" answer.
  const micActivityPill = (
    <span
      ref={micPillRef}
      data-testid="mic-activity"
      data-level="0.00"
      className="ml-1.5 h-7 px-2.5 rounded-full flex items-center gap-[3px]"
      style={{ background: 'rgba(255,255,255,0.06)' }}
      title={micOn ? 'The bars move when your mic picks up sound' : 'Mic is muted'}
    >
      {[micBar0, micBar1, micBar2].map((r, i) => (
        <span
          key={i}
          ref={r}
          className="w-[3px] rounded-full"
          style={{ height: 3, background: micOn ? GREEN : '#52525b', transition: 'height 70ms linear' }}
        />
      ))}
    </span>
  );

  const controlBar = (
    <div className="flex items-center justify-center gap-1 py-2.5">
      {hasCamera && deviceButton('cam', camOn, toggleCam, 'Camera')}
      {deviceButton('mic', micOn, toggleMic, 'Mic')}
      {micActivityPill}
    </div>
  );

  const primaryBtn = (label: string, onClick: () => void, testid: string) => (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className="flex items-center gap-2.5 px-7 py-3 rounded-full text-[13px] font-semibold text-white transition-all hover:brightness-110 shadow-lg"
      style={{ background: GREEN, boxShadow: '0 0 0 3px rgba(255,255,255,0.9), 0 6px 24px rgba(0,0,0,0.5)' }}
    >
      <span className="w-4 h-4 rounded-full border-2 border-white flex items-center justify-center">
        <span className="w-1.5 h-1.5 rounded-full bg-white" />
      </span>
      {label}
    </button>
  );

  const elapsed = fmtTime(elapsedMs);
  const stageBg = '#232323';

  // Portal to <body>: the panel dock creates its own stacking context, so a
  // fixed overlay rendered inside it would sit UNDER the preview's hit-test
  // layer no matter the z-index.
  // z 20000 — the preview's hit-test layer is 9000 and its transform boundary 10000.
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.72)', zIndex: 20000 }} data-testid="recorder-modal">
      <div
        className="relative flex flex-col rounded-2xl border border-white/[0.08] overflow-hidden"
        style={{ background: '#161616', width: 'min(1060px, 92vw)', height: 'min(700px, 90vh)' }}
        onClick={() => setOpenDropdown(null)}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-[15px] font-semibold text-zinc-100">{MODE_TITLE[mode]}</h2>
          <button
            type="button"
            data-testid="recorder-close"
            onClick={handleClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        {/* stage */}
        <div className="flex-1 mx-5 rounded-lg relative overflow-hidden" ref={stageRef} style={{ background: stageBg }}>
          {/* permission gate */}
          {phase === 'permission' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-10 text-center">
              <span className="flex items-center gap-3">
                {hasCamera && (
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="6" width="13" height="12" rx="2.5" /><path d="M15 10.5l6-3.5v10l-6-3.5" />
                  </svg>
                )}
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.6" strokeLinecap="round">
                  <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
                </svg>
              </span>
              <p className="text-sm text-zinc-200 font-medium">
                {hasCamera ? 'Allow DiviDr to use your camera and microphone' : 'Allow DiviDr to use your microphone'}
              </p>
              <p className="text-xs text-zinc-500 max-w-md leading-relaxed">
                Your {hasCamera ? 'camera and microphone are' : 'microphone is'} only used while this
                recorder is open. Nothing is captured until you start recording.
              </p>
              {permError && <p className="text-xs text-red-400 max-w-md">{permError}</p>}
              <button
                type="button"
                data-testid="perm-allow"
                onClick={handleAllowAccess}
                className="px-6 py-2.5 rounded-full text-[13px] font-semibold text-white hover:brightness-110 transition-all"
                style={{ background: GREEN }}
              >
                Allow access
              </button>
            </div>
          )}

          {/* setup + countdown + recording stages */}
          {phase !== 'permission' && phase !== 'review' && phase !== 'deleting' && (
            <>
              {/* screen preview (live while sharing) */}
              {hasScreen && (
                <video
                  ref={screenVideoRef}
                  muted
                  playsInline
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  style={{ display: screenStreamRef.current ? 'block' : 'none' }}
                />
              )}
              {/* camera-only fills the stage */}
              {mode === 'camera' && camOn && (
                <video
                  ref={camVideoRef}
                  muted
                  playsInline
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />
              )}
              {mode === 'camera' && !camOn && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-xs text-zinc-500">Camera is off — turn it back on below to record.</p>
                </div>
              )}
              {/* audio mode — mic disc while setting up, scrolling waveform while recording */}
              {isAudioOnly && phase !== 'recording' && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span
                    className="w-32 h-32 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(255,255,255,0.06)' }}
                  >
                    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#d4d4d8" strokeWidth="1.6" strokeLinecap="round">
                      <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
                    </svg>
                  </span>
                </div>
              )}
              {isAudioOnly && phase === 'recording' && (
                <div className="absolute inset-0 flex items-center justify-center px-10">
                  <canvas
                    ref={waveCanvasRef}
                    data-testid="audio-waveform"
                    className="w-full"
                    style={{ height: 220, maxWidth: 860 }}
                  />
                </div>
              )}
              {/* screen-mode helper text before a source is picked */}
              {hasScreen && !screenStreamRef.current && phase === 'setup' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-10 text-center pointer-events-none">
                  <svg width="52" height="44" viewBox="0 0 24 20" fill="none" stroke="#a1a1aa" strokeWidth="1.2">
                    <rect x="1.5" y="1.5" width="21" height="14" rx="1.5" fill="rgba(255,255,255,0.08)" />
                    <circle cx="7" cy="7" r="2.4" fill="#a1a1aa" stroke="none" />
                    <path d="M11 5.5h8M11 8.5h6" strokeLinecap="round" />
                    <path d="M17 13l3.5 5-2.6.2-1.4 2.3L14 15z" fill="#e4e4e7" stroke="none" />
                  </svg>
                  <p className="text-[13px] text-zinc-300 max-w-lg leading-relaxed">
                    You&apos;ll pick a screen or window to share. Recording starts automatically
                    after a 3-2-1 countdown — keep this window minimized for a clean take.
                  </p>
                </div>
              )}
              {bubbleEl}
              {/* setup primary action */}
              {phase === 'setup' && (
                <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-3" style={{ bottom: 26 }}>
                  {permError && (
                    <p data-testid="recorder-error" className="text-[11px] text-red-400 max-w-md text-center px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,0,0,0.5)' }}>
                      {permError}
                    </p>
                  )}
                  {hasScreen
                    ? primaryBtn('Start screen share', openPicker, 'start-share')
                    : primaryBtn('Start recording', runCountdown, 'start-recording')}
                </div>
              )}
              {/* countdown overlay */}
              {phase === 'countdown' && (
                <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }}>
                  <span data-testid="countdown" className="text-white font-bold select-none" style={{ fontSize: 130, lineHeight: 1 }}>
                    {countdown}
                  </span>
                </div>
              )}
              {/* recording control pill */}
              {phase === 'recording' && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3 pl-3 pr-4 py-2 rounded-full border border-white/80 shadow-2xl"
                  style={{ bottom: 22, background: 'rgba(12,12,12,0.92)', zIndex: 8 }}
                >
                  <button
                    type="button"
                    data-testid="rec-stop"
                    onClick={() => stopRecording('finish')}
                    title="Stop recording"
                    className="w-9 h-9 rounded-full flex items-center justify-center hover:brightness-110 transition-all"
                    style={{ background: GREEN }}
                  >
                    <span className="w-3 h-3 rounded-[2px] bg-white" />
                  </button>
                  {!paused ? (
                    <button type="button" data-testid="rec-pause" onClick={pauseRecording} title="Pause" className="text-zinc-100 hover:text-white px-1">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1" /><rect x="13.5" y="4" width="4.5" height="16" rx="1" /></svg>
                    </button>
                  ) : (
                    <button type="button" data-testid="rec-resume" onClick={resumeRecording} title="Resume" className="text-zinc-100 hover:text-white px-1">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8V4z" /></svg>
                    </button>
                  )}
                  <span data-testid="rec-timer" className="text-[15px] font-semibold text-white tabular-nums min-w-[52px] text-center">{elapsed}</span>
                  <span className="w-px h-5 bg-white/20" />
                  <button
                    type="button"
                    data-testid="rec-restart"
                    onClick={() => setConfirmDelete('restart')}
                    title="Restart — deletes this recording"
                    className="text-zinc-100 hover:text-white px-0.5"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
                    </svg>
                  </button>
                </div>
              )}
            </>
          )}

          {/* deleting interstitial */}
          {phase === 'deleting' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#e4e4e7" strokeWidth="1.4" strokeLinecap="round">
                <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
                <path d="M10 11v5.5M14 11v5.5" />
              </svg>
              <p data-testid="deleting-label" className="text-sm text-zinc-200">Deleting the clip.</p>
            </div>
          )}

          {/* review */}
          {phase === 'review' && reviewUrl && (
            <div className="absolute inset-0 flex flex-col">
              <div className="flex-1 min-h-0 flex items-center justify-center p-4">
                {isAudioOnly ? (
                  <div className="flex flex-col items-center gap-6">
                    <span className="w-28 h-28 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d4d4d8" strokeWidth="1.6" strokeLinecap="round">
                        <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
                      </svg>
                    </span>
                    <audio data-testid="review-media" src={reviewUrl} controls className="w-[420px] max-w-full" />
                  </div>
                ) : (
                  <video data-testid="review-media" src={reviewUrl} controls autoPlay className="max-w-full max-h-full rounded-lg" style={{ background: '#000' }} />
                )}
              </div>
              <div className="flex items-center justify-center gap-3 pb-2">
                <button
                  type="button"
                  data-testid="review-retake"
                  onClick={() => setConfirmDelete('retake')}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-semibold text-zinc-200 border border-white/15 hover:bg-white/[0.06] transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
                  Retake recording
                </button>
                <button
                  type="button"
                  data-testid="review-send-edith"
                  onClick={handleSendToEdith}
                  disabled={sendingToEdith || saving}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-semibold text-black hover:brightness-90 transition-all disabled:opacity-60"
                  style={{ background: '#fff' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3z" /></svg>
                  {sendingToEdith ? 'Checking audio…' : 'Send to EDITH'}
                </button>
                <button
                  type="button"
                  data-testid="review-save"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-semibold text-white hover:brightness-110 transition-all disabled:opacity-60"
                  style={{ background: GREEN, boxShadow: '0 0 0 2.5px rgba(255,255,255,0.85)' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  {saving ? 'Saving…' : 'Save and edit'}
                </button>
              </div>
              <p
                data-testid="review-audio-warning"
                className="text-center text-[12px] pb-4 min-h-[20px]"
                style={{ color: '#fbbf24' }}
              >
                {audioWarning ?? ''}
              </p>
            </div>
          )}

          {/* screen source picker */}
          {phase === 'picker' && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.55)' }}>
              <div className="rounded-2xl border border-white/10 p-5 w-[640px] max-w-[92%] max-h-[92%] flex flex-col" style={{ background: '#1b1b1b' }}>
                <p className="text-sm font-semibold text-zinc-100">Choose what to share</p>
                <p className="text-[11px] text-zinc-500 mt-0.5 mb-3">The recording will capture the contents of your selection.</p>
                <div className="flex gap-1 mb-3">
                  {(['screen', 'window'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      data-testid={`picker-tab-${t}`}
                      onClick={() => { setPickerTab(t); setPickedSource(null); }}
                      className={`px-4 py-1.5 rounded-full text-[11px] font-medium transition-colors ${pickerTab === t ? 'text-black' : 'text-zinc-400 hover:text-zinc-200'}`}
                      style={pickerTab === t ? { background: GREEN } : { background: 'rgba(255,255,255,0.05)' }}
                    >
                      {t === 'screen' ? 'Entire screen' : 'Window'}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-3 gap-2.5 pr-1">
                  {sources.filter((s) => (pickerTab === 'screen' ? s.isScreen : !s.isScreen)).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      data-testid="source-item"
                      onClick={() => setPickedSource(s.id)}
                      className={`rounded-lg overflow-hidden border text-left transition-colors ${pickedSource === s.id ? '' : 'border-white/10 hover:border-white/25'}`}
                      style={pickedSource === s.id ? { borderColor: GREEN, boxShadow: `0 0 0 1px ${GREEN}` } : undefined}
                    >
                      {s.thumbnail
                        ? <img src={s.thumbnail} className="w-full aspect-video object-cover" />
                        : <div className="w-full aspect-video bg-white/[0.04]" />}
                      <p className="px-2 py-1.5 text-[10px] text-zinc-300 truncate">{s.name}</p>
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-2 pt-3.5">
                  <button
                    type="button"
                    onClick={() => setPhase('setup')}
                    className="px-4 py-2 rounded-full text-[11px] font-medium text-zinc-300 border border-white/15 hover:bg-white/[0.06]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="source-share"
                    disabled={!pickedSource}
                    onClick={async () => {
                      if (!pickedSource) return;
                      try {
                        await startScreenStream(pickedSource);
                        runCountdown();
                      } catch (e: any) {
                        setPermError(`Screen share failed: ${e?.message ?? e}`);
                        setPhase('setup');
                      }
                    }}
                    className="px-5 py-2 rounded-full text-[11px] font-semibold text-white disabled:opacity-40 hover:brightness-110 transition-all"
                    style={{ background: GREEN }}
                  >
                    Share
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* device toolbar (hidden during review) */}
        {phase !== 'review' && phase !== 'permission' && controlBar}
        {(phase === 'review' || phase === 'permission') && <div className="py-1.5" />}

        {/* disclaimer */}
        <div className="flex items-center gap-2 px-5 pb-3.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="1.8" className="flex-shrink-0"><circle cx="12" cy="12" r="9.5" /><path d="M12 8h.01M12 11.5V16" strokeLinecap="round" /></svg>
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            By recording, you confirm you have permission from everyone in your recording and that
            it follows your organization&apos;s terms. Recordings stay on this device — they only join
            your media sources when you save them.
          </p>
        </div>

        {/* delete confirm */}
        {confirmDelete && (
          <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div className="rounded-2xl border border-white/10 p-6 w-[380px]" style={{ background: '#1b1b1b' }}>
              <p className="text-[15px] font-semibold text-zinc-100">Delete this clip?</p>
              <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">This will permanently delete your recording clip.</p>
              <div className="flex gap-2 mt-5">
                <button
                  type="button"
                  data-testid="confirm-delete"
                  onClick={() => performDelete(confirmDelete)}
                  className="px-5 py-2 rounded-lg text-xs font-semibold text-white hover:brightness-110"
                  style={{ background: GREEN }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-testid="confirm-cancel"
                  onClick={() => setConfirmDelete(null)}
                  className="px-5 py-2 rounded-lg text-xs font-medium text-zinc-200 border border-white/15 hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
