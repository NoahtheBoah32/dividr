/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'child_process';
import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildArnnDenCommand,
  getDefaultModelPath,
} from '../../backend/ffmpeg/alternativeDenoise';
import { buildFfmpegCommand } from '../../backend/ffmpeg/export/commandBuilder';
import {
  runFfmpeg,
  runFfmpegWithProgress,
} from '../../backend/ffmpeg/export/ffmpegRunner';
import { VideoEditJob } from '../../backend/ffmpeg/schema/ffmpegConfig';
import {
  buildProxyFFmpegArgs,
  buildVaapiProxyFFmpegArgs,
  detectHardwareCapabilities,
  getProxyEncoderConfig,
  getSoftwareEncoderConfig,
  type ProxyEncoderConfig,
} from '../../backend/hardware/hardwareCapabilitiesService';
import { backgroundTaskQueue } from '../../backend/io';
import { fileIOManager } from '../../backend/io/FileIOManager';
import type {
  MediaToolsProgress,
  NoiseReductionResult,
  WhisperResult,
} from '../../backend/media-tools/mediaToolsRunner';
import {
  cancelCurrentOperation,
  cancelTranscription,
  getMediaToolsStatus,
  getPythonWhisperStatus,
  reduceNoise,
  transcribeAudio,
} from '../../backend/media-tools/mediaToolsRunner';
import { IPC_CHANNELS } from '../../shared/ipc/channels';
import {
  MEDIA_SERVER_PORT,
  ensureMediaServer,
  ensurePythonInitialized,
  ffmpegPath,
  ffprobePath,
  getFfmpegAudioDenoiseFilter,
  getMediaCacheDir,
  killCurrentFfmpegProcess,
  mainWindow,
  resolveMediaPath,
  runQueuedFfmpeg,
} from '../mainProcessApp';

type WhisperProgress = MediaToolsProgress;

interface SpriteSheetJob {
  id: string;
  videoPath: string;
  outputDir: string;
  commands: string[][];
  progress: {
    current: number;
    total: number;
    stage: string;
  };
  startTime: number;
}

const activeSpriteSheetJobs = new Map<string, SpriteSheetJob>();

