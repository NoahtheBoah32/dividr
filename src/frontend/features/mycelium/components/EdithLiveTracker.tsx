import React, { useEffect, useRef, useState } from 'react';
import { operationEngine } from '../operationEngine';
import { Op } from '../types';

interface TrackerEntry {
  id: string;
  icon: string;
  label: string;
  detail: string;
  exiting: boolean;
}

function describeOp(op: Op): { icon: string; label: string; detail: string } {
  switch (op.type) {
    case 'addCaption':
      return { icon: '✦', label: 'Caption', detail: `"${op.text.slice(0, 30)}${op.text.length > 30 ? '…' : ''}"` };
    case 'trimClip':
      return { icon: '✂', label: 'Trim', detail: `${Math.round(op.newEndFrame / 30)}s` };
    case 'insertClip':
      return { icon: '＋', label: 'Insert clip', detail: `at ${Math.round(op.startFrame / 30)}s` };
    case 'colorGrade':
      return { icon: '◑', label: 'Color grade', detail: '' };
    case 'setAspectRatio':
      return { icon: '⬜', label: 'Canvas', detail: `→ ${op.ratio}` };
    case 'cutSilence':
      return { icon: '◌', label: 'Cut silences', detail: '' };
    case 'downloadMedia':
      return { icon: '↓', label: 'B-roll', detail: (op.topic ?? op.url).slice(0, 28) };
    case 'saveStyle':
      return { icon: '★', label: 'Style saved', detail: op.name };
    case 'geminiEdit':
      return { icon: '◉', label: 'Gemini edit', detail: op.userRequest.slice(0, 28) };
    case 'runWhisper':
      return { icon: '⊙', label: 'Transcribing', detail: '' };
    case 'updateClip':
      return { icon: '⟳', label: 'Update clip', detail: '' };
    case 'analyzeReference':
      return { icon: '◎', label: 'Analyzing ref', detail: '' };
    default:
      return { icon: '·', label: (op as any).type, detail: '' };
  }
}

const DISPLAY_MS = 2800;
const EXIT_MS = 300;

export const EdithLiveTracker: React.FC = () => {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const counterRef = useRef(0);

  useEffect(() => {
    const off = operationEngine.on('opApplied', (_id: unknown, op: Op) => {
      const { icon, label, detail } = describeOp(op);
      const id = String(++counterRef.current);

      setEntries((prev) => [...prev.slice(-4), { id, icon, label, detail, exiting: false }]);

      setTimeout(() => {
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, exiting: true } : e)),
        );
      }, DISPLAY_MS);

      setTimeout(() => {
        setEntries((prev) => prev.filter((e) => e.id !== id));
      }, DISPLAY_MS + EXIT_MS);
    });

    return () => (off as () => void)();
  }, []);

  if (entries.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute bottom-3 right-3 z-50 flex flex-col gap-1 items-end"
      aria-hidden="true"
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            borderRadius: '6px',
            padding: '6px 10px',
            fontSize: '12px',
            background: 'rgba(0,0,0,0.72)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#e4e4e7',
            transition: `opacity ${EXIT_MS}ms ease, transform ${EXIT_MS}ms ease`,
            opacity: entry.exiting ? 0 : 1,
            transform: entry.exiting ? 'translateX(8px)' : 'translateX(0)',
            maxWidth: '260px',
          }}
        >
          <span style={{ color: '#a1a1aa', fontSize: '11px', flexShrink: 0 }}>
            {entry.icon}
          </span>
          <span style={{ fontWeight: 500, flexShrink: 0 }}>{entry.label}</span>
          {entry.detail && (
            <span
              style={{
                color: '#a1a1aa',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};
