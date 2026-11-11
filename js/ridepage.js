// Ride page: one completed ride with stacked charts on one time axis, its intervals,
// time in zones and best powers. Pure functions (no DOM reads): app.js loads the ride
// document, measures the chart width, binds the pointer and passes the theme colors in.
//
// A ride document is what buildRide() in stats.js makes (and what rodillo-data stores in
// rides/YYYY/<id>.json): { summary, intervals, streams: { power, hr, cadence, speed (m/s),
// grade (%), target, gear, seg }, laps }. Imported rides can miss power, grade and target.

import { ZONES, zoneOf, zoneRange } from './zones.js?v=202611102147';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtLong = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
const pctCls = (p) => (p < 95 ? 'low' : p > 105 ? 'high' : 'ok');
const amax = (a, d = 0) => { let m = -Infinity; for (const v of a || []) if (v > m) m = v; return m === -Infinity ? d : m; };
const amin = (a, d = 0) => { let m = Infinity; for (const v of a || []) if (v < m) m = v; return m === Infinity ? d : m; };
const has = (a) => Array.isArray(a) && a.some((v) => v > 0);

/** Trailing n-second average (3 s for the power and HR lines, like the ride screen). */
export function smooth(a, n) {
  const out = []; let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] || 0; if (i >= n) s -= a[i - n] || 0; out.push(s / Math.min(i + 1, n)); }
  return out;
}
/** Centered n-second average: colors the power area by zone in blocks instead of stripes. */
function smoothC(a, n) {
  const h = n >> 1, out = new Array(a.length); let s = 0, k = 0;
  for (let i = -h; i < a.length; i++) {
    if (i + h < a.length) { s += a[i + h] || 0; k++; }
    if (i - h - 1 >= 0) { s -= a[i - h - 1] || 0; k--; }
    if (i >= 0) out[i] = s / k;
  }
  return out;
}

const repText = (rep) => (!rep ? '' : typeof rep === 'string' ? rep.replace('/', ' of ') : `${rep.i} of ${rep.of}`);
export const segName = (s) => `${s.label || 'Interval'}${s.rep ? ` ${repText(s.rep)}` : ''}`;

/**
 * The ride's intervals in ride seconds: [{ i, start, end, label, rep, kind, work, cad, from, to, grade, res }].
 * i is the workout segment index (the same one doc.intervals uses). Timing comes from the `seg`
 * stream (rides since Nov 11, and every ride still on this device); older synced rides fall back
 * to the workout's own timing. wsegs = flatten(workout) when the workout is still in the library.
 */
export function rideSegs(doc, wsegs = null) {
  const n = doc.streams?.power?.length || doc.streams?.hr?.length || doc.summary?.durSec || 0;
  const res = new Map((doc.intervals || []).map((x) => [x.i, x]));
  const meta = (i) => {
    const w = wsegs?.[i], r = res.get(i);
    if (!w && !r) return null;
    return {
      label: r?.label ?? w?.label ?? '', rep: r?.rep ?? (w?.rep ? `${w.rep.i}/${w.rep.of}` : undefined),
      kind: w?.kind ?? r?.kind ?? 'erg', work: r ? !!r.work : w?.kind === 'erg' ? (w.from + w.to) / 2 >= 0.85 : (w?.grade || 0) >= 0.04,
      cad: w?.cad || null, from: w?.from, to: w?.to, grade: w?.grade ?? (r?.grade != null ? r.grade / 100 : undefined), res: r || null,
    };
  };
  const seg = doc.streams?.seg;
  const out = [];
  if (Array.isArray(seg) && seg.some((v) => v >= 0)) {
    const span = new Map(); // first start and last end of each segment index (a step can be revisited)
    seg.forEach((si, t) => {
      if (si < 0 || si == null) return;
      const s = span.get(si);
      if (s) s.end = t + 1; else span.set(si, { start: t, end: t + 1 });
    });
    for (const [i, s] of [...span].sort((a, b) => a[1].start - b[1].start)) {
      const m = meta(i);
      if (m) out.push({ i, ...s, ...m });
    }
  } else if (wsegs?.length) {
    wsegs.forEach((w, i) => { if (w.start < n) out.push({ i, start: w.start, end: Math.min(n, w.end), ...meta(i) }); });
  }
  return out.filter((s) => s.end > s.start);
}

