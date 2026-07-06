/**
 * TranscriptEditor — Clipchamp-style EDITABLE transcript with per-word ripple delete.
 *
 * The transcript is a controlled contenteditable. You place a real caret anywhere
 * and BACKSPACE through text. Insertions are blocked (you can never add words).
 * Deleting characters shrinks a word; a word only ripples its segment out of the
 * video once it is FULLY emptied. Partial words (e.g. "nag" out of "nagging")
 * stay visible and touch nothing on the timeline. Selecting several words and
 * pressing delete ripples every fully-removed word in one undo step.
 *
 * EDITH's transcript is never touched. The canonical Whisper transcript on the
 * media item stays complete so EDITH's understanding can't be broken by panel
 * edits. The user's partial-word edits live separately on `track.transcriptEdits`.
 *
 * A word that has been fully removed renders struck-through (derived from clip
 * coverage), so undo/redo reflect for free.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { Loader2, ScrollText, RotateCcw } from 'lucide-react';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import type { VideoTrack } from '../../../stores/videoEditor/index';
import {
  type TranscriptionResult,
  type CoverageClip,
  type FlatWord,
  groupIntoLines,
  flattenWords,
  formatTimestamp,
  isWordPresent,
  wordToTimelineRange,
} from './transcriptEditUtils';
import {
  applyDeletion,
  type EditWord,
  type EditCaret,
  type EditSelection,
} from './transcriptCaretEdit';

interface TranscriptEditorProps {
  track: VideoTrack;
  isTranscribing?: boolean;
  transcribingMediaId?: string | null;
}

/** Resolve the subject video track that a (possibly linked-audio) track belongs to. */
function resolveSubjectTrack(track: VideoTrack, tracks: VideoTrack[]): VideoTrack {
  if (track.type === 'video') return track;
  const linkedId =
    (track as any).linkedVideoTrackId || (track as any).linkedTrackId;
  if (linkedId) {
    const v = tracks.find((t) => t.id === linkedId && t.type === 'video');
    if (v) return v;
  }
  return track;
}

function resolveMediaId(subject: VideoTrack, mediaLibrary: any[]): string | undefined {
  if ((subject as any).mediaId) return (subject as any).mediaId;
  const src = subject.source;
  const m = mediaLibrary.find((x) => x?.source === src || x?.tempFilePath === src);
  return m?.id;
}

function resolveTranscription(
  subjectMediaId: string | undefined,
  candidates: (string | undefined)[],
  mediaLibrary: any[],
  singleSourceProject: boolean,
): TranscriptionResult | null {
  const hasTranscript = (m: any) =>
    m?.cachedKaraokeSubtitles?.transcriptionResult?.segments?.length > 0;
  if (subjectMediaId) {
    const byId = mediaLibrary.find((m) => m?.id === subjectMediaId && hasTranscript(m));
    if (byId) return byId.cachedKaraokeSubtitles.transcriptionResult;
  }
  const cand = new Set(candidates.filter(Boolean) as string[]);
  for (const m of mediaLibrary) {
    if (!hasTranscript(m)) continue;
    if (cand.has(m.source) || cand.has(m.tempFilePath) || cand.has(m.previewUrl)) {
      return m.cachedKaraokeSubtitles.transcriptionResult;
    }
  }
  // Safe single-clip fallback: when the whole project has exactly ONE base-row
  // video source and exactly ONE transcribed media item, that transcript can only
  // belong to this clip — so use it even if id/source matching was finicky (e.g.
  // a trimmed/processed clip whose source path drifted from the cached item). This
  // cannot surface a foreign clip's transcript because it requires a single source.
  if (singleSourceProject) {
    const withTranscript = mediaLibrary.filter(hasTranscript);
    if (withTranscript.length === 1) {
      return withTranscript[0].cachedKaraokeSubtitles.transcriptionResult;
    }
  }
  return null;
}

/**
 * Ripple-delete ONE timeline frame range (no undo group of its own — the caller
 * owns the group). A no-animation clone of the proven delete-segment flow: split
 * the base clip at both edges, remove the middle (cascades to linked audio), then
 * re-time overlays/subtitles with the ripple transform and close the base-row gap.
 */
