import { initializePanelRegistry } from '@/frontend/features/editor/components/panels/registerPanels';
import { useActivePanelType } from '@/frontend/features/editor/stores/PanelStore';
import React, { useRef } from 'react';
import {
  getCustomPanelComponent,
  hasCustomPanelComponent,
} from '../components/panels/panelRegistry';

interface ToolsPanelProps {
  className?: string;
}

// Initialize panel registry once
initializePanelRegistry();

const panelClass = (className?: string) =>
  `flex-1 min-h-0 flex flex-col ${className ?? ''}`;

const PanelFallback: React.FC<{ className?: string }> = ({ className }) => (
  <div
    className={`w-80 flex items-center justify-center bg-background border-l border-accent ${className ?? ''}`}
  >
    <div className="text-muted-foreground text-sm">Loading...</div>
  </div>
);

export const ToolsPanel: React.FC<ToolsPanelProps> = ({ className }) => {
  const activePanelType = useActivePanelType();
  const fridayActive = activePanelType === 'friday';

  // EDITH ('friday') is kept MOUNTED once opened, and only hidden when another panel
  // is active — it is never unmounted on a panel switch. EDITH's whole runtime (the
  // op pipeline, IPC listeners, the transcript-chunk pipeline and the auto-continue
  // chain) lives inside the FridayPanel component. The old behavior unmounted it the
  // instant you switched panels, which silently dropped any op EDITH emitted while you
  // were away and stalled her loop. Mounted-but-hidden, a running op finishes and keeps
  // updating while you look at the Media Sources panel (e.g. to watch an organize land).
  // (Fully closing the panel dock still unmounts it — that is a deliberate "hide EDITH".)
  const fridayOpenedRef = useRef(false);
  if (fridayActive) fridayOpenedRef.current = true;
  const FridayComp = getCustomPanelComponent('friday');
  const keepFriday = fridayOpenedRef.current && !!FridayComp;

  // The active NON-friday panel, rendered normally and swapped on each switch.
  const otherActive =
    !fridayActive && !!activePanelType && hasCustomPanelComponent(activePanelType);
  const OtherComp =
    otherActive && activePanelType ? getCustomPanelComponent(activePanelType) : null;

  // Nothing to show and EDITH was never opened.
  if (!activePanelType && !keepFriday) {
    return null;
  }

  return (
    <>
      {keepFriday && FridayComp && (
        // `contents` when active = wrapper is layout-transparent (EDITH fills the slot
        // exactly as before); `hidden` = display:none, kept alive but not painted.
        <div className={fridayActive ? 'contents' : 'hidden'}>
          <React.Suspense fallback={<PanelFallback className={className} />}>
            <FridayComp className={panelClass(className)} />
          </React.Suspense>
        </div>
      )}

      {OtherComp && (
        <React.Suspense fallback={<PanelFallback className={className} />}>
          <OtherComp className={panelClass(className)} />
        </React.Suspense>
      )}

      {/* Active panel exists but has no custom component (and EDITH isn't covering it). */}
      {!fridayActive &&
        activePanelType &&
        !hasCustomPanelComponent(activePanelType) && (
          <div
            className={`w-80 flex-1 min-h-0 flex items-center justify-center bg-background border-l border-border ${className ?? ''}`}
          >
            <div className="text-muted-foreground text-sm">
              Panel not available
            </div>
          </div>
        )}
    </>
  );
};
