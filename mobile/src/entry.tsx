/**
 * Mobile entry point. Mirrors ../../src/renderer.tsx but:
 *   1. installs the browser bridge (window.electronAPI / myceliumAPI / appControl)
 *      BEFORE the shared App imports run, and
 *   2. registers the service worker for PWA installability.
 *
 * The App and all UI come from ../../src unchanged — same UI as desktop.
 */
import { installBridge } from './bridge/install';

// Must run before the shared frontend touches window.electronAPI.
installBridge();

import React from 'react';
import { createRoot } from 'react-dom/client';
// Reused verbatim from the desktop app via Vite aliases (see vite.config.ts).
import App from '@app/App';
import '@frontend/styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker (offline shell + installability).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW is best-effort; app still works without it */
    });
  });
}
