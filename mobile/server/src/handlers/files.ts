/**
 * File I/O channels.
 *
 * The desktop deals in local file paths. On mobile the phone has no shared
 * filesystem with the server, so media must be uploaded first (see the
 * /api/upload route in index.ts) and is then referenced by its server-side path.
 *
 * These handlers operate on those server-side paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Handler } from './index';

type Register = (channel: string, fn: Handler) => void;

// Where uploaded media + render outputs live on the server.
export const MEDIA_ROOT = process.env.DIVIDR_MEDIA_ROOT || path.join(os.tmpdir(), 'dividr-mobile');
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

export function registerFileHandlers(handle: Register): void {
  // create-preview-url: desktop returns a base64/file URL for a local path.
  // On mobile we serve uploaded files over /media/<name>, so return that URL.
  handle('create-preview-url', async ([filePath]) => {
    const name = path.basename(filePath as string);
    return { success: true, url: `/media/${encodeURIComponent(name)}` };
  });

  handle('media-path-exists', async ([p]) => {
    try {
      return fs.existsSync(p as string);
    } catch {
      return false;
    }
  });

  handle('get-media-cache-dir', async () => MEDIA_ROOT);
  handle('get-downloads-directory', async () => MEDIA_ROOT);

  handle('delete-file', async ([filePath]) => {
    try {
      await fs.promises.unlink(filePath as string);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  handle('cleanup-temp-files', async ([filePaths]) => {
    for (const f of (filePaths as string[]) ?? []) {
      await fs.promises.unlink(f).catch(() => undefined);
    }
    return { success: true };
  });

  handle('write-subtitle-file', async ([options]) => {
    const { content, filename } = options as { content: string; filename: string };
    const out = path.join(MEDIA_ROOT, path.basename(filename));
    await fs.promises.writeFile(out, content, 'utf8');
    return { success: true, path: out };
  });

  // TODO: process-dropped-files / read-file(-as-buffer) / open-file-dialog map to
  // the upload + share flows; stub.ts covers them until the upload UI is wired.
}
