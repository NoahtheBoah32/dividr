export interface ThumbnailOptions {
  videoPath: string;
  /** Optional content-based signature for stable caching across reimports */
  contentSignature?: string;
  duration: number; // in seconds
  fps: number;
  intervalSeconds?: number; // Generate thumbnail every N seconds (default: 1)
  width?: number; // Thumbnail width (default: 160)
  height?: number; // Thumbnail height (default: 90)
  quality?: number; // JPEG quality 1-31, lower is better (default: 5)
  sourceStartTime?: number; // Start time in source video (default: 0)
  /** Persist cache entry across app restarts (localStorage) */
  persist?: boolean;
}

export interface VideoThumbnail {
  id: string;
  timestamp: number; // in seconds
  frameNumber: number;
  url: string;
  width: number;
  height: number;
}

export interface ThumbnailGenerationResult {
  success: boolean;
  thumbnails: VideoThumbnail[];
  error?: string;
}

interface PersistentThumbnailCacheEntry {
  thumbnails: VideoThumbnail[];
  timestamp: number;
  lastAccessed: number;
}

export class VideoThumbnailGenerator {
  private static thumbnailCache = new Map<string, VideoThumbnail[]>();
  private static activeGenerations = new Map<
    string,
    Promise<ThumbnailGenerationResult>
  >();
  private static cacheAccessTimes = new Map<string, number>();
  private static readonly MAX_CACHE_SIZE = 50; // Limit cache to 50 entries
  private static persistentCache = new Map<
    string,
    PersistentThumbnailCacheEntry
  >();
  private static cacheInitialized = false;
  private static readonly CACHE_STORAGE_KEY = 'dividr_thumbnail_cache_v1';
  private static readonly MAX_PERSISTENT_CACHE_SIZE = 100;

  private static initializeCache(): void {
    if (this.cacheInitialized) return;

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const stored = window.localStorage.getItem(this.CACHE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as {
            entries?: Record<string, PersistentThumbnailCacheEntry>;
          };
          const entries = parsed.entries || {};
          for (const [key, entry] of Object.entries(entries)) {
            if (entry?.thumbnails?.length) {
              this.persistentCache.set(key, entry);
            }
          }
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to load thumbnail cache from storage:', error);
    }

    this.cacheInitialized = true;
  }

