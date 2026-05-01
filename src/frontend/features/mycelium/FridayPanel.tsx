import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AgentMessage, AgentPlan, AgentQuestion, AgentStatus, QueuedOp } from './types';
import { operationEngine } from './operationEngine';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor/index';
import { usePanelStore } from '@/frontend/features/editor/stores/PanelStore';
import type { HistoryEntry, MediaContextItem, TimelineSnapshot } from '@/backend/mycelium/agentRuntime';
import { useDownloadApprovalStore } from './stores/downloadApprovalStore';

const LETTERS = ['A', 'B', 'C', 'D'];

function QuestionCard({
  message,
  onAnswer,
}: {
  message: AgentMessage;
  onAnswer: (msgId: string, answer: string) => void;
}) {
  const q = message.question!;
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState('');
  const options = [...q.options, 'Other'];

  const handleSelect = (opt: string, index: number) => {
    if (q.answered) return;
    if (index === options.length - 1) {
      setOtherOpen(true);
      return;
    }
    onAnswer(message.id, opt);
  };

  const handleOtherSubmit = () => {
    const val = otherText.trim();
    if (!val) return;
    onAnswer(message.id, val);
    setOtherOpen(false);
  };

  return (
    <div className="px-4 py-2">
      <div
        className="rounded-lg border border-white/[0.08] overflow-hidden"
        style={{ background: '#1a1a1a' }}
      >
        <div className="px-3 pt-3 pb-2">
          <p className="text-xs text-zinc-200 leading-relaxed">{message.text}</p>
        </div>
        <div className="border-t border-white/[0.06]">
          {options.map((opt, i) => {
            const isSelected = q.answered && q.answer === opt;
            const isOther = i === options.length - 1;
            return (
              <button
                key={i}
                onClick={() => handleSelect(opt, i)}
                disabled={q.answered}
                className={[
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors',
                  'border-b border-white/[0.04] last:border-0',
                  q.answered
                    ? isSelected
                      ? 'text-emerald-400 bg-emerald-950/30'
                      : 'text-zinc-700 cursor-default'
                    : 'text-zinc-300 hover:bg-white/[0.04] cursor-pointer',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex-shrink-0 w-5 h-5 rounded text-[10px] font-mono flex items-center justify-center border',
                    q.answered
                      ? isSelected
                        ? 'border-emerald-500/50 text-emerald-400 bg-emerald-950/40'
                        : 'border-white/[0.06] text-zinc-700'
                      : isOther
                        ? 'border-white/10 text-zinc-500'
                        : 'border-white/10 text-zinc-400',
                  ].join(' ')}
                >
                  {LETTERS[i]}
                </span>
                <span className="flex-1">{opt}</span>
                {isSelected && <span className="text-[10px] text-emerald-600">✓</span>}
              </button>
            );
          })}
        </div>
        {otherOpen && !q.answered && (
          <div className="px-3 pb-3 pt-1 border-t border-white/[0.06]">
            <div className="flex gap-2 items-center">
              <input
                autoFocus
                className="flex-1 bg-white/[0.04] text-xs text-zinc-200 placeholder-zinc-700 rounded px-2 py-1.5 outline-none border border-white/[0.08] focus:border-white/20"
                placeholder="Type your answer…"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleOtherSubmit();
                  if (e.key === 'Escape') { setOtherOpen(false); setOtherText(''); }
                }}
              />
              <button
                onClick={handleOtherSubmit}
                disabled={!otherText.trim()}
                className="text-[11px] px-2 py-1.5 rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-30 transition-colors border border-emerald-900/40"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
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
    <div className="px-4 py-2">
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
  );
}

