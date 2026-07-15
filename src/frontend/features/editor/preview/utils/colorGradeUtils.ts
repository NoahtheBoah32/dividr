/**
 * Color grade utilities for the canvas compositor.
 *
 * Strategy: build an SVG feComponentTransfer filter once when grade changes,
 * apply it as CSS `filter: url(#dividr-grade)` on the canvas element.
 * GPU-accelerated — zero per-frame cost.
 */

export interface ColorGradeParams {
  curves?: { r: number[]; g: number[]; b: number[]; ffmpegFilter: string };
  intensity?: number;    // 0–100, blends extracted curves toward identity (default 100 = full grade)
  temperature?: number;  // -100 to +100
  tint?: number;         // -100 to +100
  hue?: number;          // -180 to +180
  shadows?: number;      // -100 to +100
  midtones?: number;     // -100 to +100
  highlights?: number;   // -100 to +100
  vignette?: number;     // 0 to 100 — darkened corners, ffmpeg `vignette` at export
  sharpen?: number;      // 0 to 100 — edge sharpen, ffmpeg `unsharp` at export
  blur?: number;         // 0 to 100 — gaussian blur, ffmpeg `gblur` at export
  grain?: number;        // 0 to 100 — animated film grain, ffmpeg `noise` at export
  saturation?: number;   // 0 to 2, 1 = neutral — CSS saturate() / ffmpeg `eq=saturation`
}

export function hasActiveGrade(grade: ColorGradeParams | undefined): boolean {
  if (!grade) return false;
  return !!(
    grade.curves ||
    (grade.temperature ?? 0) !== 0 ||
    (grade.tint ?? 0) !== 0 ||
    (grade.hue ?? 0) !== 0 ||
    (grade.shadows ?? 0) !== 0 ||
    (grade.midtones ?? 0) !== 0 ||
    (grade.highlights ?? 0) !== 0 ||
    (grade.vignette ?? 0) > 0 ||
    (grade.sharpen ?? 0) > 0 ||
    (grade.blur ?? 0) > 0 ||
    (grade.grain ?? 0) > 0 ||
    (grade.saturation ?? 1) !== 1
  );
}

// Effect-strength → filter-parameter mappings. Shared by the CSS preview and
// the FFmpeg export builder so both paths stay in visual agreement.
const BLUR_MAX_SIGMA = 20;      // gblur sigma at strength 100 (bitmap px)
const SHARPEN_MAX_AMOUNT = 2.5; // unsharp luma amount at strength 100
const sharpenKernelA = (strength: number) => (strength / 100) * 1.2;
const blurSigma = (strength: number) => (strength / 100) * BLUR_MAX_SIGMA;

// Build the tone table for one channel (steps+1 points, values 0..1)
function buildTableNumbers(
  channel: 'r' | 'g' | 'b',
  grade: ColorGradeParams,
  steps = 16,
): number[] {
  const curves = grade.curves;
  const blend = (grade.intensity ?? 100) / 100; // 0 = identity, 1 = full extracted grade
  const tempShift = (grade.temperature ?? 0) * 0.3;
  const tintShift = (grade.tint ?? 0) * 0.2;
  const shadowsAmt = (grade.shadows ?? 0) * 0.5;
  const midtonesAmt = (grade.midtones ?? 0) * 0.5;
  const highlightsAmt = (grade.highlights ?? 0) * 0.5;

  const values: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const idx = Math.round((i / steps) * 255);
    const t = i / steps;

    // Lerp between identity (idx) and extracted curve based on blend intensity
    const extracted = curves ? curves[channel][Math.min(255, idx)] : idx;
    const base = idx + (extracted - idx) * blend;

    let chShift = 0;
    if (channel === 'r') chShift = tempShift;
    if (channel === 'g') chShift = tintShift;
    if (channel === 'b') chShift = -tempShift;

    const shadowW = Math.max(0, 1 - t * 3);
    const highlightW = Math.max(0, t * 3 - 2);
    const midW = Math.max(0, 1 - Math.abs(t - 0.5) * 4);
    const toneShift =
      shadowsAmt * shadowW + midtonesAmt * midW + highlightsAmt * highlightW;

    const out = Math.max(0, Math.min(255, base + chShift + toneShift));
    values.push(+(out / 255).toFixed(4));
  }
  return values;
}

function buildTableValues(
  channel: 'r' | 'g' | 'b',
  grade: ColorGradeParams,
  steps = 16,
): string {
  return buildTableNumbers(channel, grade, steps).join(' ');
}

