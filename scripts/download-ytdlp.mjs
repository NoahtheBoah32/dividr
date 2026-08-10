import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Bundle yt-dlp with the app so sourcing works on a machine that has never
// installed it. Downlodr's whole "no setup" trick is shipping this one binary;
// DiviDr used to go hunting for a copy on the user's PC and give up.
//
// The app self-heals at runtime too (ensureYtdlp in main.ts re-downloads into
// userData when this copy goes stale), so a failure here is non-fatal — it just
// means the first b-roll on a fresh install waits ~18MB for the download.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASSET = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp_linux',
}[process.platform];

if (!ASSET) {
  console.log('[yt-dlp] Unsupported platform, skipping');
  process.exit(0);
}

// extraResource'd into the packaged app; resolved at runtime from resourcesPath.
const DEST_DIR = path.join(__dirname, '..', 'ytdlp-bin');
const DEST = path.join(DEST_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;

// yt-dlp rots fast — YouTube keeps changing and yt-dlp ships fixes every week or
// two. Re-pull at build time if the bundled copy is over a fortnight old.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

if (existsSync(DEST)) {
  const ageMs = Date.now() - statSync(DEST).mtimeMs;
  if (ageMs < MAX_AGE_MS) {
    console.log(`[yt-dlp] Bundled binary is ${Math.floor(ageMs / 86_400_000)}d old, keeping it`);
    process.exit(0);
  }
  console.log('[yt-dlp] Bundled binary is stale, refreshing...');
}

try {
  mkdirSync(DEST_DIR, { recursive: true });
  console.log('[yt-dlp] Downloading yt-dlp (~18MB)...');
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  const tmp = `${DEST}.part`;
  const reader = res.body.getReader();
  const out = createWriteStream(tmp);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value);
    received += value.length;
    if (total) process.stdout.write(`\r  ${Math.round((received / total) * 100)}%`);
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  // A truncated exe is worse than none — it would spawn and fail cryptically.
  if (statSync(tmp).size < 10_000_000) {
    unlinkSync(tmp);
    throw new Error('download incomplete');
  }
  renameSync(tmp, DEST);
  console.log('\n[yt-dlp] Saved to', DEST);
} catch (err) {
  console.warn('[yt-dlp] Pre-fetch skipped:', err?.message ?? err);
  process.exit(0);
}
