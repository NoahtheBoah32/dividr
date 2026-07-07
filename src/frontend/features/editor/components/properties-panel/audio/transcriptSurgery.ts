/**
 * transcriptSurgery — store-aware timeline surgery for "Transcript Surgery" (Skill 1).
 *
 * Shared by the opt-in Surgery-mode panel UI and EDITH's pullPhrase / reorderPhrase
 * ops so both behave identically:
 *   PULL  = copy a spoken span to a new point (duplication allowed, NO warning —
 *           the original stays; the user removes it themselves for a clean move).
 *   MOVE  = relocate a spoken span's whole voice+video block (ripple close + open).
 *
 * Built by replicating DiviDr's proven restoreSegment (ripple-open + insert) and
 * deleteSegment (ripple-close) flows, minus the animation. It ADDS behavior only —
 * nothing in the existing delete-only transcript editor is touched.
 *
 * Coordinate rule (the main foot-gun): transcript words live in SOURCE seconds;
 * the timeline works in frames. We bridge with wordToTimelineRange (source→timeline)
 * and never mix the two spaces.
 */
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import { wordToTimelineRange, type CoverageClip } from './transcriptEditUtils';

type SubjectType = 'video' | 'audio';
const state = () => useVideoEditorStore.getState() as any;

async function makePreviewUrl(src: string): Promise<string> {
  try {
    const r = await (window as any).electronAPI?.createPreviewUrl(src);
    if (r && typeof r === 'object' && (r as any).url) return (r as any).url;
    if (typeof r === 'string') return r;
  } catch {
    /* fall through to raw path */
  }
  return src;
}

/** Layer-0 clips of a given source (sorted by timeline position). */
function layer0OfSource(source: string, subjectType: SubjectType = 'video'): any[] {
  return (state().tracks as any[])
    .filter(
      (t) => (t.trackRowIndex ?? 0) === 0 && t.type === subjectType && t.source === source,
    )
    .sort((a, b) => a.startFrame - b.startFrame);
}

/** Minimal coverage-clip list for the source→timeline math (matches the panel's builder). */
export function coverageClipsForSource(source: string, subjectType: SubjectType = 'video'): CoverageClip[] {
  return layer0OfSource(source, subjectType).map((t) => ({
    startFrame: t.startFrame,
    endFrame: t.endFrame,
    sourceStartTime: t.sourceStartTime,
    playbackRate: (t as any).playbackRate,
    speed: (t as any).speed,
  }));
}

/** Shift every clip at/after `atFrame` right by `gapFrames` — opens a gap to insert into. */
function rippleOpen(atFrame: number, gapFrames: number): void {
  if (gapFrames <= 0) return;
  const s = state();
  for (const clip of [...(s.tracks as any[])]) {
    if (clip.startFrame >= atFrame) {
      s.updateTrack(clip.id, {
        startFrame: clip.startFrame + gapFrames,
        endFrame: clip.endFrame + gapFrames,
      });
    }
  }
}

/**
 * Insert [sourceStartSec .. sourceStartSec + durFrames] of `source` as a fresh
 * layer-0 video block at `atFrame`. Room must already be opened by rippleOpen.
 *
 * IMPORTANT: the store's addTrack({type:'video'}) automatically creates the linked
 * video+audio PAIR and forces the audio to share the video's start frame, so the
 * voice and picture stay welded as one block (the spec's "voice + video move
 * together"). We must NOT add a second audio track ourselves — that would double it.
 * `explicitStart: true` also stops an atFrame of 0 from being treated as
 * "append to the end" by addTrack's default consecutive-placement rule.
 */
async function insertSourceBlock(
  source: string,
  sourceStartSec: number,
  durFrames: number,
  atFrame: number,
): Promise<void> {
  const ref = layer0OfSource(source, 'video')[0];
  const previewUrl = await makePreviewUrl(source);
  await state().addTrack({
    type: 'video' as const,
    name: ref?.name ?? source.split(/[/\\]/).pop() ?? source,
    source,
    mediaId: ref?.mediaId,
    startFrame: atFrame,
    endFrame: atFrame + durFrames,
    trackRowIndex: 0,
    sourceStartTime: sourceStartSec,
    sourceDuration: ref?.sourceDuration,
    muted: ref?.muted ?? false,
    visible: true,
    locked: false,
    previewUrl,
    explicitStart: true,
  } as any);
}

