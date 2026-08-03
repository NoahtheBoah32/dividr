// Cross-panel hand-off: the Record studio (or any surface) pushes a media file
// into EDITH's chat as an attachment. FridayPanel mounts lazily on first open,
// so the payload is stashed here and consumed on mount as well as via the live
// 'edith:attachMedia' event — whichever fires first wins, the other is a no-op.

export interface EdithMediaAttachment {
  name: string;
  path: string;
  preview?: string;
}

let pending: EdithMediaAttachment | null = null;

export function sendMediaToEdith(item: EdithMediaAttachment): void {
  pending = item;
  window.dispatchEvent(new CustomEvent('edith:attachMedia'));
}

export function consumePendingEdithAttachment(): EdithMediaAttachment | null {
  const p = pending;
  pending = null;
  return p;
}
