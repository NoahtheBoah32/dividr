import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/frontend/components/ui/context-menu';
import { ShortcutKbdStack } from '@/frontend/features/editor/shortcuts/ShortcutKbdStack';
import { useShortcutKeys } from '@/frontend/features/editor/shortcuts/shortcutHooks';
import {
  Clipboard,
  Copy,
  Files,
  Scissors,
  Trash2,
} from 'lucide-react';
import React, { memo, useCallback, useMemo } from 'react';
import { useVideoEditorStore, VideoTrack } from '../stores/videoEditor/index';

interface TrackContextMenuProps {
  track: VideoTrack;
  children: React.ReactNode;
}

export const TrackContextMenu: React.FC<TrackContextMenuProps> = memo(
  ({ track, children }) => {
    const isSelected = useVideoEditorStore((state) =>
      state.timeline.selectedTrackIds.includes(track.id),
    );
    const selectedCount = useVideoEditorStore(
      (state) => state.timeline.selectedTrackIds.length,
    );
    const hasClipboard = useVideoEditorStore(
      (state) => !!(state as any).clipboard,
    );

    const duplicateKeys = useShortcutKeys('track-duplicate', ['ctrl+d', 'cmd+d']);
    const copyKeys = useShortcutKeys('track-copy', ['ctrl+c', 'cmd+c']);
    const pasteKeys = useShortcutKeys('track-paste', ['ctrl+v', 'cmd+v']);
    const splitKeys = useShortcutKeys('track-slice-playhead', ['k']);
    const deleteKeys = useShortcutKeys('track-delete', ['del', 'backspace']);

    const storeActions = useMemo(() => {
      const state = useVideoEditorStore.getState() as any;
      return {
        removeTrack: state.removeTrack,
        duplicateTrack: state.duplicateTrack,
        splitTrack: state.splitTrack,
        setSelectedTracks: state.setSelectedTracks,
        removeSelectedTracks: state.removeSelectedTracks,
        copyTracks: state.copyTracks,
        pasteTracks: state.pasteTracks,
      };
    }, []);

    const hasMultipleSelected = selectedCount > 1;

    // Derive the boolean INSIDE the selector rather than subscribing to
    // currentFrame and comparing after. There is one of these menus per clip,
    // and subscribing to the raw frame re-rendered every one of them on every
    // playhead tick. The boolean only flips when the playhead crosses this
    // clip's edges, so playback stops re-rendering the menus entirely.
    const canSplit = useVideoEditorStore(
      (state) =>
        state.timeline.currentFrame > track.startFrame &&
        state.timeline.currentFrame < track.endFrame &&
        !track.locked,
    );

    const handleContextMenu = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!isSelected) {
          e.preventDefault();
          storeActions.setSelectedTracks([track.id]);
        }
      },
      [track.id, isSelected, storeActions],
    );

    const handleDuplicateTrack = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        storeActions.duplicateTrack(track.id);
      },
      [track.id, storeActions],
    );

    const handleCopyTrack = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const selectedIds = useVideoEditorStore.getState().timeline.selectedTrackIds;
        const ids = selectedIds.includes(track.id) ? selectedIds : [track.id];
        storeActions.copyTracks(ids);
      },
      [track.id, storeActions],
    );

    const handlePasteTrack = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        storeActions.pasteTracks();
      },
      [storeActions],
    );

    const handleSplitTrack = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (canSplit) {
          // Read the playhead at click time. It is the live value by
          // definition, and it keeps this menu out of the per-tick render path.
          storeActions.splitTrack(
            track.id,
            useVideoEditorStore.getState().timeline.currentFrame,
          );
        }
      },
      [track.id, canSplit, storeActions],
    );

    const handleDeleteTrack = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (hasMultipleSelected) {
          storeActions.removeSelectedTracks();
        } else {
          storeActions.removeTrack(track.id);
        }
      },
      [track.id, hasMultipleSelected, storeActions],
    );

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenu={handleContextMenu}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent
          className="w-52"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ContextMenuItem
            onClick={handleDuplicateTrack}
            disabled={track.locked}
          >
            <Files className="mr-2 h-4 w-4" />
            Duplicate
            <ContextMenuShortcut>
              <ShortcutKbdStack combos={duplicateKeys} />
            </ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuItem
            onClick={handleCopyTrack}
            disabled={track.locked}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy
            <ContextMenuShortcut>
              <ShortcutKbdStack combos={copyKeys} />
            </ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuItem
            onClick={handlePasteTrack}
            disabled={!hasClipboard}
          >
            <Clipboard className="mr-2 h-4 w-4" />
            Paste
            <ContextMenuShortcut>
              <ShortcutKbdStack combos={pasteKeys} />
            </ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem
            onClick={handleSplitTrack}
            disabled={!canSplit || track.locked}
          >
            <Scissors className="mr-2 h-4 w-4" />
            Split
            <ContextMenuShortcut>
              <ShortcutKbdStack combos={splitKeys} />
            </ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem
            onClick={handleDeleteTrack}
            variant="destructive"
            disabled={track.locked}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {hasMultipleSelected ? `Delete ${selectedCount} clips` : 'Delete'}
            <ContextMenuShortcut>
              <ShortcutKbdStack combos={deleteKeys} />
            </ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  },
  (prevProps, nextProps) => {
    const p = prevProps.track;
    const n = nextProps.track;
    return (
      p.id === n.id &&
      p.startFrame === n.startFrame &&
      p.endFrame === n.endFrame &&
      p.locked === n.locked &&
      p.visible === n.visible &&
      p.muted === n.muted &&
      p.type === n.type &&
      prevProps.children === nextProps.children
    );
  },
);

TrackContextMenu.displayName = 'TrackContextMenu';
