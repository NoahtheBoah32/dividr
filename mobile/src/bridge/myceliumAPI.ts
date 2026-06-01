/**
 * Browser implementation of `window.myceliumAPI` — the FRIDAY/ARTHUR/EDITH agent.
 * Mirrors ../../../src/preload.ts. The agent runs on the server (it spawns the
 * Claude CLI), and streams messages/ops back over the WS event channel.
 */
import { invoke, on, removeAllListeners } from './transport';

type AnyFn = (...args: unknown[]) => void;

export const myceliumAPI = {
  sendMessage: (payload: { text: string }) => invoke('mycelium:sendMessage', payload),
  pause: () => invoke('mycelium:pause'),
  resume: () => invoke('mycelium:resume'),
  stop: () => invoke('mycelium:stop'),
  onMessage: (cb: (data: { role: string; text: string }) => void) =>
    on('mycelium:message', cb as AnyFn),
  onOp: (cb: (op: unknown) => void) => on('mycelium:op', cb as AnyFn),
  onDone: (cb: () => void) => on('mycelium:done', cb as AnyFn),
  removeAllListeners: () => {
    removeAllListeners('mycelium:message');
    removeAllListeners('mycelium:op');
    removeAllListeners('mycelium:done');
  },
};

export type MyceliumAPI = typeof myceliumAPI;
