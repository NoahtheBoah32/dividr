/**
 * Text Wrapping Utilities
 * Handles text normalization and wrapping for export
 *
 * This module provides:
 * 1. Line break normalization (CRLF → LF)
 * 2. Text wrapping based on width constraints (converts visual CSS wrapping to explicit \n)
 */

interface TextWrapOptions {
  /** Font family (e.g., 'Inter', 'Arial') */
  fontFamily: string;
  /** Font size in pixels */
  fontSize: number;
  /** Font weight (e.g., '400', '700', 'bold') */
  fontWeight?: string | number;
  /** Font style (e.g., 'normal', 'italic') */
  fontStyle?: string;
  /** Letter spacing in pixels */
  letterSpacing?: number;
  /** Word spacing in pixels */
  wordSpacing?: number;
  /** Line height (unitless multiplier) */
  lineHeight?: number;
  /** Text transform (e.g., 'none', 'uppercase') */
  textTransform?: string;
  /** Text alignment (left, center, right) */
  textAlign?: string;
  /** Word-break behavior */
  wordBreak?: string;
  /** Overflow-wrap behavior */
  overflowWrap?: string;
  /** White-space handling */
  whiteSpace?: string;
  /** Horizontal padding in pixels */
  paddingX?: number;
  /** Vertical padding in pixels */
  paddingY?: number;
  /** Maximum width in pixels for wrapping */
  maxWidth: number;
}

interface WrapResult {
  /** Text with explicit line breaks inserted */
  wrappedText: string;
  /** Array of individual lines */
  lines: string[];
  /** Whether any wrapping occurred */
  wasWrapped: boolean;
}

// Cache canvas context for performance
let measureCanvas: HTMLCanvasElement | null = null;
let measureContext: CanvasRenderingContext2D | null = null;
let domMeasureContainer: HTMLDivElement | null = null;
let domMeasureInner: HTMLDivElement | null = null;
let domMeasureTextNode: Text | null = null;

/**
 * Normalize line breaks in text content
 * Converts CRLF and CR to LF for consistent handling
 *
 * This is the single source of truth for line break normalization
 * Used by both textLayerUtils and subtitleUtils
 *
 * @param text - Raw text content
 * @returns Text with normalized line breaks (\n only)
 */
export function normalizeLineBreaks(text: string): string {
  if (!text) return '';
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Get or create a canvas context for text measurement
 */
function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureContext) {
    measureCanvas = document.createElement('canvas');
    measureContext = measureCanvas.getContext('2d');
    if (!measureContext) {
      throw new Error(
        'Failed to create canvas 2D context for text measurement',
      );
    }
  }
  return measureContext;
}

/**
 * Clean font family string for canvas context
 * Removes extra quotes that may be present in CSS font-family values
 */
function cleanFontFamily(fontFamily: string): string {
  if (!fontFamily) return 'sans-serif';

  let cleaned = fontFamily.trim();

  // Handle CSS font-family format like '"Arial", sans-serif' or "'Arial', sans-serif"
  // Extract the first font name (with or without quotes)
  if (cleaned.startsWith('"') || cleaned.startsWith("'")) {
    const match = cleaned.match(/^["']([^"']+)["']/);
    if (match) {
      cleaned = match[1];
    }
  } else {
    // No quotes - might be "Arial, sans-serif", take first part
    const commaIndex = cleaned.indexOf(',');
    if (commaIndex > 0) {
      cleaned = cleaned.substring(0, commaIndex).trim();
    }
  }

  return cleaned || 'sans-serif';
}

/**
 * Build a CSS font string for canvas context
 */
function buildFontString(options: TextWrapOptions): string {
  const style = options.fontStyle || 'normal';
  const weight = String(options.fontWeight || '400');
  const size = `${options.fontSize}px`;
  const family = cleanFontFamily(options.fontFamily);

  // CSS font format: font-style font-weight font-size font-family
  // Font family should be quoted if it contains spaces
  const quotedFamily = family.includes(' ') ? `"${family}"` : family;
  return `${style} ${weight} ${size} ${quotedFamily}`;
}

