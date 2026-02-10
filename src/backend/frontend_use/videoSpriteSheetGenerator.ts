import { VideoTrack } from '@/frontend/features/editor/stores/videoEditor/index';

import { toMediaServerUrl } from '@/shared/utils/mediaServer';

export interface SpriteSheetOptions {
  videoPath: string;
  /** Optional content-based signature for stable caching across reimports */
  contentSignature?: string;
  duration: number; // in seconds
  fps: number;
  thumbWidth?: number; // Width of each thumbnail (default: 120)
  thumbHeight?: number; // Height of each thumbnail (default: 68)
  maxThumbnailsPerSheet?: number; // Max thumbnails per sprite sheet (default: 100)
  sourceStartTime?: number; // Start time in source video (default: 0)
  intervalSeconds?: number; // Generate thumbnail every N seconds (default: auto-calculated)
}

export interface SpriteSheetThumbnail {
  id: string;
  timestamp: number; // in seconds (relative to track)
  frameNumber: number;
  sheetIndex: number; // Which sprite sheet contains this thumbnail
  x: number; // X position in sprite sheet
  y: number; // Y position in sprite sheet
  width: number;
  height: number;
}

export interface SpriteSheet {
  id: string;
  url: string;
  width: number;
  height: number;
  thumbnailsPerRow: number;
  thumbnailsPerColumn: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  thumbnails: SpriteSheetThumbnail[];
}

export interface SpriteSheetGenerationResult {
  success: boolean;
  spriteSheets: SpriteSheet[];
  error?: string;
  cacheKey: string;
}

// Persistent cache interface for sprite sheets
interface SpriteSheetCacheEntry {
  result: SpriteSheetGenerationResult;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  fileSize: number;
  videoPath: string;
}

export class VideoSpriteSheetGenerator {
  private static spriteSheetCache = new Map<
    string,
    SpriteSheetGenerationResult
  >();
  private static activeGenerations = new Map<
    string,
    Promise<SpriteSheetGenerationResult>
  >();
  private static cacheAccessTimes = new Map<string, number>();
  private static readonly MAX_CACHE_SIZE = 15; // Reduced to handle larger sprite sheets
  private static readonly CACHE_STORAGE_KEY = 'dividr_sprite_cache';
  private static readonly MAX_CACHE_AGE_DAYS = 7; // Cache expires after 7 days
  private static cacheInitialized = false;
  private static cacheValidationTimer: ReturnType<typeof setInterval> | null =
    null;
  private static isSignatureKey(cacheKey: string): boolean {
    return cacheKey.startsWith('sprite_png_v4_sig_');
  }