const SVG_ID = 'dividr-grade-filter-svg';
const FILTER_ID = 'dividr-grade';
const VIGNETTE_ID = 'dividr-vignette-overlay';
export { FILTER_ID as GRADE_FILTER_ID };

// Vignette can't be expressed as a CSS filter primitive — it's a DOM overlay
// (radial gradient) kept as a sibling of the canvas, sized by inset:0 since
// the canvas fills its (positioned) parent box.
function syncVignetteOverlay(canvas: HTMLCanvasElement, strength: number): void {
  let ovl = document.getElementById(VIGNETTE_ID) as HTMLDivElement | null;
  const parent = canvas.parentElement;
  if (!parent || strength <= 0) {
    ovl?.remove();
    return;
  }
  if (!ovl || ovl.parentElement !== parent) {
    ovl?.remove();
    ovl = document.createElement('div');
    ovl.id = VIGNETTE_ID;
    parent.appendChild(ovl);
  }
  const inner = Math.max(20, 70 - strength * 0.35); // transparent center radius (%)
  const edge = (0.85 * strength) / 100;             // corner darkness 0..0.85
  ovl.style.cssText =
    `position:absolute;inset:0;pointer-events:none;z-index:5;` +
    `background:radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}%, rgba(0,0,0,${edge.toFixed(3)}) 100%);`;
}

export function removeVignetteOverlay(): void {
  document.getElementById(VIGNETTE_ID)?.remove();
}

const GRAIN_ID = 'dividr-grain-overlay';
const GRAIN_STYLE_ID = 'dividr-grain-anim-style';
const GRAIN_NOISE_MAX_ALPHA = 0.55; // overlay opacity at grain=100

// Lazily rendered 96×96 monochrome noise tile, reused for every overlay.
let grainTileUrl: string | null = null;
function getGrainTileUrl(): string {
  if (grainTileUrl) return grainTileUrl;
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(Math.random() * 256);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainTileUrl = c.toDataURL('image/png');
  return grainTileUrl;
}