/**
 * Apply text transform for measurement purposes
 * Note: CSS text-transform does not change string length for supported transforms
 */
function applyTextTransformForMeasurement(
  text: string,
  transform?: string,
): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/\b\w/g, (char) => char.toUpperCase());
    case 'none':
    default:
      return text;
  }
}

/**
 * Measure text width using canvas
 */
function measureTextWidth(
  text: string,
  options: TextWrapOptions,
  ctx: CanvasRenderingContext2D,
): number {
  const fontString = buildFontString(options);
  ctx.font = fontString;

  const measureText = applyTextTransformForMeasurement(
    text,
    options.textTransform,
  );
  let baseWidth = ctx.measureText(measureText).width;

  // Add word spacing for spaces
  const wordSpacing = options.wordSpacing || 0;
  if (wordSpacing !== 0 && measureText.includes(' ')) {
    const spaceCount = measureText.split(' ').length - 1;
    if (spaceCount > 0) {
      baseWidth += wordSpacing * spaceCount;
    }
  }

  // Add letter spacing for each character except the last
  const letterSpacing = options.letterSpacing || 0;
  if (letterSpacing !== 0 && measureText.length > 1) {
    return baseWidth + letterSpacing * (measureText.length - 1);
  }

  return baseWidth;
}

/**
 * Get or create DOM measurement elements for accurate text layout
 */
function getDomMeasureElements(): {
  container: HTMLDivElement;
  inner: HTMLDivElement;
  textNode: Text;
} | null {
  if (typeof document === 'undefined' || !document.body) return null;

  if (
    domMeasureContainer &&
    domMeasureInner &&
    domMeasureTextNode &&
    document.body.contains(domMeasureContainer)
  ) {
    return {
      container: domMeasureContainer,
      inner: domMeasureInner,
      textNode: domMeasureTextNode,
    };
  }

  const container = document.createElement('div');
  container.setAttribute('data-text-wrap-measure', 'true');
  container.style.position = 'absolute';
  container.style.top = '-10000px';
  container.style.left = '-10000px';
  container.style.visibility = 'hidden';
  container.style.pointerEvents = 'none';
  container.style.zIndex = '-1';
  container.style.contain = 'layout style paint';

  const inner = document.createElement('div');
  inner.style.display = 'inline-block';
  inner.style.width = '100%';
  inner.style.maxWidth = '100%';
  // Match preview wrapping behavior when width is constrained
  inner.style.whiteSpace = 'pre-wrap';
  inner.style.wordBreak = 'break-word';
  inner.style.overflowWrap = 'break-word';
  inner.style.wordWrap = 'break-word';
  inner.style.boxSizing = 'border-box';

  const textNode = document.createTextNode('');
  inner.appendChild(textNode);
  container.appendChild(inner);
  document.body.appendChild(container);

  domMeasureContainer = container;
  domMeasureInner = inner;
  domMeasureTextNode = textNode;

  return { container, inner, textNode };
}

/**
 * Apply layout styles to DOM measurement elements
 */
function applyDomMeasureStyles(
  elements: { container: HTMLDivElement; inner: HTMLDivElement },
  options: TextWrapOptions,
): void {
  const { container, inner } = elements;
  container.style.width = `${options.maxWidth}px`;

  inner.style.fontFamily = options.fontFamily || 'sans-serif';
  inner.style.fontSize = `${options.fontSize}px`;
  inner.style.fontWeight = String(options.fontWeight || '400');
  inner.style.fontStyle = options.fontStyle || 'normal';
  inner.style.letterSpacing = `${options.letterSpacing || 0}px`;
  inner.style.wordSpacing = `${options.wordSpacing || 0}px`;
  inner.style.lineHeight =
    options.lineHeight !== undefined ? String(options.lineHeight) : 'normal';
  inner.style.textTransform = options.textTransform || 'none';
  inner.style.textAlign = options.textAlign || 'left';

  inner.style.whiteSpace = options.whiteSpace || 'pre-wrap';
  inner.style.wordBreak = options.wordBreak || 'break-word';
  inner.style.overflowWrap = options.overflowWrap || 'break-word';
  inner.style.wordWrap =
    options.wordBreak || options.overflowWrap || 'break-word';

  const padX = options.paddingX || 0;
  const padY = options.paddingY || 0;
  inner.style.padding = `${padY}px ${padX}px`;
}