function rippleDeleteOnce(
  fromFrame: number,
  toFrame: number,
  subjectType: 'video' | 'audio',
): void {
  if (toFrame <= fromFrame) return;
  const gapFrames = toFrame - fromFrame;
  const s0 = useVideoEditorStore.getState() as any;

  const findMiddle = () => {
    const st = useVideoEditorStore.getState() as any;
    return (st.tracks as any[]).find(
      (t) =>
        (t.trackRowIndex ?? 0) === 0 &&
        t.type === subjectType &&
        t.startFrame === fromFrame,
    );
  };

  const clipAtFrom = (s0.tracks as any[]).find(
    (t) =>
      (t.trackRowIndex ?? 0) === 0 &&
      t.type === subjectType &&
      fromFrame >= t.startFrame &&
      fromFrame < t.endFrame,
  );
  if (!clipAtFrom) return;

  if (fromFrame > clipAtFrom.startFrame) s0.splitTrack(clipAtFrom.id, fromFrame);
  let segmentClip = findMiddle() ?? clipAtFrom;

  if (segmentClip && segmentClip.endFrame > toFrame) {
    s0.splitTrack(segmentClip.id, toFrame);
    segmentClip = findMiddle() ?? segmentClip;
  }
  if (segmentClip) (useVideoEditorStore.getState() as any).removeTrack(segmentClip.id);

  const ripStart = (v: number) =>
    v < fromFrame ? v : v < toFrame ? fromFrame : v - gapFrames;
  const ripEnd = (v: number) =>
    v <= fromFrame ? v : v <= toFrame ? fromFrame : v - gapFrames;

  const st1 = useVideoEditorStore.getState() as any;
  for (const t of [...(st1.tracks as any[])]) {
    const row: number = t.trackRowIndex ?? 0;
    const isSubtitle = t.type === 'subtitle';
    const isOverlay =
      row > 0 && (t.type === 'video' || t.type === 'audio' || t.type === 'image');
    if (!isSubtitle && !isOverlay) continue;
    const ns = ripStart(t.startFrame);
    const ne = ripEnd(t.endFrame);
    if (ns === t.startFrame && ne === t.endFrame) continue;
    if (ne <= ns) {
      st1.removeTrack(t.id);
      continue;
    }
    st1.updateTrack(t.id, { startFrame: ns, endFrame: ne });
  }

  const st2 = useVideoEditorStore.getState() as any;
  for (const clip of [...(st2.tracks as any[])]) {
    if (
      (clip.trackRowIndex ?? 0) === 0 &&
      clip.type !== 'subtitle' &&
      clip.startFrame >= toFrame
    ) {
      st2.updateTrack(clip.id, {
        startFrame: clip.startFrame - gapFrames,
        endFrame: clip.endFrame - gapFrames,
      });
    }
  }
}

