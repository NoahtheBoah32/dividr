import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AgentMessage, AgentPlan, AgentStatus, QueuedOp } from './types';
import { operationEngine } from './operationEngine';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor/index';
import { getDisplayFps } from '@/frontend/features/editor/stores/videoEditor/types/timeline.types';
import { usePanelStore } from '@/frontend/features/editor/stores/PanelStore';
import type { HistoryEntry, MediaContextItem, SfxEntry, TimelineSnapshot } from '@/backend/mycelium/agentRuntime';
import { useDownloadApprovalStore } from './stores/downloadApprovalStore';
import { useEdithEditingStore } from './stores/edithEditingStore';
import { setSfxLibraryCache } from './storeAdapter';
import { consumePendingEdithAttachment } from './sendToEdith';

// "Find me the moment" fast-path. A plain CTRL-F request ("find the car", "where's the
// person", "jump to the busiest part") does NOT need an LLM turn — that adds ~7-10s of
// latency to what should feel instant. We parse the intent client-side and run the finder
// directly. Conservative by design: it only fires on a clear find verb + a KNOWN target
// (or motion / a spoken-word query). Anything it doesn't recognize returns null and falls
// through to the normal EDITH turn, so nothing regresses.
const FIND_SYNONYMS: Record<string, string> = {
  person: 'person', people: 'person', man: 'person', woman: 'person', men: 'person',
  women: 'person', someone: 'person', somebody: 'person', her: 'person', him: 'person',
  them: 'person', dancer: 'person', figure: 'person', guy: 'person', girl: 'person',
  boy: 'person', kid: 'person', lady: 'person', walker: 'person', pedestrian: 'person',
  car: 'car', vehicle: 'car', automobile: 'car', cars: 'car', truck: 'truck', bus: 'bus',
  dog: 'dog', cat: 'cat', bike: 'bicycle', bicycle: 'bicycle', cyclist: 'bicycle',
  ball: 'sports ball', bottle: 'bottle', cup: 'cup', glass: 'cup', phone: 'cell phone',
  laptop: 'laptop', bird: 'bird', horse: 'horse', dance: 'person',
};
function resolveFindIntent(raw: string): { type: 'findMoment'; target?: string; query?: string } | null {
  const t = raw.trim().toLowerCase().replace(/[?.!]+$/, '');
  // must open with a find verb / locator, else it is not a pure find
  const m = t.match(/^(?:find|locate|jump to|go to|take me to|skip to|seek to|show me|where(?:'?s| is| are)?|wheres)\s+(.+)$/);
  if (!m) return null;
  // motion intent
  if (/\b(busiest|most motion|most movement|most active|peak action|biggest motion|most action|the action)\b/.test(t)) {
    return { type: 'findMoment', target: 'motion' };
  }
  // spoken-word (transcript) intent. Strip a trailing copula ("...where pinocchio is" →
  // "pinocchio") so the visual fallback gets a clean subject and the label reads right;
  // storeAdapter does the same cleaning centrally, this just keeps the shown label honest.
  const q = t.match(/(?:part|moment|bit|spot|point)\s+where\s+(.+)/) || t.match(/when\s+(.+?)\s+(?:says?|said|talks?|mentions?)\b/);
  if (q) {
    const cleaned = q[1].trim().replace(/\s+(?:is|are|'s|appears?|shows?\s+up)\s*$/i, '').trim();
    return { type: 'findMoment', query: cleaned || q[1].trim() };
  }
  // object/scene intent: pass the cleaned phrase to OPEN-VOCAB Claude vision. Unlike
  // YOLO's 80 classes, vision identifies anything, so we no longer require a known noun —
  // any descriptive phrase ("the ampalaya", "the red jeepney") goes straight through.
  const rest = m[1]
    .replace(/^where(?:ver)?\s+/i, '')
    .replace(/^(?:the|a|an|any|some|first|that|this)\s+/i, '')
    .replace(/\b(?:in this clip|in the clip|in this video|in the video|please|now)\b/gi, '')
    .replace(/\s+(?:is|are|appears?|shows? up)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest || rest.length < 2) return null;
  return { type: 'findMoment', target: FIND_SYNONYMS[rest] || rest }; // normalize pronouns, else raw phrase
}

function renderInlineBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**')
          ? <strong key={i} className="font-semibold text-zinc-100">{part.slice(2, -2)}</strong>
          : <React.Fragment key={i}>{part}</React.Fragment>
      )}
    </>
  );
}

// Renders **bold** plus markdown bullet lines ("- item"). Fast path: text with no
// bullet line renders exactly as before (inline bold only), so existing messages are
// untouched — only EDITH's organize-style summaries gain real bullets.
function renderBold(text: string): React.ReactNode {
  if (!/^\s*[-*]\s+/m.test(text)) return renderInlineBold(text);
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const m = line.match(/^\s*[-*]\s+(.*)$/);
        if (m) {
          return (
            <span key={i} className="flex gap-1.5">
              <span className="text-zinc-500 select-none">•</span>
              <span className="flex-1">{renderInlineBold(m[1])}</span>
            </span>
          );
        }
        if (line.trim() === '') return <span key={i} className="block h-1.5" />;
        return <span key={i} className="block">{renderInlineBold(line)}</span>;
      })}
    </>
  );
}