/** Close the gap left by removing [fromFrame,toFrame] on the base row (deleteSegment-style, no animation). */
function rippleCloseBlock(fromFrame: number, toFrame: number, subjectType: SubjectType): void {
  const gapFrames = toFrame - fromFrame;
  if (gapFrames <= 0) return;

  const clipAtFrom = (state().tracks as any[]).find(
    (t) =>
      (t.trackRowIndex ?? 0) === 0 &&
      t.type === subjectType &&
      fromFrame >= t.startFrame &&
      fromFrame < t.endFrame,
  );
  if (!clipAtFrom) return;
  if (fromFrame > clipAtFrom.startFrame) state().splitTrack(clipAtFrom.id, fromFrame);
  const findMiddle = () =>
    (state().tracks as any[]).find(
      (t) => (t.trackRowIndex ?? 0) === 0 && t.type === subjectType && t.startFrame === fromFrame,
    );
  let mid = findMiddle() ?? clipAtFrom;
  if (mid && mid.endFrame > toFrame) {
    state().splitTrack(mid.id, toFrame);
    mid = findMiddle() ?? mid;
  }
  if (mid) state().removeTrack(mid.id);

  // Re-time subtitles + overlays; skip linked audio (handled with its video).
  const s1 = state();
  for (const t of [...(s1.tracks as any[])]) {
    const row = t.trackRowIndex ?? 0;
    const isSub = t.type === 'subtitle';
    const isOverlay = row > 0 && (t.type === 'video' || t.type === 'audio' || t.type === 'image');
    if (!isSub && !isOverlay) continue;
    if (t.type === 'audio' && t.isLinked) continue;
    if (t.endFrame <= fromFrame) continue;
    if (t.startFrame >= toFrame) {
      s1.updateTrack(t.id, { startFrame: t.startFrame - gapFrames, endFrame: t.endFrame - gapFrames });
    } else {
      s1.removeTrack(t.id);
    }
  }
  // Close the base-row gap.
  const s2 = state();
  for (const clip of [...(s2.tracks as any[])]) {
    if ((clip.trackRowIndex ?? 0) === 0 && clip.startFrame >= toFrame) {
      s2.updateTrack(clip.id, { startFrame: clip.startFrame - gapFrames, endFrame: clip.endFrame - gapFrames });
    }
  }
}

export interface SurgeryResult {
  ok: boolean;
  error?: string;
}

/**
 * PULL (copy) the spoken span [startSec,endSec] of `source` to timeline `atFrame`.
 * The original occurrence is left untouched — duplication is allowed silently, per
 * spec. One undo group.
 */
export async function pullSceneToFrame(
  source: string,
  startSec: number,
  endSec: number,
  atFrame: number,
  fps: number,
): Promise<SurgeryResult> {
  if (endSec <= startSec) return { ok: false, error: 'empty span' };
  const durFrames = Math.max(1, Math.round((endSec - startSec) * fps));
  state().beginGroup?.('Pull scene');
  try {
    rippleOpen(atFrame, durFrames);
    await insertSourceBlock(source, startSec, durFrames, atFrame);
  } finally {
    state().endGroup?.();
  }
  return { ok: true };
}

/**
 * MOVE (relocate) the block currently covering [startSec,endSec] to timeline
 * `atFrame`: ripple-close the vacated gap, then ripple-open + insert at the
 * position-adjusted target. One undo group.
 */
export async function moveSceneToFrame(
  source: string,
  startSec: number,
  endSec: number,
  fromFrame: number,
  toFrame: number,
  atFrame: number,
  fps: number,
): Promise<SurgeryResult> {
  const closeGap = toFrame - fromFrame;
  if (closeGap <= 0) return { ok: false, error: 'empty span' };
  const durFrames = Math.max(1, Math.round((endSec - startSec) * fps));
  state().beginGroup?.('Move scene');
  try {
    rippleCloseBlock(fromFrame, toFrame, 'video');
    // Everything after toFrame just shifted left by closeGap — adjust the target.
    let target = atFrame;
    if (atFrame >= toFrame) target = atFrame - closeGap;
    else if (atFrame > fromFrame) target = fromFrame; // dropped inside itself → clamp
    rippleOpen(target, durFrames);
    await insertSourceBlock(source, startSec, durFrames, target);
  } finally {
    state().endGroup?.();
  }
  return { ok: true };
}

/** High-level: PULL a spoken span of `source` to a target frame. */
export async function pullPhrase(
  source: string,
  startSec: number,
  endSec: number,
  targetFrame: number,
  fps: number,
): Promise<SurgeryResult> {
  return pullSceneToFrame(source, startSec, endSec, targetFrame, fps);
}

/** High-level: MOVE the block currently covering a spoken span to a target frame. */
export async function movePhrase(
  source: string,
  startSec: number,
  endSec: number,
  targetFrame: number,
  fps: number,
): Promise<SurgeryResult> {
  const cov = coverageClipsForSource(source, 'video');
  const range = wordToTimelineRange({ start: startSec, end: endSec }, cov, fps);
  if (!range) return { ok: false, error: 'phrase is not currently on the timeline' };
  return moveSceneToFrame(source, startSec, endSec, range.fromFrame, range.toFrame, targetFrame, fps);
}
