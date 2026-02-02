import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/frontend/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/frontend/components/ui/alert-dialog';
import { Button } from '@/frontend/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/frontend/components/ui/dialog';
import { Kbd } from '@/frontend/components/ui/kbd';
import { ScrollArea } from '@/frontend/components/ui/scroll-area';
import { baselineShortcuts } from '@/frontend/features/editor/shortcuts/baselineShortcuts';
import { useShortcutStore } from '@/frontend/features/editor/shortcuts/shortcutStore';
import {
  BaselineShortcut,
  filterCombosForPlatform,
  findConflict,
  getDisplayKeyGroups,
  normalizeComboFromEvent,
  normalizeComboString,
  normalizeKeyList,
  resolveEffectiveShortcuts,
} from '@/frontend/features/editor/shortcuts/shortcutUtils';
import { shortcutRegistry } from '@/frontend/features/editor/stores/videoEditor/shortcuts';
import { cn } from '@/frontend/utils/utils';
import {
  Keyboard,
  RefreshCcw,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface HotkeyItemProps {
  displayKeys: string[][];
  description: string;
  onEditCombo?: (comboIndex: number) => void;
  onReset?: () => void;
  showReset?: boolean;
  isHighlighted?: boolean;
  isActive?: boolean;
  activeComboIndex?: number | null;
  activePreviewTokens?: string[] | null;
  showConflict?: boolean;
}

const HotkeyItemComponent = React.forwardRef<HTMLDivElement, HotkeyItemProps>(
  (
    {
      displayKeys,
      description,
      onEditCombo,
      onReset,
      showReset,
      isHighlighted,
      isActive,
      activeComboIndex,
      activePreviewTokens,
      showConflict,
    },
    ref,
  ) => {
    const isInteractive = Boolean(onEditCombo);
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-start justify-between py-2 px-3 rounded-lg transition-all duration-150 group gap-4',
          'hover:bg-muted/40',
          'cursor-default',
          isHighlighted && 'ring-2 ring-primary/60 ring-offset-2',
          isActive && 'bg-muted/60 ring-1 ring-primary/50',
          showConflict &&
            'p-0 focus:outline-none focus:ring-0 ring-0 hover:bg-transparent',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground/90 group-hover:text-foreground pt-0.5">
            {description}
          </span>
          {isActive ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded">
              Listening
            </span>
          ) : null}
          {showReset ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onReset?.();
              }}
              className="text-[10px] text-muted-foreground underline underline-offset-2 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              Reset
            </button>
          ) : null}
          {isInteractive ? (
            <span className="text-[10px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
              Click a shortcut to edit
            </span>
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-1 text-left">
          {displayKeys.map((keyCombo, comboIndex) => (
            <button
              key={comboIndex}
              type="button"
              onClick={() => onEditCombo?.(comboIndex)}
              disabled={!onEditCombo}
              className={cn(
                'flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors',
                onEditCombo
                  ? 'hover:bg-muted/60 cursor-pointer'
                  : 'cursor-default',
                activeComboIndex === comboIndex && isActive
                  ? 'bg-muted/70 ring-1 ring-primary/50'
                  : 'bg-transparent',
              )}
            >
              {(isActive &&
              activeComboIndex === comboIndex &&
              activePreviewTokens &&
              activePreviewTokens.length > 0
                ? activePreviewTokens
                : keyCombo
              ).map((key, keyIndex) => (
                <React.Fragment key={keyIndex}>
                  <Kbd className="min-w-[32px] h-6 px-2 text-[10px] font-semibold shadow-sm">
                    {key}
                  </Kbd>
                  {keyIndex < keyCombo.length - 1 && (
                    <span className="text-[10px] text-muted-foreground font-medium">
                      +
                    </span>
                  )}
                </React.Fragment>
              ))}
            </button>
          ))}
        </div>
      </div>
    );
  },
);

HotkeyItemComponent.displayName = 'HotkeyItem';

const HotkeyItem = React.memo(HotkeyItemComponent);

interface HotkeySectionProps {
  title: string;
  hotkeys: HotkeyRow[];
  onEdit: (row: HotkeyRow, comboIndex: number) => void;
  onReset: (row: HotkeyRow) => void;
  highlightedId: string | null;
  activeGroupId: string | null;
  activeComboIndex: number | null;
  activePreviewTokens: string[] | null;
  conflict: ConflictState | null;
  onDismissConflict: () => void;
  onScrollToConflict: () => void;
}