  /**
   * Get precise video metadata using FFprobe
   */
  private static async getVideoMetadata(videoPath: string): Promise<{
    duration: number;
    fps: number;
    frameCount: number;
  }> {
    try {
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Video metadata requires Electron environment');
      }

      // Validate videoPath before proceeding
      if (!videoPath || typeof videoPath !== 'string') {
        console.error(
          '[VideoSpriteSheetGenerator] Invalid videoPath provided to getVideoMetadata',
          videoPath,
        );
        throw new Error(`Invalid video path: ${videoPath}`);
      }

      const durationPromise = window.electronAPI.getDuration(videoPath);
      const fpsPromise = window.electronAPI.invoke(
        'ffmpeg:detect-frame-rate',
        videoPath,
      );

      const [durationResult, fpsResult] = await Promise.allSettled([
        durationPromise,
        fpsPromise,
      ]);

      const rawDuration =
        durationResult.status === 'fulfilled' ? durationResult.value : 0;
      const rawFps = fpsResult.status === 'fulfilled' ? fpsResult.value : 30;
      const duration = Number.isFinite(rawDuration) ? rawDuration : 0;
      const fps = Number.isFinite(rawFps) && rawFps > 0 ? rawFps : 30;

      // Calculate exact frame count
      const frameCount = Math.floor(duration * fps);

      console.log(
        `[VideoSpriteSheetGenerator] Video metadata for${videoPath.split(/[\\/]/).pop()}:`,
      );
      console.log(
        `[VideoSpriteSheetGenerator] • Duration${duration.toFixed(3)}s`,
      );
      console.log(`[VideoSpriteSheetGenerator] • FPS${fps.toFixed(3)}`);
      console.log(`[VideoSpriteSheetGenerator] • Frame count${frameCount}`);

      return { duration, fps, frameCount };
    } catch (error) {
      console.warn(
        '[VideoSpriteSheetGenerator] Failed to get precise video metadata, using fallback',
        error,
      );
      // Fallback to provided values
      return { duration: 0, fps: 30, frameCount: 0 };
    }
  }

  /**
   * Initialize persistent cache from localStorage
   */
  private static async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return;

    try {
      // Try to load from localStorage if available
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = window.localStorage.getItem(this.CACHE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Record<
            string,
            SpriteSheetCacheEntry
          >;
          const now = Date.now();
          const maxAge = this.MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000;

          // Filter out expired entries and validate URLs
          for (const [key, entry] of Object.entries(parsed)) {
            if (this.isSignatureKey(key) || now - entry.timestamp < maxAge) {
              // Validate that sprite sheet URLs are still accessible
              const isValid = await this.validateCacheEntry(entry.result);
              if (isValid) {
                this.spriteSheetCache.set(key, entry.result);
                this.cacheAccessTimes.set(key, entry.lastAccessed);
              }
            }
          }

          console.log(
            `[VideoSpriteSheetGenerator] Loaded${this.spriteSheetCache.size} valid sprite sheet cache entries`,
          );
        }
      }
    } catch (error) {
      console.warn(
        '[VideoSpriteSheetGenerator] Failed to load sprite sheet cache from storage',
        error,
      );
    }

    this.cacheInitialized = true;
    this.scheduleCacheValidation();
  }

  private static joinPath(...parts: string[]): string {
    if (parts.length === 0) return '';
    return parts
      .filter((part) => part && part.length > 0)
      .map((part, index) => {
        if (index === 0) {
          return part.replace(/[\\/]+$/, '');
        }
        return part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
      })
      .join('/');
  }

  private static async getMediaCacheBaseDir(): Promise<string> {
    if (
      typeof window === 'undefined' ||
      !window.electronAPI?.getMediaCacheDir
    ) {
      return 'public';
    }

    try {
      const result = await window.electronAPI.getMediaCacheDir();
      if (result?.success && result.path) {
        return result.path;
      }
    } catch (error) {
      console.warn(
        '[VideoSpriteSheetGenerator] Failed to get media cache directory',
        error,
      );
    }

    return 'public';
  }

  private static async mediaPathExists(pathOrUrl: string): Promise<boolean> {
    if (!pathOrUrl) return false;

    if (typeof window !== 'undefined' && window.electronAPI?.mediaPathExists) {
      try {
        const result = await window.electronAPI.mediaPathExists(pathOrUrl);
        return !!result?.exists;
      } catch {
        return false;
      }
    }

    if (pathOrUrl.startsWith('http')) {
      try {
        const response = await fetch(pathOrUrl, { method: 'HEAD' });
        return response.ok;
      } catch {
        return false;
      }
    }

    return false;
  }

  private static scheduleCacheValidation(): void {
    if (this.cacheValidationTimer || typeof window === 'undefined') return;

    this.cacheValidationTimer = setInterval(
      () => {
        void this.pruneInvalidCacheEntries(5);
      },
      5 * 60 * 1000,
    );

    void this.pruneInvalidCacheEntries(5);
  }

  private static async pruneInvalidCacheEntries(maxChecks = 5): Promise<void> {
    if (typeof window === 'undefined' || !window.electronAPI?.mediaPathExists) {
      return;
    }

    let checked = 0;
    let removed = 0;

    for (const [key, entry] of this.spriteSheetCache.entries()) {
      if (checked >= maxChecks) break;
      checked++;
      const isValid = await this.validateCacheEntry(entry);
      if (!isValid) {
        this.spriteSheetCache.delete(key);
        this.cacheAccessTimes.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.saveCacheToStorage();
    }
  }

  /**
   * Validate that a cached sprite sheet entry is still valid
   */
  private static async validateCacheEntry(
    result: SpriteSheetGenerationResult,
  ): Promise<boolean> {
    try {
      if (!result.spriteSheets || result.spriteSheets.length === 0) {
        return false;
      }
      // Check if sprite sheet URLs are still accessible
      for (const sheet of result.spriteSheets) {
        const exists = await this.mediaPathExists(sheet.url);
        if (!exists) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save cache to persistent storage
   */
  private static saveCacheToStorage(): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const cacheEntries: Record<string, SpriteSheetCacheEntry> = {};

        for (const [key, result] of this.spriteSheetCache.entries()) {
          const accessTime = this.cacheAccessTimes.get(key) || Date.now();
          cacheEntries[key] = {
            result,
            timestamp: Date.now(),
            accessCount: 1,
            lastAccessed: accessTime,
            fileSize: this.estimateCacheEntrySize(result),
            videoPath: result.spriteSheets[0]?.url || '',
          };
        }

        window.localStorage.setItem(
          this.CACHE_STORAGE_KEY,
          JSON.stringify(cacheEntries),
        );
        console.log(
          `[VideoSpriteSheetGenerator] Saved${Object.keys(cacheEntries).length} sprite sheet cache entries`,
        );
      }
    } catch (error) {
      console.warn(
        '[VideoSpriteSheetGenerator] Failed to save sprite sheet cache to storage',
        error,
      );
    }
  }

  /**
   * Estimate the size of a cache entry for memory management
   */
  private static estimateCacheEntrySize(
    result: SpriteSheetGenerationResult,
  ): number {
    // Rough estimate based on number of thumbnails and sheet dimensions
    let size = 0;
    for (const sheet of result.spriteSheets) {
      size += sheet.width * sheet.height * 0.3; // Rough bytes estimate for PNG (higher than JPEG)
      size += sheet.thumbnails.length * 200; // Metadata overhead
    }
    return size;
  }

  /**
   * Generate sprite sheets for a video with optimized FFmpeg command
   */
  static async generateSpriteSheets(
    options: SpriteSheetOptions,
  ): Promise<SpriteSheetGenerationResult> {
    // Initialize cache if not already done
    await this.initializeCache();

    const cacheKey = this.createCacheKey(options);

    // Return cached result if available
    if (this.spriteSheetCache.has(cacheKey)) {
      const cached = this.spriteSheetCache.get(cacheKey);
      if (cached) {
        this.cacheAccessTimes.set(cacheKey, Date.now());
        console.log(
          '[VideoSpriteSheetGenerator] Sprite sheet cache HIT for',
          cacheKey,
        );
        return cached;
      }
    }

    // Return active generation if already in progress
    if (this.activeGenerations.has(cacheKey)) {
      const activeGeneration = this.activeGenerations.get(cacheKey);
      if (activeGeneration) {
        console.log(
          '[VideoSpriteSheetGenerator] Using active sprite sheet generation for',
          cacheKey,
        );
        return activeGeneration;
      }
    }

    // Start new generation
    const generationPromise = this.performSpriteSheetGeneration(
      options,
      cacheKey,
    );
    this.activeGenerations.set(cacheKey, generationPromise);

    try {
      const result = await generationPromise;
      this.activeGenerations.delete(cacheKey);
      return result;
    } catch (error) {
      this.activeGenerations.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Perform the actual sprite sheet generation using background FFmpeg worker
   */
  private static async performSpriteSheetGeneration(
    options: SpriteSheetOptions,
    cacheKey: string,
  ): Promise<SpriteSheetGenerationResult> {
    const {
      videoPath,
      duration: providedDuration,
      fps: providedFps,
      thumbWidth = 120,
      thumbHeight = 68,
      maxThumbnailsPerSheet = 100,
      sourceStartTime = 0,
    } = options;

    // Get precise video metadata for accurate frame extraction
    const videoMetadata = await this.getVideoMetadata(videoPath);
    const duration = videoMetadata.duration || providedDuration;
    const fps = videoMetadata.fps || providedFps;

    console.log(
      `[VideoSpriteSheetGenerator] Using${videoMetadata.duration ? 'precise' : 'fallback'} video metadata:`,
    );
    console.log(
      `[VideoSpriteSheetGenerator] • Duration${duration.toFixed(3)}s (provided: ${providedDuration.toFixed(3)}s)`,
    );
    console.log(
      `[VideoSpriteSheetGenerator] • FPS${fps.toFixed(3)} (provided: ${providedFps.toFixed(3)})`,
    );

    // Calculate optimal interval based on duration and zoom level
    const intervalSeconds =
      options.intervalSeconds || this.calculateOptimalInterval(duration);

    // Calculate exact thumbnails needed based on actual video duration
    // Use precise calculation to prevent generating more thumbnails than video content
    const exactThumbnails = Math.floor(duration / intervalSeconds) + 1; // +1 for the first frame

    // Limit total thumbnails to prevent memory issues with large files
    const maxThumbnails = Math.min(exactThumbnails, 5000); // Reasonable limit
    const adjustedTotalThumbnails = Math.max(5, maxThumbnails); // Minimum 5 thumbnails

    // Ensure we don't exceed actual video content
    const maxPossibleThumbnails = Math.floor(duration / intervalSeconds) + 1;
    const finalTotalThumbnails = Math.min(
      adjustedTotalThumbnails,
      maxPossibleThumbnails,
    );

    const numberOfSheets = Math.ceil(
      finalTotalThumbnails / maxThumbnailsPerSheet,
    );

    console.log(
      `[VideoSpriteSheetGenerator] Generating${numberOfSheets} sprite sheet(s) with ${finalTotalThumbnails} thumbnails total (${adjustedTotalThumbnails} adjusted)`,
    );
    console.log(
      `[VideoSpriteSheetGenerator] Thumbnail size${thumbWidth}x${thumbHeight}, interval: ${intervalSeconds}s`,
    );
    console.log(
      `[VideoSpriteSheetGenerator] ⏱ Duration${duration}s, Source start: ${sourceStartTime}s`,
    );
    console.log(
      `[VideoSpriteSheetGenerator] Calculation: exactThumbnails=${exactThumbnails}, maxPossible=${maxPossibleThumbnails}`,
    );

    try {
      // Check if we're in an Electron environment
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error(
          'Sprite sheet generation requires Electron environment',
        );
      }

      // Check if the custom FFmpeg method is available
      if (
        !(window.electronAPI as unknown as { runCustomFFmpeg?: unknown })
          .runCustomFFmpeg
      ) {
        throw new Error(
          'Sprite sheet generation requires app restart to enable new IPC handlers',
        );
      }

      const cacheBase = await this.getMediaCacheBaseDir();
      const outputDir = this.joinPath(
        cacheBase,
        'sprite-sheets',
        `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      );
      const commands: string[][] = [];
      const sheetMetadata: Array<{
        index: number;
        thumbnailsInSheet: number;
        thumbnailsPerRow: number;
        thumbnailsPerColumn: number;
        width: number;
        height: number;
        startThumbnailIndex: number;
        actualFrameCount: number;
      }> = [];

      // Prepare all FFmpeg commands for background processing
      for (let sheetIndex = 0; sheetIndex < numberOfSheets; sheetIndex++) {
        const startThumbnailIndex = sheetIndex * maxThumbnailsPerSheet;
        const endThumbnailIndex = Math.min(
          startThumbnailIndex + maxThumbnailsPerSheet,
          finalTotalThumbnails,
        );
        const thumbnailsInSheet = endThumbnailIndex - startThumbnailIndex;

        // Calculate time range for this sheet with strict video duration bounds
        const startTime =
          sourceStartTime + startThumbnailIndex * intervalSeconds;
        const rawEndTime =
          sourceStartTime + endThumbnailIndex * intervalSeconds;
        const maxVideoTime = sourceStartTime + duration;

        // Don't exceed actual video duration
        const endTime = Math.min(rawEndTime, maxVideoTime);
        const maxSheetDuration = endTime - startTime;

        // Skip this sheet if there's no valid time range (startTime >= maxVideoTime)
        if (startTime >= maxVideoTime) {
          console.warn(
            `[VideoSpriteSheetGenerator] Skipping sprite sheet${sheetIndex + 1} - start time (${startTime.toFixed(2)}s) exceeds video duration (${maxVideoTime.toFixed(2)}s)`,
          );
          continue;
        }

        // Calculate how many frames we can actually fit in this time range
        const maxPossibleFrames =
          Math.floor(maxSheetDuration / intervalSeconds) + 1;
        const requestedFrames = Math.min(thumbnailsInSheet, maxPossibleFrames);

        // Calculate precise duration to generate exactly the frames we need
        // For N frames at interval I, we need duration = (N-1) * I + minimal buffer
        // Use very small buffer to avoid generating extra frames
        const preciseDuration = (requestedFrames - 1) * intervalSeconds + 0.001; // Minimal buffer
        const sheetDuration = Math.min(preciseDuration, maxSheetDuration);

        // Additional check: skip if sheet duration is too small to be meaningful
        if (sheetDuration < intervalSeconds / 2) {
          console.warn(
            `[VideoSpriteSheetGenerator] Skipping sprite sheet${sheetIndex + 1} - duration (${sheetDuration.toFixed(2)}s) too small for interval (${intervalSeconds}s)`,
          );
          continue;
        }

        const finalFrameCount = requestedFrames;

        // Calculate optimal grid dimensions to minimize empty slots
        const optimalGrid = this.calculateOptimalGrid(finalFrameCount);
        const optimalCols = optimalGrid.cols;
        const optimalRows = optimalGrid.rows;

        // Use the original optimal grid since FFmpeg generates exactly what we plan
        // Only add minimal tolerance for edge cases
        const conservativeFrameCount = finalFrameCount;

        console.log(
          `[VideoSpriteSheetGenerator] Grid calculation: using optimal grid for exactly${finalFrameCount} frames`,
        );

        // Calculate exact frame numbers to extract (no time-based extraction)
        const frameNumbers = [];
        for (let i = 0; i < finalFrameCount; i++) {
          const globalThumbnailIndex = startThumbnailIndex + i;
          const timestamp =
            sourceStartTime + globalThumbnailIndex * intervalSeconds;
          const frameNumber = Math.floor(timestamp * fps);
          frameNumbers.push(frameNumber);
        }

        // Use select filter to extract exact frames (prevents excess frames)
        //const selectFilter = frameNumbers
        //  .map((frame) => `eq(n\\,${frame})`)
        //  .join('+');
        // const framesPerSheet = optimalCols * optimalRows;
        //const sheetDuration = framesPerSheet * intervalSeconds;
        //const startTime = sheetIndex * sheetDuration;

        const spriteSheetCommand = [
          '-ss',
          String(startTime), // seek to where this sheet should start
          '-i',
          videoPath,
          '-vf',
          [
            `fps=1/${intervalSeconds}`, // sample frames evenly by time
            `scale=${thumbWidth}:${thumbHeight}:force_original_aspect_ratio=increase`,
            `crop=${thumbWidth}:${thumbHeight}`,
            `tile=${optimalCols}x${optimalRows}`,
          ].join(','),
          '-q:v',
          '5',
          '-f',
          'image2',
          '-avoid_negative_ts',
          'make_zero',
          '-vsync',
          '0',
          '-threads',
          '4',
          '-frames:v',
          '1', // still one sheet per run
          '-y',
          `${outputDir}/sprite_${sheetIndex.toString().padStart(3, '0')}.jpg`,
        ];

        // Update metadata with actual dimensions
        const actualSheetWidth = optimalCols * thumbWidth;
        const actualSheetHeight = optimalRows * thumbHeight;

        commands.push(spriteSheetCommand);
        sheetMetadata.push({
          index: sheetIndex,
          thumbnailsInSheet: finalFrameCount, // Use final calculated frame count
          thumbnailsPerRow: optimalCols,
          thumbnailsPerColumn: optimalRows,
          width: actualSheetWidth,
          height: actualSheetHeight,
          startThumbnailIndex,
          actualFrameCount: finalFrameCount, // Track actual frames for filtering
        });

        const actualEmptySlots =
          optimalCols * optimalRows - conservativeFrameCount;
        console.log(
          `[VideoSpriteSheetGenerator] Prepared sprite sheet${sheetIndex + 1}/${numberOfSheets}:`,
          `•${finalFrameCount} exact frames (${thumbnailsInSheet} requested, ${maxPossibleFrames} max possible)`,
          `• OPTIMAL grid${optimalCols}x${optimalRows} (${optimalCols * optimalRows} slots for ${finalFrameCount} frames)`,
          `• Expected empty slots${actualEmptySlots}`,
          `• Frame numbers: [${frameNumbers.slice(0, 3).join(', ')}${frameNumbers.length > 3 ? '...' : ''}] (${frameNumbers.length} total)`,
          `• Time range${startTime.toFixed(2)}s to ${(startTime + sheetDuration).toFixed(2)}s (max: ${maxVideoTime.toFixed(2)}s)`,
          `• Duration${sheetDuration.toFixed(2)}s (precise: ${preciseDuration.toFixed(2)}s), Interval: ${intervalSeconds}s`,
          '• FFmpeg select: exact frame extraction (no time-based fps)',
          `• Thumbnail indices${startThumbnailIndex} to ${endThumbnailIndex - 1}`,
        );
      }

      // Start background generation
      const jobId = `sprite_${cacheKey}_${Date.now()}`;

      const backgroundResult = await (
        window.electronAPI as unknown as {
          generateSpriteSheetBackground: (options: {
            jobId: string;
            videoPath: string;
            outputDir: string;
            commands: string[][];
          }) => Promise<{ success: boolean; error?: string; jobId?: string }>;
        }
      ).generateSpriteSheetBackground({
        jobId,
        videoPath,
        outputDir,
        commands,
      });

      if (!backgroundResult.success) {
        throw new Error(
          backgroundResult.error ||
            'Failed to start background sprite sheet generation',
        );
      }

      // Calculate adaptive timeout based on video duration and number of sheets
      const baseTimeout = 60000; // 1 minute base
      const perSheetTimeout = 60000; // 1 minute per sheet
      const durationFactor = Math.max(1, duration / 60); // Factor based on video length
      const sheetCount = Math.ceil(
        finalTotalThumbnails / maxThumbnailsPerSheet,
      );
      const adaptiveTimeout = Math.min(
        baseTimeout + sheetCount * perSheetTimeout * durationFactor,
        600000, // Max 10 minutes
      );

      // Wait for completion with progress polling
      const result = await this.waitForBackgroundCompletion(
        jobId,
        backgroundResult.jobId || jobId,
        adaptiveTimeout,
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      // Build sprite sheet metadata after successful generation
      const spriteSheets: SpriteSheet[] = [];
      const missingSheets: string[] = [];

      for (const metadata of sheetMetadata) {
        const sheetPath = this.joinPath(
          outputDir,
          `sprite_${metadata.index.toString().padStart(3, '0')}.jpg`,
        );
        const exists = await this.mediaPathExists(sheetPath);
        if (!exists) {
          console.warn(
            `[VideoSpriteSheetGenerator] Sprite sheet file missing on disk${sheetPath}`,
          );
          missingSheets.push(sheetPath);
          continue;
        }

        const spriteSheetUrl = toMediaServerUrl(sheetPath);
        const thumbnails: SpriteSheetThumbnail[] = [];

        // Only create thumbnails for actual frames (not empty grid slots)
        const actualFramesToProcess = metadata.actualFrameCount;

        for (let i = 0; i < actualFramesToProcess; i++) {
          const globalThumbnailIndex = metadata.startThumbnailIndex + i;
          const row = Math.floor(i / metadata.thumbnailsPerRow);
          const col = i % metadata.thumbnailsPerRow;
          const timestamp =
            sourceStartTime + globalThumbnailIndex * intervalSeconds;

          // Strict bounds checking: only include thumbnails within video duration
          // and within the sprite sheet grid bounds
          const isWithinVideoDuration = timestamp <= sourceStartTime + duration;
          const isWithinSpriteSheet =
            col < metadata.thumbnailsPerRow &&
            row < metadata.thumbnailsPerColumn &&
            row * metadata.thumbnailsPerRow + col < actualFramesToProcess;

          if (isWithinVideoDuration && isWithinSpriteSheet) {
            thumbnails.push({
              id: `${cacheKey}_${globalThumbnailIndex}`,
              timestamp,
              frameNumber: Math.floor(timestamp * fps),
              sheetIndex: metadata.index,
              x: col * thumbWidth,
              y: row * thumbHeight,
              width: thumbWidth,
              height: thumbHeight,
            });
          }
        }

        spriteSheets.push({
          id: `${cacheKey}_sheet_${metadata.index}`,
          url: spriteSheetUrl,
          width: metadata.width,
          height: metadata.height,
          thumbnailsPerRow: metadata.thumbnailsPerRow,
          thumbnailsPerColumn: metadata.thumbnailsPerColumn,
          thumbnailWidth: thumbWidth,
          thumbnailHeight: thumbHeight,
          thumbnails,
        });

        // Check for potential padding issues
        const expectedWidth = metadata.thumbnailsPerRow * thumbWidth;
        const expectedHeight = metadata.thumbnailsPerColumn * thumbHeight;
        const hasUnexpectedPadding =
          metadata.width !== expectedWidth ||
          metadata.height !== expectedHeight;

        console.log(
          `[VideoSpriteSheetGenerator] Built sprite sheet${metadata.index} metadata:`,
          `•${thumbnails.length} valid thumbnails created (planned: ${metadata.actualFrameCount})`,
          `• ACTUAL sheet size${metadata.width}x${metadata.height}px (expected: ${expectedWidth}x${expectedHeight}px)`,
          `• ACTUAL grid${metadata.thumbnailsPerRow}x${metadata.thumbnailsPerColumn}`,
          `• Expected grid slots${metadata.thumbnailsPerRow * metadata.thumbnailsPerColumn}`,
          `• Actual thumbnails${thumbnails.length} (difference: ${metadata.thumbnailsPerRow * metadata.thumbnailsPerColumn - thumbnails.length})`,
          hasUnexpectedPadding
            ? `\n   PADDING DETECTED: FFmpeg added unexpected padding to sprite sheet`
            : '',
        );
      }

      if (missingSheets.length > 0 || spriteSheets.length === 0) {
        throw new Error(
          `Sprite sheet generation incomplete (missing ${missingSheets.length} file(s))`,
        );
      }

      console.log(
        '[VideoSpriteSheetGenerator] All sprite sheets generated successfully in background',
      );

      // Cache the result with persistent storage
      const generationResult: SpriteSheetGenerationResult = {
        success: true,
        spriteSheets,
        cacheKey,
      };

      this.cleanupCache();
      this.spriteSheetCache.set(cacheKey, generationResult);
      this.cacheAccessTimes.set(cacheKey, Date.now());

      // Save to persistent storage
      this.saveCacheToStorage();

      return generationResult;
    } catch (error) {
      console.error(
        '[VideoSpriteSheetGenerator] Sprite sheet generation failed',
        error,
      );
      return {
        success: false,
        spriteSheets: [],
        error: error instanceof Error ? error.message : 'Unknown error',
        cacheKey,
      };
    }
  }

  /**
   * Wait for background sprite sheet generation to complete
   */
  private static async waitForBackgroundCompletion(
    jobId: string,
    actualJobId: string,
    timeoutMs = 300000,
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      let isResolved = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (pollTimer) clearTimeout(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        window.electronAPI.removeListener(
          'sprite-sheet-job-completed',
          handleCompleted,
        );
        window.electronAPI.removeListener(
          'sprite-sheet-job-error',
          handleError,
        );
      };

      const handleCompleted = (_event: unknown, data: { jobId: string }) => {
        if (data.jobId === actualJobId && !isResolved) {
          isResolved = true;
          cleanup();
          console.log(
            '[VideoSpriteSheetGenerator] Background sprite sheet generation completed',
          );
          resolve({ success: true });
        }
      };

      const handleError = (
        _event: unknown,
        data: { jobId: string; error: string },
      ) => {
        if (data.jobId === actualJobId && !isResolved) {
          isResolved = true;
          cleanup();
          console.error(
            '[VideoSpriteSheetGenerator] Background sprite sheet generation failed',
            data.error,
          );
          resolve({ success: false, error: data.error });
        }
      };

      // Set up event listeners for job completion
      window.electronAPI.on('sprite-sheet-job-completed', handleCompleted);
      window.electronAPI.on('sprite-sheet-job-error', handleError);

      // Progress polling as fallback
      const pollProgress = async () => {
        if (isResolved) return;

        try {
          const progressResult = await (
            window.electronAPI as unknown as {
              getSpriteSheetProgress: (jobId: string) => Promise<{
                success: boolean;
                progress?: { current: number; total: number; stage: string };
                error?: string;
              }>;
            }
          ).getSpriteSheetProgress(actualJobId);

          if (progressResult.success && progressResult.progress) {
            const { current, total, stage } = progressResult.progress;
            console.log(
              `[VideoSpriteSheetGenerator] Sprite sheet progress${current}/${total} - ${stage}`,
            );

            // Check if completed via progress (fallback)
            if (current >= total && stage === 'Completed') {
              if (!isResolved) {
                isResolved = true;
                cleanup();
                resolve({ success: true });
                return;
              }
            }
          } else if (
            !progressResult.success &&
            progressResult.error === 'Job not found'
          ) {
            // Job might have completed and been cleaned up
            if (!isResolved) {
              isResolved = true;
              cleanup();
              resolve({ success: true });
              return;
            }
          }
        } catch (error) {
          console.warn(
            '[VideoSpriteSheetGenerator] Warning: Failed to poll sprite sheet progress',
            error,
          );
        }

        // Continue polling if not resolved
        if (!isResolved) {
          pollTimer = setTimeout(pollProgress, 1000); // Poll every second
        }
      };

      // Start polling after a short delay
      pollTimer = setTimeout(pollProgress, 500);

      // Set timeout
      timeoutTimer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve({
            success: false,
            error: `Sprite sheet generation timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          });
        }
      }, timeoutMs);
    });
  }

  /**
   * Calculate optimal grid dimensions to minimize empty slots while maintaining reasonable dimensions
   * Force single row for uneven counts to avoid black cells
   */
  private static calculateOptimalGrid(frameCount: number): {
    cols: number;
    rows: number;
    emptySlots: number;
  } {
    if (frameCount <= 0) return { cols: 1, rows: 1, emptySlots: 0 };

    // ALWAYS use single row for precise frame count to avoid empty cells
    // This prevents black strips from empty grid slots
    if (frameCount <= 50) {
      return { cols: frameCount, rows: 1, emptySlots: 0 };
    }

    // For larger counts, prefer configurations that result in zero empty slots
    // Try to find perfect divisors first
    const perfectDivisors = [];
    for (let i = 1; i <= Math.sqrt(frameCount); i++) {
      if (frameCount % i === 0) {
        perfectDivisors.push({ cols: i, rows: frameCount / i });
        if (i !== frameCount / i) {
          perfectDivisors.push({ cols: frameCount / i, rows: i });
        }
      }
    }

    // If we have perfect divisors, choose the one with best aspect ratio
    if (perfectDivisors.length > 0) {
      let bestDivisor = perfectDivisors[0];
      let bestAspectRatio = Math.max(
        bestDivisor.cols / bestDivisor.rows,
        bestDivisor.rows / bestDivisor.cols,
      );

      for (const divisor of perfectDivisors) {
        const aspectRatio = Math.max(
          divisor.cols / divisor.rows,
          divisor.rows / divisor.cols,
        );
        if (aspectRatio < bestAspectRatio && aspectRatio <= 10) {
          bestAspectRatio = aspectRatio;
          bestDivisor = divisor;
        }
      }

      console.log(
        `[VideoSpriteSheetGenerator] Perfect grid found${bestDivisor.cols}x${bestDivisor.rows} for ${frameCount} frames (0 empty slots)`,
      );
      return { cols: bestDivisor.cols, rows: bestDivisor.rows, emptySlots: 0 };
    }

    // Fallback: prefer single row to avoid any empty cells
    console.log(
      `[VideoSpriteSheetGenerator] Using single row layout for${frameCount} frames to avoid empty cells`,
    );
    return { cols: frameCount, rows: 1, emptySlots: 0 };
  }

  /**
   * Calculate optimal thumbnail interval for timeline coveragev
   */
  private static calculateOptimalInterval(duration: number): number {
    // For timeline display, we want dense coverage for smooth appearance
    // Adaptive interval based on video duration to balance quality and performance

    if (duration <= 5) {
      return 0.1; // Very dense for short videos
    } else if (duration <= 30) {
      return 0.25; // Dense coverage for short videos
    } else if (duration <= 120) {
      // 02:00
      return 0.5; // Good coverage for medium videos
    } else if (duration >= 121 && duration <= 300) {
      // 02:01 - 05:00
      return 1.0;
    } else if (duration <= 600 || duration >= 301) {
      // 10 minutes
      return 1.0; // Reasonable coverage for long videos
    } else if (duration <= 3599 && duration >= 601) {
      // 10:01 - 59:59
      return duration / 300;
    } else if (duration >= 3600) {
      // over an hour
      return duration / 1200; // Sparse coverage for very long videos to prevent memory issues
    } else {
      return 2.0;
    }
  }

  /**
   * Generate cache key for sprite sheet options
   */
  private static createCacheKey(options: SpriteSheetOptions): string {
    const {
      videoPath,
      contentSignature,
      duration,
      thumbWidth = 120,
      thumbHeight = 68,
      sourceStartTime = 0,
      intervalSeconds,
    } = options;

    const filename = videoPath.split(/[\\/]/).pop() || videoPath;
    const cacheId = contentSignature ? `sig_${contentSignature}` : filename;
    const cachePrefix = contentSignature ? 'sprite_png_v4' : 'sprite_png_v3';
    const calculatedInterval =
      intervalSeconds || this.calculateOptimalInterval(duration);

    // Round values to reduce cache fragmentation
    const roundedInterval = Math.round(calculatedInterval * 100) / 100;
    const roundedDuration = Math.round(duration * 10) / 10;
    const roundedStartTime = Math.round(sourceStartTime * 10) / 10;

    return `${cachePrefix}_${cacheId}_${roundedStartTime}_${roundedDuration}_${roundedInterval}_${thumbWidth}x${thumbHeight}`;
  }

  /**
   * Get cached sprite sheets if available
   */
  static async getCachedSpriteSheets(
    options: SpriteSheetOptions,
  ): Promise<SpriteSheetGenerationResult | null> {
    // Initialize cache if not already done
    await this.initializeCache();

    const cacheKey = this.createCacheKey(options);
    const cached = this.spriteSheetCache.get(cacheKey);

    if (cached) {
      // Validate that cached URLs are still accessible
      const isValid = await this.validateCacheEntry(cached);
      if (isValid) {
        this.cacheAccessTimes.set(cacheKey, Date.now());
        console.log(
          `[VideoSpriteSheetGenerator] Sprite sheet cache HIT for${cacheKey}`,
        );
        return cached;
      } else {
        // Remove invalid cache entry
        this.spriteSheetCache.delete(cacheKey);
        this.cacheAccessTimes.delete(cacheKey);
        console.log(
          `[VideoSpriteSheetGenerator] Sprite sheet cache INVALID for${cacheKey}, removed`,
        );
      }
    } else {
      console.log(
        `[VideoSpriteSheetGenerator] Sprite sheet cache MISS for${cacheKey}`,
      );
    }

    return null;
  }

  /**
   * Clear sprite sheet cache
   */
  static clearCache(): void {
    this.spriteSheetCache.clear();
    this.cacheAccessTimes.clear();

    // Clear persistent storage
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(this.CACHE_STORAGE_KEY);
    }

    console.log(
      '[VideoSpriteSheetGenerator] Sprite sheet cache cleared (memory and storage)',
    );
  }

  /**
   * Get cache statistics for debugging
   */
  static getCacheStats() {
    return {
      size: this.spriteSheetCache.size,
      maxSize: this.MAX_CACHE_SIZE,
      keys: Array.from(this.spriteSheetCache.keys()),
      activeGenerations: this.activeGenerations.size,
    };
  }

  /**
   * Remove specific video from cache
   */
  static removeCacheEntry(videoPath: string): void {
    const filename = videoPath.split(/[\\/]/).pop() || videoPath;
    const keysToRemove = Array.from(this.spriteSheetCache.keys()).filter(
      (key) => key.includes(filename),
    );
    keysToRemove.forEach((key) => {
      this.spriteSheetCache.delete(key);
      this.cacheAccessTimes.delete(key);
    });
    console.log(
      `[VideoSpriteSheetGenerator] Removed${keysToRemove.length} sprite sheet cache entries for ${filename}`,
    );
  }

  /**
   * Clean up old cache entries when limit is reached with intelligent eviction
   */
  private static cleanupCache() {
    if (this.spriteSheetCache.size <= this.MAX_CACHE_SIZE) return;

    console.log(
      `[VideoSpriteSheetGenerator] Cleaning up sprite sheet cache (current size${this.spriteSheetCache.size})`,
    );

    // Create scoring system for cache eviction (LRU + size considerations)
    const cacheScores = new Map<string, number>();
    const now = Date.now();

    for (const [key, result] of this.spriteSheetCache.entries()) {
      const lastAccessed = this.cacheAccessTimes.get(key) || now;
      const ageMinutes = (now - lastAccessed) / (1000 * 60);
      const size = this.estimateCacheEntrySize(result);

      // Score: higher score = more likely to be evicted
      // Factor in age (older = higher score) and size (larger = higher score)
      const score = ageMinutes * 0.1 + size * 0.0001;
      cacheScores.set(key, score);
    }

    // Sort by score and remove highest scoring entries
    const sortedEntries = Array.from(cacheScores.entries())
      .sort(([, a], [, b]) => b - a) // Highest score first
      .slice(0, this.spriteSheetCache.size - this.MAX_CACHE_SIZE + 3); // Remove extra entries

    for (const [key] of sortedEntries) {
      this.spriteSheetCache.delete(key);
      this.cacheAccessTimes.delete(key);
    }

    // Update persistent storage
    this.saveCacheToStorage();

    console.log(
      `[VideoSpriteSheetGenerator] Sprite sheet cache cleaned up (new size${this.spriteSheetCache.size})`,
    );
  }

  /**
   * Generate sprite sheets optimized for a specific track
   */
  static async generateForTrack(
    track: VideoTrack,
    fps: number,
  ): Promise<SpriteSheetGenerationResult> {
    if (track.type !== 'video' || !track.source) {
      throw new Error('Track must be a video track with a valid source');
    }

    const videoPath = track.tempFilePath || track.source;
    const durationSeconds = (track.endFrame - track.startFrame) / fps;
    console.log(
      '[VideoSpriteSheetGenerator] Log',
      'calculated seconds: ' + durationSeconds,
    );
    // Handle blob URLs (won't work with FFmpeg)
    if (videoPath.startsWith('blob:')) {
      throw new Error('Cannot generate sprite sheets from blob URL');
    }

    return this.generateSpriteSheets({
      videoPath,
      duration: durationSeconds,
      fps,
      sourceStartTime: track.sourceStartTime || 0,
      thumbWidth: 120, // Optimized size for timeline display
      thumbHeight: 68, // 16:9 aspect ratio
      maxThumbnailsPerSheet: 100, // Balance between file size and HTTP requests
      intervalSeconds: 6, // larger interval
    });
  }
}

export default VideoSpriteSheetGenerator;
