/* eslint-disable @typescript-eslint/no-explicit-any */
import { StateCreator } from 'zustand';
import { calculateVideoFitTransform } from '../../../preview/utils/scalingUtils';
import { PreviewState } from '../types';
import { DEFAULT_PREVIEW_CONFIG } from '../utils/constants';

export interface PreviewSlice {
  preview: PreviewState;
  setCanvasSize: (
    width: number,
    height: number,
    storeAsOriginal?: boolean,
  ) => void;
  resetCanvasSize: () => void;
  setPreviewScale: (scale: number) => void;
  setPreviewPan: (panX: number, panY: number) => void;
  resetPreviewPan: () => void;
  setPreviewInteractionMode: (mode: 'select' | 'pan' | 'text-edit') => void;
  toggleGrid: () => void;
  toggleSafeZones: () => void;
  setBackgroundColor: (color: string) => void;
  toggleFullscreen: () => void;
  setFullscreen: (isFullscreen: boolean) => void;

  // State management helpers
  markUnsavedChanges?: () => void;
}

export const createPreviewSlice: StateCreator<
  PreviewSlice,
  [],
  [],
  PreviewSlice
> = (set, get) => ({
  preview: {
    ...DEFAULT_PREVIEW_CONFIG,
    showGrid: false,
    showSafeZones: false,
    isFullscreen: false,
  },

  setCanvasSize: (width, height, storeAsOriginal = false) => {
    set((state: any) => {
      const updates: Partial<PreviewState> = {
        canvasWidth: width,
        canvasHeight: height,
      };

      // Store original dimensions if requested (typically on first video import)
      // or if original dimensions haven't been set yet
      if (
        storeAsOriginal ||
        (!state.preview.originalCanvasWidth &&
          !state.preview.originalCanvasHeight)
      ) {
        updates.originalCanvasWidth = width;
        updates.originalCanvasHeight = height;
      }

      // Keep media fit in sync in the same state commit to avoid one-frame stretch flicker.
      const nextTracks = Array.isArray(state.tracks)
        ? state.tracks.map((track: any) => {
            if (track.type !== 'video' && track.type !== 'image') {
              return track;
            }

            const originalWidth =
              track.width ||
              track.textTransform?.width ||
              state.preview.canvasWidth;
            const originalHeight =
              track.height ||
              track.textTransform?.height ||
              state.preview.canvasHeight;

            if (!originalWidth || !originalHeight) {
              return track;
            }

            const currentTransform = track.textTransform || {
              x: 0,
              y: 0,
              scale: 1,
              rotation: 0,
              width: originalWidth,
              height: originalHeight,
            };

            const newTransform = calculateVideoFitTransform(
              originalWidth,
              originalHeight,
              width,
              height,
              currentTransform,
            );

            const widthChanged =
              Math.abs(
                (currentTransform.width || originalWidth) - newTransform.width,
              ) > 0.5;
            const heightChanged =
              Math.abs(
                (currentTransform.height || originalHeight) -
                  newTransform.height,
              ) > 0.5;
            const scaleChanged =
              Math.abs((currentTransform.scale || 1) - newTransform.scale) >
              0.001;

            if (!widthChanged && !heightChanged && !scaleChanged) {
              return track;
            }

            return {
              ...track,
              textTransform: {
                ...currentTransform,
                x: newTransform.x,
                y: newTransform.y,
                scale: newTransform.scale,
                rotation: newTransform.rotation,
                width: newTransform.width,
                height: newTransform.height,
              },
            };
          })
        : state.tracks;

      return {
        preview: { ...state.preview, ...updates },
        tracks: nextTracks,
      };
    });
    const state = get() as any;
    state.markUnsavedChanges?.();
  },

  resetCanvasSize: () => {
    const state = get() as any;
    const { originalCanvasWidth, originalCanvasHeight } = state.preview;

    // Only reset if we have original dimensions stored
    if (originalCanvasWidth && originalCanvasHeight) {
      state.setCanvasSize(originalCanvasWidth, originalCanvasHeight);
    }
  },

  setPreviewScale: (scale) =>
    set((state: any) => ({
      preview: {
        ...state.preview,
        previewScale: Math.max(0.1, Math.min(scale, 8)),
      },
    })),

  setPreviewPan: (panX, panY) =>
    set((state: any) => ({
      preview: {
        ...state.preview,
        panX,
        panY,
      },
    })),

  resetPreviewPan: () =>
    set((state: any) => ({
      preview: {
        ...state.preview,
        panX: 0,
        panY: 0,
      },
    })),

  setPreviewInteractionMode: (mode) =>
    set((state: any) => ({
      preview: {
        ...state.preview,
        interactionMode: mode,
      },
    })),

  toggleGrid: () =>
    set((state: any) => ({
      preview: { ...state.preview, showGrid: !state.preview.showGrid },
    })),

  toggleSafeZones: () =>
    set((state: any) => ({
      preview: {
        ...state.preview,
        showSafeZones: !state.preview.showSafeZones,
      },
    })),

  setBackgroundColor: (color) =>
    set((state: any) => ({
      preview: { ...state.preview, backgroundColor: color },
    })),

  toggleFullscreen: () =>
    set((state: any) => ({
      preview: { ...state.preview, isFullscreen: !state.preview.isFullscreen },
    })),

  setFullscreen: (isFullscreen) =>
    set((state: any) => ({
      preview: { ...state.preview, isFullscreen },
    })),
});
