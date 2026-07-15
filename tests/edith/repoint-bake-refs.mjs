// Repoint persisted project/version records from Downloads bake paths to the
// internal app-storage baked dir (files were physically moved there first).
import { chromium } from 'playwright-core';

const MOVED = [
  'regionspeed_1782442994145.mp4',
  'facezoom_1779943801815.mp4',
  'speed_1779963545901.mp4',
  'rackfocus_1784082217551.mp4',
];

const b = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) {
  const u = p.url();
  if (u.includes('localhost:517') && !u.startsWith('blob:')) page = p;
}
if (!page) { console.log('no page'); process.exit(1); }

const result = await page.evaluate(async (moved) => {
  const NEW_DIR = 'C:\\Users\\User\\AppData\\Roaming\\Dividr\\baked\\';
  const fixString = (s) => {
    for (const f of moved) {
      if (s.includes(f) && /[\\/]Downloads[\\/]/i.test(s)) return NEW_DIR + f;
    }
    return s;
  };
  const walk = (node) => {
    let changed = false;
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === 'string') { const nv = fixString(v); if (nv !== v) { node[i] = nv; changed = true; } }
        else if (v && typeof v === 'object') changed = walk(v) || changed;
      });
    } else {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string') { const nv = fixString(v); if (nv !== v) { node[k] = nv; changed = true; } }
        else if (v && typeof v === 'object') changed = walk(v) || changed;
      }
    }
    return changed;
  };
  const out = [];
  for (const dbName of ['DividrProjects', 'DividrVersions']) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(dbName);
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
      const keys = await new Promise((res, rej) => {
        const tx = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
        tx.onsuccess = () => res(tx.result);
        tx.onerror = () => rej(tx.error);
      }).catch(() => []);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || typeof it !== 'object') continue;
        if (walk(it)) {
          await new Promise((res, rej) => {
            const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
            const req = store.keyPath ? store.put(it) : store.put(it, keys[i]);
            req.onsuccess = res;
            req.onerror = () => rej(req.error);
          });
          out.push(`${dbName}/${storeName}: ${it.title ?? it.id ?? keys[i]}`);
        }
      }
    }
    db.close();
  }
  return out;
}, MOVED);
console.log('updated records:');
for (const r of result) console.log(' ', r);
await b.close();
