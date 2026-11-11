// Persistence: settings/imports in localStorage, rides in IndexedDB.

const LS = 'rodillo.';
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } },
};

// v1: rides (this device's recordings). v2 adds docs: ride files fetched from rodillo-data for the ride page.
let dbp;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('rodillo', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('rides')) d.createObjectStore('rides', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn, store = 'rides') {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
export const rides = {
  put: (ride) => tx('readwrite', (s) => s.put(ride)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
  async list() {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).map(({ samples, ...meta }) => meta).sort((a, b) => b.id - a.id);
  },
};

// Ride documents from rodillo-data, keyed by ride id ("2026-11-10T1832"). Keeps the newest DOC_KEEP opened.
const DOC_KEEP = 40;
export const docs = {
  get: (id) => tx('readonly', (s) => s.get(id), 'docs').then((r) => r?.doc || null),
  async put(id, doc) {
    await tx('readwrite', (s) => s.put({ id, doc, at: Date.now() }), 'docs');
    const keys = await tx('readonly', (s) => s.getAllKeys(), 'docs');
    if (keys.length <= DOC_KEEP) return;
    const all = await tx('readonly', (s) => s.getAll(), 'docs');
    const old = all.sort((a, b) => b.at - a.at).slice(DOC_KEEP).map((r) => r.id);
    await tx('readwrite', (s) => old.forEach((k) => s.delete(k)), 'docs');
  },
};
