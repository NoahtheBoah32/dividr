/**
 * Channel → handler registry.
 *
 * Each handler has the shape (args: unknown[], ctx) => Promise<unknown>, where
 * the channel name and argument order match exactly what the desktop registered
 * with `ipcMain.handle(channel, ...)`. The bridge on the phone calls
 * invoke(channel, ...args); this registry is the server-side equivalent of the
 * desktop's ipcMain handlers.
 */
import type { Emit } from '../events';
import { registerFfmpegHandlers } from './ffmpeg';
import { registerFileHandlers } from './files';
import { registerMediaToolsHandlers } from './mediaTools';
import { registerMyceliumHandlers } from './mycelium';
import { registerStubHandlers } from './stubs';
import { registerWhisperHandlers } from './whisper';

export interface HandlerCtx {
  emit: Emit;
}
export type Handler = (args: unknown[], ctx: HandlerCtx) => Promise<unknown>;

const registry = new Map<string, Handler>();

export function handle(channel: string, fn: Handler): void {
  registry.set(channel, fn);
}

export function getHandler(channel: string): Handler | undefined {
  return registry.get(channel);
}

// Wire all handler groups. Order matters only for stubs (registered last so they
// fill in any channel a real group didn't claim).
registerFfmpegHandlers(handle);
registerWhisperHandlers(handle);
registerMediaToolsHandlers(handle);
registerMyceliumHandlers(handle);
registerFileHandlers(handle);
registerStubHandlers(handle, registry);
