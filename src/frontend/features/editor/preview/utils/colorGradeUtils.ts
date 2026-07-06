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
    (grade.highlights ?? 0) !== 0
  );
}

// Build SVG feComponentTransfer tableValues for one channel (17 points, 0..1)
function buildTableValues(
  channel: 'r' | 'g' | 'b',
  grade: ColorGradeParams,
  steps = 16,
): string {
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
  return values.join(' ');
}

const SVG_ID = 'dividr-grade-filter-svg';
const FILTER_ID = 'dividr-grade';
export { FILTER_ID as GRADE_FILTER_ID };

export function applyCSSColorGrade(
  canvas: HTMLCanvasElement,
  grade: ColorGradeParams | null | undefined,
): void {
  if (!grade || !hasActiveGrade(grade)) {
    canvas.style.filter = '';
    document.getElementById(SVG_ID)?.remove();
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

  svgEl.innerHTML = `
    <filter id="${FILTER_ID}" color-interpolation-filters="sRGB">
      <feComponentTransfer>
        <feFuncR type="table" tableValues="${rVals}"/>
        <feFuncG type="table" tableValues="${gVals}"/>
        <feFuncB type="table" tableValues="${bVals}"/>
      </feComponentTransfer>
    </filter>`;

  const hue = grade.hue ?? 0;
  const hueFilter = hue !== 0 ? ` hue-rotate(${hue}deg)` : '';
  canvas.style.filter = `url(#${FILTER_ID})${hueFilter}`;
}
