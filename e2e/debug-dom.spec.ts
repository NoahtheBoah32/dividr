import { test } from '@playwright/test';

test('dump editor DOM after creating project', async ({ page }) => {
  await page.addInitScript(() => {
    const noop = () => Promise.resolve(null);
    const noopSync = () => null;
    (window as Record<string, unknown>).electronAPI = {
      getProjects: () => Promise.resolve([]),
      getProject: noop, saveProject: noop, deleteProject: noop,
      openFile: noop, importMedia: noop, downloadFromUrl: noop,
      transcodeVideo: noop, getVideoMetadata: noop,
      openSaveDialog: noop, openDirectory: noop,
      on: noopSync, off: noopSync, send: noopSync, invoke: noop,
      ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '/usr/bin/ffprobe',
      platform: 'win32',
    };
  });

  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Click create project
  const createBtn = page.getByText(/create.*first project/i);
  console.log('\nCreate button visible:', await createBtn.isVisible());
  await createBtn.click();

  // Wait for editor to load
  await page.waitForURL('**/video-editor**', { timeout: 15_000 });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'e2e/editor-screenshot.png', fullPage: true });

  // Dump all tabs
  const tabs = await page.getByRole('tab').all();
  console.log('\n=== TABS ===');
  for (const tab of tabs) {
    console.log(' -', JSON.stringify(await tab.textContent()));
  }

  // Dump buttons with "style" text
  console.log('\n=== STYLE-RELATED ELEMENTS ===');
  const styleBtns = await page.locator('[role="tab"], button').filter({ hasText: /style/i }).all();
  for (const b of styleBtns) {
    console.log(' -', JSON.stringify(await b.textContent()), '| class:', (await b.getAttribute('class'))?.slice(0, 80));
  }

  // Dump inset-0 elements
  console.log('\n=== INSET-0 ELEMENTS ===');
  const insetEls = await page.locator('.inset-0').all();
  for (const el of insetEls) {
    console.log(' -', (await el.getAttribute('class'))?.slice(0, 100));
  }
});
