// Shared module-level state for the grade split-compare view.
// Using a plain object + custom event keeps the compositor loop out of React state.

export const gradeCompare = {
  enabled: false,
  split: 0.5,
};

export function setGradeCompare(enabled: boolean, split?: number) {
  gradeCompare.enabled = enabled;
  if (split !== undefined) gradeCompare.split = Math.max(0.01, Math.min(0.99, split));
  window.dispatchEvent(
    new CustomEvent('dividr:gradeCompare', {
      detail: { enabled: gradeCompare.enabled, split: gradeCompare.split },
    }),
  );
}
