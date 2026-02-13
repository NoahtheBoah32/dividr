/**
 * useExportHandler Hook (Updated with RenderProcessDialog Integration)
 * Handles FFmpeg execution and progress tracking
 */
import {
  FfmpegCallbacks,
  runFfmpegWithProgress,
} from '@/backend/ffmpeg/export/ffmpegRunner';
import { VideoEditJob } from '@/backend/ffmpeg/schema/ffmpegConfig';
import type { RenderEtaState } from '@/frontend/features/editor/stores/videoEditor/types/render.types';
import {
  analyzeProjectForExport,
  LIMITATION_THRESHOLDS,
  resetExportReminderTimer,
  showLongExportReminderToast,
  showPreExportLimitationToast,
} from '@/frontend/utils/mediaLimitations';
import { useCallback, useRef, useState } from 'react';
import {
  useTimelineUtils,
  useVideoEditorStore,
} from '../../editor/stores/videoEditor/index';
import { RenderState } from '../components/renderProcessDialog';

const MIN_ELAPSED_SECONDS_FOR_ETA = 2;
const MIN_PROCESSED_SECONDS_FOR_ETA = 1;
const THROUGHPUT_SMOOTHING_ALPHA = 0.2;
const ETA_SMOOTHING_ALPHA = 0.2;
const ETA_MAX_DELTA_RATIO = 0.35;
const ETA_MIN_DELTA_SECONDS = 4;

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, value));

const parseTimeToSeconds = (value?: string): number | null => {
  if (!value) return null;
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  if (![hours, minutes, seconds, fraction].every(Number.isFinite)) {
    return null;
  }
  if (minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds + fraction;
};

const parseSpeedMultiplier = (value?: string): number | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/x$/, '');
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
};

const resolveTotalDurationSeconds = (
  job: VideoEditJob,
  fallbackFps: number,
): number => {
  const targetFps = job.operations?.targetFrameRate || fallbackFps || 30;
  let maxEndFrame = 0;

  for (const input of job.inputs || []) {
    if (typeof input !== 'object' || input === null) continue;
    const track = input as {
      timelineEndFrame?: number;
      duration?: number;
      startTime?: number;
    };

    if (
      Number.isFinite(track.timelineEndFrame) &&
      (track.timelineEndFrame as number) > maxEndFrame
    ) {
      maxEndFrame = track.timelineEndFrame as number;
    }
  }

  if (maxEndFrame > 0) {
    return maxEndFrame / targetFps;
  }

  let fallbackDuration = 0;
  for (const input of job.inputs || []) {
    if (typeof input !== 'object' || input === null) continue;
    const track = input as { duration?: number; startTime?: number };
    const duration = Number(track.duration) || 0;
    const startTime = Number(track.startTime) || 0;
    fallbackDuration = Math.max(fallbackDuration, startTime + duration);
  }

  return fallbackDuration;
};

const smoothEtaSeconds = (
  previousValue: number | undefined,
  nextRawValue: number,
): number => {
  if (!Number.isFinite(nextRawValue) || nextRawValue < 0) {
    return previousValue ?? 0;
  }

  if (previousValue === undefined || !Number.isFinite(previousValue)) {
    return nextRawValue;
  }

  const blended =
    previousValue * (1 - ETA_SMOOTHING_ALPHA) +
    nextRawValue * ETA_SMOOTHING_ALPHA;
  const maxDelta = Math.max(
    ETA_MIN_DELTA_SECONDS,
    previousValue * ETA_MAX_DELTA_RATIO,
  );

  return Math.max(
    0,
    Math.min(
      previousValue + maxDelta,
      Math.max(previousValue - maxDelta, blended),
    ),
  );
};

