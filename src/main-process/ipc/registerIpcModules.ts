import { registerFfmpegIpc } from './ffmpegIpc';
import { installIpcValidation } from './installIpcValidation';
import { registerReleaseIpc } from './releaseIpc';
import { registerRuntimeIpc } from './runtimeIpc';
import { registerSystemFileIpc } from './systemFileIpc';
import { registerWindowIpc } from './windowIpc';

export function registerIpcModules(): void {
  installIpcValidation();
  registerSystemFileIpc();
  registerFfmpegIpc();
  registerRuntimeIpc();
  registerReleaseIpc();
  registerWindowIpc();
}
