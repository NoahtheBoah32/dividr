export const hasPendingUnsavedChanges = (
  hasUnsavedChanges: boolean,
  isSaving: boolean,
): boolean => hasUnsavedChanges || isSaving;
