import { Button } from '@/frontend/components/ui/button';
import { Separator } from '@/frontend/components/ui/separator';
import { Slider } from '@/frontend/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/frontend/components/ui/tooltip';
import { cn } from '@/frontend/utils/utils';
import { ChevronDown, ChevronUp, Columns2, RotateCcw } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { gradeCompare, setGradeCompare } from '../../../preview/utils/gradeCompareState';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import { ColorWheelPicker } from './ColorWheelPicker';

interface ColorGradePanelProps {
  selectedTrackIds: string[];
}

const DEFAULT_GRADE = {
  intensity: 100,
  temperature: 0,
  tint: 0,
  hue: 0,
  shadows: 0,
  highlights: 0,
  midtones: 0,
};

type GradeKey = keyof typeof DEFAULT_GRADE;

const CONTROLS: Array<{ key: GradeKey; label: string; min: number; max: number; unit?: string }> = [
  { key: 'temperature', label: 'Temperature', min: -100, max: 100 },
  { key: 'tint',        label: 'Tint',        min: -100, max: 100 },
  { key: 'hue',         label: 'Hue',         min: -180, max: 180, unit: '°' },
  { key: 'shadows',     label: 'Shadows',     min: -100, max: 100 },
  { key: 'midtones',    label: 'Midtones',    min: -100, max: 100 },
  { key: 'highlights',  label: 'Highlights',  min: -100, max: 100 },
];

function hexToGradeParams(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const temperature = Math.round(((r - b) / 255) * 80);
  const tint = Math.round(((g - (r + b) / 2) / 255) * 60);
  // HSV hue → hue shift centered at 0
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r)      hue = ((g - b) / d + 6) % 6 * 60;
    else if (max === g) hue = ((b - r) / d + 2) * 60;
    else                hue = ((r - g) / d + 4) * 60;
  }
  hue = Math.round(hue > 180 ? hue - 360 : hue);
  return {
    temperature: Math.max(-100, Math.min(100, temperature)),
    tint: Math.max(-100, Math.min(100, tint)),
    hue: Math.max(-180, Math.min(180, hue)),
  };
}

function PaletteSwatch({ hex, active, onClick }: { hex: string; active: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="flex-1 min-w-0 rounded-md border transition-all hover:scale-105"
          style={{
            height: 36,
            background: hex,
            borderColor: active ? 'white' : 'rgba(255,255,255,0.1)',
            boxShadow: active ? '0 0 0 2px rgba(255,255,255,0.4)' : 'none',
          }}
        />
      </TooltipTrigger>
      <TooltipContent><p>{hex}</p></TooltipContent>
    </Tooltip>
  );
}

