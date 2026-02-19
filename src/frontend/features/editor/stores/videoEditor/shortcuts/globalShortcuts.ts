/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createProjectShortcuts,
  type ProjectShortcutHandlers,
} from './projectShortcuts';
import { ShortcutConfig } from './types';

const TRANSFORMABLE_TYPES = new Set(['image', 'video', 'text', 'subtitle']);

const isEditableTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;

  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.isContentEditable ||
    element.closest('[contenteditable="true"]') !== null
  );
};

const hasVisiblePreviewTransformBoundary = (): boolean => {
  if (typeof document === 'undefined') return false;

  return (
    document.querySelector('[data-preview-canvas="true"] .transform-handle') !==
    null
  );
};

const nudgeSelectedPreviewTransforms = (
  store: any,
  deltaXPixels: number,
  deltaYPixels: number,
  event?: KeyboardEvent,
): boolean => {
  if (store.preview?.activeInteractionArea !== 'preview') return false;
  if (store.preview?.interactionMode !== 'select') return false;
  const activeTarget =
    event?.target ||
    (typeof document !== 'undefined' ? document.activeElement : null);
  if (isEditableTarget(activeTarget)) return false;
  if (!hasVisiblePreviewTransformBoundary()) return false;

  const selectedTrackIds: string[] = store.timeline?.selectedTrackIds || [];
  if (selectedTrackIds.length === 0) return false;

  const currentFrame = store.timeline?.currentFrame || 0;
  const selectedTransformTracks = (store.tracks || []).filter((track: any) => {
    const isTransformable = TRANSFORMABLE_TYPES.has(track.type);
    const isSelected = selectedTrackIds.includes(track.id);
    const isVisible = track.visible !== false;
    const isActive =
      currentFrame >= track.startFrame && currentFrame < track.endFrame;

    return isTransformable && isSelected && isVisible && isActive;
  });

  if (selectedTransformTracks.length === 0) return false;

  const canvasWidth = Number(store.preview?.canvasWidth) || 0;
  const canvasHeight = Number(store.preview?.canvasHeight) || 0;
  if (canvasWidth <= 0 || canvasHeight <= 0) return false;

  const deltaXNormalized = deltaXPixels / (canvasWidth / 2);
  const deltaYNormalized = deltaYPixels / (canvasHeight / 2);

  event?.preventDefault();

  const shouldGroup =
    !store.isGrouping &&
    typeof store.beginGroup === 'function' &&
    typeof store.endGroup === 'function';

  if (shouldGroup) {
    store.beginGroup('Nudge Transform');
  }

  let didUpdate = false;

  try {
    const subtitleSelected = selectedTransformTracks.some(
      (track: any) => track.type === 'subtitle',
    );

    if (
      subtitleSelected &&
      typeof store.setGlobalSubtitlePosition === 'function'
    ) {
      const currentSubtitlePosition = store.textStyle
        ?.globalSubtitlePosition || {
        x: 0,
        y: 0.7,
        scale: 1,
        width: 0,
        height: 0,
      };

      store.setGlobalSubtitlePosition(
        {
          x: (currentSubtitlePosition.x ?? 0) + deltaXNormalized,
          y: (currentSubtitlePosition.y ?? 0) + deltaYNormalized,
          scale: currentSubtitlePosition.scale ?? 1,
          width: currentSubtitlePosition.width ?? 0,
          height: currentSubtitlePosition.height ?? 0,
        },
        { skipRecord: shouldGroup },
      );
      didUpdate = true;
    }

    selectedTransformTracks.forEach((track: any) => {
      if (track.type === 'subtitle') return;

      const currentTransform = track.textTransform || {};
      const currentX = Number.isFinite(currentTransform.x)
        ? currentTransform.x
        : 0;
      const currentY = Number.isFinite(currentTransform.y)
        ? currentTransform.y
        : 0;

      store.updateTrackTransform(
        track.id,
        {
          x: currentX + deltaXNormalized,
          y: currentY + deltaYNormalized,
        },
        { skipRecord: shouldGroup },
      );
      didUpdate = true;
    });
  } finally {
    if (shouldGroup) {
      store.endGroup();
    }
  }

  return didUpdate;
};

/**
 * Global shortcuts - active everywhere in the video editor
 * These include playback controls, navigation shortcuts, and project-level actions
 */
