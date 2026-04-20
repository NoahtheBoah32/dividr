/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateContentSignatureFromPath } from '@/frontend/utils/contentSignature';
import { FileIntegrityValidator } from '@/frontend/utils/fileValidator';
import { showImportLimitationToast } from '@/frontend/utils/mediaLimitations';
import type { ProxyProgressEvent } from '@/shared/ipc/contracts';
import { toast } from 'sonner';
import { StateCreator } from 'zustand';
import {
  FileProcessingSlice,
  ImportDisposition,
  ImportResult,
  MediaLibraryItem,
  ProcessedFileInfo,
  VideoTrack,
} from '../types';
import { detectAspectRatio } from '../utils/aspectRatioHelpers';
import { DuplicateChoice, DuplicateItem } from './mediaLibrarySlice';

// Track colors for visual differentiation
const TRACK_COLORS = [
  '#e74c3c',
  '#3498db',
  '#2ecc71',
  '#f39c12',
  '#9b59b6',
  '#34495e',
];

// Helper function to detect subtitle files
const isSubtitleFile = (fileName: string): boolean => {
  const subtitleExtensions = [
    '.srt',
    '.vtt',
    '.ass',
    '.ssa',
    '.sub',
    '.sbv',
    '.lrc',
  ];
  return subtitleExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));
};

// Subtitle parsing interface
interface SubtitleSegment {
  startTime: number; // in seconds
  endTime: number; // in seconds
  text: string;
  index?: number;
}

// Parse SRT subtitle format
const parseSRT = (content: string): SubtitleSegment[] => {
  const segments: SubtitleSegment[] = [];
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const index = parseInt(lines[0]);
    const timeRegex =
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/;
    const timeMatch = lines[1].match(timeRegex);

    if (timeMatch) {
      const startTime =
        parseInt(timeMatch[1]) * 3600 +
        parseInt(timeMatch[2]) * 60 +
        parseInt(timeMatch[3]) +
        parseInt(timeMatch[4]) / 1000;

      const endTime =
        parseInt(timeMatch[5]) * 3600 +
        parseInt(timeMatch[6]) * 60 +
        parseInt(timeMatch[7]) +
        parseInt(timeMatch[8]) / 1000;

      // Preserve true line breaks from the source; only normalize CRLF
      const text = lines.slice(2).join('\n').replace(/\r/g, '');

      segments.push({
        startTime,
        endTime,
        text,
        index,
      });
    }
  }

  return segments;
};

// Parse VTT subtitle format
const parseVTT = (content: string): SubtitleSegment[] => {
  const segments: SubtitleSegment[] = [];
  const lines = content.split('\n');
  let i = 0;

  // Skip header
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const timeRegex =
        /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
      const timeMatch = line.match(timeRegex);

      if (timeMatch) {
        const startTime =
          parseInt(timeMatch[1]) * 3600 +
          parseInt(timeMatch[2]) * 60 +
          parseInt(timeMatch[3]) +
          parseInt(timeMatch[4]) / 1000;

        const endTime =
          parseInt(timeMatch[5]) * 3600 +
          parseInt(timeMatch[6]) * 60 +
          parseInt(timeMatch[7]) +
          parseInt(timeMatch[8]) / 1000;

        i++;
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          // Preserve raw lines while normalizing CR
          textLines.push(lines[i].replace(/\r/g, ''));
          i++;
        }

        const text = textLines.join('\n');

        segments.push({
          startTime,
          endTime,
          text,
        });
      }
    }
    i++;
  }

  return segments;
};

// Main subtitle parser function
const parseSubtitleContent = (
  content: string,
  fileName: string,
): SubtitleSegment[] => {
  const extension = fileName.toLowerCase().split('.').pop();

  switch (extension) {
    case 'srt':
      return parseSRT(content);
    case 'vtt':
      return parseVTT(content);
    default:
      // For other formats, try SRT parsing as fallback
      return parseSRT(content);
  }
};

// Helper function to process subtitle files and create individual tracks
const processSubtitleFile = async (
  fileInfo: ProcessedFileInfo,
  fileContent: string,
  currentTrackCount: number,
  fps: number,
  trackRowIndex: number,
  previewUrl?: string,
): Promise<Omit<VideoTrack, 'id'>[]> => {
  try {
    // Parse subtitle segments
    const segments = parseSubtitleContent(fileContent, fileInfo.name);
    const sortedSegments = [...segments].sort(
      (a, b) => a.startTime - b.startTime,
    );

    if (sortedSegments.length > 0) {
      // Create individual tracks for each subtitle segment
      const subtitleTracks = sortedSegments.map((segment, segmentIndex) => {
        // Convert precise seconds to frames using Math.floor for start (inclusive)
        // and Math.ceil for end (exclusive) to ensure full coverage
        const startFrame = Math.floor(segment.startTime * fps);
        const endFrame = Math.ceil(segment.endTime * fps);

        return {
          type: 'subtitle' as const,
          name: `${
            segment.text.length > 30
              ? segment.text.substring(0, 30) + '...'
              : segment.text
          }`,
          source: fileInfo.path,
          previewUrl,
          duration: endFrame - startFrame,
          startFrame,
          endFrame,
          visible: true,
          locked: false,
          color: getTrackColor(currentTrackCount + segmentIndex),
          subtitleText: segment.text,
          subtitleType: 'regular' as const, // Mark as regular imported subtitle
          trackRowIndex,
          // Store original precise timing from SRT for reference
          subtitleStartTime: segment.startTime,
          subtitleEndTime: segment.endTime,
        };
      });

      return subtitleTracks;
    }
  } catch (error) {
    console.error(
      `[FileProcessingSlice] Error parsing subtitle file${fileInfo.name}:`,
      error,
    );
  }

  return [
    {
      type: 'subtitle' as const,
      name: fileInfo.name,
      source: fileInfo.path,
      previewUrl,
      duration: 150, // 5 seconds at 30fps
      startFrame: 0,
      endFrame: 150,
      visible: true,
      locked: false,
      color: getTrackColor(currentTrackCount),
      subtitleText: `Subtitle: ${fileInfo.name}`,
      subtitleType: 'regular' as const, // Mark as regular imported subtitle
      trackRowIndex,
    },
  ];
};

const getTrackColor = (index: number) =>
  TRACK_COLORS[index % TRACK_COLORS.length];

// Result type for processImportedFile
interface ProcessImportResult {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
  importDisposition?: ImportDisposition;
  isDuplicate?: boolean;
  existingMediaId?: string;
}

