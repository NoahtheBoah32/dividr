/**
 * SpeedRampCurve — the manual editor for a clip's speed ramp.
 *
 * Two views, because a 300px panel cannot show both scales at once. The top
 * strip is the whole clip: every ramp region as a block with its curve drawn
 * inside, plus the source/output rails showing what the ramp does to the clip's
 * length. The graph below zooms to the selected region, where a 2-second
 * transition is wide enough to read as the smooth arc it actually is.
 *
 * Dragging is delta-based everywhere: a handle records where it was grabbed and
 * moves by the pointer's displacement, so it always travels with the pointer and
 * never jumps to it. Transitions store their two EDGES rather than a centre and
 * a width, which is what lets the left handle own the left edge and the right
 * handle own the right edge instead of mirroring each other.
 *
 * Gating: locked until EDITH runs `speedRamp` (sets appliedByEdith on the track).
 */

import { Button } from '@/frontend/components/ui/button';
import { Switch } from '@/frontend/components/ui/switch';
import { cn } from '@/frontend/utils/utils';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { setLiveRamp } from '../../../preview/services/speedRampLive';
import {
  buildProfile,
  clamp,
  clampRegions,
  cloneRegions,
  eventSpan,
  extremeSpeed,
  formatSpeed,
  framesKept,
  HOLD_GAP,
  layoutHolds,
  makeRegion,
  MAX_HOLDS,
  MIN_RAMP,
  MIN_REGION,
  peakSpeed,
  reframeRegion,
  REGION_GAP,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_SNAPS,
  speedAt,
  type RampBlend,
  type RampShape,
  type SpeedRegion,
} from '../../../preview/utils/speedRampCurve';
import type { VideoTrack } from '../../../stores/videoEditor/index';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';

interface Props {
  track: VideoTrack;
}

/* Geometry. 268 = the 300px panel minus px-4 on both sides. */
const PADL = 24;
const PADR = 4;
const PLOTW = 268 - PADL - PADR;
const PT = 24;
const PH = 110;
const PB = PT + PH;
const BANDY = 139;
const BANDH = 9;
const TICKY = 148;
const LABY = 161;

const MX = 4;
const MW = 260;
const MREGY = 12;
const MREGH = 13;
const MTICKY = 28;
const MLABY = 40;
const MSRCY = 45;
const MRAILH = 5;
const MOUTY = 61;

const LMIN = Math.log(SPEED_MIN);
const LSPAN = Math.log(SPEED_MAX) - LMIN;

/** 1x is literally the panel's muted-foreground, so normal speed reads as calm. */
const HEAT: [number, [number, number, number]][] = [
  [0.1, [70, 132, 255]],
  [0.35, [96, 146, 224]],
  [1, [166, 166, 166]],
  [2.5, [226, 170, 80]],
  [7, [255, 142, 50]],
  [18, [255, 86, 50]],
  [40, [255, 48, 86]],
];

function heat(v: number): [number, number, number] {
  const s = clamp(v, SPEED_MIN, SPEED_MAX);
  const lv = Math.log(s);
  for (let i = 0; i < HEAT.length - 1; i++) {
    if (s <= HEAT[i + 1][0]) {
      const k = clamp(
        (lv - Math.log(HEAT[i][0])) /
          (Math.log(HEAT[i + 1][0]) - Math.log(HEAT[i][0])),
        0,
        1,
      );
      return [0, 1, 2].map((j) =>
        Math.round(HEAT[i][1][j] + (HEAT[i + 1][1][j] - HEAT[i][1][j]) * k),
      ) as [number, number, number];
    }
  }
  return HEAT[HEAT.length - 1][1];
}
const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const rgba = (c: [number, number, number], a: number) =>
  `rgba(${c[0]},${c[1]},${c[2]},${a})`;

type DragKind =
  | 'seg'
  | 'bound'
  | 'wingL'
  | 'wingR'
  | 'wallA'
  | 'wallB'
  | 'rmove';

interface DragState {
  kind: DragKind;
  /** Index of the hold or transition being moved. */
  i: number;
  region: number;
  /** Pointer position at grab, in data space. */
  grabT: number;
  grabLogV: number;
  /** Value(s) at grab — everything moves relative to these. */
  orig: number[];
  /** The region exactly as it was at grab, so a resize rescales the curve it
   *  started from rather than compounding each move's rounding. */
  snap: SpeedRegion;
  onMap: boolean;
}

const SHAPES: { key: RampShape; label: string }[] = [
  { key: 'smooth', label: 'Smooth' },
  { key: 'whip', label: 'Whip' },
  { key: 'snap', label: 'Snap' },
  { key: 'linear', label: 'Linear' },
];
const BLENDS: { key: RampBlend; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'blend', label: 'Blend' },
  { key: 'flow', label: 'Optical flow' },
];

