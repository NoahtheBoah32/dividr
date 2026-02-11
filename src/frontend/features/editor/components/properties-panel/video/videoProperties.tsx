import { Button } from '@/frontend/components/ui/button';
import { Input } from '@/frontend/components/ui/input';
import { Separator } from '@/frontend/components/ui/separator';
import { Slider } from '@/frontend/components/ui/slider';
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
import { RotateCcw } from 'lucide-react';
import React, { useCallback, useMemo, useRef } from 'react';
import { useVideoEditorStore } from '../../../stores/videoEditor/index';
import { AudioProperties } from '../audio/audioProperties';

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
  const canvasWidth = useVideoEditorStore(
    (state) => state.preview.canvasWidth || 1920,
  );
  const canvasHeight = useVideoEditorStore(
    (state) => state.preview.canvasHeight || 1080,
  );
  const updateTrack = useVideoEditorStore((state) => state.updateTrack);
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
  const halfCanvasWidth = useMemo(
    () => Math.max(canvasWidth / 2, 1),
    [canvasWidth],
  );
  const halfCanvasHeight = useMemo(
    () => Math.max(canvasHeight / 2, 1),
    [canvasHeight],
  );

  const normalizedToPixelX = useCallback(
    (normalized: number) => normalized * halfCanvasWidth,
    [halfCanvasWidth],
  );
  const normalizedToPixelY = useCallback(
    (normalized: number) => normalized * halfCanvasHeight,
    [halfCanvasHeight],
  );
  const pixelToNormalizedX = useCallback(
    (pixels: number) => pixels / halfCanvasWidth,
    [halfCanvasWidth],
  );
  const pixelToNormalizedY = useCallback(
    (pixels: number) => pixels / halfCanvasHeight,
    [halfCanvasHeight],
  );
  const formatPositionInputValue = useCallback((value: number) => {
    if (!Number.isFinite(value)) return '0';
    const rounded = Math.round(value * 1000) / 1000;
    const asString = `${rounded}`;
    return asString.includes('.') ? asString.replace(/\.?0+$/, '') : asString;
  }, []);

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

  const [isEditingPositionX, setIsEditingPositionX] = React.useState(false);
  const [isEditingPositionY, setIsEditingPositionY] = React.useState(false);

  // Local state for inputs to prevent focus loss
  const [localX, setLocalX] = React.useState(
    formatPositionInputValue(normalizedToPixelX(currentTransform.x)),
  );
  const [localY, setLocalY] = React.useState(
    formatPositionInputValue(normalizedToPixelY(currentTransform.y)),
  );
  const [localRotation, setLocalRotation] = React.useState(
    displayRotation.toFixed(1),
  );

  // Update local state when track changes
  React.useEffect(() => {
    if (!isEditingPositionX) {
      setLocalX(
        formatPositionInputValue(normalizedToPixelX(currentTransform.x)),
      );
    }
    if (!isEditingPositionY) {
      setLocalY(
        formatPositionInputValue(normalizedToPixelY(currentTransform.y)),
      );
    }
    setLocalRotation(displayRotation.toFixed(1));
  }, [
    selectedTrack.id,
    currentTransform.x,
    currentTransform.y,
    displayRotation,
    normalizedToPixelX,
    normalizedToPixelY,
    formatPositionInputValue,
    isEditingPositionX,
    isEditingPositionY,
  ]);

  const handlePositionXChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalX(newValue);
    },
    [],
  );

  const commitPositionX = useCallback(() => {
    const value = parseFloat(localX);
    if (Number.isFinite(value)) {
      updateTransform({ x: pixelToNormalizedX(value) });
      setLocalX(formatPositionInputValue(value));
    } else {
      setLocalX(
        formatPositionInputValue(normalizedToPixelX(currentTransform.x)),
      );
    }
    setIsEditingPositionX(false);
  }, [
    localX,
    updateTransform,
    pixelToNormalizedX,
    formatPositionInputValue,
    normalizedToPixelX,
    currentTransform.x,
  ]);

  const handlePositionYChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalY(newValue);
    },
    [],
  );

  const commitPositionY = useCallback(() => {
    const value = parseFloat(localY);
    if (Number.isFinite(value)) {
      updateTransform({ y: pixelToNormalizedY(value) });
      setLocalY(formatPositionInputValue(value));
    } else {
      setLocalY(
        formatPositionInputValue(normalizedToPixelY(currentTransform.y)),
      );
    }
    setIsEditingPositionY(false);
  }, [
    localY,
    updateTransform,
    pixelToNormalizedY,
    formatPositionInputValue,
    normalizedToPixelY,
    currentTransform.y,
  ]);

  const handlePositionXKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        setLocalX(
          formatPositionInputValue(normalizedToPixelX(currentTransform.x)),
        );
        setIsEditingPositionX(false);
        e.currentTarget.blur();
      }
    },
    [formatPositionInputValue, normalizedToPixelX, currentTransform.x],
  );

  const handlePositionYKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        setLocalY(
          formatPositionInputValue(normalizedToPixelY(currentTransform.y)),
        );
        setIsEditingPositionY(false);
        e.currentTarget.blur();
      }
    },
    [formatPositionInputValue, normalizedToPixelY, currentTransform.y],
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
              </>
            ) : (
              <>
                <TabsTrigger value="basic" variant="underline">
                  Basic
                </TabsTrigger>
                <TabsTrigger value="advanced" disabled variant="underline">
                  Advanced
                </TabsTrigger>
              </>
            )}
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
                  <TabsTrigger value="advanced" disabled variant="underline">
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
                        <div className="relative">
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                            px
                          </span>
                          <Input
                            type="number"
                            value={localX}
                            onChange={handlePositionXChange}
                            onFocus={() => setIsEditingPositionX(true)}
                            onBlur={commitPositionX}
                            onKeyDown={handlePositionXKeyDown}
                            step={1}
                            className="h-8 text-xs pr-7"
                            disabled={isMultipleSelected}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">
                          Y
                        </label>
                        <div className="relative">
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                            px
                          </span>
                          <Input
                            type="number"
                            value={localY}
                            onChange={handlePositionYChange}
                            onFocus={() => setIsEditingPositionY(true)}
                            onBlur={commitPositionY}
                            onKeyDown={handlePositionYKeyDown}
                            step={1}
                            className="h-8 text-xs pr-7"
                            disabled={isMultipleSelected}
                          />
                        </div>
                      </div>
                    </div>
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
                  <p className="text-xs text-muted-foreground">
                    Advanced video controls coming soon. This section will
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
                      <div className="relative">
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                          px
                        </span>
                        <Input
                          type="number"
                          value={localX}
                          onChange={handlePositionXChange}
                          onFocus={() => setIsEditingPositionX(true)}
                          onBlur={commitPositionX}
                          onKeyDown={handlePositionXKeyDown}
                          step={1}
                          className="h-8 text-xs pr-7"
                          disabled={isMultipleSelected}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Y</label>
                      <div className="relative">
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                          px
                        </span>
                        <Input
                          type="number"
                          value={localY}
                          onChange={handlePositionYChange}
                          onFocus={() => setIsEditingPositionY(true)}
                          onBlur={commitPositionY}
                          onKeyDown={handlePositionYKeyDown}
                          step={1}
                          className="h-8 text-xs pr-7"
                          disabled={isMultipleSelected}
                        />
                      </div>
                    </div>
                  </div>
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
                <p className="text-xs text-muted-foreground">
                  Advanced video controls coming soon. This section will include
                  effects, filters, and more transform options.
                </p>
              </div>
            </TabsContent>
          </>
        )}

        {/* Audio Tab */}
        {hasAudio && (
          <TabsContent value="audio" className="flex-1 overflow-hidden">
            <AudioProperties
              selectedTrackIds={[audioTrackId]}
              forceTrackId={audioTrackId}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};

VideoPropertiesComponent.displayName = 'VideoProperties';

export const VideoProperties = React.memo(VideoPropertiesComponent);