/**
 * Compute line breaks from a text node using DOM layout
 */
function computeWrappedTextFromTextNode(
  textNode: Text,
  sourceText: string,
): WrapResult {
  if (!sourceText) {
    return { wrappedText: '', lines: [], wasWrapped: false };
  }

  const range = document.createRange();
  let offset = 0;
  let lastLineTop: number | null = null;
  const breakIndices: number[] = [];

  for (const char of sourceText) {
    const charLength = char.length;

    // Respect manual line breaks
    if (char === '\n') {
      lastLineTop = null;
      offset += charLength;
      continue;
    }

    range.setStart(textNode, offset);
    range.setEnd(textNode, offset + charLength);
    const rects = range.getClientRects();
    const rect = rects[0] || range.getBoundingClientRect();
    if (rect) {
      const top = rect.top;
      if (lastLineTop === null) {
        lastLineTop = top;
      } else if (Math.abs(top - lastLineTop) > 0.5) {
        breakIndices.push(offset);
        lastLineTop = top;
      }
    }

    offset += charLength;
  }

  if (breakIndices.length === 0) {
    return {
      wrappedText: sourceText,
      lines: sourceText.split('\n'),
      wasWrapped: false,
    };
  }

  let wrappedText = '';
  let lastIndex = 0;
  for (const breakIndex of breakIndices) {
    wrappedText += sourceText.slice(lastIndex, breakIndex) + '\n';
    lastIndex = breakIndex;
  }
  wrappedText += sourceText.slice(lastIndex);

  return {
    wrappedText,
    lines: wrappedText.split('\n'),
    wasWrapped: true,
  };
}

/**
 * Wrap text using DOM layout measurement (matches preview rendering)
 */
function wrapTextToWidthWithDOM(
  text: string,
  options: TextWrapOptions,
): WrapResult | null {
  try {
    const elements = getDomMeasureElements();
    if (!elements) return null;

    applyDomMeasureStyles(elements, options);
    elements.textNode.nodeValue = text;

    // Force layout to ensure measurements are accurate
    if (elements.container.getClientRects().length === 0) {
      return null;
    }

    return computeWrappedTextFromTextNode(elements.textNode, text);
  } catch (error) {
    console.warn('📐 [TextWrap] DOM measurement failed, falling back', error);
    return null;
  }
}

/**
 * Wrap text to fit within a maximum width, preserving existing line breaks
 *
 * This function:
 * 1. Preserves existing manual line breaks (\n)
 * 2. Adds new line breaks where text would visually wrap
 * 3. Uses word-level wrapping (doesn't break words unless necessary)
 */
