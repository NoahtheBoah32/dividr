import { chromium } from 'playwright-core';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (let i = 0; i < 30 && !page; i++) {
  for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
  if (!page) await sleep(2000);
}
if (!page) { console.log('NO PAGE'); process.exit(1); }
await sleep(4000);

// 0. New IPC handler answers
const ipc = await page.evaluate(async () => {
  const dataUrl = 'data:text/plain;base64,' + btoa('INT. GARAGE - DAY\nJOAQUIN: We start with the hook.\n');
  return await window.electronAPI.invoke('save-temp-attachment', dataUrl, 'demo script.txt');
});
check('save-temp-attachment IPC works', !!ipc?.filePath, ipc?.filePath ?? ipc?.error);
if (ipc?.filePath) {
  const saved = fs.readFileSync(ipc.filePath, 'utf8');
  check('bytes round-trip with original name kept', saved.includes('We start with the hook') && ipc.filePath.includes('demo script.txt'));
}

// 1. Open a project + the EDITH panel so the chat textarea exists
await page.evaluate(async () => await window.__dividrTest.openProjectByTitle('Untitled Project'));
await sleep(4000);
await page.evaluate(() => window.__dividrTest.openPanel('friday'));
await sleep(2500);

// 2. Simulate pasting a PDF-named text file into the chat textarea
const pasted = await page.evaluate(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const file = new File(['FADE IN:\nA quiet desk. A cursor blinks.\n'], 'shotlist.txt', { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clipboardData', { value: dt });
  ta.dispatchEvent(evt);
  await new Promise((r) => setTimeout(r, 1500));
  // chip rendered?
  const chips = [...document.querySelectorAll('span')].filter((s) => s.textContent === 'shotlist.txt');
  return { chip: chips.length > 0 };
});
check('pasted file becomes an attachment chip', pasted.chip === true, JSON.stringify(pasted));

await page.screenshot({ path: 'C:/tmp/dividr-demo-research/doc_attach.png' });
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} passed — shot: C:/tmp/dividr-demo-research/doc_attach.png`);
process.exit(passed === results.length ? 0 : 1);
