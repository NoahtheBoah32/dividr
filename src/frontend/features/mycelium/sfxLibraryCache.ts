/**
 * sfxLibraryCache — the single shared cache of the scanned SFX library, read by BOTH
 * the transcript asterisk-SFX trigger (needs the names to resolve *word*) and the
 * placeSFX op (needs the full entries to place a clip).
 *
 * It also self-loads: `ensureSfxLibrary()` scans the library on demand, so the
 * transcript trigger works even when the EDITH panel (which used to be the only thing
 * that scanned) hasn't mounted, or an HMR reload cleared the module state.
 */
export interface SfxEntry {
  name: string;
  path: string;
  durationSec: number;
  categories: string[];
  audioStartSec?: number;
  audioEndSec?: number;
  size?: number;
}

let _entries: SfxEntry[] = [];
let _names: string[] = [];
let _loading: Promise<string[]> | null = null;

export function setSfxLibrary(entries: SfxEntry[]): void {
  _entries = entries ?? [];
  _names = _entries.map((e) => e.name);
}

/** Back-compat alias (older callers used setSfxNames with just names). */
export function setSfxNames(names: string[]): void {
  _names = names ?? [];
}

export function getSfxEntries(): SfxEntry[] {
  return _entries;
}

export function getSfxNames(): string[] {
  return _names;
}

/**
 * Ensure the library has been scanned into the cache. Idempotent and de-duped —
 * concurrent callers share one scan. Returns the loaded names (empty on failure, e.g.
 * no SFX_LIBRARY_PATH configured). Safe to call from any component on mount.
 */
export async function ensureSfxLibrary(): Promise<string[]> {
  if (_names.length) return _names;
  if (!_loading) {
    _loading = (async () => {
      try {
        const api = (window as any).electronAPI;
        const result = await api?.invoke?.('scan-sfx-library');
        if (result?.entries?.length) setSfxLibrary(result.entries);
      } catch {
        /* best effort — a missing library just leaves the cache empty */
      } finally {
        _loading = null;
      }
      return _names;
    })();
  }
  return _loading;
}
