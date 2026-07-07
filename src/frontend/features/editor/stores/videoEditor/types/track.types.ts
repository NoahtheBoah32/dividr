// =============================================================================
// CLIP METADATA - Pure Data Model for Frame-Driven Playback
// =============================================================================
//
// ClipMetadata represents a clip as PURE DATA with NO playback state.
// This is the foundation of the frame-driven playback architecture.
//
// Key principles:
// - Clips NEVER own decoders, video elements, or playback state
// - Clips are immutable during playback
// - Source frames are calculated deterministically from timeline position
// - Multiple clips can safely reference the same source
//
// The source frame formula:
//   sourceFrame = timelineFrame - timelineStartFrame + inFrame
//
// =============================================================================

// =============================================================================
// AUDIO METADATA - Audio Processing Intent Model
// =============================================================================
//
// AudioMetadata represents the audio processing intent for a clip.
// This is a DATA-ONLY model - no processing logic is executed here.
//
// Used by:
// - Audio clips (standalone)
// - Video clips with embedded/linked audio
//
// The data is passed forward to mediaToolsRunner for processing.
// =============================================================================

/**
 * Volume value in decibels.
 * - Numeric values: -60 to +12 dB
 * - '-inf': Represents complete silence (mute)
 */
export type VolumeDb = number | '-inf';

/**
 * Noise reduction engine types.
 * - 'ffmpeg': Built-in FFmpeg noise reduction (always available)
 * - 'deepfilter': DeepFilterNet2 AI-based noise reduction (requires runtime)
 */
export type NoiseReductionEngine = 'ffmpeg' | 'deepfilter';

/**
 * AudioMetadata - Audio processing settings for a clip.
 *
 * This interface represents the user's INTENT for audio processing.
 * No actual processing occurs - data is forwarded to mediaToolsRunner.
 *
 * Default values:
 * - volumeDb: 0 (unity gain)
 * - noiseReductionEnabled: false
 */
export interface AudioMetadata {
  /**
   * Volume in decibels.
   * - Range: -60 to +12 dB
   * - Use '-inf' for complete mute
   * - 0 dB = unity gain (no change)
   */
  volumeDb: VolumeDb;

  /**
   * Whether noise reduction processing is enabled.
   * This is a boolean flag only - no parameters or model selection.
   * When true, signals intent to apply noise reduction during export.
   */
  noiseReductionEnabled: boolean;

  /**
   * The noise reduction engine to use.
   * Only relevant when noiseReductionEnabled is true.
   */
  noiseReductionEngine?: NoiseReductionEngine;
}

/**
 * Default audio metadata values.
 * Used when initializing new audio-capable clips.
 */
export const DEFAULT_AUDIO_METADATA: AudioMetadata = {
  volumeDb: 0,
  noiseReductionEnabled: false,
  noiseReductionEngine: undefined,
};

/**
 * MediaToolsAudioPayload - Payload structure for mediaToolsRunner.
 *
 * This is the data format sent to mediaToolsRunner for audio processing.
 * Intent-only: no processing is executed, just data forwarding.
 */
export interface MediaToolsAudioPayload {
  /** Volume in decibels (-60 to +12, or '-inf' for mute) */
  volumeDb: VolumeDb;
  /** Whether to apply noise reduction */
  noiseReduction: boolean;
}

/**
 * Extracts audio metadata from a track as a structured object.
 * Returns default values for any missing properties.
 */
export const getAudioMetadata = (track: {
  volumeDb?: number;
  noiseReductionEnabled?: boolean;
  noiseReductionEngine?: NoiseReductionEngine;
}): AudioMetadata => {
  return {
    volumeDb: track.volumeDb ?? DEFAULT_AUDIO_METADATA.volumeDb,
    noiseReductionEnabled:
      track.noiseReductionEnabled ??
      DEFAULT_AUDIO_METADATA.noiseReductionEnabled,
    noiseReductionEngine: track.noiseReductionEngine,
  };
};

/**
 * Creates a mediaToolsRunner payload from track audio properties.
 * This is DATA-ONLY - no processing is executed.
 */
export const createMediaToolsAudioPayload = (track: {
  volumeDb?: number;
  noiseReductionEnabled?: boolean;
}): MediaToolsAudioPayload => {
  const audio = getAudioMetadata(track);
  return {
    volumeDb: audio.volumeDb,
    noiseReduction: audio.noiseReductionEnabled,
  };
};