// Shared helper function to process imported files
// Listen for proxy progress events
if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.onProxyProgress((_data: ProxyProgressEvent) => {
    // TODO: Dispatch update to media store if we want to show exact percentage
    // For now just log to verify progress
  });
}
const processImportedFile = async (
  fileInfo: any,
  addToLibraryFn: (item: Omit<MediaLibraryItem, 'id'>) => string,
  addToTimelineFn?: (track: Omit<VideoTrack, 'id'>) => Promise<string>,
  getFps?: () => number,
  generateSpriteFn?: (mediaId: string) => Promise<boolean>,
  generateThumbnailFn?: (mediaId: string) => Promise<boolean>,
  generateWaveformFn?: (mediaId: string) => Promise<boolean>,
  updateMediaLibraryFn?: (
    mediaId: string,
    updates: Partial<MediaLibraryItem>,
  ) => void,
  checkDuplicateFn?: (
    signature: MediaLibraryItem['contentSignature'],
  ) => MediaLibraryItem | undefined,
  handleDuplicateFn?: (
    existingMedia: MediaLibraryItem,
    signature: MediaLibraryItem['contentSignature'],
  ) => Promise<DuplicateChoice>,
): Promise<ProcessImportResult | null> => {
  // Get accurate duration using FFprobe
  // Note: For images, we use a default duration since images are static and extensible
  let actualDurationSeconds: number;
  if (fileInfo.type === 'image') {
    // Images are extensible - use a default starting duration of 5 seconds
    actualDurationSeconds = 5;
  } else {
    try {
      actualDurationSeconds = await window.electronAPI.getDuration(
        fileInfo.path,
      );
    } catch (error) {
      console.warn(
        `[FileProcessingSlice] Failed to get duration for${fileInfo.name}, using fallback:`,
        error,
      );
      actualDurationSeconds = fileInfo.type === 'audio' ? 30 : 30;
    }
  }
  // Get video dimensions (only for video and image files)
  let videoDimensions: { width: number; height: number } = {
    width: 0,
    height: 0,
  };
  let aspectRatioData: ReturnType<typeof detectAspectRatio> | undefined;

  if (fileInfo.type === 'video' || fileInfo.type === 'image') {
    try {
      videoDimensions = await window.electronAPI.getVideoDimensions(
        fileInfo.path,
      );

      // Detect aspect ratio from dimensions
      aspectRatioData = detectAspectRatio(
        videoDimensions.width,
        videoDimensions.height,
      );
    } catch (error) {
      console.warn(
        `[FileProcessingSlice] Failed to get dimensions for${fileInfo.name}, using fallback:`,
        error,
      );
      videoDimensions = { width: 1920, height: 1080 }; // sensible default
      aspectRatioData = detectAspectRatio(
        videoDimensions.width,
        videoDimensions.height,
      );
    }
  } else if (fileInfo.type === 'audio') {
    // Audio files don't have dimensions - set to zero
  }

  // Create preview URL for video, image, AND audio files
  let previewUrl: string | undefined;
  if (
    fileInfo.type === 'video' ||
    fileInfo.type === 'image' ||
    fileInfo.type === 'audio'
  ) {
    try {
      const previewResult = await window.electronAPI.createPreviewUrl(
        fileInfo.path,
      );
      if (previewResult.success) {
        previewUrl = previewResult.url;
      }
    } catch (error) {
      console.warn(
        `[FileProcessingSlice] Error creating preview URL for${fileInfo.name}:`,
        error,
      );
    }
  }

  // Determine proper MIME type and track type
  let mimeType = 'application/octet-stream';
  let trackType: 'video' | 'audio' | 'image' | 'subtitle' = fileInfo.type;

  // Check for subtitle files FIRST (override any incorrect type detection)
  if (isSubtitleFile(fileInfo.name)) {
    mimeType = `text/${fileInfo.extension}`;
    trackType = 'subtitle';
  } else if (fileInfo.type === 'video') {
    mimeType = `video/${fileInfo.extension}`;
  } else if (fileInfo.type === 'audio') {
    mimeType = `audio/${fileInfo.extension}`;
  } else if (fileInfo.type === 'image') {
    mimeType = `image/${fileInfo.extension}`;
  }

  // Generate content signature for duplicate detection
  let contentSignature: MediaLibraryItem['contentSignature'] | undefined;
  try {
    const signature = await generateContentSignatureFromPath(fileInfo.path);
    if (signature) {
      contentSignature = signature;

      // Check for duplicate if callback provided
      if (checkDuplicateFn && contentSignature) {
        const existingMedia = checkDuplicateFn(contentSignature);
        if (existingMedia) {
          // Handle duplicate - ask user what to do
          if (handleDuplicateFn) {
            const choice = await handleDuplicateFn(
              existingMedia,
              contentSignature,
            );

            if (choice === 'use-existing') {
              // User chose to use existing - return existing media info
              // Don't add to timeline again since it's already there or user just wants to skip

              return {
                id: existingMedia.id,
                name: existingMedia.name,
                type: existingMedia.mimeType,
                size: existingMedia.size,
                url: existingMedia.previewUrl || existingMedia.source,
                importDisposition: 'reused-existing',
                isDuplicate: true,
                existingMediaId: existingMedia.id,
              };
            }

            // choice === 'import-copy' - continue with import
          }
        }
      }
    }
  } catch (error) {
    console.warn(
      `[FileProcessingSlice] Failed to generate content signature for${fileInfo.name}:`,
      error,
    );
  }

  // Add to media library with appropriate metadata
  const mediaLibraryItem: Omit<MediaLibraryItem, 'id'> = {
    name: fileInfo.name,
    type: trackType,
    source: fileInfo.path,
    previewUrl,
    duration: actualDurationSeconds,
    size: fileInfo.size,
    mimeType,
    contentSignature,
    // Keep sprite sheets enabled for long-form videos.
    spriteSheetDisabled: false,
    metadata:
      trackType === 'audio'
        ? {
            // Audio-specific metadata (no dimensions)
            width: 0,
            height: 0,
            aspectRatio: undefined,
            aspectRatioLabel: null,
          }
        : {
            // Video/Image metadata with dimensions
            width: videoDimensions.width,
            height: videoDimensions.height,
            aspectRatio: aspectRatioData?.ratio,
            aspectRatioLabel: aspectRatioData?.label || null,
          },
  };

  const mediaId = addToLibraryFn(mediaLibraryItem);
  const spriteSheetDisabled = !!mediaLibraryItem.spriteSheetDisabled;

  // Show import limitation toast for video files that exceed duration/resolution thresholds
  if (trackType === 'video') {
    showImportLimitationToast(
      fileInfo.path,
      videoDimensions.width,
      videoDimensions.height,
      actualDurationSeconds,
    );
  }

  // Check for 4K video (>2K width) requiring proxy for smooth playback
  const needsProxy = trackType === 'video' && videoDimensions.width > 2000;

  if (needsProxy) {
    // Show informative toast with hardware capabilities
    (async () => {
      try {
        const hwResult = await window.electronAPI.getHardwareCapabilities();
        const encoderDesc =
          hwResult.success && hwResult.capabilities?.hasHardwareEncoder
            ? hwResult.capabilities.encoderDescription
            : 'CPU';
        const gpuEnabled =
          hwResult.success && hwResult.capabilities?.hasHardwareEncoder;

        toast.info(
          `Optimizing high-res video (${videoDimensions.width}×${videoDimensions.height})`,
          {
            description: gpuEnabled
              ? `Using ${encoderDesc} for faster processing. This may take a few minutes.`
              : `Using CPU encoding. This may take several minutes for smooth editing.`,
            duration: 5000,
          },
        );
      } catch (e) {
        // Fallback toast if hardware detection fails
        toast.info(
          `Optimizing high-res video (${videoDimensions.width}×${videoDimensions.height})`,
          {
            description:
              'Generating preview proxy for smooth editing. This may take a few minutes.',
            duration: 5000,
          },
        );
      }
    })();

    if (updateMediaLibraryFn) {
      // Mark proxy status as processing
      updateMediaLibraryFn(mediaId, {
        proxy: {
          status: 'processing',
          originalPreviewUrl: previewUrl,
        },
      });

      // Trigger background proxy generation with hybrid encoder support
      window.electronAPI
        .generateProxy(fileInfo.path)
        .then(
          async (result: {
            success: boolean;
            proxyPath?: string;
            cached?: boolean;
            encoder?: {
              type: string;
              description: string;
              fallbackUsed: boolean;
              originalEncoder?: string;
            };
            benchmark?: {
              durationMs: number;
              startTime: number;
              endTime: number;
            };
            error?: string;
          }) => {
            if (result.success && result.proxyPath) {
              // Log encoder information
              if (result.encoder) {
                void result.encoder.fallbackUsed;
              }

              void result.benchmark;

              // Create URL for the proxy file
              const proxyUrlResult = await window.electronAPI.createPreviewUrl(
                result.proxyPath,
              );

              if (proxyUrlResult.success) {
                // Update media item to use proxy URL with encoder info
                updateMediaLibraryFn(mediaId, {
                  previewUrl: proxyUrlResult.url,
                  proxy: {
                    status: 'ready',
                    path: result.proxyPath,
                    originalPreviewUrl: previewUrl,
                    encoder: result.encoder,
                    benchmarkMs: result.benchmark?.durationMs,
                  },
                });

                // Trigger deferred background jobs now that proxy is ready
                if (generateSpriteFn && !spriteSheetDisabled) {
                  generateSpriteFn(mediaId).catch((err) =>
                    console.warn(
                      '[FileProcessingSlice] Deferred sprite gen failed',
                      err,
                    ),
                  );
                } else if (spriteSheetDisabled) {
                  // Sprite generation intentionally skipped for this media item.
                }
                if (generateThumbnailFn) {
                  generateThumbnailFn(mediaId).catch((err) =>
                    console.warn(
                      '[FileProcessingSlice] Deferred thumbnail gen failed',
                      err,
                    ),
                  );
                }
              }
            } else {
              console.warn(
                '[FileProcessingSlice] Proxy generation failed',
                result.error,
              );
              updateMediaLibraryFn(mediaId, {
                proxy: { status: 'failed' },
              });

              // Fallback: If proxy fails, try generating sprites/thumbnails from original source
              // This ensures we at least have visual metadata even if performance isn't optimized

              if (generateSpriteFn) {
                generateSpriteFn(mediaId).catch((err) =>
                  console.warn(
                    '[FileProcessingSlice] Fallback sprite gen failed',
                    err,
                  ),
                );
              }
              if (generateThumbnailFn) {
                generateThumbnailFn(mediaId).catch((err) =>
                  console.warn(
                    '[FileProcessingSlice] Fallback thumbnail gen failed',
                    err,
                  ),
                );
              }
            }
          },
        )
        .catch((err: any) => {
          console.error('[FileProcessingSlice] Proxy generation error', err);
          updateMediaLibraryFn(mediaId, {
            proxy: { status: 'failed' },
          });
        });
    }
  }

  // Check if file requires transcoding (AVI, WMV, etc.)
  if (trackType === 'video') {
    // Run transcoding check synchronously (awaiting the check, but not the job)
    try {
      const transcodeCheck =
        await window.electronAPI.transcodeRequiresTranscoding(fileInfo.path);

      if (transcodeCheck.requiresTranscoding) {
        // Update media with transcoding pending status
        if (updateMediaLibraryFn) {
          updateMediaLibraryFn(mediaId, {
            transcoding: {
              required: true,
              status: 'pending',
              progress: 0,
              startedAt: Date.now(),
            },
          });
        }

        // Start transcoding in background
        const startTranscode = async () => {
          try {
            const result = await window.electronAPI.transcodeStart({
              mediaId,
              inputPath: fileInfo.path,
            });

            if (result.success && result.jobId) {
              // Update with job ID and processing status
              if (updateMediaLibraryFn) {
                updateMediaLibraryFn(mediaId, {
                  transcoding: {
                    required: true,
                    status: 'processing',
                    jobId: result.jobId,
                    progress: 0,
                    startedAt: Date.now(),
                  },
                });
              }
            } else {
              console.error(
                `[FileProcessingSlice] Failed to start transcode for${fileInfo.name}:`,
                result.error,
              );

              // Mark as failed
              if (updateMediaLibraryFn) {
                updateMediaLibraryFn(mediaId, {
                  transcoding: {
                    required: true,
                    status: 'failed',
                    progress: 0,
                    error: result.error || 'Failed to start transcoding',
                  },
                });
              }
            }
          } catch (error) {
            console.error(
              `[FileProcessingSlice] Transcode error for${fileInfo.name}:`,
              error,
            );

            if (updateMediaLibraryFn) {
              updateMediaLibraryFn(mediaId, {
                transcoding: {
                  required: true,
                  status: 'failed',
                  progress: 0,
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                },
              });
            }
          }
        };

        // Start transcoding asynchronously
        startTranscode();
      }
    } catch (error) {
      console.warn(
        `[FileProcessingSlice] Could not check transcoding requirements for${fileInfo.name}:`,
        error,
      );
    } // End try/catch for transcoding check
  }

  // Generate sprite sheets, thumbnails, and audio for video files
  // PRIORITY ORDER (to prevent FFmpeg resource starvation):
  // 1. Audio extraction (HIGH priority - fast, required for waveform)
  // 2. Waveform generation (HIGH priority - depends on audio extraction)
  // 3. Sprite sheet generation (LOW priority - slow, runs in background)
  // 4. Thumbnail generation (LOW priority - can wait)
  if (trackType === 'video') {
    // Track when audio extraction completes for coordinating dependent tasks
    let audioExtractionComplete = false;
    let audioExtractionPromise: Promise<void> | null = null;

    // STEP 1: Extract audio FIRST (highest priority)
    // Audio extraction is fast and required for waveform generation
    const extractAudioWithRetry = async (retries = 3, delay = 1000) => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const result = await window.electronAPI.extractAudioFromVideo(
            fileInfo.path,
          );

          if (result.success && result.audioPath) {
            // Update the media library item with extracted audio information
            if (updateMediaLibraryFn && result.audioPath) {
              updateMediaLibraryFn(mediaId, {
                extractedAudio: {
                  audioPath: result.audioPath,
                  previewUrl: result.previewUrl,
                  size: result.size || 0,
                  extractedAt: Date.now(),
                },
              });
            }

            audioExtractionComplete = true;
            return; // Success, exit retry loop
          } else if (
            result.error?.includes('Another FFmpeg process is already running')
          ) {
            if (attempt < retries) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue; // Retry
            } else {
              console.warn(
                `[FileProcessingSlice] Audio extraction failed after${retries} attempts for ${fileInfo.name}: ${result.error}`,
              );
            }
          } else {
            console.warn(
              `[FileProcessingSlice] Audio extraction failed for${fileInfo.name}:`,
              result.error,
            );
            return; // Non-retry error, exit
          }
        } catch (error) {
          console.warn(
            `[FileProcessingSlice] Audio extraction error for${fileInfo.name} (attempt ${attempt}):`,
            error,
          );
          if (attempt === retries) {
            console.warn(
              `[FileProcessingSlice] Audio extraction failed after${retries} attempts for ${fileInfo.name}`,
            );
          }
        }
      }
    };

    // Start audio extraction immediately (non-blocking but tracked)
    audioExtractionPromise = extractAudioWithRetry().catch((error) => {
      console.warn(
        `[FileProcessingSlice] Audio extraction retry handler failed for${fileInfo.name}:`,
        error,
      );
    });

    // STEP 2: Generate waveform (depends on audio extraction)
    if (generateWaveformFn) {
      const generateWaveformWithRetry = async () => {
        // Try cache-first waveform attach immediately (no FFmpeg), before waiting
        try {
          const immediateResult = await generateWaveformFn(mediaId);
          if (immediateResult) {
            return;
          }
        } catch (error) {
          console.warn(
            `[FileProcessingSlice] Immediate waveform cache check failed for${fileInfo.name}:`,
            error,
          );
        }

        // Wait for audio extraction to complete before starting waveform generation
        // This prevents the "Audio not yet extracted" retry loop
        if (audioExtractionPromise) {
          await audioExtractionPromise;
        }

        const maxRetries = 5; // Fewer retries needed since we wait for audio
        let retryDelay = 300; // Start with 300ms
        const maxDelay = 2000; // Cap at 2 seconds

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const result = await generateWaveformFn(mediaId);
            if (result) {
              return;
            }
          } catch (error) {
            console.warn(
              `[FileProcessingSlice] Waveform generation attempt${attempt}/${maxRetries} failed for ${fileInfo.name}:`,
              error,
            );
          }

          if (attempt < maxRetries) {
            const jitter = Math.random() * 100;
            await new Promise((resolve) =>
              setTimeout(resolve, retryDelay + jitter),
            );
            retryDelay = Math.min(retryDelay * 1.5, maxDelay);
          }
        }

        console.warn(
          `[FileProcessingSlice] Waveform generation failed after${maxRetries} retries for ${fileInfo.name}`,
        );
        if (updateMediaLibraryFn) {
          updateMediaLibraryFn(mediaId, {
            waveform: {
              success: false,
              peaks: [],
              duration: 0,
              sampleRate: 0,
              cacheKey: 'failed',
              generatedAt: Date.now(),
            },
          });
        }
      };

      // Start waveform generation (will wait for audio extraction internally)
      generateWaveformWithRetry().catch((error) => {
        console.warn(
          `[FileProcessingSlice] Waveform generation retry handler failed for${fileInfo.name}:`,
          error,
        );
      });
    }

    // STEP 3: Generate sprite sheets AFTER audio tasks start (lower priority)
    // Skip if we are generating a proxy - the proxy success handler will trigger these later
    if (!needsProxy) {
      if (generateSpriteFn && !spriteSheetDisabled) {
        // Delay sprite sheet generation to give audio extraction priority
        // This prevents FFmpeg resource contention
        setTimeout(() => {
          generateSpriteFn(mediaId).catch((error) => {
            console.warn(
              `[FileProcessingSlice] Sprite sheet generation failed for${fileInfo.name}:`,
              error,
            );
            if (updateMediaLibraryFn) {
              updateMediaLibraryFn(mediaId, {
                spriteSheets: {
                  success: false,
                  spriteSheets: [],
                  cacheKey: 'failed',
                  generatedAt: Date.now(),
                },
              });
            }
          });
        }, 500); // 500ms delay to let audio extraction start and potentially complete
      } else if (spriteSheetDisabled) {
        // Sprite generation intentionally skipped for this media item.
      }

      // STEP 4: Generate thumbnail (lowest priority, can run alongside sprites)
      if (generateThumbnailFn) {
        setTimeout(() => {
          generateThumbnailFn(mediaId).catch((error) => {
            console.warn(
              `[FileProcessingSlice] Thumbnail generation failed for${fileInfo.name}:`,
              error,
            );
          });
        }, 600); // Slightly after sprite sheets
      }
    }
  }

  // Generate waveform for direct audio files with retry logic
  // Uses same retry mechanism as video files to handle race conditions
  // where the media library item may not be fully populated yet
  if (trackType === 'audio' && generateWaveformFn) {
    const generateWaveformWithRetry = async () => {
      const maxRetries = 5; // Fewer retries needed for audio (no extraction step)
      let retryDelay = 300; // Start with 300ms
      const maxDelay = 2000; // Cap at 2 seconds

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await generateWaveformFn(mediaId);
          if (result) {
            return;
          }
        } catch (error) {
          console.warn(
            `[FileProcessingSlice] Waveform generation attempt${attempt}/${maxRetries} failed for ${fileInfo.name}:`,
            error,
          );
        }

        if (attempt < maxRetries) {
          // Exponential backoff with jitter
          const jitter = Math.random() * 100;
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelay + jitter),
          );
          retryDelay = Math.min(retryDelay * 1.5, maxDelay);
        }
      }

      console.warn(
        `[FileProcessingSlice] Waveform generation failed after${maxRetries} retries for ${fileInfo.name}`,
      );
      if (updateMediaLibraryFn) {
        updateMediaLibraryFn(mediaId, {
          waveform: {
            success: false,
            peaks: [],
            duration: 0,
            sampleRate: 0,
            cacheKey: 'failed',
            generatedAt: Date.now(),
          },
        });
      }
    };

    // Start generation with small delay to ensure media library item is populated
    setTimeout(() => {
      generateWaveformWithRetry().catch((error) => {
        console.warn(
          `[FileProcessingSlice] Waveform generation retry handler failed for${fileInfo.name}:`,
          error,
        );
      });
    }, 50); // Small delay to ensure store update completes
  }

  // Add to timeline if requested
  if (addToTimelineFn && getFps) {
    const fps = getFps();

    if (trackType === 'subtitle' && isSubtitleFile(fileInfo.name)) {
      // Handle subtitle files specially
      try {
        const subtitleContent = await window.electronAPI.readFile(
          fileInfo.path,
        );
        if (subtitleContent) {
          const subtitleTracks = await processSubtitleFile(
            fileInfo,
            subtitleContent,
            0, // Will be repositioned by addTrack
            fps,
            1,
            previewUrl,
          );

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const [_index, track] of subtitleTracks.entries()) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            await addToTimelineFn(track);
          }
        }
      } catch (error) {
        console.error(
          '[FileProcessingSlice] Error processing subtitle file',
          error,
        );
        // Add single fallback track - Use precise duration calculation
        const duration = Math.floor(actualDurationSeconds * fps);
        await addToTimelineFn({
          type: 'subtitle',
          name: fileInfo.name,
          source: fileInfo.path,
          previewUrl,
          duration,
          startFrame: 0,
          endFrame: duration,
          visible: true,
          locked: false,
          color: getTrackColor(0),
          subtitleText: `Subtitle: ${fileInfo.name}`,
          subtitleType: 'regular' as const, // Mark as regular imported subtitle
          trackRowIndex: 1,
        });
      }
    } else {
      // Add regular media to timeline - Use precise duration calculation
      const duration = Math.floor(actualDurationSeconds * fps);
      await addToTimelineFn({
        type: trackType,
        name: fileInfo.name,
        source: fileInfo.path,
        previewUrl,
        duration,
        startFrame: 0,
        endFrame: duration,
        visible: true,
        locked: false,
        color: getTrackColor(0),
        // Include dimension and aspect ratio information
        width: videoDimensions.width,
        height: videoDimensions.height,
        aspectRatio: aspectRatioData?.ratio,
        detectedAspectRatioLabel: aspectRatioData?.label || undefined,
      });
    }
  }

  return {
    id: mediaId,
    name: fileInfo.name,
    type: mimeType,
    size: fileInfo.size,
    url: previewUrl || fileInfo.path,
    importDisposition: 'imported-new',
  };
};

