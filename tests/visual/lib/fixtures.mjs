/**
 * Test fixture generator.
 * Creates a synthetic 30-second 1920x1080 video (color bars + frame counter)
 * using ffmpeg-static. Cached after first run.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures');
const FIXTURE_PATH = join(FIXTURE_DIR, 'testsrc-30s.mp4');

function getFfmpegPath() {
  try {
    // Try ffmpeg-static from the project's node_modules
    const mod = await import('ffmpeg-static').catch(() => null);
    if (mod?.default) return mod.default;
  } catch {}
  return 'ffmpeg';
}

export function getFixturePath() {
  return FIXTURE_PATH;
}

export async function ensureFixture() {
  if (existsSync(FIXTURE_PATH)) return FIXTURE_PATH;

  mkdirSync(FIXTURE_DIR, { recursive: true });

  // Resolve ffmpeg — try ffmpeg-static first, then system ffmpeg
  let ffmpeg = 'ffmpeg';
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const staticPath = require('ffmpeg-static');
    if (staticPath && existsSync(staticPath)) ffmpeg = staticPath;
  } catch {}

  console.log(`[fixtures] generating ${FIXTURE_PATH} via ${ffmpeg} ...`);

  execSync(
    `"${ffmpeg}" -y -f lavfi -i "testsrc=duration=30:size=1920x1080:rate=30" ` +
    `-c:v libx264 -preset ultrafast -pix_fmt yuv420p "${FIXTURE_PATH}"`,
    { stdio: 'inherit', timeout: 60_000 },
  );

  console.log('[fixtures] done');
  return FIXTURE_PATH;
}
