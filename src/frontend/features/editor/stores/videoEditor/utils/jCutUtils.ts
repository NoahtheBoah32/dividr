/**
 * J-cut (audio lead / split edit) — the incoming clip's audio starts before
 * its picture does, so the viewer hears the next scene while still watching
 * the previous one. DiviDr keeps every video clip as a video track plus a
 * linked audio track, which makes the J-cut pure timeline surgery on fields
 * the preview and export already understand:
 *
 *   audio: the whole item slides LEFT by the lead (same source range), and
 *          hops to a free audio lane while it overlaps the previous clip
 *   video: the cut point stays put, but the picture joins its source `lead`
 *          seconds in (sourceStartTime advances, endFrame/duration shrink)
 *          so sound and picture are in sync from the moment the cut lands
 *
 * Everything is derived from `appliedLeadFrames`, so the surgery inverts
 * exactly no matter how often it is toggled or retimed — and because the
 * linked pair moves by shared deltas, the lead survives later clip moves.
 */

export interface JCutState {
  enabled: boolean;
  /** User's lead preference in seconds — survives toggling off. */
  leadSeconds: number;
  /** Exact frames currently carved into the timeline (0 = off). */
  appliedLeadFrames: number;
  /** Audio lane bump currently applied (restored on revert). */
  appliedRowDelta?: number;
  appliedByEdith?: boolean;
}

export const JCUT_DEFAULT_LEAD = 3;
export const JCUT_MIN_LEAD = 0.5;
export const JCUT_MAX_LEAD = 10;

export const jcutClampLead = (s: number): number => {
  const v = Number.isFinite(s) ? s : JCUT_DEFAULT_LEAD;
  return Math.min(JCUT_MAX_LEAD, Math.max(JCUT_MIN_LEAD, v));
};

interface JCutTrackLike {
  id: string;
  type?: string;
  startFrame: number;
  endFrame: number;
  duration?: number;
  sourceStartTime?: number;
  trackRowIndex?: number;
}

export interface JCutPlan {
  videoPatch: {
    sourceStartTime: number;
    endFrame: number;
    duration: number;
    jCut: JCutState;
  };
  audioPatch: { startFrame: number; endFrame: number; trackRowIndex: number };
  /** Lead actually applied after clamping, in seconds. */
  appliedSeconds: number;
}

export interface JCutPlanError {
  error: string;
}

/**
 * Pure reconcile: given the CURRENT tracks (which may already carry a J-cut)
 * and the desired state, produce the exact patches. Works entirely off the
 * applied-frame count stored on the clip, so any state reaches any other.
 */
