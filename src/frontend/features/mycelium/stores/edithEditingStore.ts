import { create } from 'zustand';

interface EdithEditingState {
  isEditing: boolean;
  isThinking: boolean;     // true = EDITH planning between ops; false = actively executing
  headFrame: number;
  currentOpLabel: string;

  startEditing: () => void;
  stopEditing: () => void;
  setHeadFrame: (frame: number) => void;
  setOpLabel: (label: string) => void;
  setIsThinking: (v: boolean) => void;
}

export const useEdithEditingStore = create<EdithEditingState>((set) => ({
  isEditing: false,
  isThinking: false,
  headFrame: 0,
  currentOpLabel: '',

  startEditing: () => set({ isEditing: true, isThinking: true, headFrame: 0, currentOpLabel: '' }),
  stopEditing: () => set({ isEditing: false, isThinking: false, currentOpLabel: '' }),
  setHeadFrame: (frame) => set({ headFrame: frame }),
  setOpLabel: (label) => set({ currentOpLabel: label }),
  setIsThinking: (v) => set({ isThinking: v }),
}));
