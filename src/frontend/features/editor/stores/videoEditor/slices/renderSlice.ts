/* eslint-disable @typescript-eslint/no-explicit-any */
import { StateCreator } from 'zustand';
import { RenderState } from '../types/render.types';

/**
 * Session export settings, set by the user or EDITH's `exportSettings` op.
 * `preset` names a social bundle (resolution class/fps/codec/crf); the
 * explicit fields override the preset. All optional — absent = pipeline
 * defaults (timeline fps, libx264, CRF 28).
 */
export interface ExportSettingsState {
  preset?: string | null;
  videoCodec?: 'h264' | 'hevc' | null;
  crf?: number | null;
  fps?: number | null;
}

export interface RenderSlice {
  render: RenderState;
  exportSettings: ExportSettingsState;
  /** Merge a patch into export settings; pass null to reset everything */
  setExportSettings: (patch: Partial<ExportSettingsState> | null) => void;
  startRender: (job: {
    outputPath: string;
    format: string;
    quality: string;
  }) => void;
  updateRenderProgress: (
    progress: number,
    status: string,
    currentTime?: string,
  ) => void;
  finishRender: () => void;
  cancelRender: () => void;
}

export const createRenderSlice: StateCreator<
  RenderSlice,
  [],
  [],
  RenderSlice
> = (set) => ({
  render: {
    isRendering: false,
    progress: 0,
    status: 'ready',
    currentTime: undefined,
    currentJob: undefined,
  },

  exportSettings: {},

  setExportSettings: (patch) =>
    set((state: any) => ({
      exportSettings: patch === null ? {} : { ...state.exportSettings, ...patch },
    })),

  startRender: (job) =>
    set((state: any) => ({
      render: {
        ...state.render,
        isRendering: true,
        progress: 0,
        status: 'Starting render...',
        currentJob: job,
      },
    })),

  updateRenderProgress: (progress, status, currentTime) =>
    set((state: any) => ({
      render: { ...state.render, progress, status, currentTime },
    })),

  finishRender: () =>
    set((state: any) => ({
      render: {
        ...state.render,
        isRendering: false,
        progress: 100,
        status: 'Render complete',
        currentTime: undefined,
        currentJob: undefined,
      },
    })),

  cancelRender: () =>
    set((state: any) => ({
      render: {
        ...state.render,
        isRendering: false,
        progress: 0,
        status: 'Render cancelled',
        currentTime: undefined,
        currentJob: undefined,
      },
    })),
});
