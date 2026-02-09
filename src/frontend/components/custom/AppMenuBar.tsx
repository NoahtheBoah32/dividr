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
import AboutDialog from '@/frontend/features/about/About';
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
import { normalizeAutoSavePreferences } from '@/frontend/features/editor/stores/videoEditor/slices/projectSlice';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { Check } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { HotkeysDialog } from './HotkeysDialog';
import { PreferencesDialog } from './PreferencesDialog';

const AppMenuBarComponent = () => {
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
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
  const autoSavePreferences = useVideoEditorStore(
    (state) => state.autoSavePreferences,
  );
  const setAutoSavePreferences = useVideoEditorStore(
    (state) => state.setAutoSavePreferences,
  );
  const editorCurrentProjectId = useVideoEditorStore(
    (state) => state.currentProjectId,
  );
  const editorLastSavedAt = useVideoEditorStore((state) => state.lastSavedAt);
  const editorIsSaving = useVideoEditorStore((state) => state.isSaving);
  const hasUnsavedChanges = useVideoEditorStore(
    (state) => state.hasUnsavedChanges,
  );

  // Project save state
  const currentProject = useProjectStore((state) => state.currentProject);

  // Use both active project metadata and editor dirty state to avoid false "Saved"
  // indicators when switching between multiple projects.
  const isProjectSaved = useMemo(() => {
    if (!currentProject || !editorCurrentProjectId) return false;
    if (currentProject.id !== editorCurrentProjectId) return false;
    if (hasUnsavedChanges || editorIsSaving) return false;

    const editorSavedAtMs = editorLastSavedAt
      ? new Date(editorLastSavedAt).getTime()
      : Number.NaN;
    if (!Number.isFinite(editorSavedAtMs)) return false;

    const metadataUpdatedAtMs = currentProject.metadata?.updatedAt
      ? new Date(currentProject.metadata.updatedAt).getTime()
      : Number.NaN;

    if (!Number.isFinite(metadataUpdatedAtMs)) {
      return true;
    }

    return editorSavedAtMs >= metadataUpdatedAtMs;
  }, [
    currentProject,
    editorCurrentProjectId,
    hasUnsavedChanges,
    editorIsSaving,
    editorLastSavedAt,
  ]);

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

  const handleOpenAbout = useCallback(() => {
    setShowAbout(true);
  }, [navigate]);

  const normalizedAutoSavePreferences = useMemo(
    () => normalizeAutoSavePreferences(autoSavePreferences),
    [autoSavePreferences],
  );

  const handleOpenPreferences = useCallback(() => {
    setShowPreferences(true);
  }, []);

  const handleAutoSaveToggle = useCallback(
    (checked: boolean | 'indeterminate') => {
      setAutoSavePreferences({ enabled: checked === true });
    },
    [setAutoSavePreferences],
  );

  const handleCheckUpdates = useCallback(async () => {
    try {
      toast.promise(window.electronAPI.releaseCheckForUpdates(), {
        loading: 'Checking for updates...',
        success: (result) =>
          result.updateAvailable
            ? `Update available: v${result.latest?.latestVersion}`
            : 'DiviDr is up to date',
        error: (error) =>
          error instanceof Error ? error.message : 'Update check failed',
      });
    } catch (error) {
      console.warn('Update check failed:', error);
    }
  }, []);

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
              disabled={
                isProjectSaved ||
                editorIsSaving ||
                !currentProject ||
                currentProject.id !== editorCurrentProjectId
              }
            >
              <span className="flex items-center gap-2 flex-1">
                Save Project
                {isProjectSaved && (
                  <Check className="size-3.5 text-green-500" />
                )}
                {editorIsSaving && (
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
            <MenubarCheckboxItem
              checked={normalizedAutoSavePreferences.enabled}
              onCheckedChange={handleAutoSaveToggle}
            >
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
            <MenubarItem onClick={handleOpenPreferences}>
              Preferences...
            </MenubarItem>
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
            <MenubarItem onClick={handleOpenAbout}>About DiviDr</MenubarItem>
            <MenubarItem onClick={handleCheckUpdates}>
              Check for Updates
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <HotkeysDialog open={showHotkeys} onOpenChange={handleCloseHotkeys} />
      <AboutDialog open={showAbout} onOpenChange={setShowAbout} />
      <PreferencesDialog
        open={showPreferences}
        onOpenChange={setShowPreferences}
      />
      <ConfirmationDialog />
    </div>
  );
};

AppMenuBarComponent.displayName = 'AppMenuBar';

export const AppMenuBar = AppMenuBarComponent;