/**
 * ClipMetadata - Stateless representation of a media clip.
 *
 * This interface ensures clips contain ONLY metadata:
 * - No decoder references
 * - No loading flags
 * - No playback position
 * - No render ownership
 *
 * Used by FrameResolver for deterministic frame resolution.
 */
export interface ClipMetadata {
  /** Unique clip identifier */
  clipId: string;

  /** Normalized source identifier (URL pathname) */
  sourceId: string;

  /** Raw source URL */
  sourceUrl: string;

  /** In-point in source media (frame number) - where this clip starts in the source */
  inFrame: number;

  /** Out-point in source media (frame number) - where this clip ends in the source */
  outFrame: number;

  /** Timeline start frame - where this clip starts on the timeline */
  timelineStartFrame: number;

  /** Timeline end frame - where this clip ends on the timeline */
  timelineEndFrame: number;

  /** Track row index for z-ordering (0 = behind, higher = in front) */
  trackRowIndex: number;

  /** Layer within the track for additional z-ordering */
  layer: number;
}

/**
 * AudioClipMetadata - Stateless representation of an audio clip.
 */
export interface AudioClipMetadata extends ClipMetadata {
  /** Volume level (0-1) */
  volume: number;

  /** Whether the clip is muted */
  muted: boolean;
}

// =============================================================================
// VIDEO TRACK - Full Track Model
// =============================================================================
//
// VideoTrack is the complete track model stored in state.
// It contains all metadata for timeline display and manipulation.
//
// IMPORTANT: VideoTrack should NOT contain playback state like:
// - currentPlaybackTime
// - isBuffering
// - decoderReference
//
// Playback state is managed by the SourceRegistry and compositor.
// =============================================================================

