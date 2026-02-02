export type ShortcutPlatform = 'mac' | 'win';

export interface BaselineShortcut {
  id: string;
  action: string;
  category: string;
  scope: string;
  keys: string[];
}

export type ShortcutOverrides = Record<string, string[]>;

const MODIFIER_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  command: 'cmd',
  cmd: 'cmd',
  meta: 'cmd',
  option: 'alt',
  alt: 'alt',
  shift: 'shift',
};

const SPECIAL_KEYS: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  escape: 'escape',
  esc: 'escape',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  delete: 'del',
  backspace: 'backspace',
  enter: 'enter',
  return: 'enter',
  '=': 'equal',
  '+': 'equal',
  '-': 'minus',
  _: 'minus',
};

const DISPLAY_MAP: Record<string, string> = {
  ctrl: 'Ctrl',
  cmd: 'Cmd',
  shift: 'Shift',
  alt: 'Alt',
  space: 'Space',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  equal: '=',
  minus: '-',
  del: 'Delete',
  backspace: 'Backspace',
  escape: 'Esc',
  enter: 'Enter',
};

export const getShortcutPlatform = (): ShortcutPlatform => {
  if (typeof navigator === 'undefined') return 'win';

  const platform =
    (navigator as any).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    '';

  return platform.toLowerCase().includes('mac') ? 'mac' : 'win';
};

export const isModifierKey = (key: string) =>
  key === 'ctrl' || key === 'cmd' || key === 'shift' || key === 'alt';

export const normalizeKeyToken = (raw: string) => {
  const lower = raw.toLowerCase().trim();
  if (MODIFIER_ALIASES[lower]) return MODIFIER_ALIASES[lower];
  if (SPECIAL_KEYS[lower]) return SPECIAL_KEYS[lower];
  if (lower.length === 1) return lower;
  return lower;
};

const orderModifiers = (modifiers: string[]) => {
  const hasCtrl = modifiers.includes('ctrl');
  const hasCmd = modifiers.includes('cmd');
  const hasShift = modifiers.includes('shift');
  const hasAlt = modifiers.includes('alt');
  const ordered: string[] = [];

  if (hasCtrl) ordered.push('ctrl');
  if (hasCmd) ordered.push('cmd');
  if (hasShift) ordered.push('shift');
  if (hasAlt) ordered.push('alt');

  return ordered;
};

export const normalizeComboString = (combo: string) => {
  const parts = combo.split('+').map((part) => normalizeKeyToken(part));
  const modifiers: string[] = [];
  let key: string | null = null;

  parts.forEach((part) => {
    if (!part) return;
    if (isModifierKey(part)) {
      if (!modifiers.includes(part)) modifiers.push(part);
      return;
    }
    key = part;
  });

  if (!key) return null;
  const ordered = [...orderModifiers(modifiers), key];
  return ordered.join('+');
};

export const normalizeComboFromEvent = (event: KeyboardEvent) => {
  const keyToken = normalizeKeyToken(event.key);
  if (!keyToken || isModifierKey(keyToken)) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.metaKey) modifiers.push('cmd');
  if (event.shiftKey) modifiers.push('shift');
  if (event.altKey) modifiers.push('alt');

  const ordered = [...orderModifiers(modifiers), keyToken];
  return ordered.join('+');
};

export const normalizeKeyList = (keys: string[] | string) => {
  const list = Array.isArray(keys) ? keys : [keys];
  const normalized = list
    .map((key) => normalizeComboString(key))
    .filter((key): key is string => !!key);
  return Array.from(new Set(normalized));
};

export const filterCombosForPlatform = (
  combos: string[],
  platform: ShortcutPlatform,
) => {
  if (platform === 'mac') return combos;
  return combos.filter((combo) => !combo.includes('cmd'));
};

export const sanitizeOverrides = (
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform,
) => {
  const result: ShortcutOverrides = {};

  Object.entries(overrides).forEach(([id, keys]) => {
    if (!Array.isArray(keys)) return;
    const normalized = normalizeKeyList(keys as string[]);
    const filtered = filterCombosForPlatform(normalized, platform);
    if (filtered.length > 0) {
      result[id] = filtered;
    }
  });

  return result;
};

export const getDisplayTokens = (combo: string) =>
  combo.split('+').map((part) => DISPLAY_MAP[part] || part.toUpperCase());

export const getDisplayKeyGroups = (combos: string[]) =>
  combos.map((combo) => getDisplayTokens(combo));

export const normalizeActionName = (name: string) => name.trim().toLowerCase();

export const resolveEffectiveShortcuts = (
  baseline: BaselineShortcut[],
  presetOverrides: ShortcutOverrides,
  userOverrides: ShortcutOverrides,
  platform: ShortcutPlatform,
) => {
  const resolved: ShortcutOverrides = {};

  baseline.forEach((shortcut) => {
    const baseKeys = normalizeKeyList(shortcut.keys);
    const presetKeys = presetOverrides[shortcut.id];
    const userKeys = userOverrides[shortcut.id];
    const merged = userKeys || presetKeys || baseKeys;
    const filtered = filterCombosForPlatform(merged, platform);
    resolved[shortcut.id] = filtered.length > 0 ? filtered : baseKeys;
  });

  return resolved;
};

export const findConflict = (
  combo: string,
  effective: ShortcutOverrides,
  excludeIds?: string[],
) => {
  const normalizedCombo = normalizeComboString(combo);
  if (!normalizedCombo) return null;

  for (const [id, combos] of Object.entries(effective)) {
    if (excludeIds && excludeIds.includes(id)) continue;
    if (
      combos.some((entry) => normalizeComboString(entry) === normalizedCombo)
    ) {
      return id;
    }
  }

  return null;
};

export const hasConflicts = (effective: ShortcutOverrides) => {
  const seen = new Map<string, string>();
  for (const [id, combos] of Object.entries(effective)) {
    combos.forEach((combo) => {
      const normalized = normalizeComboString(combo);
      if (!normalized) return;
      if (!seen.has(normalized)) {
        seen.set(normalized, id);
      }
    });
  }

  const conflicts: Array<{ combo: string; firstId: string; secondId: string }> =
    [];

  for (const [id, combos] of Object.entries(effective)) {
    combos.forEach((combo) => {
      const normalized = normalizeComboString(combo);
      if (!normalized) return;
      const existing = seen.get(normalized);
      if (existing && existing !== id) {
        conflicts.push({
          combo: normalized,
          firstId: existing,
          secondId: id,
        });
      }
    });
  }

  return conflicts;
};