// Track ongoing import operations to prevent duplicate imports
// Key is a hash of file names and sizes
const ongoingImports = new Map<string, Promise<ImportResult>>();

const buildImportSummary = (
  importedFiles: ImportResult['importedFiles'],
): NonNullable<ImportResult['summary']> => {
  const summary = {
    importedNew: 0,
    importedCopies: 0,
    reusedExisting: 0,
    totalImportedEntries: importedFiles.length,
  };

  importedFiles.forEach((file) => {
    switch (file.importDisposition) {
      case 'reused-existing':
        summary.reusedExisting += 1;
        break;
      case 'imported-copy':
        summary.importedCopies += 1;
        break;
      case 'imported-new':
      default:
        summary.importedNew += 1;
        break;
    }
  });

  return summary;
};

const scanFilesForDuplicates = async (
  files: Array<{ name: string; path: string }>,
  storeState: any,
): Promise<{
  duplicatesToHandle: DuplicateItem[];
  fileSignatures: Map<string, { signature: any; existingMedia: any }>;
}> => {
  const duplicatesToHandle: DuplicateItem[] = [];
  const fileSignatures = new Map<
    string,
    { signature: any; existingMedia: any }
  >();

  await Promise.all(
    files.map(async (fileInfo) => {
      try {
        // Primary duplicate detection: absolute file path.
        const existingByPath = storeState.findDuplicateByPath?.(fileInfo.path);
        if (existingByPath) {
          duplicatesToHandle.push({
            id: `dup-${fileInfo.name}-${Date.now()}-${Math.random()}`,
            pendingFileName: fileInfo.name,
            pendingFilePath: fileInfo.path,
            existingMedia: existingByPath,
            signature: existingByPath.contentSignature,
          });
          fileSignatures.set(fileInfo.path, {
            signature: existingByPath.contentSignature,
            existingMedia: existingByPath,
          });
          return;
        }

        // Secondary duplicate detection: content signature.
        const signature = await generateContentSignatureFromPath(fileInfo.path);
        const existingBySignature = signature
          ? storeState.findDuplicateBySignature?.(signature)
          : undefined;

        if (existingBySignature) {
          duplicatesToHandle.push({
            id: `dup-${fileInfo.name}-${Date.now()}-${Math.random()}`,
            pendingFileName: fileInfo.name,
            pendingFilePath: fileInfo.path,
            existingMedia: existingBySignature,
            signature,
          });
        }

        fileSignatures.set(fileInfo.path, {
          signature,
          existingMedia: existingBySignature,
        });
      } catch (error) {
        console.warn(
          `[FileProcessingSlice] Failed to check duplicate for${fileInfo.name}:`,
          error,
        );
      }
    }),
  );

  return { duplicatesToHandle, fileSignatures };
};

