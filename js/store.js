// @ts-check
// Persistence: settings/imports in localStorage, rides in IndexedDB.

/** @typedef {import('./types.js').LocalRide} LocalRide */
/** @typedef {import('./types.js').RideDoc} RideDoc */

const LS = 'rodillo.';
export const ls = {
  /** @param {string} k Key without the `rodillo.` prefix. @param {any} [d] Returned when missing or unreadable. */
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  /** @param {string} k @param {any} v Stored as JSON. */
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
  /** @param {LocalRide} ride */
  put: (ride) => tx('readwrite', (s) => s.put(ride)),
  /** @param {number} id @returns {Promise<LocalRide | undefined>} */
  get: (id) => tx('readonly', (s) => s.get(id)),
  /** @param {number} id */
  del: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
  /** This device's recordings without their samples, newest first. @returns {Promise<LocalRide[]>} */
  async list() {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).map(({ samples, ...meta }) => meta).sort((a, b) => b.id - a.id);
  },
};

// Ride documents from rodillo-data, keyed by ride id ("2026-11-10T1832"). Keeps the newest DOC_KEEP opened.
const DOC_KEEP = 40;
export const docs = {
  /** @param {string} id @returns {Promise<RideDoc | null>} */
  get: (id) => tx('readonly', (s) => s.get(id), 'docs').then((r) => r?.doc || null),
  clear: () => tx('readwrite', (s) => s.clear(), 'docs'),
  /** @param {string} id */
  del: (id) => tx('readwrite', (s) => s.delete(id), 'docs'),
  /** @param {string} id @param {RideDoc} doc */
  async put(id, doc) {
    await tx('readwrite', (s) => s.put({ id, doc, at: Date.now() }), 'docs');
    const keys = await tx('readonly', (s) => s.getAllKeys(), 'docs');
    if (keys.length <= DOC_KEEP) return;
    const all = await tx('readonly', (s) => s.getAll(), 'docs');
    const old = all.sort((a, b) => b.at - a.at).slice(DOC_KEEP).map((r) => r.id);
    await tx('readwrite', (s) => old.forEach((k) => s.delete(k)), 'docs');
  },
};
