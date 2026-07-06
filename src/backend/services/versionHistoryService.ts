/**
 * Lightweight project version history ("scrub back to 20 minutes ago").
 *
 * Fully isolated in its own IndexedDB database (`DividrVersions`) so it can NEVER corrupt or
 * interfere with the main project store. Snapshots are recorded after a successful auto-save,
 * throttled so we keep roughly one version per minute, capped at MAX_VERSIONS per project.
 * All methods swallow errors — version history is a safety net and must never break saving.
 */

const DB_NAME = 'DividrVersions';
const STORE_NAME = 'versions';
const DB_VERSION = 1;
const MAX_VERSIONS = 24; // ~ up to a few hours of 1/min snapshots
const MIN_INTERVAL_MS = 60_000; // at most one snapshot per minute per project

export interface ProjectVersion {
  id: string;
  projectId: string;
  timestamp: number;
  label: string;
  /** Deep-cloned videoEditor sub-tree (tracks, timeline, mediaLibrary, preview, textStyle). */
  videoEditor: unknown;
}

class VersionHistoryService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private lastSnapshotAt: Record<string, number> = {};

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('projectId', 'projectId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Don't cache a rejected promise — a one-time failure (e.g. private-mode IndexedDB) would
    // otherwise poison every future call. Clear it so the next call can retry from scratch.
    this.dbPromise.catch(() => {
      this.dbPromise = null;
    });
    return this.dbPromise;
  }

  private genId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `v_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    }
  }

  /** Record a snapshot for a project (throttled + capped). Safe to call on every save. */
  async recordSnapshot(
    projectId: string,
    videoEditor: unknown,
    label = 'Auto-saved',
    force = false,
  ): Promise<void> {
    try {
      if (!projectId) return;
      const now = Date.now();
      if (!force && now - (this.lastSnapshotAt[projectId] ?? 0) < MIN_INTERVAL_MS) {
        return;
      }
      this.lastSnapshotAt[projectId] = now;

      const snapshot: ProjectVersion = {
        id: this.genId(),
        projectId,
        timestamp: now,
        label,
        videoEditor: JSON.parse(JSON.stringify(videoEditor)),
      };

      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(snapshot);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      await this.prune(projectId);
    } catch (err) {
      console.warn('[versionHistory] recordSnapshot failed (non-fatal):', err);
    }
  }

  /** All versions for a project, newest first. */
  async listVersions(projectId: string): Promise<ProjectVersion[]> {
    try {
      const db = await this.open();
      const all = await new Promise<ProjectVersion[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const idx = tx.objectStore(STORE_NAME).index('projectId');
        const req = idx.getAll(projectId);
        req.onsuccess = () => resolve(req.result as ProjectVersion[]);
        req.onerror = () => reject(req.error);
      });
      return all.sort((a, b) => b.timestamp - a.timestamp);
    } catch (err) {
      console.warn('[versionHistory] listVersions failed:', err);
      return [];
    }
  }

  async getVersion(id: string): Promise<ProjectVersion | null> {
    try {
      const db = await this.open();
      return await new Promise<ProjectVersion | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve((req.result as ProjectVersion) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[versionHistory] getVersion failed:', err);
      return null;
    }
  }

  /** Keep only the newest MAX_VERSIONS for a project. */
  private async prune(projectId: string): Promise<void> {
    try {
      const versions = await this.listVersions(projectId);
      if (versions.length <= MAX_VERSIONS) return;
      const toDelete = versions.slice(MAX_VERSIONS);
      const db = await this.open();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const v of toDelete) store.delete(v.id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      /* non-fatal */
    }
  }
}

export const versionHistoryService = new VersionHistoryService();
