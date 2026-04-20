import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc/channels';
import {
  MEDIA_SERVER_PORT,
  applyTitlebarOverlay,
  ensureMediaServer,
  getStartupState,
  kickoffDeferredInitialization,
  mainWindow,
  markStartupPhase,
  requestRendererExitValidation,
  resolveAppExitDecision,
} from '../mainProcessApp';

export function registerWindowIpc(): void {
  ipcMain.on(IPC_CHANNELS.CLOSE_BTN, () => {
    requestRendererExitValidation('custom-close-button');
  });

  ipcMain.on(IPC_CHANNELS.REQUEST_APP_EXIT, (_event, trigger?: string) => {
    requestRendererExitValidation(trigger || 'renderer-request');
  });

  ipcMain.handle(IPC_CHANNELS.APP_EXIT_DECISION, async (_event, payload) => {
    return resolveAppExitDecision(payload);
  });

  ipcMain.on(IPC_CHANNELS.MINIMIZE_BTN, () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on(IPC_CHANNELS.MAXIMIZE_BTN, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_MAXIMIZE_STATE, () => {
    if (!mainWindow) return false;
    return mainWindow.isMaximized();
  });

  ipcMain.handle(
    IPC_CHANNELS.SET_TITLEBAR_OVERLAY,
    (
      _event,
      options: { color?: string; symbolColor?: string; height?: number },
    ) => {
      applyTitlebarOverlay(options);
      return process.platform === 'win32' && !!mainWindow;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SET_WINDOW_FULLSCREEN,
    (_event, isFullscreen: boolean) => {
      if (!mainWindow) return false;
      const nextState = Boolean(isFullscreen);
      if (process.platform === 'darwin') {
        const macWindow = mainWindow as BrowserWindow & {
          setSimpleFullScreen?: (v: boolean) => void;
        };
        if (typeof macWindow.setSimpleFullScreen === 'function') {
          macWindow.setSimpleFullScreen(nextState);
        } else {
          mainWindow.setFullScreen(nextState);
        }
        return true;
      }

      mainWindow.setFullScreen(nextState);
      return true;
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEDIA_ENSURE_SERVER, async () => {
    try {
      await ensureMediaServer();
      return { success: true, port: MEDIA_SERVER_PORT };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to start server',
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.STARTUP_MARK,
    async (_event, phase: string, meta?: Record<string, unknown>) => {
      if (typeof phase === 'string' && phase.length > 0) {
        markStartupPhase(phase, meta);
        if (phase === 'app-ready' || phase === 'ui-interactive') {
          kickoffDeferredInitialization('ui-interactive');
        }
      }

      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.STARTUP_GET_STATE, async () => {
    return getStartupState();
  });
}
