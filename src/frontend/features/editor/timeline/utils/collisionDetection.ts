import { VideoTrack } from '../../stores/videoEditor/types';

type MarkerSnapSource = Array<number | { frame: number }>;

const pushUniqueFrame = (
  target: number[],
  seen: Set<number>,
  frame: number,
): void => {
  if (!Number.isFinite(frame)) return;
  const normalizedFrame = Math.round(frame);
  if (!seen.has(normalizedFrame)) {
    seen.add(normalizedFrame);
    target.push(normalizedFrame);
  }
};

const appendMarkerFrames = (
  target: number[],
  seen: Set<number>,
  markerSnapSources: MarkerSnapSource = [],
): void => {
  markerSnapSources.forEach((marker) => {
    const markerFrame =
      typeof marker === 'number' ? marker : Number(marker?.frame);
    pushUniqueFrame(target, seen, markerFrame);
  });
};

/**
 * Collision Detection Utility for Multi-Row Track Architecture
 *
 * Rules:
 * 1. Only check collisions within the same track type
 * 2. Only check collisions within the same row index
 * 3. Only check collisions when time ranges overlap (not just touch)
 * 4. Touching edges (end === start) does NOT count as collision
 */

export interface CollisionCheckOptions {
  /** Track ID to exclude from collision check (usually the track being moved) */
  excludeTrackId?: string;
  /** Additional track IDs to exclude (e.g., linked tracks, selected tracks) */
  excludeTrackIds?: string[];
  /** Whether to include touching edges as collision (default: false) */
  includeTouchingEdges?: boolean;
}

export interface RowAvailabilityOptions {
  /** Preferred row index to try first */
  preferredRowIndex?: number;
  /** Minimum row index allowed (default: 0) */
  minRowIndex?: number;
  /** Track IDs to exclude from collision checks */
  excludeTrackIds?: string[];
}

/**
 * Check if two time ranges overlap (exclusive of touching edges by default)
 */
export const timeRangesOverlap = (
  start1: number,
  end1: number,
  start2: number,
  end2: number,
  includeTouchingEdges = false,
): boolean => {
  if (includeTouchingEdges) {
    return start1 <= end2 && end1 >= start2;
  }
  // Exclusive: touching edges (end1 === start2 or end2 === start1) is NOT a collision
  return start1 < end2 && end1 > start2;
};

/**
 * Get tracks that could potentially collide with a given track
 * Filters by same type AND same row index
 */
export const getCollisionCandidates = (
  track: VideoTrack,
  allTracks: VideoTrack[],
  options: CollisionCheckOptions = {},
): VideoTrack[] => {
  const { excludeTrackId, excludeTrackIds = [] } = options;
  const excludeSet = new Set(excludeTrackIds);
  if (excludeTrackId) {
    excludeSet.add(excludeTrackId);
  }

  return allTracks.filter((t) => {
    // Exclude self and specified tracks
    if (t.id === track.id || excludeSet.has(t.id)) {
      return false;
    }

    // Must be same track type
    if (t.type !== track.type) {
      return false;
    }

    // Must be same row index
    const trackRowIndex = track.trackRowIndex ?? 0;
    const candidateRowIndex = t.trackRowIndex ?? 0;
    if (trackRowIndex !== candidateRowIndex) {
      return false;
    }

    return true;
  });
};

/**
 * Check if a track at a proposed position would collide with any existing tracks
 * Returns the first colliding track or null if no collision
 */
export const findCollision = (
  proposedStartFrame: number,
  proposedEndFrame: number,
  trackType: VideoTrack['type'],
  trackRowIndex: number,
  allTracks: VideoTrack[],
  options: CollisionCheckOptions = {},
): VideoTrack | null => {
  const {
    excludeTrackId,
    excludeTrackIds = [],
    includeTouchingEdges = false,
  } = options;
  const excludeSet = new Set(excludeTrackIds);
  if (excludeTrackId) {
    excludeSet.add(excludeTrackId);
  }

  for (const track of allTracks) {
    // Skip excluded tracks
    if (excludeSet.has(track.id)) {
      continue;
    }

    // Must be same track type
    if (track.type !== trackType) {
      continue;
    }

    // Must be same row index
    const candidateRowIndex = track.trackRowIndex ?? 0;
    if (candidateRowIndex !== trackRowIndex) {
      continue;
    }

    // Check time range overlap
    if (
      timeRangesOverlap(
        proposedStartFrame,
        proposedEndFrame,
        track.startFrame,
        track.endFrame,
        includeTouchingEdges,
      )
    ) {
      return track;
    }
  }

  return null;
};

