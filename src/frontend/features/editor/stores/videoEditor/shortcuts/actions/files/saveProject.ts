import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { toast } from 'sonner';

export const saveProjectAction = async () => {
  try {
    const videoEditorStore = useVideoEditorStore.getState();
    const {
      currentProjectId,
      hasUnsavedChanges,
      isSaving,
      lastSavedAt,
      saveProjectData,
    } = videoEditorStore;
    const currentProject = useProjectStore.getState().currentProject;

    if (!currentProjectId) {
      toast.info('No project open to save');
      return;
    }

    if (isSaving) {
      toast.info('Save already in progress');
      return;
    }

    if (
      currentProject &&
      currentProject.id === currentProjectId &&
      !hasUnsavedChanges
    ) {
      const editorSavedAtMs = lastSavedAt
        ? new Date(lastSavedAt).getTime()
        : Number.NaN;
      const metadataUpdatedAtMs = currentProject.metadata?.updatedAt
        ? new Date(currentProject.metadata.updatedAt).getTime()
        : Number.NaN;

      const isMetadataAligned =
        !Number.isFinite(metadataUpdatedAtMs) ||
        (Number.isFinite(editorSavedAtMs) &&
          editorSavedAtMs >= metadataUpdatedAtMs);

      if (isMetadataAligned) {
        toast.success('💾 Project already saved', {
          duration: 1500,
        });
        return;
      }
    }

    // Force an immediate save
    await saveProjectData();

    // Show feedback with disk icon
    toast.success('💾 All changes saved', {
      duration: 2000,
    });
  } catch (error) {
    console.error('[SaveProject] Failed', error);
    toast.error('Failed to save project');
  }
};
