/**
 * Record & create — the card list panel (Clipchamp-style, DiviDr grammar).
 * Each card opens the full-screen RecorderModal in its mode. Everything
 * recorded here saves ONLY into the media library (userData/recordings),
 * never into the user's Downloads folder.
 */
import { useState } from 'react';
import { RecorderModal, type RecorderMode } from './RecorderModal';
import artScreenCamera from './assets/card-screen-camera.jpg';
import artCamera from './assets/card-camera.jpg';
import artScreen from './assets/card-screen.jpg';
import artAudio from './assets/card-audio.jpg';

// Square 1024px renders cover-cropped into the wide card — objectPosition
// picks the vertical band that keeps each subject centered, and the label
// gradient guarantees the white title stays readable over any of them.
const CARDS: Array<{ mode: RecorderMode; title: string; art: string; pos: string }> = [
  { mode: 'screen-camera', title: 'Screen and camera', art: artScreenCamera, pos: '50% 30%' },
  { mode: 'camera', title: 'Camera', art: artCamera, pos: '50% 48%' },
  { mode: 'screen', title: 'Screen', art: artScreen, pos: '50% 36%' },
  { mode: 'audio', title: 'Audio', art: artAudio, pos: '50% 42%' },
];

export function RecordPanel({ className }: { className?: string }) {
  const [activeMode, setActiveMode] = useState<RecorderMode | null>(null);

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`} style={{ background: '#141414' }}>
      <div className="px-4 py-3 border-b border-white/[0.06]">
        <h2 className="text-sm font-semibold text-zinc-100">Record &amp; create</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <p className="text-[11px] font-semibold text-zinc-400 mb-2 px-1">Record</p>
        <div className="flex flex-col gap-2.5">
          {CARDS.map((c) => (
            <button
              key={c.mode}
              type="button"
              data-testid={`record-card-${c.mode}`}
              onClick={() => setActiveMode(c.mode)}
              className="group relative w-full h-28 rounded-xl overflow-hidden text-left focus:outline-none border border-white/[0.07]"
              style={{ background: '#0c0c0c' }}
            >
              <img
                src={c.art}
                alt=""
                draggable={false}
                className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.045]"
                style={{ objectPosition: c.pos }}
              />
              {/* label plate: keeps the white title readable over the art */}
              <span
                className="absolute inset-x-0 bottom-0 h-14 pointer-events-none"
                style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0.28) 55%, transparent)' }}
              />
              <span className="absolute left-3.5 bottom-2.5 text-[13px] font-semibold text-white tracking-wide">
                {c.title}
              </span>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-zinc-600 leading-relaxed mt-3 px-1">
          Recordings save straight into your media sources — nothing is written to
          your Downloads folder.
        </p>
      </div>

      {activeMode && (
        <RecorderModal mode={activeMode} onClose={() => setActiveMode(null)} />
      )}
    </div>
  );
}
