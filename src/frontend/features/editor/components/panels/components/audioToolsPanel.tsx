import React from 'react';
import { BasePanel } from '../../../components/panels/basePanel';
import { CustomPanelProps } from '../../../components/panels/panelRegistry';
import { SfxLibrarySection } from './SfxLibrarySection';

export const AudioToolsPanel: React.FC<CustomPanelProps> = ({ className }) => {
  return (
    <BasePanel
      title="Audio Tools"
      description="Edit and enhance audio tracks"
      className={className}
    >
      <div className="space-y-4">
        <SfxLibrarySection />
        <div className="text-center text-muted-foreground border-t border-neutral-800 pt-3">
          <p className="text-xs">More audio tools coming soon.</p>
        </div>
      </div>
    </BasePanel>
  );
};
