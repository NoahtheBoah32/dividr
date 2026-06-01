# Dividr Mobile

A **mobile (phone) version of Dividr that reuses the exact same UI** as the desktop app — same React components, same timeline, same panels. Nothing in this folder modifies the desktop app under `../src`.

## Why this exists

Desktop Dividr is an Electron app. The renderer (`../src/frontend`) is plain React, but it talks to the machine through Electron's preload bridge:

- `window.electronAPI.invoke(channel, ...args)` — request/response (FFmpeg export, transcription, file I/O, etc.)
- `window.electronAPI.on(channel, listener)` — streaming events (FFmpeg progress, transcode progress, agent ops…)
- `window.myceliumAPI.*` — the FRIDAY/ARTHUR/EDITH agent
- `window.appControl.*` — desktop window controls

A phone has no Electron main process and can't run FFmpeg / Python / the Claude CLI locally. So this build does two things:

1. **Reuses the renderer unchanged.** `vite.config.ts` aliases `@frontend` → `../src/frontend`, so the same components render in a mobile browser. The UI is identical.
2. **Replaces the bridge, not the UI.** `src/bridge/` re-implements `window.electronAPI`, `window.myceliumAPI`, and `window.appControl` with the *same method signatures* (mirrored from `../src/preload.ts`), but routes every call to a backend **server** over HTTP + WebSocket instead of Electron IPC.

The server (`server/`) wraps the existing `../src/backend` code and runs the heavy work (FFmpeg, Whisper, motion analysis, the agent) on a real machine. The phone is a thin client driving it.

```
 Phone browser (PWA, installable)
   same React UI (../src/frontend)
   + bridge shims (window.electronAPI / myceliumAPI / appControl)
        │  HTTP  POST /api/invoke   (request/response channels)
        │  WS    /events            (on(...) streaming channels)
        ▼
 Server (Node) — server/
   dispatches channel → handler → ../src/backend (FFmpeg / Whisper / media-tools / mycelium agent)
```

## Status — honest

This is a **working foundation**, not a finished product. What's here:

- ✅ PWA shell: installable on iOS/Android home screen (`public/manifest.webmanifest`, service worker).
- ✅ Full bridge surface: every `electronAPI` / `myceliumAPI` / `appControl` method from `../src/preload.ts` is shimmed with matching signatures.
- ✅ Transport: HTTP `invoke` + WebSocket event stream, so `on(channel, cb)` works.
- ✅ Server skeleton: generic channel-dispatch router + WS event hub + handler registry.
- ✅ UI reuse via Vite alias — no fork of the frontend.

What still needs real work before it runs end-to-end (these need a hosted machine, not this container):

- ⚠️ **Hosting.** The server must run on an actual computer/VM with FFmpeg + Python installed. A phone alone can't do the encoding.
- ⚠️ **Backend electron-decoupling.** Some `../src/backend` modules import Electron (`app`, `dialog`, paths). Handlers wrap the electron-free pieces directly; the rest need small refactors to take plain paths/config (marked `TODO(decouple)` in `server/src/handlers/`).
- ⚠️ **File transfer model.** Desktop passes local file paths. On mobile, media must be uploaded to the server (multipart) and referenced by server-side path. Upload endpoint stub is in `server/src/handlers/files.ts`.
- ⚠️ **Privacy tradeoff.** Footage now leaves the phone and lives on the server. Document this for users.

## Run (once the server is hosted)

```bash
# 1. Server (on a machine with FFmpeg + Python from ../requirements.txt)
cd server && npm install && npm run dev      # serves on :8787

# 2. Mobile web client (point it at the server)
cd .. && npm install
VITE_DIVIDR_SERVER=http://<server-host>:8787 npm run dev   # Vite on :5180
```

Open the Vite URL on your phone (same network, or deploy behind HTTPS), then "Add to Home Screen" to install the PWA.

## Layout

```
mobile/
  index.html                 PWA entry, mounts the shared App
  vite.config.ts             aliases @frontend → ../src/frontend
  package.json               client deps (react shared via alias)
  public/
    manifest.webmanifest     installable PWA metadata (9:16 mobile)
    sw.js                    service worker (offline shell)
  src/
    entry.tsx                installs bridge shims + SW, then renders App
    bridge/
      transport.ts           HTTP invoke + WS event client
      electronAPI.ts         window.electronAPI shim (mirrors preload.ts)
      myceliumAPI.ts         window.myceliumAPI shim (agent)
      appControl.ts          window.appControl shim (no-ops/web equivalents)
      install.ts             attaches the three globals to window
  server/
    package.json
    src/
      index.ts               express + ws server
      invokeRouter.ts        POST /api/invoke → handler dispatch
      events.ts              WS hub → emit(channel, payload) to clients
      handlers/
        index.ts             channel → handler registry
        ffmpeg.ts            export / duration / progress (reuses ../src/backend/ffmpeg)
        whisper.ts           transcription (reuses python scripts)
        mediaTools.ts        noise reduction
        mycelium.ts          FRIDAY/ARTHUR/EDITH agent runtime
        files.ts             upload / preview-url / file I/O
        stubs.ts             not-yet-ported channels (explicit errors)
```
