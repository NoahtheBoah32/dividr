/**
 * WebSocket event hub. The desktop sends streaming updates via
 * `mainWindow.webContents.send(channel, payload)`; here we broadcast the same
 * (channel, args) frames to every connected phone over a single /events socket.
 *
 * Handlers receive an `emit` bound to this hub so they can stream progress
 * (ffmpeg-progress, whisper:progress, mycelium:op, …) exactly as the desktop does.
 */
import type { WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
}

/** Mirror of webContents.send(channel, ...args) → broadcast to all clients. */
export function emit(channel: string, ...args: unknown[]): void {
  const frame = JSON.stringify({ channel, args });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
}

export type Emit = typeof emit;