export function wrapTextToWidth(
  text: string,
  options: TextWrapOptions,
): WrapResult {
  const normalizedText = normalizeLineBreaks(text);

  // Validate inputs
  if (!normalizedText || options.maxWidth <= 0) {
    return {
      wrappedText: normalizedText || '',
      lines: normalizedText ? normalizedText.split('\n') : [],
      wasWrapped: false,
    };
  }

  // Use DOM measurement first for pixel-accurate wrapping
  const domResult = wrapTextToWidthWithDOM(normalizedText, options);
  if (domResult) {
    return domResult;
  }

  const ctx = getMeasureContext();
  const horizontalPadding = options.paddingX || 0;
  const maxWidth = Math.max(0, options.maxWidth - horizontalPadding * 2);
  const resultLines: string[] = [];
  let wasWrapped = false;

  // Debug: Log the font being used and test measurement
  const fontString = buildFontString(options);
  ctx.font = fontString;
  const testWidth = ctx.measureText('MMMMMMMMMM').width; // 10 Ms as a sanity check
  console.log(
    `📐 [TextWrap] Font: "${fontString}", 10 M's width: ${testWidth.toFixed(1)}px, maxWidth: ${maxWidth.toFixed(1)}px`,
  );

  // If font measurement seems broken (10 M's should be roughly fontSize * 8-10)
  // Just return the text with normalized line breaks
  const expectedMinWidth = options.fontSize * 5; // Very conservative minimum
  if (testWidth < expectedMinWidth) {
    console.warn(
      `📐 [TextWrap] Font measurement seems unreliable (${testWidth.toFixed(1)}px < ${expectedMinWidth}px). Skipping auto-wrap.`,
    );
    return {
      wrappedText: normalizedText,
      lines: normalizedText.split('\n'),
      wasWrapped: false,
    };
  }

  // Split by existing line breaks first (preserve manual breaks)
  const existingLines = normalizedText.split('\n');

  for (const line of existingLines) {
    // Preserve empty lines
    if (line === '') {
      resultLines.push('');
      continue;
    }

    // Check if this line needs wrapping
    const lineWidth = measureTextWidth(line, options, ctx);
    if (lineWidth <= maxWidth) {
      // Line fits, no wrapping needed
      resultLines.push(line);
      continue;
    }

    // Line needs wrapping - split by words
    wasWrapped = true;
    const words = line.split(/(\s+)/); // Split but keep whitespace
    let currentLine = '';

    for (const word of words) {
      // Skip empty strings from split
      if (word === '') continue;

      if (currentLine === '') {
        // First word on line
        const wordWidth = measureTextWidth(word, options, ctx);
        if (wordWidth > maxWidth && !word.match(/^\s+$/)) {
          // Word itself is too long - need to break it character by character
          const brokenLines = breakLongWord(word, options, ctx, maxWidth);
          // Add all but the last line to results
          for (let i = 0; i < brokenLines.length - 1; i++) {
            resultLines.push(brokenLines[i]);
          }
          // Keep the last part as current line
          currentLine = brokenLines[brokenLines.length - 1] || '';
        } else {
          currentLine = word;
        }
      } else {
        // Check if word fits on current line
        const testLine = currentLine + word;
        const testWidth = measureTextWidth(testLine, options, ctx);

        if (testWidth <= maxWidth) {
          // Word fits
          currentLine = testLine;
        } else {
          // Word doesn't fit - push current line and start new one
          if (currentLine !== '') {
            resultLines.push(currentLine);
          }

          const wordWidth = measureTextWidth(word, options, ctx);
          if (wordWidth > maxWidth && !word.match(/^\s+$/)) {
            // Word is too long, break it
            const brokenLines = breakLongWord(word, options, ctx, maxWidth);
            for (let i = 0; i < brokenLines.length - 1; i++) {
              resultLines.push(brokenLines[i]);
            }
            currentLine = brokenLines[brokenLines.length - 1] || '';
          } else {
            // Start new line with this word
            currentLine = word;
          }
        }
      }
    }

    // Add remaining content
    if (currentLine !== '') {
      resultLines.push(currentLine);
    }
  }

  return {
    wrappedText: resultLines.join('\n'),
    lines: resultLines,
    wasWrapped,
  };
}

/**
 * Break a long word into multiple lines (character-level breaking)
 */