const resolveDuplicateChoicesByPath = async (
  duplicatesToHandle: DuplicateItem[],
  showBatchDuplicateDialog?: (
    duplicates: DuplicateItem[],
    resolve: (choices: Map<string, DuplicateChoice>) => void,
  ) => void,
): Promise<{
  pathToChoice: Map<string, DuplicateChoice>;
}> => {
  const pathToChoice = new Map<string, DuplicateChoice>();

  if (duplicatesToHandle.length === 0) {
    return { pathToChoice };
  }

  if (!showBatchDuplicateDialog) {
    duplicatesToHandle.forEach((dup) => {
      if (dup.pendingFilePath) {
        pathToChoice.set(dup.pendingFilePath, 'use-existing');
      }
    });
    return { pathToChoice };
  }

  const choices = await new Promise<Map<string, DuplicateChoice>>((resolve) => {
    showBatchDuplicateDialog(duplicatesToHandle, resolve);
  });

  duplicatesToHandle.forEach((dup) => {
    if (!dup.pendingFilePath) return;
    const choice = choices.get(dup.id) ?? 'use-existing';
    pathToChoice.set(dup.pendingFilePath, choice);
  });

  return { pathToChoice };
};

export const createFileProcessingSlice: StateCreator<
  FileProcessingSlice,
  [],
  [],
  FileProcessingSlice
