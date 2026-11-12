// Training analytics shared by the app and the coach's review scripts.
// Pure functions, no DOM: runs in the browser and in Node.

export const CURVE_DURS = [5, 15, 30, 60, 180, 300, 600, 1200, 3600];
import { ZONES, zoneOfWatts } from './zones.js?v=202611102147';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;

/** Best average power for each duration (1 Hz power array). */
export function bests(power, durs = CURVE_DURS) {
  const out = {};
  for (const d of durs) {
    if (power.length < d) continue;
    let sum = 0, best = 0;
    for (let i = 0; i < power.length; i++) {
      sum += power[i];
      if (i >= d) sum -= power[i - d];
      if (i >= d - 1) best = Math.max(best, sum);
    }
    out[d] = Math.round(best / d);
  }
  return out;
}

export function normalizedPower(power) {
  if (power.length < 30) return Math.round(mean(power));
  let roll = 0, acc = 0, k = 0;
  for (let i = 0; i < power.length; i++) {
    roll += power[i];
    if (i >= 30) roll -= power[i - 30];
    if (i >= 29) { acc += Math.pow(roll / 30, 4); k++; }
  }
  return Math.round(Math.pow(acc / k, 0.25));
}

/** Pw:HR aerobic decoupling (%) over the steady middle of a ride; null if not meaningful. */
export function decoupling(power, hr) {
  const n = power.length;
  if (n < 2400 || hr.filter(Boolean).length < n * 0.8) return null;
  const a = 600, b = n - 300;
  const win = power.slice(a, b);
  if (normalizedPower(win) / (mean(win) || 1) > 1.06) return null; // not a steady ride: drift is meaningless
  const mid = Math.floor((a + b) / 2);
  const ef = (s, e) => {
    const p = [], h = [];
    for (let i = s; i < e; i++) if (hr[i]) { p.push(power[i]); h.push(hr[i]); }
    return mean(p) / mean(h);
  };
  const e1 = ef(a, mid), e2 = ef(mid, b);
  return e1 ? r1(((e1 - e2) / e1) * 100) : null;
}

/** Per-interval results for a structured workout. samples carry wt (workout time) and target. */
export function intervalResults(samples, segs, ftp) {
  if (!segs) return [];
  const out = [];
  segs.forEach((seg, i) => {
    const lead = seg.dur >= 30 ? 5 : 0; // ignore ERG ramp-in at the start of each step
    const xs = samples.filter((s) => (s.si !== undefined ? s.si === i && s.st >= lead : s.wt >= seg.start + lead && s.wt < seg.end));
    if (xs.length < Math.min(10, seg.dur * 0.5)) return;
    const res = {
      i, label: seg.label, kind: seg.kind, rep: seg.rep ? `${seg.rep.i}/${seg.rep.of}` : undefined,
      dur: seg.dur, dist: seg.dist || undefined, done: xs.length, avgP: Math.round(mean(xs.map((s) => s.power))),
      avgHr: Math.round(mean(xs.filter((s) => s.hr).map((s) => s.hr))) || undefined,
      avgCad: Math.round(mean(xs.map((s) => s.cadence))),
    };
    if (seg.cad) {
      const settled = xs.filter((s) => (s.st ?? s.wt - seg.start) >= 8);
      res.cadTarget = seg.cad.label;
      res.cadInRange = settled.length ? Math.round((settled.filter((s) => s.cadence >= seg.cad.lo && s.cadence <= seg.cad.hi).length / settled.length) * 100) : undefined;
    }
    if (seg.kind === 'erg') {
      const tg = xs.filter((s) => s.target).map((s) => s.target);
      res.target = Math.round(tg.length ? mean(tg) : mean([seg.from, seg.to]) * ftp);
      res.pct = res.target ? Math.round((res.avgP / res.target) * 100) : undefined;
      res.work = mean([seg.from, seg.to]) >= 0.85;
    } else {
      res.grade = r1(mean(xs.map((s) => s.grade || 0)));
      res.work = seg.grade >= 0.04;
    }
    out.push(res);
  });
  return out;
}

/** Seconds in each power zone (Z1..Z7, see zones.js) for a 1 Hz power array. */
export function timeInZones(power, ftp) {
  const z = new Array(ZONES.length).fill(0);
  for (const p of power) z[zoneOfWatts(p, ftp)]++;
  return z;
}

/** Sum time-in-zone over ride summaries (each ride is binned at its own FTP). */
export function zoneTotals(summaries) {
  const z = new Array(ZONES.length).fill(0);
  for (const r of summaries) (r.zones || []).forEach((sec, i) => { if (i < z.length) z[i] += sec || 0; });
  return z;
}