function breakLongWord(
  word: string,
  options: TextWrapOptions,
  ctx: CanvasRenderingContext2D,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let currentLine = '';

  for (const char of word) {
    const testLine = currentLine + char;
    const testWidth = measureTextWidth(testLine, options, ctx);

    if (testWidth <= maxWidth || currentLine === '') {
      // Fits, or first char (must include at least one char per line)
      currentLine = testLine;
    } else {
      // Doesn't fit, push current and start new
      lines.push(currentLine);
      currentLine = char;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [word];
}

/**
 * Apply text wrapping to content based on track transform dimensions
 *
 * Main entry point for the export pipeline.
 * - Normalizes line breaks (CRLF → LF)
 * - If width constraint exists, calculates where visual wrapping would occur
 *
 * @param text - Raw text content
 * @param trackWidth - Width from track transform (in video space pixels), 0 = auto/no constraint
 * @param fontSize - Font size in pixels
 * @param fontFamily - Font family name
 * @param fontWeight - Font weight
 * @param fontStyle - Font style (normal/italic)
 * @param letterSpacing - Letter spacing in pixels
 * @param scale - Scale factor applied to font size/padding (default 1)
 * @param wrapOptions - Optional layout overrides to match preview rendering
 * @returns Text with normalized and wrapped line breaks
 */
export function applyTextWrapping(
  text: string,
  trackWidth: number,
  fontSize: number,
  fontFamily: string,
  fontWeight?: string | number,
  fontStyle?: string,
  letterSpacing?: number,
  scale?: number,
  wrapOptions?: {
    lineHeight?: number;
    textTransform?: string;
    textAlign?: string;
    paddingX?: number;
    paddingY?: number;
    /** Whether letterSpacing should scale with transform scale (subtitles) */
    scaleLetterSpacing?: boolean;
    wordSpacing?: number;
    wordBreak?: string;
    overflowWrap?: string;
    whiteSpace?: string;
  },
): string {
  // First, normalize line breaks (this is always done)
  const normalizedText = normalizeLineBreaks(text);

  // If no width constraint, just return normalized text
  if (!trackWidth || trackWidth <= 0) {
    return normalizedText;
  }

  // Validate fontSize - must be a positive number
  const validFontSize =
    typeof fontSize === 'number' && fontSize > 0 ? fontSize : 40;

  // Account for scale - match preview by scaling font + padding (width stays in video space)
  const effectiveScale = scale || 1;
  const effectiveFontSize = validFontSize * effectiveScale;
  const effectiveLetterSpacing =
    (letterSpacing || 0) *
    (wrapOptions?.scaleLetterSpacing ? effectiveScale : 1);
  const effectiveWordSpacing =
    (wrapOptions?.wordSpacing || 0) *
    (wrapOptions?.scaleLetterSpacing ? effectiveScale : 1);
  const effectivePaddingX = (wrapOptions?.paddingX || 0) * effectiveScale;
  const effectivePaddingY = (wrapOptions?.paddingY || 0) * effectiveScale;

  // Debug: show raw input text with visible line breaks
  const debugText = text.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  console.log(`📐 [TextWrap] Input text (raw): "${debugText}"`);
  console.log(
    `📐 [TextWrap] Wrapping at width: ${trackWidth}px, Font: ${effectiveFontSize.toFixed(1)}px "${fontFamily}"`,
  );

  // Perform wrapping
  const result = wrapTextToWidth(normalizedText, {
    fontFamily,
    fontSize: effectiveFontSize,
    fontWeight,
    fontStyle,
    letterSpacing: effectiveLetterSpacing,
    wordSpacing: effectiveWordSpacing,
    maxWidth: trackWidth,
    lineHeight: wrapOptions?.lineHeight,
    textTransform: wrapOptions?.textTransform,
    textAlign: wrapOptions?.textAlign,
    paddingX: effectivePaddingX,
    paddingY: effectivePaddingY,
    wordBreak: wrapOptions?.wordBreak,
    overflowWrap: wrapOptions?.overflowWrap,
    whiteSpace: wrapOptions?.whiteSpace,
  });

  console.log(
    `📐 [TextWrap] Result: "${normalizedText.substring(0, 30)}${normalizedText.length > 30 ? '...' : ''}" → ${result.lines.length} lines (wasWrapped: ${result.wasWrapped})`,
  );

  return result.wrappedText;
}
