import { create } from 'zustand';

interface EdithEditingState {
  isEditing: boolean;
  isThinking: boolean;     // true = EDITH planning between ops; false = actively executing
  headFrame: number;
  currentOpLabel: string;
  // Last verified frame thumbnail — shown in timeline overlay after snapshot/brollCheck
  lastVerifiedFrame: string | null;   // base64 JPEG
  lastVerifiedPassed: boolean | null; // null = snapshot, true = b-roll pass, false = b-roll reject

  startEditing: () => void;
  stopEditing: () => void;
  setHeadFrame: (frame: number) => void;
  setOpLabel: (label: string) => void;
  setIsThinking: (v: boolean) => void;
  setLastVerifiedFrame: (frame: string | null, passed: boolean | null) => void;
}

export const useEdithEditingStore = create<EdithEditingState>((set) => ({
  isEditing: false,
  isThinking: false,
  headFrame: 0,
  currentOpLabel: '',
  lastVerifiedFrame: null,
  lastVerifiedPassed: null,

  startEditing: () => set({ isEditing: true, isThinking: true, headFrame: 0, currentOpLabel: '', lastVerifiedFrame: null }),
  stopEditing: () => set({ isEditing: false, isThinking: false, currentOpLabel: '', lastVerifiedFrame: null }),
  setHeadFrame: (frame) => set({ headFrame: frame }),
  setOpLabel: (label) => set({ currentOpLabel: label }),
  setIsThinking: (v) => set({ isThinking: v }),
  setLastVerifiedFrame: (frame, passed) => set({ lastVerifiedFrame: frame, lastVerifiedPassed: passed }),
}));
