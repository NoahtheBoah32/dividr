/**
 * SeparationCache — global singleton for baked voice/background STEMS.
 *
 * Sibling of NoiseReductionCache, but instead of one cleaned file it manages the
 * TWO stems a source-separation bake produces:
 *   - a VOICE stem  (the speaker, pulled out by the MDX-Net model)
 *   - a BACKGROUND stem (music / ambiance / room — the exact residual)
 *
 * The bake is one-time and CPU-heavy (runs in Python via 'media:voiceSeparate').
 * Once cached, the editor plays the two stems as two synced <audio> elements and
 * mixes them LIVE with two volume levels (the browser sums their outputs), so the
 * mix is fully real-time — no re-processing, and no vocoder/auto-tune artifact,
 * because we only change the LEVELS of already-clean audio.
 *
 * Keyed by normalized sourceId (same scheme as NoiseReductionCache), so multiple
 * clips from one source share the bake. Best-effort and reactive (subscription).
 */

export type SeparationState = 'idle' | 'processing' | 'cached' | 'error';

export interface SeparationProgress {
  stage: 'loading' | 'processing' | 'saving' | 'complete' | 'error';
  progress: number;
  message?: string;
}

export interface SeparationCacheEntry {
  sourceId: string;
  originalUrl: string;
  voicePath: string | null;
  backgroundPath: string | null;
  voiceUrl: string | null;
  backgroundUrl: string | null;
  state: SeparationState;
  progress: number;
  message: string | null;
  error: string | null;
  processedAt: number | null;
}

type SubscriptionCallback = () => void;

const PROGRESS_CHANNEL = 'media:voiceSeparate-progress';

function friendlyMessage(raw: string | null, progress: number): string {
  if (raw) {
    const m = raw.toLowerCase();
    if (m.includes('download')) return 'Downloading model (one-time)…';
    if (m.includes('loading')) return 'Preparing…';
    if (m.includes('separat')) return 'Separating voice from background…';
    if (m.includes('writing') || m.includes('saving')) return 'Finalizing stems…';
    if (m.includes('done') || m.includes('complete')) return 'Ready';
  }
  if (progress < 8) return 'Preparing…';
  if (progress < 95) return 'Separating voice from background…';
  return 'Finalizing stems…';
}

class SeparationCacheImpl {
  private cache = new Map<string, SeparationCacheEntry>();
  private subscriptions = new Map<string, Set<SubscriptionCallback>>();
  private pending = new Map<string, Promise<SeparationCacheEntry>>();

  // ── keys / source identity ────────────────────────────────────────────────
  normalizeSourceId(url: string): string {
    if (!url) return '';
    try {
      if (url.startsWith('blob:')) return url;
      const parsed = new URL(url, window.location.origin);
      return decodeURIComponent(parsed.pathname);
    } catch {
      return url;
    }
  }

  // ── queries ───────────────────────────────────────────────────────────────
  hasCached(sourceId: string): boolean {
    const e = this.cache.get(this.normalizeSourceId(sourceId));
    return e?.state === 'cached' && !!e.voiceUrl && !!e.backgroundUrl;
  }

  getVoiceUrl(sourceId: string): string | null {
    const e = this.cache.get(this.normalizeSourceId(sourceId));
    return e?.state === 'cached' ? e.voiceUrl : null;
  }

  getBackgroundUrl(sourceId: string): string | null {
    const e = this.cache.get(this.normalizeSourceId(sourceId));
    return e?.state === 'cached' ? e.backgroundUrl : null;
  }

  getVoicePath(sourceId: string): string | null {
    return this.cache.get(this.normalizeSourceId(sourceId))?.voicePath ?? null;
  }

  getBackgroundPath(sourceId: string): string | null {
    return this.cache.get(this.normalizeSourceId(sourceId))?.backgroundPath ?? null;
  }

  getState(sourceId: string): SeparationState {
    return this.cache.get(this.normalizeSourceId(sourceId))?.state ?? 'idle';
  }

  getProgress(sourceId: string): number {
    return this.cache.get(this.normalizeSourceId(sourceId))?.progress ?? 0;
  }

  getError(sourceId: string): string | null {
    return this.cache.get(this.normalizeSourceId(sourceId))?.error ?? null;
  }

  getDisplayMessage(sourceId: string): string {
    const e = this.cache.get(this.normalizeSourceId(sourceId));
    if (!e) return 'Preparing…';
    return friendlyMessage(e.message, e.progress);
  }

  getEntry(sourceId: string): SeparationCacheEntry | null {
    return this.cache.get(this.normalizeSourceId(sourceId)) ?? null;
  }