export function registerFfmpegIpc(): void {
  ipcMain.handle(IPC_CHANNELS.RUN_FFMPEG, async (event, job: VideoEditJob) => {
    try {
      const result = await runFfmpeg(job);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Enhanced IPC Handler for FFmpeg operations with real-time progress
  ipcMain.handle(
    IPC_CHANNELS.RUN_FFMPEG_WITH_PROGRESS,
    async (event, job: VideoEditJob) => {
      try {
        const result = await runFfmpegWithProgress(job, {
          onProgress: (progress) => {
            // Send progress updates to renderer process
            event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_PROGRESS, progress);
          },
          onStatus: (status) => {
            // Send status updates to renderer process
            event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_STATUS, status);
          },
          onLog: (log, type) => {
            // Send log updates to renderer process
            event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_LOG, { log, type });
          },
        });

        // Send completion event
        event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_COMPLETE, {
          success: true,
          result,
        });
        return { success: true, result };
      } catch (error) {
        // Send error event
        event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_COMPLETE, {
          success: false,
          error: error.message,
        });
        return { success: false, error: error.message };
      }
    },
  );

  // IPC Handler for audio extraction from video files
  // Uses PRIORITY 1 (highest) in FFmpeg queue - audio extraction should complete before sprite sheets
  ipcMain.handle(
    IPC_CHANNELS.EXTRACT_AUDIO_FROM_VIDEO,
    async (event, videoPath: string, outputDir?: string) => {
      console.log('[Main] MAIN PROCESS: extractAudioFromVideo handler called!');
      console.log('[Main] MAIN PROCESS: Video path', videoPath);

      if (!ffmpegPath) {
        return {
          success: false,
          error:
            'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
        };
      }

      // Use priority queue with HIGHEST priority (1) for audio extraction
      // This ensures audio extracts before sprite sheets to prevent waveform delays
      return (async () => {
        // Create a unique output directory for extracted audio files
        const audioOutputDir =
          outputDir || path.join(os.tmpdir(), 'dividr-audio-extracts');

        // Use fileIOManager for directory creation with EMFILE protection
        await fileIOManager.mkdir(audioOutputDir, 'normal');
        console.log('[Main] Audio extraction directory ready', audioOutputDir);

        // Generate unique filename for extracted audio
        const videoBaseName = path.basename(videoPath, path.extname(videoPath));
        const timestamp = Date.now();
        const audioFileName = `${videoBaseName}_${timestamp}_extracted.wav`;
        const audioOutputPath = path.join(audioOutputDir, audioFileName);

        console.log('[Main] Extracting audio to', audioOutputPath);

        // FFmpeg command to extract audio with high quality
        const args = [
          '-i',
          videoPath, // Input video file
          '-vn', // No video (audio only)
          '-acodec',
          'pcm_s16le', // Uncompressed PCM audio codec for quality
          '-ar',
          '44100', // Sample rate: 44.1kHz (CD quality)
          '-ac',
          '2', // Stereo (2 channels)
          '-y', // Overwrite output file if exists
          audioOutputPath, // Output audio file
        ];

        console.log('[Main] AUDIO EXTRACTION FFMPEG COMMAND');
        console.log('[Main] Log', ['ffmpeg', ...args].join(' '));

        const ffmpegResult = await runQueuedFfmpeg(args, {
          priority: 1,
          timeoutMs: 5 * 60 * 1000, // 5 minutes
          onStdout: (text) =>
            console.log(`[AudioExtractStdout] Log${text.trim()}`),
          onStderr: (text) =>
            console.log(`[AudioExtractStderr] Log${text.trim()}`),
        });

        if (ffmpegResult.timedOut) {
          return {
            success: false,
            error: 'Audio extraction timed out',
          };
        }

        if (ffmpegResult.code === 0) {
          try {
            // Verify that the audio file was created and has content
            // Use async stat with retry for EMFILE protection
            let stats: fs.Stats | null = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                stats = fs.statSync(audioOutputPath);
                break;
              } catch (statErr) {
                if (isEMFILEError(statErr) && attempt < 3) {
                  console.warn(
                    `[Main] EMFILE during audio file verification, retry${attempt}/3`,
                  );
                  await new Promise((r) => setTimeout(r, 500 * attempt));
                } else {
                  throw statErr;
                }
              }
            }

            if (stats && stats.size > 0) {
              // Create preview URL for the extracted audio
              // Use the same logic as the create-preview-url handler
              const previewUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodeURIComponent(audioOutputPath)}`;

              console.log('[Main] Audio extraction successful!');
              console.log('[Main] Audio file path', audioOutputPath);
              console.log('[Main] Audio file size', stats.size, 'bytes');

              return {
                success: true,
                audioPath: audioOutputPath,
                previewUrl,
                size: stats.size,
                message: 'Audio extracted successfully',
              };
            }

            console.error('[Main] Audio file was created but is empty');
            return {
              success: false,
              error: 'Audio extraction failed: output file is empty',
            };
          } catch (statError) {
            const errorMessage =
              statError instanceof Error ? statError.message : 'Unknown error';
            console.error(
              '[Main] Failed to verify extracted audio file',
              errorMessage,
            );

            // Provide helpful EMFILE message
            if (isEMFILEError(statError)) {
              return {
                success: false,
                error:
                  'System file limit reached during audio verification. Please try again.',
              };
            }

            return {
              success: false,
              error: `Audio extraction failed: ${errorMessage}`,
            };
          }
        }

        console.error(
          '[Main] Audio extraction failed with exit code',
          ffmpegResult.code,
        );
        return {
          success: false,
          error: `Audio extraction failed with exit code ${ffmpegResult.code}: ${ffmpegResult.stderr}`,
        };
      })();
    },
  );

  // IPC Handler for custom FFmpeg commands (specifically for thumbnail extraction)
  // Uses PRIORITY 3 (lowest) in FFmpeg queue - thumbnails should yield to audio extraction
  ipcMain.handle(
    IPC_CHANNELS.RUN_CUSTOM_FFMPEG,
    async (event, args: string[], outputDir: string) => {
      console.log('[Main] MAIN PROCESS: runCustomFFmpeg handler called!');
      console.log('[Main] MAIN PROCESS: FFmpeg args', args);
      console.log('[Main] MAIN PROCESS: Output directory', outputDir);

      if (!ffmpegPath) {
        return {
          success: false,
          error:
            'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
        };
      }

      // Ensure output directory exists using fileIOManager for EMFILE protection
      const hasOutputDir = !!outputDir && outputDir.trim().length > 0;
      const absoluteOutputDir = hasOutputDir
        ? path.isAbsolute(outputDir)
          ? outputDir
          : path.resolve(outputDir)
        : '';

      try {
        if (hasOutputDir) {
          await fileIOManager.mkdir(absoluteOutputDir, 'high');
          console.log('[Main] Output directory ready', absoluteOutputDir);
        }
      } catch (dirError) {
        const errorMessage =
          dirError instanceof Error ? dirError.message : 'Unknown error';
        console.error('[Main] Failed to create output directory', errorMessage);

        if (isEMFILEError(dirError)) {
          return {
            success: false,
            error: 'System file limit reached. Please wait and try again.',
          };
        }

        return {
          success: false,
          error: `Failed to create output directory: ${errorMessage}`,
        };
      }

      // Update output path in args to use absolute path
      const finalArgs = hasOutputDir
        ? args.map((arg) => {
            if (arg.includes(outputDir) && !path.isAbsolute(arg)) {
              return arg.replace(outputDir, absoluteOutputDir);
            }
            return arg;
          })
        : args;

      console.log('[Main] COMPLETE CUSTOM FFMPEG COMMAND');
      console.log('[Main] Log', ['ffmpeg', ...finalArgs].join(' '));

      // Use priority queue with LOWEST priority (3) for thumbnail extraction
      const ffmpegResult = await runQueuedFfmpeg(finalArgs, {
        priority: 3,
        timeoutMs: 10 * 60 * 1000, // 10 minutes
        onStdout: (text) => console.log(`[FFmpegStdout] Log${text.trim()}`),
        onStderr: (text) => console.log(`[FFmpegStderr] Log${text.trim()}`),
      });

      if (ffmpegResult.timedOut) {
        return {
          success: false,
          error: 'FFmpeg process timed out',
        };
      }

      console.log(`[Main] FFmpeg process exited with code${ffmpegResult.code}`);

      if (ffmpegResult.code === 0) {
        if (!hasOutputDir) {
          return { success: true, output: [] };
        }
        // List generated files
        try {
          const outputFiles = fs
            .readdirSync(absoluteOutputDir)
            .filter(
              (file) => file.startsWith('thumb_') && file.endsWith('.jpg'),
            )
            .sort();

          console.log(
            `[Main] Generated${outputFiles.length} thumbnail files:`,
            outputFiles,
          );

          return {
            success: true,
            output: outputFiles,
          };
        } catch (listError) {
          console.error('[Main] Error listing output files', listError);
          return {
            success: false,
            error: `FFmpeg succeeded but failed to list output files: ${listError.message}`,
          };
        }
      }

      console.error(`[Main] FFmpeg failed with exit code${ffmpegResult.code}`);
      return {
        success: false,
        error: `FFmpeg process failed with exit code ${ffmpegResult.code}. stderr: ${ffmpegResult.stderr}`,
      };
    },
  );

  // IPC Handler for background sprite sheet generation
  ipcMain.handle(
    IPC_CHANNELS.GENERATE_SPRITE_SHEET_BACKGROUND,
    async (
      event,
      options: {
        jobId: string;
        videoPath: string;
        outputDir: string;
        commands: string[][];
      },
    ) => {
      const { jobId, videoPath, outputDir, commands } = options;

      console.log('[Main] Starting background sprite sheet generation', jobId);
      console.log('[Main] Video', videoPath);
      console.log('[Main] Output', outputDir);
      console.log('[Main] Commands', commands.length);

      if (!ffmpegPath) {
        return {
          success: false,
          error:
            'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
        };
      }

      // Check if job already exists
      if (activeSpriteSheetJobs.has(jobId)) {
        return {
          success: false,
          error: 'Job already in progress',
        };
      }

      // Create job entry
      const job: SpriteSheetJob = {
        id: jobId,
        videoPath,
        outputDir,
        commands,
        progress: {
          current: 0,
          total: commands.length,
          stage: 'Starting...',
        },
        startTime: Date.now(),
      };

      activeSpriteSheetJobs.set(jobId, job);

      // Process commands sequentially in background
      processSpriteSheetsInBackground(jobId, job);

      return {
        success: true,
        jobId,
        message: 'Sprite sheet generation started in background',
      };
    },
  );

  // IPC Handler to get sprite sheet job progress
  ipcMain.handle(
    IPC_CHANNELS.GET_SPRITE_SHEET_PROGRESS,
    async (event, jobId: string) => {
      const job = activeSpriteSheetJobs.get(jobId);
      if (!job) {
        return {
          success: false,
          error: 'Job not found',
        };
      }

      return {
        success: true,
        progress: job.progress,
        elapsedTime: Date.now() - job.startTime,
      };
    },
  );

  // IPC Handler to cancel sprite sheet generation
  ipcMain.handle(
    IPC_CHANNELS.CANCEL_SPRITE_SHEET_JOB,
    async (event, jobId: string) => {
      const job = activeSpriteSheetJobs.get(jobId);
      if (!job) {
        return {
          success: false,
          error: 'Job not found',
        };
      }

      activeSpriteSheetJobs.delete(jobId);

      console.log('[Main] Cancelled sprite sheet job', jobId);
      return {
        success: true,
        message: 'Job cancelled',
      };
    },
  );

  // Background sprite sheet processing function
  async function processSpriteSheetsInBackground(
    jobId: string,
    job: SpriteSheetJob,
  ) {
    try {
      // Ensure output directory exists using fileIOManager for EMFILE protection
      const absoluteOutputDir = path.isAbsolute(job.outputDir)
        ? job.outputDir
        : path.resolve(job.outputDir);

      await fileIOManager.mkdir(absoluteOutputDir, 'normal');
      console.log(
        '[Main] Sprite sheet output directory ready',
        absoluteOutputDir,
      );

      // Process each command sequentially
      for (let i = 0; i < job.commands.length; i++) {
        const currentJob = activeSpriteSheetJobs.get(jobId);
        if (!currentJob) {
          console.log('[Main] Job cancelled during processing', jobId);
          return;
        }

        const command = job.commands[i];
        const adjustedCommand = command.map((arg) => {
          if (arg.includes(job.outputDir) && !path.isAbsolute(arg)) {
            return arg.replace(job.outputDir, absoluteOutputDir);
          }
          return arg;
        });

        // Update progress
        currentJob.progress = {
          current: i,
          total: job.commands.length,
          stage: `Generating sprite sheet ${i + 1}/${job.commands.length}`,
        };

        console.log(
          `[Main] Processing sprite sheet${i + 1}/${job.commands.length} for job ${jobId}`,
        );
        console.log(
          '[Main] FFmpeg command',
          ['ffmpeg', ...adjustedCommand].join(' '),
        );

        // Execute FFmpeg command with improved error handling and timeout
        // Uses PRIORITY 3 (lowest) in FFmpeg queue - sprite sheets should yield to audio extraction
        // Set adaptive timeout based on video complexity
        const timeoutMs = Math.min(300000, 60000 + i * 60000); // Max 5 minutes, min 1 minute + 1 minute per sheet
        const ffmpegResult = await runQueuedFfmpeg(adjustedCommand, {
          priority: 3,
          timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const result: { success: boolean; error?: string } = {
          success: false,
        };

        if (ffmpegResult.timedOut) {
          result.success = false;
          result.error = `FFmpeg process timed out after ${timeoutMs / 1000} seconds`;
        } else if (ffmpegResult.code === 0) {
          console.log(`[Main] Sprite sheet${i + 1} generated successfully`);

          // Progressive loading: Notify renderer that this sheet is ready
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.EVENT_SPRITE_SHEET_SHEET_READY,
              {
                jobId,
                sheetIndex: i,
                totalSheets: job.commands.length,
                sheetPath: path.join(
                  absoluteOutputDir,
                  `sprite_${i.toString().padStart(3, '0')}.jpg`,
                ),
              },
            );
          }

          result.success = true;
        } else {
          console.error(
            `[Main] Sprite sheet${i + 1} failed with exit code: ${ffmpegResult.code}`,
          );
          // Try to extract meaningful error from stderr
          const errorMatch =
            ffmpegResult.stderr.match(/Error: (.+)/i) ||
            ffmpegResult.stderr.match(/\[error\] (.+)/i);
          const meaningfulError = errorMatch
            ? errorMatch[1]
            : `Process failed with code ${ffmpegResult.code}`;
          result.success = false;
          result.error = `FFmpeg: ${meaningfulError}`;
        }

        if (!result.success) {
          console.error(
            `[Main] Failed to generate sprite sheet${i + 1}/${job.commands.length}:`,
            result.error,
          );

          // Update job with error
          currentJob.progress.stage = `Failed at sheet ${i + 1}: ${result.error}`;

          // Notify renderer about error with more context
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_ERROR,
              {
                jobId,
                error: `Sheet ${i + 1}/${job.commands.length}: ${result.error}`,
                sheetIndex: i,
                totalSheets: job.commands.length,
              },
            );
          }

          activeSpriteSheetJobs.delete(jobId);
          return;
        }

        console.log(
          `[Main] Successfully generated sprite sheet${i + 1}/${job.commands.length}`,
        );
      }

      // Job completed successfully
      const finalJob = activeSpriteSheetJobs.get(jobId);
      if (finalJob) {
        finalJob.progress = {
          current: job.commands.length,
          total: job.commands.length,
          stage: 'Completed',
        };

        // List generated files with EMFILE retry
        try {
          let outputFiles: string[] = [];

          // Retry logic for EMFILE protection
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              outputFiles = fs
                .readdirSync(absoluteOutputDir)
                .filter(
                  (file: string) =>
                    file.startsWith('sprite_') && file.endsWith('.jpg'),
                )
                .sort();
              break;
            } catch (err) {
              if (isEMFILEError(err) && attempt < 3) {
                console.warn(
                  `[Main] EMFILE listing sprite sheet files, retry${attempt}/3`,
                );
                await new Promise((r) => setTimeout(r, 500 * attempt));
              } else {
                throw err;
              }
            }
          }

          console.log(
            `[Main] Generated${outputFiles.length} sprite sheet files for job ${jobId}`,
          );

          // Notify renderer about completion
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_COMPLETED,
              {
                jobId,
                outputFiles,
                outputDir: absoluteOutputDir,
              },
            );
          }
        } catch (listError) {
          const errorMessage =
            listError instanceof Error ? listError.message : 'Unknown error';
          console.error(
            '[Main] Error listing sprite sheet output files',
            errorMessage,
          );
        }

        activeSpriteSheetJobs.delete(jobId);
      }
    } catch (error) {
      console.error('[Main] Background sprite sheet processing error', error);

      // Notify renderer about error
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.EVENT_SPRITE_SHEET_JOB_ERROR, {
          jobId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      activeSpriteSheetJobs.delete(jobId);
    }
  }

  // Helper function to check for EMFILE errors
  function isEMFILEError(error: unknown): boolean {
    if (error instanceof Error) {
      const nodeError = error as NodeJS.ErrnoException;
      return (
        nodeError.code === 'EMFILE' ||
        nodeError.code === 'ENFILE' ||
        error.message.includes('too many open files')
      );
    }
    return false;
  }

  // Helper function to write file with EMFILE retry
  async function writeFileWithRetry(
    filePath: string,
    data: Buffer,
    maxRetries = 3,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fileIOManager.writeFile(filePath, data, {
          priority: 'high',
          createDir: true,
        });
        return;
      } catch (error) {
        lastError = error as Error;
        if (isEMFILEError(error) && attempt < maxRetries) {
          console.warn(
            `[Main] EMFILE error writing${filePath}, retry ${attempt}/${maxRetries}`,
          );
          // Exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * Math.pow(2, attempt - 1)),
          );
        } else {
          throw error;
        }
      }
    }

    throw lastError || new Error('Write failed after retries');
  }

  // IPC Handler for processing dropped files by writing them to temp location
  // Uses controlled concurrency to prevent EMFILE errors
  ipcMain.handle(
    IPC_CHANNELS.PROCESS_DROPPED_FILES,
    async (
      event,
      fileBuffers: Array<{
        name: string;
        type: string;
        size: number;
        buffer: ArrayBuffer;
      }>,
    ) => {
      try {
        console.log(
          `[Main] Processing${fileBuffers.length} dropped files in main process (controlled concurrency)`,
        );

        const tempDir = path.join(os.tmpdir(), 'dividr-uploads');

        // Ensure temp directory exists using the file IO manager
        await fileIOManager.mkdir(tempDir, 'high');

        const processedFiles: Array<{
          name: string;
          originalName: string;
          type: 'video' | 'audio' | 'image';
          size: number;
          extension: string;
          path: string;
          hasPath: boolean;
          isTemporary: boolean;
        }> = [];

        const errors: string[] = [];

        // Process files in batches to prevent EMFILE
        const BATCH_SIZE = 3;
        const totalFiles = fileBuffers.length;

        for (
          let batchStart = 0;
          batchStart < totalFiles;
          batchStart += BATCH_SIZE
        ) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, totalFiles);
          const batch = fileBuffers.slice(batchStart, batchEnd);

          console.log(
            `[Main] Processing batch${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(totalFiles / BATCH_SIZE)} (files ${batchStart + 1}-${batchEnd} of ${totalFiles})`,
          );

          // Process batch in parallel (within concurrency limits)
          const batchPromises = batch.map(async (fileData, batchIndex) => {
            const globalIndex = batchStart + batchIndex;

            try {
              // Create a unique filename to avoid conflicts
              const timestamp = Date.now();
              const random = Math.random().toString(36).substring(2, 8);
              const ext = path.extname(fileData.name);
              const baseName = path.basename(fileData.name, ext);
              const uniqueFileName = `${baseName}_${timestamp}_${random}${ext}`;
              const tempFilePath = path.join(tempDir, uniqueFileName);

              // Write the file buffer using controlled I/O manager
              const buffer = Buffer.from(fileData.buffer);
              await writeFileWithRetry(tempFilePath, buffer);

              // Determine file type based on extension
              const extension = ext.toLowerCase().slice(1);
              let type: 'video' | 'audio' | 'image' = 'video';
              if (
                ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(extension)
              ) {
                type = 'audio';
              } else if (
                ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp'].includes(
                  extension,
                )
              ) {
                type = 'image';
              }

              console.log(
                `[Main] [${globalIndex + 1}/${totalFiles}] Wrote: ${fileData.name} -> ${tempFilePath}`,
              );

              return {
                success: true as const,
                file: {
                  name: fileData.name,
                  originalName: fileData.name,
                  type,
                  size: fileData.size,
                  extension,
                  path: tempFilePath,
                  hasPath: true,
                  isTemporary: true,
                },
              };
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
              console.error(
                `[Main] [${globalIndex + 1}/${totalFiles}] Failed to write: ${fileData.name}:`,
                errorMessage,
              );

              return {
                success: false as const,
                error: `Failed to process ${fileData.name}: ${errorMessage}`,
              };
            }
          });

          // Wait for batch to complete
          const batchResults = await Promise.all(batchPromises);

          // Collect results
          for (const result of batchResults) {
            if (result.success) {
              processedFiles.push(result.file);
            } else {
              errors.push(result.error);
            }
          }

          // Small delay between batches to allow system to recover
          if (batchEnd < totalFiles) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }

        // Log file I/O stats
        const stats = fileIOManager.getStats();
        console.log(
          `[Main] File I/O Stats - Completed${stats.completedOperations}, Failed: ${stats.failedOperations}, EMFILE errors: ${stats.emfileErrors}`,
        );

        if (processedFiles.length === 0 && errors.length > 0) {
          return {
            success: false,
            error: errors.join('; '),
            files: [],
          };
        }

        return {
          success: true,
          files: processedFiles,
          errors: errors.length > 0 ? errors : undefined,
          stats: {
            total: totalFiles,
            processed: processedFiles.length,
            failed: errors.length,
          },
        };
      } catch (error) {
        console.error('[Main] Failed to process dropped files', error);
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    },
  );

  // IPC Handler for cleaning up temporary files with controlled concurrency
  ipcMain.handle(
    IPC_CHANNELS.CLEANUP_TEMP_FILES,
    async (event, filePaths: string[]) => {
      try {
        let cleanedCount = 0;
        const errors: string[] = [];

        // Process deletions in batches to avoid EMFILE
        const BATCH_SIZE = 5;

        for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
          const batch = filePaths.slice(i, i + BATCH_SIZE);

          const batchPromises = batch.map(async (filePath) => {
            try {
              if (
                fileIOManager.exists(filePath) &&
                filePath.includes('dividr-uploads')
              ) {
                await fileIOManager.deleteFile(filePath, 'low');
                console.log(`[Main] Cleaned up temporary file${filePath}`);
                return true;
              }
              return false;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';
              console.warn(
                `[Main] Failed to cleanup file${filePath}:`,
                errorMessage,
              );
              errors.push(`${path.basename(filePath)}: ${errorMessage}`);
              return false;
            }
          });

          const results = await Promise.all(batchPromises);
          cleanedCount += results.filter(Boolean).length;
        }

        return {
          success: true,
          cleanedCount,
          errors: errors.length > 0 ? errors : undefined,
        };
      } catch (error) {
        console.error('[Main] Failed to cleanup temporary files', error);
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
      }
    },
  );

  // IPC Handler for reading file content with EMFILE protection
  ipcMain.handle(IPC_CHANNELS.READ_FILE, async (event, filePath: string) => {
    try {
      console.log(`[Main] Reading file content from${filePath}`);

      if (!fileIOManager.exists(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Read file content as UTF-8 text using controlled I/O manager
      const content = await fileIOManager.readFile(filePath, {
        encoding: 'utf-8',
        priority: 'normal',
      });
      console.log(
        `[Main] Successfully read file, content length${content.length}`,
      );

      return content;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Main] Failed to read file${filePath}:`, errorMessage);

      // Provide helpful error message for EMFILE
      if (isEMFILEError(error)) {
        throw new Error(
          `System file limit reached while reading ${path.basename(filePath)}. Please wait and try again.`,
        );
      }

      throw error;
    }
  });

  // IPC Handler for reading file as ArrayBuffer (for validation) with EMFILE protection
  ipcMain.handle(
    IPC_CHANNELS.READ_FILE_AS_BUFFER,
    async (event, filePath: string) => {
      try {
        console.log(`[Main] Reading file as buffer from${filePath}`);

        if (!fileIOManager.exists(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        // Read file as Buffer using controlled I/O manager
        const buffer = await fileIOManager.readFileAsBuffer(filePath, 'normal');
        console.log(
          `[Main] Successfully read file buffer, size${buffer.length} bytes`,
        );

        // Convert Node Buffer to ArrayBuffer for transfer to renderer
        return buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        console.error(
          `[Main] Failed to read file as buffer${filePath}:`,
          errorMessage,
        );

        // Provide helpful error message for EMFILE
        if (isEMFILEError(error)) {
          throw new Error(
            `System file limit reached while reading ${path.basename(filePath)}. Please wait and try again.`,
          );
        }

        throw error;
      }
    },
  );

  // IPC Handler for getting file I/O and background task queue status
  ipcMain.handle(IPC_CHANNELS.GET_IO_STATUS, async () => {
    const fileIOStats = fileIOManager.getStats();
    const taskQueueStats = backgroundTaskQueue.getStats();

    return {
      fileIO: {
        activeReads: fileIOStats.activeReads,
        activeWrites: fileIOStats.activeWrites,
        queuedReads: fileIOStats.queuedReads,
        queuedWrites: fileIOStats.queuedWrites,
        completedOperations: fileIOStats.completedOperations,
        failedOperations: fileIOStats.failedOperations,
        emfileErrors: fileIOStats.emfileErrors,
        isUnderHeavyLoad: fileIOManager.isUnderHeavyLoad(),
      },
      taskQueue: {
        pending: taskQueueStats.pending,
        running: taskQueueStats.running,
        completed: taskQueueStats.completed,
        failed: taskQueueStats.failed,
        cancelled: taskQueueStats.cancelled,
        byType: taskQueueStats.byType,
        isIdle: backgroundTaskQueue.isIdle(),
      },
    };
  });

  // IPC Handler for cancelling background tasks for a specific media
  ipcMain.handle(
    IPC_CHANNELS.CANCEL_MEDIA_TASKS,
    async (event, mediaId: string) => {
      const cancelledCount = backgroundTaskQueue.cancelTasksForMedia(mediaId);
      console.log(
        `[Main] Cancelled${cancelledCount} tasks for media ${mediaId}`,
      );
      return { success: true, cancelledCount };
    },
  );

  // IPC Handler for creating preview URLs from file paths
  ipcMain.handle(
    IPC_CHANNELS.CREATE_PREVIEW_URL,
    async (event, filePath: string) => {
      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        const ext = path.extname(filePath).toLowerCase().slice(1);

        // For images, create full data URL (they're usually small)
        if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
          const fileBuffer = fs.readFileSync(filePath);
          let mimeType = 'image/jpeg';
          if (['png'].includes(ext)) {
            mimeType = 'image/png';
          } else if (['gif'].includes(ext)) {
            mimeType = 'image/gif';
          }

          const base64 = fileBuffer.toString('base64');
          const dataUrl = `data:${mimeType};base64,${base64}`;

          return { success: true, url: dataUrl };
        }

        // For videos and other media, use the local media server
        if (
          [
            'mp4',
            'webm',
            'ogg',
            'avi',
            'mov',
            'mkv',
            'mp3',
            'wav',
            'aac',
          ].includes(ext)
        ) {
          await ensureMediaServer();
          // URL encode the file path for the media server
          const encodedPath = encodeURIComponent(filePath);
          const serverUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodedPath}`;

          console.log(`[Main] Created server URL for media${serverUrl}`);
          return { success: true, url: serverUrl };
        }

        // For other file types, return error
        return { success: false, error: 'Unsupported file type' };
      } catch (error) {
        console.error('[Main] Failed to create preview URL', error);
        return { success: false, error: error.message };
      }
    },
  );

  // IPC Handler for serving files as streams (for large video files)
  ipcMain.handle(
    IPC_CHANNELS.GET_FILE_STREAM,
    async (event, filePath: string, start?: number, end?: number) => {
      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        // If no range specified, return small chunk for preview
        const startByte = start || 0;
        const endByte = end || Math.min(startByte + 1024 * 1024, fileSize - 1); // 1MB max chunk

        const buffer = Buffer.alloc(endByte - startByte + 1);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, buffer.length, startByte);
        fs.closeSync(fd);

        return {
          success: true,
          data: buffer.toString('base64'),
          start: startByte,
          end: endByte,
          total: fileSize,
        };
      } catch (error) {
        console.error('[Main] Failed to get file stream', error);
        return { success: false, error: error.message };
      }
    },
  );

  // IPC handlers for media cache utilities
  ipcMain.handle(IPC_CHANNELS.GET_MEDIA_CACHE_DIR, async () => {
    try {
      const dir = getMediaCacheDir();
      return { success: true, path: dir };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEDIA_PATH_EXISTS,
    async (_event, pathOrUrl: string) => {
      try {
        const resolved = resolveMediaPath(pathOrUrl);
        if (!resolved) {
          return { success: false, exists: false, error: 'Invalid media path' };
        }
        return {
          success: true,
          exists: fs.existsSync(resolved),
          path: resolved,
        };
      } catch (error) {
        return {
          success: false,
          exists: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // FFmpeg IPC handlers
  ipcMain.handle(
    'ffmpeg:detect-frame-rate',
    async (event, videoPath: string) => {
      return new Promise((resolve, reject) => {
        if (!ffprobePath?.path) {
          reject(
            new Error(
              'FFprobe binary not available. Please ensure ffprobe-static is properly installed.',
            ),
          );
          return;
        }

        const ffprobe = spawn(ffprobePath.path, [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_streams',
          '-select_streams',
          'v:0',
          videoPath,
        ]);

        let output = '';

        ffprobe.stdout.on('data', (data) => {
          output += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
          console.error(`[Main] ffprobe stderr${data}`);
        });

        ffprobe.on('close', (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(output);
              const videoStream = result.streams[0];

              if (videoStream && videoStream.r_frame_rate) {
                const [num, den] = videoStream.r_frame_rate
                  .split('/')
                  .map(Number);
                const frameRate = Math.round((num / den) * 100) / 100;
                resolve(frameRate);
              } else {
                resolve(30);
              }
            } catch (err) {
              console.error('[Main] Failed to parse ffprobe output', err);
              resolve(30);
            }
          } else {
            reject(new Error(`ffprobe failed with code ${code}`));
          }
        });

        ffprobe.on('error', (err) => {
          reject(new Error(`ffprobe error: ${err.message}`));
        });
      });
    },
  );

  // Get media file duration using FFprobe
  ipcMain.handle(
    IPC_CHANNELS.FFMPEG_GET_DURATION,
    async (event, filePath: string) => {
      return new Promise((resolve, reject) => {
        if (!ffprobePath?.path) {
          reject(
            new Error(
              'FFprobe binary not available. Please ensure ffprobe-static is properly installed.',
            ),
          );
          return;
        }

        const ffprobe = spawn(ffprobePath.path, [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ]);

        let output = '';

        ffprobe.stdout.on('data', (data) => {
          output += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
          console.error(`[Main] ffprobe stderr${data}`);
        });

        ffprobe.on('close', (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(output);

              // Try to get duration from format first (most reliable)
              if (result.format && result.format.duration) {
                const duration = parseFloat(result.format.duration);
                console.log(
                  `[Main] Duration from format${duration}s for ${filePath}`,
                );
                resolve(duration);
                return;
              }

              // Fallback: try to get duration from streams
              if (result.streams && result.streams.length > 0) {
                for (const stream of result.streams) {
                  if (stream.duration && parseFloat(stream.duration) > 0) {
                    const duration = parseFloat(stream.duration);
                    console.log(
                      `[Main] Duration from stream${duration}s for ${filePath}`,
                    );
                    resolve(duration);
                    return;
                  }
                }
              }

              // Last fallback: images get 5 seconds, others get 60 seconds
              const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
              const fallbackDuration = isImage ? 5 : 60;
              console.warn(
                `[Main] Could not determine duration for${filePath}, using fallback: ${fallbackDuration}s`,
              );
              resolve(fallbackDuration);
            } catch (err) {
              console.error('[Main] Failed to parse ffprobe output', err);
              const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
              resolve(isImage ? 5 : 60); // Fallback
            }
          } else {
            console.error(
              `[Main] ffprobe failed with code${code} for ${filePath}`,
            );
            const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
            resolve(isImage ? 5 : 60); // Fallback
          }
        });

        ffprobe.on('error', (err) => {
          console.error(`[Main] ffprobe error for${filePath}:`, err.message);
          const isImage = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(filePath);
          resolve(isImage ? 5 : 60); // Fallback
        });
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GET_VIDEO_DIMENSIONS,
    async (_event, filePath: string) => {
      return new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
          const ffprobe = spawn(ffprobePath.path, [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height',
            '-of',
            'json',
            filePath,
          ]);

          let stdout = '';
          let stderr = '';

          ffprobe.stdout.on('data', (data) => {
            stdout += data.toString();
          });

          ffprobe.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          ffprobe.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
              return;
            }

            try {
              const json = JSON.parse(stdout);
              const stream = json.streams?.[0];
              if (!stream?.width || !stream?.height) {
                reject(new Error('Could not read video dimensions'));
                return;
              }
              resolve({ width: stream.width, height: stream.height });
            } catch (err) {
              reject(err);
            }
          });

          ffprobe.on('error', (err) => {
            reject(err);
          });
        },
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.FFMPEG_RUN, async (event, job: VideoEditJob) => {
    console.log('[Main] MAIN PROCESS: ffmpegRun handler called!');
    console.log(
      '[Main] MAIN PROCESS: Received job',
      JSON.stringify(job, null, 2),
    );

    const location = job.outputPath || 'public/output/';
    // Ensure we have an absolute path for the location
    const absoluteLocation = path.isAbsolute(location)
      ? location
      : path.resolve(location);

    // Important: do not wrap this handler in queueFFmpegTask.
    // runQueuedFfmpeg already enters the shared FFmpeg queue, and nesting would deadlock.
    let tempSubtitlePath: string | null = null;

    try {
      // Create temporary subtitle file if subtitle content is provided
      if (job.subtitleContent && job.operations.subtitles) {
        tempSubtitlePath = path.join(absoluteLocation, 'temp_subtitles.ass');

        // Ensure directory exists
        if (!fs.existsSync(absoluteLocation)) {
          fs.mkdirSync(absoluteLocation, { recursive: true });
        }

        // Write subtitle content to file
        fs.writeFileSync(tempSubtitlePath, job.subtitleContent, 'utf8');
        console.log('[Main] Created temporary subtitle file', tempSubtitlePath);

        // Update the job to use the absolute path instead of just the filename
        job.operations.subtitles = tempSubtitlePath;
        console.log(
          '[Main] Updated subtitle path to absolute',
          tempSubtitlePath,
        );
      }

      // Verify subtitle file exists before running FFmpeg
      if (tempSubtitlePath) {
        if (!fs.existsSync(tempSubtitlePath)) {
          throw new Error(`Subtitle file does not exist: ${tempSubtitlePath}`);
        }
        console.log('[Main] Subtitle file verified to exist', tempSubtitlePath);
      }

      // Build proper FFmpeg command
      const baseArgs = await buildFfmpegCommand(
        job,
        absoluteLocation,
        ffmpegPath,
      );
      const args = ['-progress', 'pipe:1', '-y', ...baseArgs];

      console.log('[Main] COMPLETE FFMPEG COMMAND');
      console.log('[Main] Log', ['ffmpeg', ...args].join(' '));

      // Double-check subtitle file still exists right before spawning
      if (tempSubtitlePath && !fs.existsSync(tempSubtitlePath)) {
        throw new Error(
          `Subtitle file disappeared before FFmpeg start: ${tempSubtitlePath}`,
        );
      }

      if (!ffmpegPath) {
        throw new Error(
          'FFmpeg binary not available. Please ensure ffmpeg-static is properly installed.',
        );
      }

      const logs: string[] = [];
      const ffmpegResult = await runQueuedFfmpeg(args, {
        priority: 2,
        timeoutMs: 30 * 60 * 1000,
        onStdout: (text) => {
          logs.push(`[stdout] ${text}`);
          event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_RUN_PROGRESS, {
            type: 'stdout',
            data: text,
          });
        },
        onStderr: (text) => {
          logs.push(`[stderr] ${text}`);
          event.sender.send(IPC_CHANNELS.EVENT_FFMPEG_RUN_PROGRESS, {
            type: 'stderr',
            data: text,
          });
        },
      });

      // Always cleanup temporary subtitle file after FFmpeg completes
      if (tempSubtitlePath && fs.existsSync(tempSubtitlePath)) {
        try {
          fs.unlinkSync(tempSubtitlePath);
          console.log(
            '[Main] Cleaned up temporary subtitle file after FFmpeg completion',
          );
        } catch (cleanupError) {
          console.warn(
            '[Main] Failed to cleanup temporary subtitle file after completion',
            cleanupError,
          );
        }
      }

      const logText = logs.join('\n');
      const wasCancelled =
        ffmpegResult.signal === 'SIGTERM' ||
        ffmpegResult.signal === 'SIGKILL' ||
        (ffmpegResult.code === 255 &&
          (logText.includes('received signal 15') ||
            logText.includes('Exiting normally, received signal')));

      if (wasCancelled) {
        console.log('[Main] FFmpeg process was cancelled by user');
        const outputFilePath = path.join(absoluteLocation, job.output);
        if (fs.existsSync(outputFilePath)) {
          try {
            fs.unlinkSync(outputFilePath);
            console.log(
              '[Main] Deleted incomplete output file',
              outputFilePath,
            );
          } catch (deleteError) {
            console.warn(
              '[Main] Failed to delete incomplete output file',
              deleteError,
            );
          }
        }

        return {
          success: true,
          cancelled: true,
          logs: logText,
          message: 'Export cancelled by user',
        };
      }

      if (ffmpegResult.timedOut) {
        throw new Error(`FFmpeg exited with timeout\nLogs:\n${logText}`);
      }

      if (ffmpegResult.code === 0) {
        return { success: true, logs: logText };
      }

      throw new Error(
        `FFmpeg exited with code ${ffmpegResult.code}\nLogs:\n${logText}`,
      );
    } catch (error) {
      console.log(
        '[Main] Setup error occurred before FFmpeg could start',
        error,
      );

      // Only cleanup on setup errors, not FFmpeg execution errors
      if (tempSubtitlePath && fs.existsSync(tempSubtitlePath)) {
        try {
          fs.unlinkSync(tempSubtitlePath);
          console.log(
            '[Main] Cleaned up temporary subtitle file due to setup error',
          );
        } catch (cleanupError) {
          console.warn(
            '[Main] Failed to cleanup temporary subtitle file after setup error',
            cleanupError,
          );
        }
      }
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FFMPEG_CANCEL_EXPORT, async () => {
    const cancelled = killCurrentFfmpegProcess('user-cancel');
    if (cancelled) {
      return { success: true, message: 'Export cancelled' };
    }
    return { success: false, message: 'No export running' };
  });

  // Keep track of active proxy generation promises to deduplicate requests
  const activeProxyGenerations = new Map<string, Promise<any>>();

  // Helper function to run FFmpeg proxy generation with a specific encoder config
  async function runProxyFFmpeg(
    inputPath: string,
    tempPath: string,
    encoderConfig: ProxyEncoderConfig,
    ffmpegBinaryPath: string,
    eventSender: Electron.WebContents | null,
  ): Promise<{
    success: boolean;
    code?: number;
    stderr?: string;
  }> {
    // Build FFmpeg args based on encoder type
    let args: string[];
    if (encoderConfig.type === 'vaapi') {
      // VAAPI requires special filter chain with hardware upload
      args = buildVaapiProxyFFmpegArgs(inputPath, tempPath);
    } else {
      args = buildProxyFFmpegArgs(inputPath, tempPath, encoderConfig);
    }

    console.log(
      `[Main] FFmpeg proxy command (${encoderConfig.description}):`,
      [ffmpegBinaryPath, ...args].join(' '),
    );

    try {
      const ffmpegResult = await runQueuedFfmpeg(args, {
        priority: 2,
        binaryPath: ffmpegBinaryPath,
        timeoutMs: 30 * 60 * 1000, // 30 minutes
        onStderr: (chunk) => {
          // Send progress updates to renderer
          if (chunk.includes('time=') && eventSender) {
            eventSender.send(IPC_CHANNELS.EVENT_PROXY_PROGRESS, {
              path: inputPath,
              log: chunk,
              encoder: encoderConfig.type,
            });
          }
        },
      });

      return {
        success: ffmpegResult.code === 0,
        code: ffmpegResult.code ?? undefined,
        stderr: ffmpegResult.stderr,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(
        `[Main] FFmpeg spawn error (${encoderConfig.type}):`,
        message,
      );
      return {
        success: false,
        code: -1,
        stderr: message,
      };
    }
  }

  // IPC Handler for generating proxy files for 4K video optimization
  // Uses hybrid encoder selection: GPU hardware encoder if available, CPU fallback otherwise
  ipcMain.handle(
    IPC_CHANNELS.GENERATE_PROXY,
    async (event, inputPath: string) => {
      console.log('[Main] generate-proxy called for', inputPath);

      // Check if there is already an active generation for this file
      if (activeProxyGenerations.has(inputPath)) {
        console.log('[Main] Joining existing proxy generation for', inputPath);
        return activeProxyGenerations.get(inputPath);
      }

      const generationPromise = (async () => {
        if (!ffmpegPath) {
          return { success: false, error: 'FFmpeg not available' };
        }

        try {
          const proxiesDir = path.join(app.getPath('userData'), 'proxies');
          if (!fs.existsSync(proxiesDir)) {
            fs.mkdirSync(proxiesDir, { recursive: true });
          }

          // Generate a stable hash for the filename based on input path
          const hash = crypto.createHash('md5').update(inputPath).digest('hex');
          const outputPath = path.join(proxiesDir, `${hash}.mp4`);

          // Check if proxy already exists
          if (fs.existsSync(outputPath)) {
            console.log('[Main] Proxy already exists at', outputPath);
            // Verify it's valid (size > 0)
            const stats = fs.statSync(outputPath);
            if (stats.size > 0) {
              return { success: true, proxyPath: outputPath, cached: true };
            }
            // If invalid, delete and regenerate
            fs.unlinkSync(outputPath);
          }

          // Use a temporary file during generation to prevent incomplete reads
          const tempPath = outputPath + '.tmp';
          console.log(`[Main] Writing to temp file${tempPath}`);

          // Clean up any stale temp file
          if (fs.existsSync(tempPath)) {
            try {
              fs.unlinkSync(tempPath);
            } catch (e) {
              console.warn('[Main] Could not cleanup old temp proxy', e);
            }
          }

          // Get optimal encoder configuration (hardware if available, software fallback)
          const encoderConfig = await getProxyEncoderConfig(ffmpegPath);

          console.log('[Main] Starting proxy generation to', outputPath);
          console.log(`[Main] Using encoder${encoderConfig.description}`);
          const startTime = Date.now();
          const startTimeString = new Date(startTime).toLocaleTimeString();
          console.log(
            `[Main] ⏱ Proxy generation START${startTimeString} (${startTime})`,
          );

          // Attempt proxy generation with selected encoder
          let result = await runProxyFFmpeg(
            inputPath,
            tempPath,
            encoderConfig,
            ffmpegPath,
            event.sender,
          );

          let fallbackUsed = false;
          let originalEncoder: string | undefined;

          // If hardware encoder failed, fallback to software encoding
          if (!result.success && encoderConfig.type !== 'software') {
            console.warn(
              `[Main] Hardware encoder${encoderConfig.type} failed (code: ${result.code}), falling back to software encoding`,
            );
            console.warn(`[Main] Error${result.stderr?.slice(-200)}`);

            // Clean up any partial temp file from failed attempt
            if (fs.existsSync(tempPath)) {
              try {
                fs.unlinkSync(tempPath);
              } catch (e) {
                console.warn(
                  '[Main] Could not cleanup temp file after failure',
                  e,
                );
              }
            }

            // Retry with software encoder
            const softwareConfig = getSoftwareEncoderConfig();
            console.log(`[Main] Retrying with${softwareConfig.description}...`);

            result = await runProxyFFmpeg(
              inputPath,
              tempPath,
              softwareConfig,
              ffmpegPath,
              event.sender,
            );

            fallbackUsed = true;
            originalEncoder = encoderConfig.type;
          }

          const endTime = Date.now();
          const endTimeString = new Date(endTime).toLocaleTimeString();
          const durationMs = endTime - startTime;

          console.log(
            `[Main] ⏱ Proxy generation END${endTimeString} (${endTime})`,
          );
          console.log(`[Main] ⏱ Duration${durationMs}ms`);

          if (result.success) {
            try {
              // Wait a small amount of time to ensure file handles are released
              await new Promise((r) => setTimeout(r, 500));

              // Atomic rename: temp -> final
              if (fs.existsSync(tempPath)) {
                fs.renameSync(tempPath, outputPath);
                console.log(
                  '[Main] Proxy generation complete (renamed temp -> final)',
                  outputPath,
                );

                const finalEncoderType = fallbackUsed
                  ? 'software'
                  : encoderConfig.type;
                const finalEncoderDesc = fallbackUsed
                  ? getSoftwareEncoderConfig().description
                  : encoderConfig.description;

                return {
                  success: true,
                  proxyPath: outputPath,
                  encoder: {
                    type: finalEncoderType,
                    description: finalEncoderDesc,
                    fallbackUsed,
                    originalEncoder,
                  },
                  benchmark: {
                    durationMs,
                    startTime,
                    endTime,
                  },
                };
              } else {
                console.error(
                  '[Main] Temp proxy file missing after successful FFmpeg exit',
                );
                return { success: false, error: 'Temp proxy file missing' };
              }
            } catch (err) {
              console.error('[Main] Failed to rename temp proxy file', err);
              return {
                success: false,
                error: 'Failed to finalize proxy file',
              };
            }
          } else {
            console.error(
              `[Main] Proxy generation failed with code${result.code}`,
            );
            console.error('[Main] FFmpeg stderr', result.stderr);

            // Cleanup temp file
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
            return {
              success: false,
              error: `FFmpeg exited with code ${result.code}. Error: ${result.stderr?.slice(-200)}`,
            };
          }
        } catch (error) {
          console.error('[Main] Failed to generate proxy', error);
          return { success: false, error: error.message };
        } finally {
          // Remove from active generations map when done
          activeProxyGenerations.delete(inputPath);
        }
      })();

      activeProxyGenerations.set(inputPath, generationPromise);
      return generationPromise;
    },
  );

  // IPC Handler for getting hardware capabilities (for UI display and low-hardware modal)
  ipcMain.handle(IPC_CHANNELS.GET_HARDWARE_CAPABILITIES, async () => {
    if (!ffmpegPath) {
      return {
        success: false,
        error: 'FFmpeg not available',
      };
    }

    try {
      const capabilities = await detectHardwareCapabilities(ffmpegPath);

      return {
        success: true,
        capabilities: {
          hasHardwareEncoder: capabilities.hasHardwareEncoder,
          encoderType: capabilities.encoder.primary?.type || 'none',
          encoderDescription:
            capabilities.encoder.primary?.description ||
            'Software encoding (CPU)',
          cpuCores: capabilities.cpuCores,
          totalRamGB: Math.round(
            capabilities.totalRamBytes / (1024 * 1024 * 1024),
          ),
          freeRamGB: Math.round(
            capabilities.freeRamBytes / (1024 * 1024 * 1024),
          ),
          isLowHardware: capabilities.isLowHardware,
        },
      };
    } catch (error) {
      console.error('[Main] Failed to detect hardware capabilities', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Diagnostic handler to check FFmpeg status
  ipcMain.handle(IPC_CHANNELS.FFMPEG_STATUS, async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const fs = require('fs');

    const ffmpegExists = ffmpegPath ? fs.existsSync(ffmpegPath) : false;
    const ffprobeExists = ffprobePath?.path
      ? fs.existsSync(ffprobePath.path)
      : false;

    return {
      ffmpegPath,
      ffprobePath: ffprobePath?.path,
      ffmpegExists,
      ffprobeExists,
      isReady: ffmpegPath !== null && ffprobePath?.path !== null,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      environment: process.env.NODE_ENV || 'production',
    };
  });

  // ============================================================================
  // Python Faster-Whisper IPC Handlers
  // ============================================================================

  // IPC Handler for Whisper transcription
  ipcMain.handle(
    IPC_CHANNELS.WHISPER_TRANSCRIBE,
    async (
      event,
      audioPath: string,
      options?: {
        model?:
          | 'tiny'
          | 'base'
          | 'small'
          | 'medium'
          | 'large'
          | 'large-v2'
          | 'large-v3';
        language?: string;
        translate?: boolean;
        device?: 'cpu' | 'cuda';
        computeType?: 'int8' | 'int16' | 'float16' | 'float32';
        beamSize?: number;
        vad?: boolean;
      },
    ) => {
      console.log(
        '[Main] MAIN PROCESS: whisper:transcribe handler called (Python)',
      );
      console.log('[Main] Audio path', audioPath);
      console.log('[Main] Options', options);

      try {
        await ensurePythonInitialized('ipc:whisper:transcribe');

        const result: WhisperResult = await transcribeAudio(audioPath, {
          ...options,
          onProgress: (progress: WhisperProgress) => {
            // Send progress updates to renderer process
            event.sender.send(IPC_CHANNELS.EVENT_WHISPER_PROGRESS, progress);
          },
        });

        console.log('[Main] Transcription successful');
        return { success: true, result };
      } catch (error) {
        console.error('[Main] Whisper transcription failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // IPC Handler to cancel transcription
  ipcMain.handle(IPC_CHANNELS.WHISPER_CANCEL, async () => {
    console.log('[Main] MAIN PROCESS: whisper:cancel handler called');

    const cancelled = cancelTranscription();
    return {
      success: cancelled,
      message: cancelled
        ? 'Transcription cancelled successfully'
        : 'No active transcription to cancel',
    };
  });

  // IPC Handler to check Whisper status
  ipcMain.handle(IPC_CHANNELS.WHISPER_STATUS, async () => {
    console.log('[Main] MAIN PROCESS: whisper:status handler called');

    // Try to initialize if not already initialized (but don't fail if it doesn't work)
    if (!getPythonWhisperStatus().available) {
      try {
        await ensurePythonInitialized('ipc:whisper:status');
      } catch (error) {
        console.log(
          '[Main] Python initialization failed during status check',
          error,
        );
        // Continue to return status even if initialization failed
      }
    }

    const status = getPythonWhisperStatus();
    console.log('[Main] Status', status);

    return status;
  });

  // ============================================================================
  // Media Tools IPC Handlers (Noise Reduction)
  // ============================================================================

  // IPC Handler for noise reduction
  ipcMain.handle(
    IPC_CHANNELS.MEDIA_TOOLS_NOISE_REDUCE,
    async (
      event,
      inputPath: string,
      outputPath: string,
      options?: {
        stationary?: boolean;
        propDecrease?: number;
        nFft?: number;
        engine?: 'ffmpeg' | 'deepfilter';
      },
    ) => {
      console.log(
        '[Main] MAIN PROCESS: media-tools:noise-reduce handler called',
      );
      console.log('[Main] Input path', inputPath);
      console.log('[Main] Output path', outputPath);
      console.log('[Main] Options', options);

      const engine = options?.engine || 'ffmpeg'; // Default to FFmpeg for safety/speed

      try {
        if (engine === 'deepfilter') {
          // --- DeepFilterNet2 (Python) ---
          await ensurePythonInitialized('ipc:media-tools:noise-reduce');

          const result: NoiseReductionResult = await reduceNoise(
            inputPath,
            outputPath,
            {
              ...options,
              onProgress: (progress: MediaToolsProgress) => {
                // Send progress updates to renderer process
                event.sender.send(
                  IPC_CHANNELS.EVENT_MEDIA_TOOLS_PROGRESS,
                  progress,
                );
              },
            },
          );

          console.log('[Main] DeepFilter noise reduction successful');
          return { success: true, result };
        } else {
          // --- FFmpeg (Native) ---
          console.log('[Main] Using FFmpeg for noise reduction');

          if (!ffmpegPath) {
            throw new Error('FFmpeg binary not available');
          }

          const filter = getFfmpegAudioDenoiseFilter();
          if (filter !== 'arnndn') {
            throw new Error(
              'FFmpeg build does not include arnndn filter required for RNNoise.',
            );
          }

          const modelPath = getDefaultModelPath();
          if (!fs.existsSync(modelPath)) {
            throw new Error(`RNNoise model not found: ${modelPath}`);
          }

          console.log('[Main] Denoise filter', filter);

          // Build command
          // Note: buildArnnDenCommand returns args for "ffmpeg -i input -af arnndn..."
          const args = buildArnnDenCommand(inputPath, outputPath);
          // We need to add -y to overwrite output if it exists (standard behavior)
          args.unshift('-y');

          console.log('[Main] Command', `ffmpeg${args.join(' ')}`);

          const runFfmpegDenoise = async (runArgs: string[]) => {
            let durationSec = 0;
            let stderrLog = '';

            // Send initial loading state
            event.sender.send(IPC_CHANNELS.EVENT_MEDIA_TOOLS_PROGRESS, {
              stage: 'loading',
              progress: 0,
              message: 'Initializing FFmpeg...',
            });

            const ffmpegResult = await runQueuedFfmpeg(runArgs, {
              priority: 2,
              timeoutMs: 30 * 60 * 1000, // 30 minutes
              onStderr: (text) => {
                stderrLog += text;

                // 1. Parse Duration: Duration: 00:00:10.50,
                if (durationSec === 0) {
                  const durationMatch = text.match(
                    /Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/,
                  );
                  if (durationMatch) {
                    const h = parseFloat(durationMatch[1]);
                    const m = parseFloat(durationMatch[2]);
                    const s = parseFloat(durationMatch[3]);
                    durationSec = h * 3600 + m * 60 + s;
                  }
                }

                // 2. Parse Time: time=00:00:05.20
                if (durationSec > 0) {
                  const timeMatch = text.match(
                    /time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/,
                  );
                  if (timeMatch) {
                    const h = parseFloat(timeMatch[1]);
                    const m = parseFloat(timeMatch[2]);
                    const s = parseFloat(timeMatch[3]);
                    const timeSec = h * 3600 + m * 60 + s;
                    const percent = Math.min(
                      99,
                      Math.round((timeSec / durationSec) * 100),
                    );

                    event.sender.send(IPC_CHANNELS.EVENT_MEDIA_TOOLS_PROGRESS, {
                      stage: 'processing',
                      progress: percent,
                      message: `Filtering... ${percent}%`,
                    });
                  }
                }
              },
            });

            if (ffmpegResult.timedOut) {
              return { success: false, stderrLog: 'FFmpeg timed out' };
            }

            if (ffmpegResult.code === 0) {
              return { success: true, stderrLog };
            }

            console.error(
              '[Main] FFmpeg noise reduction failed. Code',
              ffmpegResult.code,
            );
            return { success: false, stderrLog };
          };

          const firstAttempt = await runFfmpegDenoise(args);
          if (firstAttempt.success) {
            console.log('[Main] FFmpeg noise reduction successful');
            event.sender.send(IPC_CHANNELS.EVENT_MEDIA_TOOLS_PROGRESS, {
              stage: 'complete',
              progress: 100,
              message: 'Noise reduction complete!',
            });
            return {
              success: true,
              result: {
                success: true,
                outputPath,
                message: 'FFmpeg denoising complete',
              },
            };
          }

          const stderrText = firstAttempt.stderrLog || '';
          // Check for common errors in stderr
          let errorMsg = 'FFmpeg exited with code 1';
          if (stderrText.includes('Permission denied'))
            errorMsg = 'Permission denied';
          if (stderrText.includes('No such file')) errorMsg = 'File not found';

          if (stderrText.trim()) {
            errorMsg += `\nStderr:\n${stderrText.trim()}`;
          }

          return {
            success: false,
            error: errorMsg,
          };
        }
      } catch (error) {
        console.error('[Main] Noise reduction failed', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // IPC Handler to cancel media-tools operation
  ipcMain.handle(IPC_CHANNELS.MEDIA_TOOLS_CANCEL, async () => {
    console.log('[Main] MAIN PROCESS: media-tools:cancel handler called');

    const cancelled = cancelCurrentOperation();
    return {
      success: cancelled,
      message: cancelled
        ? 'Operation cancelled'
        : 'No active operation to cancel',
    };
  });

  // IPC Handler to check media-tools status
  ipcMain.handle(IPC_CHANNELS.MEDIA_TOOLS_STATUS, async () => {
    console.log('[Main] MAIN PROCESS: media-tools:status handler called');

    // Try to initialize if not already initialized
    if (!getMediaToolsStatus().available) {
      try {
        await ensurePythonInitialized('ipc:media-tools:status');
      } catch (error) {
        console.log(
          '[Main] Media tools initialization failed during status check',
          error,
        );
      }
    }

    const status = getMediaToolsStatus();
    console.log('[Main] Status', status);

    return status;
  });

  // ============================================================================
  // Noise Reduction Cache IPC Handlers
  // ============================================================================

  // Noise reduction temp directory
  const NOISE_REDUCTION_TEMP_DIR = path.join(
    os.tmpdir(),
    'dividr-noise-reduction',
  );

  // IPC Handler to get a unique output path for noise reduction
  // IPC Handler to get a unique output path for noise reduction
  ipcMain.handle(
    IPC_CHANNELS.NOISE_REDUCTION_GET_OUTPUT_PATH,
    async (_event, inputPath: string, engine?: string) => {
      console.log(
        '[Main] MAIN PROCESS: noise-reduction:get-output-path handler called',
      );
      console.log('[Main] Input path', inputPath);
      console.log('[Main] Engine', engine);

      try {
        // Ensure directory exists
        if (!fs.existsSync(NOISE_REDUCTION_TEMP_DIR)) {
          fs.mkdirSync(NOISE_REDUCTION_TEMP_DIR, { recursive: true });
          console.log(
            '[Main] Created noise reduction temp directory',
            NOISE_REDUCTION_TEMP_DIR,
          );
        }

        // Generate unique filename based on input path hash and timestamp
        const hash = crypto
          .createHash('md5')
          .update(inputPath)
          .digest('hex')
          .slice(0, 12);
        const timestamp = Date.now();
        const engineTag = engine ? `_${engine}` : '';
        const outputPath = path.join(
          NOISE_REDUCTION_TEMP_DIR,
          `nr_${hash}${engineTag}_${timestamp}.wav`,
        );

        console.log('[Main] Generated output path', outputPath);
        return { success: true, outputPath };
      } catch (error) {
        console.error('[Main] Failed to generate output path', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // IPC Handler to cleanup noise reduction temp files
  ipcMain.handle(
    IPC_CHANNELS.NOISE_REDUCTION_CLEANUP_FILES,
    async (_event, filePaths: string[]) => {
      console.log(
        '[Main] MAIN PROCESS: noise-reduction:cleanup-files handler called',
      );
      console.log('[Main] Files to clean', filePaths.length);

      try {
        let cleanedCount = 0;

        for (const filePath of filePaths) {
          try {
            // Security: only delete files in our noise reduction directory
            if (
              filePath.startsWith(NOISE_REDUCTION_TEMP_DIR) &&
              fs.existsSync(filePath)
            ) {
              fs.unlinkSync(filePath);
              cleanedCount++;
              console.log('[Main] Cleaned up', filePath);
            } else {
              console.warn('[Main] Skipped (not in temp dir)', filePath);
            }
          } catch (error) {
            console.warn(`[Main] Failed to cleanup${filePath}:`, error);
          }
        }

        console.log(`[Main] Cleaned up${cleanedCount} noise reduction files`);
        return { success: true, cleanedCount };
      } catch (error) {
        console.error('[Main] Failed to cleanup noise reduction files', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // IPC Handler to create a blob URL for a file
  ipcMain.handle(
    IPC_CHANNELS.NOISE_REDUCTION_CREATE_PREVIEW_URL,
    async (_event, filePath: string) => {
      console.log(
        '[Main] MAIN PROCESS: noise-reduction:create-preview-url handler called',
      );
      console.log('[Main] File path', filePath);

      try {
        // Read the file and return base64 data for creating blob URL in renderer
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        const buffer = fs.readFileSync(filePath);
        const base64 = buffer.toString('base64');
        const mimeType = 'audio/wav';

        console.log('[Main] Created preview URL data, size', buffer.length);
        return { success: true, base64, mimeType };
      } catch (error) {
        console.error('[Main] Failed to create preview URL', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // ============================================================================
  ipcMain.handle(
    IPC_CHANNELS.MEDIA_HAS_AUDIO,
    async (event, filePath: string) => {
      console.log('[Main] MAIN PROCESS: media:has-audio handler called');
      console.log('[Main] File path', filePath);

      if (!ffmpegPath) {
        return {
          success: false,
          hasAudio: false,
          error: 'FFmpeg binary not available',
        };
      }

      try {
        return new Promise((resolve) => {
          const ffprobe = spawn(ffmpegPath, [
            '-i',
            filePath,
            '-show_streams',
            '-select_streams',
            'a',
            '-loglevel',
            'error',
          ]);

          let stdout = '';

          ffprobe.stdout.on('data', (data) => {
            stdout += data.toString();
          });

          ffprobe.on('close', (code) => {
            // If there's audio stream info in stdout, the file has audio
            const hasAudio = stdout.includes('[STREAM]');

            console.log(`[Main] Has audio${hasAudio} (exit code: ${code})`);

            resolve({
              success: true,
              hasAudio,
            });
          });

          ffprobe.on('error', (error) => {
            console.error('[Main] FFprobe error', error);
            resolve({
              success: false,
              hasAudio: false,
              error: error.message,
            });
          });
        });
      } catch (error) {
        console.error('[Main] Error checking audio', error);
        return {
          success: false,
          hasAudio: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // =============================================================================
  // TRANSCODE SERVICE - AVI to MP4 background transcoding
  // =============================================================================

  // Formats that need transcoding for browser playback
  const FORMATS_REQUIRING_TRANSCODE = [
    '.avi',
    '.wmv',
    '.flv',
    '.divx',
    '.xvid',
    '.asf',
    '.rm',
    '.rmvb',
    '.3gp',
    '.3g2',
  ];

  // Codecs that browsers can't decode
  const UNSUPPORTED_CODECS = [
    'xvid',
    'divx',
    'mpeg4',
    'msmpeg4',
    'wmv1',
    'wmv2',
    'wmv3',
    'vc1',
    'rv10',
    'rv20',
    'rv30',
    'rv40',
  ];

  // Active transcode jobs
  interface TranscodeJob {
    id: string;
    mediaId: string;
    inputPath: string;
    outputPath: string;
    status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    duration: number;
    currentTime: number;
    error?: string;
    startedAt?: number;
    completedAt?: number;
    process?: ReturnType<typeof spawn>;
  }

  const activeTranscodeJobs = new Map<string, TranscodeJob>();
  const transcodeOutputDir = path.join(os.tmpdir(), 'dividr-transcode');

  // Ensure transcode output directory exists
  if (!fs.existsSync(transcodeOutputDir)) {
    fs.mkdirSync(transcodeOutputDir, { recursive: true });
  }
  console.log(`[Main] Transcode output directory${transcodeOutputDir}`);

  // IPC Handler to check if a file requires transcoding
  ipcMain.handle(
    IPC_CHANNELS.TRANSCODE_REQUIRES_TRANSCODING,
    async (event, filePath: string) => {
      console.log(
        '[Main] MAIN PROCESS: transcode:requires-transcoding handler called',
      );
      console.log('[Main] File path', filePath);

      const ext = path.extname(filePath).toLowerCase();

      // Check if extension requires transcoding
      if (FORMATS_REQUIRING_TRANSCODE.includes(ext)) {
        console.log(`[Main] File requires transcoding (${ext} format)`);
        return { requiresTranscoding: true, reason: `${ext} format` };
      }

      // For other formats, check the actual codec
      if (!ffprobePath?.path) {
        console.log('[Main] FFprobe not available, cannot check codec');
        return { requiresTranscoding: false, reason: 'Cannot detect codec' };
      }

      try {
        const codecResult = await new Promise<string | null>((resolve) => {
          const ffprobe = spawn(ffprobePath.path, [
            '-v',
            'quiet',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            filePath,
          ]);

          let output = '';
          ffprobe.stdout.on('data', (data) => {
            output += data.toString();
          });

          ffprobe.on('close', (code) => {
            if (code === 0 && output.trim()) {
              resolve(output.trim().toLowerCase());
            } else {
              resolve(null);
            }
          });

          ffprobe.on('error', () => resolve(null));
        });

        if (
          codecResult &&
          UNSUPPORTED_CODECS.some((c) => codecResult.includes(c))
        ) {
          console.log(
            `[Main] File requires transcoding (${codecResult} codec)`,
          );
          return { requiresTranscoding: true, reason: `${codecResult} codec` };
        }

        console.log(
          `[Main] File does not require transcoding (codec${codecResult || 'unknown'})`,
        );
        return { requiresTranscoding: false, reason: 'Supported format' };
      } catch (error) {
        console.warn('[Main] Could not detect codec', error);
        return { requiresTranscoding: false, reason: 'Cannot detect codec' };
      }
    },
  );

  // IPC Handler to start transcoding
  ipcMain.handle(
    IPC_CHANNELS.TRANSCODE_START,
    async (
      event,
      options: {
        mediaId: string;
        inputPath: string;
        videoBitrate?: string;
        audioBitrate?: string;
        crf?: number;
      },
    ) => {
      console.log('[Main] MAIN PROCESS: transcode:start handler called');
      console.log('[Main] Media ID', options.mediaId);
      console.log('[Main] Input path', options.inputPath);

      if (!ffmpegPath) {
        return { success: false, error: 'FFmpeg not available' };
      }

      // Generate job ID and output path
      const jobId = crypto.randomUUID();
      const outputFileName = `${jobId}.mp4`;
      const outputPath = path.join(transcodeOutputDir, outputFileName);

      // Get video metadata first
      let duration = 0;
      if (ffprobePath?.path) {
        try {
          duration = await new Promise<number>((resolve) => {
            const ffprobe = spawn(ffprobePath.path, [
              '-v',
              'quiet',
              '-print_format',
              'json',
              '-show_format',
              options.inputPath,
            ]);

            let output = '';
            ffprobe.stdout.on('data', (data) => {
              output += data.toString();
            });

            ffprobe.on('close', () => {
              try {
                const metadata = JSON.parse(output);
                resolve(parseFloat(metadata.format?.duration || '0'));
              } catch {
                resolve(0);
              }
            });

            ffprobe.on('error', () => resolve(0));
          });
        } catch {
          duration = 0;
        }
      }

      // Create job
      const job: TranscodeJob = {
        id: jobId,
        mediaId: options.mediaId,
        inputPath: options.inputPath,
        outputPath,
        status: 'processing',
        progress: 0,
        duration,
        currentTime: 0,
        startedAt: Date.now(),
      };

      activeTranscodeJobs.set(jobId, job);

      console.log(`[Main] Job ID${jobId}`);
      console.log(`[Main] Output path${outputPath}`);
      console.log(`[Main] Duration${duration.toFixed(2)}s`);

      // Build FFmpeg arguments
      const args = [
        '-i',
        options.inputPath,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        String(options.crf || 23),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        options.audioBitrate || '192k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-y',
        outputPath,
      ];

      console.log(`[Main] FFmpeg command: ffmpeg${args.join(' ')}`);

      let stderrOutput = '';

      const ffmpegTask = runQueuedFfmpeg(args, {
        priority: 2,
        timeoutMs: 30 * 60 * 1000, // 30 minutes
        onStart: (proc) => {
          job.process = proc;
          if (job.status === 'cancelled') {
            proc.kill('SIGTERM');
          }
        },
        onStdout: (data) => {
          const output = data.toString();

          // Parse progress
          const timeMatch = output.match(/out_time_ms=(\d+)/);
          if (timeMatch) {
            const currentTimeMs = parseInt(timeMatch[1], 10);
            job.currentTime = currentTimeMs / 1000000;

            if (job.duration > 0) {
              job.progress = Math.min(
                100,
                (job.currentTime / job.duration) * 100,
              );
            }

            // Send progress to renderer
            mainWindow?.webContents.send(
              IPC_CHANNELS.EVENT_TRANSCODE_PROGRESS,
              {
                jobId: job.id,
                mediaId: job.mediaId,
                status: job.status,
                progress: job.progress,
                currentTime: job.currentTime,
                duration: job.duration,
              },
            );
          }
        },
        onStderr: (data) => {
          stderrOutput += data.toString();
        },
      });

      void ffmpegTask
        .then((result) => {
          if (result.timedOut) {
            job.status = 'failed';
            job.error = 'FFmpeg transcode timed out';
            mainWindow?.webContents.send(
              IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED,
              {
                jobId: job.id,
                mediaId: job.mediaId,
                success: false,
                error: job.error,
              },
            );
            delete job.process;
            return;
          }

          if (result.code === 0) {
            job.status = 'completed';
            job.progress = 100;
            job.completedAt = Date.now();

            const processingTime =
              job.completedAt - (job.startedAt || job.completedAt);
            console.log(
              `[Main] Transcode completed${jobId} in ${(processingTime / 1000).toFixed(1)}s`,
            );

            // Create preview URL for the transcoded file
            const previewUrl = `http://localhost:${MEDIA_SERVER_PORT}/${encodeURIComponent(outputPath)}`;

            mainWindow?.webContents.send(
              IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED,
              {
                jobId: job.id,
                mediaId: job.mediaId,
                success: true,
                outputPath,
                previewUrl,
              },
            );

            delete job.process;
            return;
          }

          if (job.status === 'cancelled') {
            console.log(`[Main] Transcode cancelled${jobId}`);

            // Clean up output file
            if (fs.existsSync(outputPath)) {
              try {
                fs.unlinkSync(outputPath);
              } catch (e) {
                console.warn(
                  '[Main] Could not delete incomplete transcode file',
                );
              }
            }

            mainWindow?.webContents.send(
              IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED,
              {
                jobId: job.id,
                mediaId: job.mediaId,
                success: false,
                error: 'Cancelled',
              },
            );
          } else {
            job.status = 'failed';
            job.error =
              stderrOutput.slice(-500) ||
              `FFmpeg exited with code ${result.code}`;

            console.error(`[Main] Transcode failed${jobId}`);
            console.error(`[Main] Error${job.error}`);

            mainWindow?.webContents.send(
              IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED,
              {
                jobId: job.id,
                mediaId: job.mediaId,
                success: false,
                error: job.error,
              },
            );
          }

          delete job.process;
        })
        .catch((error) => {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : 'Unknown error';

          console.error(`[Main] Transcode process error${jobId}`);
          console.error(`[Main] Error${job.error}`);

          mainWindow?.webContents.send(IPC_CHANNELS.EVENT_TRANSCODE_COMPLETED, {
            jobId: job.id,
            mediaId: job.mediaId,
            success: false,
            error: job.error,
          });
        });

      return {
        success: true,
        jobId,
        outputPath,
      };
    },
  );

  // IPC Handler to get transcode job status
  ipcMain.handle(
    IPC_CHANNELS.TRANSCODE_STATUS,
    async (event, jobId: string) => {
      const job = activeTranscodeJobs.get(jobId);
      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      return {
        success: true,
        job: {
          id: job.id,
          mediaId: job.mediaId,
          status: job.status,
          progress: job.progress,
          duration: job.duration,
          currentTime: job.currentTime,
          error: job.error,
        },
      };
    },
  );

  // IPC Handler to cancel transcode job
  ipcMain.handle(
    IPC_CHANNELS.TRANSCODE_CANCEL,
    async (event, jobId: string) => {
      console.log('[Main] MAIN PROCESS: transcode:cancel handler called');
      console.log('[Main] Job ID', jobId);

      const job = activeTranscodeJobs.get(jobId);
      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      if (job.process && !job.process.killed) {
        job.status = 'cancelled';
        job.process.kill('SIGTERM');
        console.log(`[Main] Cancelled job${jobId}`);
        return { success: true };
      }

      job.status = 'cancelled';
      return { success: true, message: 'Job queued for cancellation' };
    },
  );

  // IPC Handler to cancel all transcode jobs for a media ID
  ipcMain.handle(
    IPC_CHANNELS.TRANSCODE_CANCEL_FOR_MEDIA,
    async (event, mediaId: string) => {
      console.log(
        '[Main] MAIN PROCESS: transcode:cancel-for-media handler called',
      );
      console.log('[Main] Media ID', mediaId);

      let cancelled = 0;
      for (const [, job] of activeTranscodeJobs.entries()) {
        if (
          job.mediaId === mediaId &&
          (job.status === 'queued' || job.status === 'processing')
        ) {
          job.status = 'cancelled';
          if (job.process && !job.process.killed) {
            job.process.kill('SIGTERM');
          }
          cancelled++;
        }
      }

      console.log(`[Main] Cancelled${cancelled} jobs`);
      return { success: true, cancelled };
    },
  );

  // IPC Handler to get all active transcode jobs
  ipcMain.handle(IPC_CHANNELS.TRANSCODE_GET_ACTIVE_JOBS, async () => {
    const jobs = Array.from(activeTranscodeJobs.values())
      .filter((job) => job.status === 'queued' || job.status === 'processing')
      .map((job) => ({
        id: job.id,
        mediaId: job.mediaId,
        status: job.status,
        progress: job.progress,
        duration: job.duration,
        currentTime: job.currentTime,
      }));

    return { success: true, jobs };
  });

  // IPC Handler to cleanup old transcode files with EMFILE protection
  ipcMain.handle(
    IPC_CHANNELS.TRANSCODE_CLEANUP,
    async (event, maxAgeMs: number = 24 * 60 * 60 * 1000) => {
      console.log('[Main] MAIN PROCESS: transcode:cleanup handler called');

      try {
        // Read directory with retry for EMFILE protection
        let files: string[] = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            files = fs.readdirSync(transcodeOutputDir);
            break;
          } catch (err) {
            if (isEMFILEError(err) && attempt < 3) {
              console.warn(
                `[Main] EMFILE reading transcode dir, retry${attempt}/3`,
              );
              await new Promise((r) => setTimeout(r, 500 * attempt));
            } else {
              throw err;
            }
          }
        }

        const now = Date.now();
        let cleaned = 0;
        const errors: string[] = [];

        // Process deletions in batches to prevent EMFILE
        const BATCH_SIZE = 5;
        const filesToDelete: string[] = [];

        // First pass: identify files to delete
        for (const file of files) {
          const filePath = path.join(transcodeOutputDir, file);
          try {
            const stats = fs.statSync(filePath);
            const age = now - stats.mtimeMs;
            if (age > maxAgeMs) {
              filesToDelete.push(filePath);
            }
          } catch (statErr) {
            // Skip files we can't stat
            console.warn(`[Main] Could not stat${file}:`, statErr);
          }
        }

        // Second pass: delete in batches
        for (let i = 0; i < filesToDelete.length; i += BATCH_SIZE) {
          const batch = filesToDelete.slice(i, i + BATCH_SIZE);
          const batchPromises = batch.map(async (filePath) => {
            try {
              await fileIOManager.deleteFile(filePath, 'low');
              return true;
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : 'Unknown';
              errors.push(`${path.basename(filePath)}: ${errorMessage}`);
              return false;
            }
          });

          const results = await Promise.all(batchPromises);
          cleaned += results.filter(Boolean).length;
        }

        console.log(`[Main] Cleaned${cleaned} old transcode files`);
        return {
          success: true,
          cleaned,
          errors: errors.length > 0 ? errors : undefined,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        console.error('[Main] Error cleaning up', errorMessage);

        if (isEMFILEError(error)) {
          return {
            success: false,
            error:
              'System file limit reached during cleanup. Please try again later.',
          };
        }

        return {
          success: false,
          error: errorMessage,
        };
      }
    },
  );
}
