/**
 * Stub handlers for channels not yet ported to the server.
 *
 * Two kinds:
 *  - "safe defaults": desktop-only concerns (runtime download, window state)
 *    that should resolve harmlessly so the mobile UI boots.
 *  - "explicit not-implemented": real work that still needs porting — these
 *    throw a clear error so it surfaces in the UI instead of failing silently.
 */
import type { Handler } from './index';

type Register = (channel: string, fn: Handler) => void;

// On mobile the heavy runtime lives on the server and is assumed present.
const SAFE_DEFAULTS: Record<string, unknown> = {
  'runtime:status': {
    installed: true,
    version: 'server',
    path: '(server)',
    needsUpdate: false,
    requiredVersion: 'server',
  },
  'runtime:verify': { valid: true },
  'get-io-status': { active: 0, queued: 0 },
  'ffmpeg:status': { available: true },
  'get-hardware-capabilities': {
    success: true,
    capabilities: {
      hasHardwareEncoder: false,
      encoderType: 'server',
      encoderDescription: 'Encoding handled by the Dividr server',
      cpuCores: 0,
      totalRamGB: 0,
      freeRamGB: 0,
      isLowHardware: false,
    },
  },
};

// Channels that genuinely need porting before the feature works on mobile.
const NOT_IMPLEMENTED = [
  'process-dropped-files',
  'read-file',
  'read-file-as-buffer',
  'open-file-dialog',
  'show-save-dialog',
  'show-item-in-folder',
  'get-file-stream',
  'extract-audio-from-video',
  'generate-sprite-sheet-background',
  'ffmpeg:get-duration',
  'getVideoDimensions',
  'media:downloadFromUrl',
  'transcode:start',
];

export function registerStubHandlers(handle: Register, registry: Map<string, Handler>): void {
  for (const [channel, value] of Object.entries(SAFE_DEFAULTS)) {
    if (!registry.has(channel)) handle(channel, async () => value);
  }
  for (const channel of NOT_IMPLEMENTED) {
    if (!registry.has(channel)) {
      handle(channel, async () => {
        throw new Error(
          `[dividr-mobile] channel "${channel}" is not yet ported to the server. ` +
            `See mobile/README.md → "What still needs real work".`,
        );
      });
    }
  }
}
