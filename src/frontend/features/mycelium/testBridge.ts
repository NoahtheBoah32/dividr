/**
 * Visual test bridge — only active in DEV builds.
 * Exposes window.__dividrTest so Playwright can inject store state and ops
 * without going through Electron IPC or the full media-import flow.
 */

import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { usePanelStore } from '@/frontend/features/editor/stores/PanelStore';
import { useProjectStore } from '@/frontend/features/projects/store/projectStore';
import { operationEngine } from './operationEngine';
import { refreshSfxLibrary } from './sfxLibraryCache';
import { useDownloadApprovalStore } from './stores/downloadApprovalStore';
import { sendMediaToEdith } from './sendToEdith';
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
  /** Open a dock panel by type (e.g. 'friday' to mount the EDITH chat panel). */
  openPanel(panelType: string): void;
  /** Force a fresh SFX library scan (same module instance the app reads). */
  refreshSfxLibrary(): Promise<string[]>;
  /** List saved projects (id + title) — test isolation helpers. */
  listProjects(): Promise<{ id: string; title: string }[]>;
  /** Create a fresh project and open it (keeps test edits out of user projects). */
  createAndOpenProject(title: string): Promise<string>;
  /** Open an existing project by id or (partial) title. */
  openProjectByTitle(query: string): Promise<boolean>;
  /** Snapshot of the op queue (id/type/status/error) — surfaces silent op failures. */
  getOpQueue(): { id: string; type: string; status: string; error?: string }[];
  /** The download-approval store EDITH's fetches flow through — lets tests drive
   *  the REAL enqueue→approve→import→chat-card path with a local file. */
  getDownloadApprovalStore(): typeof useDownloadApprovalStore;
  /** Hand a media file to EDITH's chat exactly like the recorder's Send to EDITH. */
  sendMediaToEdith(item: { name: string; path: string; preview?: string }): void;
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

    openPanel(panelType) {
      (usePanelStore as any).getState().showPanel(panelType);
    },

    refreshSfxLibrary() {
      return refreshSfxLibrary(0);
    },

    async listProjects() {
      const ps = (useProjectStore as any).getState();
      if (!ps.isInitialized) await ps.initializeProjects();
      return ((useProjectStore as any).getState().projects ?? []).map(
        (p: any) => ({ id: p.id, title: p.title }),
      );
    },

    async createAndOpenProject(title) {
      const ps = (useProjectStore as any).getState();
      if (!ps.isInitialized) await ps.initializeProjects();
      const id = await (useProjectStore as any).getState().createNewProject(title);
      await (useProjectStore as any).getState().openProject(id);
      window.location.hash = '#/video-editor';
      return id;
    },

    getDownloadApprovalStore() {
      return useDownloadApprovalStore;
    },

    sendMediaToEdith(item: { name: string; path: string; preview?: string }) {
      sendMediaToEdith(item);
    },

    getOpQueue() {
      return operationEngine.getQueue().map((q) => ({
        id: q.id,
        type: (q.op as any).type,
        status: q.status,
        error: q.error,
      }));
    },

    async openProjectByTitle(query) {
      const ps = (useProjectStore as any).getState();
      if (!ps.isInitialized) await ps.initializeProjects();
      const q = String(query).toLowerCase();
      const list = (useProjectStore as any).getState().projects ?? [];
      const hit =
        list.find((p: any) => p.id === query) ??
        list.find((p: any) => (p.title ?? '').toLowerCase().includes(q));
      if (!hit) return false;
      await (useProjectStore as any).getState().openProject(hit.id);
      window.location.hash = '#/video-editor';
      return true;
    },
  };

  (window as any).__dividrTest = bridge;
}

export { initTestBridge };