const SpeedRampCurveComponent: React.FC<Props> = ({ track }) => {
  const updateTrack = useVideoEditorStore((s) => s.updateTrack);
  const beginGroup = useVideoEditorStore((s) => (s as any).beginGroup);
  const endGroup = useVideoEditorStore((s) => (s as any).endGroup);
  const fps = useVideoEditorStore((s) => (s as any).timeline?.fps ?? 30);

  const ramp = (track as any).speedRamp as
    | {
        enabled?: boolean;
        regions?: SpeedRegion[];
        sourceDuration?: number;
        blend?: RampBlend;
        audio?: boolean;
        pitch?: boolean;
        appliedByEdith?: boolean;
      }
    | undefined;

  const enabled = !!ramp?.enabled;
  const duration = ramp?.sourceDuration ?? 0;

  const [regions, setRegions] = useState<SpeedRegion[]>(() =>
    cloneRegions(ramp?.regions ?? []),
  );
  const [sel, setSel] = useState(0);
  const [unit, setUnit] = useState<'x' | 'pct'>('x');
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draggingRef = useRef(false);
  const rigRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<SVGSVGElement>(null);

  /**
   * The regions a drag is currently working from. Kept in step with state
   * synchronously so a pointermove always builds on the previous move's result
   * rather than on whatever React last rendered.
   */
  const regionsRef = useRef<SpeedRegion[]>(regions);
  useEffect(() => {
    regionsRef.current = regions;
  }, [regions]);

  /* Re-sync from the store when it changes from outside (EDITH / undo). */
  const storedKey = JSON.stringify(ramp?.regions ?? null);
  useEffect(() => {
    if (draggingRef.current) return;
    const fresh = cloneRegions(ramp?.regions ?? []);
    regionsRef.current = fresh;
    setRegions(fresh);
  }, [storedKey]);

  const selIdx = Math.min(sel, Math.max(0, regions.length - 1));
  const region: SpeedRegion | undefined = regions[selIdx];

  const profile = useMemo(
    () => buildProfile(regions, Math.max(0.1, duration)),
    [regions, duration],
  );

  /* The zoomed window: the selected region plus a little air on each side. */
  const view = useMemo(() => {
    if (!region) return { a: 0, b: Math.max(0.5, duration) };
    const pad = Math.max(0.4, (region.b - region.a) * 0.12);
    let a = region.a - pad;
    let b = region.b + pad;
    if (a < 0) {
      b -= a;
      a = 0;
    }
    if (b > duration) {
      a -= b - duration;
      b = duration;
    }
    a = Math.max(0, a);
    return { a, b: Math.min(duration, Math.max(a + 0.5, b)) };
  }, [region, duration]);

  const X = useCallback(
    (t: number) => PADL + ((t - view.a) / (view.b - view.a)) * PLOTW,
    [view],
  );
  const invX = useCallback(
    (px: number) => view.a + ((px - PADL) / PLOTW) * (view.b - view.a),
    [view],
  );
  const Y = useCallback(
    (v: number) =>
      PT + (1 - (Math.log(clamp(v, SPEED_MIN, SPEED_MAX)) - LMIN) / LSPAN) * PH,
    [],
  );
  const invLogY = useCallback(
    (py: number) => LMIN + (1 - clamp((py - PT) / PH, 0, 1)) * LSPAN,
    [],
  );
  const mScale = duration > 0 ? MW / duration : 0;
  const mapX = useCallback((t: number) => MX + t * mScale, [mScale]);
  const invMapX = useCallback(
    (px: number) => clamp((px - MX) / (mScale || 1), 0, duration),
    [mScale, duration],
  );

  const commit = useCallback(
    (next: SpeedRegion[], extra?: Record<string, unknown>) => {
      const dur = Math.max(0.1, duration);
      const prof = buildProfile(next, dur);
      beginGroup?.('Speed ramp');
      updateTrack(track.id, {
        speedRamp: {
          ...(ramp ?? {}),
          enabled: ramp?.enabled ?? true,
          appliedByEdith: ramp?.appliedByEdith ?? true,
          regions: next.map((r) => ({
            a: r.a,
            b: r.b,
            shape: r.shape,
            dir: r.dir,
            segs: r.segs.slice(),
            bounds: r.bounds.map((b) => ({ t0: b.t0, t1: b.t1 })),
          })),
          sourceDuration: dur,
          ...(extra ?? {}),
        },
        // The clip's timeline length follows the ramp, exactly as it does after
        // setSpeed — otherwise the ramp would silently run past the clip's end.
        endFrame:
          track.startFrame + Math.max(1, Math.round(prof.outDuration * fps)),
      } as any);
      endGroup?.();
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    },
    [
      beginGroup,
      endGroup,
      updateTrack,
      track.id,
      track.startFrame,
      ramp,
      duration,
      fps,
    ],
  );

  /* ---- live preview -------------------------------------------------------- */
  /**
   * While a handle is down the picture has to follow it, but writing the store
   * on every pointermove would re-render the editor (and restart the timeline's
   * playback loop, which depends on `tracks`) sixty times a second. So the
   * in-progress curve goes to the live channel the resolver reads, and the
   * compositor is nudged once per animation frame. The store — and with it the
   * clip's new length and one undo entry — is written on release.
   */
  const liveRef = useRef<SpeedRegion[] | null>(null);
  const liveRafRef = useRef(0);

  const pushLive = useCallback(
    (next: SpeedRegion[]) => {
      liveRef.current = next;
      if (liveRafRef.current) return;
      liveRafRef.current = requestAnimationFrame(() => {
        liveRafRef.current = 0;
        const latest = liveRef.current;
        if (!latest) return;
        setLiveRamp(track.id, {
          ...(ramp ?? {}),
          enabled: true,
          regions: latest,
          sourceDuration: Math.max(0.1, duration),
        } as never);
        window.dispatchEvent(new CustomEvent('dividr:forceRender'));
      });
    },
    [track.id, ramp, duration],
  );

  const dropLive = useCallback(() => {
    if (liveRafRef.current) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = 0;
    }
    liveRef.current = null;
    setLiveRamp(track.id, null);
  }, [track.id]);

  /* A drag interrupted by the panel unmounting (clip deselected, dock closed)
     must not leave the clip warped by an override nothing can see or clear. */
  useEffect(() => dropLive, [dropLive]);

  /* ---- pointer geometry ---------------------------------------------------- */
  const toLocal = useCallback(
    (svg: SVGSVGElement | null, e: React.PointerEvent | PointerEvent) => {
      if (!svg) return { x: 0, y: 0 };
      const pt = svg.createSVGPoint();
      pt.x = (e as PointerEvent).clientX;
      pt.y = (e as PointerEvent).clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const l = pt.matrixTransform(ctm.inverse());
      return { x: l.x, y: l.y };
    },
    [],
  );

  const startDrag = useCallback(
    (
      e: React.PointerEvent,
      kind: DragKind,
      i: number,
      regionIdx: number,
      onMap: boolean,
    ) => {
      if (!enabled) return;
      e.preventDefault();
      e.stopPropagation();
      const svg = onMap ? mapRef.current : rigRef.current;
      const l = toLocal(svg, e);
      const r = regions[regionIdx];
      if (!r) return;
      const grabT = onMap ? invMapX(l.x) : invX(l.x);
      const orig: number[] =
        kind === 'seg'
          ? [Math.log(r.segs[i])]
          : kind === 'bound'
            ? [r.bounds[i].t0, r.bounds[i].t1]
            : kind === 'wingL'
              ? [r.bounds[i].t0]
              : kind === 'wingR'
                ? [r.bounds[i].t1]
                : kind === 'wallA'
                  ? [r.a]
                  : kind === 'wallB'
                    ? [r.b]
                    : [r.a, r.b];
      const st: DragState = {
        kind,
        i,
        region: regionIdx,
        grabT,
        grabLogV: invLogY(l.y),
        orig,
        snap: cloneRegions([r])[0],
        onMap,
      };
      dragRef.current = st;
      draggingRef.current = true;
      setDrag(st);
      setSel(regionIdx);
      svg?.setPointerCapture(e.pointerId);
    },
    [enabled, regions, toLocal, invX, invMapX, invLogY],
  );

  const onMove = useCallback(
    (e: React.PointerEvent, onMap: boolean) => {
      const st = dragRef.current;
      if (!st || st.onMap !== onMap) return;
      const svg = onMap ? mapRef.current : rigRef.current;
      const l = toLocal(svg, e);
      const t = onMap ? invMapX(l.x) : invX(l.x);
      // Everything below moves by the pointer's DISPLACEMENT from the grab
      // point, never to its absolute position. That is what keeps a handle
      // travelling in the same direction as the hand, with no jump on grab.
      const dt = t - st.grabT;

      {
        const prev = regionsRef.current;
        const next = cloneRegions(prev);
        const r = next[st.region];
        if (!r) return;
        const prevR = next[st.region - 1];
        const nextR = next[st.region + 1];
        const lo = prevR ? prevR.b + REGION_GAP : 0;
        const hi = nextR ? nextR.a - REGION_GAP : duration;

        switch (st.kind) {
          case 'seg': {
            const dLog = invLogY(l.y) - st.grabLogV;
            let v = Math.exp(st.orig[0] + dLog);
            // Snap to the common speeds, in screen space so the pull feels even
            // across the log axis.
            for (const s of SPEED_SNAPS) {
              if (Math.abs(Y(s) - Y(v)) < (s === 1 ? 7 : 5)) {
                v = s;
                break;
              }
            }
            r.segs[st.i] = clamp(v, SPEED_MIN, SPEED_MAX);
            break;
          }
          case 'bound': {
            const w = st.orig[1] - st.orig[0];
            const eLo = st.i === 0 ? r.a : r.bounds[st.i - 1].t1 + HOLD_GAP;
            const eHi =
              st.i === r.bounds.length - 1
                ? r.b
                : r.bounds[st.i + 1].t0 - HOLD_GAP;
            const t0 = clamp(st.orig[0] + dt, eLo, Math.max(eLo, eHi - w));
            r.bounds[st.i] = { t0, t1: t0 + w };
            break;
          }
          case 'wingL': {
            const eLo = st.i === 0 ? r.a : r.bounds[st.i - 1].t1 + HOLD_GAP;
            r.bounds[st.i].t0 = clamp(
              st.orig[0] + dt,
              eLo,
              r.bounds[st.i].t1 - MIN_RAMP,
            );
            break;
          }
          case 'wingR': {
            const eHi =
              st.i === r.bounds.length - 1
                ? r.b
                : r.bounds[st.i + 1].t0 - HOLD_GAP;
            r.bounds[st.i].t1 = clamp(
              st.orig[0] + dt,
              r.bounds[st.i].t0 + MIN_RAMP,
              eHi,
            );
            break;
          }
          // The three window drags all go through reframeRegion so the curve
          // travels and stretches with its window. Writing a/b alone leaves the
          // transitions at their old absolute times and the clamp then flattens
          // them into a cut.
          case 'wallA': {
            const na = clamp(st.orig[0] + dt, lo, st.snap.b - MIN_REGION);
            reframeRegion(r, st.snap, na, st.snap.b);
            break;
          }
          case 'wallB': {
            const nb = clamp(st.orig[0] + dt, st.snap.a + MIN_REGION, hi);
            reframeRegion(r, st.snap, st.snap.a, nb);
            break;
          }
          case 'rmove': {
            const w = st.orig[1] - st.orig[0];
            const na = clamp(st.orig[0] + dt, lo, Math.max(lo, hi - w));
            reframeRegion(r, st.snap, na, na + w);
            break;
          }
        }
        const out = clampRegions(next, Math.max(0.1, duration));
        regionsRef.current = out;
        setRegions(out);
        // The preview follows the handle from here, not from the store.
        pushLive(out);
      }
    },
    [toLocal, invX, invMapX, invLogY, Y, duration, pushLive],
  );

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    draggingRef.current = false;
    setDrag(null);
    // Commit first, then hand the preview back to the store — both hold the
    // same curve at this point, so the handover is invisible.
    commit(regionsRef.current);
    dropLive();
  }, [commit, dropLive]);

  /* ---- region + hold editing ---------------------------------------------- */
  const addRegion = useCallback(() => {
    const gaps: [number, number][] = [];
    let prev = 0;
    for (const r of regions) {
      gaps.push([prev, r.a - REGION_GAP]);
      prev = r.b + REGION_GAP;
    }
    gaps.push([prev, duration]);
    let best: [number, number] | null = null;
    for (const g of gaps)
      if (!best || g[1] - g[0] > best[1] - best[0]) best = g;
    if (!best || best[1] - best[0] < MIN_REGION * 2) return;
    const w = best[1] - best[0];
    const r = makeRegion(best[0] + w * 0.12, best[1] - w * 0.12, 0.35);
    const next = clampRegions([...regions, r], duration);
    setRegions(next);
    setSel(next.indexOf(r) >= 0 ? next.indexOf(r) : next.length - 1);
    commit(next);
  }, [regions, duration, commit]);

  const removeRegion = useCallback(
    (i: number) => {
      if (regions.length <= 1) return;
      const next = regions.filter((_, k) => k !== i);
      setRegions(next);
      setSel(Math.max(0, i - 1));
      commit(next);
    },
    [regions, commit],
  );

  const changeHolds = useCallback(
    (delta: number) => {
      if (!region) return;
      const next = cloneRegions(regions);
      const r = next[selIdx];
      const inner = r.segs.slice(1, -1);
      if (delta > 0) {
        if (inner.length >= MAX_HOLDS) return;
        const last = inner[inner.length - 1] ?? 1;
        inner.push(
          last > 2
            ? Math.max(SPEED_MIN, last / 5)
            : Math.min(SPEED_MAX, last * 4),
        );
      } else {
        if (inner.length <= 1) return;
        inner.pop();
      }
      const [e0, e1] = eventSpan(r);
      const w = Math.min(
        (r.b - r.a) * 0.88,
        Math.max(e1 - e0, (r.b - r.a) * 0.5),
      );
      const c = clamp((e0 + e1) / 2, r.a + w / 2, r.b - w / 2);
      layoutHolds(r, c - w / 2, c + w / 2, inner);
      const clamped = clampRegions(next, duration);
      setRegions(clamped);
      commit(clamped);
    },
    [region, regions, selIdx, duration, commit],
  );

  const patchRegion = useCallback(
    (patch: Partial<SpeedRegion>) => {
      const next = cloneRegions(regions);
      if (!next[selIdx]) return;
      Object.assign(next[selIdx], patch);
      setRegions(next);
      commit(next);
    },
    [regions, selIdx, commit],
  );

  const patchRamp = useCallback(
    (patch: Record<string, unknown>) => {
      beginGroup?.('Speed ramp');
      updateTrack(track.id, {
        speedRamp: { ...(ramp ?? {}), ...patch },
      } as any);
      endGroup?.();
      window.dispatchEvent(new CustomEvent('dividr:forceRender'));
    },
    [beginGroup, endGroup, updateTrack, track.id, ramp],
  );

  /* ---- derived readouts ---------------------------------------------------- */
  const outDur = profile.outDuration;
  const delta = outDur - duration;
  const frames = useMemo(() => framesKept(profile, fps), [profile, fps]);
  const blend = ramp?.blend ?? 'blend';
  const worstPeak = useMemo(() => {
    let mx = 1;
    let which = 0;
    regions.forEach((r, i) => {
      const p = peakSpeed(r);
      if (p > mx) {
        mx = p;
        which = i;
      }
    });
    return { mx, which };
  }, [regions]);
  const strobeWarn = worstPeak.mx >= 6 && blend !== 'flow';

  /* ---- gate ---------------------------------------------------------------- */
  if (track.type !== 'video') return null;

  if (!ramp?.appliedByEdith && !enabled) {
    return (
      <div className="rounded-lg border border-dashed border-border/50 p-3 text-center">
        <p className="text-xs text-muted-foreground">
          No ramp yet — ask EDITH to speed ramp part of this clip.
        </p>
        <p className="text-[10px] text-muted-foreground/50 mt-1">
          &quot;Ramp this up to 3000% between 6 and 13 seconds&quot;
        </p>
      </div>
    );
  }

  if (!region || duration <= 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/50 p-3 text-center">
        <p className="text-xs text-muted-foreground">
          This ramp has no regions left.
        </p>
      </div>
    );
  }

  const curveD = (() => {
    let d = '';
    const N = 240;
    for (let i = 0; i <= N; i++) {
      const t = view.a + (i / N) * (view.b - view.a);
      d +=
        (i ? ' L ' : 'M ') +
        X(t).toFixed(2) +
        ' ' +
        Y(speedAt(regions, t)).toFixed(2);
    }
    return d;
  })();

  const axisStep =
    view.b - view.a > 12
      ? 2
      : view.b - view.a > 6
        ? 1
        : view.b - view.a > 3
          ? 0.5
          : 0.25;
  const axisTicks: number[] = [];
  for (
    let t = Math.ceil(view.a / axisStep) * axisStep;
    t <= view.b + 1e-6;
    t += axisStep
  ) {
    axisTicks.push(t);
  }

  return (
    // No greyed-out state: the panel unmounts this whole editor when the ramp
    // is off, so anything visible here is live and editable.
    <div className="space-y-2.5">
      {/* Whole-clip map ---------------------------------------------------- */}
      <svg
        ref={mapRef}
        viewBox={`0 0 268 78`}
        className="w-full touch-none select-none"
        style={{ cursor: drag?.onMap ? 'grabbing' : undefined }}
        onPointerMove={(e) => onMove(e, true)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <linearGradient
            id={`sr-src-${track.id}`}
            gradientUnits="userSpaceOnUse"
          >
            {Array.from({ length: 41 }, (_, i) => (
              <stop
                key={i}
                offset={`${(i / 40) * 100}%`}
                stopColor={rgb(heat(speedAt(regions, (i / 40) * duration)))}
              />
            ))}
          </linearGradient>
          <linearGradient
            id={`sr-out-${track.id}`}
            gradientUnits="userSpaceOnUse"
          >
            {Array.from({ length: 41 }, (_, i) => (
              <stop
                key={i}
                offset={`${(i / 40) * 100}%`}
                stopColor={rgb(
                  heat(speedAt(regions, profile.srcAt((i / 40) * outDur))),
                )}
              />
            ))}
          </linearGradient>
        </defs>

        {regions.map((r, i) => {
          const x0 = mapX(r.a);
          const w = Math.max(3, mapX(r.b) - x0);
          const c = heat(extremeSpeed(r));
          const on = i === selIdx;
          let d = '';
          for (let k = 0; k <= 40; k++) {
            const t = r.a + (k / 40) * (r.b - r.a);
            const yy =
              MREGY +
              MREGH -
              2.5 -
              ((Math.log(clamp(speedAt(regions, t), SPEED_MIN, SPEED_MAX)) -
                LMIN) /
                LSPAN) *
                (MREGH - 5);
            d +=
              (k ? ' L ' : 'M ') +
              (x0 + (k / 40) * w).toFixed(2) +
              ' ' +
              yy.toFixed(2);
          }
          return (
            <g key={i}>
              <rect
                x={x0}
                y={MREGY}
                width={w}
                height={MREGH}
                rx={3}
                fill={rgba(c, on ? 0.22 : 0.12)}
                stroke={rgba(c, on ? 0.75 : 0.35)}
                strokeWidth={on ? 1.2 : 0.8}
              />
              <path
                d={d}
                fill="none"
                stroke={rgba(c, on ? 0.95 : 0.5)}
                strokeWidth={1.1}
              />
              <text
                x={x0 + 3}
                y={MREGY + 8}
                fill={rgba(c, on ? 0.95 : 0.5)}
                style={{ font: '700 6px ui-monospace, monospace' }}
              >
                {i + 1}
              </text>
              <rect
                x={x0}
                y={MREGY}
                width={w}
                height={MREGH}
                fill="transparent"
                style={{ cursor: enabled ? 'grab' : 'default' }}
                onPointerDown={(e) => startDrag(e, 'rmove', 0, i, true)}
              />
              <line
                x1={x0}
                y1={MREGY - 2}
                x2={x0}
                y2={MREGY + MREGH + 2}
                stroke="transparent"
                strokeWidth={9}
                style={{ cursor: enabled ? 'ew-resize' : 'default' }}
                onPointerDown={(e) => startDrag(e, 'wallA', 0, i, true)}
              />
              <line
                x1={mapX(r.b)}
                y1={MREGY - 2}
                x2={mapX(r.b)}
                y2={MREGY + MREGH + 2}
                stroke="transparent"
                strokeWidth={9}
                style={{ cursor: enabled ? 'ew-resize' : 'default' }}
                onPointerDown={(e) => startDrag(e, 'wallB', 0, i, true)}
              />
            </g>
          );
        })}

        {/* time axis */}
        {Array.from(
          { length: Math.floor(duration / 5) + 1 },
          (_, i) => i * 5,
        ).map((t) => (
          <g key={t}>
            <line
              x1={mapX(t)}
              y1={MTICKY}
              x2={mapX(t)}
              y2={MTICKY + 3}
              stroke="#2e2e2e"
            />
            <text
              x={mapX(t)}
              y={MLABY}
              textAnchor={t === 0 ? 'start' : 'middle'}
              className="fill-muted-foreground"
              style={{ font: '700 6px ui-monospace, monospace' }}
            >
              {t}s
            </text>
          </g>
        ))}

        {/* source -> output rails */}
        <rect
          x={MX}
          y={MSRCY}
          width={MW}
          height={MRAILH}
          rx={2.5}
          fill={`url(#sr-src-${track.id})`}
          opacity={0.5}
        />
        <rect
          x={MX}
          y={MOUTY}
          width={clamp(outDur * mScale, 3, MW)}
          height={MRAILH}
          rx={2.5}
          fill={`url(#sr-out-${track.id})`}
        />
        {Array.from({ length: Math.floor(duration) + 1 }, (_, i) => i).map(
          (i) => (
            <line
              key={i}
              x1={mapX(i)}
              y1={MSRCY + MRAILH}
              x2={MX + profile.outAt(i) * mScale}
              y2={MOUTY}
              stroke="#fff"
              strokeWidth={i % 5 === 0 ? 0.85 : 0.5}
              opacity={i % 5 === 0 ? 0.15 : 0.07}
            />
          ),
        )}
        <text
          x={MX}
          y={MOUTY + MRAILH + 9}
          className="fill-muted-foreground"
          style={{ font: '700 6px ui-monospace, monospace' }}
        >
          SOURCE {duration.toFixed(1)}s
        </text>
        <text
          x={MX + MW}
          y={MOUTY + MRAILH + 9}
          textAnchor="end"
          className="fill-muted-foreground"
          style={{ font: '700 6px ui-monospace, monospace' }}
        >
          OUTPUT {outDur.toFixed(1)}s
        </text>
      </svg>

      {/* Region chips ------------------------------------------------------- */}
      <div className="flex flex-wrap gap-1">
        {regions.map((r, i) => (
          <button
            key={i}
            onClick={() => setSel(i)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums transition-colors',
              i === selIdx
                ? 'border-border bg-accent text-foreground'
                : 'border-border/50 text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="text-muted-foreground/70">{i + 1}</span>
            {r.a.toFixed(1)}–{r.b.toFixed(1)}s
            {i === selIdx && regions.length > 1 && (
              <span
                role="button"
                aria-label={`Remove ramp ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeRegion(i);
                }}
                className="ml-0.5 text-muted-foreground hover:text-destructive"
              >
                ×
              </span>
            )}
          </button>
        ))}
        {regions.length < 4 && (
          <button
            onClick={addRegion}
            disabled={!enabled}
            className="rounded-md border border-dashed border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            + Add ramp
          </button>
        )}
      </div>

      {/* Zoomed curve editor ------------------------------------------------ */}
      <div className="rounded-md border border-border/60 bg-muted/30 p-1">
        <svg
          ref={rigRef}
          viewBox="0 0 268 170"
          data-sr-rig="1"
          className="w-full touch-none select-none"
          style={{ cursor: drag && !drag.onMap ? 'grabbing' : undefined }}
          onPointerMove={(e) => onMove(e, false)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* speed gridlines */}
          {[0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40].map((v) => (
            <g key={v}>
              <line
                x1={PADL}
                y1={Y(v)}
                x2={PADL + PLOTW}
                y2={Y(v)}
                stroke={
                  v === 1 ? 'rgba(245,245,245,.22)' : 'rgba(245,245,245,.05)'
                }
              />
              {[0.1, 0.5, 1, 5, 20].includes(v) && (
                <text
                  x={PADL - 4}
                  y={Y(v) + 2.6}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ font: '700 6px ui-monospace, monospace' }}
                >
                  {v}×
                </text>
              )}
            </g>
          ))}

          {/* outside the working window is not yours to edit */}
          {region.a > view.a && (
            <rect
              x={PADL}
              y={PT}
              width={Math.max(0, X(region.a) - PADL)}
              height={PH}
              fill="#0f0f0f"
              opacity={0.62}
            />
          )}
          {region.b < view.b && (
            <rect
              x={X(region.b)}
              y={PT}
              width={Math.max(0, PADL + PLOTW - X(region.b))}
              height={PH}
              fill="#0f0f0f"
              opacity={0.62}
            />
          )}

          {/* transition bands */}
          {region.bounds.map((b, k) => (
            <rect
              key={`z${k}`}
              x={X(b.t0)}
              y={PT}
              width={Math.max(0.5, X(b.t1) - X(b.t0))}
              height={PH}
              fill="#fff"
              opacity={0.03}
            />
          ))}

          <path
            d={curveD}
            fill="none"
            stroke="#a6a6a6"
            strokeWidth={0.6}
            opacity={0.35}
          />
          <path
            d={curveD}
            fill="none"
            stroke={rgb(heat(extremeSpeed(region)))}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* region walls */}
          {[['wallA', region.a] as const, ['wallB', region.b] as const].map(
            ([kind, t]) => (
              <g key={kind}>
                <line
                  x1={X(t)}
                  y1={PT}
                  x2={X(t)}
                  y2={PB}
                  stroke="rgba(245,245,245,.42)"
                  strokeDasharray="3 3"
                />
                <line
                  x1={X(t)}
                  y1={PT}
                  x2={X(t)}
                  y2={PB}
                  stroke="transparent"
                  strokeWidth={14}
                  data-sr={kind}
                  style={{ cursor: enabled ? 'ew-resize' : 'default' }}
                  onPointerDown={(e) => startDrag(e, kind, 0, selIdx, false)}
                />
                <rect
                  x={clamp(X(t), PADL + 12, PADL + PLOTW - 12) - 11}
                  y={PT + 7}
                  width={22}
                  height={11}
                  rx={2}
                  fill="#0f0f0f"
                  opacity={0.88}
                />
                <text
                  x={clamp(X(t), PADL + 12, PADL + PLOTW - 12)}
                  y={PT + 14.5}
                  textAnchor="middle"
                  fill="rgba(245,245,245,.5)"
                  style={{ font: '700 6px ui-monospace, monospace' }}
                >
                  {t.toFixed(1)}s
                </text>
              </g>
            ),
          )}

          {/* holds — the 1x anchors are structural and not grabbable */}
          {region.segs.map((v, i) => {
            const t0 = i === 0 ? region.a : region.bounds[i - 1].t1;
            const t1 =
              i === region.segs.length - 1 ? region.b : region.bounds[i].t0;
            const anchor = i === 0 || i === region.segs.length - 1;
            const c = heat(v);
            const y = Y(v);
            const lab = formatSpeed(v, unit);
            const cx = clamp(
              (X(t0) + X(t1)) / 2,
              PADL + lab.length * 2.6 + 6,
              PADL + PLOTW - lab.length * 2.6 - 6,
            );
            const cy = y - 15 > PT + 2 ? y - 10 : y + 13;
            return (
              <g key={`s${i}`}>
                <line
                  x1={X(t0)}
                  y1={y}
                  x2={X(t1)}
                  y2={y}
                  stroke={rgb(c)}
                  strokeWidth={anchor ? 2 : 4.5}
                  strokeLinecap="round"
                  opacity={anchor ? 0.5 : 1}
                />
                {!anchor && (
                  <>
                    <line
                      x1={X(t0)}
                      y1={y}
                      x2={X(t1)}
                      y2={y}
                      stroke="transparent"
                      strokeWidth={16}
                      data-sr="seg"
                      data-i={i}
                      style={{ cursor: enabled ? 'ns-resize' : 'default' }}
                      onPointerDown={(e) =>
                        startDrag(e, 'seg', i, selIdx, false)
                      }
                    />
                    <rect
                      x={cx - (lab.length * 2.6 + 4.5)}
                      y={cy - 7.5}
                      width={lab.length * 5.2 + 9}
                      height={15}
                      rx={3}
                      fill="#0f0f0f"
                      opacity={0.9}
                    />
                    <text
                      x={cx}
                      y={cy + 0.5}
                      textAnchor="middle"
                      fill={rgb(c)}
                      style={{ font: '700 8px ui-monospace, monospace' }}
                    >
                      {lab}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* transition handles: the whole ramp, plus one per edge */}
          {region.bounds.map((b, k) => {
            const ya = Y(region.segs[k]);
            const yb = Y(region.segs[k + 1]);
            const y0 = Math.min(ya, yb);
            const y1 = Math.max(ya, yb);
            const mid = (b.t0 + b.t1) / 2;
            return (
              <g key={`b${k}`}>
                <line
                  x1={X(mid)}
                  y1={y0}
                  x2={X(mid)}
                  y2={y1}
                  stroke="rgba(245,245,245,.55)"
                  strokeWidth={1.8}
                />
                <line
                  x1={X(mid)}
                  y1={y0 - 6}
                  x2={X(mid)}
                  y2={y1 + 6}
                  stroke="transparent"
                  strokeWidth={14}
                  data-sr="bound"
                  data-i={k}
                  style={{ cursor: enabled ? 'ew-resize' : 'default' }}
                  onPointerDown={(e) => startDrag(e, 'bound', k, selIdx, false)}
                />
                {/* left edge owns t0, right edge owns t1 — each tracks the pointer */}
                <path
                  d={`M ${X(b.t0)} ${ya - 6} L ${X(b.t0)} ${ya + 6} M ${X(b.t0)} ${ya} L ${X(b.t0) - 5} ${ya}`}
                  stroke="rgba(245,245,245,.5)"
                  strokeWidth={1.2}
                  fill="none"
                />
                <line
                  x1={X(b.t0)}
                  y1={ya - 9}
                  x2={X(b.t0)}
                  y2={ya + 9}
                  stroke="transparent"
                  strokeWidth={14}
                  data-sr="wingL"
                  data-i={k}
                  style={{ cursor: enabled ? 'ew-resize' : 'default' }}
                  onPointerDown={(e) => startDrag(e, 'wingL', k, selIdx, false)}
                />
                <path
                  d={`M ${X(b.t1)} ${yb - 6} L ${X(b.t1)} ${yb + 6} M ${X(b.t1)} ${yb} L ${X(b.t1) + 5} ${yb}`}
                  stroke="rgba(245,245,245,.5)"
                  strokeWidth={1.2}
                  fill="none"
                />
                <line
                  x1={X(b.t1)}
                  y1={yb - 9}
                  x2={X(b.t1)}
                  y2={yb + 9}
                  stroke="transparent"
                  strokeWidth={14}
                  data-sr="wingR"
                  data-i={k}
                  style={{ cursor: enabled ? 'ew-resize' : 'default' }}
                  onPointerDown={(e) => startDrag(e, 'wingR', k, selIdx, false)}
                />
              </g>
            );
          })}

          {/* frames-kept band */}
          <g>
            {Array.from({ length: 60 }, (_, i) => {
              const t = view.a + (i / 60) * (view.b - view.a);
              const s = speedAt(regions, t);
              return (
                <rect
                  key={i}
                  x={PADL + (i / 60) * PLOTW}
                  y={BANDY}
                  width={PLOTW / 60 + 0.5}
                  height={BANDH}
                  fill={rgba(
                    heat(s),
                    0.1 + 0.82 * Math.pow(Math.min(1, 1 / s), 0.55),
                  )}
                />
              );
            })}
          </g>

          {/* time axis */}
          {axisTicks.map((t) => (
            <g key={t}>
              <line
                x1={X(t)}
                y1={TICKY}
                x2={X(t)}
                y2={TICKY + 3}
                stroke="#2e2e2e"
              />
              <text
                x={X(t)}
                y={LABY}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ font: '700 6px ui-monospace, monospace' }}
              >
                {axisStep < 1 ? t.toFixed(1) : t.toFixed(0)}s
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* Readouts ------------------------------------------------------------ */}
      <div className="flex items-center justify-between text-[10px] tabular-nums">
        <span className="text-muted-foreground">
          {duration.toFixed(1)}s →{' '}
          <span className="text-foreground">{outDur.toFixed(1)}s</span>
        </span>
        <span
          className={cn(
            'rounded px-1 py-0.5',
            delta <= 0
              ? 'bg-green-500/10 text-green-500'
              : 'bg-amber-500/10 text-amber-500',
          )}
        >
          {delta <= 0 ? '' : '+'}
          {delta.toFixed(1)}s
        </span>
        <span className="text-muted-foreground">
          {frames.kept} / {frames.total} frames
        </span>
        <div className="flex overflow-hidden rounded border border-border/60">
          {(['x', 'pct'] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              className={cn(
                'px-1 py-px',
                unit === u
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {u === 'x' ? '×' : '%'}
            </button>
          ))}
        </div>
      </div>

      {strobeWarn && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-500/90">
          Ramp {worstPeak.which + 1} hits {formatSpeed(worstPeak.mx, unit)} —
          only 1 frame in {Math.round(worstPeak.mx)} survives. Turn on optical
          flow so it does not strobe.
        </p>
      )}

      {/* Shape --------------------------------------------------------------- */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          Ramp shape — Ramp {selIdx + 1}
        </label>
        <div className="flex overflow-hidden rounded-md border border-border/60">
          {SHAPES.map((s) => (
            <button
              key={s.key}
              onClick={() => patchRegion({ shape: s.key })}
              disabled={!enabled}
              className={cn(
                'flex-1 px-1 py-1 text-[10px] transition-colors disabled:opacity-40',
                region.shape === s.key
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Direction ----------------------------------------------------------- */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Direction</label>
        <div className="flex overflow-hidden rounded-md border border-border/60">
          {(['forward', 'reverse'] as const).map((d) => (
            <button
              key={d}
              onClick={() => patchRegion({ dir: d })}
              disabled={!enabled}
              className={cn(
                'flex-1 px-1 py-1 text-[10px] capitalize transition-colors disabled:opacity-40',
                region.dir === d
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Holds --------------------------------------------------------------- */}
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">
          Holds in this ramp
          <span className="ml-1.5 tabular-nums text-foreground">
            {region.segs.length - 2}
          </span>
        </label>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => changeHolds(-1)}
            disabled={!enabled || region.segs.length - 2 <= 1}
          >
            − Remove
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => changeHolds(1)}
            disabled={!enabled || region.segs.length - 2 >= MAX_HOLDS}
          >
            + Add hold
          </Button>
        </div>
      </div>

      {/* In-betweens --------------------------------------------------------- */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">In betweens</label>
        <div className="flex overflow-hidden rounded-md border border-border/60">
          {BLENDS.map((b) => (
            <button
              key={b.key}
              onClick={() => patchRamp({ blend: b.key })}
              disabled={!enabled}
              className={cn(
                'flex-1 px-1 py-1 text-[10px] transition-colors disabled:opacity-40',
                blend === b.key
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Audio ride-along ---------------------------------------------------- */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">
            Stretch audio with speed
          </label>
          <Switch
            checked={!!ramp?.audio}
            onCheckedChange={(v) => patchRamp({ audio: v })}
            className="h-4 w-7"
            thumbClassName="size-3.5"
            disabled={!enabled}
          />
        </div>
        {ramp?.audio && (
          <div className="flex items-center justify-between pl-3">
            <label className="text-[11px] text-muted-foreground/80">
              Keep original pitch
            </label>
            <Switch
              checked={ramp?.pitch !== false}
              onCheckedChange={(v) => patchRamp({ pitch: v })}
              className="h-4 w-7"
              thumbClassName="size-3.5"
              disabled={!enabled}
            />
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground/70">
          {ramp?.audio
            ? 'Audio is stretched to the ramp’s new length so it still lines up at the end.'
            : 'Audio mutes through the ramp and picks back up after it.'}
        </p>
      </div>
    </div>
  );
};

SpeedRampCurveComponent.displayName = 'SpeedRampCurve';
export const SpeedRampCurve = React.memo(SpeedRampCurveComponent);
