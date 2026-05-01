/**
 * storeAdapter — bridges the OperationEngine to Dividr's Zustand store.
 * Translates Op objects into concrete store mutations.
 */

import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { calculateDimensionsForRatio } from '@/frontend/features/editor/stores/videoEditor/utils/aspectRatioHelpers';
import { useCaptionStylesStore } from '@/frontend/features/editor/stores/captionStylesStore';
import { Op } from './types';
import { operationEngine } from './operationEngine';
import { useDownloadApprovalStore } from './stores/downloadApprovalStore';
import { pickSubtitleRow } from './captionUtils';

export { pickSubtitleRow };

// Mycelium caption style defaults
const CAPTION_DEFAULTS = {
  fontFamily: 'Inter',
  fontSize: 52,
  fillColor: '#FFFFFF',
  isBold: true,
  isUppercase: true,
  position: 0.65,
  highlightColor: '#FFD700',
};

async function applyOp(op: Op): Promise<void> {
  const store = useVideoEditorStore.getState() as any;

  switch (op.type) {
    case 'cut': {
      store.splitTrack(op.clipId, op.atFrame);
      break;
    }

    case 'trimClip': {
      store.resizeTrack(op.clipId, op.newStartFrame, op.newEndFrame);
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

      await store.addTrack({
        type: op.trackType,
        name: op.src.split(/[/\\]/).pop() ?? op.src,
        source: op.src,
        previewUrl,
        duration,
        startFrame,
        endFrame,
        sourceStartTime: op.inSeconds,
        visible: true,
        locked: false,
        color: op.trackType === 'video' ? '#4A90D9' : op.trackType === 'audio' ? '#7ED321' : '#F5A623',
      });
      break;
    }

    case 'addCaption': {
      const fps = store.fps ?? 30;
      const startFrame = Math.round(op.startSeconds * fps);
      const duration = Math.round((op.endSeconds - op.startSeconds) * fps);
      const endFrame = startFrame + duration;

      // Merge: base defaults ← active style bank entry ← op's explicit style
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

      // Pack captions into the fewest subtitle rows — reuse a row if no time collision
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

      await store.addTrack({
        type: 'video',
        name: op.src.split(/[/\\]/).pop() ?? 'B-Roll',
        source: op.src,
        previewUrl,
        duration,
        startFrame,
        endFrame,
        visible: true,
        locked: false,
        color: '#27AE60',
        trackRowIndex: 1, // Overlay row above main footage
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
      if (op.toLayer !== undefined) {
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
      console.log('[storeAdapter] ▶ downloadMedia case hit', op);
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
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Transcribing with Whisper…' } }));
      const result = await (window.electronAPI as any).invoke('whisper:transcribe', filePath, { model: 'base' });
      if (!result.success) throw new Error(result.error ?? 'Whisper failed');
      useVideoEditorStore.getState().updateMediaLibraryItem(mediaId, {
        cachedKaraokeSubtitles: {
          transcriptionResult: result.result,
          generatedAt: Date.now(),
        },
      });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Transcription complete' } }));
      break;
    }

    case 'analyzeReference': {
      const state = useVideoEditorStore.getState() as any;
      // Try media library first, then fall back to finding a reference item by name/path match
      let mediaItem = state.mediaLibrary?.find((m: any) => m.id === op.clipId);
      if (!mediaItem) {
        // EDITH may have passed a timeline track ID — find the track and match to media library
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
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Analyzing reference with Gemini…' } }));
      const result = await (window.electronAPI as any).invoke('mycelium:analyzeReference', { filePath });
      if (!result.success) throw new Error(result.error ?? 'Gemini analysis failed');
      useVideoEditorStore.getState().updateMediaLibraryItem(op.clipId, { referenceAnalysis: result.analysis });
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Reference analyzed' } }));
      break;
    }

    case 'geminiEdit': {
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

      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: 'Gemini is watching both videos…' } }));

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

      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Gemini edit applied — ${spec.segment.reason ?? 'segment selected'}` } }));
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

    default:
      console.warn('[storeAdapter] Unknown op type — full op:', JSON.stringify(op));
  }
}

export function initStoreAdapter() {
  operationEngine.setApplyFn(applyOp);
}
