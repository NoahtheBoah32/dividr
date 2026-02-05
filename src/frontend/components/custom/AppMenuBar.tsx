import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/frontend/components/ui/menubar';
import { ShortcutKbdStack } from '@/frontend/features/editor/shortcuts/ShortcutKbdStack';
import { useShortcutKeys } from '@/frontend/features/editor/shortcuts/shortcutHooks';
import { normalizeKeyList } from '@/frontend/features/editor/shortcuts/shortcutUtils';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor/index';
import {
  closeProjectAction,
  copyTracksAction,
  cutTracksAction,
  deselectAllTracksAction,
  duplicateTracksAction,
  exportVideoAction,
  importMediaAction,
  newProjectAction,
  openProjectAction,
  pasteTracksAction,
  redoAction,
  saveProjectAction,
  saveProjectAsAction,
  selectAllTracksAction,
  undoAction,
} from '@/frontend/features/editor/stores/videoEditor/shortcuts/actions';
import { useProjectShortcutDialog } from '@/frontend/features/editor/stores/videoEditor/shortcuts/hooks/useProjectShortcutDialog';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { Check } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HotkeysDialog } from './HotkeysDialog';

const AppMenuBarComponent = () => {
  const [showHotkeys, setShowHotkeys] = useState(false);
  const navigate = useNavigate();
  const importMediaFromDialog = useVideoEditorStore(
    (state) => state.importMediaFromDialog,
  );
  const tracks = useVideoEditorStore((state) => state.tracks);
  const tracksLength = tracks.length;

  // Undo/Redo state
  const undo = useVideoEditorStore((state) => state.undo);
  const redo = useVideoEditorStore((state) => state.redo);
  const canUndo = useVideoEditorStore((state) => state.canUndo);
  const canRedo = useVideoEditorStore((state) => state.canRedo);

  // Track selection state
  const setSelectedTracks = useVideoEditorStore(
    (state) => state.setSelectedTracks,
  );
  const selectedTrackIds = useVideoEditorStore(
    (state) => state.timeline.selectedTrackIds,
  );
  const selectedTrackIdsLength = selectedTrackIds.length;

  // Clipboard state
  const copyTracks = useVideoEditorStore((state) => state.copyTracks);
  const cutTracks = useVideoEditorStore((state) => state.cutTracks);
  const pasteTracks = useVideoEditorStore((state) => state.pasteTracks);
  const hasClipboardData = useVideoEditorStore(
    (state) => state.hasClipboardData,
  );
  const duplicateTrack = useVideoEditorStore((state) => state.duplicateTrack);
  const removeSelectedTracks = useVideoEditorStore(
    (state) => state.removeSelectedTracks,
  );

  // Project save state
  const { lastSavedAt, isSaving, currentProject } = useProjectStore();

  // Check if project is saved (saved within last 5 seconds means "just saved")
  const isProjectSaved = useMemo(() => {
    if (!lastSavedAt || !currentProject) return false;
    const timeSinceLastSave = Date.now() - new Date(lastSavedAt).getTime();
    return timeSinceLastSave < 5000; // Consider "saved" if within 5 seconds
  }, [lastSavedAt, currentProject]);

  // Setup confirmation dialog for close project
  const { showConfirmation, ConfirmationDialog } = useProjectShortcutDialog();

  const handleOpenHotkeys = useCallback(() => {
    setShowHotkeys(true);
  }, []);

  const newProjectKeys = useShortcutKeys('project-new', ['ctrl+n', 'cmd+n']);
  const openProjectKeys = useShortcutKeys('project-open', ['ctrl+o', 'cmd+o']);
  const saveProjectKeys = useShortcutKeys('project-save', ['ctrl+s', 'cmd+s']);
  const saveProjectAsKeys = useShortcutKeys('project-save-as', [
    'ctrl+shift+s',
    'cmd+shift+s',
  ]);
  const importMediaKeys = useShortcutKeys('project-import', [
    'ctrl+i',
    'cmd+i',
  ]);
  const exportVideoKeys = useShortcutKeys('project-export', [
    'ctrl+e',
    'cmd+e',
  ]);
  const closeProjectKeys = useShortcutKeys('project-close', [
    'ctrl+w',
    'cmd+w',
  ]);
  const undoKeys = useShortcutKeys('undo', ['ctrl+z', 'cmd+z']);
  const redoShiftKeys = useShortcutKeys('redo-shift', [
    'ctrl+shift+z',
    'cmd+shift+z',
  ]);
  const redoAltKeys = useShortcutKeys('redo-y', ['ctrl+y', 'cmd+y']);
  const redoKeys = useMemo(
    () => normalizeKeyList([...redoShiftKeys, ...redoAltKeys]),
    [redoShiftKeys, redoAltKeys],
  );
  const cutKeys = useShortcutKeys('track-cut', ['ctrl+x', 'cmd+x']);
  const copyKeys = useShortcutKeys('track-copy', ['ctrl+c', 'cmd+c']);
  const pasteKeys = useShortcutKeys('track-paste', ['ctrl+v', 'cmd+v']);
  const duplicateKeys = useShortcutKeys('track-duplicate', ['ctrl+d', 'cmd+d']);
  const deleteKeys = useShortcutKeys('track-delete', ['del', 'backspace']);
  const selectAllKeys = useShortcutKeys('timeline-select-all', [
    'ctrl+a',
    'cmd+a',
  ]);

  const handleCloseHotkeys = useCallback((open: boolean) => {
    setShowHotkeys(open);
  }, []);

  // Project action handlers - memoized to prevent re-creation
  const handleNewProject = useCallback(() => {
    newProjectAction(navigate).catch(console.error);
  }, [navigate]);

  const handleOpenProject = useCallback(() => {
    openProjectAction(navigate).catch(console.error);
  }, [navigate]);

  const handleSaveProject = useCallback(() => {
    saveProjectAction().catch(console.error);
  }, []);

  const handleSaveProjectAs = useCallback(() => {
    saveProjectAsAction().catch(console.error);
  }, []);

  const handleImportMedia = useCallback(() => {
    importMediaAction(importMediaFromDialog).catch(console.error);
  }, [importMediaFromDialog]);

  const handleExportVideo = useCallback(() => {
    exportVideoAction(tracksLength);
  }, [tracksLength]);

  const handleCloseProject = useCallback(() => {
    closeProjectAction(navigate, showConfirmation).catch(console.error);
  }, [navigate, showConfirmation]);

  // Edit action handlers - memoized to prevent re-creation
  const handleUndo = useCallback(() => {
    undoAction(undo, canUndo);
  }, [undo, canUndo]);

  const handleRedo = useCallback(() => {
    redoAction(redo, canRedo);
  }, [redo, canRedo]);

  const handleSelectAll = useCallback(() => {
    selectAllTracksAction(tracks, setSelectedTracks);
  }, [tracks, setSelectedTracks]);

  const handleDeselectAll = useCallback(() => {
    deselectAllTracksAction(setSelectedTracks, selectedTrackIds);
  }, [setSelectedTracks, selectedTrackIds]);

  // Clipboard action handlers - memoized to prevent re-creation
  const handleCopy = useCallback(() => {
    copyTracksAction(selectedTrackIds, copyTracks);
  }, [selectedTrackIds, copyTracks]);

  const handleCut = useCallback(() => {
    cutTracksAction(selectedTrackIds, cutTracks);
  }, [selectedTrackIds, cutTracks]);

  const handlePaste = useCallback(() => {
    pasteTracksAction(hasClipboardData, pasteTracks);
  }, [hasClipboardData, pasteTracks]);

  const handleDuplicate = useCallback(() => {
    duplicateTracksAction(
      selectedTrackIds,
      tracks,
      duplicateTrack,
      setSelectedTracks,
    );
  }, [selectedTrackIds, tracks, duplicateTrack, setSelectedTracks]);

  const handleDelete = useCallback(() => {
    if (selectedTrackIds.length === 0) {
      return;
    }
    removeSelectedTracks();
  }, [selectedTrackIds.length, removeSelectedTracks]);

  return (
    <div className="flex items-center">
      <Menubar variant="minimal">
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <Link to="/">
              <MenubarItem>Home</MenubarItem>
            </Link>
            <MenubarItem onClick={handleNewProject}>
              New Project{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={newProjectKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handleOpenProject}>
              Open Project{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={openProjectKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              onClick={handleSaveProject}
              disabled={isProjectSaved || isSaving || !currentProject}
            >
              <span className="flex items-center gap-2 flex-1">
                Save Project
                {isProjectSaved && (
                  <Check className="size-3.5 text-green-500" />
                )}
                {isSaving && (
                  <span className="text-xs text-muted-foreground">
                    Saving...
                  </span>
                )}
              </span>
              <MenubarShortcut>
                <ShortcutKbdStack combos={saveProjectKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handleSaveProjectAs}>
              Save As...{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={saveProjectAsKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={handleImportMedia}>
              Import Media{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={importMediaKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handleExportVideo}>
              Export Video{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={exportVideoKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={handleCloseProject}>
              Close Project{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={closeProjectKeys} />
              </MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={handleUndo} disabled={!canUndo()}>
              Undo{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={undoKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handleRedo} disabled={!canRedo()}>
              Redo{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={redoKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              onClick={handleCut}
              disabled={selectedTrackIdsLength === 0}
            >
              Cut{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={cutKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              onClick={handleCopy}
              disabled={selectedTrackIdsLength === 0}
            >
              Copy{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={copyKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={handlePaste} disabled={!hasClipboardData()}>
              Paste{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={pasteKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              onClick={handleDuplicate}
              disabled={selectedTrackIdsLength === 0}
            >
              Duplicate{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={duplicateKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              onClick={handleDelete}
              disabled={selectedTrackIdsLength === 0}
            >
              Delete{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={deleteKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              onClick={handleSelectAll}
              disabled={tracksLength === 0}
            >
              Select All{' '}
              <MenubarShortcut>
                <ShortcutKbdStack combos={selectAllKeys} />
              </MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              onClick={handleDeselectAll}
              disabled={selectedTrackIdsLength === 0}
            >
              Deselect All
            </MenubarItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger disabled>Timeline</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarItem disabled>Split Clip</MenubarItem>
                <MenubarItem disabled>Merge Clips</MenubarItem>
                <MenubarItem disabled>Trim Start</MenubarItem>
                <MenubarItem disabled>Trim End</MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Settings</MenubarTrigger>
          <MenubarContent>
            <MenubarCheckboxItem disabled>
              Auto-save Projects
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked disabled>
              Show Timeline Grid
            </MenubarCheckboxItem>
            <MenubarCheckboxItem disabled>Snap to Grid</MenubarCheckboxItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger disabled>Playback Quality</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarRadioGroup value="high">
                  <MenubarRadioItem value="low" disabled>
                    Low
                  </MenubarRadioItem>
                  <MenubarRadioItem value="medium" disabled>
                    Medium
                  </MenubarRadioItem>
                  <MenubarRadioItem value="high" disabled>
                    High
                  </MenubarRadioItem>
                  <MenubarRadioItem value="ultra" disabled>
                    Ultra
                  </MenubarRadioItem>
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarItem disabled>Preferences...</MenubarItem>
            <MenubarItem disabled>Reset to Defaults</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Help</MenubarTrigger>
          <MenubarContent>
            <MenubarItem disabled>User Guide</MenubarItem>
            <MenubarItem disabled>Video Tutorials</MenubarItem>
            <MenubarItem onClick={handleOpenHotkeys}>
              Keyboard Shortcuts
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled>Report Bug</MenubarItem>
            <MenubarItem disabled>Feature Request</MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled>About Dividr</MenubarItem>
            <MenubarItem disabled>Check for Updates</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <HotkeysDialog open={showHotkeys} onOpenChange={handleCloseHotkeys} />
      <ConfirmationDialog />
    </div>
  );
};

AppMenuBarComponent.displayName = 'AppMenuBar';

export const AppMenuBar = AppMenuBarComponent;
