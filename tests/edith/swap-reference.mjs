import { chromium } from 'playwright-core';

const REF = 'C:/tmp/dividr-demo-research/ref_dylan_min1.mp4';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().includes('localhost:5173')) page = p;
if (!page) { console.log('NO PAGE'); process.exit(1); }

const res = await page.evaluate(async (refPath) => {
  const st = () => window.__videoEditorStore.getState();
  const old = st().mediaLibrary.filter((m) => m.category === 'reference');
  for (const m of old) { try { st().removeFromMediaLibrary(m.id); } catch (e) {} }
  const name = refPath.split('/').pop();
  let duration = 75;
  try { duration = await window.electronAPI.getDuration(refPath); } catch {}
  let metadata = {};
  try { const d = await window.electronAPI.getVideoDimensions(refPath); if (d?.width) metadata = { width: d.width, height: d.height }; } catch {}
  let previewUrl = refPath;
  try {
    const r = await window.electronAPI.createPreviewUrl(refPath);
    previewUrl = (r && typeof r === 'object' && r.url) ? r.url : (typeof r === 'string' ? r : refPath);
  } catch {}
  const refId = st().addToMediaLibrary({
    name, type: 'video', source: refPath, tempFilePath: refPath, previewUrl,
    duration, size: 0, mimeType: 'video/mp4', metadata, spriteSheetDisabled: false,
  });
  st().updateMediaLibraryItem(refId, { category: 'reference' });
  return { removed: old.map((m) => m.name), refId, lib: st().mediaLibrary.map((m) => ({ name: m.name, cat: m.category })) };
}, REF);
console.log(JSON.stringify(res, null, 1));
process.exit(0);
