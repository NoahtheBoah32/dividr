import { dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/ipc/channels';

export function registerSystemFileIpc(): void {
  // IPC Handler for opening file dialog
  ipcMain.handle(
    IPC_CHANNELS.OPEN_FILE_DIALOG,
    async (
      event,
      options?: {
        title?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
      },
    ) => {
      try {
        const result = await dialog.showOpenDialog({
          title: options?.title || 'Select Media Files',
          properties: options?.properties || ['openFile', 'multiSelections'],
          filters: options?.filters || [
            {
              name: 'Media Files',
              extensions: [
                'mp4',
                'avi',
                'mov',
                'mkv',
                'mp3',
                'wav',
                'aac',
                'jpg',
                'jpeg',
                'png',
                'gif',
              ],
            },
            {
              name: 'Video Files',
              extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv', 'flv'],
            },
            {
              name: 'Audio Files',
              extensions: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'],
            },
            {
              name: 'Image Files',
              extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'],
            },
            { name: 'All Files', extensions: ['*'] },
          ],
        });

        if (!result.canceled && result.filePaths.length > 0) {
          // Get file info for each selected file
          const fileInfos = result.filePaths.map((filePath) => {
            const stats = fs.statSync(filePath);
            const fileName = path.basename(filePath);
            const ext = path.extname(fileName).toLowerCase().slice(1);

            // Determine file type based on extension
            let type: 'video' | 'audio' | 'image' = 'video';
            if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(ext)) {
              type = 'audio';
            } else if (
              ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'].includes(ext)
            ) {
              type = 'image';
            }

            return {
              path: filePath,
              name: fileName,
              size: stats.size,
              type,
              extension: ext,
            };
          });

          return { success: true, files: fileInfos };
        } else {
          return { success: false, canceled: true };
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  // IPC Handler for save dialog
  ipcMain.handle(
    IPC_CHANNELS.SHOW_SAVE_DIALOG,
    async (
      event,
      options?: {
        title?: string;
        defaultPath?: string;
        buttonLabel?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
      },
    ) => {
      try {
        const result = await dialog.showSaveDialog({
          title: options?.title || 'Save Video As',
          defaultPath:
            options?.defaultPath || path.join(os.homedir(), 'Downloads'),
          buttonLabel: options?.buttonLabel || 'Save',
          filters: options?.filters || [
            {
              name: 'Video Files',
              extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv'],
            },
            {
              name: 'All Files',
              extensions: ['*'],
            },
          ],
        });

        if (result.canceled) {
          return { success: false, canceled: true };
        }

        return {
          success: true,
          filePath: result.filePath,
          directory: path.dirname(result.filePath || ''),
          filename: path.basename(result.filePath || ''),
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  // IPC Handler for getting downloads directory
  ipcMain.handle(IPC_CHANNELS.GET_DOWNLOADS_DIRECTORY, async () => {
    try {
      return {
        success: true,
        path: path.join(os.homedir(), 'Downloads'),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // IPC Handler for showing file in folder/explorer
  ipcMain.handle(
    IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    async (event, filePath: string) => {
      try {
        if (!filePath) {
          return { success: false, error: 'No file path provided' };
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'File not found' };
        }

        // Show item in folder (works cross-platform)
        shell.showItemInFolder(filePath);

        console.log('[Main] Opened file location', filePath);
        return { success: true };
      } catch (error) {
        console.error('[Main] Failed to show file in folder', error);
        return { success: false, error: error.message };
      }
    },
  );
}