const ColorGradePanelComponent: React.FC<ColorGradePanelProps> = ({ selectedTrackIds }) => {
  const tracks = useVideoEditorStore(s => s.tracks);
  const updateTrack = useVideoEditorStore(s => s.updateTrack);
  const [openSwatchIdx, setOpenSwatchIdx] = useState<number | null>(null);
  const [showMorePalettes, setShowMorePalettes] = useState(false);
  const [compareActive, setCompareActive] = useState(gradeCompare.enabled);

  useEffect(() => {
    const handler = (e: Event) => setCompareActive((e as CustomEvent).detail.enabled);
    window.addEventListener('dividr:gradeCompare', handler);
    return () => {
      window.removeEventListener('dividr:gradeCompare', handler);
      // Turn off compare when panel unmounts
      if (gradeCompare.enabled) setGradeCompare(false);
    };
  }, []);

  const track = tracks.find(t =>
    t.type === 'video' &&
    ((t as any).trackRowIndex ?? 0) === 0,
  ) ?? tracks.find(t => t.id === selectedTrackIds[0]);

  const grade = (track as any)?.colorGrade ?? {};
  const palette: string[] = grade.palette ?? [];
  const current = { ...DEFAULT_GRADE, ...grade };

  const setGrade = useCallback((updates: Partial<typeof DEFAULT_GRADE> & { palette?: string[] }) => {
    if (!track) return;
    updateTrack(track.id, {
      colorGrade: { ...grade, ...updates },
    } as any);
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  }, [track?.id, grade, updateTrack]);

  const handleReset = useCallback(() => {
    if (!track) return;
    updateTrack(track.id, {
      colorGrade: { ...grade, ...DEFAULT_GRADE, intensity: 100 },
    } as any);
    window.dispatchEvent(new CustomEvent('dividr:forceRender'));
  }, [track?.id, grade, updateTrack]);

  const hasChanges = (current.intensity ?? 100) !== 100 || CONTROLS.some(c => (current[c.key] ?? 0) !== 0);

  if (!track) return null;

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Color Grade</h4>
        <div className="flex items-center gap-1">
          {grade.curves && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={compareActive ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setGradeCompare(!compareActive)}
                >
                  <Columns2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>Compare before / after</p></TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={handleReset} className="h-7 w-7 p-0" disabled={!hasChanges}>
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>Reset adjustments</p></TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Grade Intensity — only show when curves are loaded */}
      {grade.curves && (
        <>
          <GradeSlider
            label="Intensity"
            value={current.intensity ?? 100}
            min={0}
            max={100}
            onChange={v => setGrade({ intensity: v })}
            accentLeft="#374151"
            accentRight="#f9fafb"
          />
          <Separator />
        </>
      )}

      {/* Palette swatches */}
      {palette.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reference Palette</label>
            <span className="text-[10px] text-muted-foreground">click to pick</span>
          </div>
          <div className="flex gap-1.5">
            {palette.slice(0, 8).map((hex, i) => (
              <PaletteSwatch
                key={i}
                hex={hex}
                active={openSwatchIdx === i}
                onClick={() => setOpenSwatchIdx(openSwatchIdx === i ? null : i)}
              />
            ))}
          </div>
          {openSwatchIdx !== null && palette[openSwatchIdx] && (
            <ColorWheelPicker
              initialHex={palette[openSwatchIdx]}
              onApply={picked => {
                const newPalette = [...palette];
                newPalette[openSwatchIdx] = picked;
                setGrade({ ...hexToGradeParams(picked), palette: newPalette } as any);
                setOpenSwatchIdx(null);
              }}
              onClose={() => setOpenSwatchIdx(null)}
            />
          )}

          {/* View more — alternate palette sets from different reference frames */}
          {((grade.palettes?.length ?? 0) > 1) && (
            <div className="space-y-2 pt-1">
              <button
                onClick={() => setShowMorePalettes(v => !v)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {showMorePalettes ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {showMorePalettes ? 'Hide' : 'View more'}
              </button>

              {showMorePalettes && (grade.palettes ?? []).slice(1).map((set, idx) => (
                <div key={idx} className="space-y-1.5 rounded-md border border-border/40 p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground/60">
                      Set {idx + 2}{set.refTimeSec != null ? ` · ${set.refTimeSec.toFixed(1)}s` : ''}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-2 text-[10px]"
                      onClick={() => setGrade({ palette: set.palette, curves: set.curves } as any)}
                    >
                      Apply
                    </Button>
                  </div>
                  <div className="flex gap-1">
                    {set.palette.slice(0, 8).map((hex: string, i: number) => (
                      <div
                        key={i}
                        className="flex-1 min-w-0 rounded border border-white/10"
                        style={{ height: 20, background: hex }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {palette.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/50 p-3 text-center">
          <p className="text-xs text-muted-foreground">No palette yet — tell EDITH to apply a reference grade first.</p>
          <p className="text-[10px] text-muted-foreground/50 mt-1">"Apply the reference color grade to this clip"</p>
        </div>
      )}

      <Separator />

      {/* White Balance section */}
      <div className="space-y-3">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">White Balance</label>
        {CONTROLS.slice(0, 2).map(({ key, label, min, max, unit }) => (
          <GradeSlider
            key={key}
            label={label}
            value={current[key] ?? 0}
            min={min}
            max={max}
            unit={unit}
            onChange={v => setGrade({ [key]: v })}
            accentLeft={key === 'temperature' ? '#3b82f6' : '#22c55e'}
            accentRight={key === 'temperature' ? '#f97316' : '#ec4899'}
          />
        ))}
      </div>

      <Separator />

      {/* Hue */}
      <div className="space-y-3">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Hue</label>
        <GradeSlider
          label="Hue"
          value={current.hue ?? 0}
          min={-180}
          max={180}
          unit="°"
          onChange={v => setGrade({ hue: v })}
          accentLeft="#a855f7"
          accentRight="#f97316"
          rainbow
        />
      </div>

      <Separator />

      {/* Tone */}
      <div className="space-y-3">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Tone</label>
        {CONTROLS.slice(3).map(({ key, label, min, max }) => (
          <GradeSlider
            key={key}
            label={label}
            value={current[key] ?? 0}
            min={min}
            max={max}
            onChange={v => setGrade({ [key]: v })}
            accentLeft={key === 'shadows' ? '#1e293b' : key === 'highlights' ? '#fef9c3' : '#6b7280'}
            accentRight={key === 'shadows' ? '#475569' : key === 'highlights' ? '#fde047' : '#d1d5db'}
          />
        ))}
      </div>

      {grade.lastMethod && (
        <>
          <Separator />
          <p className="text-[10px] text-muted-foreground/50">
            Method: <span className="font-mono">{grade.lastMethod}</span>
            {grade.lastRefPath && ` · ref: ${grade.lastRefPath.split(/[/\\]/).pop()}`}
          </p>
        </>
      )}
    </div>
  );
};

function GradeSlider({
  label, value, min, max, unit = '', onChange, accentLeft, accentRight, rainbow = false,
}: {
  label: string; value: number; min: number; max: number; unit?: string;
  onChange: (v: number) => void; accentLeft: string; accentRight: string; rainbow?: boolean;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium">{label}</label>
        <span className={cn('text-xs tabular-nums', value !== 0 ? 'text-foreground' : 'text-muted-foreground')}>
          {value > 0 ? `+${value}` : value}{unit}
        </span>
      </div>
      <div className="relative">
        {rainbow ? (
          <div className="absolute inset-0 rounded-full h-1.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ background: 'linear-gradient(90deg,#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#a855f7,#ef4444)' }}
          />
        ) : (
          <div className="absolute inset-0 rounded-full h-1.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ background: `linear-gradient(90deg, ${accentLeft}, ${accentRight})`, opacity: 0.4 }}
          />
        )}
        <Slider
          min={min} max={max} step={1}
          value={[value]}
          onValueChange={([v]) => onChange(v)}
          className="w-full"
        />
      </div>
    </div>
  );
}

ColorGradePanelComponent.displayName = 'ColorGradePanel';
export const ColorGradePanel = React.memo(ColorGradePanelComponent);
