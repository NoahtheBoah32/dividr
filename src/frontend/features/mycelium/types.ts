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
    }
  | {
      type: 'addCaption';
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
  | { type: 'runWhisper'; clipId: string }
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

export interface AgentQuestion {
  options: string[];   // exactly 3 options — UI always appends "Other" as D
  answered: boolean;
  answer?: string;     // the final answer text after user responds
}

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
  question?: AgentQuestion; // present when this message is a structured question
  plan?: AgentPlan;         // present when this message is an editing plan
  imagePreviews?: string[]; // base64 data URLs for images attached by the user
}

export interface MycelliumState {
  messages: AgentMessage[];
  queue: QueuedOp[];
  agentStatus: AgentStatus;
  activeAgent: 'friday' | 'arthur' | 'edith' | null;
}
