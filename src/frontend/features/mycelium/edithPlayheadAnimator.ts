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
    case 'renameProject':
      return null; // no playhead movement
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
    case 'renameProject': return `renameProject — "${(op as any).title}"`;
    case 'zoomToFace': {
      const target = (op as any).target ?? 'face';
      return `zoomTo${target.charAt(0).toUpperCase() + target.slice(1)} — ${(op as any).startSeconds?.toFixed(1)}s–${(op as any).endSeconds?.toFixed(1)}s`;
    }
    default:              return op.type;
  }
}

function setPlayhead(frame: number) {
  useVideoEditorStore.getState().setCurrentFrame(frame);
  useEdithEditingStore.getState().setHeadFrame(frame); // keep store in sync for label positioning
}

const CURSOR_OPS = new Set([
  'cursorMoveTo', 'cursorClick', 'cursorStartDrag', 'cursorDrop', 'cursorHide',
  'highlightClipSegment', 'clearClipHighlight',
]);

// Ops that read the CURRENT preview frame the instant they run. Animating the
// playhead first destroys their input: detectLight samples the canvas, and a sweep
// that has just parked the playhead past the last clip hands it a black frame —
// which is why light detection kept "not finding" anything.
const NO_ANIM_OPS = new Set(['detectLight']);

// Animate the playhead for a single op before it applies.
// Mimics the 3D-printer feel: jump to target, micro-nudge back, confirm.
export async function animateForOp(op: Op, fps: number, totalFrames: number): Promise<void> {
  // Cursor ops are self-timed via sleep() in storeAdapter — skip playhead animation entirely
  if (CURSOR_OPS.has(op.type)) return;
  // Frame-sampling ops must run against the untouched current frame
  if (NO_ANIM_OPS.has(op.type)) return;

  const edithStore = useEdithEditingStore.getState();
  const current = edithStore.headFrame;

  edithStore.setOpLabel(opLabel(op));

  const targetFrame = opToFrame(op, fps);

  if (targetFrame === null) {
    // Sweep ops: fast left-to-right pass then return to end
    await sweep(current, totalFrames, fps);
    return;
  }

  // Captions and SFX are high-volume ops — use tighter timing (1.3x faster)
  const isFastOp = op.type === 'addCaption' || op.type === 'addSfx';
  const t = isFastOp
    ? { arrive: 385, nudge: 292, confirm: 262, settle: 369 }
    : { arrive: 500, nudge: 380, confirm: 340, settle: 480 };

  // Micro back-and-forth around target — clamped inside the timeline so the
  // confirm-nudge can never land past the last visible frame (black preview).
  const jitter = Math.max(2, Math.round(fps * 0.06)); // ~1.5 frames at 24fps
  const clampF = (f: number) => Math.max(0, Math.min(f, Math.max(0, totalFrames - 1)));

  // Jump to target — EDITH has arrived at the edit point
  setPlayhead(clampF(targetFrame));
  await sleep(t.arrive);
  // Nudge back slightly — reconsidering
  setPlayhead(clampF(targetFrame - jitter));
  await sleep(t.nudge);
  // Confirm forward — committing
  setPlayhead(clampF(targetFrame + Math.round(jitter * 0.5)));
  await sleep(t.confirm);
  // Settle on target
  setPlayhead(clampF(targetFrame));
  await sleep(t.settle);
}

// Sweep from current frame to end (for colorGrade, cutSilence etc.), then RETURN
// to where the user was. Parking at totalFrames left the playhead one frame past
// the last clip — the compositor sees "no clips at this frame" and the preview
// sticks on black until the user scrubs.
async function sweep(fromFrame: number, toFrame: number, fps: number): Promise<void> {
  const steps = 10;
  const end = Math.max(0, toFrame - 1); // last frame that still shows content
  for (let i = 0; i <= steps; i++) {
    const f = Math.round(fromFrame + (end - fromFrame) * (i / steps));
    setPlayhead(f);
    await sleep(110);
  }
  setPlayhead(Math.max(0, Math.min(fromFrame, end)));
}

export function startEdithEditing() {
  useEdithEditingStore.getState().startEditing();
}

export function stopEdithEditing() {
  useEdithEditingStore.getState().stopEditing();
}
