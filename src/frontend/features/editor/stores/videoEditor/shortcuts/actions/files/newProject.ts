/**
 * New Project Action Handler (Ctrl+N)
 * Creates a new blank project and navigates to the editor
 */

import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { toast } from 'sonner';

export const newProjectAction = async (navigate: (path: string) => void) => {
  try {
    const projectStore = useProjectStore.getState();
    const currentProject = projectStore.currentProject;

    // Trigger a read so existing auto-save behavior remains untouched.
    void currentProject;

    // Create a new untitled project
    const projectId = await projectStore.createNewProject('Untitled Project');

    // Open the newly created project
    await projectStore.openProject(projectId);

    // Navigate to video editor
    navigate('/video-editor');

    toast.success('New project created');
  } catch (error) {
    console.error('[New Project] Failed:', error);
    toast.error('Failed to create new project');
  }
};
