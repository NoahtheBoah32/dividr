/**
 * sfxLibraryCache — a tiny, component-readable mirror of the scanned SFX library
 * filenames. storeAdapter.setSfxLibraryCache keeps this in sync so UI features (the
 * transcript asterisk-SFX trigger) can resolve `*word*` markers without importing the
 * heavy storeAdapter module.
 */
let _names: string[] = [];

export function setSfxNames(names: string[]): void {
  _names = names;
}

export function getSfxNames(): string[] {
  return _names;
}