export const createGlobalShortcuts = (
  getStore: () => any,
  effectiveEndFrame: number,
  projectHandlers: ProjectShortcutHandlers,
): ShortcutConfig[] => [
  // Project-level shortcuts (New, Open, Save, Import, Export, Close)
  ...createProjectShortcuts(getStore, projectHandlers),
  {
    id: 'playback-toggle',
    keys: 'space',
    description: 'Play/Pause',
    category: 'Playback',
    scope: 'global',
    priority: 'high',
    handler: (e) => {
      e?.preventDefault();
      const store = getStore();
      if (store.render?.isRendering) return;
      store.togglePlayback();
    },
  },
  {
    id: 'navigate-frame-prev',
    keys: 'left',
    description: 'Move Playhead Backward (1 Frame)',
    category: 'Navigation',
    scope: 'global',
    handler: (e) => {
      const store = getStore();
      if (store.render?.isRendering) return;

      if (nudgeSelectedPreviewTransforms(store, -1, 0, e as KeyboardEvent)) {
        return;
      }

      e?.preventDefault();
      const currentFrame = store.timeline.currentFrame;
      store.setCurrentFrame(Math.max(0, currentFrame - 1));
    },
  },
  {
    id: 'navigate-frame-next',
    keys: 'right',
    description: 'Move Playhead Forward (1 Frame)',
    category: 'Navigation',
    scope: 'global',
    handler: (e) => {
      const store = getStore();
      if (store.render?.isRendering) return;

      if (nudgeSelectedPreviewTransforms(store, 1, 0, e as KeyboardEvent)) {
        return;
      }

      e?.preventDefault();
      const currentFrame = store.timeline.currentFrame;
      store.setCurrentFrame(Math.min(effectiveEndFrame - 1, currentFrame + 1));
    },
  },
  {
    id: 'navigate-frame-prev-fast',
    keys: 'shift+left',
    description: 'Move Playhead Backward (5 Frames)',
    category: 'Navigation',
    scope: 'global',
    handler: (e) => {
      const store = getStore();
      if (store.render?.isRendering) return;

      if (nudgeSelectedPreviewTransforms(store, -10, 0, e as KeyboardEvent)) {
        return;
      }

      e?.preventDefault();
      const currentFrame = store.timeline.currentFrame;
      const fps = store.timeline.fps || 30;
      // Use 5 frames for most frame rates, 10 for higher frame rates (60fps+)
      const jumpFrames = fps >= 60 ? 10 : 5;
      store.setCurrentFrame(Math.max(0, currentFrame - jumpFrames));
    },
  },
  {
    id: 'navigate-frame-next-fast',
    keys: 'shift+right',
    description: 'Move Playhead Forward (5 Frames)',
    category: 'Navigation',
    scope: 'global',
    handler: (e) => {
      const store = getStore();
      if (store.render?.isRendering) return;

      if (nudgeSelectedPreviewTransforms(store, 10, 0, e as KeyboardEvent)) {
        return;
      }

      e?.preventDefault();
      const currentFrame = store.timeline.currentFrame;
      const fps = store.timeline.fps || 30;
      // Use 5 frames for most frame rates, 10 for higher frame rates (60fps+)
      const jumpFrames = fps >= 60 ? 10 : 5;
      store.setCurrentFrame(
        Math.min(effectiveEndFrame - 1, currentFrame + jumpFrames),
      );
    },
  },
  {
    id: 'navigate-next-edit-point',
    keys: ['down', 'shift+down'],
    description: 'Jump to Next Edit Point',
    category: 'Navigation',
    scope: 'global',
    handler: (e) => {
      const store = getStore();
      if (store.render?.isRendering) return;

      if (
        nudgeSelectedPreviewTransforms(
          store,
          0,
          e?.shiftKey ? 10 : 1,
          e as KeyboardEvent,
        )
      ) {
        return;
      }

      e?.preventDefault();
      const currentFrame = store.timeline.currentFrame;
      const tracks = store.tracks || [];

      // Collect all edit points (track start frames) that are after current frame
      const editPoints = new Set<number>();
      tracks.forEach((track: any) => {
        if (track.startFrame > currentFrame) {
          editPoints.add(track.startFrame);
        }
        // Also consider end frames as edit points
        if (track.endFrame > currentFrame) {
          editPoints.add(track.endFrame);
        }
      });

      // Find the nearest edit point after current frame
      const sortedEditPoints = Array.from(editPoints).sort((a, b) => a - b);
      const nextEditPoint = sortedEditPoints[0];

      if (nextEditPoint !== undefined) {
        store.setCurrentFrame(nextEditPoint);
      }
    },
  },
  {
    id: 'navigate-prev-edit-point',
    keys: ['up', 'shift+up'],
    description: 'Jump to Previous Edit Point',
    category: 'Navigation',
    scope: 'global',
    handler: (e) => {
      const store = getStore();
      if (store.render?.isRendering) return;

      if (
        nudgeSelectedPreviewTransforms(
          store,
          0,
          e?.shiftKey ? -10 : -1,
          e as KeyboardEvent,
        )
      ) {
        return;
      }

      e?.preventDefault();
      const currentFrame = store.timeline.currentFrame;
      const tracks = store.tracks || [];

      // Collect all edit points (track start frames) that are before current frame
      const editPoints = new Set<number>();
      tracks.forEach((track: any) => {
        if (track.startFrame < currentFrame) {
          editPoints.add(track.startFrame);
        }
        // Also consider end frames as edit points
        if (track.endFrame < currentFrame) {
          editPoints.add(track.endFrame);
        }
      });

      // Add frame 0 as a potential edit point
      editPoints.add(0);

      // Find the nearest edit point before current frame
      const sortedEditPoints = Array.from(editPoints).sort((a, b) => b - a);
      const prevEditPoint = sortedEditPoints[0];

      if (prevEditPoint !== undefined) {
        store.setCurrentFrame(prevEditPoint);
      }
    },
  },
  {
    id: 'preview-toggle-fullscreen',
    keys: 'f',
    description: 'Toggle Fullscreen',
    category: 'Preview',
    scope: 'global',
    priority: 'high',
    handler: (e) => {
      e?.preventDefault();
      getStore().toggleFullscreen();
    },
  },
];