/**
 * Check if a track at a proposed position would have any collisions
 */
export const hasCollision = (
  proposedStartFrame: number,
  proposedEndFrame: number,
  trackType: VideoTrack['type'],
  trackRowIndex: number,
  allTracks: VideoTrack[],
  options: CollisionCheckOptions = {},
): boolean => {
  return (
    findCollision(
      proposedStartFrame,
      proposedEndFrame,
      trackType,
      trackRowIndex,
      allTracks,
      options,
    ) !== null
  );
};

/**
 * Find adjacent clips on the same track type AND same row
 * Returns the nearest clip to the left and right of the current track
 */
export const findAdjacentClipsInRow = (
  currentTrack: VideoTrack,
  allTracks: VideoTrack[],
): { leftClip: VideoTrack | null; rightClip: VideoTrack | null } => {
  const trackRowIndex = currentTrack.trackRowIndex ?? 0;

  // Filter tracks of the same type AND same row, excluding current track and its linked counterpart
  const sameRowTracks = allTracks.filter(
    (t) =>
      t.id !== currentTrack.id &&
      t.id !== currentTrack.linkedTrackId &&
      t.type === currentTrack.type &&
      (t.trackRowIndex ?? 0) === trackRowIndex,
  );

  // Find the closest clip to the left (highest endFrame that's <= currentTrack.startFrame)
  const leftClip =
    sameRowTracks
      .filter((t) => t.endFrame <= currentTrack.startFrame)
      .sort((a, b) => b.endFrame - a.endFrame)[0] || null;

  // Find the closest clip to the right (lowest startFrame that's >= currentTrack.endFrame)
  const rightClip =
    sameRowTracks
      .filter((t) => t.startFrame >= currentTrack.endFrame)
      .sort((a, b) => a.startFrame - b.startFrame)[0] || null;

  return { leftClip, rightClip };
};

/**
 * Find the nearest available position for a track on a specific row
 * Used when adding new tracks or moving tracks to avoid collisions
 */
export const findNearestAvailablePositionInRow = (
  proposedStartFrame: number,
  duration: number,
  trackType: VideoTrack['type'],
  trackRowIndex: number,
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
): number => {
  const excludeSet = new Set(excludeTrackIds);

  // Get all tracks on the same type and row
  const sameRowTracks = allTracks.filter(
    (t) =>
      !excludeSet.has(t.id) &&
      t.type === trackType &&
      (t.trackRowIndex ?? 0) === trackRowIndex,
  );

  // If no tracks on this row, return proposed position (clamped to 0)
  if (sameRowTracks.length === 0) {
    return Math.max(0, proposedStartFrame);
  }

  const proposedEndFrame = proposedStartFrame + duration;

  // Check if proposed position is available
  const hasOverlap = sameRowTracks.some(
    (t) => proposedStartFrame < t.endFrame && proposedEndFrame > t.startFrame,
  );

  if (!hasOverlap) {
    return Math.max(0, proposedStartFrame);
  }

  // Find all occupied ranges, sorted by start frame
  const occupiedRanges = sameRowTracks
    .map((t) => ({ start: t.startFrame, end: t.endFrame }))
    .sort((a, b) => a.start - b.start);

  // Try to find a gap that fits the duration
  // First, check if we can place before the first track
  if (occupiedRanges[0].start >= duration) {
    return Math.max(0, occupiedRanges[0].start - duration);
  }

  // Check gaps between tracks
  for (let i = 0; i < occupiedRanges.length - 1; i++) {
    const gapStart = occupiedRanges[i].end;
    const gapEnd = occupiedRanges[i + 1].start;
    const gapSize = gapEnd - gapStart;

    if (gapSize >= duration) {
      // Found a gap, prefer the one closest to proposed position
      if (
        gapStart >= proposedStartFrame ||
        gapStart + duration <= proposedEndFrame
      ) {
        return gapStart;
      }
    }
  }

  // No gaps available, place after the last track
  const lastTrack = occupiedRanges[occupiedRanges.length - 1];
  return lastTrack.end;
};