> = (set, get) => ({
  importMediaFromDialog: async (): Promise<ImportResult> => {
    try {
      // Use Electron's native file dialog
      const result = await window.electronAPI.openFileDialog({
        title: 'Select Media Files',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Media Files',
            extensions: [
              'mp4',
              'avi',
              'mov',
              'mkv',
              'mp3',
              'wav',
              'aac',
              'jpg',
              'jpeg',
              'png',
              'gif',
              'srt',
              'vtt',
              'ass',
              'ssa',
              'sub',
              'sbv',
              'lrc',
            ],
          },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (
        !result.success ||
        result.canceled ||
        !result.files ||
        result.files.length === 0
      ) {
        return { success: false, importedFiles: [] };
      }

      // STEP 1: Validate files BEFORE any processing
      // Convert file paths to File objects for validation
      const fileObjects = await Promise.all(
        result.files.map(async (fileInfo) => {
          try {
            // Read file from disk as ArrayBuffer
            const fileBuffer = await window.electronAPI.readFileAsBuffer(
              fileInfo.path,
            );
            // Create File object from buffer for validation
            return new File([fileBuffer], fileInfo.name, {
              type: fileInfo.type || 'application/octet-stream',
            });
          } catch (error) {
            console.error(
              `[FileProcessingSlice] Failed to read file${fileInfo.name} for validation:`,
              error,
            );
            return null;
          }
        }),
      );

      // Filter out null values (files that couldn't be read)
      const validFileObjects = fileObjects.filter(
        (file): file is File => file !== null,
      );

      if (validFileObjects.length === 0) {
        console.error(
          '[FileProcessingSlice] No files could be read for validation',
        );
        return {
          success: false,
          importedFiles: [],
          error: 'Failed to read selected files',
        };
      }

      // Validate all files
      const validationResults = await FileIntegrityValidator.validateFiles(
        validFileObjects,
        (_completed, _total) => undefined,
      );

      // Separate valid and invalid files
      const validFileIndices: number[] = [];
      const rejectedFiles: Array<{
        name: string;
        reason: string;
        error?: string;
      }> = [];

      validationResults.forEach((validationResult, file) => {
        const originalIndex = validFileObjects.indexOf(file);
        if (validationResult.isValid) {
          validFileIndices.push(originalIndex);
        } else {
          const reason = validationResult.error || 'File validation failed';
          rejectedFiles.push({
            name: file.name,
            reason,
            error: reason,
          });
          console.warn(
            `[FileProcessingSlice] Rejected${file.name} - ${reason}`,
          );
        }
      });

      // If no valid files, return early with rejection info
      if (validFileIndices.length === 0) {
        console.warn(
          '[FileProcessingSlice] No valid files to import (all rejected)',
        );
        return {
          success: false,
          importedFiles: [],
          rejectedFiles,
          error: 'All files were rejected due to corruption or invalid format',
        };
      }

      // STEP 2: Process only valid files

      const importedFiles: ImportResult['importedFiles'] = [];

      // Start undo group for batch import
      const state = get() as any;
      state.beginGroup?.('Import Media');

      try {
        // Get valid files to process
        const validFiles = validFileIndices.map((i) => result.files[i]);

        // STEP 1: Scan ALL files for duplicates first.
        const storeState = get() as any;
        const { duplicatesToHandle, fileSignatures } =
          await scanFilesForDuplicates(validFiles, storeState);

        // STEP 2: Ask user how to handle duplicates (use existing/import anyway).
        const { pathToChoice } = await resolveDuplicateChoicesByPath(
          duplicatesToHandle,
          storeState.showBatchDuplicateDialog,
        );

        // STEP 3: Process files with pre-determined duplicate choices (Parallelized)
        await Promise.all(
          validFiles.map(async (fileInfo) => {
            try {
              const sigInfo = fileSignatures.get(fileInfo.path);
              const duplicateChoice = pathToChoice.get(fileInfo.path);

              // If duplicate and user chose use-existing (skip), add existing to results
              if (
                duplicateChoice === 'use-existing' &&
                sigInfo?.existingMedia
              ) {
                importedFiles.push({
                  id: sigInfo.existingMedia.id,
                  name: sigInfo.existingMedia.name,
                  type: sigInfo.existingMedia.mimeType,
                  size: sigInfo.existingMedia.size,
                  url:
                    sigInfo.existingMedia.previewUrl ||
                    sigInfo.existingMedia.source,
                  importDisposition: 'reused-existing',
                  isDuplicate: true,
                });
                return;
              }

              // Otherwise, import the file
              const currentState = get() as any;
              const fileData = await processImportedFile(
                fileInfo,
                currentState.addToMediaLibrary,
                undefined, // No timeline addition
                () => currentState.timeline.fps,
                currentState.generateSpriteSheetForMedia,
                currentState.generateThumbnailForMedia,
                currentState.generateWaveformForMedia,
                currentState.updateMediaLibraryItem,
                undefined, // Skip duplicate detection - already handled
                undefined,
              );

              if (fileData) {
                importedFiles.push({
                  ...fileData,
                  importDisposition:
                    duplicateChoice === 'import-copy'
                      ? 'imported-copy'
                      : (fileData.importDisposition ?? 'imported-new'),
                  isDuplicate:
                    duplicateChoice === 'import-copy'
                      ? true
                      : fileData.isDuplicate,
                });
              }
            } catch (error: any) {
              console.error(
                `[FileProcessingSlice] Failed to import${fileInfo.name}:`,
                error,
              );
              rejectedFiles.push({
                name: fileInfo.name,
                reason: error.message || 'Failed to process file',
                error: error.message || 'Failed to process file',
              });
            }
          }),
        );

        if (rejectedFiles.length > 0) {
          console.warn(
            `[FileProcessingSlice] Rejected${rejectedFiles.length} files`,
          );
        }

        return {
          success: true,
          importedFiles,
          summary: buildImportSummary(importedFiles),
          rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
        };
      } finally {
        // End undo group
        state.endGroup?.();
      }
    } catch (error: any) {
      console.error(
        '[FileProcessingSlice] Failed to import media from dialog',
        error,
      );
      return {
        success: false,
        importedFiles: [],
        error: error.message || 'Unknown error occurred',
      };
    }
  },

  importMediaFromFiles: async (files: File[]): Promise<void> => {
    if (!files || files.length === 0) {
      return;
    }

    // Legacy external-drop entry point now uses the centralized registry-first flow.
    const result = await (get() as any).importMediaToTimeline(files);
    if (!result.success) {
      console.warn(
        '[FileProcessingSlice] Failed to import media from files',
        result.error,
      );
    }
  },

  importMediaFromDrop: async (files: File[]): Promise<ImportResult> => {
    try {
      // Generate a unique key for this import operation based on file names and sizes
      // This prevents duplicate imports when multiple drop handlers are triggered
      const importKey = files
        .map((f) => `${f.name}:${f.size}:${f.lastModified}`)
        .sort()
        .join('|');

      // Check if this exact import is already in progress
      if (ongoingImports.has(importKey)) {
        const existingImport = ongoingImports.get(importKey);
        if (existingImport) {
          return existingImport;
        }
      }

      // Create and store the import promise to prevent duplicate processing
      const importPromise = (async (): Promise<ImportResult> => {
        try {
          // STEP 1: Validate files BEFORE any processing
          const validationResults = await FileIntegrityValidator.validateFiles(
            files,
            (_completed, _total) => undefined,
          );

          // Separate valid and invalid files
          const validFiles: File[] = [];
          const rejectedFiles: Array<{
            name: string;
            reason: string;
            error?: string;
          }> = [];

          validationResults.forEach((result, file) => {
            if (result.isValid) {
              validFiles.push(file);
            } else {
              const reason = result.error || 'File validation failed';
              rejectedFiles.push({
                name: file.name,
                reason,
                error: reason,
              });
              console.warn(
                `[FileProcessingSlice] Rejected${file.name} - ${reason}`,
              );
            }
          });

          // If no valid files, return early with rejection info
          if (validFiles.length === 0) {
            console.warn(
              '[FileProcessingSlice] No valid files to import (all rejected)',
            );
            return {
              success: false,
              importedFiles: [],
              rejectedFiles,
              error:
                'All files were rejected due to corruption or invalid format',
            };
          }

          // STEP 2: Process only valid files

          // Convert File objects to ArrayBuffers for IPC transfer
          const fileBuffers = await Promise.all(
            validFiles.map(async (file) => {
              const buffer = await file.arrayBuffer();
              return {
                name: file.name,
                type: file.type,
                size: file.size,
                buffer,
              };
            }),
          );

          // Process files in main process to get real file paths
          const result =
            await window.electronAPI.processDroppedFiles(fileBuffers);

          if (!result.success) {
            console.error(
              '[FileProcessingSlice] Failed to process files in main process',
              result.error,
            );
            return {
              success: false,
              importedFiles: [],
              rejectedFiles,
              error: result.error || 'Failed to process files',
            };
          }

          const importedFiles: ImportResult['importedFiles'] = [];

          // Start undo group for batch import
          const state = get() as any;
          state.beginGroup?.('Import Media');

          try {
            // STEP 1: Scan ALL files for duplicates first.
            const storeState = get() as any;
            const { duplicatesToHandle, fileSignatures } =
              await scanFilesForDuplicates(result.files, storeState);

            // STEP 2: Ask user how to handle duplicates (use existing/import anyway).
            const { pathToChoice } = await resolveDuplicateChoicesByPath(
              duplicatesToHandle,
              storeState.showBatchDuplicateDialog,
            );

            // STEP 3: Process files with pre-determined duplicate choices (Parallelized)
            await Promise.all(
              result.files.map(async (fileInfo) => {
                try {
                  const sigInfo = fileSignatures.get(fileInfo.path);
                  const duplicateChoice = pathToChoice.get(fileInfo.path);

                  // If duplicate and user chose use-existing, add existing to results
                  if (
                    duplicateChoice === 'use-existing' &&
                    sigInfo?.existingMedia
                  ) {
                    importedFiles.push({
                      id: sigInfo.existingMedia.id,
                      name: sigInfo.existingMedia.name,
                      type: sigInfo.existingMedia.mimeType,
                      size: sigInfo.existingMedia.size,
                      url:
                        sigInfo.existingMedia.previewUrl ||
                        sigInfo.existingMedia.source,
                      importDisposition: 'reused-existing',
                      isDuplicate: true,
                    });
                    return;
                  }

                  // Otherwise, import the file
                  const currentState = get() as any;
                  const fileData = await processImportedFile(
                    fileInfo,
                    currentState.addToMediaLibrary,
                    undefined, // No timeline addition
                    () => currentState.timeline.fps,
                    currentState.generateSpriteSheetForMedia,
                    currentState.generateThumbnailForMedia,
                    currentState.generateWaveformForMedia,
                    currentState.updateMediaLibraryItem,
                    undefined, // Skip duplicate detection - already handled
                    undefined,
                  );

                  if (fileData) {
                    importedFiles.push({
                      ...fileData,
                      importDisposition:
                        duplicateChoice === 'import-copy'
                          ? 'imported-copy'
                          : (fileData.importDisposition ?? 'imported-new'),
                      isDuplicate:
                        duplicateChoice === 'import-copy'
                          ? true
                          : fileData.isDuplicate,
                    });
                  }
                } catch (error: any) {
                  console.error(
                    `[FileProcessingSlice] Failed to import${fileInfo.name}:`,
                    error,
                  );
                  rejectedFiles.push({
                    name: fileInfo.name,
                    reason: error.message || 'Failed to process file',
                    error: error.message || 'Failed to process file',
                  });
                }
              }),
            );

            if (rejectedFiles.length > 0) {
              console.warn(
                `[FileProcessingSlice] Rejected${rejectedFiles.length} files`,
              );
            }

            return {
              success: true,
              importedFiles,
              summary: buildImportSummary(importedFiles),
              rejectedFiles:
                rejectedFiles.length > 0 ? rejectedFiles : undefined,
            };
          } finally {
            // End undo group
            state.endGroup?.();
          }
        } catch (error: any) {
          console.error(
            '[FileProcessingSlice] Failed to import media from drop',
            error,
          );
          return {
            success: false,
            importedFiles: [],
            error: error.message || 'Unknown error occurred',
          };
        } finally {
          // Clean up the import lock after completion (success or failure)
          ongoingImports.delete(importKey);
        }
      })();

      // Store the promise to prevent duplicate imports
      ongoingImports.set(importKey, importPromise);

      // Return the promise result
      return await importPromise;
    } catch (error: any) {
      console.error(
        '[FileProcessingSlice] Failed to import media from drop (outer catch)',
        error,
      );
      return {
        success: false,
        importedFiles: [],
        error: error.message || 'Unknown error occurred',
      };
    }
  },

  importMediaToTimeline: async (files: File[]): Promise<ImportResult> => {
    try {
      // Generate a unique key for this import operation based on file names and sizes
      // This prevents duplicate imports when multiple drop handlers are triggered
      const importKey = files
        .map((f) => `${f.name}:${f.size}:${f.lastModified}`)
        .sort()
        .join('|');

      // Check if this exact import is already in progress
      if (ongoingImports.has(importKey)) {
        const existingImport = ongoingImports.get(importKey);
        if (existingImport) {
          return existingImport;
        }
      }

      // Create and store the import promise to prevent duplicate processing
      const importPromise = (async (): Promise<ImportResult> => {
        try {
          // STEP 1: Validate files BEFORE any processing
          const validationResults = await FileIntegrityValidator.validateFiles(
            files,
            (_completed, _total) => undefined,
          );

          // Separate valid and invalid files
          const validFiles: File[] = [];
          const rejectedFiles: Array<{
            name: string;
            reason: string;
            error?: string;
          }> = [];

          validationResults.forEach((result, file) => {
            if (result.isValid) {
              validFiles.push(file);
            } else {
              const reason = result.error || 'File validation failed';
              rejectedFiles.push({
                name: file.name,
                reason,
                error: reason,
              });
              console.warn(
                `[FileProcessingSlice] Rejected${file.name} - ${reason}`,
              );
            }
          });

          // If no valid files, return early
          if (validFiles.length === 0) {
            console.warn(
              '[FileProcessingSlice] No valid files to import (all rejected)',
            );
            return {
              success: false,
              importedFiles: [],
              rejectedFiles,
              error:
                'All files were rejected due to corruption or invalid format',
            };
          }

          // STEP 2: Process only valid files

          // Convert File objects to ArrayBuffers for IPC transfer
          const fileBuffers = await Promise.all(
            validFiles.map(async (file) => {
              const buffer = await file.arrayBuffer();
              return {
                name: file.name,
                type: file.type,
                size: file.size,
                buffer,
              };
            }),
          );

          // Process files in main process
          const result =
            await window.electronAPI.processDroppedFiles(fileBuffers);

          if (!result.success) {
            console.error(
              '[FileProcessingSlice] Failed to process files in main process',
              result.error,
            );
            return {
              success: false,
              importedFiles: [],
              rejectedFiles,
              error: result.error || 'Failed to process files',
            };
          }

          const importedFiles: ImportResult['importedFiles'] = [];

          // Start undo group for batch import to timeline
          const state = get() as any;
          state.beginGroup?.('Import Media to Timeline');

          try {
            // STEP 1: Scan ALL files for duplicates first.
            const storeState = get() as any;
            const { duplicatesToHandle, fileSignatures } =
              await scanFilesForDuplicates(result.files, storeState);

            // STEP 2: Ask user how to handle duplicates (use existing/import anyway).
            const { pathToChoice } = await resolveDuplicateChoicesByPath(
              duplicatesToHandle,
              storeState.showBatchDuplicateDialog,
            );

            // STEP 3: Process files with pre-determined duplicate choices
            const mediaIdsToAddToTimeline: string[] = [];

            for (const fileInfo of result.files) {
              try {
                const sigInfo = fileSignatures.get(fileInfo.path);
                const duplicateChoice = pathToChoice.get(fileInfo.path);

                // If this is a duplicate and user chose to use existing, add existing to results
                if (
                  duplicateChoice === 'use-existing' &&
                  sigInfo?.existingMedia
                ) {
                  importedFiles.push({
                    id: sigInfo.existingMedia.id,
                    name: sigInfo.existingMedia.name,
                    type: sigInfo.existingMedia.mimeType,
                    size: sigInfo.existingMedia.size,
                    url:
                      sigInfo.existingMedia.previewUrl ||
                      sigInfo.existingMedia.source,
                    importDisposition: 'reused-existing',
                    isDuplicate: true,
                  });
                  // Reuse existing media entry and still create a timeline clip.
                  mediaIdsToAddToTimeline.push(sigInfo.existingMedia.id);
                  continue;
                }

                // Otherwise, import the file (either not a duplicate, or user chose import-copy)
                const currentState = get() as any;
                const fileData = await processImportedFile(
                  fileInfo,
                  currentState.addToMediaLibrary,
                  undefined, // Do NOT add to timeline yet - we'll do that separately
                  () => currentState.timeline.fps,
                  currentState.generateSpriteSheetForMedia,
                  currentState.generateThumbnailForMedia,
                  currentState.generateWaveformForMedia,
                  currentState.updateMediaLibraryItem,
                  // Skip duplicate detection since we already handled it
                  undefined,
                  undefined,
                );

                if (fileData === null) {
                  continue;
                }

                importedFiles.push({
                  ...fileData,
                  importDisposition:
                    duplicateChoice === 'import-copy'
                      ? 'imported-copy'
                      : (fileData.importDisposition ?? 'imported-new'),
                  isDuplicate:
                    duplicateChoice === 'import-copy'
                      ? true
                      : fileData.isDuplicate,
                });
                mediaIdsToAddToTimeline.push(fileData.id);
              } catch (error: any) {
                console.error(
                  `[FileProcessingSlice] Failed to import${fileInfo.name}:`,
                  error,
                );
                rejectedFiles.push({
                  name: fileInfo.name,
                  reason: error.message || 'Failed to process file',
                  error: error.message || 'Failed to process file',
                });
              }
            }

            // STEP 2: Add successfully imported media to timeline using addTrackFromMediaLibrary
            // This ensures we reuse cached sprites/waveforms and avoid duplicate track creation
            // CRITICAL: Process SEQUENTIALLY to ensure each file gets a unique row index
            // (especially important for subtitle files which need separate rows per file)
            if (mediaIdsToAddToTimeline.length > 0) {
              const timelineResults: Array<{
                success: boolean;
                mediaId: string;
                error?: string;
              }> = [];

              // Process sequentially to ensure each file gets fresh state for row calculation
              for (const mediaId of mediaIdsToAddToTimeline) {
                try {
                  const currentState = get() as any;
                  const mediaItem = currentState.mediaLibrary.find(
                    (m: any) => m.id === mediaId,
                  );

                  // Check if transcoding is required/active
                  if (
                    mediaItem?.transcoding?.status === 'pending' ||
                    mediaItem?.transcoding?.status === 'processing'
                  ) {
                    currentState.setTranscodingBlockedMedia(mediaItem);
                    continue; // Skip adding to timeline
                  }

                  await (get() as any).addTrackFromMediaLibrary(mediaId, 0);
                  timelineResults.push({ success: true, mediaId });
                } catch (error: any) {
                  console.error(
                    `[FileProcessingSlice] Failed to add to timeline${mediaId}:`,
                    error,
                  );
                  timelineResults.push({
                    success: false,
                    mediaId,
                    error: error.message,
                  });
                }
              }

              // Log any timeline addition failures (shouldn't happen, but log for debugging)
              timelineResults.forEach((result) => {
                if (!result.success) {
                  console.warn(
                    `[FileProcessingSlice] Media imported to library but failed to add to timeline${result.mediaId}`,
                  );
                }
              });
            }
            if (rejectedFiles.length > 0) {
              console.warn(
                `[FileProcessingSlice] Rejected${rejectedFiles.length} files`,
              );
            }

            return {
              success: true,
              importedFiles,
              summary: buildImportSummary(importedFiles),
              rejectedFiles:
                rejectedFiles.length > 0 ? rejectedFiles : undefined,
            };
          } finally {
            // End undo group
            state.endGroup?.();
          }
        } catch (error: any) {
          console.error(
            '[FileProcessingSlice] Failed to import media to timeline',
            error,
          );
          return {
            success: false,
            importedFiles: [],
            error: error.message || 'Unknown error occurred',
          };
        } finally {
          // Clean up the import lock after completion (success or failure)
          ongoingImports.delete(importKey);
        }
      })();

      // Store the promise to prevent duplicate imports
      ongoingImports.set(importKey, importPromise);

      // Return the promise result
      return await importPromise;
    } catch (error: any) {
      console.error(
        '[FileProcessingSlice] Failed to import media to timeline (outer catch)',
        error,
      );
      return {
        success: false,
        importedFiles: [],
        error: error.message || 'Unknown error occurred',
      };
    }
  },
});

export type { FileProcessingSlice };
