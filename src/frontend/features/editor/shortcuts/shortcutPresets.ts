import {
  BaselineShortcut,
  ShortcutOverrides,
  ShortcutPlatform,
  filterCombosForPlatform,
  normalizeActionName,
  normalizeKeyList,
} from './shortcutUtils';

export type ShortcutPreset = 'Default' | 'CapCut' | 'Premiere Pro';

const CAPCUT_PRESET: Record<string, string[] | string> = {
  'Play / Pause': 'space',
  Undo: ['ctrl+z', 'cmd+z'],
  Redo: ['ctrl+y', 'cmd+shift+z'],
  'Split at Playhead': 'ctrl+b',
  'Delete Clip': 'del',
  'Zoom In Timeline': 'ctrl+equal',
  'Zoom Out Timeline': 'ctrl+minus',
  'Toggle Snapping': 's',
  'Select All': 'ctrl+a',
  Copy: 'ctrl+c',
  Paste: 'ctrl+v',
  Cut: 'ctrl+x',
  Duplicate: 'ctrl+d',
  'Link Clips': 'ctrl+l',
  'Unlink Clips': 'ctrl+shift+l',
  'Import Media': 'ctrl+i',
  Export: 'ctrl+e',
  'Fullscreen Preview': 'f',
};

const PREMIERE_PRESET: Record<string, string[] | string> = {
  'Play / Pause': 'space',
  Undo: ['ctrl+z', 'cmd+z'],
  Redo: ['ctrl+shift+z', 'cmd+shift+z'],
  'Razor Tool (Split Mode)': 'c',
  'Selection Tool': 'v',
  'Add Edit at Playhead': 'ctrl+k',
  Delete: 'del',
  'Zoom In Timeline': 'equal',
  'Zoom Out Timeline': 'minus',
  'Link Clips': 'ctrl+l',
  'Unlink Clips': 'ctrl+shift+l',
  Import: 'ctrl+i',
  'Export Media': 'ctrl+m',
  'Fullscreen Playback': 'ctrl+`',
  'Toggle Snapping': 's',
};

export const getPresetOverrides = (
  preset: ShortcutPreset,
  baseline: BaselineShortcut[],
  platform: ShortcutPlatform,
) => {
  if (preset === 'Default') {
    return { overrides: {} as ShortcutOverrides, errors: [] as string[] };
  }

  const mappings = preset === 'CapCut' ? CAPCUT_PRESET : PREMIERE_PRESET;
  const overrides: ShortcutOverrides = {};
  const errors: string[] = [];

  Object.entries(mappings).forEach(([actionName, keys]) => {
    const normalizedAction = normalizeActionName(actionName);
    const match = baseline.find(
      (shortcut) => normalizeActionName(shortcut.action) === normalizedAction,
    );

    if (!match) {
      errors.push(actionName);
      return;
    }

    const normalizedKeys = normalizeKeyList(keys);
    const filtered = filterCombosForPlatform(normalizedKeys, platform);

    if (filtered.length === 0) {
      errors.push(actionName);
      return;
    }

    overrides[match.id] = filtered;
  });

  return { overrides, errors };
};