/**
 * Calculate safe movement delta for a track considering row-based collisions
 * Returns the maximum safe delta that won't cause collisions
 */
export const calculateSafeMovementDelta = (
  track: VideoTrack,
  proposedDelta: number,
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
): number => {
  if (proposedDelta === 0) return 0;

  const trackRowIndex = track.trackRowIndex ?? 0;
  const duration = track.endFrame - track.startFrame;
  const excludeSet = new Set([track.id, ...excludeTrackIds]);

  // Get collision candidates (same type AND same row)
  const candidates = allTracks.filter(
    (t) =>
      !excludeSet.has(t.id) &&
      t.type === track.type &&
      (t.trackRowIndex ?? 0) === trackRowIndex,
  );

  if (candidates.length === 0) {
    // No potential collisions, allow full movement (clamped to frame 0)
    const proposedStart = track.startFrame + proposedDelta;
    if (proposedStart < 0) {
      return -track.startFrame; // Clamp to frame 0
    }
    return proposedDelta;
  }

  const proposedStart = track.startFrame + proposedDelta;
  const proposedEnd = proposedStart + duration;

  // Check if proposed position causes collision
  const wouldCollide = candidates.some(
    (c) => proposedStart < c.endFrame && proposedEnd > c.startFrame,
  );

  if (!wouldCollide) {
    // No collision, allow movement (clamped to frame 0)
    if (proposedStart < 0) {
      return -track.startFrame;
    }
    return proposedDelta;
  }

  // Collision detected, find safe delta
  let safeDelta = proposedDelta;

  if (proposedDelta > 0) {
    // Moving right: find the nearest obstacle
    candidates.forEach((c) => {
      if (c.startFrame >= track.endFrame) {
        // This track is to our right
        const maxDelta = c.startFrame - track.endFrame;
        if (maxDelta >= 0 && maxDelta < safeDelta) {
          safeDelta = maxDelta;
        }
      }
    });
  } else {
    // Moving left: find the nearest obstacle
    candidates.forEach((c) => {
      if (c.endFrame <= track.startFrame) {
        // This track is to our left
        const maxDelta = c.endFrame - track.startFrame;
        if (maxDelta <= 0 && maxDelta > safeDelta) {
          safeDelta = maxDelta;
        }
      }
    });

    // Also clamp to frame 0
    const minDelta = -track.startFrame;
    if (safeDelta < minDelta) {
      safeDelta = minDelta;
    }
  }

  return safeDelta;
};

/**
 * Find nearest available position in a specific row (row-aware version)
 * This is the row-aware equivalent of the global findNearestAvailablePosition
 */
