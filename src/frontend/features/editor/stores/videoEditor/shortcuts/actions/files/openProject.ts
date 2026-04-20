/**
 * Open Project Action Handler (Ctrl+O)
 * Opens native file dialog to select and load an existing project
 */

import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { toast } from 'sonner';

export const openProjectAction = async (navigate: (path: string) => void) => {
  try {
    // Open file dialog for project files
    const result = await window.electronAPI.openFileDialog({
      title: 'Open Project',
      properties: ['openFile'],
      filters: [
        {
          name: 'Project Files',
          extensions: ['json', 'proj', 'dividr'],
        },
        {
          name: 'All Files',
          extensions: ['*'],
        },
      ],
    });

    if (result.canceled || !result.files || result.files.length === 0) {
      return; // User cancelled
    }

    const filePath = result.files[0].path;

    // Import the project
    const projectStore = useProjectStore.getState();
    await projectStore.openProjectFromPath(filePath);

    // Navigate to video editor
    navigate('/video-editor');

    const openedTitle =
      useProjectStore.getState().currentProject?.metadata.title || 'Project';
    toast.success(`Project "${openedTitle}" opened`);
  } catch (error) {
    console.error('[OpenProject] Failed', error);
    toast.error('Failed to open project');
  }
};