  private static saveCacheToStorage(): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const entries: Record<string, PersistentThumbnailCacheEntry> = {};
        for (const [key, entry] of this.persistentCache.entries()) {
          entries[key] = entry;
        }
        window.localStorage.setItem(
          this.CACHE_STORAGE_KEY,
          JSON.stringify({ entries, version: 1, timestamp: Date.now() }),
        );
      }
    } catch (error) {
      console.warn('⚠️ Failed to save thumbnail cache to storage:', error);
    }
  }

  private static cleanupPersistentCache(): void {
    if (this.persistentCache.size <= this.MAX_PERSISTENT_CACHE_SIZE) return;

    const entries = Array.from(this.persistentCache.entries()).sort(
      ([, a], [, b]) => a.lastAccessed - b.lastAccessed,
    );
    const excess = this.persistentCache.size - this.MAX_PERSISTENT_CACHE_SIZE;
    for (let i = 0; i < excess; i++) {
      this.persistentCache.delete(entries[i][0]);
    }
  }

  private static saveToCache(
    cacheKey: string,
    thumbnails: VideoThumbnail[],
    persist?: boolean,
  ): void {
    this.thumbnailCache.set(cacheKey, thumbnails);
    this.cacheAccessTimes.set(cacheKey, Date.now());

    if (persist) {
      const now = Date.now();
      this.persistentCache.set(cacheKey, {
        thumbnails,
        timestamp: now,
        lastAccessed: now,
      });
      this.cleanupPersistentCache();
      this.saveCacheToStorage();
    }

    this.cleanupCache();
  }

  private static getCachedEntryByKey(
    cacheKey: string,
  ): { cacheKey: string; thumbnails: VideoThumbnail[] } | null {
    const cached = this.thumbnailCache.get(cacheKey);
    if (cached) {
      this.cacheAccessTimes.set(cacheKey, Date.now());
      return { cacheKey, thumbnails: cached };
    }

    const persistent = this.persistentCache.get(cacheKey);
    if (persistent?.thumbnails?.length) {
      persistent.lastAccessed = Date.now();
      this.cacheAccessTimes.set(cacheKey, Date.now());
      this.thumbnailCache.set(cacheKey, persistent.thumbnails);
      return { cacheKey, thumbnails: persistent.thumbnails };
    }

    return null;
  }

  static getCachedThumbnailEntry(
    options: ThumbnailOptions,
  ): { cacheKey: string; thumbnails: VideoThumbnail[] } | null {
    this.initializeCache();
    const cacheKey = this.createCacheKey(options);
    return this.getCachedEntryByKey(cacheKey);
  }

  static removeCacheEntryByKey(cacheKey: string): void {
    this.thumbnailCache.delete(cacheKey);
    this.cacheAccessTimes.delete(cacheKey);
    this.persistentCache.delete(cacheKey);
    this.saveCacheToStorage();
  }

  static async validateThumbnailUrl(url: string): Promise<boolean> {
    if (!url) return false;
    if (url.startsWith('data:')) return true;

    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Generate thumbnails for a video with optimized FFmpeg command
   */
  static async generateThumbnails(
    options: ThumbnailOptions,
  ): Promise<ThumbnailGenerationResult> {
    this.initializeCache();
    // Create cache key
    const cacheKey = this.createCacheKey(options);

    // Return cached result if available
    const cachedEntry = this.getCachedEntryByKey(cacheKey);
    if (cachedEntry?.thumbnails) {
      return {
        success: true,
        thumbnails: cachedEntry.thumbnails,
      };
    }

    // Return active generation if already in progress
    if (this.activeGenerations.has(cacheKey)) {
      const activeGeneration = this.activeGenerations.get(cacheKey);
      if (activeGeneration) {
        return activeGeneration;
      }
    }

    // Start new generation
    const generationPromise = this.performThumbnailGeneration(
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
   * Perform the actual thumbnail generation using FFmpeg
   */
  private static async performThumbnailGeneration(
    options: ThumbnailOptions,
    cacheKey: string,
  ): Promise<ThumbnailGenerationResult> {
    const { duration, intervalSeconds = 1, sourceStartTime = 0 } = options;

    try {
      const totalThumbnails = Math.ceil(duration / intervalSeconds);

      console.log(
        `🎬 Generating ${totalThumbnails} thumbnails for ${options.videoPath} starting at ${sourceStartTime}s (duration: ${duration}s)`,
      );

      // Generate output directory path
      const outputDir = `public/thumbnails/${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Note: Output directory will be created by the thumbnail generation process
      console.log(`📁 Thumbnails will be stored in: ${outputDir}`);

      // Extract thumbnails using FFmpeg
      return await this.extractWithFFmpeg(options, cacheKey, outputDir);
    } catch (error) {
      console.error('Error generating video thumbnails:', error);
      return {
        success: false,
        thumbnails: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate cache key for thumbnail options
   */
  private static createCacheKey(options: ThumbnailOptions): string {
    const {
      videoPath,
      contentSignature,
      intervalSeconds = 1,
      width = 160,
      height = 90,
      quality = 5,
      sourceStartTime = 0,
      duration,
    } = options;
    // Round values to reduce cache fragmentation
    const roundedInterval = Math.round(intervalSeconds * 100) / 100; // Round to 2 decimal places
    const roundedDuration = Math.round(duration * 10) / 10; // Round to 1 decimal place
    const roundedStartTime = Math.round(sourceStartTime * 10) / 10;

    if (contentSignature) {
      return `thumb_sig_${contentSignature}_${roundedStartTime}_${roundedDuration}_${roundedInterval}_${width}x${height}_q${quality}`;
    }

    // Use just the filename instead of full path for better cache sharing
    const filename = videoPath.split(/[\\/]/).pop() || videoPath;
    return `${filename}_${roundedStartTime}_${roundedDuration}_${roundedInterval}_${width}x${height}_q${quality}`;
  }

  /**
   * Clear thumbnail cache
   */
  static clearCache(): void {
    this.thumbnailCache.clear();
    this.cacheAccessTimes.clear();
    this.persistentCache.clear();
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(this.CACHE_STORAGE_KEY);
    }
  }

  /**
   * Get cache statistics for debugging
   */
  static getCacheStats() {
    return {
      size: this.thumbnailCache.size,
      maxSize: this.MAX_CACHE_SIZE,
      keys: Array.from(this.thumbnailCache.keys()),
      activeGenerations: this.activeGenerations.size,
    };
  }

  /**
   * Remove specific video from cache
   */
  static removeCacheEntry(videoPath: string): void {
    const keysToRemove = Array.from(this.thumbnailCache.keys()).filter((key) =>
      key.startsWith(videoPath),
    );
    keysToRemove.forEach((key) => {
      this.thumbnailCache.delete(key);
      this.cacheAccessTimes.delete(key);
      this.persistentCache.delete(key);
    });
    this.saveCacheToStorage();
  }

  /**
   * Get cached thumbnails if available
   */
  static getCachedThumbnails(
    options: ThumbnailOptions,
  ): VideoThumbnail[] | null {
    const entry = this.getCachedThumbnailEntry(options);
    if (entry?.thumbnails) {
      console.log(`✅ Cache HIT for ${entry.cacheKey}`);
      return entry.thumbnails;
    }

    console.log(`❌ Cache MISS for ${this.createCacheKey(options)}`);
    return null;
  }

  /**
   * Clear old cache entries when limit is reached
   */
  private static cleanupCache() {
    if (this.thumbnailCache.size <= this.MAX_CACHE_SIZE) return;

    console.log(
      `🧹 Cleaning up cache (current size: ${this.thumbnailCache.size})`,
    );

    // Sort by access time and remove oldest entries
    const sortedEntries = Array.from(this.cacheAccessTimes.entries())
      .sort(([, a], [, b]) => a - b)
      .slice(0, this.thumbnailCache.size - this.MAX_CACHE_SIZE + 10); // Remove extra 10

    for (const [key] of sortedEntries) {
      this.thumbnailCache.delete(key);
      this.cacheAccessTimes.delete(key);
    }

    console.log(`✅ Cache cleaned up (new size: ${this.thumbnailCache.size})`);
  }

  /**
   * Extract thumbnails using FFmpeg through IPC
   */
  private static async extractWithFFmpeg(
    options: ThumbnailOptions,
    cacheKey: string,
    outputDir: string,
  ): Promise<ThumbnailGenerationResult> {
    const {
      videoPath,
      duration,
      fps,
      intervalSeconds = 1,
      width = 160,
      height = 90,
      sourceStartTime = 0,
    } = options;

    // Check if we're in an Electron environment
    if (typeof window === 'undefined' || !window.electronAPI) {
      throw new Error('FFmpeg extraction requires Electron environment');
    }

    // Check if the custom FFmpeg method is available (requires app restart)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(window.electronAPI as any).runCustomFFmpeg) {
      throw new Error(
        'FFmpeg thumbnail extraction requires app restart to enable new IPC handlers',
      );
    }

    const totalThumbnails = Math.ceil(duration / intervalSeconds);
    console.log(`🎬 Extracting ${totalThumbnails} thumbnails using FFmpeg`);

    // Create a custom FFmpeg command for thumbnail extraction
    // This command will extract frames at specific intervals while preserving aspect ratio
    const thumbnailCommand = [
      '-i',
      videoPath,
      '-ss',
      sourceStartTime.toString(), // Start time
      '-t',
      duration.toString(), // Duration
      '-vf',
      `fps=1/${intervalSeconds},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear`, // Extract every N seconds and scale while preserving aspect ratio
      '-q:v',
      '5', // Lower quality
      '-vsync',
      '0',
      '-f',
      'image2', // Image sequence format
      `${outputDir}/thumb_%04d.jpg`, // Output pattern
    ];

    try {
      // Use the electron API to run the custom FFmpeg command
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (window.electronAPI as any).runCustomFFmpeg(
        thumbnailCommand,
        outputDir,
      );

      if (!result.success) {
        throw new Error(result.error || 'FFmpeg command failed');
      }

      console.log('✅ FFmpeg thumbnail extraction successful');

      // Generate thumbnail metadata
      const thumbnails: VideoThumbnail[] = [];
      for (let i = 0; i < totalThumbnails; i++) {
        const trackTimestamp = i * intervalSeconds;
        const frameNumber = Math.floor(trackTimestamp * fps);
        const thumbnailFilename = `thumb_${String(i + 1).padStart(4, '0')}.jpg`;

        // Use the media server URL for serving thumbnails
        const thumbnailUrl = `http://localhost:3001/${outputDir}/${thumbnailFilename}`;

        thumbnails.push({
          id: `${cacheKey}_${i}`,
          timestamp: trackTimestamp,
          frameNumber,
          url: thumbnailUrl,
          width,
          height,
        });
      }

      // Cache the result with cleanup
      this.saveToCache(cacheKey, thumbnails, options.persist);

      return {
        success: true,
        thumbnails,
      };
    } catch (error) {
      console.error('❌ Custom FFmpeg execution failed:', error);
      throw error;
    }
  }

  /**
   * Generate placeholder thumbnails as fallback
   */
  private static async generatePlaceholderThumbnails(
    options: ThumbnailOptions,
    cacheKey: string,
  ): Promise<ThumbnailGenerationResult> {
    const {
      duration,
      fps,
      intervalSeconds = 1,
      width = 160,
      height = 90,
      sourceStartTime = 0,
    } = options;

    console.log('📸 Falling back to placeholder thumbnail generation');

    const thumbnails: VideoThumbnail[] = [];
    const totalThumbnails = Math.ceil(duration / intervalSeconds);

    // Generate placeholder thumbnail metadata
    for (let i = 0; i < totalThumbnails; i++) {
      const trackTimestamp = i * intervalSeconds;
      const sourceTimestamp = sourceStartTime + trackTimestamp;
      const frameNumber = Math.floor(trackTimestamp * fps);

      // Create placeholder thumbnail data URL
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (ctx) {
        // Create gradient background
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(1, '#1e40af');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Add source timestamp text (shows actual video time)
        ctx.fillStyle = 'white';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.floor(sourceTimestamp)}s`, width / 2, height / 2);

        // Add track timestamp in smaller text
        ctx.font = '10px sans-serif';
        ctx.fillText(
          `+${Math.floor(trackTimestamp)}s`,
          width / 2,
          height / 2 + 15,
        );
      }

      const thumbnailUrl = canvas.toDataURL('image/jpeg', 0.8);

      thumbnails.push({
        id: `${cacheKey}_${i}`,
        timestamp: trackTimestamp,
        frameNumber,
        url: thumbnailUrl,
        width,
        height,
      });
    }

    // Cache the result
    this.saveToCache(cacheKey, thumbnails, options.persist);

    return {
      success: true,
      thumbnails,
    };
  }

  /**
   * Calculate optimal thumbnail count based on zoom level and viewport
   */
  static calculateOptimalThumbnailCount(
    duration: number,
    frameWidth: number,
    viewportWidth: number,
    zoomLevel: number,
  ): { intervalSeconds: number; estimatedCount: number } {
    // Calculate how many pixels represent one second at current zoom
    const pixelsPerSecond = frameWidth * 30; // Assuming 30 fps base
    const scaledPixelsPerSecond = pixelsPerSecond * zoomLevel;

    // Target thumbnail width should be around 160px for good visibility
    const targetThumbnailWidth = 160;

    // Calculate optimal interval
    const optimalInterval = Math.max(
      0.5,
      targetThumbnailWidth / scaledPixelsPerSecond,
    );

    // Round to reasonable intervals (0.5, 1, 2, 5, 10 seconds)
    const intervals = [0.5, 1, 2, 5, 10];
    const intervalSeconds = intervals.reduce((prev, curr) =>
      Math.abs(curr - optimalInterval) < Math.abs(prev - optimalInterval)
        ? curr
        : prev,
    );

    const estimatedCount = Math.ceil(duration / intervalSeconds);

    return { intervalSeconds, estimatedCount };
  }
}

export default VideoThumbnailGenerator;
