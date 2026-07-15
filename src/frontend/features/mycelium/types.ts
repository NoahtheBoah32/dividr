// Edit operation language — agents emit these, OperationEngine applies them to Dividr state

export type CaptionStyle = {
  fontFamily?: string;
  fontSize?: number;
  fillColor?: string;
  isBold?: boolean;
  isUppercase?: boolean;
  highlightColor?: string;
  highlightWordIndex?: number;
  position?: number; // 0–1, vertical position (0.65 = 65% from top)
};

export type Op =
  | { type: 'cut'; clipId: string; atFrame: number }
  | {
      type: 'insertClip';
      src: string;
      trackType: 'video' | 'audio' | 'image' | 'subtitle';
      startFrame: number;
      inSeconds: number;
      outSeconds: number;
      layer?: number; // trackRowIndex — 0 = main, 1 = overlay, 2 = top overlay
    }
  | {
      type: 'addCaption';
      text: string;
      startSeconds: number;
      endSeconds: number;
      style?: CaptionStyle;
    }
  | {
      type: 'addTrackedCaption';
      text: string;
      startSeconds: number;
      endSeconds: number;
      style?: CaptionStyle;
    }
  | { type: 'setVolume'; clipId: string; volumeDb: number }
  | { type: 'muteClip'; clipId: string; muted: boolean }
  | { type: 'addSfx'; src: string; atFrame: number }
  | {
      type: 'setBroll';
      src: string;
      startSeconds: number;
      endSeconds: number;
    }
  | {
      type: 'setLetterboxBlur';
      clipId: string;
      enabled: boolean;
    }
  | { type: 'trimClip'; clipId: string; newStartFrame: number; newEndFrame: number }
  | { type: 'deleteClip'; clipId: string }
  | { type: 'moveClip'; clipId: string; toStartFrame: number; toLayer?: number }
  | { type: 'setAspectRatio'; ratio: string }
  | { type: 'setCanvasSize'; width: number; height: number }
  | { type: 'updateClip'; clipId: string; updates: Record<string, unknown> }
  | {
      type: 'downloadMedia';
      url: string;
      startSeconds?: number;
      endSeconds?: number;
      filename?: string;
      verify?: string;       // what should be visible/audible in this segment (e.g. "Jensen Huang discussing AGI")
      topic?: string;        // content topic for relevance check (e.g. "permaculture food forest")
      isStockFootage?: boolean; // triggers watermark + talking-to-camera checks
    }
  | { type: 'cutSilence'; clipId: string; noiseDb?: number; minDuration?: number }
  | { type: 'runWhisper'; clipId: string; streamCaptions?: boolean }
  | { type: 'analyzeReference'; clipId: string }
  | {
      type: 'geminiEdit';
      userClipId: string;       // timeline track ID of the footage to edit
      referenceId: string;      // media library ID of the reference video
      userRequest: string;      // original user request (what kind of reel to make)
      targetDurationSeconds: number;
    }
  | {
      type: 'colorGrade';
      clipId: string;
      brightness?: number;   // 0–2, default 1
      contrast?: number;     // 0–2, default 1
      saturation?: number;   // 0–2, default 1
      hueRotate?: number;    // degrees, default 0
      blur?: number;         // px, default 0
    }
  | {
      type: 'adjust';
      clipName?: string;     // resolve by name; omit = main video track
      temperature?: number;  // -100..100 (warm/cool white balance)
      tint?: number;         // -100..100 (green/magenta white balance)
      hue?: number;          // -180..180
      shadows?: number;      // -100..100
      midtones?: number;     // -100..100
      highlights?: number;   // -100..100
      vignette?: number;     // 0..100
      sharpen?: number;      // 0..100
      blur?: number;         // 0..100
      grain?: number;        // 0..100 — animated film grain
      saturation?: number;   // 0..2, 1 = neutral
      reset?: boolean;       // true = clear all adjustment params (keeps extracted curves)
    }
  | {
      type: 'exportSettings';
      preset?: string;       // 'tiktok' | 'reels' | 'shorts' | 'youtube' | 'youtube-4k' | 'square'
      codec?: 'h264' | 'hevc';
      crf?: number;          // 0–51, lower = better quality (default 28)
      fps?: number;          // output frame rate override
      reset?: boolean;
    }
  | { type: 'exportSrt'; filename?: string; outputPath?: string }
  | { type: 'addMarker'; atSeconds: number; label: string; color?: string }
  | { type: 'removeMarker'; label?: string; atSeconds?: number }
  | { type: 'exportChapters'; filename?: string; outputPath?: string }
  | {
      type: 'saveStyle';
      name: string;          // creator name, e.g. "Esteban", "Mycelium"
      style: CaptionStyle;
    }
  | {
      type: 'renderGraphic';
      html: string;          // full Hyperframes HTML composition
      durationSeconds: number;
      startFrame: number;    // where to place the rendered clip on the timeline
      layer?: number;        // default 2 (above main video)
      width?: number;        // default matches canvas (1080 for 9:16)
      height?: number;       // default matches canvas (1920 for 9:16)
      useHyperframes?: boolean; // opt-in to full frame-by-frame render (~60s) — default false uses fast screenshot+FFmpeg path (~3s)
    }
  | { type: 'cursorMoveTo'; target: string; offsetX?: number; offsetY?: number }
  | { type: 'cursorClick' }
  | { type: 'cursorStartDrag'; target: string; label: string }
  | { type: 'cursorDrop'; target: string }
  | { type: 'cursorHide' }
  | { type: 'highlightClipSegment'; clipId: string; startFrac: number; endFrac: number; label: string }
  | { type: 'clearClipHighlight'; clipId: string }
  | { type: 'snapshotVerify'; atSeconds: number; reason: string }
  | { type: 'renameProject'; title: string }
  | { type: 'placeSFX'; file: string; atTime: number; volume?: number; trackName?: string; color?: string }
  | { type: 'scanVideo'; clipName: string; description: string; intervalSec?: number; maxFrames?: number }
  | { type: 'detectScenes'; clipId?: string; clipName?: string; threshold?: number }
  | {
      type: 'addTransition';
      fromClipId?: string;
      toClipId?: string;
      fromClipName?: string;
      toClipName?: string;
      cutIndex?: number; // 1-based cut to target (left→right). Omit = leftmost cut without a transition.
      transitionType?: 'dissolve' | 'dip' | 'wipe' | 'push' | 'slide' | 'zoom' | 'whip';
      durationSeconds?: number; // transition length, default 1.5s
      direction?: 'left' | 'right' | 'up' | 'down';
      color?: string; // dip color
    }
  | { type: 'removeTransition'; fromClipId?: string; toClipId?: string; fromClipName?: string; toClipName?: string }
  | {
      type: 'matchCut';
      clipId?: string; // the target clip to ghost
      clipName?: string;
      atSeconds?: number; // source time of the target frame to align to
      opacity?: number; // ghost opacity, default 0.45
      enable?: boolean; // default true; false clears the overlay
    }
  | { type: 'duck'; musicClipName: string; targetDb?: number; fadeDuration?: number }
  | { type: 'unduck'; musicClipName: string }
  | { type: 'isolateVoice'; preset?: 'studio' | 'podcast' | 'ambiance' | 'light' }
  | { type: 'separateStems' }
  | { type: 'ageVoice'; years?: number }
  | { type: 'detectLight' }
  | {
      type: 'paintLight';
      x?: number; // normalized 0..1; omit → bright side from detected lightSource, else center
      y?: number;
      radius?: number; // 0..1 of the frame's smaller dimension
      intensity?: number; // 0..2
      color?: string; // hex "#ffcc88" or a simple name
      kelvin?: number; // color temperature alternative to color
      blend?: 'screen' | 'soft-light' | 'overlay' | 'lighten';
      maskMode?: 'subject' | 'free';
    }
  | { type: 'clearLights' }
  | { type: 'flipClip'; axis?: 'horizontal' | 'vertical' | 'both'; clipName?: string }
  | { type: 'rotateClip'; degrees?: number; clipName?: string; absolute?: boolean }
  | {
      type: 'setSpeed';
      clipId: string;
      speed: number;           // 0.25 = 4x slow-mo, 0.5 = half speed, 2.0 = 2x fast
      startSeconds?: number;   // partial ramp: only affect this range
      endSeconds?: number;
    }
  | {
      type: 'zoomToFace';
      clipId: string;
      startSeconds: number;    // when to start the zoom
      endSeconds: number;      // when to ease back out
      zoomLevel?: number;      // default 2.5
      easeSeconds?: number;    // ease-in/out ramp duration, default 0.4s
      target?: string;         // what to zoom into — 'face' (default), 'ball', 'vase', 'money', etc.
    }
  | {
      type: 'analyzeMotion';
      clipId: string;
      detect?: string;        // comma-separated: 'punch,jump,energy,speaker' — default all
      autoIsolate?: boolean;  // if true, delete original and insert isolated segments after analysis
      windowSeconds?: number; // seconds of context around each event (default 1.5)
    }
  | {
      // "Hold the world, let one thing move" — motion-key selective freeze (no matte).
      type: 'selectiveFreeze';
      clipId?: string;
      clipName?: string;
      startSeconds: number;
      endSeconds: number;
      mode?: 'world-frozen' | 'subject-frozen' | 'full'; // world-frozen = subject keeps moving (default); full = plain freeze-frame
      freezeAt?: number;          // source second to hold the world at (default: region start)
      box?: string;               // region box: "rect:x,y,w,h" | "yolo:<class>" (normalized)
      lasso?: [number, number][]; // closed polygon (normalized) to constrain the live region
      subjectClass?: string;      // YOLO class to localize the moving subject (car, person, dog…)
    }
  | {
      // "Speed that lives inside the clip" — region-locked time-remap (no cut-out).
      type: 'regionalSpeed';
      clipId?: string;
      clipName?: string;
      startSeconds: number;
      endSeconds: number;
      speed?: number;      // region speed (0.35 = slow, 2 = fast)
      region?: string;     // "x,y,w,h" | "ellipse:cx,cy,rx,ry" | "lasso:[[x,y],..]" normalized
      lasso?: [number, number][]; // closed polygon (normalized); becomes region "lasso:..."
      invert?: boolean;    // slow everything EXCEPT the region (keep the drawn subject real-time)
      feather?: number;
    }
  | {
      // "Find me the moment" — CTRL-F for video. Jumps the playhead.
      type: 'findMoment';
      clipId?: string;
      clipName?: string;
      query?: string;      // spoken-words search (instant transcript jump)
      target?: string;     // visual object: car, dog, person, bicycle... or "motion"
      interval?: number;
    }
  | {
      // "Organize my media" — sort the media library into folders (name pass + frame reference).
      type: 'organizeMedia';
    }
  | {
      // Transcript Surgery — PULL (copy) a spoken phrase's scene to a new point.
      type: 'pullPhrase';
      phrase: string;
      atSeconds?: number;
      afterPhrase?: string;
    }
  | {
      // Transcript Surgery — REORDER (move) a spoken phrase's whole block to a new point.
      type: 'reorderPhrase';
      phrase: string;
      atSeconds?: number;
      afterPhrase?: string;
    }
  | {
      // Labels/Colors — color-code a timeline clip (stripe + tint on the clip).
      type: 'setClipColor';
      clipId?: string;
      clipName?: string;   // omit both = main video track
      color?: string;      // named (red/orange/yellow/green/teal/blue/purple/pink/gray) or #hex
      clear?: boolean;     // true = remove the label
    }
  | {
      // RGB Curves — per-channel tonal control from anchor points ([in,out] pairs, 0..1).
      type: 'setCurves';
      clipName?: string;
      red?: [number, number][];
      green?: [number, number][];
      blue?: [number, number][];
      master?: [number, number][]; // applied to all channels after the per-channel curves
      reset?: boolean;             // true = clear the curves
    }
  | {
      // Filters/LUTs — one-tap named color look (teal-orange, warm-film, bw, sepia, vintage…).
      type: 'applyLook';
      look: string;
      clipName?: string;
      intensity?: number;  // 0..100, default 100
    }
  | {
      // Sound design — short sharp audio hit to punctuate a moment.
      type: 'stinger';
      atSeconds?: number;  // omit = at the playhead
      sound?: string;      // override the auto-picked hit (resolved against the SFX library)
      volume?: number;     // dB, default -2
    }
  | {
      // Beat Sync — detect musical hits and drop a marker on every beat.
      type: 'beatSync';
      clipName?: string;   // omit = longest audio track (the music bed), else main video
      sensitivity?: number; // 1 (loose) .. 10 (strict), default 3
      minGapSec?: number;  // minimum spacing between beats, default 0.25
      maxMarkers?: number; // cap, default 60
    }
  | {
      // Rack focus — focus travels from one depth plane to another mid-shot.
      type: 'rackFocus';
      clipId?: string;
      clipName?: string;      // omit both = main video track
      startSeconds?: number;  // SOURCE seconds; omit BOTH to rack over the clip's own trimmed range
      endSeconds?: number;
      direction?: 'near-to-far' | 'far-to-near'; // default near-to-far (ignored when from/to given)
      from?: string;          // subject initially IN focus ("the vase of flowers") — vision-located, depth-anchored
      to?: string;            // subject focus travels TO ("the man in the doorway")
      strength?: number;      // max defocus 10..100, default 70 (blatant)
      holdSeconds?: number;   // hold at each end before/after the pull, default 0.35
    };

