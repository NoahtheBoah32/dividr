/**
 * Transition engine — PURE functions shared by the preview compositor (and later export).
 * No DOM/Electron deps, so fully unit-testable. The duration/position of a transition is
 * derived from the live overlap of two same-row clips; only the type/params are stored.
 */

export type TransitionType =
  | 'dissolve'
  | 'dip'
  | 'wipe'
  | 'push'
  | 'slide'
  | 'zoom'
  | 'whip';

export interface TransitionClip {
  id: string;
  startFrame: number;
  endFrame: number;
  trackRowIndex?: number;
  type?: string;
}

export interface OverlapPair {
  /** Earlier (outgoing) clip. */
  fromId: string;
  /** Later (incoming) clip. */
  toId: string;
  /** Overlap region on the timeline (frames). */
  startFrame: number;
  endFrame: number;
}

/**
 * Find all pairs of same-row VIDEO clips whose timeline ranges overlap.
 * `fromId` is always the earlier-starting clip, `toId` the later one.
 */
export function findOverlapPairs(clips: TransitionClip[]): OverlapPair[] {
  const vids = clips.filter((c) => (c.type ?? 'video') === 'video');
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < vids.length; i++) {
    for (let j = i + 1; j < vids.length; j++) {
      const a = vids[i];
      const b = vids[j];
      if ((a.trackRowIndex ?? 0) !== (b.trackRowIndex ?? 0)) continue;
      const start = Math.max(a.startFrame, b.startFrame);
      const end = Math.min(a.endFrame, b.endFrame);
      if (start < end) {
        const aFirst = a.startFrame <= b.startFrame;
        pairs.push({
          fromId: aFirst ? a.id : b.id,
          toId: aFirst ? b.id : a.id,
          startFrame: start,
          endFrame: end,
        });
      }
    }
  }
  return pairs;
}

/** Progress 0..1 through an overlap at the given timeline frame. */
export function transitionProgress(pair: OverlapPair, frame: number): number {
  const span = pair.endFrame - pair.startFrame;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (frame - pair.startFrame) / span));
}

export interface ClipTransitionFx {
  /** Opacity multiplier 0..1. */
  opacity: number;
  /** Horizontal shift as a fraction of canvas width (-1..1). */
  translateXFrac: number;
  /** Vertical shift as a fraction of canvas height (-1..1). */
  translateYFrac: number;
  /** Scale multiplier. */
  scaleMul: number;
  /** Wipe reveal: clip is masked to `revealFrac` of the frame from the given edge. */
  wipe?: { direction: 'left' | 'right' | 'up' | 'down'; revealFrac: number };
}

const IDENTITY: ClipTransitionFx = {
  opacity: 1,
  translateXFrac: 0,
  translateYFrac: 0,
  scaleMul: 1,
};

export interface DipOverlayFx {
  color: string;
  alpha: number;
}

/**
 * Render fx for a clip playing `role` ('from' = outgoing, 'to' = incoming) in a transition
 * of `type` at progress `p` (0..1). Returns identity (no effect) outside known types.
 */
export function transitionFx(
  role: 'from' | 'to',
  type: TransitionType,
  p: number,
  params?: { direction?: 'left' | 'right' | 'up' | 'down'; color?: string },
): ClipTransitionFx {
  switch (type) {
    case 'dissolve':
    case 'whip':
      // whip is a fast dissolve + motion blur (blur applied by the compositor's ghost pass)
      return { ...IDENTITY, opacity: role === 'from' ? 1 - p : p };

    case 'dip':
      // Clips hard-switch at the midpoint; the color overlay (dipOverlay) does the visible fade.
      return {
        ...IDENTITY,
        opacity: role === 'from' ? (p < 0.5 ? 1 : 0) : p < 0.5 ? 0 : 1,
      };

    case 'zoom':
      return role === 'to'
        ? { ...IDENTITY, opacity: p, scaleMul: 1.18 - 0.18 * p }
        : { ...IDENTITY, opacity: 1 - p };

    case 'push':
    case 'slide': {
      const dir = params?.direction ?? 'left';
      const hsign = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
      const vsign = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
      if (role === 'to') {
        // incoming enters from the opposite edge, ending at center
        return {
          ...IDENTITY,
          translateXFrac: -hsign * (1 - p),
          translateYFrac: -vsign * (1 - p),
        };
      }
      // push: outgoing is shoved out in the travel direction; slide: outgoing stays beneath
      return type === 'push'
        ? { ...IDENTITY, translateXFrac: hsign * p, translateYFrac: vsign * p }
        : { ...IDENTITY };
    }

    case 'wipe': {
      const dir = params?.direction ?? 'right';
      return role === 'to'
        ? { ...IDENTITY, wipe: { direction: dir, revealFrac: p } }
        : { ...IDENTITY };
    }

    default:
      return { ...IDENTITY };
  }
}

/**
 * Full-frame color overlay for a dip transition (black/white flash), peaking at the midpoint.
 * Returns null for non-dip transitions.
 */
export function dipOverlay(
  type: TransitionType,
  p: number,
  params?: { color?: string },
): DipOverlayFx | null {
  if (type !== 'dip') return null;
  const alpha = Math.max(0, 1 - Math.abs(0.5 - p) * 2);
  return { color: params?.color ?? 'black', alpha };
}