export const findNearestAvailablePositionInRowWithPlayhead = (
  desiredStartFrame: number,
  duration: number,
  trackType: VideoTrack['type'],
  trackRowIndex: number,
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
  playheadFrame?: number,
): number => {
  const excludeSet = new Set(excludeTrackIds);

  // Get all tracks on the same type and row
  const existingTracks = allTracks.filter(
    (t) =>
      !excludeSet.has(t.id) &&
      t.type === trackType &&
      (t.trackRowIndex ?? 0) === trackRowIndex,
  );

  // If no tracks on this row, return desired position (clamped to 0)
  if (existingTracks.length === 0) {
    return Math.max(0, desiredStartFrame);
  }

  const desiredEndFrame = desiredStartFrame + duration;
  const sortedTracks = [...existingTracks].sort(
    (a, b) => a.startFrame - b.startFrame,
  );

  // Check if desired position has no conflict
  const hasConflict = sortedTracks.some(
    (track) =>
      desiredStartFrame < track.endFrame && desiredEndFrame > track.startFrame,
  );

  if (!hasConflict) {
    return Math.max(0, desiredStartFrame);
  }

  // Find available positions (gaps between tracks)
  const availablePositions: number[] = [];

  // Check gaps between tracks
  for (let i = 0; i < sortedTracks.length - 1; i++) {
    const currentTrack = sortedTracks[i];
    const nextTrack = sortedTracks[i + 1];
    const gapStart = currentTrack.endFrame;
    const gapEnd = nextTrack.startFrame;
    const gapSize = gapEnd - gapStart;

    if (gapSize >= duration) {
      let gapPosition = Math.max(gapStart, desiredStartFrame);
      if (desiredStartFrame < gapStart) {
        gapPosition = gapStart;
      }
      if (desiredStartFrame > gapEnd - duration) {
        gapPosition = gapEnd - duration;
      }
      if (gapPosition >= gapStart && gapPosition + duration <= gapEnd) {
        availablePositions.push(gapPosition);
      }
    }
  }

  // Check gap before first track
  if (sortedTracks.length > 0) {
    const firstTrack = sortedTracks[0];
    if (firstTrack.startFrame >= duration) {
      const gapPosition = Math.max(0, firstTrack.startFrame - duration);
      if (gapPosition + duration <= firstTrack.startFrame) {
        availablePositions.push(gapPosition);
      }
    }
  }

  // Add position after last track
  if (sortedTracks.length > 0) {
    const lastTrack = sortedTracks[sortedTracks.length - 1];
    availablePositions.push(lastTrack.endFrame);
  }

  // Fallback if no positions found
  if (availablePositions.length === 0) {
    const lastTrack = sortedTracks[sortedTracks.length - 1];
    return lastTrack.endFrame;
  }

  // Find nearest position to desired start
  let nearestPosition = availablePositions[0];
  let minDistance = Math.abs(availablePositions[0] - desiredStartFrame);

  for (const position of availablePositions) {
    const distance = Math.abs(position - desiredStartFrame);
    let adjustedDistance = distance;

    // Prefer positions near playhead
    if (playheadFrame !== undefined) {
      const playheadDistance = Math.abs(position - playheadFrame);
      if (playheadDistance < 10) {
        adjustedDistance = distance * 0.8;
      }
    }

    if (adjustedDistance < minDistance) {
      nearestPosition = position;
      minDistance = adjustedDistance;
    }
  }

  return nearestPosition;
};

/**
 * Find snap points for a track being dragged
 * Returns potential snap targets based on ALL tracks' edges (regardless of type or row)
 * This matches CapCut behavior where you can snap to any clip edge
 */
export const findSnapPoints = (
  track: VideoTrack,
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
  playheadFrame?: number,
  markerSnapSources: MarkerSnapSource = [],
): { startSnapPoints: number[]; endSnapPoints: number[] } => {
  const excludeSet = new Set([track.id, ...excludeTrackIds]);

  const startSnapPoints: number[] = [];
  const endSnapPoints: number[] = [];
  const startSeen = new Set<number>();
  const endSeen = new Set<number>();

  // Priority 1: clip edges and frame 0
  pushUniqueFrame(startSnapPoints, startSeen, 0);
  pushUniqueFrame(endSnapPoints, endSeen, 0);

  // Collect snap points from ALL tracks (regardless of type or row)
  // This is CapCut-style behavior where any clip edge is a snap target
  allTracks.forEach((t) => {
    if (excludeSet.has(t.id)) return;

    // Add both start and end frames as potential snap points
    pushUniqueFrame(startSnapPoints, startSeen, t.startFrame);
    pushUniqueFrame(startSnapPoints, startSeen, t.endFrame);
    pushUniqueFrame(endSnapPoints, endSeen, t.startFrame);
    pushUniqueFrame(endSnapPoints, endSeen, t.endFrame);
  });

  // Priority 2: marker frames
  appendMarkerFrames(startSnapPoints, startSeen, markerSnapSources);
  appendMarkerFrames(endSnapPoints, endSeen, markerSnapSources);

  // Priority 3: playhead
  if (playheadFrame !== undefined && playheadFrame >= 0) {
    pushUniqueFrame(startSnapPoints, startSeen, playheadFrame);
    pushUniqueFrame(endSnapPoints, endSeen, playheadFrame);
  }

  // Arrays are intentionally NOT sorted so tie-breaks retain priority order.
  return {
    startSnapPoints,
    endSnapPoints,
  };
};

