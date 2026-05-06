import { Op } from './types';
import { useEdithEditingStore } from './stores/edithEditingStore';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Map an op to its representative timeline frame.
// Returns null for ops with no meaningful timeline position (they get a sweep instead).
function opToFrame(op: Op, fps: number): number | null {
  switch (op.type) {
    case 'addCaption':
      return Math.round(op.startSeconds * fps);
    case 'setBroll':
      return Math.round(op.startSeconds * fps);
    case 'insertClip':
      return op.startFrame ?? 0;
    case 'cut':
      return op.atFrame;
    case 'trimClip':
      return op.newStartFrame ?? 0;
    case 'moveClip':
      return op.toStartFrame;
    case 'addSfx':
      return op.atFrame;
    case 'geminiEdit':
      return null; // sweep
    case 'colorGrade':
      return null; // sweep
    case 'cutSilence':
      return null; // sweep
    case 'renderGraphic':
      return null; // sweep — render takes time, no single target frame
    default:
      return null;
  }
}

// Human-readable label for each op
function opLabel(op: Op): string {
  switch (op.type) {
    case 'addCaption':    return `addCaption — "${op.text?.slice(0, 20)}" at ${op.startSeconds?.toFixed(2)}s`;
    case 'setBroll':      return `addBroll — placing at ${op.startSeconds?.toFixed(2)}s`;
    case 'trimClip':      return `trimClip — adjusting cut`;
    case 'insertClip':    return `insertClip — placing clip`;
    case 'cut':           return `cut — splitting at frame ${op.atFrame}`;
    case 'colorGrade':    return `colorGrade — applying grade`;
    case 'geminiEdit':    return `geminiEdit — AI edit pass`;
    case 'cutSilence':    return `cutSilence — removing silence`;
    case 'runWhisper':    return `runWhisper — transcribing`;
    case 'analyzeReference': return `analyzeReference — studying reference`;
    case 'downloadMedia': return `downloadMedia — fetching b-roll`;
    case 'setAspectRatio': return `setAspectRatio — ${(op as any).ratio}`;
    case 'moveClip':      return `moveClip — repositioning`;
    case 'deleteClip':    return `deleteClip`;
    case 'saveStyle':     return `saveStyle — "${(op as any).name}"`;
    case 'renderGraphic': return `renderGraphic — ${(op as any).durationSeconds}s graphic`;
    default:              return op.type;
  }
}

function setPlayhead(frame: number) {
  useVideoEditorStore.getState().setCurrentFrame(frame);
  useEdithEditingStore.getState().setHeadFrame(frame); // keep store in sync for label positioning
}

// Animate the playhead for a single op before it applies.
// Mimics the 3D-printer feel: jump to target, micro-nudge back, confirm.
export async function animateForOp(op: Op, fps: number, totalFrames: number): Promise<void> {
  const edithStore = useEdithEditingStore.getState();
  const current = edithStore.headFrame;

  edithStore.setOpLabel(opLabel(op));

  const targetFrame = opToFrame(op, fps);

  if (targetFrame === null) {
    // Sweep ops: fast left-to-right pass then return to end
    await sweep(current, totalFrames, fps);
    return;
  }

  // Micro back-and-forth around target
  const jitter = Math.max(2, Math.round(fps * 0.06)); // ~1.5 frames at 24fps

  // Jump to target — EDITH has arrived at the edit point
  setPlayhead(targetFrame);
  await sleep(500);
  // Nudge back slightly — reconsidering
  setPlayhead(Math.max(0, targetFrame - jitter));
  await sleep(380);
  // Confirm forward — committing
  setPlayhead(targetFrame + Math.round(jitter * 0.5));
  await sleep(340);
  // Settle on target
  setPlayhead(targetFrame);
  await sleep(480);
}

// Sweep from current frame to end (for colorGrade, cutSilence etc.)
async function sweep(fromFrame: number, toFrame: number, fps: number): Promise<void> {
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const f = Math.round(fromFrame + (toFrame - fromFrame) * (i / steps));
    setPlayhead(f);
    await sleep(110);
  }
}

export function startEdithEditing() {
  useEdithEditingStore.getState().startEditing();
}

export function stopEdithEditing() {
  useEdithEditingStore.getState().stopEditing();
}
