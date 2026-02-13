import { ipcMain } from 'electron';
import {
  checkForReleaseUpdates,
  getInstalledReleaseDetails,
  readReleaseUpdateCache,
} from '../../backend/release/releaseUpdateService';

export function registerReleaseIpc(): void {
  ipcMain.handle('release:check-updates', async () => {
    console.log('[Main] MAIN PROCESS: release:check-updates handler called');
    return checkForReleaseUpdates();
  });

  ipcMain.handle('release:get-update-cache', async () => {
    console.log('[Main] MAIN PROCESS: release:get-update-cache handler called');
    return readReleaseUpdateCache();
  });

  ipcMain.handle('release:get-installed-release', async () => {
    console.log(
      '[Main] MAIN PROCESS: release:get-installed-release handler called',
    );
    try {
      return await getInstalledReleaseDetails();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Release lookup failed',
      };
    }
  });
}
