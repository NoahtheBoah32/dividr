// Scan all persisted projects (IndexedDB) for references to bake files
// (rackfocus_/facezoom_/speed_/reverse_/regionspeed_/skeleton_/mfreeze_).
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no page'); process.exit(1); }

const refs = await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  const out = { dbs: dbs.map((d) => d.name), refs: [] };
  const RE = /(?:rackfocus|facezoom|speed|reverse|regionspeed|skeleton|mfreeze)_\d+\.(?:mp4|mov|mkv)/g;
  for (const dbi of dbs) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(dbi.name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(() => null);
    if (!db) continue;
    for (const storeName of Array.from(db.objectStoreNames)) {
      const items = await new Promise((res, rej) => {
        const tx = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        tx.onsuccess = () => res(tx.result);
        tx.onerror = () => rej(tx.error);
      }).catch(() => []);
      for (const it of items) {
        let s = '';
        try { s = JSON.stringify(it); } catch { continue; }
        const m = s.match(RE);
        if (m) {
          out.refs.push({
            db: dbi.name,
            store: storeName,
            title: it?.title ?? it?.name ?? it?.id ?? '?',
            files: [...new Set(m)],
          });
        }
      }
    }
    db.close();
  }
  return out;
});
console.log(JSON.stringify(refs, null, 1));
await b.close();