/**
 * Find ALL snap points across all tracks for multi-track snapping
 * Returns a flat array of all unique snap frames
 */
export const findAllSnapPoints = (
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
  playheadFrame?: number,
  markerSnapSources: MarkerSnapSource = [],
): number[] => {
  const excludeSet = new Set(excludeTrackIds);
  const snapPoints: number[] = [];
  const seen = new Set<number>();

  // Priority 1: clip edges and frame 0
  pushUniqueFrame(snapPoints, seen, 0);

  // Collect all edges from all tracks
  allTracks.forEach((t) => {
    if (excludeSet.has(t.id)) return;
    pushUniqueFrame(snapPoints, seen, t.startFrame);
    pushUniqueFrame(snapPoints, seen, t.endFrame);
  });

  // Priority 2: marker frames
  appendMarkerFrames(snapPoints, seen, markerSnapSources);

  // Priority 3: playhead
  if (playheadFrame !== undefined && playheadFrame >= 0) {
    pushUniqueFrame(snapPoints, seen, playheadFrame);
  }

  // Intentionally preserve priority ordering for equal-distance tie-breaks.
  return snapPoints;
};

/**
 * Check if a position should snap to any snap point
 * Returns the snap target frame if within threshold, or null if no snap
 */
export const checkSnapPosition = (
  proposedFrame: number,
  snapPoints: number[],
  snapThreshold = 5,
): number | null => {
  let closestSnap: number | null = null;
  let closestDistance = snapThreshold + 1;

  for (const snapPoint of snapPoints) {
    const distance = Math.abs(proposedFrame - snapPoint);
    if (distance <= snapThreshold && distance < closestDistance) {
      closestSnap = snapPoint;
      closestDistance = distance;
    }
  }

  return closestSnap;
};

/**
 * Calculate snap-adjusted position for a track (global snap across all tracks)
 * Returns { snappedFrame, snapIndicatorFrame } or null if no snap
 */
export const calculateSnapPosition = (
  proposedStartFrame: number,
  trackDuration: number,
  track: VideoTrack,
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
  snapThreshold = 5,
  playheadFrame?: number,
  markerSnapSources: MarkerSnapSource = [],
): { snappedStartFrame: number; snapIndicatorFrame: number } | null => {
  // Get snap points from ALL tracks (not just same type)
  const { startSnapPoints, endSnapPoints } = findSnapPoints(
    track,
    allTracks,
    excludeTrackIds,
    playheadFrame,
    markerSnapSources,
  );

  const proposedEndFrame = proposedStartFrame + trackDuration;

  // Check if start frame snaps (prioritize start snap)
  const startSnap = checkSnapPosition(
    proposedStartFrame,
    startSnapPoints,
    snapThreshold,
  );
  if (startSnap !== null) {
    return {
      snappedStartFrame: startSnap,
      snapIndicatorFrame: startSnap,
    };
  }

  // Check if end frame snaps
  const endSnap = checkSnapPosition(
    proposedEndFrame,
    endSnapPoints,
    snapThreshold,
  );
  if (endSnap !== null) {
    return {
      snappedStartFrame: endSnap - trackDuration,
      snapIndicatorFrame: endSnap,
    };
  }

  return null;
};

/**
 * Calculate snap for multi-track selection
 * Checks if any track in the selection would snap, returns the best snap
 */