export const useExportHandler = () => {
  const tracks = useVideoEditorStore((state) => state.tracks);
  const timelineFps = useVideoEditorStore((state) => state.timeline.fps);
  const startRender = useVideoEditorStore((state) => state.startRender);
  const updateRenderProgress = useVideoEditorStore(
    (state) => state.updateRenderProgress,
  );
  const finishRender = useVideoEditorStore((state) => state.finishRender);
  const cancelRender = useVideoEditorStore((state) => state.cancelRender);
  const prepareForRender = useVideoEditorStore(
    (state) => state.prepareForRender,
  );
  const restoreAfterRender = useVideoEditorStore(
    (state) => state.restoreAfterRender,
  );
  const { getTimelineGaps } = useTimelineUtils();

  // Dialog state management
  const [isRenderDialogOpen, setIsRenderDialogOpen] = useState(false);
  const [renderDialogState, setRenderDialogState] =
    useState<RenderState>('rendering');
  const [renderError, setRenderError] = useState<string | undefined>();
  const [outputFilePath, setOutputFilePath] = useState<string | undefined>();

  // Long-running export reminder timer
  const exportReminderTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clear export reminder timer
  const clearExportReminderTimer = useCallback(() => {
    if (exportReminderTimerRef.current) {
      clearTimeout(exportReminderTimerRef.current);
      exportReminderTimerRef.current = null;
    }
  }, []);

  // Start export reminder timer for long-running exports
  const startExportReminderTimer = useCallback(() => {
    clearExportReminderTimer();
    resetExportReminderTimer();

    exportReminderTimerRef.current = setTimeout(() => {
      showLongExportReminderToast();
    }, LIMITATION_THRESHOLDS.LONG_EXPORT_REMINDER_MS);
  }, [clearExportReminderTimer]);

  const executeExport = useCallback(
    async (job: VideoEditJob): Promise<void> => {
      try {
        // Analyze project and show pre-export limitation toast if applicable
        const projectInfo = analyzeProjectForExport(tracks, timelineFps);
        showPreExportLimitationToast(projectInfo);

        // Start long-running export reminder timer
        startExportReminderTimer();

        prepareForRender();

        // Get timeline gaps
        const gaps = getTimelineGaps();

        // Add gaps to job
        job.gaps = gaps;

        const exportStartTime = Date.now();
        const totalDurationSeconds = resolveTotalDurationSeconds(
          job,
          timelineFps,
        );
        const totalFrames =
          totalDurationSeconds > 0
            ? Math.max(
                1,
                Math.round(
                  totalDurationSeconds *
                    (job.operations?.targetFrameRate || timelineFps || 30),
                ),
              )
            : undefined;

        // Track values locally to avoid stale closure regressions and jittery UI.
        let latestCurrentTime = '00:00:00';
        let latestProgressValue = 0;
        let latestElapsedSeconds = 0;
        let latestProcessedSeconds = 0;
        let latestProcessedFrames = 0;
        let latestSpeedMultiplier: number | undefined;
        let latestEtaState: RenderEtaState = 'calculating';
        let latestEtaSeconds: number | undefined;
        let smoothedThroughput: number | undefined;
        let smoothedEta: number | undefined;

        const updateRenderUi = (statusLabel: string) => {
          updateRenderProgress(
            latestProgressValue,
            statusLabel,
            latestCurrentTime,
            {
              elapsedSeconds: latestElapsedSeconds,
              etaState: latestEtaState,
              etaSeconds:
                latestEtaState === 'ready' ? latestEtaSeconds : undefined,
              processedSeconds:
                latestProcessedSeconds > 0 ? latestProcessedSeconds : undefined,
              totalDurationSeconds:
                totalDurationSeconds > 0 ? totalDurationSeconds : undefined,
              processedFrames:
                latestProcessedFrames > 0 ? latestProcessedFrames : undefined,
              totalFrames,
              speedMultiplier: latestSpeedMultiplier,
            },
          );
        };

        const callbacks: FfmpegCallbacks = {
          onProgress: (progress) => {
            latestElapsedSeconds = Math.max(
              0,
              (Date.now() - exportStartTime) / 1000,
            );
            if (progress.outTime) {
              latestCurrentTime = progress.outTime;
            }

            const parsedOutTimeSeconds =
              typeof progress.outTimeSeconds === 'number' &&
              Number.isFinite(progress.outTimeSeconds)
                ? progress.outTimeSeconds
                : parseTimeToSeconds(progress.outTime);
            if (
              parsedOutTimeSeconds !== null &&
              Number.isFinite(parsedOutTimeSeconds)
            ) {
              latestProcessedSeconds = Math.max(
                latestProcessedSeconds,
                Math.max(0, parsedOutTimeSeconds),
              );
            }

            if (Number.isFinite(progress.frame) && progress.frame > 0) {
              latestProcessedFrames = Math.max(
                latestProcessedFrames,
                Math.floor(progress.frame),
              );
            }

            const parsedSpeedMultiplier =
              typeof progress.speedMultiplier === 'number' &&
              Number.isFinite(progress.speedMultiplier)
                ? progress.speedMultiplier
                : parseSpeedMultiplier(progress.speed);
            if (
              parsedSpeedMultiplier !== null &&
              Number.isFinite(parsedSpeedMultiplier)
            ) {
              latestSpeedMultiplier = parsedSpeedMultiplier;
            }

            const progressCandidates: number[] = [];
            if (
              typeof progress.percentage === 'number' &&
              Number.isFinite(progress.percentage)
            ) {
              progressCandidates.push(progress.percentage);
            }
            if (totalDurationSeconds > 0 && latestProcessedSeconds > 0) {
              progressCandidates.push(
                (latestProcessedSeconds / totalDurationSeconds) * 100,
              );
            }
            if (totalFrames && latestProcessedFrames > 0) {
              progressCandidates.push(
                (latestProcessedFrames / totalFrames) * 100,
              );
            }

            if (progressCandidates.length > 0) {
              latestProgressValue = Math.max(
                latestProgressValue,
                clampPercent(Math.max(...progressCandidates)),
              );
            }

            latestEtaState = 'calculating';
            latestEtaSeconds = undefined;

            if (totalDurationSeconds > 0) {
              const remainingWorkSeconds = Math.max(
                0,
                totalDurationSeconds - latestProcessedSeconds,
              );

              if (remainingWorkSeconds <= 0.1) {
                latestEtaState = 'ready';
                latestEtaSeconds = 0;
                smoothedEta = 0;
              } else if (
                latestElapsedSeconds >= MIN_ELAPSED_SECONDS_FOR_ETA &&
                latestProcessedSeconds >= MIN_PROCESSED_SECONDS_FOR_ETA
              ) {
                const observedThroughput =
                  latestProcessedSeconds / latestElapsedSeconds;
                const throughputCandidates: number[] = [];

                if (
                  Number.isFinite(observedThroughput) &&
                  observedThroughput > 0
                ) {
                  throughputCandidates.push(observedThroughput);
                }
                if (
                  latestSpeedMultiplier !== undefined &&
                  Number.isFinite(latestSpeedMultiplier) &&
                  latestSpeedMultiplier > 0
                ) {
                  throughputCandidates.push(latestSpeedMultiplier);
                }

                if (throughputCandidates.length > 0) {
                  const rawThroughput =
                    throughputCandidates.reduce(
                      (sum, value) => sum + value,
                      0,
                    ) / throughputCandidates.length;
                  smoothedThroughput =
                    smoothedThroughput === undefined
                      ? rawThroughput
                      : smoothedThroughput * (1 - THROUGHPUT_SMOOTHING_ALPHA) +
                        rawThroughput * THROUGHPUT_SMOOTHING_ALPHA;

                  if (
                    Number.isFinite(smoothedThroughput) &&
                    smoothedThroughput > 0
                  ) {
                    const rawEta = remainingWorkSeconds / smoothedThroughput;
                    smoothedEta = smoothEtaSeconds(smoothedEta, rawEta);
                    latestEtaState = 'ready';
                    latestEtaSeconds = smoothedEta;
                  }
                }
              }
            }

            updateRenderUi('Rendering video...');
          },
          onStatus: (status) => {
            updateRenderUi(status);
          },
          onLog: () => {
            // Logging disabled
          },
        };

        // Construct the full output file path (use forward slash for cross-platform compatibility)
        const fullOutputPath = `${job.outputPath}/${job.output}`.replace(
          /\//g,
          '\\',
        );

        // Open dialog and set to rendering state
        setRenderDialogState('rendering');
        setIsRenderDialogOpen(true);
        setRenderError(undefined);
        setOutputFilePath(fullOutputPath);

        startRender({
          outputPath: job.output,
          format: 'mp4',
          quality: 'high',
        });
        updateRenderUi('Preparing render...');

        const result = await runFfmpegWithProgress(job, callbacks);

        // Check if export was cancelled
        if (result.cancelled) {
          clearExportReminderTimer();
          cancelRender();
          setRenderDialogState('cancelled');
          return;
        }

        clearExportReminderTimer();

        latestProgressValue = 100;
        latestElapsedSeconds = Math.max(
          0,
          (Date.now() - exportStartTime) / 1000,
        );
        latestEtaState = 'ready';
        latestEtaSeconds = 0;
        updateRenderUi('Processing complete');

        finishRender();

        // Update dialog to completed state
        setRenderDialogState('completed');
      } catch (error) {
        clearExportReminderTimer();
        cancelRender();

        // Update dialog to failed state with error message
        setRenderDialogState('failed');
        setRenderError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      tracks,
      timelineFps,
      startRender,
      updateRenderProgress,
      finishRender,
      cancelRender,
      prepareForRender,
      getTimelineGaps,
      startExportReminderTimer,
      clearExportReminderTimer,
    ],
  );

  const handleCancelRender = useCallback(async () => {
    try {
      // Clear export reminder timer
      clearExportReminderTimer();

      // Call IPC to kill FFmpeg process

      await window.electronAPI.cancelFfmpegExport();

      // Update UI state
      cancelRender();
      setRenderDialogState('cancelled');
    } catch (error) {
      console.error(
        '[UseExportHandler] Failed to cancel FFmpeg process',
        error,
      );
      // Still update UI even if IPC fails
      cancelRender();
      setRenderDialogState('cancelled');
    }
  }, [cancelRender, clearExportReminderTimer]);

  const handleCloseDialog = useCallback(() => {
    restoreAfterRender();
    setIsRenderDialogOpen(false);
    setRenderDialogState('rendering');
    setRenderError(undefined);
    setOutputFilePath(undefined);
  }, [restoreAfterRender]);

  return {
    executeExport,
    // Dialog state for component integration
    isRenderDialogOpen,
    renderDialogState,
    renderError,
    outputFilePath,
    handleCancelRender,
    handleCloseDialog,
  };
};