/** Interval color: zone of its target (ERG) or the grade color (slope). */
export function segColor(s, ftp, zoneHex, gradeHex) {
  if (s.kind === 'sim') return gradeHex(s.grade ?? 0);
  if (s.from != null) return zoneHex((s.from + s.to) / 2);
  if (s.res?.target) return zoneHex(s.res.target / ftp);
  return zoneHex(0);
}

/** Per-interval numbers straight from the streams (max HR, speed) for the table and the selection line. */
export function segStats(doc, s) {
  const S = doc.streams, sl = (k) => (S[k] || []).slice(s.start, s.end);
  const hr = sl('hr').filter(Boolean);
  return {
    avgP: S.power ? Math.round(mean(sl('power'))) : null,
    avgHr: hr.length ? Math.round(mean(hr)) : null, maxHr: hr.length ? Math.max(...hr) : null,
    avgCad: Math.round(mean(sl('cadence').filter(Boolean))) || null,
    avgKmh: S.speed ? Math.round(mean(sl('speed')) * 36) / 10 : null,
  };
}

/** What the ride was: "ERG", "Slope", "ERG + slope", "Free ride" or "Imported". */
function modeOf(doc) {
  const st = doc.summary;
  if (st.tags?.includes('imported')) return 'Imported';
  const erg = has(doc.streams?.target), slope = (st.slopeSec || 0) > 0;
  if (!st.workoutId && !erg) return 'Free ride';
  return erg && slope ? 'ERG + slope' : erg ? 'ERG' : 'Slope';
}

