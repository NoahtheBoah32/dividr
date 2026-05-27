/**
 * storeAdapter â€” bridges the OperationEngine to Dividr's Zustand store.
 * Translates Op objects into concrete store mutations.
 */

import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { calculateDimensionsForRatio } from '@/frontend/features/editor/stores/videoEditor/utils/aspectRatioHelpers';
import { useCaptionStylesStore } from '@/frontend/features/editor/stores/captionStylesStore';
import { Op } from './types';
import { operationEngine } from './operationEngine';
import { useDownloadApprovalStore } from './stores/downloadApprovalStore';
import { pickSubtitleRow } from './captionUtils';
import { animateForOp, startEdithEditing, stopEdithEditing } from './edithPlayheadAnimator';
import { useEdithEditingStore } from './stores/edithEditingStore';
import { useEdithCursorStore } from './stores/edithCursorStore';

export { pickSubtitleRow };

// SFX library cache — populated by FridayPanel on mount via scan-sfx-library IPC
let _sfxLibrary: Array<{ name: string; path: string; durationSec: number; categories: string[] }> = [];
export function setSfxLibraryCache(entries: typeof _sfxLibrary) { _sfxLibrary = entries; }

// â”€â”€ GEMINI KILL SWITCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Set to true during testing to prevent any Gemini API calls.
// Flip back to false when ready to re-enable.
const GEMINI_DISABLED = true;
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Mycelium caption style defaults
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// V2 helpers — resolve clips by timestamp or name instead of clipId
function findMainVideoTrack(store: any): any {
  return (store.tracks as any[])?.find(
    (t: any) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0,
  ) ?? null;
}

function findClipAtSeconds(store: any, seconds: number, layer?: number): any {
  const fps: number = store.fps ?? 30;
  const frame = Math.round(seconds * fps);
  return (store.tracks as any[])?.find((t: any) => {
    if (layer !== undefined && (t.trackRowIndex ?? 0) !== layer) return false;
    return t.startFrame <= frame && frame <= t.endFrame;
  }) ?? null;
}

function findClipByName(store: any, clipName: string): any {
  return (store.tracks as any[])?.find(
    (t: any) => t.name === clipName || t.source?.split(/[/\\]/).pop() === clipName,
  ) ?? null;
}

