/**
 * sfxLibraryCache — the single shared cache of the scanned SFX library, read by BOTH
 * the transcript asterisk-SFX trigger (needs the names to resolve *word*) and the
 * placeSFX op (needs the full entries to place a clip).
 *
 * It also self-loads: `ensureSfxLibrary()` scans the library on demand, so the
 * transcript trigger works even when the EDITH panel (which used to be the only thing
 * that scanned) hasn't mounted, or an HMR reload cleared the module state. And it can
 * RE-scan (`refreshSfxLibrary`) so files dropped into the folder mid-session are
 * picked up without restarting DiviDr.
 *
 * Alongside the audio files, an optional `aliases.txt` in the library folder lets the
 * user teach the *word* trigger their own names (`bark = dog_barking`). It's read
 * here through the existing read-file IPC — no main-process changes needed.
 */
import { parseSfxAliasFile } from '../editor/components/properties-panel/audio/sfxTriggerUtils';

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
let _aliases: Record<string, string> | null = null;
let _libPath = '';
let _scannedAt = 0;
let _loading: Promise<string[]> | null = null;

export function setSfxLibrary(entries: SfxEntry[], libPath?: string): void {
  _entries = entries ?? [];
  _names = _entries.map((e) => e.name);
  _scannedAt = Date.now();
  if (libPath) _libPath = libPath;
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

/** User mappings from aliases.txt in the library folder ({} until loaded / none). */
export function getSfxAliases(): Record<string, string> {
  return _aliases ?? {};
}

async function loadAliases(libPath: string): Promise<void> {
  if (!libPath) {
    _aliases = {};
    return;
  }
  try {
    const api = (window as any).electronAPI;
    const raw = await api?.invoke?.('read-file', `${libPath}/aliases.txt`);
    _aliases = parseSfxAliasFile(String(raw ?? ''));
  } catch {
    // No aliases.txt (or unreadable) — that's the normal case.
    _aliases = {};
  }
}

/**
 * Re-scan the library folder, so files added mid-session are picked up. When the
 * last scan is younger than `maxAgeMs` it's reused (aliases still load if they
 * never have). De-duped — concurrent callers share one scan.
 */
export async function refreshSfxLibrary(maxAgeMs = 0): Promise<string[]> {
  // A fresh cache is only reusable if aliases are loaded (or loadable): a scan done
  // by a caller that didn't record libPath (FridayPanel) can't load aliases lazily.
  if (_names.length && Date.now() - _scannedAt < maxAgeMs && (_aliases !== null || _libPath)) {
    if (_aliases === null) await loadAliases(_libPath);
    return _names;
  }
  if (!_loading) {
    _loading = (async () => {
      try {
        const api = (window as any).electronAPI;
        const result = await api?.invoke?.('scan-sfx-library');
        if (result?.entries?.length) {
          setSfxLibrary(result.entries, result.libPath);
          await loadAliases(result.libPath ?? '');
        }
      } catch {
        /* best effort — a missing library just leaves the cache as-is */
      } finally {
        _loading = null;
      }
      return _names;
    })();
  }
  return _loading;
}

/**
 * Ensure the library has been scanned into the cache at least once. Idempotent —
 * an already-loaded cache is returned as-is (use refreshSfxLibrary to force a
 * re-scan). Returns the loaded names (empty on failure, e.g. no SFX_LIBRARY_PATH
 * configured). Safe to call from any component on mount.
 */
export async function ensureSfxLibrary(): Promise<string[]> {
  if (_names.length && (_aliases !== null || _libPath)) {
    if (_aliases === null) await loadAliases(_libPath);
    return _names;
  }
  return refreshSfxLibrary(0);
}
