/**
 * Social export presets — named bundles of resolution class, frame rate,
 * codec, and CRF quality. Applied at export-job creation (useExportJob):
 * fps/codec/crf come straight from the preset; dimensions are fitted to the
 * project's canvas aspect so a preset can never distort the picture.
 */

export interface SocialExportPreset {
  /** Canonical key, e.g. 'tiktok' */
  name: string;
  label: string;
  /** Nominal dimensions for the preset's native aspect */
  width: number;
  height: number;
  fps: number;
  videoCodec: 'h264' | 'hevc';
  crf: number;
}

export const SOCIAL_EXPORT_PRESETS: Record<string, SocialExportPreset> = {
  tiktok: { name: 'tiktok', label: 'TikTok (9:16 1080p, 30fps)', width: 1080, height: 1920, fps: 30, videoCodec: 'h264', crf: 23 },
  reels: { name: 'reels', label: 'Instagram Reels (9:16 1080p, 30fps)', width: 1080, height: 1920, fps: 30, videoCodec: 'h264', crf: 23 },
  shorts: { name: 'shorts', label: 'YouTube Shorts (9:16 1080p, 30fps)', width: 1080, height: 1920, fps: 30, videoCodec: 'h264', crf: 23 },
  youtube: { name: 'youtube', label: 'YouTube (16:9 1080p, 30fps)', width: 1920, height: 1080, fps: 30, videoCodec: 'h264', crf: 21 },
  'youtube-4k': { name: 'youtube-4k', label: 'YouTube 4K (16:9 2160p, 30fps, HEVC)', width: 3840, height: 2160, fps: 30, videoCodec: 'hevc', crf: 24 },
  square: { name: 'square', label: 'Instagram Feed (1:1 1080p, 30fps)', width: 1080, height: 1080, fps: 30, videoCodec: 'h264', crf: 23 },
};

/** Aliases users/EDITH are likely to say → canonical preset keys */
const PRESET_ALIASES: Record<string, string> = {
  'tik tok': 'tiktok',
  instagram: 'reels',
  'instagram reels': 'reels',
  ig: 'reels',
  'ig reels': 'reels',
  reel: 'reels',
  'youtube shorts': 'shorts',
  short: 'shorts',
  yt: 'youtube',
  'youtube 4k': 'youtube-4k',
  '4k': 'youtube-4k',
  'instagram feed': 'square',
  'ig feed': 'square',
};

export function resolveExportPreset(name: string | null | undefined): SocialExportPreset | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return SOCIAL_EXPORT_PRESETS[key] ?? SOCIAL_EXPORT_PRESETS[PRESET_ALIASES[key]] ?? null;
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/**
 * Fit a preset's resolution class to the project's canvas aspect so the
 * output is never squashed: the canvas aspect is kept, and the output's
 * short edge is pinned to the preset's short edge (1080 for the social
 * presets, 2160 for 4K).
 */
export function fitPresetDimensions(
  canvasWidth: number,
  canvasHeight: number,
  preset: SocialExportPreset,
): { width: number; height: number } {
  if (!canvasWidth || !canvasHeight) return { width: preset.width, height: preset.height };
  const aspect = canvasWidth / canvasHeight;
  const shortEdge = Math.min(preset.width, preset.height);
  if (aspect <= 1) {
    // portrait / square: pin width
    return { width: even(shortEdge), height: even(shortEdge / aspect) };
  }
  // landscape: pin height
  return { width: even(shortEdge * aspect), height: even(shortEdge) };
}
