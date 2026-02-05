/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from 'zustand';
import { ShortcutPreset } from './shortcutPresets';
import {
  ShortcutOverrides,
  ShortcutPlatform,
  getShortcutPlatform,
  sanitizeOverrides,
} from './shortcutUtils';

interface ShortcutStoreState {
  platform: ShortcutPlatform;
  activePreset: ShortcutPreset;
  userOverrides: ShortcutOverrides;
  isCapturing: boolean;
  setCapturing: (value: boolean) => void;
  setActivePreset: (preset: ShortcutPreset) => void;
  setUserOverride: (id: string, keys: string[]) => void;
  resetOverride: (id: string) => void;
  resetAll: () => void;
  importOverrides: (
    preset: ShortcutPreset,
    overrides: ShortcutOverrides,
  ) => void;
}

const STORAGE_VERSION = 1;
const DEFAULT_PRESET: ShortcutPreset = 'Default';

const getStorageKey = (platform: ShortcutPlatform) =>
  `dividr-shortcuts-${platform}-v${STORAGE_VERSION}`;

const parseStoredOverrides = (raw: any, platform: ShortcutPlatform) => {
  if (!raw || typeof raw !== 'object') return {};
  return sanitizeOverrides(raw as ShortcutOverrides, platform);
};

const loadStoredState = (platform: ShortcutPlatform) => {
  if (typeof window === 'undefined') {
    return { preset: DEFAULT_PRESET, overrides: {} };
  }

  try {
    const raw = window.localStorage.getItem(getStorageKey(platform));
    if (!raw) return { preset: DEFAULT_PRESET, overrides: {} };

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) {
      return { preset: DEFAULT_PRESET, overrides: {} };
    }

    const preset = parsed.preset as ShortcutPreset;
    const overrides = parseStoredOverrides(parsed.userOverrides, platform);
    return { preset: preset || DEFAULT_PRESET, overrides };
  } catch {
    return { preset: DEFAULT_PRESET, overrides: {} };
  }
};

const saveStoredState = (
  platform: ShortcutPlatform,
  preset: ShortcutPreset,
  overrides: ShortcutOverrides,
) => {
  if (typeof window === 'undefined') return;

  try {
    const payload = {
      version: STORAGE_VERSION,
      preset,
      userOverrides: overrides,
    };
    window.localStorage.setItem(
      getStorageKey(platform),
      JSON.stringify(payload),
    );
  } catch {
    // Ignore persistence errors
  }
};

const platform = getShortcutPlatform();
const initialState = loadStoredState(platform);

export const useShortcutStore = create<ShortcutStoreState>((set) => ({
  platform,
  activePreset: initialState.preset,
  userOverrides: initialState.overrides,
  isCapturing: false,
  setCapturing: (value) => set({ isCapturing: value }),
  setActivePreset: (preset) => set({ activePreset: preset }),
  setUserOverride: (id, keys) =>
    set((state) => ({
      userOverrides: {
        ...state.userOverrides,
        [id]: keys,
      },
    })),
  resetOverride: (id) =>
    set((state) => {
      if (!state.userOverrides[id]) return state;
      const next = { ...state.userOverrides };
      delete next[id];
      return { userOverrides: next };
    }),
  resetAll: () =>
    set({
      activePreset: DEFAULT_PRESET,
      userOverrides: {},
    }),
  importOverrides: (preset, overrides) =>
    set({
      activePreset: preset,
      userOverrides: overrides,
    }),
}));

if (typeof window !== 'undefined') {
  useShortcutStore.subscribe((state) => {
    saveStoredState(state.platform, state.activePreset, state.userOverrides);
  });
}