/** Local-time id like 2026-11-10T1832 */
export function rideIdFor(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Build the full ride document (summary + intervals + streams) from session samples.
 * meta: { name, workoutId, tags, ftp, startMs, segs, source }
 */
export function buildRide(samples, meta) {
  const power = samples.map((s) => Math.round(s.power || 0));
  const hr = samples.map((s) => Math.round(s.hr || 0));
  const cad = samples.map((s) => Math.round(s.cadence || 0));
  const ftp = meta.ftp;
  const durSec = samples.length;
  const np = normalizedPower(power);
  const IF = np / ftp;
  const hrs = hr.filter(Boolean);
  const intervals = intervalResults(samples, meta.segs, ftp);
  const work = intervals.filter((x) => x.work && x.pct);
  const summary = {
    id: rideIdFor(meta.startMs),
    start: new Date(meta.startMs).toISOString(),
    name: meta.name, workoutId: meta.workoutId || null, tags: meta.tags || [],
    source: meta.source || 'rodillo', ftp,
    durSec, distKm: r1((samples.at(-1)?.distance || 0) / 1000),
    kj: Math.round(power.reduce((a, b) => a + b, 0) / 1000),
    avgP: Math.round(mean(power)), np, if: Math.round(IF * 100) / 100,
    tss: Math.round((durSec / 3600) * IF * IF * 100),
    avgHr: hrs.length ? Math.round(mean(hrs)) : null, maxHr: hrs.length ? Math.max(...hrs) : null,
    avgCad: Math.round(mean(cad.filter((c) => c > 0))) || null,
    ef: hrs.length ? Math.round((np / mean(hrs)) * 100) / 100 : null,
    decoupling: decoupling(power, hr),
    bests: bests(power),
    zones: timeInZones(power, ftp),
    compliance: work.length ? { avg: Math.round(mean(work.map((x) => x.pct))), min: Math.min(...work.map((x) => x.pct)), reps: work.length } : null,
    slopeSec: samples.filter((s) => s.grade).length,
  };
  // steps as ridden when they differ from the workout file (open-ended ramp test), so other devices draw them right
  const segs = meta.segsChanged && meta.segs
    ? meta.segs.map((g) => ({ label: g.label, kind: g.kind, dur: g.dur, start: g.start, end: g.end, from: g.from, to: g.to, grade: g.grade, free: g.free, cad: g.cad || undefined, rep: g.rep || undefined, untilFail: g.untilFail }))
    : undefined;
  return {
    summary,
    intervals,
    ...(segs ? { segs } : {}),
    streams: {
      power, hr, cadence: cad,
      grade: samples.map((s) => Math.round((s.grade || 0) * 10) / 10),
      speed: samples.map((s) => Math.round((s.speed || 0) * 100) / 100),
      target: samples.map((s) => s.target || 0),
      gear: samples.map((s) => s.gear || 0),
      seg: samples.map((s) => (s.si ?? -1)), // workout step per second (-1 = none): the ride page times intervals with it
      // slope diagnostics: grade sent to the trainer and the closed-loop trim (%), only when the ride had slope
      ...(samples.some((s) => s.sent != null) ? { sent: samples.map((s) => s.sent ?? 0), trim: samples.map((s) => s.trim ?? 0) } : {}),
    },
  };
}

// ---------------- across rides ----------------

const dayKey = (d) => d.toLocaleDateString('en-CA');

/** Daily CTL (42 d), ATL (7 d), TSB from ride summaries. */
export function loadSeries(rides, until = new Date(), days = 120) {
  const byDay = {};
  for (const r of rides) byDay[r.id.slice(0, 10)] = (byDay[r.id.slice(0, 10)] || 0) + (r.tss || 0);
  const first = rides.length ? new Date(Math.min(...rides.map((r) => Date.parse(r.id.slice(0, 10) + 'T12:00:00')))) : until;
  const out = [];
  let ctl = 0, atl = 0;
  for (let d = new Date(first); d <= until; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    const tsb = ctl - atl;
    const tss = byDay[k] || 0;
    ctl += (tss - ctl) / 42;
    atl += (tss - atl) / 7;
    out.push({ date: k, tss, ctl: r1(ctl), atl: r1(atl), tsb: r1(tsb) });
  }
  return out.slice(-days);
}

/** Monday-start weekly totals for the last n weeks. */
export function weekly(rides, n = 12, now = new Date()) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(monday); start.setDate(start.getDate() - 7 * i);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const rs = rides.filter((r) => { const t = Date.parse(r.start); return t >= start && t < end; });
    weeks.push({ start: dayKey(start), rides: rs.length, hours: r1(rs.reduce((a, r) => a + r.durSec, 0) / 3600), tss: rs.reduce((a, r) => a + (r.tss || 0), 0) });
  }
  return weeks;
}

/** Max of per-ride bests across rides started within the last `days` (all if null). */
export function powerCurve(rides, days = null, now = Date.now()) {
  const out = {};
  for (const r of rides) {
    if (days && now - Date.parse(r.start) > days * 864e5) continue;
    for (const [d, w] of Object.entries(r.bests || {})) out[d] = Math.max(out[d] || 0, w);
  }
  return out;
}

/**
 * FTP this one ride proves, or null. Ramp test: 75% of best 1 min. Any other ride: 95% of best 20 min
 * (so raising ERG effort or riding hard in slope mode counts).
 */
export function ftpFromRide(st) {
  if (st?.tags?.includes('test') && st.bests?.[60]) return { ftp: Math.round(st.bests[60] * 0.75), basis: `best 1-min ${st.bests[60]} W x 75%`, test: true };
  if (st?.bests?.[1200]) return { ftp: Math.round(st.bests[1200] * 0.95), basis: `best 20-min ${st.bests[1200]} W x 95%`, test: false };
  return null;
}

/** FTP estimates from the last 90 days: 95% of best 20 min, and 75% of best 1 min in ramp tests. */
export function ftpEstimate(rides, now = Date.now()) {
  const recent = rides.filter((r) => now - Date.parse(r.start) < 90 * 864e5);
  const b20 = Math.max(0, ...recent.map((r) => r.bests?.[1200] || 0));
  const ramp = Math.max(0, ...recent.filter((r) => r.tags?.includes('test')).map((r) => r.bests?.[60] || 0));
  return { from20min: b20 ? Math.round(b20 * 0.95) : null, fromRamp: ramp ? Math.round(ramp * 0.75) : null };
}

export function formLabel(tsb) {
  if (tsb > 15) return 'Very fresh';
  if (tsb > 5) return 'Fresh';
  if (tsb > -10) return 'Balanced';
  if (tsb > -30) return 'Productive fatigue';
  return 'Overreaching';
}
