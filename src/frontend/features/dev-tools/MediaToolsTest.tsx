import { Button } from '@/frontend/components/ui/button';
import { Progress } from '@/frontend/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/frontend/components/ui/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/frontend/components/ui/tabs';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

// ============================================================================
// Types
// ============================================================================

interface MediaToolsStatus {
  available: boolean;
  mode: 'standalone' | 'python' | 'unavailable';
  mediaToolsPath: string | null;
  pythonPath: string | null;
  mainPyScriptPath: string | null;
  isProcessing: boolean;
}

interface WhisperResult {
  segments: Array<{
    start: number;
    end: number;
    text: string;
    words?: Array<{
      word: string;
      start: number;
      end: number;
      confidence: number;
    }>;
  }>;
  language: string;
  language_probability: number;
  duration: number;
  text: string;
  processing_time: number;
  model: string;
  device: string;
  segment_count: number;
  real_time_factor?: number;
  faster_than_realtime?: boolean;
}
type WhisperSegment = WhisperResult['segments'][number];

interface NoiseReductionResult {
  success: boolean;
  outputPath: string;
  message?: string;
}

interface SelectedMediaFile {
  path: string;
  name: string;
  type?: 'video' | 'audio' | 'image';
}

type PreviewMediaKind = 'video' | 'audio';

type WhisperModel =
  | 'tiny'
  | 'base'
  | 'small'
  | 'medium'
  | 'large'
  | 'large-v2'
  | 'large-v3';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']);

const AUDIO_EXTENSIONS = new Set([
  'wav',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'opus',
]);

const TRANSCRIPTION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRANSCRIPTION_CACHE_ENTRIES = 8;
const TRANSCRIPTION_CACHE_STORAGE_KEY = 'devtools:transcription-cache:v1';

const subtitleOverlayStyle: CSSProperties = {
  fontSize: 'clamp(14px, 1.6vw, 18px)',
  fontFamily: 'Arial, sans-serif',
  fontWeight: 600,
  textAlign: 'center',
  lineHeight: 1.25,
  color: '#FFFFFF',
  textShadow: '2px 2px 4px rgba(0, 0, 0, 1), -1px -1px 2px rgba(0, 0, 0, 0.85)',
  wordWrap: 'break-word',
  whiteSpace: 'pre-wrap',
  padding: '2px 0',
  margin: '0 auto',
  position: 'relative',
  display: 'inline-block',
  maxWidth: '90%',
};

interface CachedTranscriptionEntry {
  key: string;
  file: SelectedMediaFile;
  model: WhisperModel;
  result: WhisperResult;
  cachedAt: number;
  expiresAt: number;
}

interface CachedTranscriptionStore {
  entries: CachedTranscriptionEntry[];
  lastSelection: {
    file: SelectedMediaFile;
    model: WhisperModel;
  } | null;
}

const transcriptionMemoryCache = new Map<string, CachedTranscriptionEntry>();
let transcriptionLastSelection: CachedTranscriptionStore['lastSelection'] =
  null;
let transcriptionCacheHydrated = false;

