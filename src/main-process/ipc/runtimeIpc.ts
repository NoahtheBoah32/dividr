import { ipcMain } from 'electron';
import {
  cancelDownload,
  checkRuntimeStatus,
  downloadRuntime,
  removeRuntime,
  verifyInstallation,
} from '../../backend/runtime/runtimeDownloadManager';
import { IPC_CHANNELS } from '../../shared/ipc/channels';

export function registerRuntimeIpc(): void {
  ipcMain.handle(IPC_CHANNELS.RUNTIME_STATUS, async () => {
    console.log('[Main] MAIN PROCESS: runtime:status handler called');

    const status = await checkRuntimeStatus();
    console.log('[Main] Runtime status', status);

    return status;
  });

  ipcMain.handle(IPC_CHANNELS.RUNTIME_DOWNLOAD, async (event) => {
    console.log('[Main] MAIN PROCESS: runtime:download handler called');

    try {
      const result = await downloadRuntime((progress) => {
        event.sender.send(
          IPC_CHANNELS.EVENT_RUNTIME_DOWNLOAD_PROGRESS,
          progress,
        );
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

  ipcMain.handle(IPC_CHANNELS.RUNTIME_CANCEL_DOWNLOAD, async () => {
    console.log('[Main] MAIN PROCESS: runtime:cancel-download handler called');

    const result = await cancelDownload();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.RUNTIME_VERIFY, async () => {
    console.log('[Main] MAIN PROCESS: runtime:verify handler called');

    const isValid = await verifyInstallation();
    return { valid: isValid };
  });

  ipcMain.handle(IPC_CHANNELS.RUNTIME_REMOVE, async () => {
    console.log('[Main] MAIN PROCESS: runtime:remove handler called');

    const result = await removeRuntime();
    return result;
  });
}
