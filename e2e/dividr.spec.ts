/**
 * Dividr renderer tests — runs against the Vite dev server in a real Chromium browser.
 * window.electronAPI is mocked so no Electron binary is needed.
 * GEMINI is never called — no ops are dispatched in these tests.
 */

import { test, expect, Page } from '@playwright/test';

// Inject a minimal window.electronAPI mock before each test so the React app
// doesn't crash trying to call Electron IPC handlers.
async function mockElectronAPI(page: Page) {
  await page.addInitScript(() => {
    const noop = () => Promise.resolve(null);
    const noopSync = () => null;

    (window as Record<string, unknown>).electronAPI = {
      // IPC calls used by stores / hooks on mount
      getProjects: () => Promise.resolve([]),
      getProject: noop,
      saveProject: noop,
      deleteProject: noop,
      openFile: noop,
      importMedia: noop,
      downloadFromUrl: noop,
      transcodeVideo: noop,
      getVideoMetadata: noop,
      openSaveDialog: noop,
      openDirectory: noop,
      on: noopSync,
      off: noopSync,
      send: noopSync,
      invoke: noop,
      // ffmpeg/probe stubs
      ffmpegPath: '/usr/bin/ffmpeg',
      ffprobePath: '/usr/bin/ffprobe',
      // misc
      platform: 'win32',
    };
  });
}

// Navigate to the app and wait for React root to hydrate
async function gotoApp(page: Page) {
  await mockElectronAPI(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Give React time to hydrate and Zustand to rehydrate from localStorage
  await page.waitForTimeout(3000);
}

// -----------------------------------------------------------------------

test.describe('App shell', () => {
  test('renders #root without crashing', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('#root')).toBeAttached();
  });

  test('no uncaught JS exceptions on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await gotoApp(page);
    await page.waitForTimeout(500);
    const fatal = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('favicon') &&
        !e.includes('non-passive'),
    );
    expect(fatal).toHaveLength(0);
  });
});

test.describe('Captions panel — Styles tab', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('Styles tab renders in the captions sidebar', async ({ page }) => {
    // The styles tab lives inside the captions panel; look for it by text content
    const stylesTab = page.getByRole('tab', { name: /styles/i });
    await expect(stylesTab).toBeVisible({ timeout: 15_000 });
  });

  test('Mycelium and Hormozi are pre-seeded after clicking Styles tab', async ({
    page,
  }) => {
    const stylesTab = page.getByRole('tab', { name: /styles/i });
    await stylesTab.click();

    await expect(page.getByText('Mycelium')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('Hormozi')).toBeVisible({ timeout: 8_000 });
  });
});

test.describe('EdithLiveTracker overlay', () => {
  test('tracker wrapper is present in the DOM', async ({ page }) => {
    await gotoApp(page);
    // EdithLiveTracker mounts a fixed overlay container that's always in the DOM,
    // even when idle. It has pointer-events: none and aria-hidden="true".
    const tracker = page.locator('[aria-hidden="true"]').first();
    await expect(tracker).toBeAttached({ timeout: 10_000 });
  });
});

test.describe('Remotion hidden engine', () => {
  test('RemotionPreview wrapper is mounted with opacity-0', async ({ page }) => {
    await gotoApp(page);
    // RemotionPreview renders with className="absolute inset-0 pointer-events-none opacity-0"
    const wrapper = page.locator('.opacity-0.pointer-events-none.absolute');
    await expect(wrapper).toBeAttached({ timeout: 10_000 });
  });
});