  // ── subscriptions ───────────────────────────────────────────────────────--
  subscribe(sourceId: string, callback: SubscriptionCallback): () => void {
    const key = this.normalizeSourceId(sourceId);
    let subs = this.subscriptions.get(key);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(key, subs);
    }
    subs.add(callback);
    return () => {
      const s = this.subscriptions.get(key);
      if (s) {
        s.delete(callback);
        if (s.size === 0) this.subscriptions.delete(key);
      }
    };
  }

  private update(key: string, entry: SeparationCacheEntry): void {
    this.cache.set(key, entry);
    this.subscriptions.get(key)?.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error('[SeparationCache] subscriber error', e);
      }
    });
  }

  // ── processing ──────────────────────────────────────────────────────────--
  async processSource(
    sourceId: string,
    originalUrl: string,
    options?: { onProgress?: (p: SeparationProgress) => void },
  ): Promise<SeparationCacheEntry> {
    const key = this.normalizeSourceId(sourceId);
    const existing = this.cache.get(key);
    if (existing?.state === 'cached' && existing.voiceUrl && existing.backgroundUrl) {
      return existing;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = this.doProcess(key, sourceId, originalUrl, options);
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  private async doProcess(
    key: string,
    sourceId: string,
    originalUrl: string,
    options?: { onProgress?: (p: SeparationProgress) => void },
  ): Promise<SeparationCacheEntry> {
    this.update(key, {
      sourceId: key,
      originalUrl,
      voicePath: null,
      backgroundPath: null,
      voiceUrl: null,
      backgroundUrl: null,
      state: 'processing',
      progress: 0,
      message: null,
      error: null,
      processedAt: null,
    });

    const api = window.electronAPI as any;
    const progressHandler = (_event: unknown, payload: SeparationProgress) => {
      const cur = this.cache.get(key);
      if (cur) {
        this.update(key, {
          ...cur,
          progress: payload?.progress ?? cur.progress,
          message: payload?.message ?? cur.message,
        });
      }
      options?.onProgress?.(payload);
    };

    try {
      const inputPath = this.inputPathFromUrl(originalUrl);
      if (!inputPath) throw new Error('Could not resolve a file path for this source');

      api.on?.(PROGRESS_CHANNEL, progressHandler);
      const result = await api.invoke('media:voiceSeparate', { filePath: inputPath });
      if (!result?.success || !result.filePath || !result.instrumentalPath) {
        throw new Error(result?.error || 'Voice separation failed');
      }

      const [voiceUrlRes, bgUrlRes] = await Promise.all([
        api.invoke('create-preview-url', result.filePath),
        api.invoke('create-preview-url', result.instrumentalPath),
      ]);
      if (!voiceUrlRes?.success || !voiceUrlRes.url) {
        throw new Error(voiceUrlRes?.error || 'Could not create voice stem preview URL');
      }
      if (!bgUrlRes?.success || !bgUrlRes.url) {
        throw new Error(bgUrlRes?.error || 'Could not create background stem preview URL');
      }

      const entry: SeparationCacheEntry = {
        sourceId: key,
        originalUrl,
        voicePath: result.filePath,
        backgroundPath: result.instrumentalPath,
        voiceUrl: voiceUrlRes.url,
        backgroundUrl: bgUrlRes.url,
        state: 'cached',
        progress: 100,
        message: 'Ready',
        error: null,
        processedAt: Date.now(),
      };
      this.update(key, entry);
      return entry;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const cur = this.cache.get(key);
      this.update(key, {
        ...(cur ?? {
          sourceId: key,
          originalUrl,
          voicePath: null,
          backgroundPath: null,
          voiceUrl: null,
          backgroundUrl: null,
          processedAt: null,
        }),
        state: 'error',
        progress: 0,
        message: null,
        error: msg,
      } as SeparationCacheEntry);
      throw error;
    } finally {
      api.removeListener?.(PROGRESS_CHANNEL, progressHandler);
    }
  }

  resetError(sourceId: string): void {
    const key = this.normalizeSourceId(sourceId);
    const e = this.cache.get(key);
    if (e?.state === 'error') {
      this.update(key, { ...e, state: 'idle', error: null, progress: 0 });
    }
  }

  async clearEntry(sourceId: string): Promise<void> {
    const key = this.normalizeSourceId(sourceId);
    const e = this.cache.get(key);
    if (!e) return;
    const paths = [e.voicePath, e.backgroundPath].filter(Boolean) as string[];
    if (paths.length) {
      try {
        await (window.electronAPI as any).invoke('delete-file', paths[0]);
        if (paths[1]) await (window.electronAPI as any).invoke('delete-file', paths[1]);
      } catch {
        /* best effort */
      }
    }
    this.cache.delete(key);
    this.subscriptions.get(key)?.forEach((cb) => {
      try {
        cb();
      } catch {
        /* noop */
      }
    });
  }

  /** Resolve a playable source URL back to an on-disk file path for the bake. */
  private inputPathFromUrl(url: string): string | null {
    if (!url || url.startsWith('blob:')) return null;
    if (url.startsWith('file://')) {
      try {
        let p = decodeURIComponent(new URL(url).pathname);
        if (p.startsWith('/') && p[2] === ':') p = p.slice(1);
        return p;
      } catch {
        return null;
      }
    }
    if (url.includes('/media-file?path=')) {
      try {
        const enc = new URL(url).searchParams.get('path');
        return enc ? decodeURIComponent(enc) : null;
      } catch {
        return null;
      }
    }
    if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
      try {
        let p = decodeURIComponent(new URL(url).pathname);
        if (p.startsWith('/')) p = p.slice(1);
        return p.length > 1 ? p : null;
      } catch {
        return null;
      }
    }
    if (/^[A-Za-z]:\\/.test(url) || url.startsWith('/')) return url;
    return null;
  }
}

export const SeparationCache = new SeparationCacheImpl();
export default SeparationCache;