export interface VideoTrack {
  id: string;
  type: 'video' | 'audio' | 'image' | 'subtitle' | 'text';
  name: string;
  source: string;
  previewUrl?: string;
  /** Immutable pristine source. Nuanced effects (freeze, region-speed) re-bake from
   *  THIS, never from the prior baked output, so re-running never compounds (spine). */
  originalSource?: string;
  originalFile?: File;
  tempFilePath?: string;
  mediaId?: string; // Media library ID for accurate waveform/sprite lookup
  duration: number; // Current visible duration in frames (timeline length)
  sourceDuration?: number; // Original source media duration in frames (for trimming boundaries - video/audio only; dynamically updated for text/subtitle/image)
  startFrame: number;
  endFrame: number;
  sourceStartTime?: number; // in seconds - where in the source file this track segment starts (trim in-point)
  /** Non-destructive reverse: when true, the preview plays this clip backward (frames inverted).
   * Instant — no re-encode. The actual reversed frames/audio are baked at export. */
  reversed?: boolean;
  /** Source chapters (e.g. YouTube), inherited from the media item. `start` is seconds into the source. */
  chapters?: Array<{ start: number; title: string }>;
  /** Provenance recorded at import — 'youtube' | 'url' | 'user' | 'stock'. */
  origin?: string;
  /** Detected scene-cut markers (reviewable). `atSeconds` is source time, `fraction` is 0..1 within the clip. */
  sceneMarkers?: Array<{ atSeconds: number; fraction: number }>;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
  aspectRatio?: number; // Calculated aspect ratio (width / height)
  detectedAspectRatioLabel?: string; // Human-readable label (e.g., '16:9', '9:16', '1:1')
  /**
   * Original FPS extracted from the source video file (IMMUTABLE)
   * This value must NEVER be mutated after track creation.
   * When a track is deleted and re-added, it always restores to this original FPS.
   * Used for: timeline display, track duration calculation, playback synchronization
   */
  sourceFps?: number;
  /**
   * User-set FPS for this track (used for export interpretation only)
   * This can be modified by the user for export purposes, but does not affect
   * timeline display or track length calculations (which use sourceFps).
   * Defaults to sourceFps when track is created.
   */
  effectiveFps?: number;
  // ==========================================================================
  // Audio Properties (for audio/video tracks)
  // ==========================================================================
  /**
   * Legacy volume (0-1) for backward compatibility.
   * @deprecated Use volumeDb instead
   */
  volume?: number;
  /**
   * Volume in decibels (-60 to +12 dB).
   * Use -Infinity for complete silence (mute).
   * 0 dB = unity gain (no change).
   * @see AudioMetadata
   */
  volumeDb?: number;
  /**
   * Whether the track's audio is muted.
   * Separate from volumeDb - allows muting without losing volume setting.
   */
  muted?: boolean;
  /**
   * Audio fade in duration in seconds (applied at the start of the clip during export).
   * Max recommended: 3.0s. Undefined = no fade.
   */
  fadeInDuration?: number;
  /**
   * Audio fade out duration in seconds (applied at the end of the clip during export).
   * Max recommended: 3.0s. Undefined = no fade.
   */
  fadeOutDuration?: number;
  /**
   * When true, this track's volume is automatically reduced when a primary (narration)
   * audio track is active in the same time range. Use on background music tracks.
   */
  duckingEnabled?: boolean;
  /**
   * Target volume in dB when ducked. Default: -18 dB (quiet but audible).
   * Range: -60 to 0 dB.
   */
  duckingTargetDb?: number;
  /**
   * Attack and release fade duration in seconds for smooth ducking transitions.
   * Default: 0.3 seconds.
   */
  duckingFadeDuration?: number;
  /**
   * When true, this track acts as a ducking trigger — its active time ranges cause
   * duckingEnabled tracks to reduce volume. Set on narration/voice tracks.
   * If no tracks have duckingPrimary set, all non-ducking audio tracks act as triggers.
   */
  duckingPrimary?: boolean;
  /**
   * Explicit speech intervals (in seconds) derived from Whisper transcription.
   * When present, ducking uses these precise windows instead of primary-track presence.
   */
  duckingSpeechIntervals?: { start: number; end: number }[];
  /**
   * Whether noise reduction is enabled for this track.
   * Boolean flag only - signals processing intent for export.
   * No parameters or model selection.
   * @see AudioMetadata
   */
  noiseReductionEnabled?: boolean;
  /**
   * The noise reduction engine used for this track.
   * Required when noiseReductionEnabled is true to retrieve the correct cached audio.
   * - 'ffmpeg': Built-in FFmpeg noise reduction
   * - 'deepfilter': DeepFilterNet2 AI-based noise reduction
   * @see NoiseReductionEngine
   */
  noiseReductionEngine?: NoiseReductionEngine;
  /**
   * Voice isolation (separation curve) state for this track.
   * Non-destructive: stored as params, applied live in preview via a Web Audio
   * graphic-EQ graph and baked at export via an ffmpeg equalizer chain.
   * Gated: the manual curve panel stays locked until EDITH runs `isolateVoice`
   * once (which sets `appliedByEdith` / `enabled`).
   */
  voiceIsolation?: {
    /** Master on/off for the effect on this track. */
    enabled: boolean;
    /**
     * Separation curve control nodes (Catmull-Rom). Exactly 4 nodes.
     * x = voiceness 0..1 (0 = noise/ambiance on the left, 1 = voice on the right)
     * y = keep-gain 0..1 (1 = keep fully, 0 = cut).
     */
    nodes: { x: number; y: number }[];
    /** Set true once EDITH has applied it — unlocks the manual curve. */
    appliedByEdith?: boolean;
  };
  /**
   * Voice Ager (Skill 3) state for this track. Non-destructive: stored as a single
   * ageYears dial, applied live in preview via the VoiceIsolationEngine ager stage
   * (pitch+formant shift + timbre morph) and baked at export via buildFfmpegAgeChain.
   * Gated: the manual age slider stays locked until EDITH runs `ageVoice` once.
   */
  voiceAge?: {
    /** Master on/off for the effect on this track. */
    enabled: boolean;
    /** The single user-facing dial, 20..90 (≈30 = neutral). */
    ageYears: number;
    /** Set true once EDITH has applied it — unlocks the manual slider. */
    appliedByEdith?: boolean;
  };
  /**
   * Source separation (stems) bake state. Powers the voiceIsolation curve.
   *
   * A one-time offline bake (MDX-Net ONNX, CPU) splits the clip into a clean
   * VOICE stem and a clean BACKGROUND stem (the exact residual, so they sum to
   * the original). EDITH's `isolateVoice` op kicks the bake; the stem file paths
   * live in the SeparationCache (keyed by sourceId). The voiceIsolation CURVE
   * drives the live mix of the two stems — its right side (voice) sets the voice
   * level, its left side (noise) sets the background level — and the same curve's
   * EQ runs on the voice stem, so pulling the left side down truly removes the
   * background. This field only tracks the bake lifecycle.
   */
  separation?: {
    /** Bake lifecycle: idle (not started) | processing | cached (ready) | error. */
    status: 'idle' | 'processing' | 'cached' | 'error';
    /** Separation model used (room for future engines). */
    engine?: 'mdxnet';
    /** Last error message when status === 'error'. */
    error?: string;
  };
  /**
   * Transcript panel edit layer — the user's per-word PARTIAL deletions, keyed by
   * the word's stable id. The value is the remaining visible text of a word that
   * has been partly backspaced (e.g. "nag" out of "nagging"). A word only ripples
   * out of the video once it is fully emptied; partial entries live here so the
   * partial text persists. This is SEPARATE from EDITH's canonical transcript
   * (cachedKaraokeSubtitles.transcriptionResult), which is never modified — so
   * mis-deletions in the panel never break EDITH's understanding of the clip.
   */
  transcriptEdits?: Record<string, string>;
  // ==========================================================================
  visible: boolean;
  locked: boolean;
  color: string;
  subtitleText?: string;
  subtitleType?: 'karaoke' | 'regular'; // Distinguish between karaoke (generated) and regular (imported) subtitles
  subtitleTracked?: boolean; // When true, rendered by TrackedCaptionOverlay anchored to pose landmarks
  trackedLinkedVideoTrackId?: string; // Source video track ID for skeleton landmark data
  // When present, this track is a merged caption stream. The renderer displays the active segment
  // based on the current frame; subtitleText is a fallback label only.
  subtitleSegments?: Array<{
    text: string;
    startFrame: number;
    endFrame: number;
    highlightWordIndex?: number;
  }>;
  linkedTrackId?: string;
  isLinked?: boolean;
  layer?: number; // Layer index for video/image tracks (0 = base layer, higher = overlay priority)
  trackRowIndex?: number; // Row index within the same media type (0 = bottom row, higher = upper rows)
  // Color grade state — palette from K-Means + manual Lightroom-style adjustments
  motionBlur?: number; // 0–100 intensity, applied as tmix frame blending at export
  colorGrade?: {
    palette?: string[];      // hex codes from K-Means extraction
    curves?: { r: number[]; g: number[]; b: number[]; ffmpegFilter: string }; // per-channel 256-value LUT from gradeReference
    temperature?: number;    // -100 to 100 (warm/cool)
    tint?: number;           // -100 to 100 (green/magenta)
    hue?: number;            // -180 to 180 (global hue shift)
    shadows?: number;        // -100 to 100
    highlights?: number;     // -100 to 100
    midtones?: number;       // -100 to 100
    palettes?: Array<{ palette: string[]; curves: { r: number[]; g: number[]; b: number[]; ffmpegFilter: string }; refTimeSec?: number }>;
    lastMethod?: string;
    lastRefPath?: string;
  };
  // Picture-in-Picture frame config — applied to the main (layer-0) track when B-roll is active
  pipFrame?: {
    style: 'none' | 'circle' | 'rounded-square' | 'square'; // mask shape
    x: number;           // PiP center X, normalized 0–1 (0=left, 1=right), default 0.82
    y: number;           // PiP center Y, normalized 0–1 (0=top, 1=bottom), default 0.12
    size: number;        // PiP diameter as fraction of canvas width, default 0.22
    borderColor: string; // stroke color, default '#FFB800'
    borderWidth: number; // stroke thickness in px at full canvas width, default 4
  };
  // For subtitle tracks: reference to the source video/audio track they were generated from
  linkedVideoTrackId?: string;
  // Precise subtitle timing from original SRT file (in seconds with millisecond precision)
  subtitleStartTime?: number; // Original start time from SRT (seconds)
  subtitleEndTime?: number; // Original end time from SRT (seconds)
  // Normalized subtitle timing used for rendering/export (no overlaps)
  normalizedSubtitleStartTime?: number;
  normalizedSubtitleEndTime?: number;
  subtitleSafeGapSeconds?: number;
  /**
   * Cached global subtitle container width (video space pixels).
   * Shared across all subtitle tracks to ensure stable layout.
   */
  maxContainerWidth?: number;
  // Global subtitle transform (applies to ALL subtitle tracks)
  subtitleTransform?: {
    x: number; // X position normalized (-1 to 1, relative to video center, 0 = center)
    y: number; // Y position normalized (-1 to 1, relative to video center, default bottom-aligned)
    scale?: number; // Scale factor (default 1, 1 = 100%)
    width?: number; // Width in video space pixels (0 = auto)
    height?: number; // Height in video space pixels (0 = auto)
  };
  // Text clip properties (for type === 'text')
  textContent?: string; // The actual text content for text clips
  textType?: 'heading' | 'body'; // Type of text clip
  textStyle?: {
    // Per-clip text styling (independent from global subtitle styles)
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    isBold?: boolean;
    isItalic?: boolean;
    isUnderline?: boolean;
    textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
    textAlign?: 'left' | 'center' | 'right' | 'justify';
    fontSize?: number;
    fillColor?: string;
    strokeColor?: string;
    backgroundColor?: string;
    hasShadow?: boolean;
    letterSpacing?: number;
    lineHeight?: number;
    hasGlow?: boolean;
    opacity?: number;
  };
  // Per-segment subtitle styling (overrides global styles when present)
  subtitleStyle?: {
    fontFamily?: string;
    isBold?: boolean;
    isItalic?: boolean;
    isUnderline?: boolean;
    textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
    textAlign?: 'left' | 'center' | 'right' | 'justify';
    fontSize?: number;
    fillColor?: string;
    strokeColor?: string;
    backgroundColor?: string;
    hasShadow?: boolean;
    letterSpacing?: number;
    lineHeight?: number;
    hasGlow?: boolean;
    opacity?: number;
    highlightColor?: string;
    highlightWordIndex?: number;
  };
  // Transform properties for text clips (position, scale, rotation)
  textTransform?: {
    x: number; // X position normalized (-1 to 1, relative to video center, 0 = center)
    y: number; // Y position normalized (-1 to 1, relative to video center, 0 = center)
    scale: number; // Scale factor (1 = 100%)
    rotation: number; // Rotation in degrees
    width: number; // Width in pixels (actual rendered width)
    height: number; // Height in pixels (actual rendered height)
  };

