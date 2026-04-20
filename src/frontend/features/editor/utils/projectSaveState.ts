import { ProjectData } from '@/shared/types/project.types';

export interface ProjectSaveStateInput {
  currentProject: ProjectData | null;
  editorCurrentProjectId: string | null;
  hasUnsavedChanges: boolean;
  isSaving: boolean;
  lastSavedAt: string | null;
}

export const isEditorProjectMetadataAligned = ({
  currentProject,
  editorCurrentProjectId,
  hasUnsavedChanges,
  isSaving,
  lastSavedAt,
}: ProjectSaveStateInput): boolean => {
  if (!editorCurrentProjectId) return false;
  if (!currentProject) return false;
  if (currentProject.id !== editorCurrentProjectId) return false;
  if (hasUnsavedChanges || isSaving) return false;

  const editorSavedAtMs = lastSavedAt
    ? new Date(lastSavedAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(editorSavedAtMs)) return false;

  const metadataUpdatedAtMs = currentProject.metadata?.updatedAt
    ? new Date(currentProject.metadata.updatedAt).getTime()
    : Number.NaN;

  if (!Number.isFinite(metadataUpdatedAtMs)) {
    return true;
  }

  return editorSavedAtMs >= metadataUpdatedAtMs;
};

export const shouldBlockEditorQuit = (
  state: ProjectSaveStateInput,
): boolean => {
  if (state.isSaving || state.hasUnsavedChanges) return true;

  // No active project in editor means nothing to protect.
  if (!state.editorCurrentProjectId) return false;

  // Be conservative when project context can't be matched reliably.
  if (!state.currentProject) return true;
  if (state.currentProject.id !== state.editorCurrentProjectId) return true;

  return !isEditorProjectMetadataAligned(state);
};
