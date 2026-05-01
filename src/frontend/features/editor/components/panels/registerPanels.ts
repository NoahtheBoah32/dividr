// This file registers all custom panel components
import { AudioToolsPanel } from './components/audioToolsPanel';
import { CaptionsPanel } from './components/captionsPanel';
import { ImageToolsPanel } from './components/imageToolsPanel';
import { MediaImportPanel } from './components/mediaImportPanel';
import { SettingsPanel } from './components/settingsPanel';
import { TextToolsPanel } from './components/textToolsPanel';
import { VideoEffectsPanel } from './components/videoEffectsPanel';
import { FridayPanel } from '@/frontend/features/mycelium/FridayPanel';
import { initStoreAdapter } from '@/frontend/features/mycelium/storeAdapter';
import { registerPanelComponent } from './panelRegistry';
import { ReferencesPanel } from './components/referencesPanel';

// Register all panel components
export const initializePanelRegistry = () => {
  registerPanelComponent('media-import', MediaImportPanel);
  registerPanelComponent('text-tools', TextToolsPanel);
  registerPanelComponent('video-effects', VideoEffectsPanel);
  registerPanelComponent('images', ImageToolsPanel);
  registerPanelComponent('audio-tools', AudioToolsPanel);
  registerPanelComponent('settings', SettingsPanel);
  registerPanelComponent('captions', CaptionsPanel);
  registerPanelComponent('friday', FridayPanel);
  registerPanelComponent('references', ReferencesPanel);
  // Wire OperationEngine to Dividr's store
  initStoreAdapter();
};
