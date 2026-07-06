import { createWriteStream, existsSync, statSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Pre-warm the DeepFilterNet speech-enhancement binary so the first "isolate
// voice" doesn't stall on a ~27MB download. voice_separate.py self-downloads the
// same binary as a fallback, so a failure here is non-fatal. Windows-only
// (matching the dev environment); other platforms install DeepFilterNet
// separately.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== 'win32') {
  process.exit(0);
}

// Next to the python script (extraResource'd into the packaged app), resolved by
// voice_separate.py via __file__.
const DEST = path.join(
  __dirname, '..', 'src', 'backend', 'python', 'scripts', 'deep-filter.exe',
);
const URL =
  'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/' +
  'deep-filter-0.5.6-x86_64-pc-windows-msvc.exe';

if (existsSync(DEST)) {
  console.log('[DeepFilter] Binary already exists at', DEST);
  process.exit(0);
}

try {
  console.log('[DeepFilter] Downloading deep-filter.exe (~27MB)...');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  const tmp = DEST + '.part';
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

  if (statSync(tmp).size < 5_000_000) {
    unlinkSync(tmp);
    throw new Error('download incomplete');
  }
  renameSync(tmp, DEST);
  console.log('\n[DeepFilter] Binary saved to', DEST);
} catch (err) {
  console.warn('[DeepFilter] Pre-fetch skipped:', err?.message ?? err);
  process.exit(0);
}
