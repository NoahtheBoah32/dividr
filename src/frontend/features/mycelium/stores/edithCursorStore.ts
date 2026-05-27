import { create } from 'zustand';

export interface SegmentHighlight {
  id: string;
  clipId: string;
  startFrac: number; // 0–1 fraction of the clip's visual width
  endFrac: number;
  label: string;
}

interface EdithCursorStore {
  visible: boolean;
  x: number;
  y: number;
  animate: boolean;
  clicking: boolean;
  dragging: boolean;
  dragLabel: string;
  highlights: SegmentHighlight[];

  setCursor(partial: Partial<Omit<EdithCursorStore, 'setCursor' | 'addHighlight' | 'removeHighlight' | 'clearHighlights' | 'reset'>>): void;
  addHighlight(h: SegmentHighlight): void;
  removeHighlight(id: string): void;
  clearHighlights(): void;
  reset(): void;
}

export const useEdithCursorStore = create<EdithCursorStore>((set, get) => ({
  visible: false,
  x: 0,
  y: 0,
  animate: false,
  clicking: false,
  dragging: false,
  dragLabel: '',
  highlights: [],

  setCursor: (partial) => set(partial as any),

  addHighlight: (h) => set((s) => ({ highlights: [...s.highlights, h] })),

  removeHighlight: (id) => set((s) => ({ highlights: s.highlights.filter((h) => h.id !== id) })),

  clearHighlights: () => set({ highlights: [] }),

  reset: () =>
    set({
      visible: false,
      x: 0,
      y: 0,
      animate: false,
      clicking: false,
      dragging: false,
      dragLabel: '',
      highlights: [],
    }),
}));