const HotkeySectionComponent: React.FC<HotkeySectionProps> = ({
  title,
  hotkeys,
  onEdit,
  onReset,
  highlightedId,
  activeGroupId,
  activeComboIndex,
  activePreviewTokens,
  conflict,
  onDismissConflict,
  onScrollToConflict,
}) => {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-xs text-muted-foreground/80 uppercase tracking-wide pb-1">
        {title}
      </h3>
      <div className="space-y-0.5">
        {hotkeys.map((hotkey) => {
          const showConflict = conflict?.sourceGroupId === hotkey.groupId;

          return (
            <div
              key={hotkey.groupId}
              className={cn(
                'space-y-2',
                showConflict && 'p-2 rounded-md bg-muted/60',
              )}
            >
              <HotkeyItem
                ref={hotkey.rowRef}
                displayKeys={hotkey.displayKeys}
                description={hotkey.action}
                onEditCombo={
                  hotkey.ids.length > 0
                    ? (index) => onEdit(hotkey, index)
                    : undefined
                }
                onReset={
                  hotkey.ids.length > 0 ? () => onReset(hotkey) : undefined
                }
                showReset={hotkey.ids.length > 0 && hotkey.hasOverride}
                isHighlighted={hotkey.ids.includes(highlightedId || '')}
                isActive={hotkey.groupId === activeGroupId}
                activeComboIndex={activeComboIndex}
                activePreviewTokens={activePreviewTokens}
                showConflict={showConflict}
              />
              {showConflict ? (
                <Alert
                  className="border border-border/50 text-white shadow-sm bg-[color:var(--shortcut-alert-bg)] dark:bg-[color:var(--shortcut-alert-bg-dark)]"
                  style={
                    {
                      '--shortcut-alert-bg': '#7a3b3b',
                      '--shortcut-alert-bg-dark': '#793131',
                    } as React.CSSProperties
                  }
                >
                  <AlertAction>
                    <button
                      type="button"
                      onClick={onDismissConflict}
                      className="text-white/80 hover:text-white transition-colors"
                      aria-label="Dismiss alert"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </AlertAction>
                  <TriangleAlert className="h-5 w-5 text-white" />
                  <div className="space-y-6">
                    <div className="space-y-1">
                      <AlertTitle className="text-white">
                        Shortcut Conflict Detected
                      </AlertTitle>
                      <AlertDescription className="text-white/80">
                        {conflict
                          ? `This combination is already assigned to ‘${conflict.conflictAction}’. Please choose a different key combination.`
                          : ''}
                      </AlertDescription>
                    </div>
                    <button
                      type="button"
                      onClick={onScrollToConflict}
                      className="inline-flex items-center gap-1 text-xs text-white underline underline-offset-4"
                    >
                      Go to similar shortcut
                      <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </Alert>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

HotkeySectionComponent.displayName = 'HotkeySection';

const HotkeySection = React.memo(HotkeySectionComponent);

interface HotkeysDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface HotkeyRow {
  groupId: string;
  ids: string[];
  action: string;
  category: string;
  scope: string;
  keys: string[];
  displayKeys: string[][];
  rowRef: React.RefObject<HTMLDivElement>;
  hasOverride: boolean;
}

interface ConflictState {
  combo: string;
  conflictId: string;
  conflictAction: string;
  sourceGroupId?: string | null;
}

export const HotkeysDialog: React.FC<HotkeysDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const categoryOrder = [
    'Project',
    'Edit',
    'Playback',
    'Track Editing',
    'Track Properties',
    'Navigation',
    'Track Selection',
    'Timeline Selection',
    'Tools',
    'Preview Tools',
    'Timeline Zoom',
    'Timeline Tools',
    'Preview Zoom',
  ];

  const platform = useShortcutStore((state) => state.platform);
  const userOverrides = useShortcutStore((state) => state.userOverrides);
  const setUserOverride = useShortcutStore((state) => state.setUserOverride);
  const resetOverride = useShortcutStore((state) => state.resetOverride);
  const resetAll = useShortcutStore((state) => state.resetAll);
  const setCapturing = useShortcutStore((state) => state.setCapturing);

  const [activeEdit, setActiveEdit] = useState<HotkeyRow | null>(null);
  const [activeComboIndex, setActiveComboIndex] = useState<number | null>(null);
  const [activeComboValue, setActiveComboValue] = useState<string | null>(null);
  const [pendingCombo, setPendingCombo] = useState<string | null>(null);
  const [previewTokens, setPreviewTokens] = useState<string[] | null>(null);
  const pendingComboRef = useRef<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const [resetRow, setResetRow] = useState<HotkeyRow | null>(null);

  useEffect(() => {
    pendingComboRef.current = pendingCombo;
  }, [pendingCombo]);

  const shortcutSource = useMemo<BaselineShortcut[]>(() => {
    if (baselineShortcuts.length > 0) return baselineShortcuts;
    if (!open) return [];

    const registryShortcuts = shortcutRegistry.getAllShortcuts();
    return registryShortcuts.map((shortcut) => ({
      id: shortcut.id,
      action: shortcut.description,
      category: shortcut.category,
      scope: shortcut.scope,
      keys: Array.isArray(shortcut.keys) ? shortcut.keys : [shortcut.keys],
    }));
  }, [open]);

  const effectiveShortcuts = useMemo(() => {
    return resolveEffectiveShortcuts(
      shortcutSource,
      {},
      userOverrides,
      platform,
    );
  }, [shortcutSource, userOverrides, platform]);

  const actionById = useMemo(() => {
    const map = new Map<string, string>();
    shortcutSource.forEach((shortcut) => {
      map.set(shortcut.id, shortcut.action);
    });
    return map;
  }, [shortcutSource]);

  const groupedShortcuts = useMemo<HotkeyRow[]>(() => {
    const grouped = new Map<string, HotkeyRow>();

    shortcutSource.forEach((shortcut) => {
      const groupId = `${shortcut.category}::${shortcut.action}`;
      const entry = grouped.get(groupId) || {
        groupId,
        ids: [],
        action: shortcut.action,
        category: shortcut.category,
        scope: shortcut.scope,
        keys: [],
        displayKeys: [],
        rowRef: React.createRef<HTMLDivElement>(),
        hasOverride: false,
      };

      const resolvedKeys =
        effectiveShortcuts[shortcut.id] || normalizeKeyList(shortcut.keys);
      const combinedKeys = Array.from(
        new Set([...entry.keys, ...resolvedKeys]),
      );

      entry.ids = [...entry.ids, shortcut.id];
      entry.keys = filterCombosForPlatform(combinedKeys, platform);
      entry.displayKeys = getDisplayKeyGroups(entry.keys);
      entry.hasOverride = entry.ids.some((id) => !!userOverrides[id]);

      grouped.set(groupId, entry);
    });

    return Array.from(grouped.values());
  }, [shortcutSource, effectiveShortcuts, platform, userOverrides]);

  const shortcutsByCategory = useMemo(() => {
    const grouped = new Map<string, HotkeyRow[]>();
    groupedShortcuts.forEach((shortcut) => {
      if (!grouped.has(shortcut.category)) {
        grouped.set(shortcut.category, []);
      }
      grouped.get(shortcut.category)?.push(shortcut);
    });

    const sections = Array.from(grouped.entries()).map(
      ([category, hotkeys]) => ({
        title: category,
        hotkeys,
      }),
    );

    return sections.sort((a, b) => {
      const aIndex = categoryOrder.indexOf(a.title);
      const bIndex = categoryOrder.indexOf(b.title);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.title.localeCompare(b.title);
    });
  }, [groupedShortcuts]);

  const groups = useMemo(
    () => [
      { name: 'PROJECT', categories: ['Project'] },
      { name: 'ESSENTIALS', categories: ['Edit', 'Playback'] },
      { name: 'EDITING', categories: ['Track Editing', 'Track Properties'] },
      {
        name: 'NAVIGATION',
        categories: ['Navigation', 'Track Selection', 'Timeline Selection'],
      },
      { name: 'TOOLS', categories: ['Tools', 'Preview Tools'] },
      {
        name: 'VIEW & DISPLAY',
        categories: ['Timeline Zoom', 'Timeline Tools', 'Preview Zoom'],
      },
      { name: 'INTERACTIONS', categories: ['Mouse Interactions'] },
    ],
    [],
  );

  const manualInteractionShortcuts = useMemo(() => {
    const multiSelectKeys =
      platform === 'mac' ? [['Cmd', 'Click']] : [['Ctrl', 'Click']];
    return {
      title: 'Mouse Interactions',
      hotkeys: [
        {
          groupId: 'manual-multiselect',
          ids: [] as string[],
          action: 'Add/Remove from Selection (Multi-select)',
          category: 'Mouse Interactions',
          scope: 'global',
          keys: [] as string[],
          displayKeys: multiSelectKeys,
          rowRef: React.createRef<HTMLDivElement>(),
          hasOverride: false,
        },
        {
          groupId: 'manual-cycle',
          ids: [] as string[],
          action: 'Cycle Through Overlapping Elements (Preview)',
          category: 'Mouse Interactions',
          scope: 'preview',
          keys: [] as string[],
          displayKeys: [['Shift', 'Click']],
          rowRef: React.createRef<HTMLDivElement>(),
          hasOverride: false,
        },
      ],
    };
  }, [platform]);

  const allShortcuts = [...shortcutsByCategory, manualInteractionShortcuts];

  const stopCapture = useCallback(() => {
    setActiveEdit(null);
    setActiveComboIndex(null);
    setActiveComboValue(null);
    setPendingCombo(null);
    setPreviewTokens(null);
    setCapturing(false);
  }, [setCapturing]);

  const openConflict = useCallback(
    (combo: string, conflictId: string, sourceGroupId?: string | null) => {
      setConflict({
        combo,
        conflictId,
        conflictAction: actionById.get(conflictId) || 'Unknown shortcut',
        sourceGroupId: sourceGroupId ?? null,
      });
    },
    [actionById],
  );

  const dismissConflict = useCallback(() => {
    setConflict(null);
  }, []);

  const applyCombo = useCallback(
    (combo: string) => {
      if (!activeEdit) return;
      if (activeComboIndex === null || activeComboIndex < 0) return;

      if (platform === 'win' && combo.includes('cmd')) {
        return;
      }

      const conflictId = findConflict(
        combo,
        effectiveShortcuts,
        activeEdit.ids,
      );
      if (conflictId) {
        stopCapture();
        openConflict(combo, conflictId, activeEdit.groupId);
        return;
      }

      const normalizedCombo = normalizeComboString(combo);
      if (!normalizedCombo) return;

      activeEdit.ids.forEach((id) => {
        const existing =
          effectiveShortcuts[id] || normalizeKeyList(activeEdit.keys);
        const next = [...existing];
        const targetCombo = activeComboValue || existing[activeComboIndex];
        const targetIndex =
          targetCombo && next.length > 0
            ? next.findIndex(
                (entry) =>
                  normalizeComboString(entry) ===
                  normalizeComboString(targetCombo),
              )
            : activeComboIndex;
        if (targetIndex >= 0 && targetIndex < next.length) {
          next[targetIndex] = normalizedCombo;
        } else {
          next.push(normalizedCombo);
        }
        const normalizedList = normalizeKeyList(next);
        setUserOverride(id, normalizedList);
      });

      stopCapture();
    },
    [
      activeEdit,
      activeComboIndex,
      activeComboValue,
      effectiveShortcuts,
      openConflict,
      platform,
      setUserOverride,
      stopCapture,
    ],
  );

  const confirmPendingCombo = useCallback(() => {
    const combo = pendingComboRef.current;
    if (!combo) return;
    applyCombo(combo);
  }, [applyCombo]);

  useEffect(() => {
    if (!activeEdit) return;

    const getPreviewTokens = (event: KeyboardEvent) => {
      const modifiers: string[] = [];
      if (event.ctrlKey) modifiers.push('ctrl');
      if (platform === 'mac' && event.metaKey) modifiers.push('cmd');
      if (event.shiftKey) modifiers.push('shift');
      if (event.altKey) modifiers.push('alt');

      const combo = normalizeComboFromEvent(event);
      if (combo) {
        return getDisplayKeyGroups([combo])[0] || null;
      }

      if (modifiers.length === 0) return null;
      return getDisplayKeyGroups([modifiers.join('+')])[0] || null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.key === 'Escape') {
        stopCapture();
        dismissConflict();
        return;
      }

      if (event.key === 'Enter') {
        confirmPendingCombo();
        return;
      }

      setPreviewTokens(getPreviewTokens(event));
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.key === 'Escape' || event.key === 'Enter') return;

      const combo = normalizeComboFromEvent(event);
      if (!combo) {
        setPreviewTokens(null);
        return;
      }

      setPendingCombo(combo);
      applyCombo(combo);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [
    activeEdit,
    applyCombo,
    confirmPendingCombo,
    dismissConflict,
    platform,
    stopCapture,
  ]);

  useEffect(() => {
    if (!open) {
      stopCapture();
    }
  }, [open, stopCapture]);

  useEffect(() => {
    if (!conflict) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismissConflict();
    };

    window.addEventListener('keydown', handleEscape, true);
    return () => {
      window.removeEventListener('keydown', handleEscape, true);
    };
  }, [conflict, dismissConflict]);

  const handleEdit = useCallback(
    (row: HotkeyRow, comboIndex: number) => {
      if (!row.ids.length) return;
      setActiveEdit(row);
      setActiveComboIndex(comboIndex);
      setActiveComboValue(row.keys[comboIndex] || null);
      setPendingCombo(null);
      setPreviewTokens(null);
      setCapturing(true);
    },
    [setCapturing],
  );

  const handleReset = useCallback((row: HotkeyRow) => {
    setResetRow(row);
  }, []);

  const handleScrollToConflict = useCallback(() => {
    if (!conflict) return;
    const conflictRow = groupedShortcuts.find((row) =>
      row.ids.includes(conflict.conflictId),
    );

    if (conflictRow?.rowRef?.current) {
      conflictRow.rowRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      setHighlightedId(conflict.conflictId);
      setTimeout(() => setHighlightedId(null), 1500);
    }

    setConflict(null);
  }, [conflict, groupedShortcuts]);

  const handleResetConfirm = useCallback(() => {
    if (!resetRow) return;
    resetRow.ids.forEach((id) => resetOverride(id));
    setResetRow(null);
  }, [resetOverride, resetRow]);

  const handleResetAllConfirm = useCallback(() => {
    resetAll();
    setResetAllOpen(false);
  }, [resetAll]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[1400px] min-w-[60vw] max-h-[90vh] p-0 flex flex-col">
          <div className="flex flex-col flex-1 min-h-0">
            <DialogHeader className="px-8 py-5 border-b border-border/50 bg-gradient-to-b from-muted/30 to-background">
              <DialogTitle className="flex items-center gap-4">
                <div className="p-2.5 bg-primary/15 rounded-xl ring-1 ring-primary/20">
                  <Keyboard className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">
                    Keyboard Shortcuts
                  </h2>
                  <p className="text-sm text-muted-foreground mt-0.5 font-normal">
                    Master these shortcuts to edit faster and more efficiently
                  </p>
                </div>
              </DialogTitle>
            </DialogHeader>

            <ScrollArea className="flex-1 px-8 py-6 overflow-y-auto min-h-0">
              <div className="space-y-10">
                {groups.map((group) => {
                  const groupSections = allShortcuts.filter((section) =>
                    group.categories.includes(section.title),
                  );

                  if (groupSections.length === 0) return null;

                  return (
                    <div key={group.name} className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="h-[2px] w-2 bg-primary rounded-full" />
                        <h2 className="text-xs font-bold tracking-[0.2em] text-primary/80 uppercase">
                          {group.name}
                        </h2>
                        <div className="flex-1 h-[1px] bg-gradient-to-r from-primary/20 via-border/50 to-transparent" />
                      </div>

                      <div className="grid grid-cols-1 gap-x-8 gap-y-6">
                        {groupSections.map((section) => (
                          <HotkeySection
                            key={section.title}
                            title={section.title}
                            hotkeys={section.hotkeys}
                            onEdit={handleEdit}
                            onReset={handleReset}
                            highlightedId={highlightedId}
                            activeGroupId={activeEdit?.groupId || null}
                            activeComboIndex={activeComboIndex}
                            activePreviewTokens={previewTokens}
                            conflict={conflict}
                            onDismissConflict={dismissConflict}
                            onScrollToConflict={handleScrollToConflict}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>

            <div className="px-8 py-4 border-t border-border/50 bg-muted/10 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Tip:</span>
                <span>Click a shortcut key to edit.</span>
                <span>Use</span>
                <Kbd className="inline-flex px-1.5 py-0.5 text-[9px]">Esc</Kbd>
                <span>to cancel.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs gap-2"
                  onClick={() => setResetAllOpen(true)}
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Reset to Default
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={resetAllOpen} onOpenChange={setResetAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all shortcuts?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear all custom overrides and restore baseline
              shortcuts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetAllConfirm}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resetRow} onOpenChange={() => setResetRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset shortcut?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revert{' '}
              <span className="font-medium text-foreground">
                {resetRow?.action || 'this shortcut'}
              </span>{' '}
              to its default binding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetConfirm}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