// Resolve a named EDITH target to viewport coordinates.
// Falls back to sensible positions if the element isn't mounted yet.
function resolveTarget(target: string): { x: number; y: number } {
  const el = document.querySelector(`[data-edith-target="${target}"]`);
  if (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  // Fallback positions by prefix
  if (target.startsWith('media:')) {
    return { x: window.innerWidth * 0.13, y: window.innerHeight * 0.45 };
  }
  if (target.startsWith('track-body:')) {
    return { x: window.innerWidth * 0.55, y: window.innerHeight * 0.82 };
  }
  if (target === 'timeline-drop') {
    return { x: window.innerWidth * 0.5, y: window.innerHeight * 0.88 };
  }
  return { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
}

async function cursorMoveTo(target: string, offsetX = 0, offsetY = 0) {
  const { x, y } = resolveTarget(target);
  const cursor = useEdithCursorStore.getState();
  if (!cursor.visible) {
    // Teleport to start without animation, then show
    cursor.setCursor({ x: x + offsetX, y: y + offsetY, animate: false, visible: true });
    await sleep(60);
  }
  cursor.setCursor({ x: x + offsetX, y: y + offsetY, animate: true });
  await sleep(600); // matches 0.55s CSS transition + buffer
  cursor.setCursor({ animate: false });
}

async function cursorDoClick() {
  useEdithCursorStore.getState().setCursor({ clicking: true });
  await sleep(90);
  useEdithCursorStore.getState().setCursor({ clicking: false });
  await sleep(120);
}

async function cursorDoStartDrag(target: string, label: string, offsetX = 0, offsetY = 0) {
  await cursorMoveTo(target, offsetX, offsetY);
  useEdithCursorStore.getState().setCursor({ clicking: true, dragging: true, dragLabel: label });
  await sleep(200);
  useEdithCursorStore.getState().setCursor({ clicking: false });
}

async function cursorDoDrop(target: string) {
  const { x, y } = resolveTarget(target);
  useEdithCursorStore.getState().setCursor({ x, y, animate: true });
  await sleep(650);
  useEdithCursorStore.getState().setCursor({ animate: false, dragging: false, dragLabel: '', clicking: true });
  await sleep(90);
  useEdithCursorStore.getState().setCursor({ clicking: false });
  await sleep(150);
}

function cursorDoHide() {
  useEdithCursorStore.getState().setCursor({ visible: false, dragging: false, dragLabel: '' });
}

const CAPTION_DEFAULTS = {
  fontFamily: 'Impact',
  fontSize: 90,
  fillColor: '#FFFFFF',
  isBold: false,
  isUppercase: true,
  position: 0.65,
  highlightColor: '#FFD700',
};

/**
 * Compute the overlay props for a B-roll clip based on three framing cases:
 * 1. Landscape canvas → fill entire canvas
 * 2. Portrait canvas with letterbox-blurred main track (landscape video in reels format)
 *    → fill only the middle zone where the landscape video actually plays
 * 3. Native portrait canvas → no adjustment (returns empty, let clip play at natural size)
 */
function computeBrollOverlayProps(
  store: any,
  canvasW: number,
  canvasH: number,
): Record<string, unknown> {
  const isLandscapeCanvas = canvasW >= canvasH;

  if (isLandscapeCanvas) {
    // Case 1: landscape project — scale B-roll to fill the full canvas (center-crop, no blur overlay)
    return {
      textTransform: { x: 0, y: 0, scale: 1, rotation: 0, width: canvasW, height: canvasH },
    };
  }

  // Portrait canvas — check if the main video is letterbox-blurred (landscape in reels)
  const mainTrack = (store.tracks as any[])?.find(
    (t: any) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0
  );
  const hasLetterbox = mainTrack?.proxyBlockedMessage === 'letterbox-blur';

  if (hasLetterbox) {
    // Case 2: landscape footage shown in portrait canvas — B-roll fills only the middle 16:9 zone
    const middleH = Math.round(canvasW * 9 / 16);
    const middleY = Math.round((canvasH - middleH) / 2);
    return {
      textTransform: { x: 0, y: middleY, scale: 1, rotation: 0, width: canvasW, height: middleH },
    };
  }

  // Case 3: native portrait/reels — fill full canvas
  return {
    textTransform: { x: 0, y: 0, scale: 1, rotation: 0, width: canvasW, height: canvasH },
  };
}

async function applyOp(op: Op): Promise<void> {
  const store = useVideoEditorStore.getState() as any;

  switch (op.type) {
    case 'cut': {
      if ((op as any).atSeconds !== undefined) {
        // V2: resolve main video clip by timestamp
        const fps: number = store.fps ?? 30;
        const frame = Math.round((op as any).atSeconds * fps);
        const clip = findClipAtSeconds(store, (op as any).atSeconds, 0);
        if (!clip) throw new Error(`cut: no layer-0 clip at ${(op as any).atSeconds}s`);
        store.splitTrack(clip.id, frame);
      } else {
        store.splitTrack(op.clipId, op.atFrame);
      }
      break;
    }

    case 'trimClip': {
      // resizeTrack processes only ONE direction at a time (if/else if).
      // When EDITH specifies both bounds, apply them as two sequential calls so
      // neither is silently dropped. Re-read the store between calls so the
      // second call gets the updated state.
      const currentTrack = (store.tracks as any[]).find((t: any) => t.id === op.clipId);
      const currentStart = currentTrack?.startFrame ?? 0;

      if (op.newStartFrame !== undefined && op.newStartFrame !== currentStart) {
        store.resizeTrack(op.clipId, op.newStartFrame, undefined);
      }
      if (op.newEndFrame !== undefined) {
        store.resizeTrack(op.clipId, undefined, op.newEndFrame);
      }
      break;
    }

    case 'insertClip': {
      const fps = store.fps ?? 30;
      const startFrame = op.startFrame;
      const inFrame = Math.round(op.inSeconds * fps);
      const outFrame = Math.round(op.outSeconds * fps);
      const duration = outFrame - inFrame;
      const endFrame = startFrame + duration;

      // Create preview URL via Electron IPC
      let previewUrl = op.src;
      try {
        const result = await window.electronAPI.createPreviewUrl(op.src);
        if (result && typeof result === 'object' && (result as any).url) {
          previewUrl = (result as any).url;
        } else if (typeof result === 'string') {
          previewUrl = result;
        }
      } catch {
        // fall through with raw path
      }

      const isOverlay = op.trackType === 'video' && (op.layer ?? 0) > 0;
      const canvasW: number = (store as any).preview?.canvasWidth ?? 1080;
      const canvasH: number = (store as any).preview?.canvasHeight ?? 1920;
      await store.addTrack({
        type: op.trackType,
        name: op.src.split(/[/\\]/).pop() ?? op.src,
        source: op.src,
        previewUrl,
        duration,
        startFrame,
        endFrame,
        sourceStartTime: op.inSeconds,
        trackRowIndex: op.layer ?? 0,
        muted: isOverlay ? true : undefined,
        visible: true,
        locked: false,
        color: op.trackType === 'video' ? '#4A90D9' : op.trackType === 'audio' ? '#7ED321' : '#F5A623',
        ...(isOverlay ? computeBrollOverlayProps(store, canvasW, canvasH) : {}),
      });
      break;
    }

    case 'addCaption': {
      const fps = store.fps ?? 30;
      const startFrame = Math.round(op.startSeconds * fps);
      const duration = Math.round((op.endSeconds - op.startSeconds) * fps);
      const endFrame = startFrame + duration;

      // Merge: base defaults â† active style bank entry â† op's explicit style
      const { styles: savedStyles, activeStyleId } = useCaptionStylesStore.getState();
      const bankStyle = savedStyles.find((s) => s.id === activeStyleId) ?? null;
      const style = {
        ...CAPTION_DEFAULTS,
        ...(bankStyle ? {
          fontFamily: bankStyle.fontFamily,
          fontSize: bankStyle.fontSize,
          fillColor: bankStyle.fillColor,
          highlightColor: bankStyle.highlightColor,
          isBold: bankStyle.isBold,
          isUppercase: bankStyle.isUppercase,
          position: bankStyle.position,
        } : {}),
        ...op.style,
      };

      // Pack captions into the fewest subtitle rows â€” reuse a row if no time collision
      const subtitleTracks = (store.tracks as any[]).filter((t: any) => t.type === 'subtitle');
      const targetRow = pickSubtitleRow(subtitleTracks, startFrame, endFrame);

      await store.addTrack({
        type: 'subtitle',
        name: op.text.slice(0, 40),
        source: '',
        subtitleText: op.text,
        subtitleType: 'karaoke',
        duration,
        startFrame,
        endFrame,
        visible: true,
        locked: false,
        color: '#F5A623',
        trackRowIndex: targetRow,
        subtitleStyle: {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fillColor: style.fillColor,
          isBold: style.isBold,
          textTransform: style.isUppercase ? 'uppercase' : 'none',
          highlightColor: style.highlightColor,
          highlightWordIndex: style.highlightWordIndex ?? 0,
        },
        subtitleTransform: {
          x: 0,
          y: style.position * 2 - 1,
        },
      });
      break;
    }

    case 'setVolume': {
      store.updateTrackAudio(op.clipId, { volumeDb: op.volumeDb });
      break;
    }

    case 'muteClip': {
      const track = store.tracks.find((t: any) => t.id === op.clipId);
      if (track) {
        store.updateTrack(op.clipId, { muted: op.muted });
      }
      break;
    }

    case 'addSfx': {
      const fps = store.fps ?? 30;
      const startFrame = op.atFrame;
      let previewUrl = op.src;
      try {
        const result = await window.electronAPI.createPreviewUrl(op.src);
        if (result && typeof result === 'object' && (result as any).url) {
          previewUrl = (result as any).url;
        } else if (typeof result === 'string') {
          previewUrl = result;
        }
      } catch {
        // fall through
      }
      // Get SFX duration
      const durationSec = await window.electronAPI.getDuration(op.src).catch(() => 2);
      const duration = Math.round(durationSec * fps);

      await store.addTrack({
        type: 'audio',
        name: op.src.split(/[/\\]/).pop() ?? 'SFX',
        source: op.src,
        previewUrl,
        duration,
        startFrame,
        endFrame: startFrame + duration,
        volumeDb: -6,
        visible: true,
        locked: false,
        color: '#9B59B6',
      });
      break;
    }

    case 'setBroll': {
      const fps = store.fps ?? 30;
      const startFrame = Math.round(op.startSeconds * fps);
      const endFrame = Math.round(op.endSeconds * fps);
      const duration = endFrame - startFrame;
      let previewUrl = op.src;
      try {
        const result = await window.electronAPI.createPreviewUrl(op.src);
        if (result && typeof result === 'object' && (result as any).url) {
          previewUrl = (result as any).url;
        } else if (typeof result === 'string') {
          previewUrl = result;
        }
      } catch {
        // fall through
      }

      const brollCanvasW: number = (store as any).preview?.canvasWidth ?? 1080;
      const brollCanvasH: number = (store as any).preview?.canvasHeight ?? 1920;
      await store.addTrack({
        type: 'video',
        name: op.src.split(/[/\\]/).pop() ?? 'B-Roll',
        source: op.src,
        previewUrl,
        duration,
        startFrame,
        endFrame,
        muted: true,
        visible: true,
        locked: false,
        color: '#27AE60',
        trackRowIndex: 1,
        ...computeBrollOverlayProps(store, brollCanvasW, brollCanvasH),
      });
      break;
    }

    case 'setLetterboxBlur': {
      store.updateTrack(op.clipId, { proxyBlockedMessage: op.enabled ? 'letterbox-blur' : undefined });
      break;
    }

    case 'deleteClip': {
      store.removeTrack(op.clipId);
      break;
    }

    case 'moveClip': {
      if ((op as any).atSeconds !== undefined) {
        // V2: find clip by timestamp, move to toSeconds
        const fps: number = store.fps ?? 30;
        const clip = findClipAtSeconds(store, (op as any).atSeconds, 0);
        if (!clip) throw new Error(`moveClip: no clip at ${(op as any).atSeconds}s`);
        store.moveTrack(clip.id, Math.round((op as any).toSeconds * fps));
      } else if (op.toLayer !== undefined) {
        store.moveTrackToRow(op.clipId, op.toLayer, op.toStartFrame);
      } else {
        store.moveTrack(op.clipId, op.toStartFrame);
      }
      break;
    }

    case 'setAspectRatio': {
      const { canvasWidth, canvasHeight } = store.preview;
      const { width, height } = calculateDimensionsForRatio(op.ratio, canvasWidth ?? 1080, canvasHeight ?? 1920);
      store.setCanvasSize(width, height);
      break;
    }

    case 'setCanvasSize': {
      store.setCanvasSize(op.width, op.height);
      break;
    }

    case 'updateClip': {
      store.updateTrack(op.clipId, op.updates);
      break;
    }

    case 'downloadMedia': {
      console.log('[storeAdapter] â–¶ downloadMedia case hit', op);
      const jobId = Math.random().toString(36).slice(2);
      const dlDir = localStorage.getItem('edith-download-dir') ?? undefined;
      const result = await window.electronAPI.downloadFromUrl({
        jobId,
        url: op.url,
        startSeconds: op.startSeconds,
        endSeconds: op.endSeconds,
        downloadDir: dlDir,
        verify: op.verify,
        topic: op.topic,
        isStockFootage: op.isStockFootage,
      });
      if (!result.success || !result.filePath) {
        window.dispatchEvent(new CustomEvent('edith:downloadComplete', { detail: { url: op.url } }));
        throw new Error(result.error ?? 'Download failed');
      }
      const fileName = result.filePath.replace(/\\/g, '/').split('/').pop() ?? 'download';
      const fileType = (result.fileType ?? 'video') as 'video' | 'audio' | 'image';
      const approvalStore = useDownloadApprovalStore.getState();
      console.log('[storeAdapter] downloadMedia complete', { filePath: result.filePath, autoApproveAll: approvalStore.autoApproveAll, pendingCount: approvalStore.pending.length });
      window.dispatchEvent(new CustomEvent('edith:downloadComplete', { detail: { url: op.url } }));
      const title = (result as any).title ?? op.topic ?? fileName;
      if (approvalStore.autoApproveAll) {
        await approvalStore.approve(
          (() => {
            const id = Math.random().toString(36).slice(2);
            approvalStore.enqueue({ id, filePath: result.filePath!, fileName, fileType, sourceUrl: op.url, title });
            return id;
          })(),
        );
      } else {
        approvalStore.enqueue({
          id: Math.random().toString(36).slice(2),
          filePath: result.filePath,
          fileName,
          fileType,
          sourceUrl: op.url,
          title,
        });
      }
      break;
    }

    case 'cutSilence': {
      const track = store.tracks.find((t: any) => t.id === op.clipId);
      if (!track) {
        throw new Error(`cutSilence: clip ${op.clipId} not found on timeline`);
      }
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Removing silence...' } }));
      const result = await (window.electronAPI as any).invoke('media:cutSilence', {
        filePath: track.source,
        noiseDb: op.noiseDb,
        minDuration: op.minDuration,
      });
      if (!result.success || !result.filePath) {
        throw new Error(result.error ?? 'Silence cutting failed');
      }
      // If the file is unchanged (no silence found), skip update
      if (result.filePath === track.source) break;
      let newPreviewUrl = result.filePath;
      try {
        const previewResult = await window.electronAPI.createPreviewUrl(result.filePath);
        if (previewResult && typeof previewResult === 'object' && (previewResult as any).url) {
          newPreviewUrl = (previewResult as any).url;
        } else if (typeof previewResult === 'string') {
          newPreviewUrl = previewResult;
        }
      } catch {
        // fall through with raw path
      }
      const newName = result.filePath.replace(/\\/g, '/').split('/').pop() ?? track.name;
      store.updateTrack(op.clipId, { source: result.filePath, previewUrl: newPreviewUrl, name: newName });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Silence removed' } }));
      break;
    }

    case 'runWhisper': {
      // Resolve: could be a media library ID or a timeline track ID
      let mediaId = op.clipId;
      let filePath: string | undefined;
      const mediaItem = store.mediaLibrary?.find((m: any) => m.id === op.clipId);
      if (mediaItem) {
        filePath = (mediaItem as any).tempFilePath || (mediaItem as any).source;
      } else {
        const track = store.tracks.find((t: any) => t.id === op.clipId);
        if (!track) throw new Error(`runWhisper: clip ${op.clipId} not found`);
        filePath = track.source;
        // Find the matching media library item by source so we can update it
        const matchingMedia = store.mediaLibrary?.find((m: any) =>
          (m.source === filePath || m.tempFilePath === filePath)
        );
        if (matchingMedia) mediaId = matchingMedia.id;
      }
      if (!filePath) throw new Error(`runWhisper: no file path for ${op.clipId}`);
      useEdithEditingStore.getState().setIsThinking(false);
      useEdithEditingStore.getState().setOpLabel('Transcribing — starting up…');

      // Stream progress + chunks — update timeline overlay label directly
      const onWhisperProgress = (_event: any, progress: { stage: string; progress: number; message: string }) => {
        const pct = Math.round(progress.progress);
        const label = pct < 15 ? 'Loading Whisper model…' : `Transcribing… ${pct}%`;
        useEdithEditingStore.getState().setOpLabel(label);
      };

      const doStreamCaptions = op.streamCaptions !== false; // default on
      const onWhisperChunk = (_event: any, chunk: { chunkIndex: number; startTime: number; endTime: number; segments: Array<{ start: number; end: number; text: string }>; text: string }) => {
        const mins = Math.floor(chunk.endTime / 60);
        const secs = String(Math.floor(chunk.endTime % 60)).padStart(2, '0');
        useEdithEditingStore.getState().setOpLabel(`Transcribing… ${mins}:${secs} (chunk ${chunk.chunkIndex + 1})`);
        window.dispatchEvent(new CustomEvent('edith:transcriptChunk', { detail: chunk }));

        if (doStreamCaptions && chunk.segments?.length) {
          const store = useVideoEditorStore.getState() as any;
          const fps: number = store?.timeline?.fps ?? 30;
          const { styles: savedStyles, activeStyleId } = useCaptionStylesStore.getState();
          const bankStyle = savedStyles.find((s: any) => s.id === activeStyleId) ?? null;
          const style = {
            ...CAPTION_DEFAULTS,
            ...(bankStyle ? {
              fontFamily: bankStyle.fontFamily,
              fontSize: bankStyle.fontSize,
              fillColor: bankStyle.fillColor,
              highlightColor: bankStyle.highlightColor,
              isBold: bankStyle.isBold,
              isUppercase: bankStyle.isUppercase,
              position: bankStyle.position,
            } : {}),
          };

          for (const seg of chunk.segments) {
            if (!seg.text?.trim()) continue;
            const segText = seg.text.trim();
            const words: Array<{ word: string; start: number; end: number }> = seg.words ?? [];

            if (words.length >= 1) {
              // Word-level karaoke: one subtitle track per word, all displaying the full sentence.
              // highlightWordIndex increments so the yellow follows each word as it's spoken —
              // identical to CapCut's auto-caption highlight behavior.
              for (let wi = 0; wi < words.length; wi++) {
                const w = words[wi];
                if (!w?.word?.trim()) continue;
                const wordStart = Math.round(w.start * fps);
                const wordEnd = Math.round(w.end * fps);
                const wordDur = Math.max(1, wordEnd - wordStart);
                const subtitleTracks = (store.tracks as any[]).filter((t: any) => t.type === 'subtitle');
                const targetRow = pickSubtitleRow(subtitleTracks, wordStart, wordStart + wordDur);
                store.addTrack({
                  type: 'subtitle',
                  name: segText.slice(0, 40),
                  source: '',
                  subtitleText: segText,
                  subtitleType: 'karaoke',
                  duration: wordDur,
                  startFrame: wordStart,
                  endFrame: wordStart + wordDur,
                  visible: true,
                  locked: false,
                  color: '#F5A623',
                  trackRowIndex: targetRow,
                  subtitleStyle: {
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSize,
                    fillColor: style.fillColor,
                    isBold: style.isBold,
                    textTransform: style.isUppercase ? 'uppercase' : 'none',
                    highlightColor: style.highlightColor,
                    highlightWordIndex: wi,
                  },
                  subtitleTransform: { x: 0, y: style.position * 2 - 1 },
                });
              }
            } else {
              // Fallback: no word timestamps — per-segment with halved duration
              const startFrame = Math.round(seg.start * fps);
              const rawDuration = Math.max(1, Math.round(seg.end * fps) - startFrame);
              const duration = Math.max(1, Math.round(rawDuration / 2));
              const endFrame = startFrame + duration;
              const subtitleTracks = (store.tracks as any[]).filter((t: any) => t.type === 'subtitle');
              const targetRow = pickSubtitleRow(subtitleTracks, startFrame, endFrame);
              store.addTrack({
                type: 'subtitle',
                name: segText.slice(0, 40),
                source: '',
                subtitleText: segText,
                subtitleType: 'karaoke',
                duration,
                startFrame,
                endFrame,
                visible: true,
                locked: false,
                color: '#F5A623',
                trackRowIndex: targetRow,
                subtitleStyle: {
                  fontFamily: style.fontFamily,
                  fontSize: style.fontSize,
                  fillColor: style.fillColor,
                  isBold: style.isBold,
                  textTransform: style.isUppercase ? 'uppercase' : 'none',
                  highlightColor: style.highlightColor,
                  highlightWordIndex: 0,
                },
                subtitleTransform: { x: 0, y: style.position * 2 - 1 },
              });
            }
          }
        }
      };

      (window.electronAPI as any).on('whisper:progress', onWhisperProgress);
      (window.electronAPI as any).on('whisper:chunk', onWhisperChunk);

      const whisperModel = (op as any).model ?? 'large-v3';
      const result = await (window.electronAPI as any).invoke('whisper:transcribe', filePath, { model: whisperModel });
      (window.electronAPI as any).removeListener('whisper:progress', onWhisperProgress);
      (window.electronAPI as any).removeListener('whisper:chunk', onWhisperChunk);

      if (!result.success) throw new Error(result.error ?? 'Whisper failed');
      useVideoEditorStore.getState().updateMediaLibraryItem(mediaId, {
        cachedKaraokeSubtitles: {
          transcriptionResult: result.result,
          generatedAt: Date.now(),
        },
      });
      useEdithEditingStore.getState().setOpLabel('Transcription complete');
      break;
    }

    case 'analyzeReference': {
      const state = useVideoEditorStore.getState() as any;
      // Try media library first, then fall back to finding a reference item by name/path match
      let mediaItem = state.mediaLibrary?.find((m: any) => m.id === op.clipId);
      // Hard guard â€” never re-analyze a reference that already has data
      if (mediaItem?.referenceAnalysis?.captionStyle) {
        window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Reference already analyzed â€” skipping' } }));
        break;
      }
      if (!mediaItem) {
        // EDITH may have passed a timeline track ID â€” find the track and match to media library
        const track = state.tracks?.find((t: any) => t.id === op.clipId);
        if (track) {
          mediaItem = state.mediaLibrary?.find((m: any) =>
            m.source === track.source || m.tempFilePath === track.source
          );
        }
      }
      if (!mediaItem) {
        // Last resort: find any reference-category item
        mediaItem = state.mediaLibrary?.find((m: any) => m.category === 'reference');
      }
      if (!mediaItem) throw new Error(`analyzeReference: no reference video found. Make sure a reference is uploaded in the References panel.`);
      const filePath = (mediaItem as any).tempFilePath || (mediaItem as any).source;
      const mediaLibraryId = (mediaItem as any).id;
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Analyzing reference (frame sampling)â€¦' } }));
      const result = await (window.electronAPI as any).invoke('mycelium:analyzeReference', { filePath });
      if (!result.success) throw new Error(result.error ?? 'Reference analysis failed');
      useVideoEditorStore.getState().updateMediaLibraryItem(mediaLibraryId, { referenceAnalysis: result.analysis });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Reference analyzed' } }));
      break;
    }

    case 'geminiEdit': {
      if (GEMINI_DISABLED) {
        window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Gemini disabled (test mode) â€” skipping AI edit pass' } }));
        break;
      }
      const state = useVideoEditorStore.getState() as any;

      // Resolve user clip
      const userTrack = state.tracks?.find((t: any) => t.id === op.userClipId);
      if (!userTrack) throw new Error(`geminiEdit: clip ${op.userClipId} not found on timeline`);
      const userVideoPath = userTrack.source;
      if (!userVideoPath) throw new Error(`geminiEdit: clip ${op.userClipId} has no source path`);

      // Resolve reference
      let refItem = state.mediaLibrary?.find((m: any) => m.id === op.referenceId);
      if (!refItem) refItem = state.mediaLibrary?.find((m: any) => m.category === 'reference');
      if (!refItem) throw new Error(`geminiEdit: no reference video found`);
      const referenceVideoPath = (refItem as any).tempFilePath || (refItem as any).source;
      if (!referenceVideoPath) throw new Error(`geminiEdit: reference has no file path`);

      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Gemini is watching both videosâ€¦' } }));

      const result = await (window.electronAPI as any).invoke('mycelium:generateEdit', {
        userVideoPath,
        referenceVideoPath,
        userRequest: op.userRequest,
        targetDurationSeconds: op.targetDurationSeconds,
      });

      if (!result.success || !result.spec) throw new Error(result.error ?? 'Gemini edit failed');

      const spec = result.spec;
      const fps = state.fps ?? 30;

      // 1. Delete all other video tracks (keep only the one we're editing)
      const otherTracks = (state.tracks ?? []).filter((t: any) =>
        t.type === 'video' && t.id !== op.userClipId
      );
      for (const t of otherTracks) state.removeTrack(t.id);

      // 2. Trim the main clip to the Gemini-chosen segment
      const segStart = spec.segment.sourceStartSeconds ?? 0;
      const segEnd = spec.segment.sourceEndSeconds ?? (segStart + op.targetDurationSeconds);
      const durationFrames = Math.round((segEnd - segStart) * fps);
      state.resizeTrack(op.userClipId, 0, durationFrames);
      state.updateTrack(op.userClipId, { sourceStartTime: segStart, startFrame: 0, endFrame: durationFrames });

      // 3. Apply color grade
      if (spec.colorGrade) {
        const { brightness, contrast, saturation, hueRotate } = spec.colorGrade;
        const parts: string[] = [];
        if (brightness !== undefined) parts.push(`brightness(${brightness})`);
        if (contrast !== undefined) parts.push(`contrast(${contrast})`);
        if (saturation !== undefined) parts.push(`saturate(${saturation})`);
        if (hueRotate !== undefined && hueRotate !== 0) parts.push(`hue-rotate(${hueRotate}deg)`);
        if (parts.length) state.updateTrack(op.userClipId, { filter: parts.join(' ') });
      }

      // 4. Letterbox blur
      if (spec.letterboxBlur) {
        state.updateTrack(op.userClipId, { proxyBlockedMessage: 'letterbox-blur' });
      }

      // 5. Store caption style + edit spec on the reference media item so EDITH can read it on next turn
      const captionStyle = spec.captionStyle;
      useVideoEditorStore.getState().updateMediaLibraryItem(refItem.id, {
        referenceAnalysis: {
          ...(refItem.referenceAnalysis ?? {}),
          captionStyle,
          geminiEditDescription: spec.description,
          geminiSegment: spec.segment,
        },
      });

      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Gemini edit applied â€” ${spec.segment.reason ?? 'segment selected'}` } }));
      break;
    }

    case 'colorGrade': {
      const parts: string[] = [];
      if (op.brightness !== undefined) parts.push(`brightness(${op.brightness})`);
      if (op.contrast !== undefined) parts.push(`contrast(${op.contrast})`);
      if (op.saturation !== undefined) parts.push(`saturate(${op.saturation})`);
      if (op.hueRotate !== undefined) parts.push(`hue-rotate(${op.hueRotate}deg)`);
      if (op.blur !== undefined) parts.push(`blur(${op.blur}px)`);
      store.updateTrack(op.clipId, { filter: parts.length ? parts.join(' ') : undefined });
      break;
    }

    case 'saveStyle': {
      useCaptionStylesStore.getState().saveStyle(op.name, {
        fontFamily: op.style.fontFamily,
        fontSize: op.style.fontSize,
        fillColor: op.style.fillColor,
        highlightColor: op.style.highlightColor,
        isBold: op.style.isBold,
        isUppercase: op.style.isUppercase,
        position: op.style.position,
      });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Style saved: ${op.name}` } }));
      break;
    }

    case 'renderGraphic': {
      const fps = store.fps ?? 30;
      const canvasWidth = store.canvasWidth ?? 1080;
      const canvasHeight = store.canvasHeight ?? 1920;
      const width = op.width ?? canvasWidth;
      const height = op.height ?? canvasHeight;
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Rendering graphic with Hyperframesâ€¦' } }));
      const result = await (window.electronAPI as any).invoke('mycelium:renderGraphic', {
        html: op.html,
        durationSeconds: op.durationSeconds,
        width,
        height,
      });
      if (!result.success) {
        if (result.needsRevision) {
          // Design pre-check failed â€” send critique to FridayPanel so EDITH can revise
          window.dispatchEvent(new CustomEvent('edith:graphicRevision', {
            detail: { issues: result.issues ?? [], summary: result.summary ?? '' },
          }));
          return;
        }
        throw new Error(result.error ?? 'Hyperframes render failed');
      }
      const filePath: string = result.filePath;
      let previewUrl = filePath;
      try {
        const r = await window.electronAPI.createPreviewUrl(filePath);
        if (r && typeof r === 'object' && (r as any).url) previewUrl = (r as any).url;
        else if (typeof r === 'string') previewUrl = r;
      } catch { /* use raw path */ }
      const duration = Math.round(op.durationSeconds * fps);
      const endFrame = op.startFrame + duration;
      await store.addTrack({
        type: 'video',
        name: 'graphic.mp4',
        source: filePath,
        previewUrl,
        duration,
        startFrame: op.startFrame,
        endFrame,
        trackRowIndex: op.layer ?? 2,
        visible: true,
        locked: false,
        color: '#B06AFF',
      });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Graphic placed on timeline' } }));
      break;
    }

    case 'cursorMoveTo': {
      await cursorMoveTo(op.target, op.offsetX ?? 0, op.offsetY ?? 0);
      break;
    }

    case 'cursorClick': {
      await cursorDoClick();
      break;
    }

    case 'cursorStartDrag': {
      await cursorDoStartDrag(op.target, op.label);
      break;
    }

    case 'cursorDrop': {
      await cursorDoDrop(op.target);
      break;
    }

    case 'cursorHide': {
      cursorDoHide();
      break;
    }

    case 'highlightClipSegment': {
      useEdithCursorStore.getState().addHighlight({
        id: `${op.clipId}-${op.startFrac.toFixed(3)}`,
        clipId: op.clipId,
        startFrac: op.startFrac,
        endFrac: op.endFrac,
        label: op.label,
      });
      break;
    }

    case 'clearClipHighlight': {
      const { highlights, removeHighlight } = useEdithCursorStore.getState();
      highlights
        .filter((h) => h.clipId === op.clipId)
        .forEach((h) => removeHighlight(h.id));
      break;
    }

    case 'renameProject': {
      window.dispatchEvent(new CustomEvent('edith:renameProject', { detail: { title: op.title } }));
      break;
    }

    case 'snapshotVerify': {
      const fps = (store as any).fps ?? 30;
      const targetFrame = Math.round(op.atSeconds * fps);
      const mainClip = (store.tracks as any[])?.find(
        (t: any) => t.type === 'video' && (t.trackRowIndex ?? 0) === 0
      );
      const clipPath = mainClip?.source ?? null;
      console.log('[storeAdapter] snapshotVerify ▶ jumping playhead to', op.atSeconds, 's (frame', targetFrame, ') | reason:', op.reason, '| clipPath:', clipPath);
      store.setCurrentFrame(targetFrame);
      await sleep(250);
      console.log('[storeAdapter] snapshotVerify — calling app:verifySnapshot IPC');
      const result = await (window.electronAPI as any).invoke('app:verifySnapshot', {
        atSeconds: op.atSeconds,
        reason: op.reason,
        clipPath,
      });
      console.log('[storeAdapter] snapshotVerify ◀ result:', result);
      window.dispatchEvent(new CustomEvent('edith:snapshotTaken', {
        detail: {
          atSeconds: op.atSeconds,
          reason: op.reason,
          analysis: result?.analysis ?? null,
          error: result?.error ?? null,
          frameBase64: result?.frameBase64 ?? null,
        },
      }));
      break;
    }

    // ── V2 ops ─────────────────────────────────────────────────────────────────
    // EDITH V2 uses timestamp-based ops with no clipIds. These resolve internally.

    case 'deleteSegment': {
      // V2: {“type”:”deleteSegment”,”fromSeconds”:45.0,”toSeconds”:90.0}
      // Plays a 3-phase visual animation (playhead jump → red highlight → cut flash → gap close)
      // before applying the actual data mutation so the editor looks alive.
      const fps: number = store.fps ?? 30;
      const fromFrame = Math.round((op as any).fromSeconds * fps);
      const toFrame = Math.round((op as any).toSeconds * fps);

      // ── Phase 1: Smooth playhead jump to the cut start point ──────────────
      store.setCutAnimation({ fromFrame, toFrame, phase: 'highlighting' });
      store.setCurrentFrame(fromFrame);
      await sleep(900); // playhead slides + red highlight fades in

      // ── Phase 2: Pulse — visual confirmation before the cut ───────────────
      store.setCutAnimation({ fromFrame, toFrame, phase: 'pulse' });
      await sleep(650);

      // ── Phase 3: Flash white — the moment of the cut ─────────────────────
      store.setCutAnimation({ fromFrame, toFrame, phase: 'cutting' });
      store.setClipTransitions(true); // clips now have CSS transitions → gap-close slides
      await sleep(280);

      // ── Phase 4: Apply the actual data mutation ───────────────────────────
      // The clip transitions are already enabled so remaining clips will animate
      // to their new positions as the store updates their startFrame values.
      store.setCutAnimation({ fromFrame, toFrame, phase: 'closing' });

      // First cut — at the start of the unwanted section
      const clipAtFrom = findClipAtSeconds(store, (op as any).fromSeconds, 0);
      if (!clipAtFrom) {
        store.setCutAnimation(null);
        store.setClipTransitions(false);
        throw new Error(`deleteSegment: no clip at ${(op as any).fromSeconds}s`);
      }
      store.splitTrack(clipAtFrom.id, fromFrame);

      // Re-read store — splitTrack created a new clip. Find clip that now starts at fromFrame.
      const freshStore = useVideoEditorStore.getState() as any;
      const segmentClip = (freshStore.tracks as any[]).find(
        (t: any) => (t.trackRowIndex ?? 0) === 0 && t.type === 'video' && t.startFrame === fromFrame,
      );
      if (segmentClip) {
        // Second cut — at the end of the unwanted section
        if (segmentClip.endFrame > toFrame) {
          freshStore.splitTrack(segmentClip.id, toFrame);
        }
        // Remove the segment clip (the unwanted section)
        freshStore.removeTrack(segmentClip.id);
      }

      // Shift all subtitle and overlay tracks to close the gap.
      const gapFrames = toFrame - fromFrame;
      const postCutStore = useVideoEditorStore.getState() as any;
      const snapshot: any[] = [...(postCutStore.tracks as any[])];
      for (const track of snapshot) {
        const row: number = track.trackRowIndex ?? 0;
        const isSubtitle: boolean = track.type === 'subtitle';
        const isOverlay: boolean = row > 0 && (track.type === 'video' || track.type === 'audio' || track.type === 'image');
        if (!isSubtitle && !isOverlay) continue;
        if (track.type === 'audio' && track.isLinked) continue;

        const tStart: number = track.startFrame;
        const tEnd: number = track.endFrame;

        if (tEnd <= fromFrame) continue;

        if (tStart >= toFrame) {
          postCutStore.updateTrack(track.id, {
            startFrame: tStart - gapFrames,
            endFrame: tEnd - gapFrames,
          });
          if (track.isLinked && track.linkedTrackId) {
            const linked = (postCutStore.tracks as any[]).find((t: any) => t.id === track.linkedTrackId);
            if (linked) {
              postCutStore.updateTrack(track.linkedTrackId, {
                startFrame: linked.startFrame - gapFrames,
                endFrame: linked.endFrame - gapFrames,
              });
            }
          }
        } else {
          postCutStore.removeTrack(track.id);
        }
      }

      // Close the gap for layer-0 clips (right portion of main video + linked audio).
      // The overlay/subtitle loop above handles everything except these — they were explicitly
      // skipped because they were "handled above via splitTrack/removeTrack", but that only
      // removed the middle segment; the right portion still starts at toFrame, not fromFrame.
      const layer0Store = useVideoEditorStore.getState() as any;
      for (const clip of [...(layer0Store.tracks as any[])]) {
        if ((clip.trackRowIndex ?? 0) === 0 && clip.startFrame >= toFrame) {
          layer0Store.updateTrack(clip.id, {
            startFrame: clip.startFrame - gapFrames,
            endFrame: clip.endFrame - gapFrames,
          });
        }
      }

      // ── Phase 5: Let the gap-close slide animation play out ───────────────
      await sleep(500);

      // Cleanup
      store.setCutAnimation(null);
      store.setClipTransitions(false);
      break;
    }

    case 'restoreSegment': {
      // V2: {“type”:”restoreSegment”,”fromSeconds”:72,”toSeconds”:127}
      // Restores a previously-deleted source range back into the timeline.
      // Uses sourceStartTime on adjacent clips to locate the stitch point and measure the gap.
      const fps: number = store.fps ?? 30;
      const fromSec: number = (op as any).fromSeconds;
      const toSec: number = (op as any).toSeconds;
      const gapFrames = Math.round((toSec - fromSec) * fps);

      if (gapFrames <= 0) throw new Error(`restoreSegment: invalid range ${fromSec}→${toSec}`);

      // Find the layer-0 clips sorted by timeline position
      const layer0 = (store.tracks as any[])
        .filter((t: any) => (t.trackRowIndex ?? 0) === 0 && t.type === 'video')
        .sort((a: any, b: any) => a.startFrame - b.startFrame);

      // Locate the stitch point: left clip whose source end ≈ fromSec
      // sourceEnd = sourceStartTime + (endFrame - startFrame) / fps
      const TOLERANCE = 2; // 2-second tolerance for floating point drift
      const leftClip = layer0.find((t: any) => {
        const srcEnd = (t.sourceStartTime ?? 0) + (t.endFrame - t.startFrame) / fps;
        return Math.abs(srcEnd - fromSec) <= TOLERANCE;
      });
      if (!leftClip) throw new Error(`restoreSegment: no left clip ending near source ${fromSec}s`);

      // Right clip: starts immediately after left clip in the timeline
      const stitchFrame = leftClip.endFrame;
      const rightClip = layer0.find((t: any) => t.startFrame === stitchFrame);

      // ── Restore animation (right-to-left green sweep) ────────────────────────
      const restoreFromFrame = stitchFrame;
      const restoreToFrame = stitchFrame + gapFrames;
      store.setRestoreAnimation({ fromFrame: restoreFromFrame, toFrame: restoreToFrame, phase: 'highlighting' });
      store.setCurrentFrame(restoreToFrame);
      await sleep(900);
      store.setRestoreAnimation({ fromFrame: restoreFromFrame, toFrame: restoreToFrame, phase: 'pulse' });
      await sleep(650);
      store.setRestoreAnimation({ fromFrame: restoreFromFrame, toFrame: restoreToFrame, phase: 'restoring' });
      store.setRestoreTransitions(true);
      await sleep(280);
      store.setRestoreAnimation({ fromFrame: restoreFromFrame, toFrame: restoreToFrame, phase: 'closing' });

      // ── Shift all right-side clips to make room ───────────────────────────────
      const shiftStore = useVideoEditorStore.getState() as any;
      for (const clip of [...(shiftStore.tracks as any[])]) {
        if (clip.startFrame >= stitchFrame) {
          shiftStore.updateTrack(clip.id, {
            startFrame: clip.startFrame + gapFrames,
            endFrame: clip.endFrame + gapFrames,
          });
        }
      }

      // ── Insert the restored segment as a new layer-0 clip ────────────────────
      const srcFile = leftClip.source;
      let previewUrl: string = srcFile;
      try {
        const r = await window.electronAPI.createPreviewUrl(srcFile);
        if (r && typeof r === 'object' && (r as any).url) previewUrl = (r as any).url;
        else if (typeof r === 'string') previewUrl = r;
      } catch { /* fall through */ }

      await store.addTrack({
        type: 'video' as const,
        name: leftClip.name,
        source: srcFile,
        startFrame: stitchFrame,
        endFrame: stitchFrame + gapFrames,
        trackRowIndex: 0,
        sourceStartTime: fromSec,
        sourceDuration: leftClip.sourceDuration,
        muted: leftClip.muted ?? false,
        visible: true,
        locked: false,
        previewUrl,
        isLinked: false,
      });

      // Also restore linked audio if the right clip has a linked audio track
      if (rightClip?.linkedTrackId) {
        const linkedAudio = (shiftStore.tracks as any[]).find((t: any) => t.id === rightClip.linkedTrackId);
        if (linkedAudio) {
          await store.addTrack({
            type: 'audio' as const,
            name: linkedAudio.name,
            source: srcFile,
            startFrame: stitchFrame,
            endFrame: stitchFrame + gapFrames,
            trackRowIndex: 0,
            sourceStartTime: fromSec,
            sourceDuration: linkedAudio.sourceDuration,
            muted: false,
            visible: true,
            locked: false,
            isLinked: true,
          });
        }
      }

      await sleep(500);
      store.setRestoreAnimation(null);
      store.setRestoreTransitions(false);
      break;
    }

    case 'trim': {
      // V2: {“type”:”trim”,”keepFrom”:10.0,”keepTo”:120.0}
      const fps: number = store.fps ?? 30;
      const mainClip = findMainVideoTrack(store);
      if (!mainClip) throw new Error('trim: no main video on timeline');

      const newFromFrame = Math.round((op as any).keepFrom * fps);
      const newToFrame = Math.round((op as any).keepTo * fps);
      const isExpanding = newFromFrame < mainClip.startFrame || newToFrame > mainClip.endFrame;

      if (isExpanding) {
        // ── Phase 1: Playhead jumps to right edge, green overlay sweeps right→left ──
        store.setRestoreAnimation({ fromFrame: newFromFrame, toFrame: newToFrame, phase: 'highlighting' });
        store.setCurrentFrame(newToFrame);
        await sleep(900);

        // ── Phase 2: Pulse ────────────────────────────────────────────────────────
        store.setRestoreAnimation({ fromFrame: newFromFrame, toFrame: newToFrame, phase: 'pulse' });
        await sleep(650);

        // ── Phase 3: Green flash — moment of restore ──────────────────────────────
        store.setRestoreAnimation({ fromFrame: newFromFrame, toFrame: newToFrame, phase: 'restoring' });
        store.setRestoreTransitions(true);
        await sleep(280);

        // ── Phase 4: Apply mutation + slide clip open ─────────────────────────────
        store.setRestoreAnimation({ fromFrame: newFromFrame, toFrame: newToFrame, phase: 'closing' });
        store.resizeTrack(mainClip.id, newFromFrame, newToFrame);

        await sleep(500);
        store.setRestoreAnimation(null);
        store.setRestoreTransitions(false);
      } else {
        store.resizeTrack(mainClip.id, newFromFrame, newToFrame);
      }
      break;
    }

    case 'deleteBroll': {
      // V2: {“type”:”deleteBroll”,”atSeconds”:45.0}
      const fps: number = store.fps ?? 30;
      const frame = Math.round((op as any).atSeconds * fps);
      // Find any non-layer-0 clip that contains this timestamp
      const brollClip = (store.tracks as any[])?.find(
        (t: any) => (t.trackRowIndex ?? 0) > 0 && t.startFrame <= frame && frame <= t.endFrame,
      );
      if (brollClip) store.removeTrack(brollClip.id);
      else throw new Error(`deleteBroll: no b-roll clip found at ${(op as any).atSeconds}s`);
      break;
    }

    case 'broll': {
      // V2: {“type”:”broll”,”src”:”/path”,”from”:15.0,”to”:19.0}
      const fps: number = store.fps ?? 30;
      const startFrame = Math.round((op as any).from * fps);
      const endFrame = Math.round((op as any).to * fps);
      const duration = endFrame - startFrame;
      let previewUrl = (op as any).src;
      try {
        const r = await window.electronAPI.createPreviewUrl((op as any).src);
        if (r && typeof r === 'object' && (r as any).url) previewUrl = (r as any).url;
        else if (typeof r === 'string') previewUrl = r;
      } catch { /* fall through */ }
      const canvasW: number = (store as any).preview?.canvasWidth ?? 1080;
      const canvasH: number = (store as any).preview?.canvasHeight ?? 1920;
      await store.addTrack({
        type: 'video',
        name: (op as any).src.split(/[/\\]/).pop() ?? 'B-Roll',
        source: (op as any).src,
        previewUrl,
        duration,
        startFrame,
        endFrame,
        muted: true,
        visible: true,
        locked: false,
        color: '#27AE60',
        trackRowIndex: 1,
        ...computeBrollOverlayProps(store, canvasW, canvasH),
      });
      break;
    }

    case 'download': {
      // V2: {“type”:”download”,”query”:”...”,”verify”:”...”,”isStockFootage”:true|false}
      // isStockFootage:true  → Pixabay API search (no cookies, watermark-free)
      // isStockFootage:false → YouTube search via ytsearch: (uses browser cookies automatically)
      const isStock = (op as any).isStockFootage !== false;
      const urlToUse = isStock
        ? `pixabaysearch:${(op as any).query}`
        : `ytsearch1:${(op as any).query}`;
      await applyOp({
        type: 'downloadMedia',
        url: urlToUse,
        topic: (op as any).query,
        verify: (op as any).verify,
        isStockFootage: isStock,
      } as any);
      break;
    }

    case 'silence': {
      // V2: {“type”:”silence”} — cut silence from main video
      const mainClip = findMainVideoTrack(store);
      if (!mainClip) throw new Error('silence: no main video on timeline');
      await applyOp({ type: 'cutSilence', clipId: mainClip.id } as any);
      break;
    }

    case 'transcribe': {
      // V2: {“type”:”transcribe”,”streamCaptions”:true}
      const mainClip = findMainVideoTrack(store);
      if (!mainClip) throw new Error('transcribe: no main video on timeline');

      // Guard: block if already transcribing
      if ((useVideoEditorStore.getState() as any).isTranscribing) {
        console.warn('[storeAdapter] transcribe op skipped — transcription already in progress');
        window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Transcription already in progress…' } }));
        break;
      }

      // Guard: block if transcript already exists for this clip
      const existingMedia = (useVideoEditorStore.getState() as any).mediaLibrary?.find(
        (m: any) => m.source === mainClip.source || m.tempFilePath === mainClip.source,
      );
      const hasTranscription =
        existingMedia?.cachedKaraokeSubtitles?.transcriptionResult?.segments?.length > 0;
      if (hasTranscription) {
        console.warn('[storeAdapter] transcribe op skipped — transcription already exists');
        window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Already transcribed — skipping.' } }));
        break;
      }

      await applyOp({ type: 'runWhisper', clipId: mainClip.id, streamCaptions: (op as any).streamCaptions ?? false, model: 'large-v3' } as any);
      break;
    }

    case 'caption': {
      // V2: {“type”:”caption”,”text”:”EXACT WORDS”,”from”:5.0,”to”:7.2}
      await applyOp({ type: 'addCaption', text: (op as any).text, startSeconds: (op as any).from, endSeconds: (op as any).to, style: (op as any).style } as any);
      break;
    }

    case 'deleteCaption': {
      // V2: {“type”:”deleteCaption”,”atSeconds”:45.0}
      // Removes ALL subtitle clips active at the given timestamp (clears stacked duplicates too)
      const fps: number = store.fps ?? 30;
      const atFrame = Math.round((op as any).atSeconds * fps);
      const toDelete = (store.tracks as any[]).filter(
        (t: any) => t.type === 'subtitle' && t.startFrame <= atFrame && t.endFrame > atFrame,
      );
      for (const t of toDelete) store.removeTrack(t.id);
      break;
    }

    case 'clearCaptions': {
      // V2: {“type”:”clearCaptions”}
      // Removes ALL subtitle clips — use before re-placing corrected captions
      const allSubtitleIds = (store.tracks as any[])
        .filter((t: any) => t.type === 'subtitle')
        .map((t: any) => t.id);
      for (const id of allSubtitleIds) store.removeTrack(id);
      break;
    }

    case 'buildCaptions': {
      // V2: {“type”:”buildCaptions”,”src”:”/path/to/footage.mp4”}
      // Creates ONE continuous subtitle track from the stored Whisper transcript.
      // Timestamps are automatically remapped through any cuts using the layer-0 clip map.
      const fps: number = store.fps ?? 30;
      const srcPath: string = (op as any).src;

      // Find the media item
      const mediaLib: any[] = (store as any).mediaLibrary ?? [];
      const srcBasename = srcPath.split(/[/\\]/).pop() ?? '';
      const mediaItem = mediaLib.find((m: any) =>
        m.source === srcPath ||
        m.tempFilePath === srcPath ||
        (m.source ?? '').split(/[/\\]/).pop() === srcBasename ||
        m.name === srcBasename,
      );
      if (!mediaItem) throw new Error(`buildCaptions: media “${srcBasename}” not found in library`);

      const transcriptSegs: any[] = mediaItem.cachedKaraokeSubtitles?.transcriptionResult?.segments ?? [];
      if (!transcriptSegs.length) throw new Error(`buildCaptions: no transcription for “${srcBasename}” — run transcribe first`);

      // Source → timeline timestamp mapper (accounts for any deleteSegment cuts)
      const layer0 = (store.tracks as any[])
        .filter((t: any) => (t.trackRowIndex ?? 0) === 0 && t.type === 'video')
        .sort((a: any, b: any) => a.startFrame - b.startFrame);

      const srcToTimeline = (s: number): number | null => {
        // If no cuts, treat as identity mapping
        if (!layer0.length) return s;
        for (const clip of layer0) {
          const clipSrcStart: number = clip.sourceStartTime ?? 0;
          const clipSrcEnd: number = clipSrcStart + (clip.endFrame - clip.startFrame) / fps;
          if (s >= clipSrcStart && s < clipSrcEnd) {
            return clip.startFrame / fps + (s - clipSrcStart);
          }
        }
        return null; // was in a cut range
      };

      // Step 1: Flatten all words from every Whisper segment into a single list.
      // If a segment has word-level timestamps, use them directly.
      // Otherwise divide the segment duration evenly across its words.
      interface _WordEntry { word: string; start: number; end: number; }
      const allWords: _WordEntry[] = [];
      for (const seg of transcriptSegs) {
        const segWords: any[] = seg.words ?? [];
        if (segWords.length > 0) {
          for (const w of segWords) {
            const wText = (w.word ?? '').trim();
            if (wText) allWords.push({ word: wText, start: w.start, end: w.end });
          }
        } else {
          const wordList = (seg.text ?? '').trim().split(/\s+/).filter(Boolean);
          if (!wordList.length) continue;
          const wordDur = (seg.end - seg.start) / wordList.length;
          for (let wi = 0; wi < wordList.length; wi++) {
            allWords.push({
              word: wordList[wi],
              start: seg.start + wi * wordDur,
              end: seg.start + (wi + 1) * wordDur,
            });
          }
        }
      }

      // Step 2: Group words into phrases of up to 4 words.
      // Break earlier on sentence-ending punctuation so captions align with natural speech rhythm.
      const PHRASE_MAX = 4;
      const wordPhrases: _WordEntry[][] = [];
      let currentPhrase: _WordEntry[] = [];
      for (const w of allWords) {
        currentPhrase.push(w);
        const isSentenceEnd = /[.,!?;:]$/.test(w.word);
        if (currentPhrase.length >= PHRASE_MAX || isSentenceEnd) {
          wordPhrases.push(currentPhrase);
          currentPhrase = [];
        }
      }
      if (currentPhrase.length) wordPhrases.push(currentPhrase);

      // Step 3: Build subtitle segments — one per word, but carrying the FULL phrase text.
      // highlightWordIndex points to the active word. The renderer (renderCaptionWords) splits
      // by spaces and colors word[i] yellow while all others stay white — karaoke tracking.
      const subtitleSegments: Array<{ text: string; startFrame: number; endFrame: number; highlightWordIndex: number }> = [];

      for (const phrase of wordPhrases) {
        const phraseText = phrase.map((w) => w.word.toUpperCase()).join(' ');
        for (let i = 0; i < phrase.length; i++) {
          const w = phrase[i];
          const tStart = srcToTimeline(w.start);
          if (tStart === null) continue;
          // End this word's segment at the NEXT word's start (no flicker gap within phrase),
          // or at the word's own end if it's the last in the phrase.
          const wEndSrc = i < phrase.length - 1 ? phrase[i + 1].start : w.end;
          const tEnd = srcToTimeline(wEndSrc) ?? (tStart + Math.max(0.05, wEndSrc - w.start));
          subtitleSegments.push({
            text: phraseText,
            startFrame: Math.round(tStart * fps),
            endFrame: Math.max(Math.round(tStart * fps) + 1, Math.round(tEnd * fps)),
            highlightWordIndex: i,
          });
        }
      }

      if (!subtitleSegments.length) throw new Error('buildCaptions: no segments after cut mapping — verify the transcription exists');

      // Clear any existing subtitle tracks before placing the new one
      const existingSubs = (store.tracks as any[]).filter((t: any) => t.type === 'subtitle');
      for (const sub of existingSubs) store.removeTrack(sub.id);

      // Create one continuous subtitle track spanning from first word to last word
      const firstFrame = subtitleSegments[0].startFrame;
      const lastFrame = subtitleSegments[subtitleSegments.length - 1].endFrame;

      await store.addTrack({
        type: 'subtitle',
        name: 'Captions',
        source: '',
        subtitleText: '',
        subtitleType: 'karaoke',
        duration: lastFrame - firstFrame,
        startFrame: firstFrame,
        endFrame: lastFrame,
        visible: true,
        locked: false,
        color: '#F5A623',
        trackRowIndex: 1,
        subtitleStyle: {
          fontFamily: 'Impact',
          fontSize: 55,
          fillColor: '#FFFFFF',
          isBold: false,
          textTransform: 'uppercase',
          highlightColor: '#FFD700',
          highlightWordIndex: 0,
        },
        subtitleTransform: { x: 0, y: 0.3 },
        subtitleSegments,
      } as any);
      break;
    }

    case 'grade': {
      // V2: {“type”:”grade”,”brightness”:1.05,”contrast”:1.15,”saturation”:1.2}
      const mainClip = findMainVideoTrack(store);
      if (!mainClip) throw new Error('grade: no main video on timeline');
      const parts: string[] = [];
      if ((op as any).brightness !== undefined) parts.push(`brightness(${(op as any).brightness})`);
      if ((op as any).contrast !== undefined) parts.push(`contrast(${(op as any).contrast})`);
      if ((op as any).saturation !== undefined) parts.push(`saturate(${(op as any).saturation})`);
      store.updateTrack(mainClip.id, { filter: parts.length ? parts.join(' ') : undefined });
      break;
    }

    case 'resize': {
      // V2: {“type”:”resize”,”ratio”:”9:16”}
      const { canvasWidth, canvasHeight } = store.preview;
      const { width, height } = calculateDimensionsForRatio((op as any).ratio, canvasWidth ?? 1080, canvasHeight ?? 1920);
      store.setCanvasSize(width, height);
      break;
    }

    case 'letterbox': {
      // V2: {“type”:”letterbox”,”enabled”:true}
      const mainClip = findMainVideoTrack(store);
      if (!mainClip) throw new Error('letterbox: no main video on timeline');
      store.updateTrack(mainClip.id, { proxyBlockedMessage: (op as any).enabled ? 'letterbox-blur' : undefined });
      break;
    }

    case 'volume': {
      // V2: {“type”:”volume”,”clipName”:”footage.mp4”,”db”:-6}
      const clip = findClipByName(store, (op as any).clipName);
      if (!clip) throw new Error(`volume: clip “${(op as any).clipName}” not found`);
      store.updateTrackAudio(clip.id, { volumeDb: (op as any).db });
      break;
    }

    case 'mute': {
      // V2: {“type”:”mute”,”clipName”:”footage.mp4”,”muted”:true}
      const clip = findClipByName(store, (op as any).clipName);
      if (!clip) throw new Error(`mute: clip “${(op as any).clipName}” not found`);
      store.updateTrack(clip.id, { muted: (op as any).muted });
      break;
    }

    case 'duck': {
      // {“type”:”duck”,”musicClipName”:”music.mp3”,”targetDb”:-18,”fadeDuration”:0.3}
      const musicClip = findClipByName(store, (op as any).musicClipName);
      if (!musicClip) throw new Error(`duck: clip “${(op as any).musicClipName}” not found`);

      const fps: number = store.fps ?? 30;
      const mediaLib: any[] = (store as any).mediaLibrary ?? [];

      // Find the voice waveform: prefer linked audio from main video, fall back to any audio
      const mainVideoTrack = findMainVideoTrack(store);
      const voiceTrack = (store.tracks as any[])?.find(
        (t: any) => t.type === 'audio' && t.linkedTrackId === mainVideoTrack?.id,
      );
      const voiceMediaId = voiceTrack?.mediaId ?? mainVideoTrack?.mediaId;
      const voiceMedia = mediaLib.find((m: any) => m.id === voiceMediaId)
        ?? mediaLib.find((m: any) => m.type === 'video' && m.waveform?.peaks?.length);

      const peaks: number[] = voiceMedia?.waveform?.peaks ?? [];
      const voiceDurationSec = voiceMedia?.waveform?.duration
        ?? (voiceTrack ? (voiceTrack.endFrame - voiceTrack.startFrame) / fps : 0)
        ?? (mainVideoTrack ? (mainVideoTrack.endFrame - mainVideoTrack.startFrame) / fps : 0);

      // Derive speech intervals from amplitude peaks (threshold = 5% of max)
      const speechIntervals: { start: number; end: number }[] = [];

      if (peaks.length > 0 && voiceDurationSec > 0) {
        const maxPeak = Math.max(...peaks);
        const threshold = maxPeak * 0.05; // 5% of max amplitude = speech
        const secPerPeak = voiceDurationSec / peaks.length;
        const minSilenceGap = 0.4; // merge speech regions within 0.4s of each other

        let inSpeech = false;
        let speechStart = 0;

        for (let i = 0; i < peaks.length; i++) {
          const isSpeech = peaks[i] > threshold;
          const t = i * secPerPeak;
          if (isSpeech && !inSpeech) { speechStart = t; inSpeech = true; }
          else if (!isSpeech && inSpeech) { speechIntervals.push({ start: speechStart, end: t }); inSpeech = false; }
        }
        if (inSpeech) speechIntervals.push({ start: speechStart, end: voiceDurationSec });

        // Merge intervals closer than minSilenceGap
        const merged: { start: number; end: number }[] = [];
        for (const iv of speechIntervals) {
          const last = merged[merged.length - 1];
          if (last && iv.start - last.end < minSilenceGap) last.end = iv.end;
          else merged.push({ ...iv });
        }
        speechIntervals.length = 0;
        speechIntervals.push(...merged);
        console.log(`[duck] Derived ${speechIntervals.length} speech intervals from ${peaks.length} waveform peaks`);
      } else {
        // No waveform data — duck across the full video duration
        const end = voiceDurationSec || (mainVideoTrack ? (mainVideoTrack.endFrame - mainVideoTrack.startFrame) / fps : 0);
        if (end > 0) speechIntervals.push({ start: 0, end });
        console.log(`[duck] No waveform data — ducking full clip (0–${speechIntervals[0]?.end?.toFixed(1)}s)`);
      }

      store.updateTrack(musicClip.id, {
        duckingEnabled: true,
        duckingTargetDb: (op as any).targetDb ?? -18,
        duckingFadeDuration: (op as any).fadeDuration ?? 0.3,
        duckingSpeechIntervals: speechIntervals,
      });
      break;
    }

    case 'unduck': {
      // {“type”:”unduck”,”musicClipName”:”music.mp3”}
      const duckClip = findClipByName(store, (op as any).musicClipName);
      if (!duckClip) throw new Error(`unduck: clip “${(op as any).musicClipName}” not found`);
      store.updateTrack(duckClip.id, { duckingEnabled: false });
      break;
    }

    case 'setSpeed': {
      // {“type”:”setSpeed”,”clipId”:”abc123”,”speed”:0.5}
      // {“type”:”setSpeed”,”clipId”:”abc123”,”speed”:0.25,”startSeconds”:3.0,”endSeconds”:6.0}
      const speedClip = store.tracks.find((t: any) => t.id === op.clipId);
      if (!speedClip) throw new Error(`setSpeed: clip ${op.clipId} not found`);
      if (!speedClip.source) throw new Error(`setSpeed: clip ${op.clipId} has no source file`);

      const speedLabel = op.speed < 1 ? `${Math.round(op.speed * 100)}% speed` : `${op.speed}x speed`;
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Applying ${speedLabel}...` } }));

      const result = await (window.electronAPI as any).invoke('media:setSpeed', {
        filePath: speedClip.source,
        speed: op.speed,
        startSeconds: op.startSeconds,
        endSeconds: op.endSeconds,
      });

      if (!result.success || !result.filePath) {
        throw new Error(result.error ?? 'Speed change failed');
      }

      let newPreviewUrl = result.filePath;
      try {
        const previewResult = await window.electronAPI.createPreviewUrl(result.filePath);
        if (previewResult && typeof previewResult === 'object' && (previewResult as any).url) {
          newPreviewUrl = (previewResult as any).url;
        } else if (typeof previewResult === 'string') {
          newPreviewUrl = previewResult;
        }
      } catch { /* fall through */ }

      const fps: number = (store as any).fps ?? 30;
      const newName = result.filePath.replace(/\\/g, '/').split('/').pop() ?? speedClip.name;

      // Recalculate endFrame based on new duration
      const updates: Record<string, unknown> = {
        source: result.filePath,
        previewUrl: newPreviewUrl,
        name: newName,
      };
      if (result.duration && result.duration > 0) {
        updates.endFrame = speedClip.startFrame + Math.round(result.duration * fps);
      }

      store.updateTrack(op.clipId, updates);
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `${speedLabel} applied` } }));
      break;
    }

    case 'zoomToFace': {
      // {"type":"zoomToFace","clipId":"abc123","startSeconds":2.0,"endSeconds":6.0,"zoomLevel":1.5}
      const zoomClip = store.tracks.find((t: any) => t.id === op.clipId);
      if (!zoomClip) throw new Error(`zoomToFace: clip ${op.clipId} not found`);
      if (!zoomClip.source) throw new Error(`zoomToFace: clip ${op.clipId} has no source file`);

      const zoomTarget = op.target ?? 'face';
      const statusLabel = zoomTarget === 'face' ? 'face' : `"${zoomTarget}"`;
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Tracking ${statusLabel} and applying zoom...` } }));

      // Adjust for sourceStartTime: op.startSeconds is timeline-relative (0 = clip start),
      // but facezoom.py needs absolute seconds in the source file.
      const zoomSourceOffset = zoomClip.sourceStartTime ?? 0;
      const result = await (window.electronAPI as any).invoke('media:faceZoom', {
        filePath: zoomClip.source,
        startSeconds: op.startSeconds + zoomSourceOffset,
        endSeconds: op.endSeconds + zoomSourceOffset,
        zoomLevel: op.zoomLevel ?? 2.5,
        easeSeconds: op.easeSeconds ?? 0.4,
        target: zoomTarget,
      });

      if (!result.success || !result.filePath) {
        throw new Error(result.error ?? 'Zoom failed');
      }

      let newPreviewUrl = result.filePath;
      try {
        const previewResult = await window.electronAPI.createPreviewUrl(result.filePath);
        if (previewResult && typeof previewResult === 'object' && (previewResult as any).url) {
          newPreviewUrl = (previewResult as any).url;
        } else if (typeof previewResult === 'string') {
          newPreviewUrl = previewResult;
        }
      } catch { /* fall through */ }

      const newName = result.filePath.replace(/\\/g, '/').split('/').pop() ?? zoomClip.name;
      store.updateTrack(op.clipId, { source: result.filePath, previewUrl: newPreviewUrl, name: newName });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Zoom on ${statusLabel} applied` } }));
      break;
    }

    case 'analyzeMotion': {
      // {“type”:”analyzeMotion”,”clipId”:”abc123”,”detect”:”punch,jump,energy,speaker”}
      // clipId may be a track ID OR a media library ID — try both
      let motionClip = store.tracks.find((t: any) => t.id === op.clipId);
      if (!motionClip) {
        // Try matching by name (EDITH sometimes uses descriptive IDs)
        motionClip = store.tracks.find((t: any) =>
          t.name?.toLowerCase().includes(op.clipId?.toLowerCase()) ||
          op.clipId?.toLowerCase().includes(t.name?.toLowerCase())
        );
      }
      if (!motionClip) {
        // Fall back to first video track on the timeline
        motionClip = store.tracks.find((t: any) => t.type === 'video' || t.trackType === 'video');
      }
      if (!motionClip) throw new Error(`analyzeMotion: no video track found (clipId=”${op.clipId}”)`);

      // Resolve file path — try source first, then proxy via media library
      let motionFilePath: string = motionClip.source ?? '';
      const pathExists = motionFilePath
        ? await (window.electronAPI as any).invoke('media-path-exists', motionFilePath).catch(() => false)
        : false;

      if (!pathExists) {
        // Try to get path from media library
        const libItem = (store as any).mediaLibrary?.find(
          (m: any) => m.id === motionClip.mediaLibraryId || m.id === op.clipId || m.name === motionClip.name
        );
        if (libItem?.path) motionFilePath = libItem.path;
      }

      if (!motionFilePath) throw new Error(`analyzeMotion: could not resolve file path for clip “${motionClip.name ?? op.clipId}”`);

      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Analyzing motion in clip...' } }));

      const motionResult = await (window.electronAPI as any).invoke('media:analyzeMotion', {
        filePath: motionFilePath,
        detect: op.detect ?? 'punch,jump,energy,speaker',
        sampleEvery: 3,
      });

      if (!motionResult.success) throw new Error(motionResult.error ?? 'Motion analysis failed');

      // Store motion data and landmark positions on the track
      store.updateTrack(motionClip.id, {
        motionData: {
          events: motionResult.events ?? [],
          energyTimeline: motionResult.energyTimeline ?? [],
          speakerTrack: motionResult.speakerTrack ?? [],
          fps: motionResult.fps,
          totalFrames: motionResult.totalFrames,
          analyzedAt: Date.now(),
        },
        poseLandmarks: motionResult.poseLandmarks ?? [],
      } as any);

      const eventSummary = (motionResult.events ?? [])
        .map((e: any) => e.type)
        .reduce((acc: Record<string, number>, t: string) => { acc[t] = (acc[t] ?? 0) + 1; return acc; }, {});
      const summaryStr = Object.entries(eventSummary).map(([k, v]) => `${v} ${k}`).join(', ') || 'no events';

      // autoIsolate: cut the clip down to only the detected event windows
      if ((op as any).autoIsolate && (motionResult.events ?? []).length > 0) {
        const analysisFps: number = motionResult.fps ?? 30;
        const sourceDuration: number = motionResult.totalFrames / analysisFps;
        const windowSec: number = (op as any).windowSeconds ?? 1.5;

        // Build one window around each frame-based event
        const rawWindows = (motionResult.events as any[])
          .filter((e) => e.frame !== undefined)
          .map((e) => ({
            inSec: Math.max(0, e.frame / analysisFps - windowSec),
            outSec: Math.min(sourceDuration, e.frame / analysisFps + windowSec),
          }));

        // Also include startFrame/endFrame events (jumps, high_energy)
        for (const e of (motionResult.events as any[])) {
          if (e.startFrame !== undefined && e.endFrame !== undefined) {
            rawWindows.push({
              inSec: Math.max(0, e.startFrame / analysisFps - 0.5),
              outSec: Math.min(sourceDuration, e.endFrame / analysisFps + 0.5),
            });
          }
        }

        // Merge overlapping windows
        const sorted = rawWindows.sort((a, b) => a.inSec - b.inSec);
        const merged: { inSec: number; outSec: number }[] = [];
        for (const w of sorted) {
          if (merged.length && w.inSec <= merged[merged.length - 1].outSec) {
            merged[merged.length - 1].outSec = Math.max(merged[merged.length - 1].outSec, w.outSec);
          } else {
            merged.push({ ...w });
          }
        }

        if (merged.length > 0) {
          window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Cutting to ${merged.length} moment(s)...` } }));

          const timelineFps: number = (store as any).fps ?? (store as any).timeline?.fps ?? 30;
          const clipRow: number = motionClip.trackRowIndex ?? 0;
          const sourceStartTime: number = motionClip.sourceStartTime ?? 0;

          // Pre-fetch preview URL once
          let previewUrl: string = motionFilePath;
          try {
            const r = await window.electronAPI.createPreviewUrl(motionFilePath);
            previewUrl = typeof r === 'string' ? r : ((r as any).url ?? motionFilePath);
          } catch { /* fall through */ }

          // Read landmarks from motionResult directly — motionClip is a stale
          // snapshot and won't reflect the updateTrack call above.
          const capturedLandmarks = motionResult.poseLandmarks ?? [];

          // Remove original BEFORE adding new clips so addTrack's auto-placement
          // doesn't see the original clip and push new clips to after it.
          store.removeTrack(motionClip.id);

          let timelineCursor: number = 0;

          for (const seg of merged) {
            const fileInSec = sourceStartTime + seg.inSec;
            const fileOutSec = sourceStartTime + seg.outSec;
            const segFrames = Math.max(1, Math.round((fileOutSec - fileInSec) * timelineFps));
            await store.addTrack({
              type: 'video',
              name: motionClip.name,
              source: motionFilePath,
              previewUrl,
              duration: segFrames,
              startFrame: timelineCursor,
              endFrame: timelineCursor + segFrames,
              sourceStartTime: fileInSec,
              trackRowIndex: clipRow,
              visible: true,
              locked: false,
              color: motionClip.color ?? '#4A90D9',
              poseLandmarks: capturedLandmarks,
            } as any);
            timelineCursor += segFrames;
          }

          const totalSec = Math.round(merged.reduce((s, w) => s + (w.outSec - w.inSec), 0));
          window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Isolated ${merged.length} moment(s) — ${totalSec}s total` } }));
          break;
        }
      }

      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Motion analyzed: ${summaryStr}` } }));
      break;
    }

    case 'placeSFX': {
      // {“type”:”placeSFX”,”file”:”ES_User Interface, Click, Button Click...mp3”,”atTime”:12.5,”volume”:-3,”trackName”:”sfx_1”}
      const sfxFileName: string = (op as any).file;
      const atTimeSec: number = (op as any).atTime ?? 0;
      const volumeDb: number = (op as any).volume ?? -3;

      // Look up file in cached library (by name match)
      const entry = _sfxLibrary.find(
        (e) => e.name === sfxFileName || e.path === sfxFileName || e.name.includes(sfxFileName),
      );
      if (!entry) throw new Error(`placeSFX: “${sfxFileName}” not found in SFX library`);

      const fps: number = (store as any).fps ?? (store as any).timeline?.fps ?? 30;
      const atFrame = Math.round(atTimeSec * fps);
      const audioStart = (entry as any).audioStartSec ?? 0;
      const audioEnd = (entry as any).audioEndSec ?? entry.durationSec;
      const trimmedDuration = Math.max(0.05, audioEnd - audioStart);
      const durationFrames = Math.max(1, Math.round(trimmedDuration * fps));
      const previewUrl = `http://localhost:3001/${encodeURIComponent(entry.path)}`;
      const trackName = (op as any).trackName ?? sfxFileName.replace(/ - Epidemic Sound\.(mp3|wav)$/i, '');

      // Check if this SFX is already in the media library (avoid duplicates)
      const existingMediaItem = (store as any).mediaLibrary?.find(
        (m: any) => m.source === entry.path,
      );

      let mediaId: string;
      if (existingMediaItem) {
        mediaId = existingMediaItem.id;
      } else {
        // Import into media library so it appears in the Sources panel
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? 'mp3';
        const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
        mediaId = store.addToMediaLibrary({
          name: trackName,
          type: 'audio',
          source: entry.path,
          previewUrl,
          duration: entry.durationSec,
          size: (entry as any).size ?? 0,
          mimeType,
          spriteSheetDisabled: true,
        });
        // Trigger waveform generation so the audiogram shows up
        store.generateWaveformForMedia(mediaId).catch(() => {});
      }

      await store.addTrack({
        type: 'audio' as const,
        name: trackName,
        source: entry.path,
        previewUrl,
        mediaId,
        startFrame: atFrame,
        endFrame: atFrame + durationFrames,
        trackRowIndex: 1,
        layer: 1,
        volumeDb,
        muted: false,
        visible: true,
        sourceStartTime: audioStart,
      });
      break;
    }

    case 'scanVideo': {
      // {“type”:”scanVideo”,”clipName”:”footage.mp4”,”description”:”person typing on keyboard”}
      const targetClip = findClipByName(store, (op as any).clipName)
        ?? findMainVideoTrack(store);
      if (!targetClip?.source) throw new Error(`scanVideo: clip “${(op as any).clipName}” not found`);

      const result = await (window.electronAPI as any).invoke('app:scanVideoFrames', {
        clipPath: targetClip.source,
        description: (op as any).description,
        intervalSec: (op as any).intervalSec ?? 2,
        maxFrames: (op as any).maxFrames ?? 15,
        findAll: (op as any).findAll ?? false,
      });

      const foundSec: number | null = result?.foundAtSec ?? null;
      const frameBase64: string | null = result?.frameBase64 ?? null;
      const allMatchesSec: number[] | null = result?.allMatchesSec ?? null;
      const desc: string = (op as any).description;

      window.dispatchEvent(new CustomEvent('edith:scanVideoResult', {
        detail: { description: desc, foundAtSec: foundSec, frameBase64, allMatchesSec, clipName: (op as any).clipName },
      }));
      break;
    }

    case 'fadeIn': {
      // V2: {“type”:”fadeIn”,”clipName”:”footage.mp4”,”duration”:3.0}
      const clip = findClipByName(store, (op as any).clipName);
      if (!clip) throw new Error(`fadeIn: clip “${(op as any).clipName}” not found`);
      const duration = Math.min((op as any).duration ?? 3.0, 3.0);
      store.updateTrack(clip.id, { fadeInDuration: duration });
      break;
    }

    case 'fadeOut': {
      // V2: {“type”:”fadeOut”,”clipName”:”footage.mp4”,”duration”:3.0}
      const clip = findClipByName(store, (op as any).clipName);
      if (!clip) throw new Error(`fadeOut: clip “${(op as any).clipName}” not found`);
      const duration = Math.min((op as any).duration ?? 3.0, 3.0);
      store.updateTrack(clip.id, { fadeOutDuration: duration });
      break;
    }

    case 'snapshot': {
      // V2: {“type”:”snapshot”,”atSeconds”:30.5,”reason”:”...”}
      const fps: number = (store as any).fps ?? 30;
      const targetFrame = Math.round((op as any).atSeconds * fps);
      const mainClip = findMainVideoTrack(store);
      store.setCurrentFrame(targetFrame);
      await sleep(250);
      const snapResult = await (window.electronAPI as any).invoke('app:verifySnapshot', {
        atSeconds: (op as any).atSeconds,
        reason: (op as any).reason,
        clipPath: mainClip?.source ?? null,
      });
      window.dispatchEvent(new CustomEvent('edith:snapshotTaken', {
        detail: {
          atSeconds: (op as any).atSeconds,
          reason: (op as any).reason,
          analysis: snapResult?.analysis ?? null,
          error: snapResult?.error ?? null,
          frameBase64: snapResult?.frameBase64 ?? null,
        },
      }));
      break;
    }

    case 'rename': {
      // V2: {“type”:”rename”,”title”:”...”}
      window.dispatchEvent(new CustomEvent('edith:renameProject', { detail: { title: (op as any).title } }));
      break;
    }

    default:
      console.warn('[storeAdapter] Unknown op type — full op:', JSON.stringify(op));
  }
}

export function initStoreAdapter() {
  operationEngine.setApplyFn(applyOp);

  operationEngine.setPreApplyFn(async (op: Op) => {
    const store = useVideoEditorStore.getState() as any;
    const fps: number = store?.timeline?.fps ?? 30;
    const totalFrames: number = store?.timeline?.totalFrames ?? 900;

    // Start editing mode on first op
    if (!useEdithEditingStore.getState().isEditing) startEdithEditing();

    // EDITH is now executing â€” stop the thinking freeze
    useEdithEditingStore.getState().setIsThinking(false);

    await animateForOp(op, fps, totalFrames);

    // Op animation done â€” EDITH is thinking about the next one
    useEdithEditingStore.getState().setIsThinking(true);
  });

  operationEngine.on('queueDrained', () => {
    stopEdithEditing();
  });
}



