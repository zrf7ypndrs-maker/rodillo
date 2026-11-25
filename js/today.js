// @ts-check
// Today and Calendar (#today, #overview, #week, #tab-calendar): the rider overview tiles, the hero (planned workout,
// rest day or done), the Next days strip, the month calendar with the selected day's detail, and the WHOOP recovery call
// on them. Moved out of js/app.js Nov 18 (code-health plan step 4) with no change in behavior.
// The day facts and the markup (overview tiles, Next days cards, hero pieces, month grid, day detail, the coach's call) are
// pure: data and a view `v` in, markup out, tested in test/today.mjs.
// `v` = { plan, library, rows, whoop, settings, today, gradeHex, zoneHex, prof }, which app.js builds at draw time
// (todayView()): the plan, rides, WHOOP and settings change, the colors follow the light / dark theme. The profile
// charts, meta line, main set phrase and the readout come from js/profile.js, drawn with `v.prof` (their look). The DOM part (renderOverview, renderHero, renderWeek, renderCalendar, plan views, WHOOP loading) gets app.js
// state and hooks through initToday(). Never import app.js from here.
import { flatten, totalDuration, estimateTSS, isTrack } from './engine/workout.js';
import { loadSeries, ftpEstimate, formLabel, loadNow } from './stats.js';
import { logMsg } from './ble/base.js';
import { ls, rides } from './store.js';
import { dkey, dayDate, addDays, mondayOf } from './dates.js';
import { fmtTime } from './ridepage.js';
import { LOAD_INFO, infoTip } from './training.js';
import { profileSvg, woMeta, isSim, workSummary, bindProfileHover } from './profile.js';
import { $, esc } from './ui.js';

// from app.js, set by initToday()
/** @typedef {import('./types.js').TodayDeps} Deps */
/** @typedef {import('./types.js').TodayView} TodayView */
/** @typedef {import('./types.js').Workout} Workout */
/** @typedef {import('./types.js').RideSummary} RideSummary */
/** @typedef {ReturnType<typeof dayInfo>} DayInfo What's planned and ridden on a day. */
/** @type {Deps['app']} */ let app;
/** @type {Deps['view']} */ let view;
/** @type {Deps['isPhone']} */ let isPhone;
/** @type {Deps['syncClient']} */ let syncClient;
/** @type {Deps['syncHint']} */ let syncHint;
/** @type {Deps['startFree']} */ let startFree;
/** @type {Deps['startWorkout']} */ let startWorkout;
/** @type {Deps['openRide']} */ let openRide;
/** @type {Deps['setTab']} */ let setTab;

/** Wires the Calendar's month buttons. Called once from app.js, where that wiring sat, before anything renders. */
/** @param {import('./types.js').TodayDeps} deps */
export function initToday(deps) {
  ({ app, view, isPhone, syncClient, syncHint, startFree, startWorkout, openRide, setTab } = deps);
  const shiftMonth = (n) => { const [y, m] = (app.calMonth || dkey(new Date()).slice(0, 7)).split('-').map(Number); const d = new Date(y, m - 1 + n, 1, 12); app.calMonth = dkey(d).slice(0, 7); renderCalendar(); };
  $('#cal-prev').onclick = () => shiftMonth(-1);
  $('#cal-next').onclick = () => shiftMonth(1);
  $('#cal-today').onclick = () => { app.calMonth = null; app.calSel = null; renderCalendar(); };
}

// ------------------------------------------------------------------ rider overview (top of home)
export const fmtHours = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

/** Recovery, this week's riding vs plan, fatigue/form, FTP. Uses the same numbers as the Training tab. */
function renderOverview() {
  const el = $('#overview');
  el.innerHTML = overviewHtml(new Date(), isPhone(), view());
  bindRecoveryAdvice(el);
}

/** Phone recovery card: ring, % and the call from the hero line. */
function recCardHtml(pct, z, hero, v) {
  const C = 2 * Math.PI * 27;
  const ring = `<svg class="rec-ring ${z}" viewBox="0 0 64 64" aria-hidden="true"><circle class="trk" cx="32" cy="32" r="27"/>${pct != null ? `<circle class="arc" cx="32" cy="32" r="27" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}"/>` : ''}</svg>`;
  const call = hero.replace('class="hero-rec"', 'class="rc-call"');
  return `<div class="rec-card">
      <div class="rc-ring">${ring}<span class="rc-v">${pct != null ? `${pct}<small>%</small>` : `<span class="none">${v.whoop ? 'Not yet' : 'Off'}</span>`}</span></div>
      <div class="rc-text"><div class="rc-l">Recovery</div>${call}${pct != null ? '' : `<div class="rc-sub">${v.whoop ? 'not scored yet' : 'no WHOOP'}</div>`}</div>
    </div>`;
}

/**
 * FTP over the last 90 days (Agustín: "Feels left out"): every ride stores the FTP it was ridden at; the line ends at today's
 * setting. Returns the tile's step line and its sub line.
 * @param {Date} now @param {TodayView} v
 */