export const calculateMultiTrackSnapPosition = (
  tracks: VideoTrack[],
  proposedDelta: number,
  allTracks: VideoTrack[],
  excludeTrackIds: string[] = [],
  snapThreshold = 5,
  playheadFrame?: number,
  markerSnapSources: MarkerSnapSource = [],
): { snappedDelta: number; snapIndicatorFrame: number } | null => {
  const allSnapPoints = findAllSnapPoints(
    allTracks,
    excludeTrackIds,
    playheadFrame,
    markerSnapSources,
  );

  let bestSnap: { snappedDelta: number; snapIndicatorFrame: number } | null =
    null;
  let bestDistance = snapThreshold + 1;

  for (const track of tracks) {
    const proposedStart = track.startFrame + proposedDelta;
    const proposedEnd = track.endFrame + proposedDelta;

    // Check start frame snap
    for (const snapPoint of allSnapPoints) {
      const distance = Math.abs(proposedStart - snapPoint);
      if (distance <= snapThreshold && distance < bestDistance) {
        bestSnap = {
          snappedDelta: snapPoint - track.startFrame,
          snapIndicatorFrame: snapPoint,
        };
        bestDistance = distance;
      }
    }

    // Check end frame snap
    for (const snapPoint of allSnapPoints) {
      const distance = Math.abs(proposedEnd - snapPoint);
      if (distance <= snapThreshold && distance < bestDistance) {
        const trackDuration = track.endFrame - track.startFrame;
        bestSnap = {
          snappedDelta: snapPoint - trackDuration - track.startFrame,
          snapIndicatorFrame: snapPoint,
        };
        bestDistance = distance;
      }
    }
  }

  return bestSnap;
};

/**
 * Calculate final drop position for a track being moved to a new row
 * Handles collision detection and finds nearest available position
 */
export const calculateDropPosition = (
  track: VideoTrack,
  targetRowIndex: number,
  targetFrame: number,
  allTracks: VideoTrack[],
  selectedTrackIds: string[] = [],
): { finalStartFrame: number; finalRowIndex: number } => {
  const duration = track.endFrame - track.startFrame;
  const excludeIds = [...new Set([track.id, ...selectedTrackIds])];

  // Check for collision at target position
  const wouldCollide = hasCollision(
    targetFrame,
    targetFrame + duration,
    track.type,
    targetRowIndex,
    allTracks,
    { excludeTrackIds: excludeIds },
  );

  if (!wouldCollide) {
    return {
      finalStartFrame: Math.max(0, targetFrame),
      finalRowIndex: targetRowIndex,
    };
  }

  // Find nearest available position in target row
  const finalStartFrame = findNearestAvailablePositionInRow(
    targetFrame,
    duration,
    track.type,
    targetRowIndex,
    allTracks,
    excludeIds,
  );

  return {
    finalStartFrame,
    finalRowIndex: targetRowIndex,
  };
};

/**
 * Find the nearest available row index for a time range without collisions.
 * Tries the preferred row first, then searches upward for the next available row.
 */
export const findAvailableRowIndexForRange = (
  proposedStartFrame: number,
  proposedEndFrame: number,
  trackType: VideoTrack['type'],
  allTracks: VideoTrack[],
  options: RowAvailabilityOptions = {},
): number => {
  const { preferredRowIndex, minRowIndex = 0, excludeTrackIds = [] } = options;

  const normalizedPreferred =
    preferredRowIndex !== undefined && !Number.isNaN(preferredRowIndex)
      ? Math.max(minRowIndex, Math.round(preferredRowIndex))
      : undefined;

  const existingRowIndices = allTracks
    .filter((t) => t.type === trackType)
    .map((t) => t.trackRowIndex ?? 0);

  const maxExistingIndex =
    existingRowIndices.length > 0
      ? Math.max(...existingRowIndices)
      : minRowIndex;

  const maxCandidateIndex =
    Math.max(maxExistingIndex, normalizedPreferred ?? minRowIndex) + 1;

  const hasOverlapInRow = (rowIndex: number) =>
    hasCollision(
      proposedStartFrame,
      proposedEndFrame,
      trackType,
      rowIndex,
      allTracks,
      { excludeTrackIds },
    );

  if (
    normalizedPreferred !== undefined &&
    !hasOverlapInRow(normalizedPreferred)
  ) {
    return normalizedPreferred;
  }

  const startIndex =
    normalizedPreferred !== undefined ? normalizedPreferred + 1 : minRowIndex;

  for (let rowIndex = startIndex; rowIndex <= maxCandidateIndex; rowIndex++) {
    if (!hasOverlapInRow(rowIndex)) {
      return rowIndex;
    }
  }

  return maxCandidateIndex;
};
