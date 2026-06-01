/**
 * Browser implementation of `window.appControl`.
 *
 * These are desktop window/OS features (minimize, maximize, titlebar overlay,
 * clipboard monitoring, auto-launch, .dividr file association). On a phone they
 * are either no-ops or map to web equivalents, so the shared UI's calls don't
 * throw. Signatures mirror ../../../src/preload.ts.
 */
type AnyFn = (...args: unknown[]) => void;

const noop = () => undefined;
const resolved = <T>(v: T) => () => Promise.resolve(v);

export const appControl = {
  // Window controls — meaningless on mobile; resolve harmlessly.
  showWindow: resolved(undefined),
  hideWindow: resolved(undefined),
  setAutoLaunch: (_enabled: boolean) => Promise.resolve(undefined),
  quitApp: noop,
  minimizeApp: noop,
  maximizeApp: noop,
  getAutoLaunch: resolved(false),
  getMaximizeState: resolved(true), // mobile is effectively always "maximized"
  setTitlebarOverlay: (_options: unknown) => Promise.resolve(undefined),
  setWindowFullscreen: (isFullscreen: boolean) => {
    // Map to the Fullscreen API where available.
    if (isFullscreen) document.documentElement.requestFullscreen?.().catch(noop);
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(noop);
    return Promise.resolve(undefined);
  },
  onMaximizeChanged: (_cb: (isMaximized: boolean) => void) => undefined,
  offMaximizeChanged: noop,

  // Clipboard — use the async Clipboard API instead of OS monitoring.
  getClipboardText: () => navigator.clipboard?.readText?.().catch(() => '') ?? Promise.resolve(''),
  onClipboardChange: (_cb: (text: string) => void) => undefined, // no background monitoring on web
  offClipboardChange: noop,
  startClipboardMonitoring: resolved(undefined),
  stopClipboardMonitoring: resolved(undefined),
  isClipboardMonitoringActive: resolved(false),
  isWindowFocused: () => Promise.resolve(document.hasFocus()),
  clearLastClipboardText: resolved(undefined),
  clearClipboard: () => navigator.clipboard?.writeText?.('').catch(noop) ?? Promise.resolve(undefined),

  // .dividr file association — N/A on mobile.
  onOpenProjectFile: (_cb: (filePath: string) => void) => undefined,
  offOpenProjectFile: noop,
} satisfies Record<string, AnyFn | unknown>;

export type AppControl = typeof appControl;
