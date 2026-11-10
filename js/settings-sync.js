// Settings shared by every device through the plan in rodillo-data (coach/plan.json).
// FTP stays top-level (plan.ftp + plan.ftpSetAt) because the morning coach reads and writes it there.
// Every other setting: plan.settings[key] + plan.settingsSetAt[key]. Newest timestamp wins, per key.

// Used once per device, for values it had before syncing existed: any real change made later wins over it.
export const SEED_AT = '2000-01-01T00:00:00.000Z';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function planGet(p, k) {
  if (k === 'ftp') return p?.ftp != null ? { v: p.ftp, at: p.ftpSetAt || null } : null;
  return p?.settings && k in p.settings ? { v: p.settings[k], at: p.settingsSetAt?.[k] || null } : null;
}

export function planSet(p, k, v, at, source) {
  if (k === 'ftp') { p.ftp = v; p.ftpSetAt = at; if (source) p.ftpSource = source; return; }
  (p.settings ||= {})[k] = v;
  (p.settingsSetAt ||= {})[k] = at;
}

/**
 * Merges the plan's settings with this device's.
 * base: { key: { v, at } } = the value each key had when this device last agreed with the plan (null on first run).
 * pending: { key: { v, at, source } } = local changes not yet written to the plan.
 * Returns new copies plus the keys adopted from the plan.
 */
export function reconcile({ plan, settings, base, pending = {}, defaults = {}, now = new Date().toISOString(), source = 'settings' }) {
  const first = !base;
  settings = { ...settings }; base = { ...(base || {}) }; pending = { ...pending };
  const adopted = [];
  // 1. take newer values from the plan
  if (plan) {
    for (const k of new Set([...Object.keys(plan.settings || {}), 'ftp'])) {
      const r = planGet(plan, k);
      if (!r || r.at == null && k === 'ftp' && !first) continue;
      if (base[k] && base[k].at === r.at && r.at != null) continue; // nothing new
      if (pending[k] && pending[k].at > (r.at || '')) continue;     // our change is newer
      if (first && r.at == null && !same(settings[k], defaults[k]) && !same(settings[k], r.v)) continue; // untimed plan FTP vs a value set here: seed ours
      delete pending[k];
      if (!same(settings[k], r.v)) { settings[k] = r.v; adopted.push(k); }
      base[k] = { v: r.v, at: r.at };
    }
  }
  // 2. anything that differs from what we last agreed on is a local change
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
  return { settings, base, pending, adopted };
}

/** Writes pending changes into plan (in place) unless the plan has a newer value. Returns the keys written. */
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
