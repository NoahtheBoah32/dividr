import { registerFfmpegIpc } from './ffmpegIpc';
import { registerReleaseIpc } from './releaseIpc';
import { registerRuntimeIpc } from './runtimeIpc';
import { registerSystemFileIpc } from './systemFileIpc';
import { registerWindowIpc } from './windowIpc';

export function registerIpcModules(): void {
  registerSystemFileIpc();
  registerFfmpegIpc();
  registerRuntimeIpc();
  registerReleaseIpc();
  registerWindowIpc();
}
