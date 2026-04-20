import { ipcMain } from 'electron';
import {
  checkForReleaseUpdates,
  getInstalledReleaseDetails,
  readReleaseUpdateCache,
} from '../../backend/release/releaseUpdateService';
import { IPC_CHANNELS } from '../../shared/ipc/channels';

export function registerReleaseIpc(): void {
  ipcMain.handle(IPC_CHANNELS.RELEASE_CHECK_UPDATES, async () => {
    console.log('[Main] MAIN PROCESS: release:check-updates handler called');
    return checkForReleaseUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.RELEASE_GET_UPDATE_CACHE, async () => {
    console.log('[Main] MAIN PROCESS: release:get-update-cache handler called');
    return readReleaseUpdateCache();
  });

  ipcMain.handle(IPC_CHANNELS.RELEASE_GET_INSTALLED_RELEASE, async () => {
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
