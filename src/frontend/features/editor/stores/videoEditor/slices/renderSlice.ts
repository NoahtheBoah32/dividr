/* eslint-disable @typescript-eslint/no-explicit-any */
import { StateCreator } from 'zustand';
import { RenderMetrics, RenderState } from '../types/render.types';

export interface RenderSlice {
  render: RenderState;
  startRender: (job: {
    outputPath: string;
    format: string;
    quality: string;
  }) => void;
  updateRenderProgress: (
    progress: number,
    status: string,
    currentTime?: string,
    metrics?: Partial<RenderMetrics>,
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

  startRender: (job) =>
    set((state: any) => ({
      render: {
        ...state.render,
        isRendering: true,
        progress: 0,
        status: 'Starting render...',
        currentTime: '00:00:00',
        metrics: {
          elapsedSeconds: 0,
          etaState: 'calculating',
        },
        currentJob: job,
      },
    })),

  updateRenderProgress: (progress, status, currentTime, metrics) =>
    set((state: any) => ({
      render: {
        ...state.render,
        progress,
        status,
        currentTime,
        metrics: metrics
          ? {
              ...state.render.metrics,
              ...metrics,
            }
          : state.render.metrics,
      },
    })),

  finishRender: () =>
    set((state: any) => ({
      render: {
        ...state.render,
        isRendering: false,
        progress: 100,
        status: 'Render complete',
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
        metrics: undefined,
        currentJob: undefined,
      },
    })),
});