function PlanCard({
  message,
  onToggle,
  onSkipStep,
}: {
  message: AgentMessage;
  onToggle: (msgId: string) => void;
  onSkipStep: (msgId: string, stepId: string, override?: string) => void;
}) {
  const plan = message.plan!;
  const [dotCount, setDotCount] = useState(1);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!plan.generating) return;
    const id = setInterval(() => setDotCount((d) => (d >= 3 ? 1 : d + 1)), 400);
    return () => clearInterval(id);
  }, [plan.generating]);

  useEffect(() => {
    if (editingStepId && inputRef.current) inputRef.current.focus();
  }, [editingStepId]);

  const commitEdit = (stepId: string) => {
    const text = editValue.trim();
    if (text) {
      setOverrides((prev) => ({ ...prev, [stepId]: text }));
      onSkipStep(message.id, stepId, text);
    }
    setEditingStepId(null);
    setEditValue('');
  };

  return (
    <div className="px-4 py-1.5">
      <div className="rounded-xl border border-white/[0.07] px-3 py-2" style={{ background: 'rgba(255,255,255,0.02)' }}>
      {plan.generating && (
        <div className="flex items-center gap-0 mb-1">
          <span className="text-[11px] text-zinc-600">planning process</span>
          <span className="text-[11px] text-zinc-700" style={{ minWidth: '1rem' }}>
            {'.'.repeat(dotCount)}
          </span>
        </div>
      )}

      {plan.steps.length > 0 && (
        <button
          onClick={() => onToggle(message.id)}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition-colors font-medium"
        >
          <span>View process</span>
          <span className="text-zinc-500">{plan.open ? '▾' : '›'}</span>
        </button>
      )}

      {plan.open && plan.steps.length > 0 && (
        <div className="mt-3 border-l border-white/[0.07] pl-3 ml-0.5">
          {plan.steps.map((step) => {
            const override = overrides[step.id];
            const isEditing = editingStepId === step.id;

            return (
              <div key={step.id} className="flex items-start gap-2.5 py-[5px]">
                {/* Checkbox */}
                <div
                  className={[
                    'flex-shrink-0 w-4 h-4 mt-[1px] flex items-center justify-center',
                    step.status === 'pending' && !override ? 'cursor-pointer' : '',
                  ].join(' ')}
                  onClick={() => {
                    if (step.status === 'pending' && !override) {
                      setEditingStepId(step.id);
                      setEditValue('');
                    }
                  }}
                >
                  {step.status === 'done' ? (
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6.5l2.5 2.5 5.5-5.5" stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : step.status === 'active' ? (
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  ) : override ? (
                    <div className="w-3.5 h-3.5 rounded border border-zinc-700 flex items-center justify-center">
                      <div className="w-1.5 h-[1.5px] bg-zinc-500 rotate-45 absolute" />
                      <div className="w-1.5 h-[1.5px] bg-zinc-500 -rotate-45 absolute" />
                    </div>
                  ) : (
                    <div className="w-3.5 h-3.5 rounded border border-white/[0.18] hover:border-white/40 transition-colors flex-shrink-0" />
                  )}
                </div>

                {/* Label or inline input */}
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitEdit(step.id); }
                        if (e.key === 'Escape') { setEditingStepId(null); setEditValue(''); }
                      }}
                      onBlur={() => commitEdit(step.id)}
                      placeholder="Type your instruction…"
                      className="w-full bg-transparent border-0 border-b border-white/20 text-[13px] text-white outline-none pb-px placeholder-zinc-600 leading-snug"
                      style={{ boxShadow: 'none', WebkitAppearance: 'none' }}
                    />
                  ) : override ? (
                    <span className="text-[13px] text-zinc-600 leading-snug line-through decoration-zinc-700 block">{step.step}</span>
                  ) : (
                    <span
                      className={[
                        'text-[13px] leading-snug cursor-pointer',
                        step.status === 'done' ? 'text-zinc-600 line-through decoration-zinc-700' :
                        step.status === 'active' ? 'text-white font-medium' :
                        'text-zinc-400 hover:text-zinc-200 transition-colors',
                      ].join(' ')}
                      onClick={() => {
                        if (step.status === 'pending') {
                          setEditingStepId(step.id);
                          setEditValue('');
                        }
                      }}
                    >
                      {step.step}
                    </span>
                  )}
                  {override && (
                    <span className="text-[12px] text-zinc-400 leading-snug block mt-0.5">{override}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

// ── Live reasoning card ───────────────────────────────────────────────────────
// Claude-style "thinking" feed for long analysis work (reference watching). Each
// stage line is a REAL pipeline step streamed from the main process — the shimmer
// line is what EDITH is doing at this exact moment, not decoration.
const REASONING_CSS = `
@keyframes edith-shimmer {
  0% { background-position: 200% center; }
  100% { background-position: -200% center; }
}
@keyframes edith-star-spin {
  0% { transform: rotate(0deg) scale(1); opacity: 0.85; }
  50% { transform: rotate(180deg) scale(1.18); opacity: 1; }
  100% { transform: rotate(360deg) scale(1); opacity: 0.85; }
}
@keyframes edith-stage-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}`;

const SHIMMER_STYLE: React.CSSProperties = {
  background: 'linear-gradient(90deg, #8b8b93 25%, #f4f4f5 50%, #8b8b93 75%)',
  backgroundSize: '200% auto',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  animation: 'edith-shimmer 2.2s linear infinite',
};

function ReasoningStar({ running, failed }: { running: boolean; failed?: boolean }) {
  return (
    <svg
      width="11" height="11" viewBox="0 0 24 24"
      className={failed ? 'text-red-400' : running ? 'text-emerald-300' : 'text-zinc-500'}
      fill="currentColor"
      style={running ? { animation: 'edith-star-spin 5s ease-in-out infinite' } : undefined}
    >
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z" />
    </svg>
  );
}

function ReasoningCard({ message, onToggle }: { message: AgentMessage; onToggle: (msgId: string) => void }) {
  const r = message.reasoning!;
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    if (!r.running) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [r.running]);
  void nowTick;

  const seconds = r.elapsedMs != null
    ? Math.max(1, Math.round(r.elapsedMs / 1000))
    : Math.max(0, Math.floor((Date.now() - r.startedAt) / 1000));
  const showStages = r.running || r.open;

  return (
    <div className="mx-4 my-1.5 rounded-xl border border-white/[0.07] overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <style>{REASONING_CSS}</style>
      {/* Header — shimmering title while she works, quiet summary once done */}
      <button
        onClick={() => { if (!r.running) onToggle(message.id); }}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${r.running ? 'cursor-default' : 'cursor-pointer hover:bg-white/[0.02]'} transition-colors`}
      >
        <ReasoningStar running={r.running} failed={r.failed} />
        {r.running ? (
          <span className="text-[12px] font-medium flex-1 truncate" style={SHIMMER_STYLE}>
            {r.title}
          </span>
        ) : (
          <span className={`text-[12px] font-medium flex-1 truncate ${r.failed ? 'text-red-400/90' : 'text-zinc-400'}`}>
            {r.failed ? 'Reference analysis failed' : r.title.replace(/^Watching\b/, 'Watched')}
          </span>
        )}
        <span className="text-[10px] text-zinc-600 tabular-nums flex-shrink-0">{seconds}s</span>
        {!r.running && (
          <span className="text-[10px] text-zinc-600 flex-shrink-0">{r.open ? '▾' : '›'}</span>
        )}
      </button>

      {/* Stage feed — appears line by line as the pipeline advances */}
      {showStages && r.stages.length > 0 && (
        <div className="px-3 pb-2.5">
          <div className="border-l border-white/[0.07] pl-3 ml-[4px] space-y-[3px]">
            {r.stages.map((st, i) => {
              const isActive = st.status === 'active' && r.running;
              return (
                <div key={`${st.stage}-${i}`} style={{ animation: 'edith-stage-in 0.35s ease both' }}>
                  <div className="flex items-center gap-2">
                    <span className="w-3 flex-shrink-0 flex items-center justify-center">
                      {st.status === 'done' ? (
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6.5l2.5 2.5 5.5-5.5" stroke="#4ade80" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : st.status === 'failed' ? (
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="#f87171" strokeWidth="1.6" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <span className="w-[5px] h-[5px] rounded-full bg-emerald-300 animate-pulse" />
                      )}
                    </span>
                    {isActive ? (
                      <span className="text-[12px] leading-snug" style={SHIMMER_STYLE}>{st.stage}</span>
                    ) : (
                      <span className={`text-[12px] leading-snug ${st.status === 'failed' ? 'text-red-400/80' : 'text-zinc-500'}`}>{st.stage}</span>
                    )}
                  </div>
                  {st.detail && (
                    <p className="text-[10px] text-zinc-600 leading-snug pl-5 mt-[1px]">{st.detail}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ConsentScreen({ onAgree, onCancel }: { onAgree: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col h-full text-white" style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#141414' }}>
      {/* Header */}
      <div className="flex items-center px-4 py-2.5 border-b border-white/[0.06] select-none">
        <div className="flex items-center gap-2.5">
          <div
            className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(34,197,94,0.14)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#4ade80">
              <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z" />
            </svg>
          </div>
          <span className="text-[12.5px] font-semibold text-zinc-100">EDITH</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col justify-center px-6 py-5 gap-4 min-h-0 overflow-y-auto">
        <div>
          <p className="text-sm font-medium text-zinc-100 mb-1">Allow EDITH to edit</p>
          <p className="text-[12px] text-zinc-500 leading-relaxed">
            She'll read your project context to edit effectively — nothing leaves your machine without your approval.
          </p>
        </div>

        {/* Reassurances */}
        <div className="space-y-2">
          {[
            'She won\'t record, export, or transmit your footage.',
            'She won\'t upload anything to the cloud without a separate confirmation from you.',
            'She can\'t see raw video — only clip names, positions, and transcripts.',
            'When she downloads b-roll, a prompt will ask for your approval before anything enters your media library.',
          ].map((line) => (
            <div key={line} className="flex gap-2 items-start">
              <span className="text-zinc-700 text-[11px] mt-[1px] flex-shrink-0">—</span>
              <p className="text-[11px] text-zinc-600 leading-relaxed">{line}</p>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-zinc-700 leading-relaxed">
          A <span className="text-zinc-600 font-mono">Dividr Downloads</span> folder will be created in your home directory for clips EDITH fetches.
        </p>

        {/* Buttons */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={onAgree}
            className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all hover:brightness-110"
            style={{ background: '#22c55e', color: '#052e13' }}
          >
            Agree
          </button>
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded text-xs font-medium transition-colors"
            style={{ background: '#141414', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  // Audio-waveform bars — the editor's own visual language, not a generic chat
  // bouncing-dots. Bars breathe out of phase at slightly different periods so the
  // motion never reads as a loop.
  return (
    <span className="flex items-center gap-[3px] py-0.5" style={{ height: 14 }}>
      <style>{`@keyframes edith-wave { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }`}</style>
      {[0.9, 1.15, 0.75, 1.3, 1.0].map((period, i) => (
        <span
          key={i}
          className="inline-block rounded-full bg-emerald-400/80"
          style={{
            width: 2.5,
            height: 13,
            transformOrigin: 'center',
            animation: `edith-wave ${period}s ease-in-out ${i * 0.12}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// The [clip "name" id:… at Xs-Ys on the timeline] token EDITH targets is part of
// the persisted history text. It must never be SHOWN — parse it back out so a
// reloaded chat renders the same clean card the user saw when sending.
const CLIP_TOKEN_RE = /\s*\[clip "([^"]+)" id:([^\s\]]+) at ([\d.]+)s-([\d.]+)s on the timeline\]/g;
function extractClipTokens(text: string): {
  clean: string;
  clips: NonNullable<AgentMessage['clipAttachments']>;
} {
  const clips: NonNullable<AgentMessage['clipAttachments']> = [];
  const clean = text.replace(CLIP_TOKEN_RE, (_m, name, trackId, s, e) => {
    clips.push({ trackId, name, startSec: parseFloat(s), endSec: parseFloat(e) });
    return '';
  }).trim();
  return { clean, clips };
}

// EDITH's own fetches (b-roll downloads, sourced images) persist as a system-role
// token line — system entries never re-enter the LLM's context on reload, but the
// UI parses them back into the same playable card the user saw live.
const MEDIA_TOKEN_RE = /^\[fetched (video|audio|image) "([^"]*)" media:([^\s\]]+)\]$/;
function fmtMediaDuration(sec: number | undefined): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function mediaTokenText(card: NonNullable<AgentMessage['mediaCard']>): string {
  return `[fetched ${card.mediaType} "${card.name.replace(/"/g, "'")}" media:${card.mediaId}]`;
}

function historyToMessages(entries: HistoryEntry[]): AgentMessage[] {
  return entries
    // Internal agent-loop "continue" turns fire silently (no chat bubble) when they
    // run live. They are still persisted because EDITH needs them in her context, so
    // a reload would otherwise paint them as fake user messages. Drop them from the
    // DISPLAY only — the backend history EDITH reasons over is untouched, so this
    // just makes a reloaded chat match what was shown live.
    .filter((e) => !(e.role === 'user' && /^continue($| \()/.test(e.text.trim())))
    .map((e, i) => {
    if (e.role === 'system') {
      const m = e.text.match(MEDIA_TOKEN_RE);
      if (m) {
        return {
          id: e.id,
          role: 'edith' as AgentMessage['role'],
          text: '',
          timestamp: e.timestamp,
          mediaCard: { mediaType: m[1] as 'video' | 'audio' | 'image', name: m[2], mediaId: m[3] },
        };
      }
    }
    if (e.role === 'edith' && e.text.startsWith('PLAN:')) {
      try {
        const steps = JSON.parse(e.text.slice(5).trim()) as Array<{ id: string; step: string }>;
        return {
          id: e.id,
          role: 'edith' as AgentMessage['role'],
          text: '',
          timestamp: e.timestamp,
          plan: {
            steps: steps.map((s) => ({ ...s, status: 'done' as const })),
            generating: false,
            open: false,
          },
        };
      } catch { /* fall through */ }
    }
    if (e.role === 'user') {
      const { clean, clips } = extractClipTokens(e.text);
      return {
        id: e.id,
        role: 'user' as AgentMessage['role'],
        text: clean,
        timestamp: e.timestamp,
        ...(clips.length > 0 && { clipAttachments: clips }),
      };
    }
    return {
      id: e.id,
      role: e.role as AgentMessage['role'],
      text: e.text,
      timestamp: e.timestamp,
    };
  });
}

export function FridayPanel({ className }: { className?: string }) {
  const hidePanel = usePanelStore((state) => state.hidePanel);

  const currentProjectId = useVideoEditorStore((state) => state.currentProjectId);
  const currentOpLabel = useEdithEditingStore((s) => s.currentOpLabel);
  const isEditing = useEdithEditingStore((s) => s.isEditing);
  const isThinkingStore = useEdithEditingStore((s) => s.isThinking);

  // Consent state: per-project, skip if this project already agreed or has existing history
  const getConsentKey = () => `edith-consent-${currentProjectId ?? 'default'}`;
  const [consentGiven, setConsentGiven] = useState(() => localStorage.getItem(`edith-consent-${currentProjectId ?? 'default'}`) === 'true');

  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: '0',
      role: 'system',
      text: 'Ready. Drop footage into the timeline or tell me what to cut.',
      timestamp: Date.now(),
    },
  ]);
  const [queue, setQueue] = useState<QueuedOp[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [activeAgent, setActiveAgent] = useState<AgentMessage['role'] | null>(null);
  const getDraftKey = () => `edith-draft-${currentProjectId ?? 'default'}`;
  const [input, setInput] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ name: string; path: string; preview?: string }>>([]);
  const [activeDownloads, setActiveDownloads] = useState<{ url: string; topic?: string }[]>([]);
  // Media the user clicked to preview — resolved to a playable src at click time
  // so every card kind (EDITH's fetches, attached timeline clips) opens the same
  // full-size player. seekTo starts a clip at its own source in-point.
  const [mediaPreview, setMediaPreview] = useState<{
    src: string; name: string; mediaType: 'video' | 'audio' | 'image'; seekTo?: number;
  } | null>(null);
  const [sfxLibrary, setSfxLibrary] = useState<SfxEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputTaRef = useRef<HTMLTextAreaElement>(null);
  const activePlanIdRef = useRef<string | null>(null);
  const agentStatusRef = useRef<AgentStatus>('idle');
  const interruptedRef = useRef(false);
  // EDITH is kept mounted when you switch panels (so a running op survives), so the
  // document-level Escape/Copy shortcuts must only fire while EDITH is the VISIBLE
  // panel. Otherwise a hidden EDITH would swallow Escape (cancelling her) or Copy from
  // whatever panel you are actually looking at.
  const panelTypeForVisibility = usePanelStore((s) => s.activePanelType);
  const isPanelVisibleRef = useRef(true);
  const pendingSlowOpsRef = useRef<Set<string>>(new Set());
  const pendingSnapshotAnalysisRef = useRef<string | null>(null);
  // QA tracking — count substantial ops per EDITH run, trigger QA after done
  const substantialOpsThisRunRef = useRef(0);
  const qaRunningRef = useRef(false);
  // Self-correction memory loop
  const isQACorrectionRunRef = useRef(false);
  const lastQAIssuesRef = useRef<any[]>([]);
  const lastUserRequestRef = useRef('');
  // Transcription chunk pipeline — fires EDITH per 30s chunk while Whisper runs in background
  const pendingTranscriptChunksRef = useRef<Array<{chunkIndex: number; startTime: number; endTime: number; text: string}>>([]);
  const edithLlmActiveRef = useRef(false);
  const transcriptionPipelineActiveRef = useRef(false);
  const pendingDownloadContinueRef = useRef(false);
  // Reference analysis: id of the live reasoning card being streamed to, and the
  // auto-continue note held back if analysis lands while an LLM turn is running.
  const activeReasoningIdRef = useRef<string | null>(null);
  const pendingReferenceNoteRef = useRef<string | null>(null);
  const [approvalTransitioning, setApprovalTransitioning] = useState(false);
  const denyContextRef = useRef<string | null>(null);
  // Gate: once a download op is seen in a turn, drop all subsequent non-download ops.
  // Prevents EDITH from placing broll in the same turn as downloads (files don't exist yet).
  const seenDownloadThisTurnRef = useRef(false);
  const mediaLibrary = useVideoEditorStore((state) => state.mediaLibrary);
  const tracks = useVideoEditorStore((state) => state.tracks);
  // NOTE: do not subscribe to state.timeline here. Every field this panel reads
  // off it (fps, currentFrame, totalFrames) is read through getState() inside
  // callbacks, so the subscription was dead weight — but currentFrame lives
  // inside that object, so it re-rendered this whole panel on every playhead
  // tick during playback and starved the preview canvas.
  // Drag-a-clip-into-the-chat: while a timeline clip is mid-drag the input lights
  // up; releasing over it attaches the clip as a card (thumbnail + time range).
  // The [clip …] token EDITH targets is serialized only when the message sends.
  const clipDragActive = useVideoEditorStore(
    (state) => !!(state.playback.dragGhost?.isActive && state.playback.dragGhost?.trackId),
  );
  const [clipRefs, setClipRefs] = useState<Array<{
    trackId: string; name: string; startSec: number; endSec: number; thumbnail?: string;
  }>>([]);
  const handleClipDropIntoChat = useCallback(() => {
    const s = useVideoEditorStore.getState() as any;
    const ghost = s.playback.dragGhost;
    if (!ghost?.isActive || !ghost.trackId) return;
    const clip = s.tracks.find((t: any) => t.id === ghost.trackId);
    if (!clip) return;
    // CRITICAL: the live drag has ALREADY displaced the clip by the time the
    // mouse reaches the chat — its current startFrame is mid-drag garbage.
    // The clip's true position is where the drag STARTED.
    const dragOrigin = s.playback.dragStartFrame ?? clip.startFrame;
    const fps = getDisplayFps(s.tracks) || 30;
    const durFrames = clip.endFrame - clip.startFrame;
    const startSec = +(dragOrigin / fps).toFixed(1);
    const endSec = +((dragOrigin + durFrames) / fps).toFixed(1);
    const media = (s.mediaLibrary ?? []).find((m: any) => m.id === clip.mediaId);
    setClipRefs((prev) =>
      prev.some((r) => r.trackId === clip.id)
        ? prev
        : [...prev, { trackId: clip.id, name: clip.name, startSec, endSec, thumbnail: media?.thumbnail }],
    );
    // The drop landed in chat, not on a timeline row — end the drag with NO move
    // and no undo entry, then snap the clip (and its linked partner) back to the
    // drag origin.
    s.endDraggingTrack?.(false);
    s.clearDragGhost?.();
    const fresh = useVideoEditorStore.getState() as any;
    const moved = fresh.tracks.find((t: any) => t.id === clip.id);
    if (moved && moved.startFrame !== dragOrigin) {
      const delta = moved.startFrame - dragOrigin;
      fresh.updateTrack(moved.id, {
        startFrame: moved.startFrame - delta,
        endFrame: moved.endFrame - delta,
      });
      if (moved.isLinked && moved.linkedTrackId) {
        const partner = fresh.tracks.find((t: any) => t.id === moved.linkedTrackId);
        if (partner) {
          fresh.updateTrack(partner.id, {
            startFrame: partner.startFrame - delta,
            endFrame: partner.endFrame - delta,
          });
        }
      }
    }
  }, []);
  // Selection tool — arm it from the chat box, then click a timeline clip to attach
  // it as the same card a drag-into-chat produces. 'single' disarms after one pick;
  // double-clicking the target button arms 'persistent' (survives sends). Esc or
  // leaving the EDITH panel disarms, so a forgotten armed tool can't silently
  // hoover up every clip the user clicks while editing.
  const [selectionMode, setSelectionMode] = useState<'off' | 'single' | 'persistent'>('off');
  const attachClipByTrackId = useCallback((trackId: string) => {
    const s = useVideoEditorStore.getState() as any;
    const clip = s.tracks.find((t: any) => t.id === trackId);
    if (!clip) return;
    const fps = getDisplayFps(s.tracks) || 30;
    const startSec = +(clip.startFrame / fps).toFixed(1);
    const endSec = +(clip.endFrame / fps).toFixed(1);
    const media = (s.mediaLibrary ?? []).find((m: any) => m.id === clip.mediaId);
    setClipRefs((prev) =>
      prev.some((r) => r.trackId === clip.id)
        ? prev
        : [...prev, { trackId: clip.id, name: clip.name, startSec, endSec, thumbnail: media?.thumbnail }],
    );
  }, []);
  useEffect(() => {
    if (selectionMode === 'off') return;
    const store = useVideoEditorStore.getState() as any;
    // Arming clears the timeline selection so the very next click attaches — without
    // this, picking the clip that was already selected produces no store change.
    store.setSelectedTracks?.([]);
    let prevIds: string[] = (useVideoEditorStore.getState() as any).timeline?.selectedTrackIds ?? [];
    const unsub = useVideoEditorStore.subscribe((s: any) => {
      const ids: string[] = s.timeline?.selectedTrackIds ?? [];
      if (ids === prevIds) return;
      const added = ids.filter((id) => !prevIds.includes(id));
      prevIds = ids;
      if (added.length === 0) return;
      // One click can select a linked video+audio pair — attach only the video half.
      const byId = new Map<string, any>(s.tracks.map((t: any) => [t.id, t]));
      const picked = added.filter((id) => {
        const c = byId.get(id);
        if (!c) return false;
        return !(c.isLinked && c.linkedTrackId && added.includes(c.linkedTrackId) && c.type === 'audio');
      });
      if (picked.length === 0) return;
      picked.forEach(attachClipByTrackId);
      if (selectionMode === 'single') setSelectionMode('off');
    });
    return unsub;
  }, [selectionMode, attachClipByTrackId]);
  useEffect(() => {
    if (selectionMode === 'off') return;
    // Capture-phase so this Esc ONLY exits selection mode — it must not also reach
    // the document-level Esc that cancels a running EDITH turn.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSelectionMode('off');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectionMode]);
  useEffect(() => {
    if (panelTypeForVisibility !== 'friday') setSelectionMode('off');
  }, [panelTypeForVisibility]);
  const approvalPending = useDownloadApprovalStore((s) => s.pending);
  const approvalApprove = useDownloadApprovalStore((s) => s.approve);
  const approvalApproveAll = useDownloadApprovalStore((s) => s.approveAll);
  const approvalDeny = useDownloadApprovalStore((s) => s.deny);

  // Load SFX library once on mount
  useEffect(() => {
    window.electronAPI.invoke('scan-sfx-library').then((result: any) => {
      if (result?.entries?.length) {
        setSfxLibrary(result.entries);
        setSfxLibraryCache(result.entries);
        console.log(`[SFX] Loaded ${result.entries.length} effects from ${result.libPath}`);
      }
    }).catch(() => {});
  }, []);

  // Load history + draft when project changes; auto-grant consent if history exists
  useEffect(() => {
    if (!currentProjectId) return;
    try { setInput(localStorage.getItem(`edith-draft-${currentProjectId}`) ?? ''); } catch {}
    window.electronAPI.invoke('mycelium:setProject', currentProjectId).then((result: any) => {
      if (result?.messages?.length) {
        setMessages(historyToMessages(result.messages));
        // History exists — consent was implicitly given in a prior session
        setConsentGiven(true);
      } else {
        setMessages([{
          id: '0',
          role: 'system',
          text: 'Ready. Drop footage into the timeline or tell me what to cut.',
          timestamp: Date.now(),
        }]);
      }
    });
  }, [currentProjectId]);

  // Shared silent continue — fires EDITH with fresh context, no chat bubble
  const triggerAutoContinue = useCallback((contextNote?: string) => {
    edithLlmActiveRef.current = true; // EDITH LLM subprocess is about to start
    setTimeout(() => {
      if (interruptedRef.current) {
        edithLlmActiveRef.current = false;
        return;
      }
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const mediaCtx = (s.mediaLibrary ?? []).map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type ?? 'video',
        duration: item.duration,
        path: item.tempFilePath || item.source || '',
        isReference: item.category === 'reference',
        transcription: item.cachedKaraokeSubtitles?.transcriptionResult
          ? item.cachedKaraokeSubtitles.transcriptionResult.segments
              ?.map((seg: any) => {
                const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;
                return `[${fmt(seg.start)}-${fmt(seg.end)}] ${seg.text.trim()}`;
              }).join('\n')
          : undefined,
        referenceAnalysis: item.referenceAnalysis,
      }));
      const timelineCtx = {
        fps,
        currentFrame: s.timeline?.currentFrame ?? 0,
        totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id,
          mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '',
          type: t.type,
          layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0,
          endFrame: t.endFrame ?? 0,
          durationFrames: t.duration ?? ((t.endFrame ?? 0) - (t.startFrame ?? 0)),
          volume: t.volume,
          muted: t.muted,
          letterboxBlur: t.proxyBlockedMessage === 'letterbox-blur' || undefined,
          captionText: t.type === 'subtitle' ? (t.subtitleText ?? t.textContent ?? undefined) : undefined,
          textContent: t.type === 'text' ? (t.textContent ?? undefined) : undefined,
          textType: t.type === 'text' ? (t.textType ?? undefined) : undefined,
        })),
      };
      const snapshotNote = pendingSnapshotAnalysisRef.current;
      pendingSnapshotAnalysisRef.current = null;
      // Queue-awareness: EDITH cannot see the op queue, so a continue turn after a
      // long op made her re-emit work she had already queued (observed: doubled
      // gradeReference/buildCaptions/zoomToFace stacks). Tell her what's in flight.
      let queueNote: string | null = null;
      try {
        const inFlight = operationEngine.getQueue()
          .filter((q) => q.status === 'pending' || q.status === 'running')
          .map((q) => (q.op as any).type);
        if (inFlight.length) {
          queueNote = `ops ALREADY queued/running from your previous turn (do NOT re-emit these, they are being applied): ${inFlight.join(', ')}`;
        }
      } catch { /* queue unavailable */ }
      const combinedNote = [snapshotNote, queueNote, contextNote].filter(Boolean).join(' | ');
      const text = combinedNote ? `continue (note: ${combinedNote})` : 'continue';
      window.electronAPI.invoke('mycelium:sendMessage', {
        text,
        mediaContext: mediaCtx,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      });
      setAgentStatus('running');
    }, 600);
  }, [sfxLibrary]);

  // Fires after each approved download — triggerContinue flag controls whether EDITH runs now
  useEffect(() => {
    const handler = (e: Event) => {
      const { triggerContinue } = (e as CustomEvent<{ remaining: number; triggerContinue?: boolean }>).detail;
      if (!triggerContinue || interruptedRef.current) return;
      if (edithLlmActiveRef.current) {
        pendingDownloadContinueRef.current = true;
      } else {
        triggerAutoContinue();
      }
    };
    window.addEventListener('edith:downloadImported', handler);
    return () => window.removeEventListener('edith:downloadImported', handler);
  }, [triggerAutoContinue]);

  // EDITH fetched media herself — drop a playable card into the chat and persist
  // it (as a system-role token) so a reloaded chat shows the same card.
  useEffect(() => {
    const handler = (e: Event) => {
      const card = (e as CustomEvent<NonNullable<AgentMessage['mediaCard']>>).detail;
      if (!card?.mediaId) return;
      setMessages((prev) => [...prev, {
        id: Math.random().toString(36).slice(2),
        role: 'edith' as const,
        text: '',
        timestamp: Date.now(),
        mediaCard: card,
      }]);
      window.electronAPI.invoke('mycelium:appendUiMessage', { text: mediaTokenText(card) }).catch(() => {});
    };
    window.addEventListener('edith:mediaFetched', handler);
    return () => window.removeEventListener('edith:mediaFetched', handler);
  }, []);

  // Deny clears the queue — prompt the user for a new direction
  useEffect(() => {
    const handler = (e: Event) => {
      const { title } = (e as CustomEvent<{ title: string }>).detail;
      denyContextRef.current = `The user denied the b-roll download "${title}". They will tell you what to search for instead — wait for their message.`;
      setMessages((prev) => [...prev, {
        id: Math.random().toString(36).slice(2),
        role: 'system' as const,
        text: `"${title}" denied — what should EDITH search for instead?`,
        timestamp: Date.now(),
      }]);
    };
    window.addEventListener('edith:downloadDenied', handler);
    return () => window.removeEventListener('edith:downloadDenied', handler);
  }, []);

  // Live reasoning feed — reference analysis streams its real pipeline stages here.
  // begin → new card; stage updates → append/refresh lines; finish → settle the card.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{
        title?: string; stage?: string; detail?: string;
        done?: boolean; begin?: boolean; finish?: boolean; failed?: boolean;
      }>).detail || {};
      if (d.begin) {
        const id = Math.random().toString(36).slice(2);
        activeReasoningIdRef.current = id;
        setMessages((prev) => [...prev, {
          id,
          role: 'edith' as const,
          text: '',
          timestamp: Date.now(),
          reasoning: {
            title: d.title || 'Analyzing the reference',
            stages: d.stage ? [{ stage: d.stage, detail: d.detail, status: 'active' as const }] : [],
            running: true,
            open: true,
            startedAt: Date.now(),
          },
        }]);
        return;
      }
      const id = activeReasoningIdRef.current;
      if (!id) return;
      setMessages((prev) => prev.map((m) => {
        if (m.id !== id || !m.reasoning) return m;
        const r = { ...m.reasoning, stages: [...m.reasoning.stages] };
        if (d.finish) {
          r.running = false;
          r.elapsedMs = Date.now() - r.startedAt;
          r.open = false;
          r.failed = !!d.failed;
          r.stages = r.stages.map((s) =>
            s.status === 'active' ? { ...s, status: d.failed ? 'failed' as const : 'done' as const } : s);
          return { ...m, reasoning: r };
        }
        if (d.stage) {
          const lastIdx = r.stages.length - 1;
          const last = r.stages[lastIdx];
          if (last && last.stage === d.stage) {
            r.stages[lastIdx] = { ...last, detail: d.detail ?? last.detail, status: d.done ? 'done' : last.status };
          } else {
            if (last && last.status === 'active') r.stages[lastIdx] = { ...last, status: 'done' };
            r.stages.push({ stage: d.stage, detail: d.detail, status: d.done ? 'done' : 'active' });
          }
        }
        return { ...m, reasoning: r };
      }));
      if (d.finish) activeReasoningIdRef.current = null;
    };
    window.addEventListener('edith:reasoning', handler);
    return () => window.removeEventListener('edith:reasoning', handler);
  }, []);

  // Analysis finished — auto-continue so EDITH moves from watching into applying.
  // If her LLM turn is somehow still open, hold the note and flush it on done.
  useEffect(() => {
    const handler = (e: Event) => {
      const { name, alreadyAnalyzed } = (e as CustomEvent<{ name: string; alreadyAnalyzed?: boolean }>).detail || {};
      if (interruptedRef.current) return;
      const note = alreadyAnalyzed
        ? `Reference "${name}" was already analyzed — its STYLE PROFILE is in your context under "Reference Videos". Move straight to applying it to the timeline footage.`
        : `Reference "${name}" analyzed — the full STYLE PROFILE is now in your context under "Reference Videos". Say in ONE short line what defines this style, then start applying it to the timeline footage following the profile's blocks and rules. NEVER place the reference itself on the timeline.`;
      if (edithLlmActiveRef.current) {
        pendingReferenceNoteRef.current = note;
      } else {
        triggerAutoContinue(note);
      }
    };
    window.addEventListener('edith:referenceAnalyzed', handler);
    return () => window.removeEventListener('edith:referenceAnalyzed', handler);
  }, [triggerAutoContinue]);

  // Transcription chunk pipeline — fire EDITH per 30s segment while Whisper runs in background
  const flushTranscriptChunks = useCallback(() => {
    const chunks = pendingTranscriptChunksRef.current.splice(0);
    if (!chunks.length) return;
    const startTime = chunks[0].startTime;
    const endTime = chunks[chunks.length - 1].endTime;
    const text = chunks.map((c: any) => c.text).join(' ').trim();
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const chunkNote = `Transcription chunk [${fmt(startTime)}–${fmt(endTime)}]: "${text.slice(0, 600)}". Captions for this window are being placed automatically — do NOT emit caption, resize, or letterbox. Emit at most 1 download op (isStockFootage:true, batch:5) for the single most visually compelling moment in this window. End your turn immediately after the download op (or immediately if nothing compelling).`;
    triggerAutoContinue(chunkNote);
  }, [triggerAutoContinue]);

  useEffect(() => {
    const handler = (e: Event) => {
      const chunk = (e as CustomEvent).detail;

      // Speaker diarization result — feed back to EDITH so she can name speakers
      if (chunk?.speakerDiarization) {
        const segs: Array<{speaker: string; start: number; end: number}> = chunk.segments ?? [];
        const speakers = [...new Set(segs.map(s => s.speaker))];
        const summary = speakers.map(spk => {
          const windows = segs.filter(s => s.speaker === spk)
            .map(s => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).slice(0, 5).join(', ');
          return `${spk}: ${windows}`;
        }).join('\n');
        const note = `Speaker diarization complete — ${speakers.length} speaker${speakers.length !== 1 ? 's' : ''} identified.\n${summary}\n\nThese are anonymous labels (SPEAKER_A, SPEAKER_B…). Cross-reference with the transcript to figure out who each label maps to — the first person to speak in the transcript is likely SPEAKER_A. Once you know who is who, use the speaker labels when writing B-roll queries and placing captions.`;
        setAgentStatus('running');
        const s = useVideoEditorStore.getState() as any;
        const fps = s.timeline?.fps || 30;
        window.electronAPI.invoke('mycelium:sendMessage', {
          text: `continue (${note})`,
          timelineSnapshot: {
            fps, currentFrame: s.timeline?.currentFrame ?? 0, totalFrames: s.timeline?.totalFrames ?? 0,
            selectedClipIds: s.selectedTrackIds ?? [],
            clips: (s.tracks ?? []).map((t: any) => ({
              id: t.id, mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
              sourcePath: t.source ?? '', type: t.type, layer: t.trackRowIndex ?? 0,
              startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
              durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
            })),
          },
          activeDownloads: [],
          sfxLibrary,
        }).catch(() => {});
        return;
      }

      if (!chunk?.text?.trim() || !transcriptionPipelineActiveRef.current) return;
      pendingTranscriptChunksRef.current.push({
        chunkIndex: chunk.chunkIndex,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        text: chunk.text,
      });
      if (!edithLlmActiveRef.current) {
        flushTranscriptChunks();
      }
    };
    window.addEventListener('edith:transcriptChunk', handler);
    return () => window.removeEventListener('edith:transcriptChunk', handler);
  }, [flushTranscriptChunks, sfxLibrary]);

  // Frame snapshot verification — EDITH jumps playhead, we capture + analyze, then auto-continue
  useEffect(() => {
    const handler = (e: Event) => {
      const { atSeconds, reason, analysis, error, frameBase64 } = (e as CustomEvent<{
        atSeconds: number; reason: string; analysis: string | null; error: string | null; frameBase64: string | null;
      }>).detail;
      const mins = String(Math.floor(atSeconds / 60)).padStart(2, '0');
      const secs = String(Math.floor(atSeconds % 60)).padStart(2, '0');
      const label = error
        ? `snapshot failed at ${mins}:${secs}`
        : `snapshot · ${mins}:${secs} · ${reason.slice(0, 50)}`;
      if (frameBase64) {
        useEdithEditingStore.getState().setLastVerifiedFrame(frameBase64, null);
        setTimeout(() => useEdithEditingStore.getState().setLastVerifiedFrame(null, null), 6000);
      }
      setMessages((prev) => [...prev, {
        id: Math.random().toString(36).slice(2),
        role: 'system',
        text: `__snapshot__${label}`,
        timestamp: Date.now(),
        imagePreviews: frameBase64 ? [`data:image/jpeg;base64,${frameBase64}`] : undefined,
      }]);
      pendingSnapshotAnalysisRef.current = analysis
        ? `Visual check at ${mins}:${secs}: ${analysis}`
        : `Visual check at ${mins}:${secs} failed — continue without visual feedback.`;
    };
    window.addEventListener('edith:snapshotTaken', handler);
    return () => window.removeEventListener('edith:snapshotTaken', handler);
  }, []);

  // scanVideo result — fires a continue turn with the found timestamp
  useEffect(() => {
    const handler = (e: Event) => {
      const { description, foundAtSec, frameBase64 } = (e as CustomEvent).detail;
      if (frameBase64) {
        useEdithEditingStore.getState().setLastVerifiedFrame(frameBase64, null);
        setTimeout(() => useEdithEditingStore.getState().setLastVerifiedFrame(null, null), 8000);
        setMessages((prev) => [...prev, {
          id: Math.random().toString(36).slice(2),
          role: 'system' as const,
          text: `__snapshot__Scene scan: ${description}`,
          timestamp: Date.now(),
          imagePreviews: [`data:image/jpeg;base64,${frameBase64}`],
        }]);
      }
      const allMatchesSec: number[] | null = (e as CustomEvent).detail?.allMatchesSec ?? null;
      let note: string;
      if (allMatchesSec !== null) {
        // findAll mode — format all matching timestamps into segment ranges for EDITH
        if (allMatchesSec.length === 0) {
          note = `Segment scan result: no frames matched "${description}". Ask the user for approximate timestamps.`;
        } else {
          const tsStr = allMatchesSec.map((t: number) => `${t.toFixed(1)}s`).join(', ');
          note = `Segment scan result: frames matching "${description}" found at: ${tsStr}. These are SAMPLED timestamps — the actual segment boundaries may be slightly before/after each. Derive contiguous ranges by grouping nearby timestamps, then emit deleteSegment ops to remove everything that does NOT match.`;
        }
      } else if (foundAtSec !== null && foundAtSec !== undefined) {
        note = `Scene scan result: "${description}" found at ${foundAtSec.toFixed(1)}s. Now place the SFX at that timestamp.`;
      } else {
        note = `Scene scan result: "${description}" was not found. Ask the user for the timestamp manually.`;
      }

      // Scan completes after EDITH's turn ends — fire a new continue turn with the result
      setAgentStatus('running');
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const timelineCtx = {
        fps,
        currentFrame: s.timeline?.currentFrame ?? 0,
        totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id,
          mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '',
          type: t.type, layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
          durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
        })),
      };
      window.electronAPI.invoke('mycelium:sendMessage', {
        text: `continue (${note})`,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      }).catch(() => {});
    };
    window.addEventListener('edith:scanVideoResult', handler);
    return () => window.removeEventListener('edith:scanVideoResult', handler);
  }, [sfxLibrary]);

  // findMoment result — fire a continue turn so EDITH confirms the jump OR reports a clean miss.
  // Without this she narrates "Scanning…" and never follows up (the result note was never delivered).
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const label = d.label || d.query || 'that';
      let note: string;
      if (d.found && d.atSec != null) {
        const mm = Math.floor(d.atSec / 60);
        const ss = Math.floor(d.atSec % 60).toString().padStart(2, '0');
        note = `findMoment result: "${label}" found at ${mm}:${ss}. The playhead already jumped there — confirm in ONE short line (e.g. "Jumped to ${mm}:${ss} — ${label}."). Do NOT emit any op.`;
      } else {
        note = `findMoment result: "${label}" was NOT found — the footage does not contain it, nothing changed, and the playhead did NOT move. Tell the user plainly that the footage doesn't have what they're looking for, and ask them to either be more specific or point you at different footage. Do NOT invent a timestamp, do NOT jump anywhere, do NOT emit any op.`;
      }
      setAgentStatus('running');
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const timelineCtx = {
        fps,
        currentFrame: s.timeline?.currentFrame ?? 0,
        totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id,
          mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '',
          type: t.type, layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
          durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
        })),
      };
      window.electronAPI.invoke('mycelium:sendMessage', {
        text: `continue (${note})`,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      }).catch(() => {});
    };
    window.addEventListener('edith:findMomentResult', handler);
    return () => window.removeEventListener('edith:findMomentResult', handler);
  }, [sfxLibrary]);

  // searchMedia result — feed the YouTube candidate list back so EDITH reasons over
  // sources (resolution keywords, view counts, channel credibility) and picks one
  // before emitting a download. Same continue-turn pattern as findMoment/scanVideo.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      let note: string;
      if (d.success && Array.isArray(d.candidates) && d.candidates.length) {
        const list = d.candidates.map((c: any, i: number) => {
          const dur = c.durationSec != null
            ? `${Math.floor(c.durationSec / 60)}:${String(Math.floor(c.durationSec % 60)).padStart(2, '0')}`
            : 'unknown length';
          const views = c.viewCount != null ? `${c.viewCount.toLocaleString('en-US')} views` : 'view count unknown';
          return `${i + 1}. "${c.title}" — ${dur}, ${views}, channel: ${c.channel ?? 'unknown'} — ${c.url}`;
        }).join('\n');
        note = `searchMedia result for "${d.query}" — ${d.candidates.length} candidates:\n${list}\n\nReason over these like an editor sourcing footage: prefer resolution keywords (4K/HDR/1080p) in the title, high view counts, credible clip channels, and a duration that fits the need. Skip reactions, essays, fan edits, and vertical crops. Tell the user in ONE line which you picked and why, then emit download with that exact url and a concrete verify description of what must be visible.`;
      } else {
        note = `searchMedia found nothing for "${d.query}"${d.error ? ` (${d.error})` : ''}. Rephrase the query with the most distinctive words (movie title + scene nouns) and try searchMedia once more, or ask the user for a link. Do NOT emit a blind download.`;
      }
      setAgentStatus('running');
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const timelineCtx = {
        fps,
        currentFrame: s.timeline?.currentFrame ?? 0,
        totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id,
          mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '',
          type: t.type, layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
          durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
        })),
      };
      window.electronAPI.invoke('mycelium:sendMessage', {
        text: `continue (${note})`,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      }).catch(() => {});
    };
    window.addEventListener('edith:searchMediaResult', handler);
    return () => window.removeEventListener('edith:searchMediaResult', handler);
  }, [sfxLibrary]);

  // Media handed off from the Record studio ("Send to EDITH") — lands as a file
  // chip in the input. Consumed on mount AND on the live event, because this
  // panel mounts lazily on first open.
  useEffect(() => {
    const attach = () => {
      const item = consumePendingEdithAttachment();
      if (!item?.path) return;
      setAttachments((prev) =>
        prev.some((a) => a.path === item.path)
          ? prev
          : [...prev, { name: item.name, path: item.path, preview: item.preview }],
      );
      inputTaRef.current?.focus();
    };
    attach();
    window.addEventListener('edith:attachMedia', attach);
    return () => window.removeEventListener('edith:attachMedia', attach);
  }, []);

  // removeFillersFromMedia result — the cleaned file is already imported (its card
  // is in chat via edith:mediaFetched); this continue turn is narration only.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as any;
      let note: string;
      if (!d.success) {
        note =
          `removeFillersFromMedia result: the pipeline FAILED (${d.error ?? 'unknown error'}). ` +
          'Tell the user honestly it did not work and they can try again. Do NOT claim anything was removed, do NOT emit any op.';
      } else if (!d.removedCount) {
        note =
          'removeFillersFromMedia result: the transcription found NO filler words — the take is already clean. ' +
          'Tell the user that in one line. Nothing was created or imported. Do NOT emit any op. ' +
          'ZERO cuts were made this run — any filler counts from earlier in the conversation are from a different run; do not mention them.';
      } else {
        const parts = Object.entries(d.breakdown ?? {})
          .map(([w, n]) => `"${w}" ×${n}`)
          .join(', ');
        note =
          `removeFillersFromMedia result: removed ${d.removedCount} filler word(s) (${parts}), cutting ${d.removedSec}s total. ` +
          `The cleaned file is imported into the media panel as "${d.importedName}" and its playable card is already shown in chat. ` +
          'Tell the user in one or two lines what was removed and where the clean version lives. Do NOT place anything on the timeline unless they ask. Do NOT emit any op.';
      }
      setAgentStatus('running');
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const timelineCtx = {
        fps,
        currentFrame: s.timeline?.currentFrame ?? 0,
        totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id,
          mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '',
          type: t.type, layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
          durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
        })),
      };
      window.electronAPI.invoke('mycelium:sendMessage', {
        text: `continue (${note})`,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      }).catch(() => {});
    };
    window.addEventListener('edith:removeFillersFileResult', handler);
    return () => window.removeEventListener('edith:removeFillersFileResult', handler);
  }, [sfxLibrary]);

  // organizeMedia result — feed the folder breakdown back so EDITH narrates the
  // summary (a line + one bullet per folder). The library was already re-foldered
  // by the op; this turn is narration only.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      let note: string;
      if (d.success) {
        const folders: Array<{ name: string; count: number }> = d.folders || [];
        const breakdown = folders.map((f) => `${f.name} (${f.count})`).join(', ');
        note =
          `organizeMedia result: done. The media library is now sorted into ${folders.length} ` +
          `folder(s): ${breakdown}. Confirm with ONE short line, then a bullet list with one ` +
          `folder per line exactly "- <Folder> (<count>)", in that order. Do NOT emit any op.`;
      } else if (d.empty) {
        note =
          'organizeMedia result: there is no media to organize — the library is empty. Tell the ' +
          'user there is nothing to sort yet. Do NOT emit any op.';
      } else {
        note =
          `organizeMedia result: the organize did not complete (${d.error || 'unknown error'}). ` +
          'Tell the user briefly that it did not work and they can try again. Do NOT emit any op.';
      }
      setAgentStatus('running');
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const timelineCtx = {
        fps,
        currentFrame: s.timeline?.currentFrame ?? 0,
        totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id,
          mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '',
          type: t.type, layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
          durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
        })),
      };
      window.electronAPI.invoke('mycelium:sendMessage', {
        text: `continue (${note})`,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      }).catch(() => {});
    };
    window.addEventListener('edith:organizeMediaResult', handler);
    return () => window.removeEventListener('edith:organizeMediaResult', handler);
  }, [sfxLibrary]);

  // detectTransients result — feed timestamps back to EDITH so she can place SFX
  useEffect(() => {
    const handler = (e: Event) => {
      const { transients, count } = (e as CustomEvent).detail as { transients: number[]; count: number };
      let note: string;
      if (!transients || transients.length === 0) {
        note = 'Transient detection result: no transients found. The audio may be too quiet or the clip may have no percussive events.';
      } else {
        const sample = transients.slice(0, 20).map((t: number) => `${t.toFixed(3)}s`).join(', ');
        const suffix = count > 20 ? ` … (${count} total)` : '';
        note = `Transient detection result: ${count} audio spikes found at: ${sample}${suffix}. These are the exact onset timestamps. Now place the appropriate SFX at each relevant one using placeSFX — match each spike to the best-fit file from the SFX Library. Skip spikes that fall during speech or silence gaps where SFX would clash.`;
      }
      setAgentStatus('running');
      const s = useVideoEditorStore.getState() as any;
      const fps = s.timeline?.fps || 30;
      const timelineCtx = {
        fps, currentFrame: s.timeline?.currentFrame ?? 0, totalFrames: s.timeline?.totalFrames ?? 0,
        selectedClipIds: s.selectedTrackIds ?? [],
        clips: (s.tracks ?? []).map((t: any) => ({
          id: t.id, mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
          sourcePath: t.source ?? '', type: t.type, layer: t.trackRowIndex ?? 0,
          startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
          durationFrames: (t.endFrame ?? 0) - (t.startFrame ?? 0),
        })),
      };
      window.electronAPI.invoke('mycelium:sendMessage', {
        text: `continue (${note})`,
        timelineSnapshot: timelineCtx,
        activeDownloads: [],
        sfxLibrary,
      }).catch(() => {});
    };
    window.addEventListener('edith:transientsResult', handler);
    return () => window.removeEventListener('edith:transientsResult', handler);
  }, [sfxLibrary]);

  // B-roll quality check thumbnails pushed from main process
  useEffect(() => {
    const handler = (_: unknown, data: { label: string; duration: number; passed: boolean; reason: string; frameBase64: string | null }) => {
      if (data.frameBase64) {
        useEdithEditingStore.getState().setLastVerifiedFrame(data.frameBase64, data.passed);
        setTimeout(() => useEdithEditingStore.getState().setLastVerifiedFrame(null, null), 6000);
      }
      const statusText = data.passed ? 'passed' : `rejected — ${data.reason}`;
      setMessages((prev) => [...prev, {
        id: Math.random().toString(36).slice(2),
        role: 'system',
        text: `__brollcheck__${data.passed ? '✓' : '✗'} "${data.label}" ${data.duration}s — ${statusText}`,
        timestamp: Date.now(),
        imagePreviews: data.frameBase64 ? [`data:image/jpeg;base64,${data.frameBase64}`] : undefined,
      }]);
    };
    (window.electronAPI as any).on('edith:brollCheck', handler);
    return () => (window.electronAPI as any).removeListener('edith:brollCheck', handler);
  }, []);

  // IPC listeners
  useEffect(() => {
    (window as any).myceliumAPI?.removeAllListeners?.();

    const SUBSTANTIAL_OP_TYPES = new Set([
      // V1 names
      'addCaption', 'setBroll', 'insertClip', 'colorGrade', 'trimClip', 'cutSilence',
      // V2 names
      'caption', 'broll', 'grade', 'trim', 'silence', 'transcribe',
    ]);
    const offApplied = operationEngine.on('opApplied', (_opId: string, op: unknown) => {
      setQueue(operationEngine.getQueue());
      if (SUBSTANTIAL_OP_TYPES.has((op as any)?.type)) {
        substantialOpsThisRunRef.current += 1;
      }
      const stepId = (op as any)?.stepId as string | undefined;
      if (stepId && activePlanIdRef.current) {
        const planId = activePlanIdRef.current;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== planId || !m.plan) return m;
            const steps = m.plan.steps.map((s) => {
              if (s.id === stepId) return { ...s, status: 'active' as const };
              if (s.status === 'active' && s.id !== stepId) return { ...s, status: 'done' as const };
              return s;
            });
            return { ...m, plan: { ...m.plan, steps } };
          }),
        );
      }
      // Auto-continue after slow ops (runWhisper / analyzeReference / geminiEdit) complete
      if (pendingSlowOpsRef.current.has(_opId)) {
        pendingSlowOpsRef.current.delete(_opId);
        if (pendingSlowOpsRef.current.size === 0) {
          const completedOp = op as any;
          let note: string | undefined;
          const isTranscribeOp = completedOp?.type === 'runWhisper' || completedOp?.type === 'transcribe';
          if (isTranscribeOp && completedOp?.streamCaptions !== false) {
            transcriptionPipelineActiveRef.current = false;
            note = 'Transcription fully complete. Check ## Timeline — if subtitle clips exist, captions were placed automatically, so do NOT emit caption ops. Now decide which case you are in: (a) the user asked ONLY to transcribe/caption → STOP here and confirm it is done, do NOT cut, grade, zoom, or download/place b-roll on your own; (b) transcription was ONE STEP of a larger request or of a plan you announced (a full edit, "edit this video", applying a reference style) → CONTINUE with the next step of that plan RIGHT NOW, in this turn — emit its ops, do not stop to announce the transcript and do not wait for acknowledgment. In both cases b-roll stays off unless it was explicitly requested.';
          } else if (isTranscribeOp && completedOp?.streamCaptions === false) {
            note = 'Transcription complete. The full transcript is now in ## Available Project Media. Now decide which case you are in: (a) the user asked ONLY to transcribe → STOP and confirm it is ready, do NOT emit captions, cuts, grade, zoom, or b-roll on your own; (b) transcription was ONE STEP of a larger request or of a plan you announced (a full edit, applying a reference style) → CONTINUE with the next step of that plan RIGHT NOW, in this turn — emit its ops, do not stop or wait for acknowledgment. In both cases b-roll stays off unless it was explicitly requested.';
          }
          triggerAutoContinue(note);
        }
      }
    });
    const offFailed = operationEngine.on('opFailed', (_opId: string, op: unknown) => {
      setQueue(operationEngine.getQueue());
      const failed = operationEngine.getQueue().find((q) => q.id === _opId);
      const errText = failed?.error ?? 'Op failed';
      const opType = (op as any)?.type ?? 'unknown';
      console.error('[FridayPanel] op failed:', opType, errText);
      setMessages((prev) => [...prev, {
        id: Math.random().toString(36).slice(2),
        role: 'system' as const,
        text: `Op failed (${opType}): ${errText}`,
        timestamp: Date.now(),
      }]);
      setTimeout(() => setQueue(operationEngine.getQueue().filter((q) => q.status !== 'failed')), 4000);
      // If a slow op fails, still auto-continue so EDITH knows and can recover
      if (pendingSlowOpsRef.current.has(_opId)) {
        pendingSlowOpsRef.current.delete(_opId);
        if (pendingSlowOpsRef.current.size === 0) {
          triggerAutoContinue(`Op ${opType} failed: ${errText}. Adapt your plan accordingly.`);
        }
      }
    });
    const offDrained = operationEngine.on('queueDrained', () => {
      setQueue(operationEngine.getQueue());
      setAgentStatus('done');
    });
    const offPaused = operationEngine.on('paused', () => setAgentStatus('paused'));
    const offResumed = operationEngine.on('resumed', () => setAgentStatus('running'));

    const handleAgentMsg = (_: unknown, data: { role: AgentMessage['role']; text: string; imagePreviews?: string[] }) => {
      if (interruptedRef.current) return;
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).slice(2),
          role: data.role,
          text: data.text,
          timestamp: Date.now(),
          ...(data.imagePreviews?.length && { imagePreviews: data.imagePreviews }),
        },
      ]);
      if (data.role !== 'user' && data.role !== 'system') {
        setActiveAgent(data.role);
        setAgentStatus('running');
        // EDITH is speaking — she's thinking, not executing an op
        if (useEdithEditingStore.getState().isEditing) {
          useEdithEditingStore.getState().setIsThinking(true);
        }
      }
    };

    const handleOp = (_: unknown, opData: unknown) => {
      if (interruptedRef.current) return;
      try {
        const op = typeof opData === 'string' ? JSON.parse(opData) : opData;
        const isDownload = op.type === 'downloadMedia' || op.type === 'download';

        // Enforce the download rule: once a download op is seen in a turn, drop every
        // subsequent non-download op. Downloads are async — files don't exist in the media
        // library until the next turn, so broll/caption ops placed after downloads fail silently.
        if (seenDownloadThisTurnRef.current && !isDownload) {
          console.warn(`[FridayPanel] Dropping op '${op.type}' — emitted after download in same turn`);
          return;
        }

        if (isDownload) {
          seenDownloadThisTurnRef.current = true;
          setActiveDownloads((prev) => [...prev, { url: op.url ?? op.query, topic: op.topic ?? op.query }]);
        }
        const qId = operationEngine.enqueue(op);
        // V1 + V2 slow op names — completion fires triggerAutoContinue with a context note
        if (op.type === 'runWhisper' || op.type === 'transcribe' || op.type === 'analyzeReference' || op.type === 'geminiEdit' || op.type === 'snapshotVerify' || op.type === 'snapshot') {
          pendingSlowOpsRef.current.add(qId);
        }
        // Arm the per-chunk B-ROLL pipeline ONLY when auto b-roll was explicitly
        // requested. A plain transcribe (no `autoBroll`) must NEVER fire EDITH per
        // chunk to download stock footage — transcription is standalone. Previously
        // this armed on `streamCaptions !== false`, which is `true` for a plain
        // transcribe (streamCaptions undefined), so "transcribe, don't do anything
        // else" wrongly auto-downloaded b-roll. B-roll is now opt-in: the user asks
        // for footage explicitly, or a reel flow sets `autoBroll: true` on the op.
        if ((op.type === 'runWhisper' || op.type === 'transcribe') && (op as any).autoBroll === true) {
          transcriptionPipelineActiveRef.current = true;
          pendingTranscriptChunksRef.current = [];
        }
        setQueue(operationEngine.getQueue());
      } catch (e) {
        console.error('[FridayPanel] bad op:', e);
      }
    };

    const runPostEditQA = async (isVerification = false) => {
      if (qaRunningRef.current || interruptedRef.current) return;
      qaRunningRef.current = true;

      try {
        const s = useVideoEditorStore.getState() as any;
        const fps: number = s.timeline?.fps ?? 30;
        const allTracks: any[] = s.tracks ?? [];
        const mediaLib: any[] = s.mediaLibrary ?? [];

        // Build QAClip list
        const clips = allTracks
          .filter((t) => t.type === 'video' || t.type === 'subtitle')
          .map((t) => ({
            id: t.id,
            type: t.type,
            layer: t.trackRowIndex ?? 0,
            sourcePath: t.source ?? '',
            startFrame: t.startFrame ?? 0,
            endFrame: t.endFrame ?? 0,
            sourceOffset: t.sourceStartTime ?? 0,
            subtitleY: t.subtitleTransform?.y,
            subtitleText: t.subtitleText,
          }));

        // Build transcript context for b-roll clips
        const transcriptionSegs: any[] = (() => {
          for (const m of mediaLib) {
            const segs = m.cachedKaraokeSubtitles?.transcriptionResult?.segments;
            if (segs?.length) return segs;
          }
          return [];
        })();
        const mainClip = clips.find((c) => c.type === 'video' && c.layer === 0);
        const mainOffset = mainClip?.sourceOffset ?? 0;
        for (const clip of clips) {
          if (clip.type === 'video' && clip.layer > 0 && transcriptionSegs.length) {
            const timelineStart = clip.startFrame / fps;
            const sourceSec = mainOffset + timelineStart;
            const seg = transcriptionSegs.find((seg: any) => seg.start <= sourceSec && seg.end >= sourceSec);
            if (seg) (clip as any).transcriptContext = seg.text.trim();
          }
        }

        // Find reference video for style comparison
        let reference: { sourcePath: string; midpointSeconds: number } | undefined;
        const refItem = mediaLib.find((m) => m.category === 'reference' && m.referenceAnalysis);
        if (refItem) {
          const refPath = refItem.tempFilePath || refItem.source;
          const refDur = refItem.duration ?? 30;
          if (refPath) reference = { sourcePath: refPath, midpointSeconds: refDur / 2 };
        }

        // Capture a live canvas screenshot with captions rendered
        // Seek to the first caption's frame, wait for render, then grab the canvas
        let captionScreenshot: string | undefined;
        const firstCaption = allTracks.find((t: any) => t.type === 'subtitle');
        if (firstCaption) {
          try {
            useVideoEditorStore.getState().setCurrentFrame(firstCaption.startFrame ?? 0);
            await new Promise((r) => setTimeout(r, 350)); // let canvas re-render
            const previewCanvas = document.querySelector<HTMLCanvasElement>('[data-preview-canvas="true"]');
            if (previewCanvas) {
              const dataUrl = previewCanvas.toDataURL('image/jpeg', 0.82);
              if (dataUrl && dataUrl.length > 100) {
                captionScreenshot = dataUrl.split(',')[1]; // strip data:image/jpeg;base64,
              }
            }
          } catch {
            // non-fatal — vision check will proceed without caption screenshot
          }
        }

        setMessages((prev) => [
          ...prev,
          { id: Math.random().toString(36).slice(2), role: 'system' as const, text: 'Running QA check…', timestamp: Date.now() },
        ]);

        const result = await (window.electronAPI as any).invoke('mycelium:runQA', { clips, fps, reference, captionScreenshot });
        if (!result.success) throw new Error(result.error);

        const qa = result.result;
        const allIssues = [...(qa.programmatic ?? []), ...(qa.issues ?? [])];

        if (allIssues.length === 0 && qa.passed) {
          setMessages((prev) => [
            ...prev.filter((m) => m.text !== 'Running QA check…'),
            { id: Math.random().toString(36).slice(2), role: 'system' as const, text: `QA passed — ${qa.summary}`, timestamp: Date.now() },
          ]);
          // Verification pass after a correction: record lessons for each original issue
          if (isVerification) {
            const origIssues = lastQAIssuesRef.current;
            const userReq = lastUserRequestRef.current;
            for (const iss of origIssues) {
              (window.electronAPI as any).invoke('mycelium:recordLesson', {
                userRequest: userReq,
                mistake: iss.issue,
                fix: iss.suggestion,
              }).catch(() => {});
            }
            isQACorrectionRunRef.current = false;
            lastQAIssuesRef.current = [];
          }
        } else if (isVerification) {
          // Second QA still has issues — stop the loop, don't record unresolved lessons
          isQACorrectionRunRef.current = false;
          lastQAIssuesRef.current = [];
          setMessages((prev) => [
            ...prev.filter((m) => m.text !== 'Running QA check…'),
            { id: Math.random().toString(36).slice(2), role: 'system' as const, text: `QA: ${allIssues.length} issue(s) remain after correction — review manually`, timestamp: Date.now() },
          ]);
        } else {
          // Format issues for EDITH
          const issueLines = allIssues.map((iss: any) =>
            `[${iss.severity.toUpperCase()}] ${iss.label}: ${iss.issue} → ${iss.suggestion}`
          ).join('\n');
          const qaNote = `QA check found ${allIssues.length} issue(s):\n${issueLines}\nSummary: ${qa.summary}`;

          setMessages((prev) => [
            ...prev.filter((m) => m.text !== 'Running QA check…'),
            { id: Math.random().toString(36).slice(2), role: 'system' as const, text: `QA: ${allIssues.length} issue(s) — sending to EDITH`, timestamp: Date.now() },
          ]);

          // Mark this as a correction run so handleDone triggers a verification QA
          isQACorrectionRunRef.current = true;
          lastQAIssuesRef.current = allIssues;

          // Auto-continue EDITH with the QA report so she can self-correct
          setTimeout(() => {
            if (interruptedRef.current) return;
            const s2 = useVideoEditorStore.getState() as any;
            const fps2 = s2.timeline?.fps || 30;
            const mediaCtx = (s2.mediaLibrary ?? []).map((item: any) => ({
              id: item.id, name: item.name, type: item.type ?? 'video',
              duration: item.duration, path: item.tempFilePath || item.source || '',
              isReference: item.category === 'reference',
              transcription: item.cachedKaraokeSubtitles?.transcriptionResult?.segments
                ?.map((seg: any) => {
                  const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;
                  return `[${fmt(seg.start)}-${fmt(seg.end)}] ${seg.text.trim()}`;
                }).join('\n'),
              referenceAnalysis: item.referenceAnalysis,
            }));
            const timelineCtx = {
              fps: fps2,
              currentFrame: s2.timeline?.currentFrame ?? 0,
              totalFrames: s2.timeline?.totalFrames ?? 0,
              selectedClipIds: s2.selectedTrackIds ?? [],
              clips: (s2.tracks ?? []).map((t: any) => ({
                id: t.id,
                mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
                sourcePath: t.source ?? '',
                type: t.type, layer: t.trackRowIndex ?? 0,
                startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
                durationFrames: t.duration ?? ((t.endFrame ?? 0) - (t.startFrame ?? 0)),
                sourceStartTime: t.sourceStartTime,
                volume: t.volume, muted: t.muted,
                letterboxBlur: t.proxyBlockedMessage === 'letterbox-blur' || undefined,
                captionText: t.type === 'subtitle' ? (t.subtitleText ?? undefined) : undefined,
                textContent: t.type === 'text' ? (t.textContent ?? undefined) : undefined,
                textType: t.type === 'text' ? (t.textType ?? undefined) : undefined,
              })),
            };
            window.electronAPI.invoke('mycelium:sendMessage', {
              text: `continue (QA report — fix these before declaring done:\n${qaNote})`,
              mediaContext: mediaCtx,
              timelineSnapshot: timelineCtx,
              activeDownloads: [],
              sfxLibrary,
            });
            setAgentStatus('running');
          }, 800);
        }
      } catch (e) {
        console.error('[FridayPanel] QA check failed:', e);
        setMessages((prev) => prev.filter((m) => m.text !== 'Running QA check…'));
      } finally {
        qaRunningRef.current = false;
      }
    };

    // After EDITH finishes, collapse all per-phrase subtitle clips on each row into one
    // continuous stream track. The merged track carries subtitleSegments[] so the renderer
    // can highlight the right word at the right frame without losing per-phrase timing.
    const mergeCaptionsIntoStream = () => {
      const s = useVideoEditorStore.getState() as any;
      const allSubs = (s.tracks as any[]).filter((t: any) => t.type === 'subtitle');
      if (allSubs.length === 0) return;

      // Group by trackRowIndex
      const byRow = new Map<number, any[]>();
      for (const sub of allSubs) {
        const row = sub.trackRowIndex ?? 0;
        if (!byRow.has(row)) byRow.set(row, []);
        byRow.get(row)!.push(sub);
      }

      for (const [, rowClips] of byRow) {
        // Expand any previously-merged stream back to its constituent segments so
        // follow-up EDITH turns can re-merge cleanly with newly added clips.
        const expanded: any[] = [];
        const originalIds: string[] = [];
        for (const clip of rowClips) {
          originalIds.push(clip.id);
          if (clip.subtitleSegments && clip.subtitleSegments.length > 0) {
            for (const seg of clip.subtitleSegments) {
              expanded.push({
                subtitleText: seg.text,
                startFrame: seg.startFrame,
                endFrame: seg.endFrame,
                subtitleStyle: { ...(clip.subtitleStyle ?? {}), highlightWordIndex: seg.highlightWordIndex ?? 0 },
                subtitleTransform: clip.subtitleTransform,
                color: clip.color,
              });
            }
          } else {
            expanded.push({
              subtitleText: clip.subtitleText ?? '',
              startFrame: clip.startFrame,
              endFrame: clip.endFrame,
              subtitleStyle: clip.subtitleStyle,
              subtitleTransform: clip.subtitleTransform,
              color: clip.color,
            });
          }
        }

        // Need at least 2 phrases to bother merging
        if (expanded.length < 2) continue;

        expanded.sort((a: any, b: any) => a.startFrame - b.startFrame);

        const segments = expanded.map((c: any) => ({
          text: c.subtitleText,
          startFrame: c.startFrame,
          endFrame: c.endFrame,
          highlightWordIndex: c.subtitleStyle?.highlightWordIndex ?? 0,
        }));

        const mergedStart = segments[0].startFrame;
        const mergedEnd = segments[segments.length - 1].endFrame;
        const canonical = expanded[0]; // style/transform from first phrase

        // Update the first original clip to become the merged stream track
        const anchorId = originalIds[0];
        s.updateTrack?.(anchorId, {
          name: 'Captions',
          subtitleText: segments[0].text,
          startFrame: mergedStart,
          endFrame: mergedEnd,
          duration: mergedEnd - mergedStart,
          subtitleStyle: canonical.subtitleStyle ?? {},
          subtitleTransform: canonical.subtitleTransform ?? { x: 0, y: 0.3 },
          subtitleSegments: segments,
        });

        // Remove all other clips on this row
        for (let i = 1; i < originalIds.length; i++) {
          s.removeTrack?.(originalIds[i]);
        }
      }
    };

    const handleDone = () => {
      seenDownloadThisTurnRef.current = false; // reset download gate for next turn
      if (interruptedRef.current) { interruptedRef.current = false; edithLlmActiveRef.current = false; return; }
      edithLlmActiveRef.current = false;
      setAgentStatus('done');
      setActiveAgent(null);
      submittingRef.current = false;
      // Merge all per-phrase subtitle clips into one continuous stream track per row
      mergeCaptionsIntoStream();
      // Remove the transient "thinking" indicator
      setMessages((prev) => prev.filter((m) => m.text !== 'E.D.I.T.H thinking…'));
      // If EDITH just finished a QA correction turn, run a verification pass
      if (isQACorrectionRunRef.current) {
        substantialOpsThisRunRef.current = 0;
        runPostEditQA(true);
      } else if (substantialOpsThisRunRef.current >= 3) {
        // Trigger initial QA after a substantial edit (3+ meaningful ops)
        substantialOpsThisRunRef.current = 0;
        runPostEditQA();
      }
      if (activePlanIdRef.current) {
        const planId = activePlanIdRef.current;
        setMessages((prev) => {
          const planMsg = prev.find((m) => m.id === planId);
          // Remove empty placeholder if EDITH never emitted a PLAN:
          if (planMsg?.plan && planMsg.plan.steps.length === 0) {
            return prev.filter((m) => m.id !== planId);
          }
          // Mark done: stop generating, advance active step to done
          return prev.map((m) =>
            m.id === planId && m.plan
              ? {
                  ...m,
                  plan: {
                    ...m.plan,
                    generating: false,
                    steps: m.plan.steps.map((s) =>
                      s.status === 'active' ? { ...s, status: 'done' as const } : s,
                    ),
                  },
                }
              : m,
          );
        });
        activePlanIdRef.current = null;
      }
      // Chunk pipeline: flush buffered transcript chunks if any are waiting
      if (transcriptionPipelineActiveRef.current && pendingTranscriptChunksRef.current.length > 0) {
        flushTranscriptChunks();
      } else if (pendingDownloadContinueRef.current) {
        // Downloads finished while EDITH was on a chunk turn — now place them
        pendingDownloadContinueRef.current = false;
        triggerAutoContinue();
      } else if (pendingReferenceNoteRef.current) {
        // Reference analysis landed mid-turn — apply the style now that she's free
        const note = pendingReferenceNoteRef.current;
        pendingReferenceNoteRef.current = null;
        triggerAutoContinue(note);
      }
    };

    const handlePlan = (_: unknown, data: { steps: Array<{ id: string; step: string }> }) => {
      if (interruptedRef.current) return;
      // EDITH is laying out a plan — she's thinking
      if (useEdithEditingStore.getState().isEditing) {
        useEdithEditingStore.getState().setIsThinking(true);
      }
      if (activePlanIdRef.current) {
        // Update the placeholder we already inserted
        const planId = activePlanIdRef.current;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === planId && m.plan
              ? { ...m, plan: { ...m.plan, steps: data.steps.map((s) => ({ ...s, status: 'pending' as const })) } }
              : m,
          ),
        );
      } else {
        const planId = Math.random().toString(36).slice(2);
        activePlanIdRef.current = planId;
        setMessages((prev) => [
          ...prev,
          {
            id: planId,
            role: 'edith' as AgentMessage['role'],
            text: '',
            timestamp: Date.now(),
            plan: {
              steps: data.steps.map((s) => ({ ...s, status: 'pending' as const })),
              generating: true,
              open: false,
            },
          },
        ]);
      }
    };

    window.electronAPI.on('mycelium:message', handleAgentMsg);
    window.electronAPI.on('mycelium:op', handleOp);
    window.electronAPI.on('mycelium:done', handleDone);
    window.electronAPI.on('mycelium:plan', handlePlan);

    return () => {
      offApplied(); offFailed(); offDrained(); offPaused(); offResumed();
      (window as any).myceliumAPI?.removeAllListeners?.();
      window.electronAPI.removeListener('mycelium:message', handleAgentMsg);
      window.electronAPI.removeListener('mycelium:op', handleOp);
      window.electronAPI.removeListener('mycelium:done', handleDone);
        window.electronAPI.removeListener('mycelium:plan', handlePlan);
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { url } = (e as CustomEvent<{ url: string }>).detail;
      setActiveDownloads((prev) => prev.filter((d) => d.url !== url));
    };
    window.addEventListener('edith:downloadComplete', handler);
    return () => window.removeEventListener('edith:downloadComplete', handler);
  }, []);

  // Graphic design pre-check failed — send Haiku's critique back to EDITH for revision
  useEffect(() => {
    const handler = (e: Event) => {
      const { issues, summary } = (e as CustomEvent<{ issues: string[]; summary: string }>).detail;
      const issueList = issues.map((iss) => `- ${iss}`).join('\n');
      const critiqueMsg = `Design QA failed — revising graphic before render…`;
      const continueMsg = `continue (graphic design critique:\nSummary: ${summary}\n\nFix these issues in the HTML before re-emitting renderGraphic:\n${issueList}\n\nUse glassmorphism: backdrop-filter blur, rgba backgrounds, text-shadow, proper visual hierarchy. No plain colored boxes or unstyled text.)`;

      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(36).slice(2), role: 'system' as const, text: critiqueMsg, timestamp: Date.now() },
      ]);

      setTimeout(() => {
        if (interruptedRef.current) return;
        const s = useVideoEditorStore.getState() as any;
        const fps = s.timeline?.fps || 30;
        const mediaCtx = (s.mediaLibrary ?? []).map((item: any) => ({
          id: item.id, name: item.name, type: item.type ?? 'video',
          duration: item.duration, path: item.tempFilePath || item.source || '',
          isReference: item.category === 'reference',
          transcription: item.cachedKaraokeSubtitles?.transcriptionResult?.segments
            ?.map((seg: any) => {
              const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;
              return `[${fmt(seg.start)}-${fmt(seg.end)}] ${seg.text.trim()}`;
            }).join('\n'),
          referenceAnalysis: item.referenceAnalysis,
        }));
        const timelineCtx = {
          fps,
          currentFrame: s.timeline?.currentFrame ?? 0,
          totalFrames: s.timeline?.totalFrames ?? 0,
          selectedClipIds: s.selectedTrackIds ?? [],
          clips: (s.tracks ?? []).map((t: any) => ({
            id: t.id,
            mediaName: (t.source ?? '').replace(/\\/g, '/').split('/').pop() ?? t.name,
            sourcePath: t.source ?? '',
            type: t.type, layer: t.trackRowIndex ?? 0,
            startFrame: t.startFrame ?? 0, endFrame: t.endFrame ?? 0,
            durationFrames: t.duration ?? ((t.endFrame ?? 0) - (t.startFrame ?? 0)),
            sourceStartTime: t.sourceStartTime,
            volume: t.volume, muted: t.muted,
          })),
        };
        window.electronAPI.invoke('mycelium:sendMessage', {
          text: continueMsg,
          mediaContext: mediaCtx,
          timelineSnapshot: timelineCtx,
          activeDownloads: [],
          sfxLibrary,
        });
        setAgentStatus('running');
      }, 600);
    };
    window.addEventListener('edith:graphicRevision', handler);
    return () => window.removeEventListener('edith:graphicRevision', handler);
  }, [sfxLibrary]);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const buildMediaContext = useCallback((): MediaContextItem[] => {
    return mediaLibrary.map((item) => {
      // Format Whisper transcription as "[00:00-00:05] text" lines
      let transcription: string | undefined;
      const segs = item.cachedKaraokeSubtitles?.transcriptionResult?.segments;
      if (segs?.length) {
        const fmt = (s: number) => {
          const m = Math.floor(s / 60).toString().padStart(2, '0');
          const sec = Math.floor(s % 60).toString().padStart(2, '0');
          return `${m}:${sec}`;
        };
        transcription = segs.map((seg: any) => `[${fmt(seg.start)}-${fmt(seg.end)}] ${seg.text.trim()}`).join('\n');
      }

      let referenceAnalysis: MediaContextItem['referenceAnalysis'] | undefined;
      if (item.referenceAnalysis) {
        const ra = item.referenceAnalysis as any;
        referenceAnalysis = {
          captionStyle: ra.captionStyle as Record<string, unknown>,
          description: ra.description ?? '',
          editing: ra.editing,
          structure: ra.structure,
          colorGrade: ra.colorGrade,
          profile: ra.profile, // full StyleProfile — rendered as the digest in EDITH's context
        };
      }

      return {
        id: item.id,
        name: item.name,
        type: item.type,
        duration: item.duration,
        path: item.tempFilePath || item.source,
        isReference: item.category === 'reference',
        transcription,
        referenceAnalysis,
        speakerSegments: (item as any).speakerSegments,
      };
    });
  }, [mediaLibrary]);

  const buildTimelineSnapshot = useCallback((): TimelineSnapshot => {
    // Read the timeline at CALL time rather than subscribing to it. The
    // snapshot is built when a message is sent, so live state is the correct
    // source anyway, and subscribing dragged this panel into every playhead
    // tick. Matches how `preview` was already read on the next line.
    const st = useVideoEditorStore.getState() as any;
    const timeline = st.timeline;
    const fps = timeline?.fps || 30;
    const { canvasWidth, canvasHeight } = st.preview as any;
    return {
      fps,
      currentFrame: timeline?.currentFrame ?? 0,
      totalFrames: timeline?.totalFrames ?? 3000,
      selectedClipIds: timeline?.selectedTrackIds ?? [],
      canvasWidth: canvasWidth ?? 1080,
      canvasHeight: canvasHeight ?? 1920,
      clips: (tracks ?? []).map((t: any) => ({
        id: t.id,
        mediaName: t.source ? t.source.replace(/\\/g, '/').split('/').pop() ?? t.source : (t.name ?? t.id),
        sourcePath: t.source ?? '',
        type: t.type ?? 'video',
        layer: t.trackRowIndex ?? 0,
        startFrame: t.startFrame ?? 0,
        endFrame: t.endFrame ?? 0,
        durationFrames: t.duration ?? ((t.endFrame ?? 0) - (t.startFrame ?? 0)),
        sourceStartTime: t.sourceStartTime ?? 0,
        volume: t.volume,
        muted: t.muted,
        letterboxBlur: t.proxyBlockedMessage === 'letterbox-blur' || undefined,
        backgroundRemoved: t.backgroundRemoved || undefined,
        captionText: t.type === 'subtitle' ? (t.subtitleText ?? t.textContent ?? undefined) : undefined,
      })),
    };
  }, [tracks]);

  const addAttachment = (file: File) => {
    const isImage = file.type.startsWith('image/');
    const realPath: string | undefined = (file as any).path || undefined;
    const entry = { name: file.name, path: realPath ?? '', preview: undefined as string | undefined };
    setAttachments((prev) => [...prev, entry]);
    if (isImage) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;
        if (!realPath && dataUrl) {
          const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
          try {
            const result = await window.electronAPI.invoke('save-temp-image', dataUrl, ext);
            if (result?.filePath) {
              setAttachments((prev) => prev.map((a) => a.name === file.name ? { ...a, path: result.filePath, preview: dataUrl } : a));
            }
          } catch {}
        } else {
          setAttachments((prev) => prev.map((a) => a.name === file.name ? { ...a, preview: dataUrl } : a));
        }
      };
      reader.readAsDataURL(file);
    } else if (!realPath) {
      // Documents (PDF, scripts, XML, SRT…) pasted without a filesystem path:
      // persist the bytes to temp so EDITH's Read tool can open them from the
      // [Attached: …] token. Files dragged from Explorer keep their real path.
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;
        if (!dataUrl) return;
        try {
          const result = await window.electronAPI.invoke('save-temp-attachment', dataUrl, file.name);
          if (result?.filePath) {
            setAttachments((prev) => prev.map((a) => a.name === file.name && !a.path ? { ...a, path: result.filePath } : a));
          }
        } catch {}
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) addAttachment(file);
      return;
    }
    // Pasted FILES (PDF, script, XML, SRT… copied in Explorer): attach instead
    // of dumping a filename string into the input.
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      files.forEach(addAttachment);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(addAttachment);
    e.target.value = '';
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0 && clipRefs.length === 0) || submittingRef.current) return;
    interruptedRef.current = false;
    submittingRef.current = true;
    edithLlmActiveRef.current = true; // block chunk pipeline until this turn completes
    pendingTranscriptChunksRef.current = []; // clear any stale chunks from prior sessions
    transcriptionPipelineActiveRef.current = false; // reset pipeline — will re-arm when runWhisper is enqueued
    substantialOpsThisRunRef.current = 0; // reset per-run counter
    isQACorrectionRunRef.current = false; // new user turn resets correction cycle
    lastUserRequestRef.current = text;
    const attachedPaths = attachments.map((a) => a.path).filter(Boolean);
    const imagePreviews = attachments.filter((a) => a.preview).map((a) => a.preview!);
    const denyCtx = denyContextRef.current;
    denyContextRef.current = null;
    // Dropped timeline clips serialize into the token EDITH targets, appended
    // to the message text (the input box only ever shows the clean card).
    const clipTokens = clipRefs
      .map((r) => `[clip "${r.name}" id:${r.trackId} at ${r.startSec}s-${r.endSec}s on the timeline]`)
      .join(' ');
    const textWithClips = clipTokens ? `${text ? `${text} ` : ''}${clipTokens}` : text;
    const fullText = attachedPaths.length > 0
      ? `${textWithClips}\n\n[Attached: ${attachedPaths.join(', ')}]`
      : denyCtx
        ? `${denyCtx}\n\nUser says: ${textWithClips}`
        : textWithClips;
    setInput('');
    try { localStorage.removeItem(getDraftKey()); } catch {}
    setAttachments([]);
    setClipRefs([]);
    isNearBottomRef.current = true; // always scroll when user sends
    activePlanIdRef.current = null;
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        role: 'user',
        text: text
          || (clipRefs.length > 0
            ? '' // the clip card IS the message, Gemini-style
            : `[${attachments.length} attachment${attachments.length > 1 ? 's' : ''}]`),
        timestamp: Date.now(),
        ...(imagePreviews.length > 0 && { imagePreviews }),
        ...(clipRefs.length > 0 && { clipAttachments: clipRefs }),
      },
    ]);
    // Fast-path: a plain "find the moment" request skips the LLM and runs the finder
    // directly (instant CTRL-F). Only when there are no attachments / clips / deny-context.
    const fastFind = (!attachedPaths.length && !denyCtx && !clipTokens) ? resolveFindIntent(text) : null;
    if (fastFind) {
      const label = fastFind.target === 'motion'
        ? 'the action'
        : (fastFind.target ?? `“${fastFind.query}”`);
      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(36).slice(2), role: 'edith', text: `Jumping to ${label}.`, timestamp: Date.now() },
      ]);
      operationEngine.enqueue(fastFind as any);
      setQueue(operationEngine.getQueue());
      submittingRef.current = false;
      edithLlmActiveRef.current = false;
      setAgentStatus('done');
      return;
    }

    setAgentStatus('running');
    await window.electronAPI.invoke('mycelium:sendMessage', {
      text: fullText,
      mediaContext: buildMediaContext(),
      timelineSnapshot: buildTimelineSnapshot(),
      activeDownloads,
      sfxLibrary,
    });
  }, [input, attachments, clipRefs, activeDownloads, sfxLibrary, buildMediaContext, buildTimelineSnapshot]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handlePlanToggle = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.plan
          ? { ...m, plan: { ...m.plan, open: !m.plan.open } }
          : m,
      ),
    );
  }, []);

  const handleReasoningToggle = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.reasoning
          ? { ...m, reasoning: { ...m.reasoning, open: !m.reasoning.open } }
          : m,
      ),
    );
  }, []);

  const handleSkipStep = useCallback((msgId: string, stepId: string, override?: string) => {
    operationEngine.cancelByStepId(stepId);
    // If user typed an override, keep the step visible (PlanCard handles its own display state)
    // If no override (pure skip), remove from plan entirely
    if (!override) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.plan
            ? { ...m, plan: { ...m.plan, steps: m.plan.steps.filter((s) => s.id !== stepId) } }
            : m,
        ),
      );
    }
  }, []);

  const handleClearHistory = useCallback(async () => {
    // Kill any in-progress transcription first
    interruptedRef.current = true;
    pendingSlowOpsRef.current.clear();
    operationEngine.clearQueue();
    window.electronAPI.invoke('mycelium:stop');
    window.electronAPI.invoke('whisper:cancel');
    useEdithEditingStore.getState().stopEditing();
    submittingRef.current = false;
    setAgentStatus('idle');
    await window.electronAPI.invoke('mycelium:clearHistory');
    interruptedRef.current = false;
    setMessages([{
      id: Math.random().toString(36).slice(2),
      role: 'system',
      text: 'Conversation cleared.',
      timestamp: Date.now(),
    }]);
  }, []);

  // Auto-grow the input from its CONTENT, not from keystrokes — sizing on
  // onChange alone left the box tall after send cleared it programmatically
  // (no keystroke, no resize until the next typed letter). This also sizes the
  // box correctly when a saved draft is restored on project switch.
  useEffect(() => {
    const ta = inputTaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 128) + 'px';
  }, [input]);

  // Keep ref in sync so the Escape listener doesn't close over stale state
  useEffect(() => { agentStatusRef.current = agentStatus; }, [agentStatus]);
  useEffect(() => { isPanelVisibleRef.current = panelTypeForVisibility === 'friday'; }, [panelTypeForVisibility]);

  // Ctrl+C copies selected text from chat messages (non-input elements)
  useEffect(() => {
    const onCopy = (e: KeyboardEvent) => {
      if (!isPanelVisibleRef.current) return; // EDITH not visible -> let other panels copy
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
      const activeEl = document.activeElement;
      // Let the browser handle copy natively if focus is inside an input/textarea
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) return;
      const sel = window.getSelection()?.toString();
      if (sel) {
        e.preventDefault();
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    };
    document.addEventListener('keydown', onCopy);
    return () => document.removeEventListener('keydown', onCopy);
  }, []);

  // While the media preview overlay is open, Escape closes IT — registered in the
  // capture phase so the interrupt-EDITH listener below never sees the keystroke.
  useEffect(() => {
    if (!mediaPreview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setMediaPreview(null);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [mediaPreview]);

  // Escape cancels EDITH mid-response
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!isPanelVisibleRef.current) return; // only cancel EDITH from the EDITH panel
      if (agentStatusRef.current !== 'running' && agentStatusRef.current !== 'paused') return;
      interruptedRef.current = true;
      pendingSlowOpsRef.current.clear();
      operationEngine.clearQueue();
      window.electronAPI.invoke('mycelium:stop');
      window.electronAPI.invoke('whisper:cancel');
      submittingRef.current = false;
      setAgentStatus('idle');
      setActiveAgent(null);
      useEdithEditingStore.getState().stopEditing();
      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(36).slice(2), role: 'system', text: 'Interrupted', timestamp: Date.now() },
      ]);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const pendingOps = queue.filter((q) => q.status === 'pending' || q.status === 'running').length;
  const failedOps = queue.filter((q) => q.status === 'failed').length;
  const isActive = agentStatus === 'running' || agentStatus === 'paused';

  // Merge consecutive plain EDITH text messages into ONE bubble. The runtime emits
  // one message per output line, which rendered as a stack of separate bubbles for
  // what reads as a single reply. Display-only — the messages array is untouched.
  const groupedMessages = React.useMemo(() => {
    const out: Array<AgentMessage & { mergedTexts?: string[] }> = [];
    for (const m of messages) {
      const plainEdithText = m.role !== 'system' && m.role !== 'user' && !m.reasoning && !m.plan && !m.mediaCard;
      const prev = out[out.length - 1];
      if (plainEdithText && prev?.mergedTexts) {
        prev.mergedTexts.push(m.text);
        continue;
      }
      out.push(plainEdithText ? { ...m, mergedTexts: [m.text] } : m);
    }
    return out;
  }, [messages]);

  if (!consentGiven) {
    return (
      <div className={`flex flex-col h-full${className ? ` ${className}` : ''}`}>
        <ConsentScreen
          onAgree={() => {
            // Consent must activate the instant Agree is clicked. Persist + flip state
            // FIRST, then prepare the downloads dir as a guarded, non-blocking side task.
            // Previously this awaited initDownloadDir before setConsentGiven, so if that
            // call was missing (stale preload), slow, or threw, consent never took and the
            // button looked dead. Optional chaining + fire-and-forget makes it bulletproof.
            localStorage.setItem(getConsentKey(), 'true');
            setConsentGiven(true);
            Promise.resolve(window.electronAPI?.initDownloadDir?.())
              .then((dlResult) => {
                if (dlResult?.path)
                  localStorage.setItem('edith-download-dir', dlResult.path);
              })
              .catch(() => {});
          }}
          onCancel={hidePanel}
        />
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-full text-white${className ? ` ${className}` : ''}`}
      style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#141414' }}
    >
      {/* Header — Bubble grammar: round accent mark + name + status dot */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] select-none">
        <div className="flex items-center gap-2.5">
          <div
            className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(34,197,94,0.14)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#4ade80">
              <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z" />
            </svg>
          </div>
          <span className="text-[12.5px] font-semibold text-zinc-100">EDITH</span>
          {activeAgent && activeAgent !== 'friday' && (
            <span className="text-xs text-zinc-600 tracking-widest uppercase">
              → {activeAgent}
            </span>
          )}
        </div>
        <div className="flex gap-1.5">
          {isActive && (
            <>
              <button
                onClick={() => {
                  if (agentStatus === 'paused') {
                    operationEngine.resume();
                    window.electronAPI.invoke('mycelium:resume');
                  } else {
                    operationEngine.pause();
                    window.electronAPI.invoke('mycelium:pause');
                  }
                }}
                className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-white border border-white/10 hover:border-white/20 transition-colors"
              >
                {agentStatus === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={() => {
                  pendingSlowOpsRef.current.clear();
                  interruptedRef.current = true;
                  operationEngine.clearQueue();
                  window.electronAPI.invoke('mycelium:stop');
                  window.electronAPI.invoke('whisper:cancel');
                  setAgentStatus('idle');
                  useEdithEditingStore.getState().stopEditing();
                  submittingRef.current = false;
                }}
                className="text-[11px] px-2 py-1 rounded text-zinc-600 hover:text-red-400 border border-white/10 hover:border-red-900/50 transition-colors"
              >
                Stop
              </button>
            </>
          )}
          {!isActive && messages.length > 1 && (
            <button
              onClick={handleClearHistory}
              className="text-[11px] px-2 py-1 rounded text-zinc-700 hover:text-zinc-400 border border-white/[0.06] hover:border-white/10 transition-colors"
              title="Clear conversation"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto py-3 min-h-0 space-y-2 select-text"
      >
        {groupedMessages.map((msg) => {
          if (msg.role === 'system') {
            const isInterrupted = msg.text === 'Interrupted';
            const isThinking = msg.text === 'E.D.I.T.H thinking…';
            const isSnapshot = msg.text.startsWith('__snapshot__');
            const isScreenshot = msg.text.startsWith('__screenshot__');
            const isInProgress = !isInterrupted && !isThinking && !isSnapshot && !isScreenshot && msg.text.endsWith('…');
            const baseText = isInProgress ? msg.text.slice(0, -1) : msg.text;
            if (isThinking) {
              return (
                <div key={msg.id} className="px-4 py-1">
                  <ThinkingIndicator />
                </div>
              );
            }
            const isBrollCheck = msg.text.startsWith('__brollcheck__');
            if (isSnapshot || isBrollCheck || isScreenshot) {
              const rawLabel = isSnapshot
                ? msg.text.slice('__snapshot__'.length)
                : isBrollCheck
                ? msg.text.slice('__brollcheck__'.length)
                : msg.text.slice('__screenshot__'.length);
              const passed = isBrollCheck ? rawLabel.startsWith('✓') : null;
              const frame = msg.imagePreviews?.[0];
              const accentColor = isBrollCheck
                ? (passed ? 'text-emerald-400' : 'text-red-400')
                : isScreenshot ? 'text-zinc-400'
                : 'text-emerald-400';
              const borderColor = isBrollCheck
                ? (passed ? 'border-emerald-500/30' : 'border-red-500/30')
                : 'border-white/[0.08]';
              return (
                <div key={msg.id} className={`mx-4 my-1.5 rounded-xl border overflow-hidden ${borderColor}`} style={{ background: 'rgba(255,255,255,0.03)' }}>
                  {frame && (
                    <div className="relative">
                      <img
                        src={frame}
                        className="w-full block"
                        style={{ maxHeight: '110px', objectFit: 'cover', opacity: 0.88 }}
                      />
                      {isBrollCheck && (
                        <span className={`absolute top-1.5 right-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${passed ? 'bg-emerald-500/90 text-white' : 'bg-red-500/90 text-white'}`}>
                          {passed ? '✓ pass' : '✗ reject'}
                        </span>
                      )}
                      {isSnapshot && (
                        <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-black/70 text-emerald-300 font-mono">
                          snapshot
                        </span>
                      )}
                      {isScreenshot && (
                        <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-black/70 text-zinc-200 font-mono">
                          EDITH sees this
                        </span>
                      )}
                    </div>
                  )}
                  <div className="px-2.5 py-1.5">
                    <span className={`text-[10px] font-mono ${accentColor} opacity-80`}>
                      {rawLabel}
                    </span>
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} className="px-4 py-1 flex items-center gap-1">
                <span className={`text-[12px] italic ${isInterrupted ? 'text-amber-600/70' : 'text-zinc-400'}`}>
                  {baseText}
                </span>
                {isInProgress && (
                  <span className="flex items-center gap-[3px] mb-[1px]">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-[3px] h-[3px] rounded-full bg-zinc-500 inline-block animate-pulse"
                        style={{ animationDelay: `${i * 0.2}s` }}
                      />
                    ))}
                  </span>
                )}
              </div>
            );
          }
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="px-4 py-1.5 flex justify-end">
                <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
                  {msg.clipAttachments && msg.clipAttachments.length > 0 && (
                    // Side-by-side like Gemini — multiple attached clips sit in a
                    // row and wrap, never stack one per line.
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {msg.clipAttachments.map((c) => {
                        // Live echo carries the thumbnail; hydrated history re-resolves
                        // it from the media library (survives source swaps from bakes).
                        const tr = tracks.find((t) => t.id === c.trackId);
                        const thumb = c.thumbnail
                          ?? (tr ? mediaLibrary?.find((m) => m.id === (tr as any).mediaId)?.thumbnail : undefined);
                        const clipSrc = (tr as any)?.previewUrl ?? (tr as any)?.source;
                        return (
                          <button
                            type="button"
                            key={c.trackId}
                            onClick={() => clipSrc && setMediaPreview({
                              src: clipSrc, name: c.name, mediaType: 'video',
                              seekTo: (tr as any)?.sourceStartTime ?? 0,
                            })}
                            disabled={!clipSrc}
                            className={`text-left rounded-xl border border-white/10 overflow-hidden transition-colors ${clipSrc ? 'hover:border-white/25 cursor-pointer' : 'cursor-default'}`}
                            style={{ background: '#1e1e1e', width: 104 }}
                            title={clipSrc ? 'Click to preview' : undefined}
                          >
                            <div className="relative w-full" style={{ height: 58, background: '#111' }}>
                              {thumb ? (
                                <img src={thumb} className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.6">
                                    <rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3V9z" fill="#52525b" stroke="none"/>
                                  </svg>
                                </div>
                              )}
                              <div
                                className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full px-2 py-0.5"
                                style={{ background: 'rgba(0,0,0,0.75)' }}
                              >
                                <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4V1z" fill="#fff"/></svg>
                                <span className="text-[10px] font-semibold text-white tabular-nums">
                                  {(c.endSec - c.startSec).toFixed(1)}s
                                </span>
                              </div>
                            </div>
                            <div className="px-2 py-1.5">
                              <p className="text-[10px] text-zinc-300 font-medium truncate">{c.name}</p>
                              <p className="text-[10px] text-zinc-500 tabular-nums">{c.startSec}s – {c.endSec}s on timeline</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {msg.imagePreviews?.map((src, i) => (
                    <img key={i} src={src} className="rounded-lg max-w-full max-h-40 object-contain border border-white/10" />
                  ))}
                  {msg.text && (
                    <span
                      className="text-xs leading-relaxed break-words select-text cursor-text px-3.5 py-2"
                      style={{ background: '#173f27', color: '#c9f2d9', borderRadius: '16px 16px 4px 16px' }}
                    >
                      {msg.text}
                    </span>
                  )}
                </div>
              </div>
            );
          }
          if (msg.reasoning) {
            return <ReasoningCard key={msg.id} message={msg} onToggle={handleReasoningToggle} />;
          }
          if (msg.plan) {
            return <PlanCard key={msg.id} message={msg} onToggle={handlePlanToggle} onSkipStep={handleSkipStep} />;
          }
          if (msg.mediaCard) {
            const card = msg.mediaCard;
            const media = mediaLibrary?.find((m) => m.id === card.mediaId);
            const thumb = (media as any)?.thumbnail as string | undefined;
            const src = (media as any)?.previewUrl ?? (media as any)?.source;
            const duration = (media as any)?.duration as number | undefined;
            return (
              <div key={msg.id} className="px-4 py-1.5 flex justify-start">
                <button
                  type="button"
                  onClick={() => media && src && setMediaPreview({ src, name: card.name, mediaType: card.mediaType })}
                  disabled={!media}
                  className={`text-left rounded-xl border border-white/10 overflow-hidden transition-colors ${media ? 'hover:border-white/25 cursor-pointer' : 'opacity-60 cursor-default'}`}
                  style={{ background: '#1e1e1e', width: 168 }}
                  title={media ? 'Click to preview' : 'Removed from the media library'}
                >
                  <div className="relative w-full" style={{ height: 94, background: '#111' }}>
                    {media && card.mediaType === 'video' && (
                      thumb
                        ? <img src={thumb} className="w-full h-full object-cover" />
                        : <video src={src} preload="metadata" muted playsInline className="w-full h-full object-cover pointer-events-none" />
                    )}
                    {media && card.mediaType === 'image' && (
                      <img src={thumb ?? src} className="w-full h-full object-cover" />
                    )}
                    {(!media || card.mediaType === 'audio') && (
                      <div className="w-full h-full flex items-center justify-center">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.6">
                          {card.mediaType === 'audio'
                            ? <><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>
                            : <><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3V9z" fill="#52525b" stroke="none"/></>}
                        </svg>
                      </div>
                    )}
                    {media && card.mediaType !== 'image' && (
                      <div
                        className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full px-2 py-0.5"
                        style={{ background: 'rgba(0,0,0,0.75)' }}
                      >
                        <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4V1z" fill="#fff"/></svg>
                        <span className="text-[10px] font-semibold text-white tabular-nums">{fmtMediaDuration(duration)}</span>
                      </div>
                    )}
                    {media && card.mediaType === 'video' && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.55)' }}>
                          <svg width="12" height="12" viewBox="0 0 10 10"><path d="M2.5 1l6 4-6 4V1z" fill="#fff"/></svg>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="px-2 py-1.5">
                    <p className="text-[10px] text-zinc-300 font-medium truncate">{card.name}</p>
                    <p className="text-[10px] text-zinc-500">{media ? 'Fetched by EDITH — in your media library' : 'Removed from the media library'}</p>
                  </div>
                </button>
              </div>
            );
          }
          return (
            <div key={msg.id} className="px-4 py-1.5 flex justify-start">
              <div
                className="max-w-[92%] px-3.5 py-2.5 space-y-2"
                style={{ background: '#1c1c1c', borderRadius: '16px 16px 16px 4px' }}
              >
                {(msg.mergedTexts ?? [msg.text]).map((t, i) => (
                  <span key={i} className="block text-xs text-zinc-300 leading-relaxed break-words select-text cursor-text">{renderBold(t)}</span>
                ))}
              </div>
            </div>
          );
        })}
        {/* Live op ticker — shows while EDITH is working */}
        {isEditing && currentOpLabel && (
          <div className="px-4 py-1.5 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
            <span className="text-[11px] text-emerald-300/80 italic truncate">{currentOpLabel}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Download approval — one at a time, sequential with 1s gap between cards */}
      {(() => {
        const item = !approvalTransitioning ? approvalPending[0] : undefined;
        if (!item) return null;
        const remaining = approvalPending.length - 1;
        const handleAllow = () => {
          setApprovalTransitioning(true);
          approvalApprove(item.id, true);
          setTimeout(() => setApprovalTransitioning(false), 1000);
        };
        const handleAlwaysAllow = () => {
          setApprovalTransitioning(true);
          approvalApproveAll(item.id);
          setTimeout(() => setApprovalTransitioning(false), 400);
        };
        const handleDeny = () => {
          approvalDeny(item.id);
        };
        return (
          <div className="border-t border-white/[0.06]">
            <div className="px-3 py-2">
              <div className="rounded-xl border border-white/[0.08] overflow-hidden" style={{ background: '#1a1a1a' }}>
                <div className="px-3 pt-2.5 pb-2">
                  <div className="flex items-center justify-between mb-0.5">
                    <p className="text-[11px] font-semibold text-zinc-100">Allow EDITH to use this download?</p>
                    {remaining > 0 && (
                      <span className="text-[10px] text-zinc-600">{remaining} more waiting</span>
                    )}
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">{item.title ?? item.filePath.split(/[/\\]/).pop()}</p>
                </div>
                <div className="flex border-t border-white/[0.06]" style={{ background: '#141414' }}>
                  <button onClick={handleDeny} className="flex-1 py-2 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors border-r border-white/[0.06]">Deny</button>
                  <button onClick={handleAllow} className="flex-1 py-2 text-[11px] font-medium hover:bg-white/[0.04] transition-colors border-r border-white/[0.06]" style={{ color: '#4ade80' }}>Allow</button>
                  <button onClick={handleAlwaysAllow} className="flex-1 py-2 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors border-r border-white/[0.06]">Always allow</button>
                  <button onClick={() => window.electronAPI.showItemInFolder(item.filePath)} className="flex-1 py-2 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors">View</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Op Queue */}
      {(pendingOps > 0 || failedOps > 0) && (
        <div className="border-t border-white/[0.06]">
          <button
            className="w-full flex items-center justify-between px-4 py-2 text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
            onClick={() => setShowQueue(!showQueue)}
          >
            <span className="font-mono">
              {pendingOps > 0
                ? `applying ${pendingOps} edit${pendingOps > 1 ? 's' : ''}…`
                : `${failedOps} edit${failedOps > 1 ? 's' : ''} failed`}
            </span>
            <span className="text-zinc-700">{showQueue ? '▲' : '▼'}</span>
          </button>
          {showQueue && (
            <div className="px-4 pb-2 max-h-28 overflow-y-auto space-y-0.5">
              {queue.filter((q) => q.status === 'pending' || q.status === 'running' || q.status === 'failed').map((q) => {
                const color = ({ pending: '#52525b', running: '#4ade80', failed: '#f87171' } as Record<string, string>)[q.status] ?? '#3f3f46';
                return (
                  <div key={q.id} className="flex items-center gap-2 font-mono text-[10px]" style={{ color }}>
                    <span className="w-1 h-1 rounded-full bg-current flex-shrink-0" />
                    <span className="truncate">{
                      q.op.type === 'zoomToFace'
                        ? `zoomTo${((q.op as any).target ?? 'face').replace(/^\w/, (c: string) => c.toUpperCase())}`
                        : q.op.type
                    }</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="px-3 pb-3 pt-2 border-t border-white/[0.06] select-none">
        {clipRefs.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {clipRefs.map((r) => {
              const chipTrack = tracks.find((t) => t.id === r.trackId);
              const chipSrc = (chipTrack as any)?.previewUrl ?? (chipTrack as any)?.source;
              return (
              <div
                key={r.trackId}
                onClick={() => chipSrc && setMediaPreview({
                  src: chipSrc, name: r.name, mediaType: 'video',
                  seekTo: (chipTrack as any)?.sourceStartTime ?? 0,
                })}
                className={`group relative rounded-xl border border-white/10 overflow-hidden transition-colors ${chipSrc ? 'hover:border-white/25 cursor-pointer' : ''}`}
                style={{ background: '#1e1e1e', width: 118 }}
                title={chipSrc ? 'Click to preview' : undefined}
              >
                <div className="relative w-full" style={{ height: 66, background: '#111' }}>
                  {r.thumbnail ? (
                    <img src={r.thumbnail} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.6">
                        <rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3V9z" fill="#52525b" stroke="none"/>
                      </svg>
                    </div>
                  )}
                  {/* duration pill — Gemini-style play badge */}
                  <div
                    className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full px-2 py-0.5"
                    style={{ background: 'rgba(0,0,0,0.75)' }}
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4V1z" fill="#fff"/></svg>
                    <span className="text-[10px] font-semibold text-white tabular-nums">
                      {(r.endSec - r.startSec).toFixed(1)}s
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setClipRefs((prev) => prev.filter((x) => x.trackId !== r.trackId));
                    }}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-white/80 hover:text-white"
                    style={{ background: 'rgba(0,0,0,0.7)' }}
                    aria-label="Remove clip"
                  >×</button>
                </div>
                <div className="px-2 py-1.5">
                  <p className="text-[10px] text-zinc-300 font-medium truncate">{r.name}</p>
                  <p className="text-[10px] text-zinc-500 tabular-nums">{r.startSec}s – {r.endSec}s on timeline</p>
                </div>
              </div>
              );
            })}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a, i) => (
              <div key={i} className="group flex items-center gap-1.5 rounded-md border border-white/10 overflow-hidden" style={{ background: '#1e1e1e' }}>
                {a.preview
                  ? <img src={a.preview} className="w-8 h-8 object-cover flex-shrink-0" />
                  : <div className="w-8 h-8 flex items-center justify-center flex-shrink-0 bg-white/[0.04]">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9H3V2z" stroke="#71717a" strokeWidth="1.2" strokeLinejoin="round"/></svg>
                    </div>
                }
                <span className="text-[10px] text-zinc-500 pr-1.5 max-w-[80px] truncate">{a.name}</span>
                <button
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-500 hover:text-white pr-1.5 text-xs leading-none"
                >×</button>
              </div>
            ))}
          </div>
        )}

        <input ref={fileInputRef} type="file" multiple accept="image/*,video/*,audio/*,.pdf,.txt,.md,.xml,.srt,.vtt,.fountain,.json,.csv,.docx,.doc" className="hidden" onChange={handleFileInput} />

        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2 border transition-colors"
          style={{
            background: '#1c1c1c',
            borderColor: clipDragActive || selectionMode !== 'off' ? '#22c55e' : 'rgba(255,255,255,0.08)',
            boxShadow: clipDragActive || selectionMode !== 'off' ? '0 0 0 1px #22c55e66' : 'none',
          }}
          onMouseUp={handleClipDropIntoChat}
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 w-6 h-6 self-end mb-1 rounded flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          <textarea
            ref={inputTaRef}
            data-testid="edith-input"
            className="flex-1 bg-transparent text-xs text-zinc-200 placeholder-zinc-600 resize-none outline-none leading-relaxed max-h-32 overflow-y-auto py-1.5"
            rows={1}
            placeholder="Say something to EDITH…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              try { localStorage.setItem(getDraftKey(), e.target.value); } catch {}
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <button
            data-testid="edith-selection-tool"
            onClick={(e) => {
              // e.detail >= 2 = second click of a double-click. Detected here rather than
              // onDoubleClick because Chromium doesn't always synthesize dblclick (and the
              // first click already flipped the mode, so this must override it anyway).
              if (e.detail >= 2) setSelectionMode('persistent');
              else setSelectionMode((m) => (m === 'off' ? 'single' : 'off'));
            }}
            title={selectionMode === 'persistent'
              ? 'Selection stays on — click again or press Esc to turn off'
              : selectionMode === 'single'
                ? 'Click a clip on the timeline to attach it · Esc to cancel'
                : 'Attach a timeline clip — click, then pick a clip. Double-click to keep it on.'}
            className={`flex-shrink-0 w-6 h-6 self-end mb-1 rounded-md flex items-center justify-center transition-colors ${
              selectionMode === 'off' ? 'text-zinc-500 hover:text-zinc-300' : 'text-emerald-400'
            }`}
            style={selectionMode !== 'off'
              ? {
                  background: 'rgba(34,197,94,0.12)',
                  boxShadow: selectionMode === 'persistent' ? '0 0 0 1px rgba(34,197,94,0.55)' : 'none',
                }
              : undefined}
            aria-label="Selection tool"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="6.5" />
              <path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5" />
              {selectionMode !== 'off' && <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />}
            </svg>
          </button>
          <button
            onClick={sendMessage}
            disabled={(!input.trim() && attachments.length === 0 && clipRefs.length === 0) || submittingRef.current}
            className="flex-shrink-0 w-8 h-8 self-end rounded-full flex items-center justify-center transition-all hover:brightness-110 disabled:opacity-20 disabled:cursor-not-allowed"
            style={{ background: '#22c55e' }}
          >
            {/* Gemini-style up arrow — minimal, no fill */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
        <p className={`text-[10px] mt-1.5 text-center ${selectionMode !== 'off' ? 'text-emerald-500/80' : 'text-zinc-600'}`}>
          {selectionMode === 'persistent'
            ? 'selection mode stays on — click clips on the timeline · esc to exit'
            : selectionMode === 'single'
              ? 'selection mode — click a clip on the timeline · esc to cancel'
              : '↵ send · ⇧↵ newline · paste image or file to attach'}
        </p>
      </div>

      {/* Media preview — full-size player over the app (Gemini-style). Opens from
          EDITH's fetched-media cards AND the user's attached-clip cards. */}
      {mediaPreview && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            // z 20000 — must beat the preview canvas hit-test layer (9000) and
            // transform boundary (10000), or clicks over the canvas area die.
            style={{ background: 'rgba(0,0,0,0.85)', zIndex: 20000 }}
            onClick={() => setMediaPreview(null)}
          >
            <div className="flex flex-col items-center gap-3 max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
              {mediaPreview.mediaType === 'video' && (
                <video
                  src={mediaPreview.src}
                  controls
                  autoPlay
                  playsInline
                  onLoadedMetadata={(e) => {
                    if (mediaPreview.seekTo) e.currentTarget.currentTime = mediaPreview.seekTo;
                  }}
                  className="rounded-2xl"
                  style={{ maxWidth: '90vw', maxHeight: '78vh', background: '#000' }}
                />
              )}
              {mediaPreview.mediaType === 'image' && (
                <img src={mediaPreview.src} className="rounded-2xl object-contain" style={{ maxWidth: '90vw', maxHeight: '78vh' }} />
              )}
              {mediaPreview.mediaType === 'audio' && (
                <audio src={mediaPreview.src} controls autoPlay className="w-[420px] max-w-[90vw]" />
              )}
              <p className="text-xs text-zinc-300 max-w-[80vw] truncate">{mediaPreview.name}</p>
            </div>
            <button
              type="button"
              onClick={() => setMediaPreview(null)}
              className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center text-zinc-300 hover:text-white transition-colors"
              style={{ background: 'rgba(255,255,255,0.1)' }}
              title="Close preview"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
      )}
    </div>
  );
}