function ConsentScreen({ onAgree, onCancel }: { onAgree: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col h-full text-white" style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#141414' }}>
      {/* Header */}
      <div className="flex items-center px-4 py-2.5 border-b border-white/[0.06] select-none">
        <div className="flex items-center gap-2.5">
          <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
          <span className="text-xs font-medium tracking-widest uppercase text-zinc-300">E.D.I.T.H</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col px-5 py-5 gap-4 min-h-0 overflow-y-auto">
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
            className="flex-1 py-2 rounded text-xs font-semibold text-white transition-colors"
            style={{ background: '#6b7c3a' }}
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

const STATUS_DOT: Record<AgentStatus, string> = {
  idle: 'bg-zinc-600',
  running: 'bg-emerald-400 animate-pulse',
  paused: 'bg-yellow-400',
  done: 'bg-zinc-600',
  error: 'bg-red-400',
};

function historyToMessages(entries: HistoryEntry[]): AgentMessage[] {
  return entries.map((e, i) => {
    if (e.role === 'edith' && e.text.startsWith('Q:')) {
      try {
        const q = JSON.parse(e.text.slice(2).trim()) as { question: string; options: string[] };
        // If a user message follows this question in history, it was already answered
        const answeredEntry = entries.slice(i + 1).find((next) => next.role === 'user');
        const answered = !!answeredEntry;
        return {
          id: e.id,
          role: 'edith' as AgentMessage['role'],
          text: q.question,
          timestamp: e.timestamp,
          question: { options: q.options, answered, answer: answered ? answeredEntry!.text : undefined },
        };
      } catch { /* fall through */ }
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activePlanIdRef = useRef<string | null>(null);
  const agentStatusRef = useRef<AgentStatus>('idle');
  const interruptedRef = useRef(false);
  const pendingSlowOpsRef = useRef<Set<string>>(new Set());
  const mediaLibrary = useVideoEditorStore((state) => state.mediaLibrary);
  const tracks = useVideoEditorStore((state) => state.tracks);
  const timeline = useVideoEditorStore((state) => state.timeline);
  const approvalPending = useDownloadApprovalStore((s) => s.pending);
  const approvalApprove = useDownloadApprovalStore((s) => s.approve);
  const approvalApproveAll = useDownloadApprovalStore((s) => s.approveAll);
  const approvalDeny = useDownloadApprovalStore((s) => s.deny);

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

  // IPC listeners
  useEffect(() => {
    (window as any).myceliumAPI?.removeAllListeners?.();

    // Shared helper — called when all pending slow ops finish (success or failure)
    const triggerAutoContinue = (errorContext?: string) => {
      setTimeout(() => {
        if (interruptedRef.current) return;
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
          })),
        };
        const text = errorContext ? `continue (note: ${errorContext})` : 'continue';
        window.electronAPI.invoke('mycelium:sendMessage', {
          text,
          mediaContext: mediaCtx,
          timelineSnapshot: timelineCtx,
          activeDownloads: [],
        });
        setAgentStatus('running');
      }, 600);
    };

    const offApplied = operationEngine.on('opApplied', (_opId: string, op: unknown) => {
      setQueue(operationEngine.getQueue());
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
          triggerAutoContinue();
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

    const handleAgentMsg = (_: unknown, data: { role: AgentMessage['role']; text: string }) => {
      if (interruptedRef.current) return;
      setMessages((prev) => [
        ...prev,
        { id: Math.random().toString(36).slice(2), role: data.role, text: data.text, timestamp: Date.now() },
      ]);
      if (data.role !== 'user' && data.role !== 'system') {
        setActiveAgent(data.role);
        setAgentStatus('running');
      }
    };

    const handleOp = (_: unknown, opData: unknown) => {
      if (interruptedRef.current) return;
      try {
        const op = typeof opData === 'string' ? JSON.parse(opData) : opData;
        if (op.type === 'downloadMedia') {
          setActiveDownloads((prev) => [...prev, { url: op.url, topic: op.topic }]);
        }
        const qId = operationEngine.enqueue(op);
        if (op.type === 'runWhisper' || op.type === 'analyzeReference' || op.type === 'geminiEdit') {
          pendingSlowOpsRef.current.add(qId);
        }
        setQueue(operationEngine.getQueue());
      } catch (e) {
        console.error('[FridayPanel] bad op:', e);
      }
    };

    const handleDone = () => {
      if (interruptedRef.current) { interruptedRef.current = false; return; }
      setAgentStatus('done');
      setActiveAgent(null);
      submittingRef.current = false;
      // Remove the transient "thinking" indicator
      setMessages((prev) => prev.filter((m) => m.text !== 'E.D.I.T.H thinking…'));
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
    };

    const handlePlan = (_: unknown, data: { steps: Array<{ id: string; step: string }> }) => {
      if (interruptedRef.current) return;
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

    const handleQuestion = (_: unknown, data: { question: string; options: string[] }) => {
      setMessages((prev) => {
        // Remove empty plan placeholder if EDITH asks a question instead
        const withoutEmptyPlan = activePlanIdRef.current
          ? prev.filter((m) => !(m.id === activePlanIdRef.current && m.plan && m.plan.steps.length === 0))
          : prev;
        activePlanIdRef.current = null;
        return [
          ...withoutEmptyPlan,
          {
            id: Math.random().toString(36).slice(2),
            role: 'edith' as AgentMessage['role'],
            text: data.question,
            timestamp: Date.now(),
            question: { options: data.options, answered: false },
          },
        ];
      });
      setActiveAgent('edith');
      setAgentStatus('running');
    };

    window.electronAPI.on('mycelium:message', handleAgentMsg);
    window.electronAPI.on('mycelium:op', handleOp);
    window.electronAPI.on('mycelium:done', handleDone);
    window.electronAPI.on('mycelium:question', handleQuestion);
    window.electronAPI.on('mycelium:plan', handlePlan);

    return () => {
      offApplied(); offFailed(); offDrained(); offPaused(); offResumed();
      (window as any).myceliumAPI?.removeAllListeners?.();
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
      };
    });
  }, [mediaLibrary]);

  const buildTimelineSnapshot = useCallback((): TimelineSnapshot => {
    const fps = timeline?.fps || 30;
    const { canvasWidth, canvasHeight } = useVideoEditorStore.getState().preview as any;
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
        layer: t.layer ?? 0,
        startFrame: t.startFrame ?? 0,
        endFrame: t.endFrame ?? 0,
        durationFrames: t.duration ?? ((t.endFrame ?? 0) - (t.startFrame ?? 0)),
        volume: t.volume,
        muted: t.muted,
        letterboxBlur: t.proxyBlockedMessage === 'letterbox-blur' || undefined,
        captionText: t.type === 'subtitle' ? (t.subtitleText ?? t.textContent ?? undefined) : undefined,
      })),
    };
  }, [tracks, timeline]);

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
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) addAttachment(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(addAttachment);
    e.target.value = '';
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || submittingRef.current) return;
    interruptedRef.current = false;
    submittingRef.current = true;
    const attachedPaths = attachments.map((a) => a.path);
    const imagePreviews = attachments.filter((a) => a.preview).map((a) => a.preview!);
    const fullText = attachedPaths.length > 0
      ? `${text}\n\n[Attached: ${attachedPaths.join(', ')}]`
      : text;
    setInput('');
    try { localStorage.removeItem(getDraftKey()); } catch {}
    setAttachments([]);
    isNearBottomRef.current = true; // always scroll when user sends
    activePlanIdRef.current = null;
    setMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        role: 'user',
        text: text || `[${attachments.length} attachment${attachments.length > 1 ? 's' : ''}]`,
        timestamp: Date.now(),
        ...(imagePreviews.length > 0 && { imagePreviews }),
      },
    ]);
    setAgentStatus('running');
    await window.electronAPI.invoke('mycelium:sendMessage', {
      text: fullText,
      mediaContext: buildMediaContext(),
      timelineSnapshot: buildTimelineSnapshot(),
      activeDownloads,
    });
  }, [input, attachments, activeDownloads, buildMediaContext, buildTimelineSnapshot]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleQuestionAnswer = useCallback(async (msgId: string, answer: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.question
          ? { ...m, question: { ...m.question, answered: true, answer } }
          : m,
      ),
    );
    setMessages((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), role: 'user', text: answer, timestamp: Date.now() },
    ]);
    setAgentStatus('running');
    interruptedRef.current = false;
    submittingRef.current = true;
    await window.electronAPI.invoke('mycelium:sendMessage', {
      text: answer,
      mediaContext: buildMediaContext(),
      timelineSnapshot: buildTimelineSnapshot(),
      activeDownloads,
    });
  }, [activeDownloads, buildMediaContext, buildTimelineSnapshot]);

  const handlePlanToggle = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.plan
          ? { ...m, plan: { ...m.plan, open: !m.plan.open } }
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
    await window.electronAPI.invoke('mycelium:clearHistory');
    setMessages([{
      id: Math.random().toString(36).slice(2),
      role: 'system',
      text: 'Conversation cleared.',
      timestamp: Date.now(),
    }]);
  }, []);

  // Keep ref in sync so the Escape listener doesn't close over stale state
  useEffect(() => { agentStatusRef.current = agentStatus; }, [agentStatus]);

  // Ctrl+C copies selected text from chat messages (non-input elements)
  useEffect(() => {
    const onCopy = (e: KeyboardEvent) => {
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

  // Escape cancels EDITH mid-response
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (agentStatusRef.current !== 'running' && agentStatusRef.current !== 'paused') return;
      interruptedRef.current = true;
      pendingSlowOpsRef.current.clear();
      operationEngine.clearQueue();
      window.electronAPI.invoke('mycelium:stop');
      submittingRef.current = false;
      setAgentStatus('idle');
      setActiveAgent(null);
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
  const activeQuestion = messages.findLast((m) => m.question && !m.question.answered) ?? null;
  const isActive = agentStatus === 'running' || agentStatus === 'paused';

  if (!consentGiven) {
    return (
      <div className={`flex flex-col h-full${className ? ` ${className}` : ''}`}>
        <ConsentScreen
          onAgree={async () => {
            localStorage.setItem(getConsentKey(), 'true');
            const dlResult = await window.electronAPI.initDownloadDir().catch(() => null);
            if (dlResult?.path) localStorage.setItem('edith-download-dir', dlResult.path);
            setConsentGiven(true);
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
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] select-none">
        <div className="flex items-center gap-2.5">
          <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[agentStatus]}`} />
          <span className="text-xs font-medium tracking-widest uppercase text-zinc-300">
            E.D.I.T.H
          </span>
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
                  setAgentStatus('idle');
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
        className="flex-1 overflow-y-auto py-3 min-h-0 space-y-0.5 select-text"
      >
        {messages.map((msg) => {
          if (msg.role === 'system') {
            const isInterrupted = msg.text === 'Interrupted';
            const isInProgress = !isInterrupted && msg.text.endsWith('…');
            const baseText = isInProgress ? msg.text.slice(0, -1) : msg.text;
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
                  {msg.imagePreviews?.map((src, i) => (
                    <img key={i} src={src} className="rounded-lg max-w-full max-h-40 object-contain border border-white/10" />
                  ))}
                  {msg.text && (
                    <span className="text-xs text-zinc-300 bg-white/[0.06] rounded-lg px-3 py-1.5 break-words select-text cursor-text">
                      {msg.text}
                    </span>
                  )}
                </div>
              </div>
            );
          }
          if (msg.question) {
            if (!msg.question.answered) return null; // rendered anchored below
            return (
              <div key={msg.id} className="px-4 py-1">
                <span className="text-[11px] text-zinc-600 italic">{msg.text} → <span className="text-zinc-500">{msg.question.answer}</span></span>
              </div>
            );
          }
          if (msg.plan) {
            return <PlanCard key={msg.id} message={msg} onToggle={handlePlanToggle} onSkipStep={handleSkipStep} />;
          }
          return (
            <div key={msg.id} className="px-4 py-1.5">
              <span className="text-xs text-zinc-300 leading-relaxed break-words select-text cursor-text">{msg.text}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Active question — anchored above input, never scrolls */}
      {activeQuestion && (
        <div className="border-t border-white/[0.06]">
          <QuestionCard message={activeQuestion} onAnswer={handleQuestionAnswer} />
        </div>
      )}

      {/* Download approval — anchored above input, never scrolls */}
      {approvalPending.length > 0 && (
        <div className="border-t border-white/[0.06]">
          {approvalPending.map((item) => (
            <div key={item.id} className="px-3 py-2">
              <div className="rounded-lg border border-white/[0.08] overflow-hidden" style={{ background: '#1a1a1a' }}>
                <div className="px-3 pt-2.5 pb-2">
                  <p className="text-[11px] font-semibold text-zinc-100 mb-0.5">Allow EDITH to use this download?</p>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">{item.title ?? item.filePath.split(/[/\\]/).pop()}</p>
                </div>
                <div className="flex border-t border-white/[0.06]" style={{ background: '#141414' }}>
                  <button onClick={() => approvalDeny(item.id)} className="flex-1 py-2 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors border-r border-white/[0.06]">Deny</button>
                  <button onClick={() => approvalApprove(item.id)} className="flex-1 py-2 text-[11px] font-medium hover:bg-white/[0.04] transition-colors border-r border-white/[0.06]" style={{ color: '#a3b862' }}>Allow</button>
                  <button onClick={() => approvalApproveAll(item.id)} className="flex-1 py-2 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors border-r border-white/[0.06]">Always allow</button>
                  <button onClick={() => window.electronAPI.showItemInFolder(item.filePath)} className="flex-1 py-2 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors">View</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

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
                const color = { pending: '#52525b', running: '#4ade80', failed: '#f87171' }[q.status] ?? '#3f3f46';
                return (
                  <div key={q.id} className="flex items-center gap-2 font-mono text-[10px]" style={{ color }}>
                    <span className="w-1 h-1 rounded-full bg-current flex-shrink-0" />
                    <span className="truncate">{q.op.type}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="px-3 pb-3 pt-2 border-t border-white/[0.06] select-none">
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

        <input ref={fileInputRef} type="file" multiple accept="image/*,video/*,audio/*" className="hidden" onChange={handleFileInput} />

        <div
          className="flex items-end gap-2 rounded-lg px-3 py-2 border transition-colors"
          style={{ background: '#1e1e1e', borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 transition-colors mb-0.5"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
          <textarea
            className="flex-1 bg-transparent text-xs text-zinc-200 placeholder-zinc-700 resize-none outline-none leading-relaxed"
            rows={2}
            placeholder="Make 3 reels from this video…"
            value={input}
            onChange={(e) => { setInput(e.target.value); try { localStorage.setItem(getDraftKey(), e.target.value); } catch {} }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <button
            onClick={sendMessage}
            disabled={(!input.trim() && attachments.length === 0) || submittingRef.current}
            className="flex-shrink-0 w-6 h-6 rounded flex items-center justify-center transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
            style={{ background: '#22c55e' }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M1 11L11 1M11 1H4M11 1V8" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-zinc-700 mt-1.5 px-1">↵ send · ⇧↵ newline · paste image to attach</p>
      </div>
    </div>
  );
}
