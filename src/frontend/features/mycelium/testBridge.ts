/**
 * Visual test bridge — only active in DEV builds.
 * Exposes window.__dividrTest so Playwright can inject store state and ops
 * without going through Electron IPC or the full media-import flow.
 */

import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { operationEngine } from './operationEngine';
import type { Op } from './types';

interface DividrTestBridge {
  /** Replace portions of the video editor store state directly. */
  setStoreState(partial: Record<string, unknown>): void;
  /** Read the current video editor store snapshot. */
  getStoreSnapshot(): Record<string, unknown>;
  /** Enqueue ops through the normal operation engine (applyFn must be registered). */
  applyOps(ops: Op[]): string[];
  /** Returns a Promise that resolves when the op queue is empty. */
  waitForQueueDrained(): Promise<void>;
  /** Force a store re-render by bumping a no-op field. */
  ping(): string;
}

function initTestBridge() {
  if (!(import.meta as any).env?.DEV) return;

  const bridge: DividrTestBridge = {
    setStoreState(partial) {
      // Shallow-deep merge: top-level objects (preview, timeline) get their keys merged
      // rather than replaced, so required fields aren't dropped.
      const current = (useVideoEditorStore as any).getState();
      const merged: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(partial)) {
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          current[key] !== null &&
          typeof current[key] === 'object' &&
          !Array.isArray(current[key])
        ) {
          merged[key] = { ...current[key], ...(value as object) };
        } else {
          merged[key] = value;
        }
      }
      (useVideoEditorStore as any).setState(merged, false);
    },

    getStoreSnapshot() {
      return (useVideoEditorStore as any).getState();
    },

    applyOps(ops) {
      return operationEngine.enqueueMany(ops);
    },

    waitForQueueDrained() {
      const state = (operationEngine as any);
      // If already idle, resolve immediately
      if ((!state.queue || state.queue.length === 0) && !state.processing) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const off = operationEngine.on('queueDrained', () => {
          off();
          resolve();
        });
      });
    },

    ping() {
      return 'pong';
    },
  };

  (window as any).__dividrTest = bridge;
}

export { initTestBridge };
