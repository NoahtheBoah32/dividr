import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/frontend/components/ui/button';
import { X } from 'lucide-react';

// ── color math ───────────────────────────────────────────────────────────────

function hexToHsv(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r)      h = ((g - b) / d + 6) % 6 * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else                h = ((r - g) / d + 4) * 60;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    return Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

// ── canvas draws ─────────────────────────────────────────────────────────────

function drawSVSquare(canvas: HTMLCanvasElement, hue: number) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
  ctx.fillRect(0, 0, width, height);
  const gW = ctx.createLinearGradient(0, 0, width, 0);
  gW.addColorStop(0, 'rgba(255,255,255,1)');
  gW.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gW; ctx.fillRect(0, 0, width, height);
  const gB = ctx.createLinearGradient(0, 0, 0, height);
  gB.addColorStop(0, 'rgba(0,0,0,0)');
  gB.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = gB; ctx.fillRect(0, 0, width, height);
}

function drawHueStrip(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0,    '#ff0000');
  g.addColorStop(0.17, '#ffff00');
  g.addColorStop(0.33, '#00ff00');
  g.addColorStop(0.5,  '#00ffff');
  g.addColorStop(0.67, '#0000ff');
  g.addColorStop(0.83, '#ff00ff');
  g.addColorStop(1,    '#ff0000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, light: boolean) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = light ? '#fff' : '#000';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ── component ─────────────────────────────────────────────────────────────────

interface ColorWheelPickerProps {
  initialHex: string;
  onApply: (hex: string) => void;
  onClose: () => void;
}

const SQ = 160;
const STRIP_W = 14;

export const ColorWheelPicker: React.FC<ColorWheelPickerProps> = ({ initialHex, onApply, onClose }) => {
  const sqRef   = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<'sq' | 'strip' | null>(null);

  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(initialHex));
  const [hexInput, setHexInput] = useState(initialHex);
  const [h, s, v] = hsv;

  // Redraw square when hue changes
  useEffect(() => {
    const canvas = sqRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    drawSVSquare(canvas, h);
    // Marker
    const mx = s * SQ;
    const my = (1 - v) * SQ;
    drawMarker(ctx, mx, my, v < 0.5);
  }, [h, s, v]);

  // Draw hue strip + strip marker
  useEffect(() => {
    const canvas = stripRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    drawHueStrip(canvas);
    const my = (h / 360) * SQ;
    ctx.beginPath();
    ctx.rect(0, Math.max(0, my - 2), STRIP_W, 4);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [h, s, v]);

  // Keep hex input in sync
  useEffect(() => { setHexInput(hsvToHex(h, s, v)); }, [h, s, v]);

  // ── pointer helpers ──

  const getSq = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const r = sqRef.current!.getBoundingClientRect();
    const sx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const sy = Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height));
    return [sx, 1 - sy];
  };

  const getStrip = (e: React.MouseEvent<HTMLCanvasElement>): number => {
    const r = stripRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(360, ((e.clientY - r.top) / r.height) * 360));
  };

  const onSqDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragging.current = 'sq';
    const [ns, nv] = getSq(e);
    setHsv(([h]) => [h, ns, nv]);
  };

  const onStripDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragging.current = 'strip';
    setHsv(([, s, v]) => [getStrip(e), s, v]);
  };

  const onMove = (e: React.MouseEvent) => {
    if (dragging.current === 'sq') {
      const [ns, nv] = getSq(e as React.MouseEvent<HTMLCanvasElement>);
      setHsv(([h]) => [h, ns, nv]);
    } else if (dragging.current === 'strip') {
      setHsv(([, s, v]) => [getStrip(e as React.MouseEvent<HTMLCanvasElement>), s, v]);
    }
  };

  const onUp = () => { dragging.current = null; };

  const handleHexInput = (val: string) => {
    setHexInput(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) setHsv(hexToHsv(val));
  };

  const currentHex = hsvToHex(h, s, v);

  return (
    <div
      className="rounded-xl border border-border bg-popover p-3 mt-2 space-y-2 select-none"
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Color Picker</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
      </div>

      <div className="flex gap-2">
        <canvas
          ref={sqRef}
          width={SQ} height={SQ}
          className="rounded cursor-crosshair flex-shrink-0"
          style={{ width: SQ, height: SQ }}
          onMouseDown={onSqDown}
        />
        <canvas
          ref={stripRef}
          width={STRIP_W} height={SQ}
          className="rounded cursor-ns-resize flex-shrink-0"
          style={{ width: STRIP_W, height: SQ }}
          onMouseDown={onStripDown}
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="w-7 h-6 rounded border border-border flex-shrink-0" style={{ background: currentHex }} />
        <input
          className="flex-1 text-xs font-mono bg-muted/30 border border-border rounded px-2 h-6 focus:outline-none focus:ring-1 focus:ring-ring text-foreground"
          value={hexInput}
          onChange={e => handleHexInput(e.target.value)}
          maxLength={7}
          spellCheck={false}
        />
      </div>

      <Button size="sm" className="w-full h-7 text-xs" onClick={() => { onApply(currentHex); onClose(); }}>
        Apply to grade
      </Button>
    </div>
  );
};

export default ColorWheelPicker;
