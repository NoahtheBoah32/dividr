/**
 * Transport for the mobile bridge.
 *
 * Desktop Dividr reaches the backend through Electron IPC:
 *   ipcRenderer.invoke(channel, ...args)   -> request/response
 *   ipcRenderer.on(channel, listener)      -> streaming events
 *
 * On mobile there is no IPC, so:
 *   invoke()  -> POST /api/invoke   (JSON request/response)
 *   on()      -> a single WebSocket /events stream, demuxed by channel
 *
 * This file is the only place that knows about HTTP/WS. The electronAPI /
 * myceliumAPI / appControl shims are written purely in terms of invoke()/on().
 */

const SERVER =
  (import.meta as any).env?.VITE_DIVIDR_SERVER?.replace(/\/$/, '') ||
  window.location.origin;

const WS_URL = SERVER.replace(/^http/, 'ws') + '/events';

type Listener = (...args: unknown[]) => void;

/** channel -> set of listeners registered via electronAPI.on(channel, cb) */
const channelListeners = new Map<string, Set<Listener>>();

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(WS_URL);

  socket.onmessage = (evt) => {
    // Server frames: { channel: string, args: unknown[] }
    try {
      const { channel, args } = JSON.parse(evt.data as string);
      const set = channelListeners.get(channel);
      if (set) for (const l of set) l(...(args ?? []));
    } catch {
      /* ignore malformed frame */
    }
  };

  socket.onclose = () => {
    socket = null;
    // Auto-reconnect with a small backoff so long-running jobs survive flaky mobile networks.
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (channelListeners.size > 0) ensureSocket();
      }, 1500);
    }
  };

  socket.onerror = () => socket?.close();
}

/** Request/response over HTTP — mirror of ipcRenderer.invoke. */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`${SERVER}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`invoke(${channel}) failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/** Subscribe to a streaming channel — mirror of ipcRenderer.on. */
export function on(channel: string, listener: Listener): void {
  let set = channelListeners.get(channel);
  if (!set) channelListeners.set(channel, (set = new Set()));
  set.add(listener);
  ensureSocket();
}

export function removeListener(channel: string, listener: Listener): void {
  channelListeners.get(channel)?.delete(listener);
}

export function removeAllListeners(channel: string): void {
  channelListeners.delete(channel);
}

export { SERVER };