const inferPreviewMediaKind = (
  filePath: string,
  type?: 'video' | 'audio' | 'image',
): PreviewMediaKind => {
  if (type === 'video' || type === 'image') return 'video';
  if (type === 'audio') return 'audio';

  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'audio';
};

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatVttTimestamp = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis
    .toString()
    .padStart(3, '0')}`;
};

const buildWebVttFromSegments = (
  segments: Array<{ start: number; end: number; text: string }>,
): string => {
  const lines: string[] = ['WEBVTT', ''];

  segments.forEach((segment, index) => {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end))
      return;
    if (segment.end <= segment.start) return;

    const start = formatVttTimestamp(segment.start);
    const end = formatVttTimestamp(segment.end);
    const text = (segment.text || '').replace(/\r?\n/g, ' ').trim();
    if (!text) return;

    lines.push(`${index + 1}`);
    lines.push(`${start} --> ${end}`);
    lines.push(text);
    lines.push('');
  });

  return lines.join('\n');
};

const getTranscriptionCacheKey = (
  filePath: string,
  model: WhisperModel,
): string => `${model}::${filePath}`;

const hydrateTranscriptionCache = () => {
  if (transcriptionCacheHydrated || typeof window === 'undefined') return;
  transcriptionCacheHydrated = true;

  try {
    const raw = window.localStorage.getItem(TRANSCRIPTION_CACHE_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw) as CachedTranscriptionStore;
    const now = Date.now();

    if (Array.isArray(parsed?.entries)) {
      parsed.entries.forEach((entry) => {
        if (
          entry &&
          typeof entry.key === 'string' &&
          entry.expiresAt > now &&
          entry.result
        ) {
          transcriptionMemoryCache.set(entry.key, entry);
        }
      });
    }

    transcriptionLastSelection = parsed?.lastSelection ?? null;
  } catch {
    transcriptionMemoryCache.clear();
    transcriptionLastSelection = null;
  }
};

const persistTranscriptionCache = () => {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const entries = [...transcriptionMemoryCache.values()]
    .filter((entry) => entry.expiresAt > now)
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .slice(0, MAX_TRANSCRIPTION_CACHE_ENTRIES);

  transcriptionMemoryCache.clear();
  entries.forEach((entry) => {
    transcriptionMemoryCache.set(entry.key, entry);
  });

  const payload: CachedTranscriptionStore = {
    entries,
    lastSelection: transcriptionLastSelection,
  };
  window.localStorage.setItem(
    TRANSCRIPTION_CACHE_STORAGE_KEY,
    JSON.stringify(payload),
  );
};

const getCachedTranscription = (
  filePath: string,
  model: WhisperModel,
): CachedTranscriptionEntry | null => {
  hydrateTranscriptionCache();
  const key = getTranscriptionCacheKey(filePath, model);
  const cached = transcriptionMemoryCache.get(key);

  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    transcriptionMemoryCache.delete(key);
    persistTranscriptionCache();
    return null;
  }

  return cached;
};

const setCachedTranscription = (
  file: SelectedMediaFile,
  model: WhisperModel,
  result: WhisperResult,
) => {
  hydrateTranscriptionCache();
  const now = Date.now();
  const key = getTranscriptionCacheKey(file.path, model);

  transcriptionMemoryCache.set(key, {
    key,
    file,
    model,
    result,
    cachedAt: now,
    expiresAt: now + TRANSCRIPTION_CACHE_TTL_MS,
  });

  persistTranscriptionCache();
};

const getCachedTranscriptionSelection = () => {
  hydrateTranscriptionCache();
  return transcriptionLastSelection;
};

const setCachedTranscriptionSelection = (
  file: SelectedMediaFile | null,
  model: WhisperModel,
) => {
  hydrateTranscriptionCache();
  transcriptionLastSelection = file ? { file, model } : null;
  persistTranscriptionCache();
};

const PlainSubtitle = ({ segment }: { segment: WhisperSegment | null }) => {
  if (!segment) return null;

  return <div style={subtitleOverlayStyle}>{segment.text}</div>;
};

const decodeNoisePreviewUrl = async (filePath: string): Promise<string> => {
  const previewResult =
    await window.electronAPI.noiseReductionCreatePreviewUrl(filePath);

  if (!previewResult.success || !previewResult.base64) {
    throw new Error(previewResult.error || 'Failed to create preview URL');
  }

  const binary = atob(previewResult.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], {
    type: previewResult.mimeType || 'audio/wav',
  });
  return URL.createObjectURL(blob);
};

const resolvePreviewUrl = async (filePath: string): Promise<string> => {
  const previewResult = await window.electronAPI.createPreviewUrl(filePath);
  if (!previewResult.success || !previewResult.url) {
    throw new Error(
      previewResult.error || 'Failed to create media preview URL',
    );
  }
  return previewResult.url;
};

const PreviewCard = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => {
  return (
    <div className="rounded-lg border border-border bg-card p-4 lg:p-5 h-full">
      <div className="space-y-1 mb-3">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const MediaToolsTest = () => {
  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto min-h-0 flex-1 overflow-y-auto">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="space-y-2 mb-6">
          <h2 className="text-2xl font-bold">Media Tools Test Interface</h2>
          <p className="text-sm text-muted-foreground">
            Test transcription and noise reduction using the unified
            dividr-tools binary
          </p>
        </div>

        <Tabs defaultValue="transcribe" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="transcribe">Transcription</TabsTrigger>
            <TabsTrigger value="noise-reduce">Noise Reduction</TabsTrigger>
          </TabsList>

          <TabsContent
            value="status"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            <StatusPanel />
          </TabsContent>

          <TabsContent
            value="transcribe"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            <TranscriptionPanel />
          </TabsContent>

          <TabsContent
            value="noise-reduce"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            <NoiseReductionPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

// ============================================================================
// Status Panel
// ============================================================================

const StatusPanel = () => {
  const [status, setStatus] = useState<MediaToolsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCheckStatus = async () => {
    try {
      setError(null);
      const statusResult = await window.electronAPI.mediaToolsStatus();
      setStatus(statusResult);
    } catch (err) {
      console.error('[MediaToolsTest] Failed to get status', err);
      setError(err instanceof Error ? err.message : 'Failed to get status');
    }
  };

  return (
    <div className="space-y-4">
      <Button onClick={handleCheckStatus} variant="outline">
        Check Media Tools Status
      </Button>

      {error && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {status && (
        <div className="rounded-md border border-border bg-muted/50 p-4">
          <div className="space-y-2 text-sm">
            <div>
              <strong>Available:</strong> {status.available ? 'Yes' : 'No'}
            </div>
            <div>
              <strong>Mode:</strong>{' '}
              <span className="capitalize">{status.mode}</span>
            </div>
            {status.mediaToolsPath && (
              <div>
                <strong>Binary Path:</strong>{' '}
                <span className="break-all">{status.mediaToolsPath}</span>
              </div>
            )}
            {status.pythonPath && (
              <div>
                <strong>Python Path:</strong> {status.pythonPath}
              </div>
            )}
            {status.mainPyScriptPath && (
              <div>
                <strong>Script Path:</strong>{' '}
                <span className="break-all">{status.mainPyScriptPath}</span>
              </div>
            )}
            <div>
              <strong>Processing:</strong> {status.isProcessing ? 'Yes' : 'No'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Transcription Panel
// ============================================================================

const TranscriptionPanel = () => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [result, setResult] = useState<WhisperResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedMediaFile | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<WhisperModel>('base');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [subtitleTrackUrl, setSubtitleTrackUrl] = useState<string | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const previewKind = useMemo<PreviewMediaKind>(() => {
    if (!selectedFile) return 'audio';
    return inferPreviewMediaKind(selectedFile.path, selectedFile.type);
  }, [selectedFile]);

  const activeSegmentIndex = useMemo(() => {
    if (!result?.segments?.length) return -1;
    return result.segments.findIndex(
      (segment) => previewTime >= segment.start && previewTime < segment.end,
    );
  }, [result?.segments, previewTime]);

  const activeSegment =
    activeSegmentIndex >= 0 && result?.segments
      ? result.segments[activeSegmentIndex]
      : null;

  useEffect(() => {
    const selection = getCachedTranscriptionSelection();
    if (!selection?.file?.path) return;

    setSelectedFile(selection.file);
    setSelectedModel(selection.model);

    const cached = getCachedTranscription(selection.file.path, selection.model);
    if (cached) {
      setResult(cached.result);
      setCacheNotice('Loaded cached transcription (TTL: 1 hour).');
    }
  }, []);

  const handleSelectFile = async () => {
    try {
      const fileResult = await window.electronAPI.openFileDialog({
        title: 'Select Audio/Video File',
        filters: [
          {
            name: 'Audio Files',
            extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'opus'],
          },
          {
            name: 'Video Files',
            extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm'],
          },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (
        fileResult.success &&
        fileResult.files &&
        fileResult.files.length > 0
      ) {
        const file = fileResult.files[0];
        setSelectedFile({
          path: file.path,
          name: file.name,
          type: file.type,
        });
        setResult(null);
        setCacheNotice(null);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select file');
    }
  };

  useEffect(() => {
    if (!selectedFile?.path) return;

    setCachedTranscriptionSelection(selectedFile, selectedModel);

    const cached = getCachedTranscription(selectedFile.path, selectedModel);
    if (cached) {
      setResult(cached.result);
      setError(null);
      setCacheNotice('Loaded cached transcription (TTL: 1 hour).');
      return;
    }

    setResult(null);
    setCacheNotice(null);
  }, [selectedFile, selectedModel]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!selectedFile?.path) {
        setPreviewUrl(null);
        setPreviewError(null);
        setPreviewTime(0);
        return;
      }

      try {
        setPreviewLoading(true);
        setPreviewError(null);
        const url = await resolvePreviewUrl(selectedFile.path);
        if (!cancelled) {
          setPreviewUrl(url);
          setPreviewTime(0);
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewUrl(null);
          setPreviewError(
            err instanceof Error ? err.message : 'Failed to load media preview',
          );
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [selectedFile?.path]);

  useEffect(() => {
    if (!result?.segments?.length) {
      setSubtitleTrackUrl((previousUrl) => {
        if (previousUrl) {
          URL.revokeObjectURL(previousUrl);
        }
        return null;
      });
      return;
    }

    const vtt = buildWebVttFromSegments(result.segments);
    const blob = new Blob([vtt], { type: 'text/vtt' });
    const trackUrl = URL.createObjectURL(blob);

    setSubtitleTrackUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return trackUrl;
    });

    return () => {
      URL.revokeObjectURL(trackUrl);
    };
  }, [result?.segments]);

  useEffect(() => {
    const element = mediaRef.current;
    if (!element || element.tagName !== 'VIDEO' || !subtitleTrackUrl) return;

    const syncTrackMode = () => {
      const track = element.textTracks?.[0];
      if (track) {
        track.mode = 'showing';
      }
    };

    syncTrackMode();
    element.addEventListener('loadeddata', syncTrackMode);
    return () => {
      element.removeEventListener('loadeddata', syncTrackMode);
    };
  }, [subtitleTrackUrl, previewUrl]);

  useEffect(() => {
    return () => {
      if (mediaRef.current) {
        mediaRef.current.pause();
        mediaRef.current.removeAttribute('src');
        mediaRef.current.load();
      }
      window.electronAPI.removeWhisperProgressListener();
    };
  }, []);

  const seekToSegment = (startTime: number) => {
    if (!mediaRef.current) return;
    mediaRef.current.currentTime = Math.max(0, startTime);
    setPreviewTime(mediaRef.current.currentTime);
  };

  const handleTranscribe = async () => {
    if (!selectedFile?.path) {
      setError('Please select an audio file first');
      return;
    }

    const cached = getCachedTranscription(selectedFile.path, selectedModel);
    if (cached) {
      setResult(cached.result);
      setError(null);
      setCacheNotice('Loaded cached transcription (TTL: 1 hour).');
      return;
    }

    setIsTranscribing(true);
    setError(null);
    setResult(null);
    setCacheNotice(null);
    setProgress(0);
    setProgressMessage('Starting...');

    window.electronAPI.onWhisperProgress((progressData) => {
      setProgress(progressData.progress);
      setProgressMessage(progressData.message || '');
    });

    try {
      const transcriptionResult = await window.electronAPI.whisperTranscribe(
        selectedFile.path,
        {
          model: selectedModel,
          device: 'cpu',
          computeType: 'int8',
          beamSize: 5,
          vad: true,
        },
      );

      if (transcriptionResult.success && transcriptionResult.result) {
        setResult(transcriptionResult.result);
        setCachedTranscription(
          selectedFile,
          selectedModel,
          transcriptionResult.result,
        );
        setCacheNotice('Transcription cached for 1 hour.');
      } else {
        setError(transcriptionResult.error || 'Transcription failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setIsTranscribing(false);
      window.electronAPI.removeWhisperProgressListener();
    }
  };

  const handleCancel = async () => {
    try {
      await window.electronAPI.whisperCancel();
      setIsTranscribing(false);
      setProgressMessage('Cancelled');
    } catch (err) {
      console.error('[MediaToolsTest] Failed to cancel', err);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,480px)] gap-6">
      <div className="space-y-6">
        {/* File Selection */}
        <div className="space-y-3">
          <Button onClick={handleSelectFile} variant="outline">
            Select Audio/Video File
          </Button>
          {selectedFile && (
            <div className="text-sm text-muted-foreground break-all">
              <strong>Selected:</strong> {selectedFile.path}
            </div>
          )}
        </div>

        {/* Model Selection */}
        <div className="space-y-3">
          <label className="text-sm font-medium">Whisper Model</label>
          <Select
            value={selectedModel}
            onValueChange={(value) => setSelectedModel(value as WhisperModel)}
            disabled={isTranscribing}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tiny">Tiny (fastest)</SelectItem>
              <SelectItem value="base">Base (recommended)</SelectItem>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="large">Large</SelectItem>
              <SelectItem value="large-v2">Large v2</SelectItem>
              <SelectItem value="large-v3">Large v3 (most accurate)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Controls */}
        <div className="flex gap-2">
          <Button
            onClick={handleTranscribe}
            disabled={!selectedFile || isTranscribing}
          >
            {isTranscribing ? 'Transcribing...' : 'Start Transcription'}
          </Button>
          {isTranscribing && (
            <Button onClick={handleCancel} variant="destructive">
              Cancel
            </Button>
          )}
        </div>

        {cacheNotice && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            {cacheNotice}
          </div>
        )}

        {/* Progress */}
        {isTranscribing && (
          <div className="space-y-2">
            <Progress value={progress} className="w-full" />
            <div className="text-sm text-muted-foreground">
              {progressMessage} ({progress}%)
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="rounded-lg border border-border bg-card p-6 space-y-4">
            <h3 className="text-xl font-semibold">Transcription Result</h3>

            <div className="grid grid-cols-2 gap-3">
              <div className="text-sm">
                <strong>Language:</strong> {result.language}
              </div>
              <div className="text-sm">
                <strong>Confidence:</strong>{' '}
                {(result.language_probability * 100).toFixed(1)}%
              </div>
              <div className="text-sm">
                <strong>Duration:</strong> {result.duration.toFixed(2)}s
              </div>
              <div className="text-sm">
                <strong>Processing:</strong> {result.processing_time.toFixed(2)}
                s
              </div>
              <div className="text-sm">
                <strong>Segments:</strong> {result.segment_count}
              </div>
              <div className="text-sm">
                <strong>Model:</strong> {result.model}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="font-semibold">Full Transcription:</h4>
              <div className="p-4 bg-muted rounded-md text-sm">
                {result.text}
              </div>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer font-semibold">
                View Raw JSON
              </summary>
              <pre className="mt-2 p-4 bg-muted rounded-md overflow-x-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>

      <PreviewCard
        title="Sandbox Preview"
        description="Read-only preview with timed transcription subtitles."
      >
        {!selectedFile && (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-6 text-sm text-muted-foreground">
            Select a media file to enable preview.
          </div>
        )}

        {selectedFile && previewLoading && (
          <div className="rounded-lg bg-black/90 border border-border/60 text-muted-foreground flex items-center justify-center aspect-video">
            Loading preview...
          </div>
        )}

        {selectedFile && previewError && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-xs text-destructive">
            {previewError}
          </div>
        )}

        {selectedFile && previewUrl && previewKind === 'video' && (
          <div className="relative rounded-lg border border-border/70 bg-black overflow-hidden aspect-video">
            <video
              ref={(el) => {
                mediaRef.current = el;
              }}
              src={previewUrl}
              className="w-full h-full object-contain"
              controls
              onTimeUpdate={(e) => setPreviewTime(e.currentTarget.currentTime)}
              onSeeked={(e) => setPreviewTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) =>
                setPreviewTime(e.currentTarget.currentTime || 0)
              }
            >
              {subtitleTrackUrl && (
                <track
                  key={subtitleTrackUrl}
                  kind="subtitles"
                  src={subtitleTrackUrl}
                  srcLang={result?.language || 'en'}
                  label="Transcription"
                  default
                />
              )}
            </video>
          </div>
        )}

        {selectedFile && previewUrl && previewKind === 'audio' && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border/70 bg-black/90 aspect-video flex items-center justify-center px-4">
              <div className="text-center space-y-2 max-w-md">
                <p className="text-sm text-muted-foreground">
                  Audio preview with timed transcription overlay
                </p>
                {activeSegment ? (
                  <PlainSubtitle segment={activeSegment} />
                ) : (
                  <div className="text-xs text-muted-foreground">
                    {result?.segments?.length
                      ? 'Play audio to preview subtitle timing'
                      : 'Run transcription to render subtitles'}
                  </div>
                )}
              </div>
            </div>
            <audio
              ref={(el) => {
                mediaRef.current = el;
              }}
              src={previewUrl}
              className="w-full"
              controls
              onTimeUpdate={(e) => setPreviewTime(e.currentTarget.currentTime)}
              onSeeked={(e) => setPreviewTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) =>
                setPreviewTime(e.currentTarget.currentTime || 0)
              }
            />
          </div>
        )}

        {result && (
          <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center justify-between">
            <span>Active subtitle time: {formatTime(previewTime)}</span>
            {activeSegment && (
              <span>
                {formatTime(activeSegment.start)} -{' '}
                {formatTime(activeSegment.end)}
              </span>
            )}
          </div>
        )}

        {result?.segments?.length ? (
          <div className="rounded-md border border-border/70 bg-muted/30 p-2 max-h-44 overflow-y-auto space-y-1">
            {result.segments.map((segment, index) => (
              <button
                key={`${segment.start}-${segment.end}-${index}`}
                type="button"
                className={`w-full text-left rounded px-2 py-1 text-xs transition-colors ${
                  index === activeSegmentIndex
                    ? 'bg-primary/20 text-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                onClick={() => seekToSegment(segment.start)}
              >
                <span className="inline-block min-w-20 font-mono">
                  {formatTime(segment.start)}
                </span>
                {segment.text.trim()}
              </button>
            ))}
          </div>
        ) : null}
      </PreviewCard>
    </div>
  );
};

