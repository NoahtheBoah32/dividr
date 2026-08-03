/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Subtitle Utilities
 * Handles subtitle content generation for export
 * NOTE: Text clips are now handled separately by textLayerUtils.ts
 */
import { generateASSContent } from '@/backend/ffmpeg/subtitles/subtitleExporter';
import {
  SUBTITLE_PADDING_HORIZONTAL,
  SUBTITLE_PADDING_VERTICAL,
} from '../../editor/preview/core/constants';
import {
  useVideoEditorStore,
  VideoTrack,
} from '../../editor/stores/videoEditor/index';
import { applyTextWrapping } from './textWrapUtils';

interface SubtitleGenerationResult {
  subtitleContent: string;
  currentTextStyle: any;
  fontFamilies: string[];
}

/**
 * Generate subtitle content from subtitle tracks ONLY
 * Text clips are now handled separately by textLayerUtils.ts
 * @param timelineStartFrame - Optional start frame of the export range (for offsetting subtitle timestamps)
 */
export function generateSubtitleContent(
  subtitleTracks: VideoTrack[],
  textTracks: VideoTrack[], // Kept for backward compatibility but not used
  textStyle: any,
  getTextStyleForSubtitle: (styleId: string) => any,
  videoDimensions?: { width: number; height: number },
  timelineStartFrame?: number,
): SubtitleGenerationResult {
  // Get timeline data non-reactively
  const { timeline } = useVideoEditorStore.getState();

  // Calculate time offset if export starts at a specific frame
  const timeOffset =
    timelineStartFrame !== undefined ? timelineStartFrame / timeline.fps : 0;

  if (timeOffset > 0) {
    console.log(
      `📝 Export starts at frame ${timelineStartFrame} (${timeOffset.toFixed(3)}s)`,
    );
  }

  // Extract subtitle segments from subtitle tracks with frame-based timing.
  // A track may be a single legacy phrase (subtitleText) OR a merged caption
  // stream (subtitleSegments, one entry per karaoke word) — the stream must be
  // expanded here or the export burns the fallback text for the whole span.
  let subtitleEntrySeq = 0;
  const subtitleSegments =
    subtitleTracks.length > 0
      ? subtitleTracks.flatMap((track, index) => {
          // Calculate timing relative to export start frame
          const relativeStartFrame = Math.max(
            0,
            track.startFrame - (timelineStartFrame || 0),
          );
          const relativeEndFrame = Math.max(
            0,
            track.endFrame - (timelineStartFrame || 0),
          );

          const startTime = relativeStartFrame / timeline.fps;
          const endTime = relativeEndFrame / timeline.fps;

          console.log(
            `[Subtitle] "${track.subtitleText?.substring(0, 30)}" - frames ${track.startFrame}-${track.endFrame} -> relative ${relativeStartFrame}-${relativeEndFrame} -> ${startTime.toFixed(3)}s-${endTime.toFixed(3)}s`,
          );

          // Log raw track style for debugging export payload
          if (track.subtitleStyle || track.textStyle) {
            console.log(`📦 [Export Payload] Track ${index + 1} raw style:`, {
              trackId: track.id,
              subtitleStyle: track.subtitleStyle,
              textStyle: track.textStyle,
            });
          }

          // Extract per-segment styling if available (prioritize subtitleStyle over textStyle)
          const trackStyle = track.subtitleStyle || track.textStyle;
          const style = trackStyle
            ? {
                fontFamily: trackStyle.fontFamily,
                // For subtitleStyle (no fontWeight/fontStyle), use isBold/isItalic
                // For textStyle (has fontWeight/fontStyle), use those if available
                // CRITICAL: Must handle explicit false values to allow per-clip overrides
                fontWeight:
                  'fontWeight' in trackStyle &&
                  trackStyle.fontWeight !== undefined
                    ? String(trackStyle.fontWeight)
                    : trackStyle.isBold !== undefined
                      ? trackStyle.isBold
                        ? '700'
                        : '400'
                      : undefined,
                fontStyle:
                  'fontStyle' in trackStyle &&
                  trackStyle.fontStyle !== undefined
                    ? String(trackStyle.fontStyle)
                    : trackStyle.isItalic !== undefined
                      ? trackStyle.isItalic
                        ? 'italic'
                        : 'normal'
                      : undefined,
                isUnderline: trackStyle.isUnderline,
                textTransform: trackStyle.textTransform,
                textDecoration: trackStyle.isUnderline
                  ? 'underline'
                  : trackStyle.isUnderline === false
                    ? 'none'
                    : undefined,
                fontSize: trackStyle.fontSize
                  ? `${trackStyle.fontSize}px`
                  : undefined,
                color: trackStyle.fillColor,
                strokeColor: trackStyle.strokeColor,
                backgroundColor: trackStyle.backgroundColor,
                hasShadow: trackStyle.hasShadow,
                hasGlow: trackStyle.hasGlow,
                opacity: trackStyle.opacity,
                letterSpacing:
                  trackStyle.letterSpacing !== undefined
                    ? `${trackStyle.letterSpacing}px`
                    : undefined,
                lineHeight: trackStyle.lineHeight,
                textAlign: trackStyle.textAlign,
              }
            : undefined;

          // Log converted style for debugging
          if (style) {
            console.log(
              `📦 [Export Payload] Track ${index + 1} converted style:`,
              {
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                fontStyle: style.fontStyle,
                strokeColor: style.strokeColor,
                color: style.color,
                opacity: style.opacity,
              },
            );
          }

          // Process text through textWrapUtils (single source of truth for line breaks)
          // - Normalizes CRLF/CR to LF
          // - Applies auto-wrapping if width constraint exists (user resized the subtitle box)
          const subtitleWidth =
            track.subtitleTransform?.width ||
            textStyle.globalSubtitlePosition?.width ||
            track.maxContainerWidth ||
            0;
          const fontSize = trackStyle?.fontSize || 40; // Default 40px at 720p
          const fontFamily = trackStyle?.fontFamily || 'Inter';
          const fontWeight = trackStyle?.isBold ? '700' : '400';
          const fontStyle = trackStyle?.isItalic ? 'italic' : 'normal';
          const letterSpacing = trackStyle?.letterSpacing || 0;
          const scale =
            track.subtitleTransform?.scale ||
            textStyle.globalSubtitlePosition?.scale ||
            1;

          // applyTextWrapping handles both normalization and width-based wrapping
          const cleanText = applyTextWrapping(
            track.subtitleText || '',
            subtitleWidth,
            fontSize,
            fontFamily,
            fontWeight,
            fontStyle,
            letterSpacing,
            scale,
            {
              lineHeight: trackStyle?.lineHeight,
              textTransform: trackStyle?.textTransform,
              textAlign: trackStyle?.textAlign,
              paddingX: SUBTITLE_PADDING_HORIZONTAL,
              paddingY: SUBTITLE_PADDING_VERTICAL,
              scaleLetterSpacing: true,
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              whiteSpace: 'pre-wrap',
            },
          );

          // Extract transform/position data from subtitleTransform or fall back to global position
          // Convert coordinates from [-1,1] (frontend) to [0,1] (ASS generator)
          // This ensures parity with how textLayerUtils.ts handles text transforms
          const transform =
            track.subtitleTransform || textStyle.globalSubtitlePosition;
          const position = transform
            ? {
                x: (transform.x + 1) / 2, // Convert from [-1,1] to [0,1]
                y: (transform.y + 1) / 2, // Convert from [-1,1] to [0,1]
                scale: transform.scale ?? 1, // Default to 1 if not set
              }
            : undefined;

          // Log position data for debugging
          if (position) {
            console.log(
              `📍 [Export Payload] Track ${index + 1} position: x=${position.x.toFixed(3)}, y=${position.y.toFixed(3)}, scale=${position.scale}`,
            );
          }

          // Merged caption stream: group consecutive word-segments that share the
          // same phrase text into ONE burned entry per phrase (the per-word gold
          // highlight is a live-preview feature; export shows the phrase timing).
          if (track.subtitleSegments?.length) {
            const groups: Array<{ text: string; startFrame: number; endFrame: number; highlightWordIndex?: number }> = [];
            for (const seg of track.subtitleSegments) {
              const last = groups[groups.length - 1];
              if (last && last.text === seg.text) {
                last.endFrame = Math.max(last.endFrame, seg.endFrame);
              } else {
                groups.push({
                  text: seg.text,
                  startFrame: seg.startFrame,
                  endFrame: seg.endFrame,
                  highlightWordIndex: (seg as any).highlightWordIndex,
                });
              }
            }
            // Kinetic-typography emphasis: bake the highlighted word bigger (and
            // accent-colored) via inline ASS override tags. Only fires when the
            // track opts in with subtitleStyle.highlightScale — normal caption
            // tracks are untouched. \fscx/\fscy are percentages of the style's
            // font size, so this is resolution-independent; {\r} resets to the
            // Dialogue's base style for the words that follow.
            const ktScale = (trackStyle as any)?.highlightScale as number | undefined;
            const ktAccent = (trackStyle as any)?.highlightColor as string | undefined;
            const emphasize = (text: string, wordIdx: number | undefined): string => {
              if (!ktScale || wordIdx === undefined || wordIdx < 0) return text;
              const pct = Math.round(ktScale * 100);
              const hex = /^#([0-9a-fA-F]{6})$/.exec(ktAccent ?? '');
              const colorTag = hex
                ? `\\c&H${(hex[1].slice(4, 6) + hex[1].slice(2, 4) + hex[1].slice(0, 2)).toUpperCase()}&`
                : '';
              let wordCount = 0;
              return text
                .split(/(\s+)/)
                .map((token) => {
                  if (/^\s*$/.test(token)) return token;
                  return wordCount++ === wordIdx
                    ? `{\\fscx${pct}\\fscy${pct}${colorTag}}${token}{\\r}`
                    : token;
                })
                .join('');
            };
            return groups.map((g) => {
              const gStart = Math.max(0, g.startFrame - (timelineStartFrame || 0)) / timeline.fps;
              const gEnd = Math.max(0, g.endFrame - (timelineStartFrame || 0)) / timeline.fps;
              const gText = applyTextWrapping(
                g.text || '',
                subtitleWidth,
                fontSize,
                fontFamily,
                fontWeight,
                fontStyle,
                letterSpacing,
                scale,
                {
                  lineHeight: trackStyle?.lineHeight,
                  textTransform: trackStyle?.textTransform,
                  textAlign: trackStyle?.textAlign,
                  paddingX: SUBTITLE_PADDING_HORIZONTAL,
                  paddingY: SUBTITLE_PADDING_VERTICAL,
                  scaleLetterSpacing: true,
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  whiteSpace: 'pre-wrap',
                },
              );
              return {
                startTime: gStart,
                endTime: gEnd,
                // Tag injection AFTER wrapping so the tags never skew width measurement
                text: emphasize(gText, g.highlightWordIndex),
                index: ++subtitleEntrySeq,
                style,
                position,
              };
            });
          }

          return [{
            startTime,
            endTime,
            text: cleanText,
            index: ++subtitleEntrySeq,
            style,
            position, // Include position data for ASS positioning
          }];
        })
      : [];

  // NOTE: Text clips are no longer processed here - they are handled separately by textLayerUtils.ts
  // This ensures proper multi-track rendering with text layers as separate overlays

  // Only use subtitle segments
  const allSegments = [...subtitleSegments];

  if (allSegments.length === 0) {
    return {
      subtitleContent: '',
      currentTextStyle: undefined,
      fontFamilies: [],
    };
  }

  // Filter out segments that have invalid timing (end time <= 0 or start >= end)
  const validSegments = allSegments.filter(
    (segment) => segment.endTime > 0 && segment.startTime < segment.endTime,
  );

  if (validSegments.length === 0) {
    console.log('⚠️ No valid subtitle segments after filtering');
    return {
      subtitleContent: '',
      currentTextStyle: undefined,
      fontFamilies: [],
    };
  }

  // Sort by start time and re-index
  validSegments.sort((a, b) => a.startTime - b.startTime);
  validSegments.forEach((segment, index) => {
    segment.index = index + 1;
  });

  console.log(`📝 Final subtitle count: ${validSegments.length} segments`);

  // Get current text style (for subtitles that don't have per-segment styling)
  const currentTextStyle = getTextStyleForSubtitle(textStyle.activeStyle);

  // Generate ASS content with styling and video dimensions
  const assResult = generateASSContent(
    validSegments,
    currentTextStyle,
    videoDimensions,
  );

  console.log(
    `📝 [Subtitles] Generated subtitle content: ${validSegments.length} segments`,
  );
  console.log('📝 [Subtitles] Fonts used:', assResult.fontFamilies.join(', '));

  return {
    subtitleContent: assResult.content,
    currentTextStyle,
    fontFamilies: assResult.fontFamilies,
  };
}