function ftpTrend(real, now, v, est) {
  const since = dkey(addDays(now, -90));
  // a ride sits at its day's local noon, but never after now (a ride from earlier this morning would run off the right edge)
  const fp = real.filter((r) => r.ftp && r.id.slice(0, 10) >= since).sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [Math.min(+dayDate(r.id.slice(0, 10)), +now), r.ftp]);
  fp.push([+now, v.settings.ftp]);
  let ftpViz = '', ftpSub = '';
  if (fp.length > 1) {
    const t0 = fp[0][0], t1 = +now, vs = fp.map((x) => x[1]), lo2 = Math.min(...vs) - 8, hi2 = Math.max(...vs) + 4;
    const X = (t) => ((Math.max(t, t0) - t0) / Math.max(1, t1 - t0)) * 200, Y = (v) => 26 - ((v - lo2) / (hi2 - lo2)) * 22;
    let d = `M${X(fp[0][0]).toFixed(1)},${Y(fp[0][1]).toFixed(1)}`;
    for (let i = 1; i < fp.length; i++) d += ` H${X(fp[i][0]).toFixed(1)} V${Y(fp[i][1]).toFixed(1)}`;
    ftpViz = `<div class="ov-ftp"><svg viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true"><path class="ar" d="${d} V28 H0 Z"/><path d="${d}" vector-effect="non-scaling-stroke"/></svg><i style="top:${((Y(v.settings.ftp) / 28) * 100).toFixed(1)}%"></i></div>`;
    const dW = v.settings.ftp - fp[0][1], from = new Date(fp[0][0]).toLocaleDateString([], { month: 'short', day: 'numeric' });
    ftpSub = dW ? `<b class="${dW > 0 ? 'up' : ''}">${dW > 0 ? '+' : ''}${dW} W</b> since ${from}` : `same since ${from}`;
  } else if (est.fromRamp) ftpSub = `ramp test ${est.fromRamp} W`;
  return { ftpViz, ftpSub };
}

/** The overview tiles at `now`; `ph` = the phone layout (three tiles and the recovery card). */
/** @param {Date} now @param {boolean} ph Phone layout. @param {TodayView} v */
export function overviewHtml(now, ph, v) {
  const real = (v.rows || []).filter((r) => !r.demo).map((r) => r.summary);
  const series = loadSeries(real, now, 90);
  const t = series.at(-1) || { ctl: 0, atl: 0, tsb: 0 };
  const monday = mondayOf(now);
  const weekKeys = Array.from({ length: 7 }, (_, i) => dkey(addDays(monday, i)));
  const ridden = real.filter((r) => weekKeys.includes(r.id.slice(0, 10)));
  const doneSec = ridden.reduce((a, r) => a + (r.durSec || 0), 0);
  // Planned = this week's plan workouts, optional days left out.
  const planned = weekKeys.map((k) => dayInfo(k, v)).filter((d) => d.workout && !d.optional);
  const planSec = planned.reduce((a, d) => a + totalDuration(d.workout), 0);
  // Recovery: only the % (HRV / RHR / sleep live in the WHOOP app, Agustín, Nov 13). Phone: its own card (ring + the call from
  // the hero line); the hero line and the tile hide there.
  const w = whoopDay(dkey(now), v);
  const today = dayInfo(dkey(now), v);
  const pct = w?.recovery != null ? w.recovery : null, z = pct != null ? recZone(pct) : '';
  const recCard = recCardHtml(pct, z, heroRecovery(today, v), v);
  const ld = loadNow(t);
  const est = ftpEstimate(real);
  // Premium look tiles (desktop Nov 13; phone too since Nov 13, 10:45 pm): label on top, number, then one small visual per
  // tile. Desktop: four tiles, the recovery call stays in the hero line. Phone: the recovery card above, then three tiles.
  const dTile = (cls, label, v, viz, sub, info = '') => `<div class="stat ov2 ${cls}">${info ? infoTip(info, label) : ''}<div class="ol">${label}</div><div class="v">${v}</div>${viz}${sub ? `<div class="os">${sub}</div>` : ''}</div>`;
  const recViz = `<div class="ov-bar ${z}">${pct != null ? `<i style="width:${pct}%"></i>` : ''}</div>`;
  // this week, Monday to Sunday: ring in the planned workout's zone color, filled once ridden; strength / rest = small dot
  const dayDots = weekKeys.map((k, i) => {
    const d = dayInfo(k, v);
    const st = d.workout ? (d.done ? 'done' : 'plan') : d.done ? 'done' : 'off';
    return `<span class="wd ${st}${d.isToday ? ' today' : ''}" style="--c:${d.workout ? workoutColor(d.workout, v) : 'var(--ink)'}"><i></i><em>${'MTWTFSS'[i]}</em></span>`;
  }).join('');
  // form on the same fixed -45..+25 scale as the Training strip; marker in whichever of fitness / fatigue is ahead
  const lo = -45, hi = 25, pos = (v) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100;
  const formViz = `<div class="ov-form"><span class="band" style="left:${pos(-10)}%;width:${pos(5) - pos(-10)}%"></span><span class="zero" style="left:${pos(0)}%"></span><span class="mk ${ld.form >= 0 ? 'fit' : 'fat'}" style="left:${pos(ld.form)}%"></span></div>`;
  const wkg = (v.settings.ftp / (v.settings.riderKg || 77)).toFixed(1);
  const { ftpViz, ftpSub } = ftpTrend(real, now, v, est);
  const html =
    dTile('rec-tile', 'Recovery', pct != null ? `<span class="rz ${z}">${pct}%</span>` : `<span class="none">${v.whoop ? 'Not yet' : 'Off'}</span>`, recViz, pct != null ? '' : (v.whoop ? 'not scored yet' : 'no WHOOP'))
    + dTile('', 'This week', `${fmtHours(doneSec)}${planSec ? ` <span class="of">/ ${fmtHours(planSec)}</span>` : ''}`, `<div class="ov-week">${dayDots}</div>`, '')
    + (ph
      ? dTile('', 'Form', `${ld.form > 0 ? '+' : ''}${ld.form}`, formViz, formLabel(ld.form).toLowerCase(), `${LOAD_INFO.tsb}<br><br>${LOAD_INFO.atl} Fatigue now: ${ld.fatigue}.`)
        + dTile('', 'FTP', `${v.settings.ftp} <span class="of">W</span>`, ftpViz, `${wkg} W/kg`)
        + recCard // last: the phone pulls it to the top with order: -1
      : dTile('', 'Form', `${ld.form > 0 ? '+' : ''}${ld.form} <span class="of">${formLabel(ld.form).toLowerCase()}</span>`, formViz, `fitness ${ld.fitness} &middot; fatigue ${ld.fatigue}`, `${LOAD_INFO.tsb}<br><br>${LOAD_INFO.atl} Fatigue now: ${ld.fatigue}.`)
        + dTile('', 'FTP', `${v.settings.ftp} <span class="of">W &middot; <b>${wkg}</b> W/kg</span>`, ftpViz, ftpSub));
  return html;
}