// ============================================================================
// Noise Reduction Panel
// ============================================================================

const NoiseReductionPanel = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [result, setResult] = useState<NoiseReductionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputFile, setInputFile] = useState<SelectedMediaFile | null>(null);
  const [outputFile, setOutputFile] = useState<string | null>(null);
  const [propDecrease, setPropDecrease] = useState(0.8);
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(
    null,
  );
  const [processedPreviewUrl, setProcessedPreviewUrl] = useState<string | null>(
    null,
  );
  const [activePreviewMode, setActivePreviewMode] = useState<
    'original' | 'reduced'
  >('original');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const processedBlobUrlRef = useRef<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const handleSelectInput = async () => {
    try {
      const fileResult = await window.electronAPI.openFileDialog({
        title: 'Select Input Audio File',
        filters: [
          { name: 'WAV Files', extensions: ['wav'] },
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (
        fileResult.success &&
        fileResult.files &&
        fileResult.files.length > 0
      ) {
        const file = fileResult.files[0];
        const inputPath = file.path;
        setInputFile({
          path: file.path,
          name: file.name,
          type: file.type,
        });
        // Auto-generate output path
        const outputPath = inputPath.replace(/(\.[^.]+)$/, '_clean$1');
        setOutputFile(outputPath);
        setResult(null);
        setActivePreviewMode('original');
        setProcessedPreviewUrl(null);
        setPreviewTime(0);
        setPreviewError(null);
        if (processedBlobUrlRef.current) {
          URL.revokeObjectURL(processedBlobUrlRef.current);
          processedBlobUrlRef.current = null;
        }
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select file');
    }
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!inputFile?.path) {
        setOriginalPreviewUrl(null);
        return;
      }

      try {
        setPreviewLoading(true);
        setPreviewError(null);
        const url = await resolvePreviewUrl(inputFile.path);
        if (!cancelled) {
          setOriginalPreviewUrl(url);
        }
      } catch (err) {
        if (!cancelled) {
          setOriginalPreviewUrl(null);
          setPreviewError(
            err instanceof Error
              ? err.message
              : 'Failed to load source preview',
          );
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [inputFile?.path]);

  useEffect(() => {
    return () => {
      if (processedBlobUrlRef.current) {
        URL.revokeObjectURL(processedBlobUrlRef.current);
        processedBlobUrlRef.current = null;
      }
      if (audioPreviewRef.current) {
        audioPreviewRef.current.pause();
        audioPreviewRef.current.removeAttribute('src');
        audioPreviewRef.current.load();
      }
      window.electronAPI.removeMediaToolsProgressListener();
    };
  }, []);

  const handleSelectOutput = async () => {
    try {
      const result = await window.electronAPI.showSaveDialog({
        title: 'Save Cleaned Audio',
        defaultPath: outputFile || 'cleaned_audio.wav',
        filters: [
          { name: 'WAV Files', extensions: ['wav'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.success && result.filePath) {
        setOutputFile(result.filePath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select output');
    }
  };

  const handleNoiseReduce = async () => {
    if (!inputFile || !outputFile) {
      setError('Please select input and output files');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setResult(null);
    setProcessedPreviewUrl(null);
    setActivePreviewMode('original');
    if (processedBlobUrlRef.current) {
      URL.revokeObjectURL(processedBlobUrlRef.current);
      processedBlobUrlRef.current = null;
    }
    setProgress(0);
    setProgressMessage('Starting...');

    window.electronAPI.onMediaToolsProgress((progressData) => {
      setProgress(progressData.progress);
      setProgressMessage(progressData.message || '');
    });

    try {
      const noiseResult = await window.electronAPI.mediaToolsNoiseReduce(
        inputFile.path,
        outputFile,
        {
          stationary: true,
          propDecrease,
        },
      );

      if (noiseResult.success && noiseResult.result) {
        setResult(noiseResult.result);
        setPreviewLoading(true);
        setPreviewError(null);

        const previewBlobUrl = await decodeNoisePreviewUrl(
          noiseResult.result.outputPath,
        );

        if (processedBlobUrlRef.current) {
          URL.revokeObjectURL(processedBlobUrlRef.current);
        }
        processedBlobUrlRef.current = previewBlobUrl;
        setProcessedPreviewUrl(previewBlobUrl);
        setActivePreviewMode('reduced');
      } else {
        setError(noiseResult.error || 'Noise reduction failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noise reduction failed');
      setPreviewError(
        err instanceof Error
          ? err.message
          : 'Failed to build processed preview',
      );
    } finally {
      setIsProcessing(false);
      setPreviewLoading(false);
      window.electronAPI.removeMediaToolsProgressListener();
    }
  };

  const handleCancel = async () => {
    try {
      await window.electronAPI.mediaToolsCancel();
      setIsProcessing(false);
      setProgressMessage('Cancelled');
    } catch (err) {
      console.error('[MediaToolsTest] Failed to cancel', err);
    }
  };

  const activePreviewUrl =
    activePreviewMode === 'reduced' && processedPreviewUrl
      ? processedPreviewUrl
      : originalPreviewUrl;

  const canCompare = Boolean(originalPreviewUrl && processedPreviewUrl);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,480px)] gap-6">
      <div className="space-y-6">
        {/* Input File Selection */}
        <div className="space-y-3">
          <Button onClick={handleSelectInput} variant="outline">
            Select Input Audio File
          </Button>
          {inputFile && (
            <div className="text-sm text-muted-foreground break-all">
              <strong>Input:</strong> {inputFile.path}
            </div>
          )}
        </div>

        {/* Output File Selection */}
        <div className="space-y-3">
          <Button
            onClick={handleSelectOutput}
            variant="outline"
            disabled={!inputFile}
          >
            Select Output Location
          </Button>
          {outputFile && (
            <div className="text-sm text-muted-foreground break-all">
              <strong>Output:</strong> {outputFile}
            </div>
          )}
        </div>

        {/* Noise Reduction Strength */}
        <div className="space-y-3">
          <label className="text-sm font-medium">
            Noise Reduction Strength: {(propDecrease * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={propDecrease * 100}
            onChange={(e) => setPropDecrease(Number(e.target.value) / 100)}
            className="w-full"
            disabled={isProcessing}
          />
          <p className="text-xs text-muted-foreground">
            Higher values remove more noise but may affect audio quality
          </p>
        </div>

        {/* Controls */}
        <div className="flex gap-2">
          <Button
            onClick={handleNoiseReduce}
            disabled={!inputFile || !outputFile || isProcessing}
          >
            {isProcessing ? 'Processing...' : 'Start Noise Reduction'}
          </Button>
          {isProcessing && (
            <Button onClick={handleCancel} variant="destructive">
              Cancel
            </Button>
          )}
        </div>

        {/* Progress */}
        {isProcessing && (
          <div className="space-y-2">
            <Progress value={progress} className="w-full" />
            <div className="text-sm text-muted-foreground">
              {progressMessage} ({progress}%)
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="rounded-lg border border-border bg-card p-6 space-y-4">
            <h3 className="text-xl font-semibold">Noise Reduction Complete</h3>
            <div className="space-y-2 text-sm">
              <div>
                <strong>Status:</strong> {result.success ? 'Success' : 'Failed'}
              </div>
              <div className="break-all">
                <strong>Output:</strong> {result.outputPath}
              </div>
              {result.message && (
                <div>
                  <strong>Message:</strong> {result.message}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <PreviewCard
        title="Sandbox Preview"
        description="Read-only output playback from generated files. No timeline writes, media registry changes, or autosave."
      >
        {!inputFile && (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-6 text-sm text-muted-foreground">
            Select an input file to enable preview.
          </div>
        )}

        {inputFile && (
          <div className="rounded-lg border border-border/70 bg-black/90 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Button
                variant={
                  activePreviewMode === 'original' ? 'default' : 'outline'
                }
                size="sm"
                onClick={() => setActivePreviewMode('original')}
                disabled={!originalPreviewUrl}
              >
                A: Original
              </Button>
              <Button
                variant={
                  activePreviewMode === 'reduced' ? 'default' : 'outline'
                }
                size="sm"
                onClick={() => setActivePreviewMode('reduced')}
                disabled={!processedPreviewUrl}
              >
                B: Noise Reduced
              </Button>
              {canCompare && (
                <span className="text-[11px] text-muted-foreground">
                  A/B comparison
                </span>
              )}
            </div>

            <div className="text-[11px] text-muted-foreground break-all">
              Source:{' '}
              {activePreviewMode === 'reduced' && result
                ? result.outputPath
                : inputFile.path}
            </div>

            {previewLoading && (
              <div className="text-xs text-muted-foreground">
                Loading preview...
              </div>
            )}

            {previewError && (
              <div className="rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
                {previewError}
              </div>
            )}

            {activePreviewUrl ? (
              <audio
                ref={audioPreviewRef}
                src={activePreviewUrl}
                controls
                className="w-full"
                onTimeUpdate={(e) =>
                  setPreviewTime(e.currentTarget.currentTime)
                }
                onSeeked={(e) => setPreviewTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) =>
                  setPreviewTime(e.currentTarget.currentTime || 0)
                }
              />
            ) : (
              <div className="text-xs text-muted-foreground">
                Run noise reduction to preview output.
              </div>
            )}
          </div>
        )}

        {activePreviewUrl && (
          <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Preview time: {formatTime(previewTime)}
          </div>
        )}
      </PreviewCard>
    </div>
  );
};

export default MediaToolsTest;
