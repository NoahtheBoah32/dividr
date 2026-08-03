import { create } from 'zustand';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';

export interface PendingDownload {
  id: string;
  filePath: string;
  fileName: string;
  fileType: 'video' | 'audio' | 'image';
  sourceUrl: string;
  title?: string;
  /** Source chapters (e.g. YouTube) captured at download — carried onto the media item. */
  chapters?: Array<{ start: number; title: string }>;
  /** Provenance recorded at download time. */
  origin?: string;
}

interface DownloadApprovalState {
  pending: PendingDownload[];
  autoApproveAll: boolean;

  enqueue: (item: PendingDownload) => void;
  approve: (id: string, triggerContinue?: boolean) => Promise<void>;
  approveAll: (id: string) => Promise<void>;
  deny: (id: string) => Promise<void>;
  resetForProjectSwitch: () => void;
}

// Exported: the References panel reuses this exact import recipe for URL downloads.
// Returns the new media library id so callers can reference the imported item.
export async function importFileIntoLibrary(item: PendingDownload): Promise<string> {
  const store = useVideoEditorStore.getState() as any;

  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  };
  const ext = item.fileName.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = mimeTypes[ext] ?? `${item.fileType}/${ext}`;

  // Get duration — lightweight IPC call, no file read
  let duration = 30;
  try { duration = await window.electronAPI.getDuration(item.filePath); } catch {}

  // Get dimensions for video files
  let metadata: { width?: number; height?: number } = {};
  if (item.fileType === 'video') {
    try {
      const dims = await (window.electronAPI as any).getVideoDimensions(item.filePath);
      if (dims?.width) metadata = { width: dims.width, height: dims.height };
    } catch {}
  }

  // Create a preview URL (media:// protocol or object URL)
  let previewUrl: string | undefined;
  try {
    const r = await window.electronAPI.createPreviewUrl(item.filePath);
    if (r && typeof r === 'object' && (r as any).url) previewUrl = (r as any).url;
    else if (typeof r === 'string') previewUrl = r;
  } catch {}

  const mediaId = store.addToMediaLibrary({
    name: item.title ?? item.fileName,
    type: item.fileType,
    source: item.filePath,
    tempFilePath: item.filePath,
    previewUrl: previewUrl ?? item.filePath,
    duration,
    size: 0,
    mimeType,
    metadata,
    spriteSheetDisabled: duration > 300,
    ...(item.chapters?.length ? { chapters: item.chapters } : {}),
    ...(item.origin ? { origin: item.origin as any } : {}),
  });

  if (item.fileType === 'video' && duration <= 300) {
    (store as any).generateSpriteSheetForMedia(mediaId).catch(() => {});
  }
  return mediaId;
}

export const useDownloadApprovalStore = create<DownloadApprovalState>((set, get) => ({
  pending: [],
  autoApproveAll: false,

  enqueue: (item) => set((s) => ({ pending: [...s.pending, item] })),

  approve: async (id, triggerContinue = true) => {
    const item = get().pending.find((p) => p.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
    let mediaId: string;
    try {
      mediaId = await importFileIntoLibrary(item);
    } catch (err) {
      console.error('[downloadApprovalStore] import failed:', err);
      window.dispatchEvent(new CustomEvent('edith:status', { detail: { text: `Import failed: ${err instanceof Error ? err.message : String(err)}` } }));
      return;
    }
    // The chat renders EDITH's own fetches as playable cards — tell it what landed.
    window.dispatchEvent(new CustomEvent('edith:mediaFetched', {
      detail: { mediaId, name: item.title ?? item.fileName, mediaType: item.fileType },
    }));
    window.dispatchEvent(new CustomEvent('edith:downloadImported', {
      detail: { id, remaining: get().pending.length, triggerContinue },
    }));
  },

  approveAll: async (id) => {
    set({ autoApproveAll: true });
    // Approve the clicked item without triggering EDITH yet
    await get().approve(id, false);
    // Drain remaining pending items, no trigger for each
    while (get().pending.length > 0) {
      const next = get().pending[0];
      if (!next) break;
      await get().approve(next.id, false);
    }
    // Fire one trigger now that all are imported
    window.dispatchEvent(new CustomEvent('edith:downloadImported', {
      detail: { id: 'all', remaining: 0, triggerContinue: true },
    }));
  },

  deny: async (id) => {
    // Delete the denied file
    const item = get().pending.find((p) => p.id === id);
    if (item) await window.electronAPI.deleteFile(item.filePath).catch(() => {});
    // Clear the entire queue — denial cancels the whole batch
    const rest = get().pending.filter((p) => p.id !== id);
    for (const p of rest) {
      await window.electronAPI.deleteFile(p.filePath).catch(() => {});
    }
    set({ pending: [], autoApproveAll: false });
    window.dispatchEvent(new CustomEvent('edith:downloadDenied', {
      detail: { title: item?.title ?? item?.fileName ?? 'clip' },
    }));
  },

  resetForProjectSwitch: () => {
    set({ pending: [], autoApproveAll: false });
  },
}));
