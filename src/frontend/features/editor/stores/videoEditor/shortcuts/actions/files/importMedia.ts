/**
 * Import Media Action Handler (Ctrl+I)
 * Opens file picker to import media files into the project
 */

import { toast } from 'sonner';

export const importMediaAction = async (
  importMediaFromDialog: () => Promise<{
    success: boolean;
    importedFiles?: Array<{
      id: string;
      name: string;
      type: string;
      size: number;
      url: string;
    }>;
    summary?: {
      importedNew: number;
      importedCopies: number;
      reusedExisting: number;
    };
    canceled?: boolean;
  }>,
) => {
  try {
    const result = await importMediaFromDialog();

    if (result.success && result.importedFiles?.length) {
      const summary = result.summary;
      if (summary) {
        const imported =
          (summary.importedNew || 0) + (summary.importedCopies || 0);
        const reused = summary.reusedExisting || 0;

        if (imported === 0 && reused > 0) {
          toast.success(
            `Used existing media for ${reused} duplicate${reused > 1 ? 's' : ''}`,
          );
        } else {
          toast.success(`Imported ${imported} file${imported > 1 ? 's' : ''}`);
        }
      } else {
        const count = result.importedFiles.length;
        toast.success(`Imported ${count} file${count > 1 ? 's' : ''}`);
      }
    } else if (!result.success && !result.canceled) {
      toast.error('Failed to import media');
    }
    // If canceled, do nothing (user cancelled the dialog)
  } catch (error) {
    console.error('[ImportMedia] Failed', error);
    toast.error('Failed to import media');
  }
};