const TranscriptEditorComponent: React.FC<TranscriptEditorProps> = ({
  track,
  isTranscribing,
  transcribingMediaId,
}) => {
  const tracks = useVideoEditorStore((state) => state.tracks);
  const mediaLibrary = useVideoEditorStore((state) => (state as any).mediaLibrary);
  const fps = useVideoEditorStore((state) => state.timeline?.fps ?? 30);
  const setCurrentFrame = useVideoEditorStore(
    (state) => (state as any).setCurrentFrame,
  );
  const updateTrack = useVideoEditorStore((state) => state.updateTrack);

  const subject = useMemo(() => resolveSubjectTrack(track, tracks), [track, tracks]);
  const subjectMediaId = useMemo(
    () => resolveMediaId(subject, mediaLibrary ?? []),
    [subject, mediaLibrary],
  );
  // True when the whole timeline has at most one base-row video source — used to
  // safely fall back to the lone transcript if id/source matching drifts.
  const singleSourceProject = useMemo(() => {
    const srcs = new Set(
      (tracks as VideoTrack[])
        .filter((t) => (t.trackRowIndex ?? 0) === 0 && t.type === 'video' && t.source)
        .map((t) => t.source),
    );
    return srcs.size <= 1;
  }, [tracks]);
  const transcription = useMemo(
    () =>
      resolveTranscription(
        subjectMediaId,
        [subject.source, track.source, (track as any).previewUrl, (subject as any).previewUrl],
        mediaLibrary ?? [],
        singleSourceProject,
      ),
    [subjectMediaId, subject, track, mediaLibrary, singleSourceProject],
  );

  const subjectType: 'video' | 'audio' = subject.type === 'video' ? 'video' : 'audio';
  const edits: Record<string, string> = (track as any).transcriptEdits ?? {};

  const coverageClips: CoverageClip[] = useMemo(() => {
    const src = subject.source;
    return (tracks as VideoTrack[])
      .filter(
        (t) =>
          (t.trackRowIndex ?? 0) === 0 && t.type === subjectType && t.source === src,
      )
      .map((t) => ({
        startFrame: t.startFrame,
        endFrame: t.endFrame,
        sourceStartTime: t.sourceStartTime,
        playbackRate: (t as any).playbackRate,
        speed: (t as any).speed,
      }));
  }, [tracks, subject.source, subjectType]);

  const lines = useMemo(() => groupIntoLines(transcription), [transcription]);
  const allWords = useMemo(() => flattenWords(transcription), [transcription]);

  const shownText = useCallback(
    (w: FlatWord) => edits[w.id] ?? w.text.trim(),
    [edits],
  );
  const isDeleted = useCallback(
    (w: FlatWord) => !isWordPresent(w, coverageClips, fps),
    [coverageClips, fps],
  );

  const trimmedCount = useMemo(
    () =>
      allWords.filter(
        (w) => !isDeleted(w) && (edits[w.id] ?? w.text.trim()) !== w.text.trim(),
      ).length,
    [allWords, edits, isDeleted],
  );

  // Live model snapshot for the native beforeinput handler (avoids stale closures).
  const modelRef = useRef<{
    words: FlatWord[];
    edits: Record<string, string>;
    fps: number;
    trackId: string;
    subjectType: 'video' | 'audio';
    subjectSource: string | undefined;
  }>({ words: [], edits, fps, trackId: track.id, subjectType, subjectSource: subject.source });
  modelRef.current = {
    words: allWords,
    edits,
    fps,
    trackId: track.id,
    subjectType,
    subjectSource: subject.source,
  };

  const editorRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<EditCaret | null>(null);

  // ---- DOM <-> model mapping -------------------------------------------------
  const caretFromDom = useCallback(
    (node: Node | null, offset: number): EditCaret | null => {
      if (!node || !editorRef.current) return null;
      const host = (node.nodeType === 3 ? node.parentElement : node) as Element | null;
      const span = host?.closest?.('[data-wid]') as HTMLElement | null;
      if (span) {
        const len = span.textContent?.length ?? 0;
        const wordId = span.getAttribute('data-wid')!;
        if (node.nodeType === 3) {
          return { wordId, offset: Math.max(0, Math.min(offset, len)) };
        }
        // Element-level selection point: child-index 0 = start, otherwise end.
        return { wordId, offset: offset <= 0 ? 0 : len };
      }
      // Clicked in a gap / non-editable island — snap to the nearest preceding word.
      const spans = Array.from(
        editorRef.current.querySelectorAll('[data-wid]'),
      ) as HTMLElement[];
      if (spans.length === 0) return null;
      const target = (node.nodeType === 1 ? node : host) as Element | null;
      if (target) {
        let preceding: HTMLElement | null = null;
        for (const s of spans) {
          // target follows s  =>  s precedes the click point; keep the latest one.
          if (s.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) {
            preceding = s;
          }
        }
        if (preceding) {
          return {
            wordId: preceding.getAttribute('data-wid')!,
            offset: preceding.textContent?.length ?? 0,
          };
        }
      }
      return { wordId: spans[0].getAttribute('data-wid')!, offset: 0 };
    },
    [],
  );

  const readSelection = useCallback((): EditSelection | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const a = caretFromDom(sel.anchorNode, sel.anchorOffset);
    const f = caretFromDom(sel.focusNode, sel.focusOffset);
    if (!a || !f) return null;
    return { anchor: a, focus: f };
  }, [caretFromDom]);

  const placeCaret = useCallback((c: EditCaret) => {
    const root = editorRef.current;
    if (!root) return;
    // Only ever move the caret while focus is actually in this box — never yank
    // the selection back in if the user has clicked away.
    if (document.activeElement !== root && !root.contains(document.activeElement)) {
      return;
    }
    const span = root.querySelector(
      `[data-wid="${(window as any).CSS?.escape ? CSS.escape(c.wordId) : c.wordId}"]`,
    ) as HTMLElement | null;
    const tn = span?.firstChild;
    if (!tn) return;
    const len = tn.textContent?.length ?? 0;
    const range = document.createRange();
    range.setStart(tn, Math.max(0, Math.min(c.offset, len)));
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  // Restore the caret after each model-driven re-render.
  useLayoutEffect(() => {
    if (pendingCaretRef.current) {
      placeCaret(pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  });

  // ---- Per-word undo grouping ------------------------------------------------
  // Consecutive keystrokes on the SAME word share one undo group whose start
  // state is the full word. So a single ctrl-z restores the whole word (and its
  // video, once removed) in one step, and a partial trim never folds an unrelated
  // prior action. The group commits when the word is fully removed, when the user
  // moves to another word, on blur, on a short idle, or on unmount.
  const groupOpenRef = useRef(false);
  const groupWordRef = useRef<string | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeGroup = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (groupOpenRef.current) {
      (useVideoEditorStore.getState() as any).endGroup?.();
      groupOpenRef.current = false;
      groupWordRef.current = null;
    }
  }, []);

  const armIdleClose = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => closeGroup(), 700);
  }, [closeGroup]);

  const openGroupFor = useCallback((wordId: string) => {
    const store = useVideoEditorStore.getState() as any;
    if (groupOpenRef.current && groupWordRef.current === wordId) return;
    if (groupOpenRef.current) store.endGroup?.(); // commit the previous word's group
    store.beginGroup?.('Edit transcript');
    groupOpenRef.current = true;
    groupWordRef.current = wordId;
  }, []);

  // Commit any open group when the editor unmounts (e.g. switching clips).
  useEffect(() => () => closeGroup(), [closeGroup]);

  // Ripple every base-row occurrence of a word's source span (group owned by caller).
  const rippleWordEverywhere = useCallback((word: FlatWord) => {
    const liveClips = (): CoverageClip[] =>
      (useVideoEditorStore.getState() as any).tracks
        .filter(
          (t: VideoTrack) =>
            (t.trackRowIndex ?? 0) === 0 &&
            t.type === modelRef.current.subjectType &&
            t.source === modelRef.current.subjectSource,
        )
        .map((t: VideoTrack) => ({
          startFrame: t.startFrame,
          endFrame: t.endFrame,
          sourceStartTime: t.sourceStartTime,
          playbackRate: (t as any).playbackRate,
          speed: (t as any).speed,
        }));
    const cap = liveClips().length + 2;
    for (let i = 0; i < cap; i++) {
      const range = wordToTimelineRange(word, liveClips(), modelRef.current.fps);
      if (!range) break;
      rippleDeleteOnce(range.fromFrame, range.toFrame, modelRef.current.subjectType);
    }
  }, []);

  // ---- The one deletion entry point -----------------------------------------
  const handleDelete = useCallback(
    (inputType: string) => {
      const sel = readSelection();
      if (!sel) return;
      const collapsed =
        sel.anchor.wordId === sel.focus.wordId &&
        sel.anchor.offset === sel.focus.offset;
      const m = modelRef.current;
      // Editable model = visible (not fully-deleted) words, in order, with chars.
      const editable: EditWord[] = m.words
        .filter((w) => isWordPresent(w, coverageClips, m.fps))
        .map((w) => ({ id: w.id, chars: m.edits[w.id] ?? w.text.trim() }));
      if (editable.length === 0) return;

      const res = applyDeletion(editable, sel, inputType);
      const affected = Array.from(new Set([...res.changed, ...res.emptied]));
      if (affected.length === 0) return; // no-op keystroke — leave the caret alone
      pendingCaretRef.current = res.caret;

      // Build the next partial-edit map: changed words store their shrunk text,
      // emptied words drop their entry (they become coverage-deleted instead).
      const nextEdits: Record<string, string> = { ...m.edits };
      const wordById = new Map(m.words.map((w) => [w.id, w]));
      for (const id of res.changed) {
        const w = res.model.find((x) => x.id === id);
        const full = wordById.get(id)?.text.trim() ?? '';
        if (w && w.chars !== full) nextEdits[id] = w.chars;
        else delete nextEdits[id];
      }
      for (const id of res.emptied) delete nextEdits[id];

      const rippleEmptied = () => {
        for (const id of res.emptied) {
          const w = wordById.get(id);
          if (w) rippleWordEverywhere(w);
        }
      };

      const discrete = !collapsed || affected.length > 1;
      if (discrete) {
        // A selection delete / multi-word op is one discrete, undoable action.
        closeGroup();
        const store = useVideoEditorStore.getState() as any;
        store.beginGroup?.('Delete transcript');
        try {
          updateTrack(m.trackId, { transcriptEdits: nextEdits } as any);
          rippleEmptied();
        } finally {
          (useVideoEditorStore.getState() as any).endGroup?.();
        }
      } else {
        // Single-word, character-by-character edit: keep ONE group open across
        // consecutive keystrokes on this word so undo restores the full word.
        const W = affected[0];
        openGroupFor(W);
        try {
          updateTrack(m.trackId, { transcriptEdits: nextEdits } as any); // suppressed in group
          if (res.emptied.length > 0) rippleEmptied();
        } finally {
          if (res.emptied.length > 0) {
            closeGroup(); // word fully removed → commit this word's group
          } else {
            armIdleClose(); // stay open for the next keystroke
          }
        }
      }
    },
    [
      readSelection,
      coverageClips,
      updateTrack,
      rippleWordEverywhere,
      closeGroup,
      openGroupFor,
      armIdleClose,
    ],
  );

  // Native beforeinput: block insertions, intercept deletions.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      const t = ie.inputType || '';
      e.preventDefault(); // we own all edits; nothing is applied natively
      if (t.startsWith('delete')) handleDelete(t);
      // every insert* / formatting type is simply swallowed (no additions)
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [handleDelete]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Enter would insert a paragraph; block it outright.
    if (e.key === 'Enter') e.preventDefault();
  }, []);

  const restoreAllWords = useCallback(() => {
    updateTrack(track.id, { transcriptEdits: {} } as any);
  }, [updateTrack, track.id]);

  const seekToLine = useCallback(
    (word: { start: number; end: number }) => {
      const range = wordToTimelineRange(word, coverageClips, fps);
      if (range) setCurrentFrame?.(range.fromFrame);
    },
    [coverageClips, fps, setCurrentFrame],
  );

  // ---- Locked / empty states -------------------------------------------------
  const showSpinner =
    !!isTranscribing &&
    (transcribingMediaId ? transcribingMediaId === subjectMediaId : !transcription);

  if (showSpinner) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Transcribing this clip…</p>
      </div>
    );
  }

  if (!transcription) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 py-8 px-4 text-center">
        <ScrollText className="size-5 text-muted-foreground/70" />
        <p className="text-xs text-muted-foreground">
          Ask EDITH to transcribe this clip to edit it here.
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          Once transcribed, backspace through a word to remove it from the video.
        </p>
      </div>
    );
  }

  const totalWords = allWords.length;
  const deletedCount = allWords.filter((w) => isDeleted(w)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{totalWords} words</span>
        <div className="flex items-center gap-2">
          {deletedCount > 0 && (
            <span className="text-[11px] text-muted-foreground/70">
              {deletedCount} removed · ⌘Z to restore
            </span>
          )}
          {trimmedCount > 0 && (
            <button
              type="button"
              onClick={restoreAllWords}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              title="Restore words you trimmed but did not fully delete"
            >
              <RotateCcw className="size-3" />
              restore {trimmedCount}
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        Click into the text and backspace through a whole word to cut it from the
        video. Partial edits stay until the word is fully removed.
      </p>

      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onKeyDown={onKeyDown}
        onBlur={closeGroup}
        onPaste={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        role="textbox"
        aria-multiline="true"
        className="max-h-[360px] overflow-y-auto pr-1 space-y-3 outline-none focus:outline-none caret-foreground"
      >
        {lines.map((line, li) => (
          <div key={li} className="flex items-start gap-3" data-line>
            <span
              contentEditable={false}
              onClick={() => seekToLine(line.words[0])}
              className="shrink-0 w-11 cursor-pointer select-none text-left font-mono text-xs leading-relaxed tabular-nums text-muted-foreground hover:text-foreground transition-colors"
              title="Jump to this point"
            >
              {formatTimestamp(line.startSec)}
            </span>
            <span className="flex-1 text-sm leading-relaxed text-foreground/90">
              {line.words.map((w) => {
                const full = w.text.trim();
                if (isDeleted(w)) {
                  return (
                    <span
                      key={w.id}
                      contentEditable={false}
                      className="mr-0 inline text-muted-foreground/40 line-through select-none"
                    >
                      {full}
                      <span contentEditable={false} className="select-none">
                        {' '}
                      </span>
                    </span>
                  );
                }
                const shown = shownText(w);
                const trimmed = shown !== full;
                return (
                  <React.Fragment key={w.id}>
                    <span
                      data-wid={w.id}
                      className={
                        'inline rounded-sm ' +
                        (trimmed ? 'text-amber-400/90 underline decoration-dotted underline-offset-2' : '')
                      }
                    >
                      {shown}
                    </span>
                    <span contentEditable={false} className="select-none">
                      {' '}
                    </span>
                  </React.Fragment>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

TranscriptEditorComponent.displayName = 'TranscriptEditor';
export const TranscriptEditor = React.memo(TranscriptEditorComponent);
