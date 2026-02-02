import { useMemo } from 'react';
import { baselineShortcuts } from './baselineShortcuts';
import { getPresetOverrides } from './shortcutPresets';
import { useShortcutStore } from './shortcutStore';
import { normalizeKeyList, resolveEffectiveShortcuts } from './shortcutUtils';

export const useResolvedShortcutMap = () => {
  const activePreset = useShortcutStore((state) => state.activePreset);
  const userOverrides = useShortcutStore((state) => state.userOverrides);
  const platform = useShortcutStore((state) => state.platform);

  return useMemo(() => {
    const { overrides: presetOverrides, errors } = getPresetOverrides(
      activePreset,
      baselineShortcuts,
      platform,
    );

    if (errors.length > 0) {
      return resolveEffectiveShortcuts(
        baselineShortcuts,
        {},
        userOverrides,
        platform,
      );
    }

    return resolveEffectiveShortcuts(
      baselineShortcuts,
      presetOverrides,
      userOverrides,
      platform,
    );
  }, [activePreset, userOverrides, platform]);
};

export const useShortcutKeys = (id: string, fallback: string | string[]) => {
  const resolved = useResolvedShortcutMap();
  return resolved[id] && resolved[id].length > 0
    ? resolved[id]
    : normalizeKeyList(fallback);
};

export const useShortcutCaptureState = () =>
  useShortcutStore((state) => state.isCapturing);
