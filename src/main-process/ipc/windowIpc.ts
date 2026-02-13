import { BrowserWindow, ipcMain } from 'electron';
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
  ipcMain.on('close-btn', () => {
    requestRendererExitValidation('custom-close-button');
  });

  ipcMain.on('request-app-exit', (_event, trigger?: string) => {
    requestRendererExitValidation(trigger || 'renderer-request');
  });

  ipcMain.handle('app-exit-decision', async (_event, payload) => {
    return resolveAppExitDecision(payload);
  });

  ipcMain.on('minimize-btn', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('maximize-btn', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('get-maximize-state', () => {
    if (!mainWindow) return false;
    return mainWindow.isMaximized();
  });

  ipcMain.handle(
    'set-titlebar-overlay',
    (
      _event,
      options: { color?: string; symbolColor?: string; height?: number },
    ) => {
      applyTitlebarOverlay(options);
      return process.platform === 'win32' && !!mainWindow;
    },
  );

  ipcMain.handle('set-window-fullscreen', (_event, isFullscreen: boolean) => {
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
  });

  ipcMain.handle('media:ensure-server', async () => {
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
    'startup:mark',
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

  ipcMain.handle('startup:get-state', async () => {
    return getStartupState();
  });
}
