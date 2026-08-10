import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import {
  ensureSfxLibrary,
  getSfxEntries,
  type SfxEntry,
} from '../../../../mycelium/sfxLibraryCache';

/**
 * SFX Library browser — the 125-sound library EDITH places from, surfaced for
 * manual editing. Search + category filter, a play-preview per sound (so you
 * hear it BEFORE it's on the timeline), and drag-to-timeline: rows set an
 * `application/x-dividr-sfx` payload the timeline drop handler routes through
 * the same placeSFX machinery EDITH uses (media import, row-1 clash push-up,
 * export-safe duration).
 */

export const SFX_DRAG_MIME = 'application/x-dividr-sfx';
const MEDIA_SERVER = 'http://localhost:3001';

const previewUrlFor = (entry: SfxEntry) =>
  `${MEDIA_SERVER}/${encodeURIComponent(entry.path)}`;

const displayName = (name: string) =>
  name
    .replace(/ - Epidemic Sound\.(mp3|wav|ogg)$/i, '')
    .replace(/\.(mp3|wav|ogg)$/i, '');

const formatDuration = (sec: number) =>
  sec >= 10 ? `${Math.round(sec)}s` : `${sec.toFixed(1)}s`;

// The scanner has no real taxonomy (entry.categories just echoes the filename),
// so bucket by filename keywords — display-layer only, search still sees all.
const CATEGORY_RULES: Array<[string, RegExp]> = [
  ['Whooshes & Transitions', /whoosh|swoosh|swish|transition|riser|sweep/],
  ['Impacts & Hits', /impact|boom|hit|punch|slam|thud|bass_drop|explosion|crash/],
  ['UI, Pops & Dings', /click|pop|ding|beep|notification|ui_|button|typing|keyboard|camera/],
  ['Crowd & Voice', /laugh|applause|cheer|gasp|scream|cry|crowd|boo|kids|talking/],
  ['Animals', /dog|cat|bird|bee|rooster|horse|cow|lion|wolf|frog|duck|animal/],
  ['Nature & Ambience', /rain|wind|thunder|ocean|water|fire|forest|night|ambience|birds/],
  ['Vehicles & Alarms', /car|airplane|train|siren|engine|horn|alarm|traffic|helicopter/],
  ['Musical', /music|drum|guitar|piano|stinger|chime|bell|orchestra|trumpet/],
];

const categoryOf = (name: string): string => {
  const n = name.toLowerCase();
  for (const [label, re] of CATEGORY_RULES) if (re.test(n)) return label;
  return 'Other';
};

export const SfxLibrarySection: React.FC = () => {
  const [entries, setEntries] = useState<SfxEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [playingName, setPlayingName] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    ensureSfxLibrary().then(() => {
      if (!alive) return;
      setEntries(getSfxEntries());
      setLoaded(true);
    });
    return () => {
      alive = false;
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(categoryOf(e.name));
    return ['all', ...[...set].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (category !== 'all' && categoryOf(e.name) !== category) return false;
      if (q && !e.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, query, category]);

  const togglePreview = (entry: SfxEntry) => {
    if (playingName === entry.name) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingName(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(previewUrlFor(entry));
    audio.onended = () => setPlayingName((cur) => (cur === entry.name ? null : cur));
    audio.onerror = () => setPlayingName((cur) => (cur === entry.name ? null : cur));
    audio.play().catch(() => setPlayingName(null));
    audioRef.current = audio;
    setPlayingName(entry.name);
  };

  const onDragStart = (e: React.DragEvent, entry: SfxEntry) => {
    // Preview shouldn't ride along onto the timeline
    audioRef.current?.pause();
    setPlayingName(null);
    e.dataTransfer.setData(SFX_DRAG_MIME, JSON.stringify({ name: entry.name }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  if (loaded && entries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        SFX library not found. It ships with DiviDr — try reinstalling.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">SFX Library</h3>
        <span className="text-xs text-muted-foreground">
          {filtered.length}/{entries.length}
        </span>
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search sounds…"
        className="w-full rounded-md bg-neutral-800/80 border border-neutral-700 px-2 py-1.5 text-xs outline-none focus:border-neutral-500 placeholder:text-neutral-500"
      />

      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="w-full rounded-md bg-neutral-800/80 border border-neutral-700 px-2 py-1.5 text-xs outline-none focus:border-neutral-500"
      >
        {categories.map((c) => (
          <option key={c} value={c}>
            {c === 'all' ? 'All categories' : c}
          </option>
        ))}
      </select>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin max-h-[420px] flex flex-col gap-1 pr-1">
        {!loaded && (
          <div className="text-xs text-muted-foreground py-2">Scanning library…</div>
        )}
        {filtered.map((entry) => (
          <div
            key={entry.name}
            draggable
            onDragStart={(e) => onDragStart(e, entry)}
            className="group flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 hover:bg-neutral-800/80 hover:border-neutral-700 px-2 py-1.5 cursor-grab active:cursor-grabbing select-none"
            title={`${displayName(entry.name)} — drag onto the timeline`}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                togglePreview(entry);
              }}
              className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-neutral-700/80 hover:bg-neutral-600 text-neutral-200"
              title={playingName === entry.name ? 'Stop preview' : 'Preview sound'}
            >
              {playingName === entry.name ? (
                <Pause className="w-3 h-3" />
              ) : (
                <Play className="w-3 h-3 ml-px" />
              )}
            </button>
            <span className="flex-1 truncate text-xs text-neutral-200">
              {displayName(entry.name)}
            </span>
            <span className="flex-shrink-0 text-[10px] tabular-nums text-neutral-500">
              {formatDuration(entry.durationSec)}
            </span>
          </div>
        ))}
        {loaded && filtered.length === 0 && entries.length > 0 && (
          <div className="text-xs text-muted-foreground py-2">
            Nothing matches “{query}”.
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Drag a sound onto the timeline to place it — same placement EDITH uses.
      </p>
    </div>
  );
};
