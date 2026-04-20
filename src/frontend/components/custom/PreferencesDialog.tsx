import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/frontend/components/ui/dialog';
import { Input } from '@/frontend/components/ui/input';
import { Label } from '@/frontend/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/frontend/components/ui/select';
import { Switch } from '@/frontend/components/ui/switch';
import { useVideoEditorStore } from '@/frontend/features/editor/stores/videoEditor';
import { normalizeAutoSavePreferences } from '@/frontend/features/editor/stores/videoEditor/slices/projectSlice';
import {
  AUTO_SAVE_INTERVAL_MAX_MS,
  AUTO_SAVE_INTERVAL_MIN_MS,
  AUTO_SAVE_INTERVAL_OPTIONS_MS,
} from '@/frontend/features/editor/stores/videoEditor/utils/constants';
import { KeyboardEvent, useEffect, useMemo, useState } from 'react';

interface PreferencesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const AUTO_SAVE_PRESET_LABELS: Record<number, string> = {
  30000: '30s',
  60000: '1m',
  180000: '3m',
  300000: '5m',
  600000: '10m',
};

const clampIntervalMs = (value: number): number =>
  Math.min(
    AUTO_SAVE_INTERVAL_MAX_MS,
    Math.max(AUTO_SAVE_INTERVAL_MIN_MS, Math.round(value)),
  );

const toSeconds = (intervalMs: number): number =>
  Math.max(1, Math.round(intervalMs / 1000));

export const PreferencesDialog = ({
  open,
  onOpenChange,
}: PreferencesDialogProps) => {
  const autoSavePreferences = useVideoEditorStore(
    (state) => state.autoSavePreferences,
  );
  const setAutoSavePreferences = useVideoEditorStore(
    (state) => state.setAutoSavePreferences,
  );

  const normalizedPreferences =
    normalizeAutoSavePreferences(autoSavePreferences);

  const isPresetInterval = useMemo(
    () =>
      AUTO_SAVE_INTERVAL_OPTIONS_MS.some(
        (value) => value === normalizedPreferences.intervalMs,
      ),
    [normalizedPreferences.intervalMs],
  );

  const [useCustomInterval, setUseCustomInterval] = useState(!isPresetInterval);
  const [customSeconds, setCustomSeconds] = useState(
    String(toSeconds(normalizedPreferences.intervalMs)),
  );

  useEffect(() => {
    setUseCustomInterval(!isPresetInterval);
    setCustomSeconds(String(toSeconds(normalizedPreferences.intervalMs)));
  }, [isPresetInterval, normalizedPreferences.intervalMs]);

  const handlePresetChange = (value: string) => {
    if (value === 'custom') {
      setUseCustomInterval(true);
      return;
    }

    const nextIntervalMs = Number(value);
    if (!Number.isFinite(nextIntervalMs) || nextIntervalMs <= 0) return;

    setUseCustomInterval(false);
    setAutoSavePreferences({ intervalMs: clampIntervalMs(nextIntervalMs) });
  };

  const applyCustomSeconds = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return;

    const nextIntervalMs = clampIntervalMs(parsed * 1000);
    setCustomSeconds(String(toSeconds(nextIntervalMs)));
    setAutoSavePreferences({ intervalMs: nextIntervalMs });
  };

  const handleCustomInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    applyCustomSeconds(customSeconds);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Preferences
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Configure how the editor behaves while you work.
          </p>
        </DialogHeader>

        <section className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-5">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Auto-Save
            </h3>
            <p className="text-sm text-muted-foreground">
              Save changes automatically at your preferred interval.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="preferences-auto-save-toggle" className="text-sm">
                Enable Auto-Save
              </Label>
              <p className="text-xs text-muted-foreground">
                Turn automatic saves on or off instantly.
              </p>
            </div>
            <Switch
              id="preferences-auto-save-toggle"
              checked={normalizedPreferences.enabled}
              onCheckedChange={(enabled) =>
                setAutoSavePreferences({ enabled: enabled === true })
              }
            />
          </div>

          <div className="space-y-3">
            <Label htmlFor="preferences-auto-save-interval" className="text-sm">
              Interval
            </Label>
            <Select
              value={
                useCustomInterval
                  ? 'custom'
                  : String(normalizedPreferences.intervalMs)
              }
              onValueChange={handlePresetChange}
              disabled={!normalizedPreferences.enabled}
            >
              <SelectTrigger
                id="preferences-auto-save-interval"
                className="w-full"
              >
                <SelectValue placeholder="Select interval" />
              </SelectTrigger>
              <SelectContent>
                {AUTO_SAVE_INTERVAL_OPTIONS_MS.map((intervalMs) => (
                  <SelectItem key={intervalMs} value={String(intervalMs)}>
                    {AUTO_SAVE_PRESET_LABELS[intervalMs]}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>

            {useCustomInterval && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    id="preferences-auto-save-custom-seconds"
                    type="number"
                    inputMode="numeric"
                    min={Math.floor(AUTO_SAVE_INTERVAL_MIN_MS / 1000)}
                    max={Math.floor(AUTO_SAVE_INTERVAL_MAX_MS / 1000)}
                    step={1}
                    value={customSeconds}
                    onChange={(event) => setCustomSeconds(event.target.value)}
                    onBlur={() => applyCustomSeconds(customSeconds)}
                    onKeyDown={handleCustomInputKeyDown}
                    disabled={!normalizedPreferences.enabled}
                    className="w-40"
                  />
                  <span className="text-sm text-muted-foreground">seconds</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Allowed range: {Math.floor(AUTO_SAVE_INTERVAL_MIN_MS / 1000)}s
                  {' - '}
                  {Math.floor(AUTO_SAVE_INTERVAL_MAX_MS / 1000)}s.
                </p>
              </div>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
};
