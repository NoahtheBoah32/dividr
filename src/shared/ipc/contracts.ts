import type { FfmpegProgress } from '../../backend/ffmpeg/export/ffmpegRunner';

export type IpcErrorResponse = {
  success: false;
  error: string;
  code?: string;
  details?: unknown;
};

export type IpcSuccessResponse<
  T extends Record<string, unknown> = Record<string, never>,
> = {
  success: true;
} & T;

export type IpcResponse<
  T extends Record<string, unknown> = Record<string, never>,
> = IpcSuccessResponse<T> | IpcErrorResponse;

export type AppExitDecision = 'pending' | 'allow' | 'cancel';

export type AppExitDecisionRequest = {
  requestId?: number;
  decision?: AppExitDecision;
};

export type AppExitDecisionResponse = {
  success: boolean;
};

export type AppExitRequestedEvent = {
  requestId: number;
  trigger: string;
};

export type ProxyProgressEvent = {
  path: string;
  log: string;
  encoder?: string;
};

export interface FfmpegEventHandlers {
  onProgress?: (progress: FfmpegProgress) => void;
  onStatus?: (status: string) => void;
  onLog?: (log: { log: string; type: 'stdout' | 'stderr' }) => void;
  onComplete?: (result: {
    success: boolean;
    result?: unknown;
    error?: string;
  }) => void;
}
