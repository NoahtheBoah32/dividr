import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';

// Safe storage wrapper — silently no-ops when localStorage is unavailable (tests, SSR)
const safeLocalStorage = {
  getItem: (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem: (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  removeItem: (key: string): void => {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export interface SavedCaptionStyle {
  id: string;
  name: string;
  fontFamily: string;
  fontSize: number;
  fillColor: string;
  highlightColor: string;
  isBold: boolean;
  isUppercase: boolean;
  position: number; // 0–1
  emphasisFirst?: boolean; // highlight first content word instead of last
}

const DEFAULT_STYLES: SavedCaptionStyle[] = [
  {
    id: 'mycelium',
    name: 'Mycelium',
    fontFamily: 'Inter',
    fontSize: 52,
    fillColor: '#FFFFFF',
    highlightColor: '#00D4FF',
    isBold: true,
    isUppercase: true,
    position: 0.65,
  },
  {
    id: 'hormozi',
    name: 'Hormozi',
    fontFamily: 'Impact',
    fontSize: 64,
    fillColor: '#FFFFFF',
    highlightColor: '#FFE500',
    isBold: false,
    isUppercase: true,
    position: 0.7,
  },
  {
    id: 'farm',
    name: 'Farm',
    fontFamily: 'Arial Black',
    fontSize: 72,
    fillColor: '#FFFFFF',
    highlightColor: '#FFD700',
    isBold: false,
    isUppercase: true,
    position: 0.65,
    emphasisFirst: true,
  },
];

interface CaptionStylesState {
  styles: SavedCaptionStyle[];
  activeStyleId: string;
  saveStyle: (name: string, style: Partial<SavedCaptionStyle>) => void;
  deleteStyle: (id: string) => void;
  setActiveStyle: (id: string) => void;
}

export const useCaptionStylesStore = create<CaptionStylesState>()(
  persist(
    (set) => ({
      styles: DEFAULT_STYLES,
      activeStyleId: 'mycelium',

      saveStyle: (name, style) =>
        set((state) => {
          const existing = state.styles.find(
            (s) => s.name.toLowerCase() === name.toLowerCase(),
          );
          const base = existing ?? DEFAULT_STYLES[0];
          const updated: SavedCaptionStyle = {
            id: existing?.id ?? uuidv4(),
            name,
            fontFamily: style.fontFamily ?? base.fontFamily,
            fontSize: style.fontSize ?? base.fontSize,
            fillColor: style.fillColor ?? base.fillColor,
            highlightColor: style.highlightColor ?? base.highlightColor,
            isBold: style.isBold ?? base.isBold,
            isUppercase: style.isUppercase ?? base.isUppercase,
            position: style.position ?? base.position,
          };
          return {
            styles: [
              ...state.styles.filter(
                (s) => s.name.toLowerCase() !== name.toLowerCase(),
              ),
              updated,
            ],
          };
        }),

      deleteStyle: (id) =>
        set((state) => ({
          styles: state.styles.filter((s) => s.id !== id),
          activeStyleId:
            state.activeStyleId === id ? 'mycelium' : state.activeStyleId,
        })),

      setActiveStyle: (id) => set({ activeStyleId: id }),
    }),
    {
      name: 'dividr-caption-styles',
      storage: createJSONStorage(() => safeLocalStorage),
      // Always keep built-in styles up-to-date; preserve user-added styles
      merge: (persisted: unknown, current) => {
        const p = persisted as Partial<CaptionStylesState>;
        const userStyles = (p.styles ?? []).filter(
          (s) => !DEFAULT_STYLES.some((d) => d.id === s.id),
        );
        return {
          ...current,
          ...p,
          styles: [...DEFAULT_STYLES, ...userStyles],
        };
      },
    },
  ),
);