/** The page above and below the chart. opts: { segs, ftp, zoneHex, gradeHex, profile, season, canFit, canDelete, sel } */
export function pageHtml(doc, opts) {
  const st = doc.summary, S = doc.streams || {};
  const d = new Date(st.start || st.id);
  const when = `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} &middot; ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const mode = modeOf(doc);
  const hidden = new Set(['sim', 'free-slope', 'imported', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  const tags = (st.tags || []).filter((t) => !hidden.has(t)).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const kmh = st.distKm && st.durSec ? Math.round((st.distKm / st.durSec) * 36000) / 10 : null;
  const slope = mode === 'Slope' || mode === 'ERG + slope';
  const stat = (v, l, sub = '') => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const stats = [
    stat(fmtTime(st.durSec), 'Time', !slope && st.distKm ? `${st.distKm.toFixed(1)} km` : ''),
    slope && st.distKm ? stat(`${st.distKm.toFixed(1)}<small>km</small>`, 'Distance', kmh ? `${kmh} km/h` : '') : '',
    st.np != null ? stat(`${st.np}<small>W</small>`, 'NP', st.avgP != null ? `avg ${st.avgP} W` : '') : '',
    st.tss != null ? stat(st.tss, 'TSS', st.tssFrom === 'hr' ? 'from heart rate' : '') : '',
    st.if != null ? stat(Number(st.if).toFixed(2), 'IF') : '',
    st.kj != null ? stat(st.kj, 'kJ') : '',
    st.avgHr ? stat(st.avgHr, 'Avg HR', st.maxHr ? `max ${st.maxHr}` : '') : '',
    st.avgCad ? stat(st.avgCad, 'Cadence') : '',
    st.compliance ? stat(`<span class="pct ${pctCls(st.compliance.min)}">${st.compliance.avg}%</span>`, 'Intervals', `min ${st.compliance.min}%, ${st.compliance.reps} ${st.compliance.reps === 1 ? 'rep' : 'reps'}`) : '',
  ].filter(Boolean).slice(0, 8);

  // intervals table: every interval with data, recoveries muted
  const segs = opts.segs || [];
  const ergTable = segs.some((s) => s.kind === 'erg');
  const rows = segs.filter((s) => s.res).map((s) => {
    const x = s.res, ss = segStats(doc, s);
    const tgt = s.kind === 'erg' ? (x.target ? `${x.target} W` : '') : `${+(x.grade ?? (s.grade || 0) * 100).toFixed(1)}%`;
    const pct = s.kind === 'erg' && s.work && x.pct ? `<span class="pct ${pctCls(x.pct)}">${x.pct}%</span>` : '';
    const third = ergTable ? `<td class="r">${pct}</td>` : `<td class="r num rd-wide">${ss.avgKmh != null ? `${ss.avgKmh} km/h` : ''}</td>`;
    const cad = `${x.avgCad ?? ''}${x.cadTarget ? `<span class="cadin">${x.cadInRange ?? '-'}% in ${esc(x.cadTarget)}</span>` : ''}`;
    return `<tr data-i="${s.i}" class="${s.work ? '' : 'rec'} ${opts.sel === s.i ? 'sel' : ''}">
      <td><span class="zdot" style="background:${segColor(s, opts.ftp, opts.zoneHex, opts.gradeHex)}"></span>${esc(s.label || 'Interval')}${x.rep ? ` ${esc(x.rep)}` : ''}</td>
      <td class="r num rd-wide">${fmtTime(s.end - s.start)}</td><td class="r num">${tgt}</td><td class="r num">${x.avgP != null ? `${x.avgP} W` : ''}</td>${third}
      <td class="r num">${x.avgHr ?? ''}</td><td class="r num">${cad}</td></tr>`;
  }).join('');
  const head = `<th>Interval</th><th class="r rd-wide">Time</th><th class="r">${ergTable ? 'Target' : 'Grade'}</th><th class="r">Avg</th>${ergTable ? '<th class="r">%</th>' : '<th class="r rd-wide">Speed</th>'}<th class="r">HR</th><th class="r">Cad</th>`;

  const zones = st.zones?.some(Boolean) ? (() => {
    const total = st.zones.reduce((a, b) => a + (b || 0), 0), max = Math.max(...st.zones);
    return `<section class="card"><h3>Time in zones<span class="muted">at FTP ${st.ftp} W</span></h3><div class="zbars">${ZONES.map((z, i) => {
      const sec = st.zones[i] || 0;
      return `<div class="zb-z">Z${z.z}</div><div class="zb-n">${z.name}<span>${zoneRange(i, st.ftp)}</span></div>
        <div class="zb-bar"><i style="width:${(sec / max) * 100}%;background:var(--${z.color})"></i></div>
        <div class="zb-t">${sec ? fmtLong(sec) : '-'}</div><div class="zb-p">${sec ? Math.round((sec / total) * 100) + '%' : ''}</div>`;
    }).join('')}</div></section>`;
  })() : '';
  const bestCells = [[5, '5 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min']].filter(([dur]) => st.bests?.[dur]).map(([dur, l]) => {
    const v = st.bests[dur], sb = opts.season?.[dur];
    const sub = sb && v >= sb ? '<span class="pr">Best in 90 days</span>' : sb ? `90-day best ${sb}` : '';
    return `<div><div class="v">${v}<small> W</small></div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }).join('');
  const best = bestCells ? `<section class="card"><h3>Best power</h3><div class="rd-best">${bestCells}</div></section>` : '';
  const side = zones + best;
  const acts = `${opts.canFit ? '<button class="ghost small" data-rd="fit">Export .FIT</button>' : ''}${opts.canDelete ? '<button class="ghost small danger" data-rd="delete">Delete</button>' : ''}`;
  const back = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  const lanes = laneKeys(doc);

  return `
    <div class="rd-nav"><button class="ghost small rd-back" data-rd="back">${back}${esc(opts.backLabel || 'Back')}</button><div class="rd-acts">${acts}</div></div>
    <header class="rd-head ${opts.profile ? '' : 'noprof'}">
      <div><h2>${esc(st.name)}</h2><div class="rd-sub">${when} &middot; ${mode}${st.ftp ? ` &middot; FTP ${st.ftp} W` : ''}${tags ? ` ${tags}` : ''}</div></div>
      ${opts.profile ? `<div class="rd-thumb">${opts.profile}</div>` : ''}
    </header>
    <div class="rd-stats" style="--n:${stats.length}">${stats.join('')}</div>
    ${lanes.length ? `<section class="card rd-charts">
      <div class="rd-chhead"><div class="rd-sel" id="rd-sel"></div><div class="rd-hint" id="rd-hint">${opts.phone ? `Drag across the chart to read any second.${segs.length ? ' Tap an interval to select it.' : ''}` : `Point at the chart to read any second.${segs.length ? ' Click an interval to select it.' : ''}`}</div></div>
      <div class="rd-wrap" id="rd-wrap"><svg id="rd-chart" class="rd-chart"></svg><div class="rd-tip" id="rd-tip" role="status"></div></div>
    </section>` : '<p class="muted">This ride has no recorded data to chart.</p>'}
    ${rows || side ? `<div class="rd-grid ${rows ? '' : 'noints'}">
      ${rows ? `<section class="card rd-ints"><h3>Intervals</h3><table class="ints" id="rd-ints"><tr>${head}</tr>${rows}</table></section>` : ''}
      ${side ? `<div class="rd-side">${side}</div>` : ''}
    </div>` : ''}
    ${acts ? `<div class="rd-foot">${acts}</div>` : ''}`;
}