// Animated film grain — a repeating noise tile in overlay blend, jittered by a
// steps() keyframe loop so the grain "lives" like real film (export bakes true
// temporal noise via ffmpeg `noise=allf=t+u`; this is the visual stand-in).
function syncGrainOverlay(canvas: HTMLCanvasElement, strength: number): void {
  let ovl = document.getElementById(GRAIN_ID) as HTMLDivElement | null;
  const parent = canvas.parentElement;
  if (!parent || strength <= 0) {
    ovl?.remove();
    return;
  }
  if (!document.getElementById(GRAIN_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = GRAIN_STYLE_ID;
    style.textContent = `@keyframes dividr-grain-jitter {
      0% { background-position: 0 0; } 12% { background-position: -17px 9px; }
      25% { background-position: 11px -21px; } 37% { background-position: -23px -13px; }
      50% { background-position: 7px 19px; } 62% { background-position: -9px -27px; }
      75% { background-position: 21px 5px; } 87% { background-position: -13px 23px; }
      100% { background-position: 0 0; } }`;
    document.head.appendChild(style);
  }
  if (!ovl || ovl.parentElement !== parent) {
    ovl?.remove();
    ovl = document.createElement('div');
    ovl.id = GRAIN_ID;
    parent.appendChild(ovl);
  }
  const alpha = (strength / 100) * GRAIN_NOISE_MAX_ALPHA;
  ovl.style.cssText =
    `position:absolute;inset:0;pointer-events:none;z-index:6;` +
    `background-image:url(${getGrainTileUrl()});background-repeat:repeat;` +
    `mix-blend-mode:overlay;opacity:${alpha.toFixed(3)};` +
    `animation:dividr-grain-jitter 0.55s steps(1) infinite;`;
}

export function removeGrainOverlay(): void {
  document.getElementById(GRAIN_ID)?.remove();
}

export function clearCSSColorGrade(canvas: HTMLCanvasElement): void {
  canvas.style.filter = '';
  document.getElementById(SVG_ID)?.remove();
  removeVignetteOverlay();
  removeGrainOverlay();
}

export function applyCSSColorGrade(
  canvas: HTMLCanvasElement,
  grade: ColorGradeParams | null | undefined,
): void {
  if (!grade || !hasActiveGrade(grade)) {
    clearCSSColorGrade(canvas);
    return;
  }

  // Create or reuse the hidden SVG container
  let svgEl = document.getElementById(SVG_ID) as SVGSVGElement | null;
  if (!svgEl) {
    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    svgEl.id = SVG_ID;
    svgEl.setAttribute('style', 'display:none;position:absolute;width:0;height:0;');
    document.body.appendChild(svgEl);
  }

  const rVals = buildTableValues('r', grade);
  const gVals = buildTableValues('g', grade);
  const bVals = buildTableValues('b', grade);

  // Sequential primitives chain implicitly: tone table → sharpen → blur
  const prims: string[] = [
    `<feComponentTransfer>
        <feFuncR type="table" tableValues="${rVals}"/>
        <feFuncG type="table" tableValues="${gVals}"/>
        <feFuncB type="table" tableValues="${bVals}"/>
      </feComponentTransfer>`,
  ];

  const sharpen = grade.sharpen ?? 0;
  if (sharpen > 0) {
    const a = +sharpenKernelA(sharpen).toFixed(4);
    prims.push(
      `<feConvolveMatrix order="3" kernelMatrix="0 ${-a} 0 ${-a} ${+(1 + 4 * a).toFixed(4)} ${-a} 0 ${-a} 0" preserveAlpha="true"/>`,
    );
  }

  const blur = grade.blur ?? 0;
  if (blur > 0) {
    // Export gblur sigma is in bitmap px; the CSS filter works in element px.
    // Scale by displayed/bitmap width so preview and export blur match.
    const scale =
      canvas.width > 0 && canvas.clientWidth > 0
        ? canvas.clientWidth / canvas.width
        : 1;
    prims.push(`<feGaussianBlur stdDeviation="${(blurSigma(blur) * scale).toFixed(3)}"/>`);
  }

  svgEl.innerHTML = `
    <filter id="${FILTER_ID}" color-interpolation-filters="sRGB">
      ${prims.join('\n      ')}
    </filter>`;

  const hue = grade.hue ?? 0;
  const hueFilter = hue !== 0 ? ` hue-rotate(${hue}deg)` : '';
  const sat = grade.saturation ?? 1;
  const satFilter = sat !== 1 ? ` saturate(${sat})` : '';
  canvas.style.filter = `url(#${FILTER_ID})${hueFilter}${satFilter}`;

  syncVignetteOverlay(canvas, grade.vignette ?? 0);
  syncGrainOverlay(canvas, grade.grain ?? 0);
}

/**
 * Build the FFmpeg filter chain that bakes this grade at export.
 * Uses the SAME tone-table math as the live preview (buildTableNumbers), so
 * what you see on the canvas is what the exported file looks like.
 * Returns null when the grade is inactive.
 */
export function buildFfmpegGradeFilter(
  grade: ColorGradeParams | null | undefined,
): string | null {
  if (!grade || !hasActiveGrade(grade)) return null;
  const filters: string[] = [];

  const toneActive =
    !!grade.curves ||
    (grade.temperature ?? 0) !== 0 ||
    (grade.tint ?? 0) !== 0 ||
    (grade.shadows ?? 0) !== 0 ||
    (grade.midtones ?? 0) !== 0 ||
    (grade.highlights ?? 0) !== 0;
  if (toneActive) {
    const pts = (ch: 'r' | 'g' | 'b') =>
      buildTableNumbers(ch, grade)
        .map((v, i) => `${(i / 16).toFixed(4)}/${v.toFixed(4)}`)
        .join(' ');
    filters.push(`curves=red='${pts('r')}':green='${pts('g')}':blue='${pts('b')}'`);
  }

  const hue = grade.hue ?? 0;
  if (hue !== 0) filters.push(`hue=h=${hue}`);

  const sat = grade.saturation ?? 1;
  if (sat !== 1) filters.push(`eq=saturation=${Math.max(0, Math.min(3, sat)).toFixed(3)}`);

  const sharpen = grade.sharpen ?? 0;
  if (sharpen > 0) filters.push(`unsharp=5:5:${((sharpen / 100) * SHARPEN_MAX_AMOUNT).toFixed(2)}`);

  const blur = grade.blur ?? 0;
  if (blur > 0) filters.push(`gblur=sigma=${blurSigma(blur).toFixed(2)}`);

  const vignette = grade.vignette ?? 0;
  if (vignette > 0) filters.push(`vignette=angle=${((vignette / 100) * (Math.PI / 2)).toFixed(4)}`);

  // Temporal + uniform noise — real animated film grain in the export.
  // Strength maps 0..100 → alls 0..28 (28 is blatant, ~12 is subtle).
  const grain = grade.grain ?? 0;
  if (grain > 0) filters.push(`noise=alls=${Math.round((grain / 100) * 28)}:allf=t+u`);

  return filters.length ? filters.join(',') : null;
}