// ------------------------------------------------------------------ plan: week carousel + calendar
// day keys: dkey, dayDate, addDays, mondayOf from js/dates.js

/** @param {Workout} w @param {TodayView} v */
export function workoutColor(w, v) {
  const segs = flatten(w);
  if (segs.every((x) => x.kind === 'sim')) return v.gradeHex(Math.max(...segs.map((x) => x.grade ?? 0))); // slope day = its steepest grade
  const work = Math.max(...segs.filter((x) => x.kind === 'erg' && x.dur >= 30).map((x) => (x.from + x.to) / 2));
  return v.zoneHex(work);
}

/** What's planned and what was ridden on a given date. */
/** @param {string} key Day key. @param {TodayView} v */
export function dayInfo(key, v) {
  const entry = v.plan?.days?.[key];
  const w = entry && v.library.find((x) => x.id === entry);
  const ridden = (v.rows || []).filter((r) => !r.demo && r.summary.id.slice(0, 10) === key).map((r) => r.summary);
  const done = w ? ridden.find((r) => r.workoutId === w.id) || ridden[0] : ridden[0];
  return {
    key, workout: w || null, kind: w ? 'ride' : entry || null,
    note: v.plan?.notes?.[key] || '', ridden, done, optional: (v.plan?.optional || []).includes(key),
    isToday: key === v.today, isPast: key < v.today,
  };
}

/** @param {DayInfo} info @param {TodayView} v */
export function dayCardHtml(info, v) {
  const d = dayDate(info.key);
  const dow = d.toLocaleDateString([], { weekday: 'short' });
  let body, status = '';
  // Slim cards for the "Next days" strip (today is the hero above it): name + duration, no chart.
  if (info.workout) {
    const w = info.workout;
    body = `<div class="d-name">${esc(w.name)}</div><div class="d-meta">${woMeta(w)}</div>`;
  } else if (info.kind === 'strength') body = '<div class="d-name muted">Strength</div>';
  else if (info.kind === 'rest') body = '<div class="d-name muted">Rest</div>';
  else body = '<div class="d-name muted">Nothing planned</div>';
  if (info.done) status = `<div class="d-done">&#10003; ${info.done.workoutId === info.workout?.id ? 'Done' : esc(info.done.name)} &middot; ${info.done.tss} TSS</div>`;
  else if (info.workout && info.isPast) status = `<div class="d-missed">${info.optional ? 'Skipped (optional)' : 'Missed'}</div>`;
  else if (info.workout && info.optional) status = '<div class="d-missed">Optional</div>';
  return `<div class="day ${info.workout ? '' : 'nowo'} ${info.isPast ? 'past' : ''} ${info.done ? 'done' : ''}" data-day="${info.key}" style="--c:${info.workout ? workoutColor(info.workout, v) : 'transparent'}" tabindex="0">
    <div class="d-top"><span class="d-dow">${dow} ${d.getDate()}</span></div>${body}${status}</div>`;
}