/** Which lanes this ride has data for, top to bottom. */
export function laneKeys(doc) {
  const S = doc.streams || {}, out = [];
  if (has(S.power)) out.push('power');
  if (has(S.hr)) out.push('hr');
  if (has(S.cadence)) out.push('cadence');
  const erg = has(S.target);
  if (!erg && has(S.speed)) out.push('speed');
  if (S.grade?.some((g) => g)) out.push('grade');
  return out;
}

const LANES = {
  power: { label: 'Power', unit: 'W', h: [170, 120] }, hr: { label: 'Heart rate', unit: 'bpm', h: [84, 64] },
  cadence: { label: 'Cadence', unit: 'rpm', h: [70, 54] }, speed: { label: 'Speed', unit: 'km/h', h: [60, 48] },
  grade: { label: 'Grade', unit: '%', h: [54, 44] },
};

/**
 * The chart: interval strip, then one lane per stream on one time axis.
 * o: { width, phone, ftp, segs, sel, tok: { ink, rule, faint, ftp, hr, info, infoLine, band, dim, sheet }, zoneHex, gradeHex }
 * Returns { svg (inner markup), height, geo } where geo maps time to x and values to y for the crosshair.
 */
export function chartSvg(doc, o) {
  const S = doc.streams, keys = laneKeys(doc);
  const T = Math.max(1, ...keys.map((k) => S[k].length));
  const W = Math.max(200, o.width), gutR = o.phone ? 30 : 40, PW = W - gutR;
  const STRIP = o.segs.length ? (o.phone ? 12 : 14) : 0, GAP = o.phone ? 10 : 12, AX = 18;
  const X = (t) => (t / T) * PW, nn = (v) => Math.max(0, v);
  const kmh = S.speed ? S.speed.map((v) => v * 3.6) : null;
  const pw = S.power ? smooth(S.power, 3) : null, hr = S.hr ? smooth(S.hr.map((v) => v || 0), 3) : null, cad = S.cadence ? smooth(S.cadence, 3) : null;
  const sp = kmh ? smooth(kmh, 3) : null;
  const lanes = keys.map((k) => ({ k, ...LANES[k], h: LANES[k].h[o.phone ? 1 : 0] }));
  let y = STRIP ? STRIP + 8 : 4;
  lanes.forEach((l) => { l.y = y; y += l.h + GAP; });
  const H = y - GAP + AX, top = STRIP ? STRIP + 4 : 0, bodyH = H - AX - top;
  const hrVals = (S.hr || []).filter(Boolean), cadVals = (S.cadence || []).filter(Boolean);
  const scale = {
    power: [0, Math.max(o.ftp * 1.3, amax(pw)) * 1.06],
    hr: hrVals.length ? [amin(hrVals) - 5, amax(hrVals) + 5] : [60, 190],
    cadence: [Math.min(40, amin(cadVals, 60) - 5), Math.max(115, amax(cadVals) + 5)],
    speed: [0, Math.max(10, amax(sp)) * 1.1],
    grade: [Math.min(-1, amin(S.grade)), Math.max(9, amax(S.grade)) + 1],
  };
  const yOf = (l, v) => { const [a, b] = scale[l.k]; return l.y + l.h - ((v - a) / (b - a)) * l.h; };
  const perPx = Math.max(1, Math.round(T / PW));
  const path = (l, arr) => {
    let d = '', pen = false;
    for (let t = 0; t < T; t += perPx) {
      const v = arr[t];
      if (l.k === 'hr' && !S.hr[t]) { pen = false; continue; } // gaps where the strap dropped
      d += `${pen ? 'L' : 'M'}${X(t).toFixed(1)},${yOf(l, v).toFixed(1)}`; pen = true;
    }
    return d;
  };
  const tick = (l, v, txt = v) => `<text class="rd-tick" x="${PW + 5}" y="${(yOf(l, v) + 4).toFixed(1)}">${txt}</text>`;
  const { tok } = o;
  let out = '';
  // work intervals: a faint band through every lane; the strip on top says which interval is which
  for (const s of o.segs) if (s.work) out += `<rect x="${X(s.start)}" y="${top}" width="${nn(X(s.end) - X(s.start))}" height="${bodyH}" fill="${tok.band}"/>`;
  if (STRIP) out += `<g class="rd-strip">${o.segs.map((s) => `<rect data-i="${s.i}" x="${(X(s.start) + 0.5).toFixed(1)}" y="0" width="${Math.max(1, X(s.end) - X(s.start) - 1).toFixed(1)}" height="${STRIP}" rx="2" fill="${segColor(s, o.ftp, o.zoneHex, o.gradeHex)}"/>`).join('')}</g>`;
  for (const l of lanes) {
    out += `<line x1="0" x2="${PW}" y1="${l.y + l.h}" y2="${l.y + l.h}" stroke="${tok.rule}"/>`;
    out += `<text class="rd-lane" x="4" y="${l.y + 12}">${l.label} <tspan>${l.unit}</tspan></text>`;
    if (l.k === 'power') {
      // zone-colored area: height from the 3 s power, color from a 20 s average so zones read as blocks
      const zs = smoothC(S.power, 20), base = l.y + l.h;
      let run = null;
      const flush = () => { if (run) out += `<path d="M${run.x0},${base}${run.pts}L${run.x1},${base}Z" fill="${run.c}"/>`; };
      for (let px = 0; px <= Math.ceil(PW); px++) {
        const a = Math.min(T - 1, Math.floor((px / PW) * T)), b = Math.max(a + 1, Math.floor(((px + 1) / PW) * T));
        const v = mean(pw.slice(a, b)), c = o.zoneHex(mean(zs.slice(a, b)) / o.ftp), yy = yOf(l, v).toFixed(1);
        if (!run || run.c !== c) {
          if (run) { run.pts += `L${px},${yy}`; run.x1 = px; }
          flush(); run = { c, x0: px, pts: `L${px},${yy}`, x1: px };
        } else { run.pts += `L${px},${yy}`; run.x1 = px; }
      }
      flush();
      out += `<line x1="0" x2="${PW}" y1="${yOf(l, o.ftp)}" y2="${yOf(l, o.ftp)}" stroke="${tok.ftp}" stroke-dasharray="4 4"/>${tick(l, o.ftp, 'FTP')}`;
      if (has(S.target)) {
        let d = '', pen = false;
        for (let t = 0; t < T; t += perPx) { const v = S.target[t]; if (!v) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(t).toFixed(1)},${yOf(l, v).toFixed(1)}`; pen = true; }
        out += `<path d="${d}" fill="none" stroke="${tok.ink}" stroke-width="1.6" stroke-linejoin="round"/>`;
      }
      for (const v of [100, 300, 500]) if (v < scale.power[1] * 0.95 && Math.abs(v - o.ftp) > o.ftp * 0.25) out += tick(l, v);
    } else if (l.k === 'hr') {
      out += `<path d="${path(l, hr)}" fill="none" stroke="${tok.hr}" stroke-width="1.8" stroke-linejoin="round"/>`;
      const [a, b] = scale.hr;
      for (const v of [Math.ceil((a + 4) / 10) * 10, Math.floor((b - 4) / 10) * 10]) out += tick(l, v);
    } else if (l.k === 'cadence') {
      for (const s of o.segs) {
        if (!s.cad) continue;
        const hi = Math.min(s.cad.hi ?? Infinity, scale.cadence[1]); // "95+" has no ceiling (Infinity, null once it went through JSON)
        out += `<rect x="${X(s.start)}" y="${yOf(l, hi)}" width="${nn(X(s.end) - X(s.start))}" height="${nn(yOf(l, s.cad.lo) - yOf(l, hi))}" fill="${tok.infoLine}" opacity=".7"/>`;
      }
      out += `<path d="${path(l, cad)}" fill="none" stroke="${tok.info}" stroke-width="1.6" stroke-linejoin="round"/>${tick(l, 60)}${tick(l, 90)}`;
    } else if (l.k === 'speed') {
      out += `<path d="${path(l, sp)}" fill="none" stroke="${tok.ink}" stroke-width="1.5" stroke-linejoin="round"/>`;
      for (const v of [20, 40]) if (v < scale.speed[1]) out += tick(l, v);
    } else if (l.k === 'grade') {
      const y0 = yOf(l, 0);
      for (let px = 0; px < PW; px += 2) {
        const g = S.grade[Math.min(T - 1, Math.floor((px / PW) * T))] || 0, y1 = yOf(l, g);
        if (g) out += `<rect x="${px}" y="${Math.min(y0, y1).toFixed(1)}" width="2.1" height="${Math.abs(y1 - y0).toFixed(1)}" fill="${o.gradeHex(g / 100)}" opacity=".85"/>`;
      }
      out += tick(l, 0) + tick(l, 8);
    }
  }
  const step = T > 5400 ? 1800 : T > 2400 ? 600 : T > 900 ? 300 : 60;
  for (let t = 0; t <= T - step * 0.4; t += step) out += `<text class="rd-tick" x="${X(t)}" y="${H - 3}" text-anchor="${t ? 'middle' : 'start'}">${t ? (t >= 3600 && step >= 1800 ? fmtTime(t).replace(/:00$/, '') : `${Math.round(t / 60)} min`) : '0'}</text>`;
  if (o.sel != null) {
    const s = o.segs.find((x) => x.i === o.sel);
    if (s) {
      const a = X(s.start), b = X(s.end);
      out += `<rect x="0" y="${top}" width="${nn(a)}" height="${bodyH}" fill="${tok.dim}"/><rect x="${b}" y="${top}" width="${nn(PW - b)}" height="${bodyH}" fill="${tok.dim}"/>`;
      out += `<rect x="${a}" y="${top}" width="${nn(b - a)}" height="${bodyH}" fill="none" stroke="${tok.ink}" stroke-width="1.5"/>`;
    }
  }
  out += `<g class="rd-xh" style="display:none"><line y1="${top}" y2="${H - AX}" stroke="${tok.ink}" stroke-width="1"/>${lanes.filter((l) => l.k !== 'grade').map((l) => `<circle data-k="${l.k}" r="3.5" fill="${l.k === 'hr' ? tok.hr : l.k === 'cadence' ? tok.info : tok.ink}" stroke="${tok.sheet}" stroke-width="1.5"/>`).join('')}</g>`;
  return { svg: out, width: W, height: H, geo: { T, PW, X, lanes, yOf, vals: { power: pw, hr, cadence: cad, speed: sp }, top } };
}

/** The crosshair tag's contents at second t. */
export function tipHtml(doc, segs, t) {
  const S = doc.streams, seg = segs.find((s) => t >= s.start && t < s.end);
  const p = S.power ? Math.round(mean(S.power.slice(Math.max(0, t - 2), t + 1))) : null;
  const tgt = S.target?.[t] ? ` <span>target ${S.target[t]}</span>` : S.grade?.[t] ? ` <span>${Number(S.grade[t]).toFixed(1)}%</span>` : '';
  const row = [
    S.hr?.[t] ? `${S.hr[t]} <span>bpm</span>` : '', S.cadence?.[t] ? `${S.cadence[t]} <span>rpm</span>` : '',
    S.speed && !S.target?.some((v) => v) ? `${(S.speed[t] * 3.6).toFixed(1)} <span>km/h</span>` : '',
  ].filter(Boolean).join(' &nbsp;');
  return `<div class="pt-lbl">${seg ? `${esc(segName(seg))} &middot; ` : ''}${fmtTime(t)}</div>
    ${p != null ? `<div class="pt-tgt">${p} W${tgt}</div>` : ''}${row ? `<div class="pt-row">${row}</div>` : ''}`;
}

/** The line above the chart while an interval is selected. */
export function selHtml(doc, s) {
  const x = s.res || {}, ss = segStats(doc, s);
  const avgP = x.avgP ?? ss.avgP;
  return `<b>${esc(segName(s))}</b><span class="muted">${fmtTime(s.start)} to ${fmtTime(s.end)}</span>
    ${avgP != null ? `<span><span class="num">${avgP} W</span>${s.kind === 'erg' && x.pct ? ` <span class="pct ${pctCls(x.pct)}">${x.pct}%</span>` : ''}</span>` : ''}
    ${ss.avgHr ? `<span><span class="num">${ss.avgHr}</span> <span class="muted">bpm avg, max ${ss.maxHr}</span></span>` : ''}
    ${ss.avgCad ? `<span><span class="num">${ss.avgCad}</span> <span class="muted">rpm</span></span>` : ''}
    <button class="ghost small" data-rd="clear">Show all</button>`;
}

/** Turn a ride document back into 1 Hz samples, so a ride that's only in rodillo-data can still be exported as .FIT. */
export function samplesFromDoc(doc) {
  const S = doc.streams || {}, n = Math.max(0, ...['power', 'hr', 'cadence', 'speed'].map((k) => S[k]?.length || 0));
  const t0 = Date.parse(doc.summary.start);
  let dist = 0;
  return Array.from({ length: n }, (_, i) => {
    const v = S.speed?.[i] || 0;
    dist += v;
    return { t: t0 + i * 1000, power: S.power?.[i] || 0, hr: S.hr?.[i] || undefined, cadence: S.cadence?.[i] || 0, speed: v, distance: dist, grade: S.grade?.[i] || 0 };
  });
}
