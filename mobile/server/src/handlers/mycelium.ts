/**
 * FRIDAY / ARTHUR / EDITH agent channels.
 *
 * The desktop agent (../../../../src/backend/mycelium/agentRuntime.ts) streams
 * messages/ops back through `win.webContents.send(channel, payload)`. We don't
 * have a BrowserWindow on the server, so we pass a tiny shim whose
 * `webContents.send` forwards to the WS hub — no changes to agentRuntime needed.
 *
 * The agent spawns the Claude CLI, so the server host must have it installed and
 * authenticated (same requirement as desktop).
 */
import type { Handler } from './index';
import type { Emit } from '../events';

type Register = (channel: string, fn: Handler) => void;

/** Minimal BrowserWindow-shaped object: only what agentRuntime touches. */
function fakeWindow(emit: Emit) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => emit(channel, ...args),
    },
  } as never;
}

export function registerMyceliumHandlers(handle: Register): void {
  handle('mycelium:sendMessage', async ([payload], { emit }) => {
    const { spawnEdith } = await import(
      '../../../../src/backend/mycelium/agentRuntime.js'
    );
    const p = payload as {
      text: string;
      mediaContext?: unknown;
      timelineSnapshot?: unknown;
      activeDownloads?: unknown;
      sfxLibrary?: unknown;
    };
    // Fire-and-forget; UI listens for mycelium:message / :op / :done over WS.
    spawnEdith(
      fakeWindow(emit),
      p.text,
      p.mediaContext as never,
      p.timelineSnapshot as never,
      p.activeDownloads as never,
      p.sfxLibrary as never,
    ).catch((e: unknown) => console.error('[mobile-server] spawnEdith error:', e));
    return { success: true };
  });

  handle('mycelium:pause', async () => {
    const { pauseSession } = await import(
      '../../../../src/backend/mycelium/agentRuntime.js'
    );
    pauseSession();
    return { success: true };
  });

  handle('mycelium:resume', async () => {
    const { resumeSession } = await import(
      '../../../../src/backend/mycelium/agentRuntime.js'
    );
    resumeSession();
    return { success: true };
  });

  handle('mycelium:stop', async () => {
    const { stopSession } = await import(
      '../../../../src/backend/mycelium/agentRuntime.js'
    );
    stopSession();
    return { success: true };
  });

  // TODO(decouple): mycelium:analyzeReference / runQA / recordLesson read
  // app.getAppPath() and the project .env for ANTHROPIC_API_KEY. Lift those
  // into env vars on the server, then wire these channels the same way.
}
