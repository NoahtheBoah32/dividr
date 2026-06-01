import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * Mobile web build. Reuses the desktop renderer source under ../src by aliasing:
 *   @         -> ../src        (matches the frontend's own "@/..." imports)
 *   @app      -> ../src        (App.tsx etc.)
 *   @frontend -> ../src/frontend
 *
 * Native-only modules are externalized exactly as the desktop renderer config
 * does — the shared UI never executes them directly; they sit behind the bridge.
 */
const DESKTOP_SRC = path.resolve(__dirname, '../src');

export default defineConfig(({ mode }) => ({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@': DESKTOP_SRC,
      '@app': DESKTOP_SRC,
      '@frontend': path.join(DESKTOP_SRC, 'frontend'),
    },
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    exclude: ['ffmpeg-static', 'ffprobe-static', 'child_process', 'electron'],
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: ['ffmpeg-static', 'ffprobe-static', 'child_process', 'electron'],
    },
  },
  css: {
    postcss: {
      plugins: [require('tailwindcss'), require('autoprefixer')],
    },
  },
  server: {
    host: true, // expose on LAN so a phone can reach the dev server
    port: 5180,
  },
  esbuild: {
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
}));
