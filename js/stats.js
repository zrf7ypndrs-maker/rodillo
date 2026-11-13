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
      // planned watts (rides since Nov 12) so lowering the effort doesn't make a rep look on target;
      // older rides only have the target sent to the trainer, which already includes the effort
      const pl = xs.filter((s) => s.plan).map((s) => s.plan);
      const tg = xs.filter((s) => s.target).map((s) => s.target);
      res.target = Math.round(pl.length ? mean(pl) : tg.length ? mean(tg) : mean([seg.from, seg.to]) * ftp);
      res.pct = res.target ? Math.round((res.avgP / res.target) * 100) : undefined;
      if (pl.length) {
        const eff = Math.round(mean(xs.filter((s) => s.plan).map((s) => s.eff ?? 1)) * 100);
        if (eff !== 100) res.effort = eff; // average effort over the rep, in %
      }
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
  // compliance counts the reps when the workout has them (not a one-off opener), else every work interval
  let work = intervals.filter((x) => x.work && x.pct);
  if (work.some((x) => x.rep)) work = work.filter((x) => x.rep);
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
    ...(meta.bike ? { bike: meta.bike } : {}),
    ...(meta.gearing ? { gearing: meta.gearing } : {}),
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
      // planned watts per second (effort 100%), only when the ride had ERG with a changed effort
      ...(samples.some((s) => s.eff != null) ? { plan: samples.map((s) => s.plan ?? 0) } : {}),
      // slope diagnostics: grade sent to the trainer and the closed-loop trim (%), only when the ride had slope
      ...(samples.some((s) => s.sent != null) ? { sent: samples.map((s) => s.sent ?? 0), trim: samples.map((s) => s.trim ?? 0) } : {}),
      // 1 where the trainer did the shifting (Zwift protocol), 0 where Rodillo did (FTMS)
      ...(samples.some((s) => s.zp) ? { zp: samples.map((s) => s.zp ?? 0) } : {}),
    },
  };
}

// ---------------- across rides ----------------

const dayKey = (d) => d.toLocaleDateString('en-CA');

/**
 * Daily CTL (42 d), ATL (7 d), TSB from ride summaries, as of the START of each day:
 * a day's ride moves fitness, fatigue and form the next morning, and tsb = ctl - atl on every row.
 * Days are calendar days (compared by key), so today's row exists from midnight.
 */
export function loadSeries(rides, until = new Date(), days = 120) {
  const byDay = {};
  for (const r of rides) { const k = r.id.slice(0, 10); byDay[k] = (byDay[k] || 0) + (r.tss || 0); }
  const end = dayKey(until);
  const first = Object.keys(byDay).sort()[0] || end;
  const out = [];
  let ctl = 0, atl = 0;
  // noon local so DST never skips or repeats a day
  for (let d = new Date(first + 'T12:00:00'); dayKey(d) <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d), tss = byDay[k] || 0;
    out.push({ date: k, tss, ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) });
    ctl += (tss - ctl) / 42;
    atl += (tss - atl) / 7;
  }
  return out.slice(-days);
}

/** What the cards show: rounded fitness and fatigue, form = their difference, so the three always add up. */
export function loadNow(row) {
  const fitness = Math.round(row?.ctl || 0), fatigue = Math.round(row?.atl || 0);
  return { fitness, fatigue, form: fitness - fatigue };
}

// Typical intensity (fraction of FTP) inside each zone, used to weight time in zone into TSS.
const ZONE_MID_IF = [0.45, 0.655, 0.83, 0.98, 1.13, 1.355, 1.75];

/**
 * A ride's TSS split by power zone (Z1..Z7), or null when the ride has no power zones
 * (HR-scored imports). TSS grows with time x IF squared, so each zone's seconds are
 * weighted by its typical IF squared, then scaled so the parts add up to the ride's TSS.
 */
export function tssByZone(r) {
  const z = r?.zones;
  if (!r?.tss || !Array.isArray(z)) return null;
  const w = ZONES.map((_, i) => (z[i] || 0) * ZONE_MID_IF[i] ** 2);
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map((x) => (x / sum) * r.tss) : null;
}

/** Monday-start weekly totals for the last n weeks; zoneTss splits the TSS by power zone, otherTss is TSS without power. */
export function weekly(rides, n = 12, now = new Date()) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(monday); start.setDate(start.getDate() - 7 * i);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const rs = rides.filter((r) => { const t = Date.parse(r.start); return t >= start && t < end; });
    const zoneTss = new Array(ZONES.length).fill(0);
    let otherTss = 0;
    for (const r of rs) {
      const z = tssByZone(r);
      if (z) z.forEach((t, i) => { zoneTss[i] += t; }); else otherTss += r.tss || 0;
    }
    weeks.push({ start: dayKey(start), rides: rs.length, hours: r1(rs.reduce((a, r) => a + r.durSec, 0) / 3600), tss: rs.reduce((a, r) => a + (r.tss || 0), 0), zoneTss: zoneTss.map(r1), otherTss: r1(otherTss) });
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

/** Form state; the same cutoffs as FORM_BANDS in js/app.js. */
export function formLabel(tsb) {
  if (tsb > 15) return 'Very fresh';
  if (tsb > 5) return 'Fresh';
  if (tsb > -10) return 'Balanced';
  if (tsb > -30) return 'Productive fatigue';
  return 'Overreaching';
}