// Inline so the crank can spin on hover / controller focus (css: .bike-ico). Same drawing as the old icons/bike.png.
export const BIKE_ICO = '<svg class="bike-ico" viewBox="0 0 156 96" aria-hidden="true">'
  + '<g fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="32.5" cy="64.5" r="25.5"/><circle cx="122.5" cy="64.5" r="25.5"/>'
  + '<path d="M32.5 64.5H73L106 28H56.5zM32.5 64.5L57 28M73 64.5L54 19M100 15L122.5 64.5M100 15L117 12"/></g>'
  + '<rect x="43" y="15" width="25" height="7.5" rx="3.75" fill="currentColor"/>'
  + '<g class="crank"><circle cx="73" cy="64.5" r="7" fill="currentColor"/>'
  + '<path d="M73 51V78" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></g></svg>';
const PLAY_ICO = '<svg class="play-ico" viewBox="0 0 16 18" aria-hidden="true"><path d="M2 1.5v15l13-7.5z"/></svg>';

/** Recovery + the coach's call (or the built-in advice), one line under the profile. */
/** @param {DayInfo} today @param {TodayView} v */
export function heroRecovery(today, v) {
  const d = whoopDay(today.key, v);
  const decided = coachDecision(today.key, v);
  const z = d?.recovery != null ? recZone(d.recovery) : '';
  // The number lives in the overview tile; this line is only the call (dot = zone).
  const rec = z ? `<span class="rdot ${z}"></span><span>` : '<span>';
  if (decided) return `<div class="hero-rec">${rec}${decided.replace(/^<p class="coach-call">|<\/p>$/g, '')}</span></div>`;
  if (!z) return '';
  const adv = today.workout && !today.done ? recoveryAdvice(today, v) : '';
  // recoveryAdvice() returns a block; pull its sentence and buttons into the hero line.
  const p = adv.match(/<p>(.*?)<\/p>/)?.[1] || '';
  if (!p) return '';
  const btns = adv.match(/<div class="row-btns">(.*?)<\/div>/s)?.[1] || '';
  return `<div class="hero-rec">${rec}${p}</span>${btns ? `<span class="row-btns">${btns}</span>` : ''}</div>`;
}

const DONE_ICO = '<svg class="done-ico" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16"/><path d="M9 16.5l4.8 4.8L23.5 11"/></svg>';
const SEE_ICO = '<svg class="see-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>';

/** Today's hero once the planned ride is done: result headline, the ride's real numbers, See ride + Free ride. */
/** Stat row of a finished ride (done hero, Calendar day): only the numbers the ride has. */
/** @param {Workout | null} w @param {RideSummary} r @param {TodayView} v */
export function rideStatsHtml(w, r, v) {
  const same = !!w && r.workoutId === w.id;
  const c = r.compliance;
  const stat = (v, l, extra = '', cls = '') => `<div class="hs"><div class="v ${cls}">${v}</div><div class="l"><b>${l}</b>${extra ? `<span class="wide-only"> &middot; ${extra}</span>` : ''}</div></div>`;
  return [
    r.durSec != null && stat(fmtTime(r.durSec), 'Time', same ? `plan ${fmtTime(totalDuration(w))}` : ''),
    r.np && stat(`${r.np} W`, 'NP', r.avgP ? `avg ${r.avgP} W` : ''),
    r.tss != null && stat(r.tss, 'TSS', same && !isSim(w) ? `plan ~${estimateTSS(w)}` : ''),
    r.if && stat(Number(r.if).toFixed(2), 'IF', r.kj ? `${r.kj} kJ` : ''),
    r.avgHr && stat(r.avgHr, 'Avg HR', r.maxHr ? `max ${r.maxHr}` : '', 'hr'),
    c && stat(`${c.avg}%`, 'Intervals', `${c.reps} ${c.reps === 1 ? 'rep' : 'reps'} &middot; min ${c.min}%`, c.min >= 95 ? 'ok' : 'warn'),
  ].filter(Boolean).join('');
}

/** "All 3 reps on target." / "Weakest rep at 88% of target." */
export const complianceLine = (c) => !c ? '' : c.min >= 95 ? `All ${c.reps} ${c.reps === 1 ? 'rep' : 'reps'} on target.` : `Weakest rep at ${c.min}% of target.`;