export type OpStatus = 'pending' | 'running' | 'applied' | 'failed' | 'undone';

export interface QueuedOp {
  id: string;
  op: Op;
  status: OpStatus;
  error?: string;
  appliedAt?: number;
}

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'done'
  | 'error';

export interface AgentPlanStep {
  id: string;
  step: string;
  status: 'pending' | 'active' | 'done';
}

export interface AgentPlan {
  steps: AgentPlanStep[];
  generating: boolean; // true while EDITH subprocess is still running
  open: boolean;       // dropdown expanded state
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'friday' | 'arthur' | 'edith' | 'system';
  text: string;
  timestamp: number;
  plan?: AgentPlan;         // present when this message is an editing plan
  imagePreviews?: string[]; // base64 data URLs for images attached by the user
  // Timeline clips the user attached by dragging into the chat — rendered as
  // Gemini-style cards on the sent bubble. thumbnail is only present on the
  // live echo; hydrated messages re-resolve it from the media library.
  clipAttachments?: Array<{
    trackId: string; name: string; startSec: number; endSec: number; thumbnail?: string;
  }>;
}

export interface MycelliumState {
  messages: AgentMessage[];
  queue: QueuedOp[];
  agentStatus: AgentStatus;
  activeAgent: 'friday' | 'arthur' | 'edith' | null;
}
