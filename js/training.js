// @ts-check
// Training tab: stats card, fitness / fatigue / form chart, weekly load bars, power curve, time in zones and the
// rides list (#training-cards, #chart-*, #ride-table). Moved out of js/app.js Nov 17 (code-health plan step 4) with
// no change in behavior. The chart builders are pure (data and a `look` in, markup out; tested in test/training.mjs):
// `look` = { phone, INK, MUTED, RULE, FAINT, UNDERLAY, FITNESS, FATIGUE, TOK, ZC, zoneHex }, which app.js builds at draw
// time (chartLook()) because the colors follow the light / dark theme. Only renderTraining() needs app.js, through
// initTraining(). Never import app.js from here.
import { loadSeries, weekly, powerCurve, ftpEstimate, formLabel, loadNow, zoneTotals, CURVE_DURS } from './stats.js';
import { ZONES, zoneRange } from './zones.js';
import { fmtTime } from './ridepage.js';
import { ls, rides } from './store.js';
import { $, $$, esc } from './ui.js';
import { dkey, dayDate } from './dates.js';
/** @typedef {import('./types.js').ElementEvent} ElementEvent */

// from app.js, set by initTraining()
/** @typedef {import('./types.js').TrainingDeps} Deps */
/** @typedef {import('./types.js').ChartLook} ChartLook */
/** @typedef {import('./types.js').LoadRow} LoadRow */
/** @type {Deps['app']} */ let app;
/** @type {Deps['look']} */ let look;
/** @type {Deps['trainingRows']} */ let trainingRows;
/** @type {Deps['syncClient']} */ let syncClient;
/** @type {Deps['dataRepo']} */ let dataRepo;
/** @type {Deps['syncHint']} */ let syncHint;
/** @type {Deps['syncPending']} */ let syncPending;
/** @type {Deps['whoopDay']} */ let whoopDay;
/** @type {Deps['recZone']} */ let recZone;
/** @type {Deps['openRide']} */ let openRide;
/** @type {Deps['downloadFit']} */ let downloadFit;
/** @type {Deps['ask']} */ let ask;

/** @param {import('./types.js').TrainingDeps} deps */
export function initTraining(deps) {
  ({ app, look, trainingRows, syncClient, dataRepo, syncHint, syncPending, whoopDay, recZone, openRide, downloadFit, ask } = deps);
}


