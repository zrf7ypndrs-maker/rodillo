// @ts-check
// Settings shared by every device through the plan in rodillo-data (coach/plan.json).
// FTP stays top-level (plan.ftp + plan.ftpSetAt) because the morning coach reads and writes it there.
// Every other setting: plan.settings[key] + plan.settingsSetAt[key]. Newest timestamp wins, per key.

// Used once per device, for values it had before syncing existed: any real change made later wins over it.
export const SEED_AT = '2000-01-01T00:00:00.000Z';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @typedef {import('./types.js').Plan} Plan */
/** @typedef {{ v: any, at: string | null }} Stamped A value and when it was set (null = never). */

/** @param {Plan | null} p @param {string} k @returns {Stamped | null} */
export function planGet(p, k) {
  if (k === 'ftp') return p?.ftp != null ? { v: p.ftp, at: p.ftpSetAt || null } : null;
  return p?.settings && k in p.settings ? { v: p.settings[k], at: p.settingsSetAt?.[k] || null } : null;
}

/** @param {Plan} p @param {string} k @param {any} v @param {string} at @param {string | null} [source] */
export function planSet(p, k, v, at, source) {
  if (k === 'ftp') { p.ftp = v; p.ftpSetAt = at; if (source) p.ftpSource = source; return; }
  (p.settings ||= {})[k] = v;
  (p.settingsSetAt ||= {})[k] = at;
}

/** @typedef {{ settings: Record<string, any>, base: Record<string, Stamped>, pending: Record<string, Stamped & { source?: string }>, adopted: string[], first: boolean, defaults: Record<string, any>, now: string, source: string }} Merge reconcile's working copies. */

/** Step 1's reasons to leave key k alone. @param {Stamped | null} r @param {string} k @param {Merge} m */
function keepOurs(r, k, m) {
  const { base, pending, settings, defaults, first } = m;
  if (!r || r.at == null && k === 'ftp' && !first) return true;
  if (base[k] && base[k].at === r.at && r.at != null) return true; // nothing new
  if (pending[k] && pending[k].at > (r.at || '')) return true;     // our change is newer
  if (first && r.at == null && !same(settings[k], defaults[k]) && !same(settings[k], r.v)) return true; // untimed plan FTP vs a value set here: seed ours
  return false;
}

/** 1. take newer values from the plan @param {Plan} plan @param {Merge} m */
function takeFromPlan(plan, m) {
  const { settings, base, pending, adopted } = m;
  for (const k of new Set([...Object.keys(plan.settings || {}), 'ftp'])) {
    const r = planGet(plan, k);
    if (keepOurs(r, k, m)) continue;
    delete pending[k];
    if (!same(settings[k], r.v)) { settings[k] = r.v; adopted.push(k); }
    base[k] = { v: r.v, at: r.at };
  }
}

/** 2. anything that differs from what we last agreed on is a local change @param {Merge} m */
function noteLocalChanges(m) {
  const { settings, base, pending, defaults, first, now, source } = m;
  for (const [k, v] of Object.entries(settings)) {
    if (base[k] && same(base[k].v, v)) { if (pending[k] && same(pending[k].v, v)) delete pending[k]; continue; }
    if (pending[k] && same(pending[k].v, v)) continue;
    if (first && !base[k]) {
      if (same(v, defaults[k])) { base[k] = { v, at: null }; continue; } // untouched default: nothing to share
      pending[k] = { v, at: SEED_AT, source: 'seed' };
      continue;
    }
    pending[k] = { v, at: now, source };
  }
}

/**
 * Merges the plan's settings with this device's.
 * base: { key: { v, at } } = the value each key had when this device last agreed with the plan (null on first run).
 * pending: { key: { v, at, source } } = local changes not yet written to the plan.
 * Returns new copies plus the keys adopted from the plan.
 * @param {{ plan: Plan | null, settings: Record<string, any>, base: Record<string, Stamped> | null, pending?: Record<string, Stamped & { source?: string }>, defaults?: Record<string, any>, now?: string, source?: string }} o
 */
export function reconcile({ plan, settings, base, pending = {}, defaults = {}, now = new Date().toISOString(), source = 'settings' }) {
  /** @type {Merge} */
  const m = { settings: { ...settings }, base: { ...(base || {}) }, pending: { ...pending }, adopted: [], first: !base, defaults, now, source };
  if (plan) takeFromPlan(plan, m);
  noteLocalChanges(m);
  return { settings: m.settings, base: m.base, pending: m.pending, adopted: m.adopted };
}

/** Writes pending changes into plan (in place) unless the plan has a newer value. Returns the keys written.
 * @param {Plan} plan @param {Record<string, Stamped & { source?: string }>} pending @returns {string[]} */
export function applyPending(plan, pending) {
  const written = [];
  for (const [k, x] of Object.entries(pending)) {
    const r = planGet(plan, k);
    if (r?.at && r.at > x.at) continue;
    planSet(plan, k, x.v, x.at, k === 'ftp' && x.source !== 'seed' ? x.source : null);
    written.push(k);
  }
  return written;
}
