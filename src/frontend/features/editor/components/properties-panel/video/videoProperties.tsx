import { Button } from '@/frontend/components/ui/button';
import { Input } from '@/frontend/components/ui/input';
import { Separator } from '@/frontend/components/ui/separator';
import { Slider } from '@/frontend/components/ui/slider';
import { Switch } from '@/frontend/components/ui/switch';
import { operationEngine } from '@/frontend/features/mycelium/operationEngine';
import { ensureStabilizationLoaded } from '@/frontend/features/editor/preview/services/stabilizationCache';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/frontend/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/frontend/components/ui/tooltip';
import { cn } from '@/frontend/utils/utils';
import { Loader2, RotateCcw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import { AudioProperties } from '../audio/audioProperties';
import { ColorGradePanel } from './colorGradePanel';
import { SpeedRampCurve } from './SpeedRampCurve';
import { buildProfile } from '@/frontend/features/editor/preview/utils/speedRampCurve';
import {
  kbClampZoom,
  KB_MIN_ZOOM,
  KB_MAX_ZOOM,
} from '@/frontend/features/editor/preview/utils/kenBurnsUtils';
import {
  setJCut,
  JCUT_MIN_LEAD,
  JCUT_MAX_LEAD,
} from '@/frontend/features/editor/stores/videoEditor/utils/jCutUtils';
import { VideoFramePanel } from './videoFramePanel';
import { NuancedEffectsPanel } from '../effects/nuancedEffectsPanel';

interface VideoPropertiesProps {
  selectedTrackIds: string[];
}

const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  width: 0,
  height: 0,
};

