import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { toast } from 'sonner';

export const saveProjectAction = async () => {
  try {
    const videoEditorStore = useVideoEditorStore.getState();
    const { currentProjectId, lastSavedAt, saveProjectData } = videoEditorStore;

    if (!currentProjectId) {
      toast.info('No project open to save');
      return;
    }

    // Check if already saved recently (within 2 seconds)
    if (lastSavedAt) {
      const timeSinceLastSave = Date.now() - new Date(lastSavedAt).getTime();
      if (timeSinceLastSave < 2000) {
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
    console.error('[Save Project] Failed:', error);
    toast.error('Failed to save project');
  }
};
