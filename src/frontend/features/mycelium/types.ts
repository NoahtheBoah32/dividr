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
  | { type: 'placeSFX'; file: string; atTime: number; volume?: number; trackName?: string }
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
}

export interface MycelliumState {
  messages: AgentMessage[];
  queue: QueuedOp[];
  agentStatus: AgentStatus;
  activeAgent: 'friday' | 'arthur' | 'edith' | null;
}
