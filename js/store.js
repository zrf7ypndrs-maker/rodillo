// Persistence: settings/imports in localStorage, rides in IndexedDB.

const LS = 'rodillo.';
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } },
};

let dbp;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('rodillo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('rides', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('rides', mode);
    const out = fn(t.objectStore('rides'));
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
