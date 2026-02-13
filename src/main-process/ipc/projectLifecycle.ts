import { app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc/channels';
import { mainWindow, setPendingFilePath } from '../mainProcessApp';

function getFileFromArgs(args: string[] = process.argv): string | null {
  const fileArgs = args.slice(1);
  for (const arg of fileArgs) {
    if (
      arg.endsWith('.dividr') &&
      !arg.startsWith('-') &&
      !arg.startsWith('--')
    ) {
      return arg;
    }
  }
  return null;
}

export function registerProjectLifecycleEvents(): void {
  setPendingFilePath(getFileFromArgs());

  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    app.quit();
    return;
  }

  app.on('second-instance', (_event, commandLine) => {
    if (!mainWindow) return;

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();

    const filePath = getFileFromArgs(commandLine);
    if (filePath) {
      mainWindow.webContents.send(
        IPC_CHANNELS.EVENT_OPEN_PROJECT_FILE,
        filePath,
      );
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!filePath.endsWith('.dividr')) return;

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send(
        IPC_CHANNELS.EVENT_OPEN_PROJECT_FILE,
        filePath,
      );
      return;
    }

    setPendingFilePath(filePath);
  });
}
