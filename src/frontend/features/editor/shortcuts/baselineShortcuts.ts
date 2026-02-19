import { BaselineShortcut } from './shortcutUtils';

export const baselineShortcuts: BaselineShortcut[] = [
  // Project
  {
    id: 'project-new',
    action: 'New Project',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+n', 'cmd+n'],
  },
  {
    id: 'project-open',
    action: 'Open Project',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+o', 'cmd+o'],
  },
  {
    id: 'project-save',
    action: 'Save Project',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+s', 'cmd+s'],
  },
  {
    id: 'project-save-as',
    action: 'Save Project As...',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+shift+s', 'cmd+shift+s'],
  },
  {
    id: 'project-import',
    action: 'Import Media',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+i', 'cmd+i'],
  },
  {
    id: 'project-export',
    action: 'Export Video',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+e', 'cmd+e'],
  },
  {
    id: 'project-close',
    action: 'Close Project',
    category: 'Project',
    scope: 'global',
    keys: ['ctrl+w', 'cmd+w'],
  },

  // Edit
  {
    id: 'undo',
    action: 'Undo last action',
    category: 'Edit',
    scope: 'global',
    keys: ['ctrl+z', 'cmd+z'],
  },
  {
    id: 'redo-shift',
    action: 'Redo last undone action',
    category: 'Edit',
    scope: 'global',
    keys: ['ctrl+shift+z', 'cmd+shift+z'],
  },
  {
    id: 'redo-y',
    action: 'Redo last undone action (alternative)',
    category: 'Edit',
    scope: 'global',
    keys: ['ctrl+y', 'cmd+y'],
  },

  // Playback
  {
    id: 'playback-toggle',
    action: 'Play/Pause',
    category: 'Playback',
    scope: 'global',
    keys: ['space'],
  },

  // Navigation
  {
    id: 'navigate-frame-prev',
    action: 'Move Playhead Backward (1 Frame)',
    category: 'Navigation',
    scope: 'global',
    keys: ['left'],
  },
  {
    id: 'navigate-frame-next',
    action: 'Move Playhead Forward (1 Frame)',
    category: 'Navigation',
    scope: 'global',
    keys: ['right'],
  },
  {
    id: 'navigate-frame-prev-fast',
    action: 'Move Playhead Backward (5 Frames)',
    category: 'Navigation',
    scope: 'global',
    keys: ['shift+left'],
  },
  {
    id: 'navigate-frame-next-fast',
    action: 'Move Playhead Forward (5 Frames)',
    category: 'Navigation',
    scope: 'global',
    keys: ['shift+right'],
  },
  {
    id: 'navigate-next-edit-point',
    action: 'Jump to Next Edit Point',
    category: 'Navigation',
    scope: 'global',
    keys: ['down'],
  },
  {
    id: 'navigate-prev-edit-point',
    action: 'Jump to Previous Edit Point',
    category: 'Navigation',
    scope: 'global',
    keys: ['up'],
  },

  // Preview (global)
  {
    id: 'preview-toggle-fullscreen',
    action: 'Toggle Fullscreen',
    category: 'Preview',
    scope: 'global',
    keys: ['f'],
  },

  // Timeline Zoom
  {
    id: 'timeline-zoom-in',
    action: 'Zoom In',
    category: 'Timeline Zoom',
    scope: 'timeline',
    keys: ['equal'],
  },
  {
    id: 'timeline-zoom-out',
    action: 'Zoom Out',
    category: 'Timeline Zoom',
    scope: 'timeline',
    keys: ['minus'],
  },
  {
    id: 'timeline-zoom-reset',
    action: 'Reset Zoom',
    category: 'Timeline Zoom',
    scope: 'timeline',
    keys: ['0'],
  },

  // Timeline Tools
  {
    id: 'timeline-toggle-snap',
    action: 'Toggle Snapping',
    category: 'Timeline Tools',
    scope: 'timeline',
    keys: ['s'],
  },
  {
    id: 'timeline-toggle-split-mode-b',
    action: 'Toggle Split Mode',
    category: 'Timeline Tools',
    scope: 'timeline',
    keys: ['b'],
  },
  {
    id: 'timeline-toggle-split-mode-c',
    action: 'Toggle Split Mode',
    category: 'Timeline Tools',
    scope: 'timeline',
    keys: ['c'],
  },
  {
    id: 'timeline-split-playhead-k',
    action: 'Split at Playhead',
    category: 'Timeline Tools',
    scope: 'timeline',
    keys: ['k', 'ctrl+k', 'cmd+k'],
  },
  {
    id: 'timeline-exit-split-mode',
    action: 'Exit Split Mode',
    category: 'Timeline Tools',
    scope: 'timeline',
    keys: ['escape'],
  },
  {
    id: 'timeline-add-marker',
    action: 'Add Marker at Playhead',
    category: 'Timeline Tools',
    scope: 'timeline',
    keys: ['shift+m'],
  },

  // Timeline Selection
  {
    id: 'timeline-select-all',
    action: 'Select All Tracks',
    category: 'Timeline Selection',
    scope: 'timeline',
    keys: ['ctrl+a', 'cmd+a'],
  },

  // Track Editing
  {
    id: 'track-slice-playhead',
    action: 'Slice at Playhead',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+b', 'cmd+b', 'k', 'ctrl+k', 'cmd+k'],
  },
  {
    id: 'track-duplicate',
    action: 'Duplicate Track',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+d', 'cmd+d'],
  },
  {
    id: 'track-copy',
    action: 'Copy Track(s)',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+c', 'cmd+c'],
  },
  {
    id: 'track-cut',
    action: 'Cut Track(s)',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+x', 'cmd+x'],
  },
  {
    id: 'track-paste',
    action: 'Paste Track(s)',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+v', 'cmd+v'],
  },
  {
    id: 'track-delete',
    action: 'Delete Selected Tracks',
    category: 'Track Editing',
    scope: 'track',
    keys: ['del', 'backspace'],
  },
  {
    id: 'track-link',
    action: 'Link Clips',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+g', 'cmd+g'],
  },
  {
    id: 'track-unlink',
    action: 'Unlink Clips',
    category: 'Track Editing',
    scope: 'track',
    keys: ['ctrl+shift+g', 'cmd+shift+g'],
  },

  // Track Properties
  {
    id: 'track-toggle-mute',
    action: 'Toggle Track Mute',
    category: 'Track Properties',
    scope: 'track',
    keys: ['m'],
  },

  // Track Selection
  {
    id: 'track-deselect',
    action: 'Deselect All Tracks',
    category: 'Track Selection',
    scope: 'track',
    keys: ['escape'],
  },

  // Tools
  {
    id: 'track-selection-tool',
    action: 'Selection Tool',
    category: 'Tools',
    scope: 'track',
    keys: ['v'],
  },
  {
    id: 'track-toggle-split-mode',
    action: 'Toggle Split Mode',
    category: 'Tools',
    scope: 'track',
    keys: ['b', 'c'],
  },

  // Preview Tools
  {
    id: 'preview-select-tool',
    action: 'Select Tool (Preview)',
    category: 'Preview Tools',
    scope: 'preview',
    keys: ['v'],
  },
  {
    id: 'preview-hand-tool',
    action: 'Hand Tool (Preview)',
    category: 'Preview Tools',
    scope: 'preview',
    keys: ['h'],
  },
  {
    id: 'preview-text-edit-tool',
    action: 'Text Edit Mode (Preview)',
    category: 'Preview Tools',
    scope: 'preview',
    keys: ['t'],
  },

  // Preview Zoom
  {
    id: 'preview-zoom-25',
    action: 'Zoom to 25%',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['shift+0'],
  },
  {
    id: 'preview-zoom-50',
    action: 'Zoom to 50%',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['shift+1'],
  },
  {
    id: 'preview-zoom-fit',
    action: 'Zoom to Fit (100%)',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['shift+f'],
  },
  {
    id: 'preview-zoom-200',
    action: 'Zoom to 200%',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['shift+2'],
  },
  {
    id: 'preview-zoom-400',
    action: 'Zoom to 400%',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['shift+3'],
  },
  {
    id: 'preview-zoom-in',
    action: 'Zoom In (Preview)',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['ctrl+equal'],
  },
  {
    id: 'preview-zoom-out',
    action: 'Zoom Out (Preview)',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['ctrl+minus'],
  },
  {
    id: 'preview-zoom-reset',
    action: 'Reset Zoom (100%)',
    category: 'Preview Zoom',
    scope: 'preview',
    keys: ['ctrl+0'],
  },

  // Hardcoded: Preview fullscreen
  {
    id: 'hardcoded-preview-exit-fullscreen',
    action: 'Exit Fullscreen',
    category: 'Preview Fullscreen',
    scope: 'preview',
    keys: ['escape'],
  },

  // Hardcoded: Preview text editing (canvas)
  {
    id: 'hardcoded-preview-text-edit-commit',
    action: 'Commit text edit',
    category: 'Preview Text Editing',
    scope: 'preview',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-preview-text-edit-cancel',
    action: 'Cancel text edit',
    category: 'Preview Text Editing',
    scope: 'preview',
    keys: ['escape'],
  },

  // Hardcoded: Preview subtitle editing (canvas)
  {
    id: 'hardcoded-preview-subtitle-edit-commit',
    action: 'Commit subtitle edit',
    category: 'Preview Subtitle Editing',
    scope: 'preview',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-preview-subtitle-edit-cancel',
    action: 'Cancel subtitle edit',
    category: 'Preview Subtitle Editing',
    scope: 'preview',
    keys: ['escape'],
  },

  // Hardcoded: Preview cleanup
  {
    id: 'hardcoded-preview-discard-empty-text',
    action: 'Discard pending empty text clip',
    category: 'Preview Cleanup',
    scope: 'preview',
    keys: ['escape'],
  },

  // Hardcoded: Projects screen
  {
    id: 'hardcoded-projects-select-all',
    action: 'Select All Projects',
    category: 'Projects',
    scope: 'projects',
    keys: ['ctrl+a', 'cmd+a'],
  },
  {
    id: 'hardcoded-projects-clear-selection',
    action: 'Clear Selection',
    category: 'Projects',
    scope: 'projects',
    keys: ['escape'],
  },
  {
    id: 'hardcoded-projects-bulk-delete',
    action: 'Bulk Delete Selected Projects',
    category: 'Projects',
    scope: 'projects',
    keys: ['del', 'backspace'],
  },

  // Hardcoded: Projects inline rename
  {
    id: 'hardcoded-projects-rename-save',
    action: 'Save rename',
    category: 'Projects Rename',
    scope: 'projects',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-projects-rename-cancel',
    action: 'Cancel rename',
    category: 'Projects Rename',
    scope: 'projects',
    keys: ['escape'],
  },

  // Hardcoded: Properties panel - Text
  {
    id: 'hardcoded-properties-text-start-edit',
    action: 'Start editing text',
    category: 'Properties - Text',
    scope: 'properties',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-properties-text-commit',
    action: 'Commit text edit',
    category: 'Properties - Text',
    scope: 'properties',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-properties-text-cancel',
    action: 'Cancel text edit',
    category: 'Properties - Text',
    scope: 'properties',
    keys: ['escape'],
  },

  // Hardcoded: Properties panel - Subtitles
  {
    id: 'hardcoded-properties-subtitle-start-edit',
    action: 'Start editing subtitle',
    category: 'Properties - Subtitles',
    scope: 'properties',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-properties-subtitle-commit',
    action: 'Commit subtitle edit',
    category: 'Properties - Subtitles',
    scope: 'properties',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-properties-subtitle-cancel',
    action: 'Cancel subtitle edit',
    category: 'Properties - Subtitles',
    scope: 'properties',
    keys: ['escape'],
  },

  // Hardcoded: Properties panel - Audio
  {
    id: 'hardcoded-properties-audio-commit',
    action: 'Commit volume input',
    category: 'Properties - Audio',
    scope: 'properties',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-properties-audio-cancel',
    action: 'Cancel/revert volume input',
    category: 'Properties - Audio',
    scope: 'properties',
    keys: ['escape'],
  },

  // Hardcoded: Numeric input (shared)
  {
    id: 'hardcoded-numeric-commit',
    action: 'Commit value',
    category: 'Inputs',
    scope: 'input',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-numeric-revert',
    action: 'Revert value',
    category: 'Inputs',
    scope: 'input',
    keys: ['escape'],
  },
  {
    id: 'hardcoded-numeric-increment',
    action: 'Increment value',
    category: 'Inputs',
    scope: 'input',
    keys: ['up'],
  },
  {
    id: 'hardcoded-numeric-decrement',
    action: 'Decrement value',
    category: 'Inputs',
    scope: 'input',
    keys: ['down'],
  },
  {
    id: 'hardcoded-numeric-increment-fast',
    action: 'Increment value x10',
    category: 'Inputs',
    scope: 'input',
    keys: ['shift+up'],
  },
  {
    id: 'hardcoded-numeric-decrement-fast',
    action: 'Decrement value x10',
    category: 'Inputs',
    scope: 'input',
    keys: ['shift+down'],
  },
  {
    id: 'hardcoded-numeric-increment-fine',
    action: 'Increment value x0.1',
    category: 'Inputs',
    scope: 'input',
    keys: ['alt+up'],
  },
  {
    id: 'hardcoded-numeric-decrement-fine',
    action: 'Decrement value x0.1',
    category: 'Inputs',
    scope: 'input',
    keys: ['alt+down'],
  },

  // Hardcoded: Captions panel
  {
    id: 'hardcoded-captions-save',
    action: 'Save subtitle edit',
    category: 'Captions',
    scope: 'captions',
    keys: ['enter'],
  },
  {
    id: 'hardcoded-captions-cancel',
    action: 'Cancel subtitle edit',
    category: 'Captions',
    scope: 'captions',
    keys: ['escape'],
  },
];
