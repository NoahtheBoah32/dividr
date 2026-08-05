/**
 * Entry point for the UI and App.tsx.
 * This file is responsible for rendering the main App component
 * into the DOM.
 *
 * STARTUP OPTIMIZATION:
 * - Loader is already in index.html (shows immediately)
 * - React will replace the loader when App mounts
 * - Tracks performance metrics
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './frontend/styles/index.css';
import { startupManager } from './frontend/utils/startupManager';
import { initTestBridge } from './frontend/features/mycelium/testBridge';

// Log renderer mount start
startupManager.logStage('renderer-mount');

// Register visual test bridge (DEV only — no-op in production)
initTestBridge();

// Live-transcription pre-warm: if the recorder toggle was left on, load the
// whisper model now — not when the user finally reaches the recorder. Delayed
// so app startup gets the disk and CPU first.
setTimeout(() => {
  try {
    if (localStorage.getItem('recorder-live-transcribe') === '1') {
      (window as any).electronAPI?.invoke?.('recorder:liveTranscribe:warm')?.catch?.(() => {});
    }
  } catch { /* no bridge (web preview) — recorder warms on open instead */ }
}, 3000);

// Get root container (already exists from index.html)
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

// Create root and render (React will replace the loader)
const root = createRoot(container);

// Render immediately - App component will handle removing the loader
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
