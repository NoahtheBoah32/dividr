export type RenderEtaState = 'calculating' | 'ready';

export interface RenderMetrics {
  elapsedSeconds: number;
  etaSeconds?: number;
  etaState: RenderEtaState;
  processedSeconds?: number;
  totalDurationSeconds?: number;
  processedFrames?: number;
  totalFrames?: number;
  speedMultiplier?: number;
}

export interface RenderState {
  isRendering: boolean;
  progress: number;
  status: string;
  currentTime?: string; // Current render time in HH:MM:SS.FF format from FFmpeg outTime
  metrics?: RenderMetrics;
  currentJob?: {
    outputPath: string;
    format: string;
    quality: string;
  };
}