// Form states, same cutoffs as formLabel() in stats.js (the Form tile)
/** @type {[number, number, string][]} */
const FORM_BANDS = [[15, 25, 'Very fresh'], [5, 15, 'Fresh'], [-10, 5, 'Balanced'], [-30, -10, 'Productive fatigue'], [-45, -30, 'Overreaching']];
/** @param {LoadRow[]} series @param {ChartLook} look */
export function svgLoad(series, { phone, INK, MUTED, RULE, FITNESS, FATIGUE }) {
  // phone: the svg shrinks to about half, so text is drawn about twice as big there
  const ph = phone, k = ph ? 1.8 : 1;
  const W = 640, H = ph ? 440 : 330, top = 150, n = series.length, PR = W - (ph ? 190 : 120); // PR = right edge of the plot, labels to its right
  if (n < 2) return '<p class="muted">Ride a few times to see fitness and fatigue.</p>';
  const maxL = Math.max(10, ...series.map((d) => Math.max(d.ctl, d.atl))) * 1.1;
  const X = (i) => (i / (n - 1)) * (PR - 30) + 30;
  const Y = (v) => top - (v / maxL) * (top - 10);
  // form strip: fixed scale -45..+25 so the bands never move
  const S0 = ph ? 196 : 178, S1 = H - (ph ? 36 : 24), lo = -45, hi = 25, B = (v) => S0 + ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * (S1 - S0), Z = B(0);
  const f = (v) => v.toFixed(1);
  const line = (k, c) => `<polyline fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" points="${series.map((d, i) => `${f(X(i))},${f(Y(d[k]))}`).join(' ')}"/>`;
  let gap = '';
  for (let i = 0; i < n - 1; i++) {
    const a = series[i], b = series[i + 1], da = a.ctl - a.atl, db = b.ctl - b.atl;
    const quad = (x0, c0, t0, x1, c1, t1, col) => `<polygon points="${f(x0)},${f(Y(c0))} ${f(x1)},${f(Y(c1))} ${f(x1)},${f(Y(t1))} ${f(x0)},${f(Y(t0))}" fill="${col}" opacity=".2"/>`;
    if (da * db < 0) {
      const t = da / (da - db), xm = X(i) + t * (X(i + 1) - X(i)), vm = a.ctl + t * (b.ctl - a.ctl);
      gap += quad(X(i), a.ctl, a.atl, xm, vm, vm, da > 0 ? FITNESS : FATIGUE) + quad(xm, vm, vm, X(i + 1), b.ctl, b.atl, db > 0 ? FITNESS : FATIGUE);
    } else gap += quad(X(i), a.ctl, a.atl, X(i + 1), b.ctl, b.atl, da + db >= 0 ? FITNESS : FATIGUE);
  }
  const now = loadNow(series.at(-1)).form;
  const cur = FORM_BANDS.find(([l, h]) => now > l && now <= h) || (now > 0 ? FORM_BANDS[0] : FORM_BANDS.at(-1));
  const bands = FORM_BANDS.map(([l, h, name], j) => `<rect x="30" y="${f(B(h))}" width="${W - 40}" height="${f(B(l) - B(h))}" fill="${INK}" opacity="${j % 2 ? 0.045 : 0.0}"/>`
    + `<text x="${PR + 10}" y="${f((B(l) + B(h)) / 2 + 4)}" fill="${name === cur[2] ? INK : MUTED}" font-size="${11 * k}" font-weight="${name === cur[2] ? 700 : 400}">${name}</text>`).join('');
  // premium look (phone Nov 12, desktop Nov 13): today's fitness and fatigue at the line ends, in their colors; the higher one on top
  const e = loadNow(series.at(-1)), blk = ph ? 50 : 44, mid = Math.min(Math.max((Y(e.fitness) + Y(e.fatigue)) / 2, blk + 4), top + 20 - blk);
  const end = (v, col, name, y) => `<text x="${PR + 12}" y="${f(y + (ph ? 26 : 24))}" fill="${col}" font-size="${(ph ? 15 : 24) * k}" font-weight="700">${v}</text><text x="${PR + 12}" y="${f(y + (ph ? 46 : 40))}" fill="${MUTED}" font-size="${(ph ? 10.5 : 12.5) * k}">${name}</text>`;
  const fitTop = e.fitness >= e.fatigue;
  const legend = end(e.fitness, FITNESS, 'Fitness', fitTop ? mid - blk : mid) + end(e.fatigue, FATIGUE, 'Fatigue', fitTop ? mid : mid - blk);
  const bw = Math.max(1, (PR - 30) / n - 1);
  const bars = series.map((d, i) => `<rect x="${f(X(i) - bw / 2)}" y="${f(Math.min(B(d.tsb), Z))}" width="${f(bw)}" height="${f(Math.abs(B(d.tsb) - Z))}" fill="${d.tsb >= 0 ? FITNESS : FATIGUE}" opacity=".85"/>`).join('');
  const m1 = series.findIndex((d) => d.date.endsWith('-01')), first = m1 < 0 || m1 >= (ph ? 16 : 10); // drop the first date if it would run into the 1st of the month
  const ticks = series.map((d, i) => d.date.endsWith('-01') || (i === 0 && first) ? `<text x="${X(i)}" y="${H - 4}" fill="${MUTED}" font-size="${12 * k}">${dayDate(d.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart">
    <text x="0" y="${14 * k}" fill="${MUTED}" font-size="${12 * k}">${Math.round(maxL)}</text>
    ${gap}${line('atl', FATIGUE)}${line('ctl', FITNESS)}
    <text x="30" y="${S0 - 8 * k}" fill="${INK}" font-size="${12 * k}" font-weight="650">Form <tspan fill="${MUTED}" font-weight="400">now ${now > 0 ? '+' : ''}${now}, ${cur[2].toLowerCase()}</tspan></text>
    ${bands}<line x1="30" x2="${PR}" y1="${f(Z)}" y2="${f(Z)}" stroke="${RULE}"/>${bars}${ticks}
    ${legend}</svg>`;
}

/** @param {ReturnType<typeof weekly>} weeks @param {ChartLook} look */
export function svgWeekly(weeks, { phone, ZC, INK, MUTED, RULE, FAINT, UNDERLAY }) {
  // Real pixel sizes on the phone (viewBox = about the card width there), so text isn't shrunk.
  const W = phone ? 340 : 560, n = weeks.length;
  const top = 24, barMax = phone ? 110 : 120, base = top + barMax, H = base + 40;
  const max = Math.max(100, ...weeks.map((w) => w.tss));
  const bw = (W - 8) / n;
  const fmtDay = (d) => dayDate(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // Each bar is the week's TSS stacked by power zone, Z1 at the bottom; HR-only TSS (no power) sits on top, hatched.
  const bars = weeks.map((w, i) => {
    const h = (w.tss / max) * barMax, x = 4 + i * bw, cx = x + bw / 2, bwid = Math.min(bw - 8, 34), bx = cx - bwid / 2;
    const parts = (w.zoneTss || []).map((t, z) => ({ t, fill: ZC[ZONES[z].color] }))
      .concat(w.otherTss ? [{ t: w.otherTss, fill: 'url(#wk-hr)' }] : []);
    const known = parts.reduce((a, p) => a + p.t, 0);
    let y = base, segs = '';
    if (known > 0) for (const p of parts) {
      const sh = (p.t / known) * h;
      if (sh < 0.3) continue;
      y -= sh;
      segs += `<rect x="${bx}" y="${y}" width="${bwid}" height="${sh + 0.4}" fill="${p.fill}"/>`;
    } else if (h) segs = `<rect x="${bx}" y="${base - h}" width="${bwid}" height="${h}" fill="${FAINT}"/>`;
    const byZone = (w.zoneTss || []).map((t, z) => [t, z]).filter(([t]) => t >= 1)
      .map(([t, z]) => `Z${z + 1} ${Math.round(t)}`).concat(w.otherTss >= 1 ? [`HR only ${Math.round(w.otherTss)}`] : []);
    const tip = `Week of ${fmtDay(w.start)}: ${w.tss} TSS, ${w.hours} h${byZone.length ? `\n${byZone.join(' · ')}` : ''}`;
    const cur = i === n - 1, lab = cur ? INK : MUTED, wt = cur ? ' font-weight="700"' : '';
    return `<g><title>${esc(tip)}</title><clipPath id="wk-c${i}"><rect x="${bx}" y="${base - h}" width="${bwid}" height="${h + 8}" rx="6"/></clipPath><g clip-path="url(#wk-c${i})">${segs}</g></g>
      ${w.tss ? `<text x="${cx}" y="${base - h - 6}" text-anchor="middle" fill="${INK}" font-size="14" font-weight="700">${w.tss}</text>` : ''}
      <text x="${cx}" y="${base + 17}" text-anchor="middle" fill="${lab}" font-size="12"${wt}>${fmtDay(w.start)}</text>
      <text x="${cx}" y="${base + 33}" text-anchor="middle" fill="${MUTED}" font-size="12"${wt}>${w.rides ? `${w.hours} h` : '-'}</text>`;
  }).join('');
  const hrOnly = weeks.some((w) => w.otherTss > 0);
  const legend = `<div class="wk-legend"><span class="wk-key">Number on bar = training stress (TSS). Below: week starting, hours ridden.</span>${ZONES.slice(0, 6).map((z) => `<span><i style="background:var(--${z.color})"></i>Z${z.z}</span>`).join('')}${hrOnly ? '<span><i class="hr"></i>HR only (no power)</span>' : ''}</div>`;
  // premium look: round tops, no glow (phone Nov 13, desktop Nov 16, Agustín)
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart"><defs><pattern id="wk-hr" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${UNDERLAY}"/><line x1="0" y1="0" x2="0" y2="5" stroke="${FAINT}" stroke-width="2"/></pattern></defs>
    <line x1="4" x2="${W - 4}" y1="${base}" y2="${base}" stroke="${RULE}"/>${bars}</svg>${legend}`;
}

/** Power curve (premium look): orange line and a soft orange fill, no glow (Nov 16). Agustín's call (Nov 12, "I actually liked
 *  the orange"; Nov 13, "keep the curve orange" on desktop too): the one exception to the zone-colors-only-on-zone-data rule. */
/** @param {Record<string, number>} c90 @param {Record<string, number>} cAll @param {ChartLook} look */
export function svgCurve(c90, cAll, look) {
  const { phone, zoneHex, TOK, INK, MUTED } = look;
  if (phone) return svgCurvePhone(c90, cAll, look);
  const W = 1000, H = 230, labels = ['5s', '15s', '30s', '1m', '3m', '5m', '10m', '20m', '60m'], C = zoneHex(1.1);
  const max = Math.max(100, ...Object.values(cAll)) * 1.1;
  const X = (i) => 40 + (i / (CURVE_DURS.length - 1)) * (W - 80);
  const Y = (w) => 195 - (w / max) * 170;
  const P = (c) => CURVE_DURS.map((d, i) => (c[d] ? [X(i), Y(c[d])] : null)).filter(Boolean);
  const p90 = P(c90), pAll = P(cAll);
  const pts = (p) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = p90.length > 1 ? `<polygon points="${pts(p90)} ${p90.at(-1)[0].toFixed(1)},195 ${p90[0][0].toFixed(1)},195" fill="url(#pcd-fill)"/>` : '';
  const dots = CURVE_DURS.map((d, i) => (c90[d] ? `<circle cx="${X(i)}" cy="${Y(c90[d])}" r="4.5" fill="${C}" stroke="${TOK.sheet}" stroke-width="2"/><text x="${X(i)}" y="${Y(c90[d]) - 12}" text-anchor="middle" fill="${INK}" font-size="13.5" font-weight="650">${c90[d]}</text>` : '')).join('');
  return `<div class="pc-legend"><span><i class="solid"></i>Last 90 days</span><span><i class="dash"></i>All time</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="svgchart">
    <defs><linearGradient id="pcd-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C}" stop-opacity=".28"/><stop offset="1" stop-color="${C}" stop-opacity="0"/></linearGradient></defs>
    ${area}<polyline fill="none" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="4 5" points="${pts(pAll)}"/>
    <polyline fill="none" stroke="${C}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${pts(p90)}"/>${dots}
    ${labels.map((l, i) => `<text x="${X(i)}" y="222" text-anchor="middle" fill="${MUTED}" font-size="12.5">${l}</text>`).join('')}</svg>`;
}

/** Phone power curve (premium look, Nov 12): real pixel size so text isn't shrunk. Same orange as the desktop curve above,
 *  no glow (Agustín, Nov 13). */
/** @param {Record<string, number>} c90 @param {Record<string, number>} cAll @param {ChartLook} look */
export function svgCurvePhone(c90, cAll, { zoneHex, TOK, INK, MUTED }) {
  const W = 340, H = 160, labels = ['5s', '15s', '30s', '1m', '3m', '5m', '10m', '20m', '60m'], C = zoneHex(1.1);
  const max = Math.max(100, ...Object.values(cAll)) * 1.08;
  const X = (i) => 12 + (i / (CURVE_DURS.length - 1)) * (W - 24);
  const Y = (w) => 132 - (w / max) * 104;
  const P = (c) => CURVE_DURS.map((d, i) => (c[d] ? [X(i), Y(c[d])] : null)).filter(Boolean);
  const p90 = P(c90), pAll = P(cAll);
  const pts = (p) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = p90.length > 1 ? `<polygon points="${pts(p90)} ${p90.at(-1)[0].toFixed(1)},132 ${p90[0][0].toFixed(1)},132" fill="url(#pc-fill)"/>` : '';
  const dots = CURVE_DURS.map((d, i) => (c90[d] ? `<circle cx="${X(i)}" cy="${Y(c90[d])}" r="3.2" fill="${C}" stroke="${TOK.sheet}" stroke-width="1.5"/><text x="${X(i)}" y="${Y(c90[d]) - 9}" text-anchor="middle" fill="${INK}" font-size="11.5" font-weight="650">${c90[d]}</text>` : '')).join('');
  return `<div class="pc-legend"><span><i class="solid"></i>Last 90 days</span><span><i class="dash"></i>All time</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="svgchart pc-phone">
    <defs><linearGradient id="pc-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C}" stop-opacity=".30"/><stop offset="1" stop-color="${C}" stop-opacity="0"/></linearGradient></defs>
    ${area}<polyline fill="none" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="3 4" points="${pts(pAll)}"/>
    <polyline fill="none" stroke="${C}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts(p90)}"/>${dots}
    ${labels.map((l, i) => `<text x="${X(i)}" y="152" text-anchor="middle" fill="${MUTED}" font-size="11">${l}</text>`).join('')}</svg>`;
}

/** Time-in-zone rows (Z1..Z7). With ftp, ranges are in watts (one ride); without, % of FTP. */
const fmtLong = (sec) => (sec < 3600 ? fmtTime(sec) : `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`);
/** @param {number[]} secs Seconds per zone. @param {number} [ftp] */
export function zoneBars(secs, ftp) {
  const total = (secs || []).reduce((a, b) => a + (b || 0), 0);
  if (!total) return '<p class="muted">No rides in this period.</p>';
  const max = Math.max(...secs);
  return `<div class="zbars">${ZONES.map((z, i) => {
    const sec = secs[i] || 0;
    return `<div class="zb-z">Z${z.z}</div><div class="zb-n">${z.name}<span>${zoneRange(i, ftp)}</span></div>
      <div class="zb-bar"><i style="width:${(sec / max) * 100}%;background:var(--${z.color});color:var(--${z.color})"></i></div>
      <div class="zb-t">${sec ? fmtLong(sec) : '-'}</div><div class="zb-p">${sec ? Math.round((sec / total) * 100) + '%' : ''}</div>`;
  }).join('')}</div>`;
}

/** Time in zones, this week and the last 4 weeks (the #chart-zones card). */
export function zonesHtml(real, thisWeekStart, now = Date.now()) {
  const since28 = dkey(new Date(now - 27 * 864e5));
  const pick = (from) => real.filter((r) => r.id.slice(0, 10) >= from);
  const col = (title, rs) => {
    const z = zoneTotals(rs), tot = z.reduce((a, b) => a + b, 0);
    return `<div><h4>${title} <span class="muted">${tot ? `${fmtLong(tot)} &middot; ${rs.length} ride${rs.length === 1 ? '' : 's'}` : ''}</span></h4>${zoneBars(z)}</div>`;
  };
  return col('This week', pick(thisWeekStart)) + col('Last 4 weeks', pick(since28));
}

export const LOAD_INFO = {
  ctl: '<b>Chronic Training Load.</b> Your average daily training stress (TSS) over roughly the last 6 weeks (42-day weighted average, recent days count more). It climbs slowly with consistent training and is the best single number for fitness. A 1-hour ride at FTP is 100 TSS.',
  atl: '<b>Acute Training Load.</b> The same average over roughly the last week (7 days). It jumps after hard days and drops fast with rest, so it tracks fatigue. ATL above CTL means you are training harder than your recent normal.',
  tsb: '<b>Training Stress Balance</b> = fitness minus fatigue. All three are as of the start of today, so today\'s ride moves them tomorrow morning. Above +5: fresh, good for a test or race. -10 to +5: balanced. -10 to -30: productive fatigue, normal in a build block. Below -30: overreaching, back off.',
};
/** (i) button with a hover / tap tip; app.js closes open tips on a click elsewhere. */
/** @param {string} html @param {string} label */
export const infoTip = (html, label) => `<span class="info"><button type="button" class="info-btn" aria-label="What is ${esc(label)}?"><svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="3.6" r="1.25"/><rect x="5.95" y="5.9" width="2.1" height="5.5" rx=".6"/></svg></button><span class="tip" role="tooltip">${html}</span></span>`;

export async function renderTraining() {
  const lk = look();
  const locked = !syncClient(); // private: signed out shows only how to sign in
  $('#tab-training').classList.toggle('locked', locked);
  if (locked) {
    $('#sync-status').innerHTML = `Your training history is private. ${syncHint()} in <a href="#" data-open-settings="sync">Settings</a> to see it.`;
    return;
  }
  const rows = await trainingRows();
  const real = rows.filter((r) => !r.demo).map((r) => r.summary);
  const series = loadSeries(real, new Date(), 90);
  const today = series.at(-1) || { ctl: 0, atl: 0, tsb: 0 };
  const ld = loadNow(today);
  const wk = weekly(real, lk.phone ? 8 : 12);
  const thisWeek = wk.at(-1);
  const est = ftpEstimate(real);
  const card = (v, l, sub = '', info = '') => `<div class="stat">${info ? infoTip(info, l) : ''}<div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const at = ls.get('remoteIndexAt');
  $('#sync-status').innerHTML = `Synced with <b>${esc(dataRepo())}</b>${at ? `, last checked ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} <button class="ghost small" id="btn-syncnow">Sync now</button>`;
  if ($('#btn-syncnow')) $('#btn-syncnow').onclick = () => syncPending();
  $('#training-cards').innerHTML = [
    card(ld.fitness, 'Fitness (CTL)', '', LOAD_INFO.ctl), card(ld.fatigue, 'Fatigue (ATL)', '', LOAD_INFO.atl),
    card(`${ld.form > 0 ? '+' : ''}${ld.form}`, 'Form (TSB)', formLabel(ld.form), LOAD_INFO.tsb),
    card(`${thisWeek.hours}h`, 'This week', `${thisWeek.tss} TSS &middot; ${thisWeek.rides} rides`),
    (() => {
      const t = whoopDay(dkey(new Date())) || Object.values(app.whoop || {}).at(-1);
      return t?.recovery != null ? card(`<span class="rz ${recZone(t.recovery)}">${t.recovery}%</span>`, 'Recovery (WHOOP)', '') : card('-', 'Recovery (WHOOP)', 'not connected');
    })(),
    card(`${app.settings.ftp} W`, 'FTP', [est.from20min && `20-min est ${est.from20min}`, est.fromRamp && `ramp ${est.fromRamp}`].filter(Boolean).join(' &middot; ') || 'no estimate yet'),
  ].join('');
  $('#chart-load').innerHTML = svgLoad(series, lk);
  $('#chart-weekly').innerHTML = svgWeekly(wk, lk);
  $('#chart-zones').innerHTML = zonesHtml(real, thisWeek.start);
  $('#chart-curve').innerHTML = real.length ? svgCurve(powerCurve(real, 90), powerCurve(real), lk) : '<p class="muted">No rides yet.</p>';
  $('#ride-table').innerHTML = rows.length ? `<table><tr><th>Date</th><th>Ride</th><th>Time</th><th>NP</th><th>IF</th><th>TSS</th><th>HR</th><th>Intervals</th><th>Drift</th><th></th></tr>
    ${rows.map((r) => {
      const x = r.summary;
      const comp = x.compliance ? `<span class="pct ${x.compliance.min < 95 ? 'low' : 'ok'}">${x.compliance.avg}%</span> <span class="muted">min ${x.compliance.min}%</span>` : '';
      const status = r.demo ? '<span class="tag">demo</span>' : r.interrupted ? '<span class="tag">interrupted</span>' : r.synced ? '' : '<span class="tag warn">not synced</span>';
      return `<tr data-ride="${esc(x.id)}"><td>${new Date(x.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td>
      <td>${esc(x.name)} ${status}</td><td>${fmtTime(x.durSec)}</td><td>${x.np != null ? `${x.np} W` : '-'}</td><td>${x.if ?? '-'}</td><td>${x.tss}${x.tssFrom === 'hr' ? ' <span class="muted">HR</span>' : ''}</td><td>${x.avgHr ?? '-'}</td>
      <td>${comp}</td><td>${x.decoupling != null ? x.decoupling + '%' : ''}</td>
      <td class="nowrap">${r.local ? `<button class="ghost small" data-fit="${r.local.id}">.FIT</button> <button class="ghost small" data-del="${r.local.id}">Delete</button>` : ''}</td></tr>`;
    }).join('')}</table>
    <div class="ride-list">${rows.map((r) => {
      const x = r.summary;
      const status = r.demo ? ' <span class="tag">demo</span>' : r.interrupted ? ' <span class="tag">interrupted</span>' : r.synced ? '' : ' <span class="tag warn">not synced</span>';
      const right = x.compliance ? `<span class="rl-right"><span class="pct ${x.compliance.min < 95 ? 'low' : 'ok'}">${x.compliance.avg}%</span> <span class="muted">min ${x.compliance.min}%</span></span>`
        : x.decoupling != null ? `<span class="rl-right muted">Drift <b>${x.decoupling}%</b></span>` : '';
      const st = (l, v, u = '') => `<span class="rl-s"><span class="v">${v}${u ? `<small>${u}</small>` : ''}</span><span class="l">${l}</span></span>`;
      return `<div class="rl" data-ride="${esc(x.id)}"><div class="rl-head"><span class="rl-name"><span class="rl-date">${new Date(x.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>${esc(x.name)}${status}</span>${right}</div>
        <div class="rl-stats">${st('Time', fmtTime(x.durSec))}${st('NP', x.np != null ? x.np : '-', x.np != null ? ' W' : '')}${st('IF', x.if ?? '-')}${st(x.tssFrom === 'hr' ? 'TSS (HR)' : 'TSS', x.tss)}${st('HR', x.avgHr ?? '-')}</div>
        ${r.local ? `<div class="rl-btns"><button class="ghost small" data-fit="${r.local.id}">.FIT</button><button class="ghost small" data-del="${r.local.id}">Delete</button></div>` : ''}</div>`;
    }).join('')}</div>` : '<p class="muted">No rides yet.</p>';
  $$('#ride-table .rl').forEach((el) => (el.onclick = (/** @type {ElementEvent} */ e) => { if (!e.target.closest('button')) openRide(el.dataset.ride); }));
  // a row opens its ride page (the .FIT / Delete buttons keep their own job)
  $$('#ride-table tr[data-ride]').forEach((tr) => (tr.onclick = (/** @type {ElementEvent} */ e) => { if (!e.target.closest('button')) openRide(tr.dataset.ride); }));
  $$('[data-fit]').forEach((b) => (b.onclick = async () => downloadFit(await rides.get(+b.dataset.fit))));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (await ask('Synced copies stay in rodillo-data.', { title: 'Delete this ride from this Mac?', ok: 'Delete', danger: true })) { await rides.del(+b.dataset.del); renderTraining(); } }));
}
