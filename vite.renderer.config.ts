import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    // Boot speed: pre-transform the renderer's whole static module graph the moment the
    // Vite dev server starts (which happens while electron-forge is still launching
    // Electron), instead of waiting for the browser to discover and request ~400 modules
    // one waterfall level at a time after the window loads. Warming the entry crawls its
    // static imports via preTransformRequests, so by the time the Electron window loads,
    // the modules are already transformed and served from cache — collapsing the boot's
    // dominant renderer-load phase. Dev-only; no effect on production builds.
    warmup: {
      clientFiles: ['./src/renderer.tsx'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    exclude: ['ffmpeg-static', 'ffprobe-static', 'child_process', 'onnxruntime-web'],
  },
  build: {
    rollupOptions: {
      external: ['ffmpeg-static', 'ffprobe-static', 'child_process'],
    },
  },
  css: {
    postcss: {
      plugins: [require('tailwindcss'), require('autoprefixer')],
    },
  },
  esbuild: {
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
}));
