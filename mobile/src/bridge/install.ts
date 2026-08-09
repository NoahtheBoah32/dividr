/**
 * Attach the browser bridge shims to window BEFORE the shared frontend mounts,
 * so every `window.electronAPI.*` / `window.myceliumAPI.*` / `window.appControl.*`
 * call in ../../../src/frontend resolves to the HTTP/WS-backed implementation.
 */
import { appControl } from './appControl';
import { electronAPI } from './electronAPI';
import { myceliumAPI } from './myceliumAPI';

export function installBridge(): void {
  const w = window as unknown as Record<string, unknown>;
  w.electronAPI = electronAPI;
  w.myceliumAPI = myceliumAPI;
  w.appControl = appControl;
}