export function planJCut(opts: {
  video: JCutTrackLike & { jCut?: JCutState };
  audio: JCutTrackLike;
  tracks: readonly JCutTrackLike[];
  fps: number;
  enabled: boolean;
  leadSeconds?: number;
  markEdith?: boolean;
}): JCutPlan | JCutPlanError {
  const { video, audio, tracks, enabled, markEdith } = opts;
  const fps = opts.fps > 0 ? opts.fps : 30;
  const cur = video.jCut;
  const curLead = Math.max(0, Math.round(cur?.appliedLeadFrames ?? 0));
  const curRowDelta = cur?.appliedRowDelta ?? 0;

  const lead = jcutClampLead(
    opts.leadSeconds ?? cur?.leadSeconds ?? JCUT_DEFAULT_LEAD,
  );

  // Reconstruct the un-J-cut geometry — clamps are judged against it.
  const audioStart0 = audio.startFrame + curLead;
  const audioEnd0 = audio.endFrame + curLead;
  const audioRow0 = (audio.trackRowIndex ?? 0) - curRowDelta;
  const videoEnd0 = video.endFrame + curLead;
  const videoDur0 = videoEnd0 - video.startFrame;
  const videoSrc0 = (video.sourceStartTime ?? 0) - curLead / fps;

  let desired = enabled ? Math.round(lead * fps) : 0;
  if (enabled) {
    // The audio can only lead as far as the timeline start allows, and the
    // picture must keep at least a second of itself after losing its head.
    const maxLead = Math.min(audioStart0, videoDur0 - Math.round(fps));
    if (maxLead < Math.round(JCUT_MIN_LEAD * fps)) {
      return {
        error:
          audioStart0 < Math.round(JCUT_MIN_LEAD * fps)
            ? 'No room before this clip — a J-cut needs the clip to start later on the timeline so its audio can lead over the previous clip'
            : 'Clip is too short for a J-cut — the picture needs at least a second left after trading its head for the audio lead',
      };
    }
    desired = Math.min(desired, maxLead);
  }

  // While the lead is applied, the audio overlaps the previous clip's audio —
  // park it on a fresh lane (like dragging it onto its own row in an NLE) so
  // the J shape reads cleanly, then put it back home on revert.
  let rowDelta = 0;
  if (desired > 0) {
    const newStart = audioStart0 - desired;
    const newEnd = audioEnd0 - desired;
    const laneMates = tracks.filter(
      (t) =>
        t.type === 'audio' &&
        t.id !== audio.id &&
        (t.trackRowIndex ?? 0) === audioRow0 &&
        t.startFrame < newEnd &&
        t.endFrame > newStart,
    );
    if (laneMates.length > 0) {
      // Already parked on a bump lane? Stay there — recomputing would climb.
      if (curRowDelta > 0) {
        rowDelta = curRowDelta;
      } else {
        const maxRow = tracks.reduce(
          (m, t) =>
            t.type === 'audio' && t.id !== audio.id
              ? Math.max(m, t.trackRowIndex ?? 0)
              : m,
          0,
        );
        rowDelta = maxRow + 1 - audioRow0;
      }
    }
  }

  const newVideoEnd = videoEnd0 - desired;
  return {
    videoPatch: {
      sourceStartTime: videoSrc0 + desired / fps,
      endFrame: newVideoEnd,
      duration: newVideoEnd - video.startFrame,
      jCut: {
        enabled: enabled && desired > 0,
        leadSeconds: lead,
        appliedLeadFrames: desired,
        appliedRowDelta: rowDelta,
        appliedByEdith: cur?.appliedByEdith || markEdith || false,
      },
    },
    audioPatch: {
      startFrame: audioStart0 - desired,
      endFrame: audioEnd0 - desired,
      trackRowIndex: audioRow0 + rowDelta,
    },
    appliedSeconds: desired / fps,
  };
}

export interface JCutResult {
  ok: boolean;
  /** Lead actually applied in seconds (0 when reverted or on failure). */
  appliedSeconds: number;
  error?: string;
}

/**
 * Apply/adjust/revert the J-cut on a video clip through the store — one undo
 * entry for the whole surgery. `store` is useVideoEditorStore.getState().
 */
export function setJCut(
  store: {
    tracks: (JCutTrackLike & {
      type?: string;
      linkedTrackId?: string;
      jCut?: JCutState;
    })[];
    timeline?: { fps?: number };
    updateTrack: (id: string, updates: Record<string, unknown>) => void;
    beginGroup?: (name: string) => void;
    endGroup?: () => void;
  },
  videoTrackId: string,
  opts: { enabled: boolean; leadSeconds?: number; markEdith?: boolean },
): JCutResult {
  const video = store.tracks.find((t) => t.id === videoTrackId);
  if (!video || video.type !== 'video') {
    return { ok: false, appliedSeconds: 0, error: 'J-cut runs on video clips only' };
  }
  const audio = video.linkedTrackId
    ? store.tracks.find(
        (t) => t.id === video.linkedTrackId && t.type === 'audio',
      )
    : undefined;
  if (!audio) {
    return {
      ok: false,
      appliedSeconds: 0,
      error:
        'This clip has no linked audio track to lead with — a J-cut slides the clip’s own audio ahead of its picture',
    };
  }

  const plan = planJCut({
    video,
    audio,
    tracks: store.tracks,
    fps: store.timeline?.fps ?? 30,
    enabled: opts.enabled,
    leadSeconds: opts.leadSeconds,
    markEdith: opts.markEdith,
  });
  if ('error' in plan) return { ok: false, appliedSeconds: 0, error: plan.error };

  store.beginGroup?.('J-Cut');
  try {
    store.updateTrack(video.id, plan.videoPatch as Record<string, unknown>);
    store.updateTrack(audio.id, plan.audioPatch as Record<string, unknown>);
  } finally {
    store.endGroup?.();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  }
  return { ok: true, appliedSeconds: plan.appliedSeconds };
}
