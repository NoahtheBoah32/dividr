import { ipcMain } from 'electron';
import {
  cancelDownload,
  checkRuntimeStatus,
  downloadRuntime,
  removeRuntime,
  verifyInstallation,
} from '../../backend/runtime/runtimeDownloadManager';

export function registerRuntimeIpc(): void {
  ipcMain.handle('runtime:status', async () => {
    console.log('[Main] MAIN PROCESS: runtime:status handler called');

    const status = await checkRuntimeStatus();
    console.log('[Main] Runtime status', status);

    return status;
  });

  ipcMain.handle('runtime:download', async (event) => {
    console.log('[Main] MAIN PROCESS: runtime:download handler called');

    try {
      const result = await downloadRuntime((progress) => {
        event.sender.send('runtime:download-progress', progress);
      });

      console.log('[Main] Download result', result);
      return result;
    } catch (error) {
      console.error('[Main] Runtime download failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle('runtime:cancel-download', async () => {
    console.log('[Main] MAIN PROCESS: runtime:cancel-download handler called');

    const result = await cancelDownload();
    return result;
  });

  ipcMain.handle('runtime:verify', async () => {
    console.log('[Main] MAIN PROCESS: runtime:verify handler called');

    const isValid = await verifyInstallation();
    return { valid: isValid };
  });

  ipcMain.handle('runtime:remove', async () => {
    console.log('[Main] MAIN PROCESS: runtime:remove handler called');

    const result = await removeRuntime();
    return result;
  });
}