const VideoPropertiesComponent: React.FC<VideoPropertiesProps> = ({
  selectedTrackIds,
}) => {
  const tracks = useVideoEditorStore((state) => state.tracks);
  const updateTrack = useVideoEditorStore((state) => state.updateTrack);
  const timelineFps = useVideoEditorStore(
    (state) => (state as any).timeline?.fps ?? 30,
  );
  const updateTrackProperty = useVideoEditorStore(
    (state) => state.updateTrackProperty,
  );
  const beginPropertyUpdate = useVideoEditorStore(
    (state) => state.beginPropertyUpdate,
  );
  const endPropertyUpdate = useVideoEditorStore(
    (state) => state.endPropertyUpdate,
  );

  // Track if we're in a slider/knob drag to avoid multiple beginGroup calls
  const isDraggingRef = useRef(false);

  // Get selected video tracks
  const selectedVideoTracks = useMemo(
    () =>
      tracks.filter(
        (track) =>
          track.type === 'video' && selectedTrackIds.includes(track.id),
      ),
    [tracks, selectedTrackIds],
  );

  // Don't render if no video tracks are selected
  if (selectedVideoTracks.length === 0) {
    return null;
  }

  const isMultipleSelected = selectedVideoTracks.length > 1;
  const selectedTrack = selectedVideoTracks[0];
  const currentTransform = selectedTrack.textTransform || DEFAULT_TRANSFORM;

  // Check if video has audio (embedded or linked)
  const hasAudio = useMemo(() => {
    if (isMultipleSelected) return false;

    // Check for embedded audio (video track has volume properties)
    const hasEmbeddedAudio =
      selectedTrack.volume !== undefined ||
      selectedTrack.volumeDb !== undefined ||
      selectedTrack.muted !== undefined;

    // Check for linked audio
    const hasLinkedAudio =
      selectedTrack.isLinked && selectedTrack.linkedTrackId;

    return hasEmbeddedAudio || hasLinkedAudio;
  }, [selectedTrack, isMultipleSelected]);

  // Get linked audio track if present
  const linkedAudioTrack = useMemo(() => {
    if (!selectedTrack.isLinked || !selectedTrack.linkedTrackId) return null;
    return (
      tracks.find(
        (track) =>
          track.id === selectedTrack.linkedTrackId && track.type === 'audio',
      ) || null
    );
  }, [tracks, selectedTrack]);

  // Remove Background processing state
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);

  // Stabilization state — the toggle enqueues the SAME setStabilization op EDITH
  // emits, so the manual and AI paths run identical code. `isStabilizing` covers
  // the one-time motion analysis on first enable; toggling after that is instant.
  const [isStabilizing, setIsStabilizing] = useState(false);
  const stabState = (selectedTrack as any)?.stabilization as
    | { enabled: boolean; offsetsPath?: string; shakeBefore?: number; shakeAfter?: number }
    | undefined;
  useEffect(() => {
    if (!isStabilizing) return;
    const onStatus = (e: any) => {
      const t: string = e.detail?.text ?? '';
      if (/Stabilized|Stabilization (on|off)|analysis failed|failed/i.test(t)) setIsStabilizing(false);
    };
    window.addEventListener('edith:status', onStatus);
    return () => window.removeEventListener('edith:status', onStatus);
  }, [isStabilizing]);
  const handleStabilizationToggle = useCallback(
    (checked: boolean) => {
      if (!selectedTrack) return;
      const st = (selectedTrack as any).stabilization;
      // Sidecars from older models (pre-"stab3_") are stale — enabling with
      // one must re-analyze, not revive the retired curve.
      const cachedValid = st?.offsetsPath && /stab3_[^\\/]*$/.test(st.offsetsPath);
      // Off, or on with cached offsets → direct store write, instant like the
      // motion-blur slider (the compositor picks it up on the next drawn frame).
      if (!checked || cachedValid) {
        if (checked && cachedValid) ensureStabilizationLoaded(st.offsetsPath);
        updateTrack(selectedTrack.id, {
          stabilization: { ...(st ?? {}), enabled: checked },
        } as any);
        window.dispatchEvent(new CustomEvent('dividr:forceRender'));
        return;
      }
      // First enable on this source → run the one-time motion analysis through
      // the SAME setStabilization op EDITH emits.
      setIsStabilizing(true);
      operationEngine.enqueue({
        type: 'setStabilization',
        clipId: selectedTrack.id,
        enabled: true,
      } as any);
    },
    [selectedTrack, updateTrack],
  );
  const stabPct =
    stabState?.shakeBefore && stabState.shakeBefore > 0
      ? Math.round(
          (1 - (stabState.shakeAfter ?? 0) / stabState.shakeBefore) * 100,
        )
      : null;

  // Tab state management - persist while same track is selected
  const [activeTab, setActiveTab] = React.useState(
    hasAudio ? 'video' : 'basic',
  );
  const [videoSubTab, setVideoSubTab] = React.useState('basic');

  // Reset to appropriate default tab when selected track changes
  React.useEffect(() => {
    setActiveTab(hasAudio ? 'video' : 'basic');
    setVideoSubTab('basic');
  }, [selectedTrack.id, hasAudio]);

  // A ramp EDITH just applied lives under Advanced. Surface it the moment it
  // appears on THIS clip — otherwise the panel looks unchanged while the curve
  // sits one tab away. Only on the false→true edge, so re-selecting a ramped
  // clip later still opens on Basic like everything else.
  const rampSeenRef = React.useRef('');
  const rampApplied = !!(selectedTrack as any)?.speedRamp?.appliedByEdith;
  React.useEffect(() => {
    const id = selectedTrack.id;
    if (rampApplied && rampSeenRef.current === `${id}:false`) {
      if (hasAudio) {
        setActiveTab('video');
        setVideoSubTab('advanced');
      } else {
        setActiveTab('advanced');
      }
    }
    rampSeenRef.current = `${id}:${rampApplied}`;
  }, [rampApplied, selectedTrack.id, hasAudio]);

  // Ken Burns EDITH just applied lives under Basic. Surface it the moment it
  // appears on THIS clip, same edge-only rule as the ramp above.
  const kbSeenRef = React.useRef('');
  const kbApplied = !!(selectedTrack as any)?.kenBurns?.appliedByEdith;
  React.useEffect(() => {
    const id = selectedTrack.id;
    if (kbApplied && kbSeenRef.current === `${id}:false`) {
      if (hasAudio) {
        setActiveTab('video');
        setVideoSubTab('basic');
      } else {
        setActiveTab('basic');
      }
    }
    kbSeenRef.current = `${id}:${kbApplied}`;
  }, [kbApplied, selectedTrack.id, hasAudio]);

  // J-cut EDITH just applied lives under Basic too — same edge-only rule.
  const jcSeenRef = React.useRef('');
  const jcApplied = !!(selectedTrack as any)?.jCut?.appliedByEdith;
  React.useEffect(() => {
    const id = selectedTrack.id;
    if (jcApplied && jcSeenRef.current === `${id}:false`) {
      if (hasAudio) {
        setActiveTab('video');
        setVideoSubTab('basic');
      } else {
        setActiveTab('basic');
      }
    }
    jcSeenRef.current = `${id}:${jcApplied}`;
  }, [jcApplied, selectedTrack.id, hasAudio]);

  // Determine which track ID to use for audio tab
  const audioTrackId = useMemo(() => {
    if (linkedAudioTrack) {
      return linkedAudioTrack.id;
    }
    // For embedded audio, use video track ID
    return selectedTrack.id;
  }, [linkedAudioTrack, selectedTrack.id]);

  // Sanitize transform values to ensure they are valid numbers
  // This prevents NaN/Infinity from breaking the canvas rendering
  const sanitizeTransform = useCallback(
    (
      transform: Partial<typeof DEFAULT_TRANSFORM>,
    ): Partial<typeof DEFAULT_TRANSFORM> => {
      const sanitized: Partial<typeof DEFAULT_TRANSFORM> = {};
      if (transform.x !== undefined) {
        sanitized.x = Number.isFinite(transform.x) ? transform.x : 0;
      }
      if (transform.y !== undefined) {
        sanitized.y = Number.isFinite(transform.y) ? transform.y : 0;
      }
      if (transform.scale !== undefined) {
        sanitized.scale =
          Number.isFinite(transform.scale) && transform.scale > 0
            ? transform.scale
            : 1;
      }
      if (transform.rotation !== undefined) {
        sanitized.rotation = Number.isFinite(transform.rotation)
          ? transform.rotation
          : 0;
      }
      if (transform.width !== undefined) {
        sanitized.width =
          Number.isFinite(transform.width) && transform.width > 0
            ? transform.width
            : 0;
      }
      if (transform.height !== undefined) {
        sanitized.height =
          Number.isFinite(transform.height) && transform.height > 0
            ? transform.height
            : 0;
      }
      return sanitized;
    },
    [],
  );

  // Helper function to get a proper default transform for a track
  // This ensures width/height are never zero, which would cause invisible renders
  const getDefaultTransformForTrack = useCallback(
    (track: (typeof selectedVideoTracks)[0]) => ({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      width: track.width || 1920,
      height: track.height || 1080,
    }),
    [],
  );

  // Helper function to update transform for selected tracks (creates undo entry)
  const updateTransform = useCallback(
    (transformUpdates: Partial<typeof DEFAULT_TRANSFORM>) => {
      const sanitizedUpdates = sanitizeTransform(transformUpdates);
      selectedVideoTracks.forEach((track) => {
        // Use track-specific defaults to ensure width/height are never zero
        const currentTrackTransform =
          track.textTransform || getDefaultTransformForTrack(track);
        updateTrack(track.id, {
          textTransform: {
            ...currentTrackTransform,
            ...sanitizedUpdates,
          },
        });
      });
    },
    [
      selectedVideoTracks,
      updateTrack,
      sanitizeTransform,
      getDefaultTransformForTrack,
    ],
  );

  // Helper function to update transform during drag (batch-safe, no individual undo entries)
  const updateTransformDrag = useCallback(
    (transformUpdates: Partial<typeof DEFAULT_TRANSFORM>) => {
      const sanitizedUpdates = sanitizeTransform(transformUpdates);
      selectedVideoTracks.forEach((track) => {
        // Use track-specific defaults to ensure width/height are never zero
        const currentTrackTransform =
          track.textTransform || getDefaultTransformForTrack(track);
        updateTrackProperty(track.id, {
          textTransform: {
            ...currentTrackTransform,
            ...sanitizedUpdates,
          },
        });
      });
    },
    [
      selectedVideoTracks,
      updateTrackProperty,
      sanitizeTransform,
      getDefaultTransformForTrack,
    ],
  );

  // Check if transform has changed from default
  const hasTransformChanged = useMemo(() => {
    return (
      currentTransform.scale !== 1 ||
      currentTransform.x !== 0 ||
      currentTransform.y !== 0 ||
      currentTransform.rotation !== 0
    );
  }, [currentTransform]);

  // Handle slider drag start (begin batch transaction)
  const handleSliderDragStart = useCallback(() => {
    if (!isDraggingRef.current) {
      isDraggingRef.current = true;
      beginPropertyUpdate('Update Transform');
    }
  }, [beginPropertyUpdate]);

  // Handle slider drag end (end batch transaction)
  const handleSliderDragEnd = useCallback(() => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      endPropertyUpdate();
    }
  }, [endPropertyUpdate]);

  const handleScaleSliderChange = useCallback(
    (values: number[]) => {
      updateTransformDrag({ scale: values[0] / 100 });
    },
    [updateTransformDrag],
  );

  const handleScaleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value) || 0;
      updateTransform({ scale: value / 100 });
    },
    [updateTransform],
  );

  // Normalize rotation for display (-180 to 180)
  const displayRotation = useMemo(() => {
    const normalized = ((currentTransform.rotation % 360) + 360) % 360;
    return normalized > 180 ? normalized - 360 : normalized;
  }, [currentTransform.rotation]);

  // Local state for inputs to prevent focus loss
  const [localX, setLocalX] = React.useState(currentTransform.x.toFixed(2));
  const [localY, setLocalY] = React.useState(currentTransform.y.toFixed(2));
  const [localRotation, setLocalRotation] = React.useState(
    displayRotation.toFixed(1),
  );

  // Update local state when track changes
  React.useEffect(() => {
    setLocalX(currentTransform.x.toFixed(2));
    setLocalY(currentTransform.y.toFixed(2));
    setLocalRotation(displayRotation.toFixed(1));
  }, [
    selectedTrack.id,
    currentTransform.x,
    currentTransform.y,
    displayRotation,
  ]);

  const handlePositionXChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalX(newValue);
      const value = parseFloat(newValue);
      if (!isNaN(value)) {
        updateTransform({ x: value });
      }
    },
    [updateTransform],
  );

  const handlePositionYChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalY(newValue);
      const value = parseFloat(newValue);
      if (!isNaN(value)) {
        updateTransform({ y: value });
      }
    },
    [updateTransform],
  );

  const handleRotationInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalRotation(newValue);
      const value = parseFloat(newValue);
      if (!isNaN(value) && Number.isFinite(value)) {
        // Ensure currentTransform.rotation is valid, default to 0 if not
        const safeCurrentRotation = Number.isFinite(currentTransform.rotation)
          ? currentTransform.rotation
          : 0;

        // Convert display rotation (-180 to 180) back to full rotation value
        const currentNormalized = ((safeCurrentRotation % 360) + 360) % 360;
        const currentDisplay =
          currentNormalized > 180 ? currentNormalized - 360 : currentNormalized;

        // Calculate the difference and apply it
        const rotationDelta = value - currentDisplay;
        const newRotation = safeCurrentRotation + rotationDelta;

        // Final validation to ensure we never store NaN or Infinity
        if (Number.isFinite(newRotation)) {
          updateTransform({
            rotation: newRotation,
          });
        }
      }
    },
    [updateTransform, currentTransform.rotation],
  );

  // Rotation knob handlers
  const [isDraggingKnob, setIsDraggingKnob] = React.useState(false);
  const knobRef = React.useRef<HTMLDivElement>(null);

  const handleKnobMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDraggingKnob(true);
      // Begin batch transaction for rotation knob drag
      beginPropertyUpdate('Update Rotation');
    },
    [beginPropertyUpdate],
  );

  React.useEffect(() => {
    if (!isDraggingKnob) return;

    let lastAngle = displayRotation;

    const handleMouseMove = (e: MouseEvent) => {
      if (!knobRef.current) return;

      const rect = knobRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Calculate angle from center to mouse position
      const angle =
        Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);

      // Normalize to -180 to 180 range
      let normalizedAngle = (angle + 90 + 360) % 360;
      if (normalizedAngle > 180) normalizedAngle -= 360;

      // Calculate the delta from last angle to avoid jumps
      let delta = normalizedAngle - (lastAngle % 360);

      // Handle wrap-around (crossing -180/180 boundary)
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;

      // Ensure currentTransform.rotation is valid, default to 0 if not
      const safeCurrentRotation = Number.isFinite(currentTransform.rotation)
        ? currentTransform.rotation
        : 0;
      const newRotation = safeCurrentRotation + delta;
      lastAngle = normalizedAngle;

      // Use drag version during knob drag (no individual undo entries)
      // Only update if the result is valid
      if (Number.isFinite(newRotation)) {
        updateTransformDrag({ rotation: newRotation });
      }
    };

    const handleMouseUp = () => {
      setIsDraggingKnob(false);
      document.body.style.cursor = '';
      // End batch transaction for rotation knob drag
      endPropertyUpdate();
    };

    // Set cursor to grabbing while dragging
    document.body.style.cursor = 'grabbing';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
  }, [
    isDraggingKnob,
    updateTransformDrag,
    endPropertyUpdate,
    displayRotation,
    currentTransform.rotation,
  ]);

  const handleResetTransform = useCallback(() => {
    updateTransform({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
    });
  }, [updateTransform]);

  // Background removal — calls electronAPI, replaces track source with alpha WebM/PNG
  const handleRemoveBackground = useCallback(async () => {
    const sourcePath = (selectedTrack as any).source || (selectedTrack as any).tempFilePath;
    if (!sourcePath) return;

    setIsRemovingBackground(true);
    try {
      const cacheDir = await window.electronAPI.getMediaCacheDir();
      const outputDir = (cacheDir as any).path ?? '';
      const result = await (window.electronAPI as any).removeBackground({
        inputPath: sourcePath,
        outputDir,
        model: 'rembg',
      });
      if (result?.success && result.filePath) {
        let previewUrl = result.filePath;
        try {
          const p = await window.electronAPI.createPreviewUrl(result.filePath);
          if (p && typeof p === 'object' && (p as any).url) previewUrl = (p as any).url;
          else if (typeof p === 'string') previewUrl = p;
        } catch { /* use filePath directly */ }
        updateTrack(selectedTrack.id, {
          source: result.filePath,
          previewUrl,
          backgroundRemoved: true,
          backgroundRemovedOutputPath: result.filePath,
        } as any);
      } else {
        console.error('Remove background failed:', result?.error);
      }
    } catch (err) {
      console.error('Remove background error:', err);
    } finally {
      setIsRemovingBackground(false);
    }
  }, [selectedTrack, updateTrack]);

  const handleResetBackgroundRemoval = useCallback(() => {
    updateTrack(selectedTrack.id, {
      backgroundRemoval: { enabled: false },
    } as any);
  }, [selectedTrack.id, updateTrack]);

  const backgroundRemovalEnabled =
    !!(selectedTrack as any).backgroundRemoval?.enabled;

  /**
   * Speed Ramp — unlocked by EDITH's speedRamp op. It lives under Advanced in
   * both panel layouts (with and without an audio tab), so it is built once
   * here rather than duplicated into each.
   */
  const rampEnabled = !!(selectedTrack as any).speedRamp?.enabled;
  const rampReady = !!(selectedTrack as any).speedRamp?.appliedByEdith;

  const speedRampSection = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="text-sm font-semibold text-foreground">
            Speed Ramp
          </label>
          {rampEnabled && (
            <div className="w-2 h-2 bg-green-500 rounded-full" />
          )}
        </div>
        <Switch
          checked={!!(selectedTrack as any).speedRamp?.enabled}
          onCheckedChange={(v) => {
            const sr = (selectedTrack as any).speedRamp;
            if (!sr) return;
            // Turning the ramp off restores the clip's untouched length;
            // turning it back on re-applies the curve's.
            const outFrames = v
              ? Math.max(
                  1,
                  Math.round(
                    buildProfile(
                      sr.regions ?? [],
                      Math.max(0.1, sr.sourceDuration ?? 0),
                    ).outDuration * timelineFps,
                  ),
                )
              : Math.max(
                  1,
                  Math.round((sr.sourceDuration ?? 0) * timelineFps),
                );
            updateTrack(selectedTrack.id, {
              speedRamp: { ...sr, enabled: v },
              endFrame: selectedTrack.startFrame + outFrames,
            } as any);
            window.dispatchEvent(new CustomEvent('dividr:forceRender'));
          }}
          className="h-4 w-7"
          thumbClassName="size-3.5"
          disabled={isMultipleSelected || !rampReady}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {rampEnabled
          ? 'Speed follows the curve inside each ramp region'
          : rampReady
            ? 'Turn on to re-apply the curve to this clip'
            : 'Ask EDITH to speed ramp part of this clip'}
      </p>

      {/* Collapsed when off, the same way Audio Ducking behaves — the editor
          disappears entirely rather than sitting there greyed out. */}
      {rampEnabled && !isMultipleSelected && (
        <SpeedRampCurve track={selectedTrack} />
      )}
    </div>
  );

  /**
   * Ken Burns — unlocked by EDITH's kenBurns op. Until then the section is
   * ABSENT from the panel entirely (not greyed out) — asking EDITH is what
   * reveals it. It lives under Basic in both panel layouts, so it is built
   * once here. The toggle applies instantly (pure store write, no analysis).
   */
  const kbState = (selectedTrack as any).kenBurns as
    | {
        enabled: boolean;
        endZoom: number;
        endCenter: { x: number; y: number };
        appliedByEdith?: boolean;
      }
    | undefined;
  const kenBurnsSection = kbState?.appliedByEdith ? (
    <>
      <Separator />
      <div className="space-y-3" data-testid="ken-burns-section">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-semibold text-foreground">
              Ken Burns
            </label>
            {kbState.enabled && (
              <div className="w-2 h-2 bg-green-500 rounded-full" />
            )}
          </div>
          <Switch
            checked={!!kbState.enabled}
            data-testid="ken-burns-toggle"
            onCheckedChange={(v) => {
              updateTrack(selectedTrack.id, {
                kenBurns: { ...kbState, enabled: v },
              } as any);
              window.dispatchEvent(new CustomEvent('dividr:forceRender'));
            }}
            className="h-4 w-7"
            thumbClassName="size-3.5"
            disabled={isMultipleSelected}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {kbState.enabled
            ? 'Slow push-in toward the focus point — drag the red End box in the preview'
            : 'Turn on to re-apply the push-in to this clip'}
        </p>
        {kbState.enabled && !isMultipleSelected && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">End zoom</label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.round(kbClampZoom(kbState.endZoom) * 100)}%
              </span>
            </div>
            <Slider
              value={[Math.round(kbClampZoom(kbState.endZoom) * 100)]}
              onValueChange={([v]) => {
                updateTrack(selectedTrack.id, {
                  kenBurns: { ...kbState, endZoom: v / 100 },
                } as any);
                window.dispatchEvent(new CustomEvent('dividr:forceRender'));
              }}
              min={Math.round(KB_MIN_ZOOM * 100)}
              max={Math.round(KB_MAX_ZOOM * 100)}
              step={1}
              className="flex-1"
              data-testid="ken-burns-zoom-slider"
            />
            <p className="text-xs text-muted-foreground">
              Eases in and out across the whole clip — baked on export
            </p>
          </div>
        )}
      </div>
    </>
  ) : null;

  /**
   * J-Cut — unlocked by EDITH's jCut op, same rule as Ken Burns: absent from
   * the panel until she has applied it once. A simple toggle plus a seconds
   * box; the surgery itself lives in jCutUtils.setJCut (one undo entry).
   */
  const jcState = (selectedTrack as any).jCut as
    | {
        enabled: boolean;
        leadSeconds: number;
        appliedLeadFrames: number;
        appliedByEdith?: boolean;
      }
    | undefined;
  const jCutSection = jcState?.appliedByEdith ? (
    <>
      <Separator />
      <div className="space-y-3" data-testid="j-cut-section">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-semibold text-foreground">
              J-Cut
            </label>
            {jcState.enabled && (
              <div className="w-2 h-2 bg-green-500 rounded-full" />
            )}
          </div>
          <Switch
            checked={!!jcState.enabled}
            data-testid="j-cut-toggle"
            onCheckedChange={(v) => {
              const res = setJCut(
                useVideoEditorStore.getState() as any,
                selectedTrack.id,
                { enabled: v },
              );
              if (!res.ok) console.warn(`J-cut: ${res.error}`);
            }}
            className="h-4 w-7"
            thumbClassName="size-3.5"
            disabled={isMultipleSelected}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {jcState.enabled
            ? `This clip's audio starts ${(
                jcState.appliedLeadFrames / timelineFps
              ).toFixed(1)}s before its picture cuts in`
            : 'Turn on to slide this clip’s audio back over the previous clip'}
        </p>
        {jcState.enabled && !isMultipleSelected && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs text-muted-foreground">
                Audio lead (s)
              </label>
              <Input
                type="number"
                min={JCUT_MIN_LEAD}
                max={JCUT_MAX_LEAD}
                step={0.5}
                defaultValue={Number(
                  (jcState.appliedLeadFrames / timelineFps).toFixed(1),
                )}
                key={`${selectedTrack.id}:${jcState.appliedLeadFrames}`}
                data-testid="j-cut-lead-input"
                className="h-7 w-20 text-right text-xs tabular-nums"
                onBlur={(e) => {
                  const v = parseFloat(e.currentTarget.value);
                  if (!Number.isFinite(v)) return;
                  const res = setJCut(
                    useVideoEditorStore.getState() as any,
                    selectedTrack.id,
                    { enabled: true, leadSeconds: v },
                  );
                  if (!res.ok) console.warn(`J-cut: ${res.error}`);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              You hear this clip before you see it — its audio leads the cut
            </p>
          </div>
        )}
      </div>
    </>
  ) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-4">
          <TabsList className="w-full rounded px-1.5">
            {hasAudio ? (
              <>
                <TabsTrigger value="video" className="rounded">
                  Video
                </TabsTrigger>
                <TabsTrigger value="audio" className="rounded">
                  Audio
                </TabsTrigger>
                <TabsTrigger value="color" className="rounded">
                  Color
                </TabsTrigger>
                <TabsTrigger value="frame" className="rounded">
                  Frame
                </TabsTrigger>
              </>
            ) : (
              <>
                <TabsTrigger value="basic" variant="underline">
                  Basic
                </TabsTrigger>
                <TabsTrigger value="advanced" variant="underline">
                  Advanced
                </TabsTrigger>
              </>
            )}
            <TabsTrigger value="effects" className="rounded">
              Effects
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Video Tab with nested Basic/Advanced tabs */}
        {hasAudio ? (
          <TabsContent
            value="video"
            className={cn(
              'flex-1 overflow-hidden',
              activeTab === 'video' && 'grid',
            )}
          >
            <Tabs
              value={videoSubTab}
              onValueChange={setVideoSubTab}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <div className="px-4">
                <TabsList variant="underline">
                  <TabsTrigger value="basic" variant="underline">
                    Basic
                  </TabsTrigger>
                  <TabsTrigger value="advanced" variant="underline">
                    Advanced
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent
                value="basic"
                className="flex-1 overflow-y-auto px-4 pb-4 space-y-4"
              >
                {/* Transform Section */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-foreground">
                      Transform
                    </h4>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleResetTransform}
                          className="h-7 w-7 p-0"
                          disabled={!hasTransformChanged || isMultipleSelected}
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {hasTransformChanged
                            ? 'Reset all transforms'
                            : 'No changes to reset'}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {/* Scale */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">
                        Scale
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Slider
                        value={[currentTransform.scale * 100]}
                        onValueChange={handleScaleSliderChange}
                        onPointerDown={handleSliderDragStart}
                        onValueCommit={handleSliderDragEnd}
                        min={0}
                        max={200}
                        step={1}
                        className="flex-1"
                        disabled={isMultipleSelected}
                      />
                      <Input
                        type="number"
                        value={Math.round(currentTransform.scale * 100)}
                        onChange={handleScaleInputChange}
                        min={0}
                        max={200}
                        className="w-16 h-8 text-xs text-center"
                        disabled={isMultipleSelected}
                      />
                      <span className="text-xs text-muted-foreground w-4">
                        %
                      </span>
                    </div>
                  </div>

                  <Separator />

                  {/* Opacity */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">
                        Opacity
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Slider
                        value={[100]}
                        onValueChange={() => {
                          // Disabled - no-op
                        }}
                        min={0}
                        max={100}
                        step={1}
                        className="flex-1"
                        disabled
                      />
                      <Input
                        type="number"
                        value={100}
                        onChange={() => {
                          // Disabled - no-op
                        }}
                        min={0}
                        max={100}
                        className="w-16 h-8 text-xs text-center"
                        disabled
                      />
                      <span className="text-xs text-muted-foreground w-4">
                        %
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Opacity controls coming soon
                    </p>
                  </div>

                  <Separator />

                  {/* Motion Blur */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">Motion Blur</label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {(selectedTrack as any).motionBlur ?? 0}
                      </span>
                    </div>
                    <Slider
                      value={[(selectedTrack as any).motionBlur ?? 0]}
                      onValueChange={([v]) => updateTrack(selectedTrack.id, { motionBlur: v } as any)}
                      min={0}
                      max={100}
                      step={1}
                      className="flex-1"
                      disabled={isMultipleSelected}
                    />
                    <p className="text-xs text-muted-foreground">Baked as frame blending on export</p>
                  </div>

                  <Separator />

                  {/* Stabilization */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <label className="text-sm font-semibold text-foreground">
                          Stabilization
                        </label>
                        {isStabilizing && (
                          <Loader2 className="size-4 animate-spin text-primary" />
                        )}
                        {stabState?.enabled && !isStabilizing && stabPct !== null && (
                          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/15 border border-green-500/30">
                            <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                            <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                              {stabPct}% steadier
                            </span>
                          </div>
                        )}
                      </div>
                      <Switch
                        checked={!!stabState?.enabled}
                        onCheckedChange={handleStabilizationToggle}
                        className="h-4 w-7"
                        thumbClassName="size-3.5"
                        disabled={isMultipleSelected || isStabilizing}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {isStabilizing
                        ? 'Measuring camera motion…'
                        : 'Removes camera shake — a slight smart zoom hides the edges, same resolution'}
                    </p>
                  </div>

                  {kenBurnsSection}

                  {jCutSection}

                  <Separator />

                  {/* Remove Background */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <label className="text-sm font-semibold text-foreground">
                          Remove Background
                        </label>
                        {isRemovingBackground && (
                          <Loader2 className="size-4 animate-spin text-primary" />
                        )}
                        {backgroundRemovalEnabled && !isRemovingBackground && (
                          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/15 border border-green-500/30">
                            <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                            <span className="text-xs text-green-600 dark:text-green-400 font-medium">Removed</span>
                          </div>
                        )}
                      </div>
                      {backgroundRemovalEnabled && !isRemovingBackground && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={handleResetBackgroundRemoval}
                              className="h-7 w-7 p-0"
                              disabled={isMultipleSelected}
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Clear background removal</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    {!backgroundRemovalEnabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full h-8 text-xs"
                        onClick={handleRemoveBackground}
                        disabled={isRemovingBackground || isMultipleSelected}
                      >
                        {isRemovingBackground ? 'Processing...' : 'Remove Background'}
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {backgroundRemovalEnabled
                        ? 'Background removed — baked at export'
                        : 'AI background removal'}
                    </p>
                  </div>

                  <Separator />

                  {/* Position */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">
                        Position
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">
                          X
                        </label>
                        <Input
                          type="number"
                          value={localX}
                          onChange={handlePositionXChange}
                          step={0.01}
                          className="h-8 text-xs"
                          disabled={isMultipleSelected}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">
                          Y
                        </label>
                        <Input
                          type="number"
                          value={localY}
                          onChange={handlePositionYChange}
                          step={0.01}
                          className="h-8 text-xs"
                          disabled={isMultipleSelected}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Normalized coordinates (-1 to 1, 0 = center)
                    </p>
                  </div>

                  <Separator />

                  {/* Rotation */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">
                        Rotation
                      </label>
                    </div>
                    <div className="grid grid-cols-2 items-center gap-3">
                      <Input
                        type="number"
                        value={localRotation}
                        onChange={handleRotationInputChange}
                        step={1}
                        className="h-8 text-xs"
                        disabled={isMultipleSelected}
                      />

                      {/* Rotation Knob */}
                      <div
                        ref={knobRef}
                        className="relative flex items-center justify-center size-10 rounded-full border-2 border-border bg-muted/50 cursor-grab active:cursor-grabbing hover:border-primary transition-colors select-none"
                        onMouseDown={handleKnobMouseDown}
                        style={{
                          opacity: isMultipleSelected ? 0.5 : 1,
                          pointerEvents: isMultipleSelected ? 'none' : 'auto',
                        }}
                      >
                        {/* Rotation indicator line */}
                        <div
                          className="absolute w-0.5 h-4 bg-primary rounded-full"
                          style={{
                            transform: `rotate(${displayRotation}deg)`,
                            transformOrigin: 'center bottom',
                            bottom: '50%',
                          }}
                        />
                        {/* Center dot */}
                        <div className="absolute w-1.5 h-1.5 bg-primary rounded-full" />
                      </div>
                    </div>
                  </div>
                </div>

                {isMultipleSelected && (
                  <div className="pt-4">
                    <p className="text-xs text-muted-foreground text-center">
                      Multiple tracks selected. Select a single track to edit
                      properties.
                    </p>
                  </div>
                )}
              </TabsContent>

              <TabsContent
                value="advanced"
                className="flex-1 overflow-y-auto px-4 pb-4 space-y-4 mt-4"
              >
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-foreground">
                    Advanced
                  </h4>

                  {speedRampSection}

                  <Separator />

                  <p className="text-xs text-muted-foreground">
                    More advanced video controls coming soon. This section will
                    include effects, filters, and more transform options.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </TabsContent>
        ) : (
          <>
            {/* No audio - show Basic/Advanced directly */}
            <TabsContent
              value="basic"
              className="flex-1 overflow-y-auto px-4 pb-4 space-y-4"
            >
              {/* Transform Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-foreground">
                    Transform
                  </h4>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetTransform}
                        className="h-7 w-7 p-0"
                        disabled={!hasTransformChanged || isMultipleSelected}
                      >
                        <RotateCcw className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {hasTransformChanged
                          ? 'Reset all transforms'
                          : 'No changes to reset'}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>

                {/* Scale */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">
                      Scale
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Slider
                      value={[currentTransform.scale * 100]}
                      onValueChange={handleScaleSliderChange}
                      onPointerDown={handleSliderDragStart}
                      onValueCommit={handleSliderDragEnd}
                      min={0}
                      max={200}
                      step={1}
                      className="flex-1"
                      disabled={isMultipleSelected}
                    />
                    <Input
                      type="number"
                      value={Math.round(currentTransform.scale * 100)}
                      onChange={handleScaleInputChange}
                      min={0}
                      max={200}
                      className="w-16 h-8 text-xs text-center"
                      disabled={isMultipleSelected}
                    />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                </div>

                <Separator />

                {/* Opacity */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">
                      Opacity
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Slider
                      value={[100]}
                      onValueChange={() => {
                        // Disabled - no-op
                      }}
                      min={0}
                      max={100}
                      step={1}
                      className="flex-1"
                      disabled
                    />
                    <Input
                      type="number"
                      value={100}
                      onChange={() => {
                        // Disabled - no-op
                      }}
                      min={0}
                      max={100}
                      className="w-16 h-8 text-xs text-center"
                      disabled
                    />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Opacity controls coming soon
                  </p>
                </div>

                <Separator />

                {/* Remove Background */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-semibold text-foreground">
                        Remove Background
                      </label>
                      {isRemovingBackground && (
                        <Loader2 className="size-4 animate-spin text-primary" />
                      )}
                      {backgroundRemovalEnabled && !isRemovingBackground && (
                        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/15 border border-green-500/30">
                          <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                          <span className="text-xs text-green-600 dark:text-green-400 font-medium">Removed</span>
                        </div>
                      )}
                    </div>
                    {backgroundRemovalEnabled && !isRemovingBackground && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleResetBackgroundRemoval}
                            className="h-7 w-7 p-0"
                            disabled={isMultipleSelected}
                          >
                            <RotateCcw className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Clear background removal</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  {!backgroundRemovalEnabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-8 text-xs"
                      onClick={handleRemoveBackground}
                      disabled={isRemovingBackground || isMultipleSelected}
                    >
                      {isRemovingBackground ? 'Processing...' : 'Remove Background'}
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {backgroundRemovalEnabled
                      ? 'Background removed — baked at export'
                      : 'AI background removal'}
                  </p>
                </div>

                <Separator />

                {/* Position */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">
                      Position
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">X</label>
                      <Input
                        type="number"
                        value={localX}
                        onChange={handlePositionXChange}
                        step={0.01}
                        className="h-8 text-xs"
                        disabled={isMultipleSelected}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Y</label>
                      <Input
                        type="number"
                        value={localY}
                        onChange={handlePositionYChange}
                        step={0.01}
                        className="h-8 text-xs"
                        disabled={isMultipleSelected}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Normalized coordinates (-1 to 1, 0 = center)
                  </p>
                </div>

                <Separator />

                {/* Rotation */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">
                      Rotation
                    </label>
                  </div>
                  <div className="grid grid-cols-2 items-center gap-3">
                    <Input
                      type="number"
                      value={localRotation}
                      onChange={handleRotationInputChange}
                      step={1}
                      className="h-8 text-xs"
                      disabled={isMultipleSelected}
                    />

                    {/* Rotation Knob */}
                    <div
                      ref={knobRef}
                      className="relative flex items-center justify-center size-10 rounded-full border-2 border-border bg-muted/50 cursor-grab active:cursor-grabbing hover:border-primary transition-colors select-none"
                      onMouseDown={handleKnobMouseDown}
                      style={{
                        opacity: isMultipleSelected ? 0.5 : 1,
                        pointerEvents: isMultipleSelected ? 'none' : 'auto',
                      }}
                    >
                      {/* Rotation indicator line */}
                      <div
                        className="absolute w-0.5 h-4 bg-primary rounded-full"
                        style={{
                          transform: `rotate(${displayRotation}deg)`,
                          transformOrigin: 'center bottom',
                          bottom: '50%',
                        }}
                      />
                      {/* Center dot */}
                      <div className="absolute w-1.5 h-1.5 bg-primary rounded-full" />
                    </div>
                  </div>
                </div>
              </div>

              {kenBurnsSection}

              {jCutSection}

              {isMultipleSelected && (
                <div className="pt-4">
                  <p className="text-xs text-muted-foreground text-center">
                    Multiple tracks selected. Select a single track to edit
                    properties.
                  </p>
                </div>
              )}
            </TabsContent>

            <TabsContent
              value="advanced"
              className="flex-1 overflow-y-auto px-4 pb-4 space-y-4 mt-4"
            >
              <div className="space-y-4">
                <h4 className="text-sm font-semibold text-foreground">
                  Advanced
                </h4>

                {speedRampSection}

                <Separator />

                <p className="text-xs text-muted-foreground">
                  More advanced video controls coming soon. This section will
                  include effects, filters, and more transform options.
                </p>
              </div>
            </TabsContent>
          </>
        )}

        {/* Audio Tab */}
        {hasAudio && (
          <TabsContent
            value="audio"
            className="flex-1 flex flex-col overflow-hidden"
          >
            <AudioProperties
              selectedTrackIds={[audioTrackId]}
              forceTrackId={audioTrackId}
            />
          </TabsContent>
        )}

        {/* Color Tab — reference grade palette + manual adjustments */}
        <TabsContent value="color" className="flex-1 overflow-hidden">
          <ColorGradePanel selectedTrackIds={selectedTrackIds} />
        </TabsContent>

        {/* Frame Tab — PiP config for the main video */}
        <TabsContent value="frame" className="flex-1 overflow-hidden">
          <VideoFramePanel selectedTrackIds={selectedTrackIds} />
        </TabsContent>

        {/* Effects Tab — nuanced AI skills: Transform, Light */}
        <TabsContent value="effects" className="flex-1 overflow-y-auto">
          <NuancedEffectsPanel selectedTrackIds={selectedTrackIds} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

VideoPropertiesComponent.displayName = 'VideoProperties';

export const VideoProperties = React.memo(VideoPropertiesComponent);
