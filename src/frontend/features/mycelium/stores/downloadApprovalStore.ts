import { create } from 'zustand';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';

export interface PendingDownload {
  id: string;
  filePath: string;
  fileName: string;
  fileType: 'video' | 'audio' | 'image';
  sourceUrl: string;
  title?: string;
}

interface DownloadApprovalState {
  pending: PendingDownload[];
  autoApproveAll: boolean;

  enqueue: (item: PendingDownload) => void;
  approve: (id: string) => Promise<void>;
  approveAll: (id: string) => Promise<void>;
  deny: (id: string) => Promise<void>;
}

async function importFileIntoLibrary(item: PendingDownload): Promise<void> {
  const bufResult = await window.electronAPI.readFileAsBuffer(item.filePath);
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  };
  const ext = item.fileName.split('.').pop()?.toLowerCase() ?? '';
  const mime = mimeTypes[ext] ?? `${item.fileType}/${ext}`;
  const blob = new Blob([bufResult], { type: mime });
  const file = new File([blob], item.fileName, { type: mime, lastModified: Date.now() });
  const store = useVideoEditorStore.getState() as any;
  await store.importMediaFromDrop([file]);
}

export const useDownloadApprovalStore = create<DownloadApprovalState>((set, get) => ({
  pending: [],
  autoApproveAll: false,

  enqueue: (item) => set((s) => ({ pending: [...s.pending, item] })),

  approve: async (id) => {
    const item = get().pending.find((p) => p.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
    await importFileIntoLibrary(item);
    // Fire after import is fully done so media library is populated before EDITH reads context
    window.dispatchEvent(new CustomEvent('edith:downloadImported', { detail: { id, remaining: get().pending.length } }));
  },

  approveAll: async (id) => {
    set({ autoApproveAll: true });
    await get().approve(id);
  },

  deny: async (id) => {
    const item = get().pending.find((p) => p.id === id);
    if (item) {
      await window.electronAPI.deleteFile(item.filePath).catch(() => {});
    }
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },
}));