  // ==========================================================================
  // Proxy Generation Blocking State
  // ==========================================================================
  /**
   * Indicates the track is blocked due to 4K proxy generation in progress.
   * When true, the track cannot be edited (no drag, trim, split, etc.)
   * but is visually present on the timeline with an "optimizing" overlay.
   * Other tracks and UI remain fully usable.
   */
  proxyBlocked?: boolean;

  /**
   * Message to display when track is proxy-blocked.
   * Shown as an overlay on the track strip.
   */
  proxyBlockedMessage?: string;

  /** CSS filter string applied during compositing (e.g. "brightness(1.1) contrast(1.2) saturate(1.3)") */
  filter?: string;

  /**
   * AI background removal settings.
   * `enabled` drives the compositor and export pipeline.
   * `maskPath` is written by the backend after processing and referenced at export to avoid recomputing the mask.
   */
  backgroundRemoval?: {
    enabled: boolean;
    model?: 'rembg' | 'mediapipe';
    /** Absolute path to the pre-generated alpha mask written by the backend */
    maskPath?: string;
  };

  /** Per-frame pose landmark data from analyzeMotion. [x, y, visibility] per landmark (33 points). */
  poseLandmarks?: Array<{ frame: number; lm: [number, number, number][] }>;

  /** "Hold the world" — motion-key selective freeze. `appliedByEdith` gates the manual panel. */
  selectiveFreeze?: {
    mode: 'world-frozen' | 'subject-frozen' | 'full';
    start: number;
    end: number;
    appliedByEdith?: boolean;
  };

  /** "Speed that lives inside the clip" — per-region time-remap. `appliedByEdith` gates refinement. */
  regionalSpeed?: {
    speed: number;
    region: string;
    start: number;
    end: number;
    invert?: boolean;
    appliedByEdith?: boolean;
  };
}