/** @param {Workout | null} w @param {RideSummary} r @param {string} date Day key. @param {TodayView} v */
export function heroDoneBody(w, r, date, v) {
  const same = r.workoutId === w.id;
  const at = r.start ? new Date(r.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const c = r.compliance;
  const sub = !same ? `Instead of ${esc(w.name)}.`
    : complianceLine(c);
  const stats = rideStatsHtml(w, r, v);
  return `<div class="hero-main">
      <div class="hero-text">
        <div class="hero-top"><b>Today</b><span>${date}${at ? ` &middot; ${at}` : ''}</span></div>
        <h2 class="hero-name">${DONE_ICO}<span><span class="ok">Done.</span> ${esc(same ? w.name : r.name)}</span></h2>
        ${sub ? `<p class="hero-desc">${sub}</p>` : ''}
      </div>
      <div class="hero-btns">
        <button class="primary hero-see" id="hero-see">${SEE_ICO}See ride</button>
        <button class="ghost hero-free" id="btn-free"><span class="hs-label">Free ride</span>${BIKE_ICO}</button>
      </div>
    </div>
    ${stats ? `<div class="hero-stats">${stats}</div>` : ''}
    ${same ? `<div class="hero-prof prof-hover">${profileSvg(w, v.prof, 1000, 100)}</div>` : ''}`;
}

/** Phone hero numbers (premium look, Nov 12): the main set's watts big with the set under it, then time and TSS.
 *  Desktop hides .hero-nums and keeps the one-line .hero-meta. Real climbs keep .hero-meta (ascent) on the phone too. */
/** @param {Workout} w @param {string} work The main set phrase. @param {TodayView} v */
export function heroNums(w, work, v) {
  const segs = flatten(w);
  if (isTrack(segs)) return '';
  const dist = segs.filter((x) => x.dist).reduce((a, x) => a + x.dist, 0);
  const mins = Math.round(totalDuration(w) / 60);
  const m = work && work.match(/\sat\s([\d/]+)\sW/);
  const items = [];
  if (m) items.push([m[1], 'W', work.replace(m[0], '').trim(), 'main']);
  items.push([`${dist ? '~' : ''}${mins}`, 'min', 'Time']);
  if (dist) items.push([+(dist / 1000).toFixed(1), 'km', 'Distance']);
  else if (!isSim(w)) items.push([`~${estimateTSS(w)}`, '', 'TSS']);
  return `<div class="hero-nums">${items.map(([v, u, l, c]) => `<div class="hn${c ? ` ${c}` : ''}"><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div><div class="l">${l}</div></div>`).join('')}</div>`;
}

/** Today: a full-width card in the color of the day's main effort, with Start up front and Free ride as the second choice. */
export function renderHero() {
  const el = $('#today');
  const v = view();
  const today = dayInfo(dkey(new Date()), v);
  const w = today.workout;
  const date = dayDate(today.key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const src = !syncClient()
    ? `<p class="plan-src">Signed out: your plan and history are private. ${syncHint()} in <a href="#" data-open-settings="sync">Settings</a> to see them.</p>`
    : !app.plan ? ''
    : app.coachNoRepo ? `<p class="plan-src">Can't reach your data repo <b>${esc(app.coachNoRepo)}</b>. Create it on GitHub (private) and install the Rodillo GitHub App on it, then reload. Another repo name goes in <a href="#" data-open-settings="sync">Settings</a>.</p>`
    : app.coachError ? `<p class="plan-src">Couldn't load the coach plan (${esc(app.coachError.slice(0, 80))}). Showing the last saved copy. Check sync in <a href="#" data-open-settings="sync">Settings</a>.</p>` : '';
  const free = (primary) => `<button class="${primary ? 'primary' : 'ghost'} hero-free" id="btn-free"><span class="hs-label">${primary ? 'Start free ride' : 'Free ride'}</span>${BIKE_ICO}</button>`;
  let body;
  // Done = the planned workout, or another structured workout in its place (e.g. the red-recovery Zone 2 swap).
  // A free ride alone leaves today's workout open.
  const doneRide = w && (today.ridden.find((r) => r.workoutId === w.id) || today.ridden.find((r) => r.workoutId));
  if (doneRide) {
    // Done: a quiet sheet card with the ride's real numbers (Next days below shows what's next).
    el.innerHTML = `${src}<section class="hero done" style="--c:${workoutColor(w, v)}" aria-label="Today, done">${heroDoneBody(w, doneRide, date, v)}</section>`;
    $('#btn-free').onclick = (e) => startFree(/** @type {HTMLElement} */ (e.currentTarget));
    $('#hero-see').onclick = () => openRide(doneRide.id);
    if (doneRide.workoutId === w.id) bindProfileHover(el.querySelector('.hero-prof'), w, v.prof);
    return;
  }
  if (w) {
    const work = workSummary(w, v.prof.ftp);
    const status = today.done
      ? `<div class="hero-done"><span class="ck">&#10003;</span> ${today.done.workoutId === w.id ? 'Done' : esc(today.done.name)} &middot; ${today.done.tss} TSS<button class="ghost small hero-done-see" data-ride="${esc(today.done.id)}">See ride</button></div>` : '';
    const start = `<button class="primary hero-start" id="hero-start">${PLAY_ICO}<span class="hs-label">Start workout</span></button>`;
    body = `<div class="hero-main">
        <div class="hero-text">
          <div class="hero-top"><b>Today</b><span>${date}</span></div>
          <h2 class="hero-name">${esc(w.name)}${w._source === 'coach' ? ' <span class="tag coach">coach</span>' : ''}</h2>
          <div class="hero-meta">${woMeta(w)}${work ? ` &middot; ${work}` : ''}</div>${heroNums(w, work, v)}
          ${today.note ? `<p class="hero-desc"><b>Coach:</b> ${esc(today.note)}</p>` : w.description ? `<p class="hero-desc">${esc(w.description)}</p>` : ''}
          ${status}
        </div>
        <div class="hero-btns">${start}${free(false)}</div>
      </div>
      <div class="hero-prof prof-hover">${profileSvg(w, v.prof, 1000, 100)}</div>
      ${heroRecovery(today, v)}`;
  } else {
    const [name, sub] = today.kind === 'strength' ? ['Strength day', 'Gym day, no ride planned.']
      : today.kind === 'rest' ? ['Rest day', 'Nothing planned. Spin easy if you feel like it.']
      : [app.plan ? 'Nothing planned' : 'No plan loaded', 'Set the grade with D-pad up/down and ride it with your gears.'];
    body = `<div class="hero-main">
        <div class="hero-text">
          <div class="hero-top"><b>Today</b><span>${date}</span></div>
          <h2 class="hero-name">${name}</h2>
          <p class="hero-desc">${sub}</p>
          ${today.done ? `<div class="hero-done"><span class="ck">&#10003;</span> ${esc(today.done.name)} &middot; ${today.done.tss} TSS<button class="ghost small hero-done-see" data-ride="${esc(today.done.id)}">See ride</button></div>` : ''}
        </div>
        <div class="hero-btns">${free(true)}</div>
      </div>${heroRecovery(today, v)}`;
  }
  el.innerHTML = `${src}<section class="hero ${w ? '' : 'nowo'}${body.includes('hero-nums') ? ' has-nums' : ''}" style="--c:${w ? workoutColor(w, v) : 'transparent'}" aria-label="Today">${body}</section>`;
  $('#btn-free').onclick = (e) => startFree(/** @type {HTMLElement} */ (e.currentTarget));
  el.querySelectorAll('.hero-done-see').forEach((/** @type {HTMLElement} */ b) => (b.onclick = () => openRide(b.dataset.ride)));
  const s = $('#hero-start');
  if (s) s.onclick = () => startWorkout(w, 1, s);
  if (w) bindProfileHover(el.querySelector('.hero-prof'), w, v.prof);
  bindRecoveryAdvice(el);
}

export function renderWeek() {
  const el = $('#week');
  const v = view();
  renderHero();
  renderOverview();
  if (!app.plan) { el.classList.add('hidden'); return; }
  // Re-renders (plan reload, tab switch, WHOOP) keep the scroll position;
  // only a new day (or the first render) starts the strip at tomorrow again.
  const prev = $('#week-strip');
  const keepScroll = prev && prev.dataset.start === dkey(new Date()) ? prev.scrollLeft : 0;
  el.classList.remove('hidden');
  // Today lives in the hero; the strip is the next 13 days (history lives in Calendar and Training).
  const start = new Date(); start.setHours(12, 0, 0, 0);
  const days = Array.from({ length: 13 }, (_, i) => dayInfo(dkey(addDays(start, i + 1)), v));
  el.innerHTML = `<div class="week-head"><h3 class="eyebrow">Next days</h3>
    <div class="row-btns"><button class="ghost small" data-scroll="-1" aria-label="Earlier">&lsaquo;</button><button class="ghost small" data-scroll="1" aria-label="Later">&rsaquo;</button></div></div>
    <div class="week-strip" id="week-strip" data-start="${dkey(start)}">${days.map((d) => dayCardHtml(d, v)).join('')}</div>`;
  const strip = $('#week-strip');
  el.querySelectorAll('[data-scroll]').forEach((/** @type {HTMLElement} */ b) => (b.onclick = () => strip.scrollBy({ left: +b.dataset.scroll * strip.clientWidth * 0.8, behavior: 'smooth' })));
  const back = /** @type {HTMLButtonElement} */ (el.querySelector('[data-scroll="-1"]'));
  const syncBack = () => (back.disabled = strip.scrollLeft <= 4);
  strip.addEventListener('scroll', syncBack, { passive: true });
  strip.scrollLeft = keepScroll;
  syncBack();
  bindDayCards(el);
  bindRecoveryAdvice(el);
}

function bindDayCards(root) {
  root.querySelectorAll('[data-startday]').forEach((/** @type {HTMLElement} */ b) => (b.onclick = (e) => { e.stopPropagation(); const i = dayInfo(b.dataset.startday, view()); if (i.workout) startWorkout(i.workout); }));
  root.querySelectorAll('.day[data-day], .cal-cell[data-day]').forEach((/** @type {HTMLElement} */ c) => (c.onclick = () => { app.calMonth = c.dataset.day.slice(0, 7); app.calSel = c.dataset.day; setTab('calendar'); }));
}

export function renderCalendar() {
  const now = new Date();
  const v = view();
  const ym = app.calMonth || dkey(now).slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const sel = app.calSel || dkey(now);
  $('#cal-title').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });
  $('#cal-grid').innerHTML = calGridHtml(ym, sel, v);
  $('#cal-grid').querySelectorAll('.cal-cell').forEach((/** @type {HTMLElement} */ c) => (c.onclick = () => { app.calSel = c.dataset.day; if (c.dataset.day.slice(0, 7) !== ym) app.calMonth = c.dataset.day.slice(0, 7); renderCalendar(); }));
  // detail for the selected day
  const info = dayInfo(sel, v);
  $('#cal-detail').innerHTML = calDayHtml(sel, v);
  $('#cal-detail').style.setProperty('--c', info.workout ? workoutColor(info.workout, v) : 'transparent'); // phone: soft glow in the day's color
  $('#cal-detail').querySelectorAll('[data-ride]').forEach((/** @type {HTMLElement} */ b) => (b.onclick = () => openRide(b.dataset.ride)));
  $('#cal-detail').querySelectorAll('[data-startday]').forEach((/** @type {HTMLElement} */ b) => (b.onclick = () => startWorkout(info.workout)));
  if (info.workout) bindProfileHover($('#cal-detail .cal-prof'), info.workout, v.prof);
}

/** The month grid (Monday first, up to six weeks) for `ym` = "YYYY-MM", with the day `sel` selected. */
/** @param {string} ym 'YYYY-MM'. @param {string} sel Day key. @param {TodayView} v */
export function calGridHtml(ym, sel, v) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const start = mondayOf(first);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.getMonth() !== m - 1) break;
    cells.push(d);
  }
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('') +
    cells.map((d) => {
      const info = dayInfo(dkey(d), v);
      const chip = info.workout ? `<div class="cal-chip" style="--c:${workoutColor(info.workout, v)}">${esc(info.workout.name)}<span>${Math.round(totalDuration(info.workout) / 60)}'</span></div>`
        : info.kind === 'strength' ? '<div class="cal-chip ghost">Strength</div>' : info.kind === 'rest' ? '<div class="cal-chip ghost">Rest</div>' : '';
      const done = info.done ? `<div class="cal-done">&#10003; ${info.done.tss} TSS</div>` : info.workout && info.isPast ? `<div class="cal-missed">${info.optional ? 'optional' : 'missed'}</div>` : info.optional ? '<div class="cal-missed">optional</div>' : '';
      return `<div class="cal-cell ${d.getMonth() !== m - 1 ? 'other' : ''} ${info.isToday ? 'today' : ''} ${info.key === sel ? 'sel' : ''}" data-day="${info.key}">
        <div class="cal-num">${d.getDate()}</div>${chip}${done}</div>`;
    }).join('');
}

/** The selected day's detail: the result once the planned workout is ridden, else the plan; then the coach's call,
 *  WHOOP and any other rides that day. */
/** @param {string} sel Day key. @param {TodayView} v */
export function calDayHtml(sel, v) {
  const info = dayInfo(sel, v);
  const date = dayDate(sel).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  let html = `<h3>${date}</h3>`;
  // The planned workout already ridden: lead with the result, not the plan (no Start, no pre-ride coach note).
  const doneRide = info.workout && info.ridden.find((r) => r.workoutId === info.workout.id);
  if (doneRide) {
    const w = info.workout, r = doneRide;
    const at = r.start ? new Date(r.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const sub = [complianceLine(r.compliance), at && `Ridden at ${at}.`].filter(Boolean).join(' ');
    html += `<div class="cal-wo cal-done-wo">
      <div class="cal-done-head">${DONE_ICO}<div><div class="cal-done-name"><span class="ok">Done.</span> ${esc(w.name)}</div>${sub ? `<div class="cal-done-sub">${sub}</div>` : ''}</div></div>
      <div class="hero-stats cal-stats">${rideStatsHtml(w, r, v)}</div>
      <div class="cal-prof prof-hover">${profileSvg(w, v.prof, 600, 60)}</div>
      <button class="primary small cal-see-main" data-ride="${esc(r.id)}">${SEE_ICO}See ride</button></div>`;
  } else if (info.workout) {
    const w = info.workout;
    html += `<div class="cal-wo"><div class="wo-top"><div class="wo-name">${esc(w.name)}</div><div class="wo-meta">${woMeta(w)}</div></div><div class="cal-prof prof-hover">${profileSvg(w, v.prof, 600, 60)}</div>
      ${info.note && !info.isPast ? `<p><b>Coach:</b> ${esc(info.note)}</p>` : ''}<p class="muted">${esc(w.description)}</p>
      ${info.isPast ? `<p class="cal-missed-line">${info.optional ? 'Skipped (optional).' : 'Missed.'}</p>` : ''}
      <button class="${info.isPast ? 'ghost' : 'primary'} small" data-startday="${sel}">${info.isToday ? 'Start' : 'Ride it now'}</button></div>`;
  } else html += `<p class="muted">${info.kind === 'strength' ? 'Strength day: no ride planned.' : info.kind === 'rest' ? 'Rest day.' : 'Nothing planned.'}</p>`;
  html += coachDecision(sel, v);
  const wd = whoopDay(sel, v);
  if (wd?.recovery != null) html += `<div class="cal-ride" style="color:var(--muted)">WHOOP: recovery <b class="rz ${recZone(wd.recovery)}">${wd.recovery}%</b></div>`; // recovery only (Agustín, Nov 13)
  for (const r of info.ridden.filter((x) => x !== doneRide)) {
    html += `<div class="cal-ride">&#10003; <b>${esc(r.name)}</b> &middot; ${fmtTime(r.durSec)}${r.np != null ? ` &middot; NP ${r.np} W` : ''} &middot; TSS ${r.tss}${r.tssFrom === 'hr' ? ' (from HR)' : ''}${r.avgHr ? ` &middot; HR ${r.avgHr}` : ''}${r.compliance ? ` &middot; intervals ${r.compliance.avg}% (min ${r.compliance.min}%)` : ''}<button class="ghost small cal-see" data-ride="${esc(r.id)}">${SEE_ICO}See ride</button></div>`;
  }
  return html;
}

// ------------------------------------------------------------------ WHOOP recovery
/** @param {number} r Recovery, %. */
export const recZone = (r) => (r >= 67 ? 'green' : r >= 34 ? 'yellow' : 'red');
/** @param {string} key Day key. @param {TodayView} [v] */
export const whoopDay = (key, v = view()) => v.whoop?.[key];

/** @param {Workout} w */
export function isHard(w) {
  if (!w) return false;
  if ((w.tags || []).some((t) => ['vo2', 'threshold', 'test', 'max'].includes(t))) return true;
  return flatten(w).some((x) => x.kind === 'erg' && x.dur >= 120 && (x.from + x.to) / 2 >= 0.88);
}

/** Coach's read of today's recovery vs today's session. */
/** @param {DayInfo} today @param {TodayView} v */
export function recoveryAdvice(today, v) {
  if (!today) return '';
  const d = whoopDay(today.key, v);
  // The recovery number itself lives only in the overview tile at the top; here just the call.
  // The morning coach run already weighed recovery against the plan: show its call, don't adjust twice.
  const decided = coachDecision(today.key, v);
  if (d?.recovery == null) return decided;
  const z = recZone(d.recovery), w = today.workout;
  if (decided) return `<div class="rec-advice ${z} stacked">${decided}</div>`;
  if (!w || today.done) return '';
  let advice = '', btns = '';
  if (z === 'red' && isHard(w)) {
    advice = `Hard session on a red recovery day is a bad trade. Swap to easy Zone 2, or ride it at 90%.`;
    btns = `<button class="primary small" data-rec="swap">Swap to Zone 2, 60 min</button><button class="ghost small" data-rec="0.9">Ride it at 90%</button>`;
  } else if (z === 'red') {
    advice = 'Red recovery: keep it truly easy today; drop to 95% if HR runs high.';
    btns = `<button class="ghost small" data-rec="0.95">Ride at 95%</button>`;
  } else if (z === 'yellow' && isHard(w)) {
    advice = 'Yellow recovery: ride as planned. If the first rep feels like a fight, nudge effort down 2-3% with the left shifter.';
    btns = `<button class="ghost small" data-rec="0.97">Start at 97%</button>`;
  } else advice = 'Green light: ride as planned.';
  return `<div class="rec-advice ${z}"><p>${advice}</p>${btns ? `<div class="row-btns">${btns}</div>` : ''}</div>`;
}

export const DECISION_LABEL = { kept: 'Ride as planned', scaled: 'Adjusted', swapped: 'Swapped', moved: 'Moved', rest: 'Rest instead' };

/** The daily coach run's decision for a day (plan.daily[key]), as HTML. */
/** @param {string} key Day key. @param {TodayView} v */
export function coachDecision(key, v) {
  const d = v.plan?.daily?.[key];
  if (!d?.reason) return '';
  const label = DECISION_LABEL[d.action] || 'Coach';
  return `<p class="coach-call"><span class="tag coach">coach &middot; ${esc(label)}</span> ${esc(d.reason)}</p>`;
}

function bindRecoveryAdvice(root) {
  root.querySelectorAll('[data-rec]').forEach((b) => (b.onclick = () => {
    const today = dayInfo(dkey(new Date()), view());
    if (b.dataset.rec === 'swap') { const z2 = app.library.find((x) => x.id === 'z2-60'); if (z2) startWorkout(z2); }
    else if (today.workout) startWorkout(today.workout, Number(b.dataset.rec));
  }));
}

async function loadWhoop() {
  const gh = syncClient();
  app.whoop = gh ? ls.get('whoop', null) : null; // private: signed in only
  if (!gh) return;
  try {
    const r = await gh.getJson('whoop/daily.json');
    if (r?.json?.days) { app.whoop = r.json.days; ls.set('whoop', app.whoop); }
  } catch (e) { logMsg('whoop', e.message); }
}

export async function refreshPlanViews() {
  app.rows = await trainingRows();
  await loadWhoop();
  renderWeek();
  if (app.tab === 'calendar') renderCalendar();
}

export async function trainingRows() {
  if (!syncClient()) return []; // ride history is private: nothing shows signed out, not even a cached copy
  const remote = ls.get('remoteIndex', []);
  let local = [];
  try { local = (await rides.list()).filter((r) => r.status === 'done' || r.status === 'inprogress'); } catch { /* no idb */ }
  const gone = new Set(ls.get('pendingDeletes', [])); // deleted here, rodillo-data not told yet
  const rows = new Map();
  for (const r of remote) if (!gone.has(r.id)) rows.set(r.id, { summary: r, synced: true });
  for (const l of local) {
    if (!l.summary?.id || gone.has(l.summary.id)) continue; // rides from before history tracking; deleted ones
    const row = rows.get(l.summary.id) || { summary: l.summary, synced: false };
    row.local = l;
    row.demo = l.demo;
    if (l.status === 'inprogress') row.interrupted = true;
    rows.set(l.summary.id, row);
  }
  return [...rows.values()].sort((x, y) => (x.summary.id < y.summary.id ? 1 : -1));
}
