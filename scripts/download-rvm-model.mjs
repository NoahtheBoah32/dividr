import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(__dirname, '..', 'public', 'rvm_mobilenetv3_fp32.onnx');
const URL = 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx';

if (existsSync(DEST)) {
  console.log('[RVM] Model already exists at', DEST);
  process.exit(0);
}

console.log('[RVM] Downloading rvm_mobilenetv3_fp32.onnx (~14MB)...');
const res = await fetch(URL);
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

const total = Number(res.headers.get('content-length') || 0);
let received = 0;

const reader = res.body.getReader();
const out = createWriteStream(DEST);

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  out.write(value);
  received += value.length;
  if (total) process.stdout.write(`\r  ${Math.round(received / total * 100)}%`);
}

await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
console.log('\n[RVM] Model saved to', DEST);
