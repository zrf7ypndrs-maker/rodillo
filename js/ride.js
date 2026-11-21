// @ts-check
// The desktop ride screen (#ride): interval card, Next card, tiles, interval list, the chart (workouts, free ride and
// slope-only roads), workout messages over the chart and the ramp test takeover. renderRide() runs on every engine
// tick (4 Hz), so nothing here may do more per tick than it did in app.js.
// The phone ride screen (renderPhone) is still in app.js and imports what it shares from here: segRows, workoutLeft,
// fmtDist, segAmount, drawTrack, trackProgress, smoothPower, drawHrTrace, sizeChart, renderRide.
// Pure parts (unit tests: test/ride.mjs): rideTiles, intervalCard, nextCard, gearViz, the chart geometry (powerScale,
// workoutX, gradeBarH, ergShape, trackFrame, trackView, trackKmStep), smoothPower, smoothHr, msgMs, intervalEnding.
// Never imports app.js: app state and app.js hooks come in initRide(deps); theme colors come from `look()` at draw time.
import { POWER_SHOW_S } from './engine/session.js?v=202611102147';
import { segTarget, ftpWatts, isTrack, track, trackDist, trackHeight, trackClimbed, climbAhead, climbsByDist } from './engine/workout.js?v=202611102147';
import { stepCue, resultCue, bestAvg } from './testcoach.js?v=202611102147';
import { fmtTime, fmtDist } from './ridepage.js?v=202611102147';
import { ELEV_MIN, rampStops } from './profile.js?v=202611102147';
import { action } from './controls.js?v=202611102147';
import { $, esc, reducedMotion } from './ui.js?v=202611102147';

/** @typedef {import('./types.js').RideDeps} Deps */
/** @typedef {import('./types.js').RideSession} Session */
/** @typedef {import('./types.js').RideView} RideView */
/** @typedef {import('./types.js').Segment} Segment */
/** @typedef {HTMLElement & { _ses?: object, _seg?: number }} RideCard The interval card / phone hero, with the session and step it last showed. */
/** @type {Deps['app']} */ let app;
/** @type {Deps['isPhone']} */ let isPhone;
/** @type {Deps['renderPhone']} */ let renderPhone;
/** @type {Deps['setDevPop']} */ let setDevPop;
/** @type {Deps['look']} */ let look;
/** @type {Deps['zoneHex']} */ let zoneHex;
/** @type {Deps['gradeHex']} */ let gradeHex;
/** @type {Deps['setZc']} */ let setZc;
/** @type {Deps['NUM_FONT']} */ let NUM_FONT;
/**
 * deps: app state and app.js hooks. `look()` = { INK, MUTED, RULE, FTP_LINE, HR_LINE, TOK } read at draw time (the
 * light / dark theme); zoneHex, gradeHex and setZc are app.js's color helpers; NUM_FONT is shared with the phone chart.
 * rampStops and ELEV_MIN come from js/profile.js (the workout profiles use them too).
 * @param {Deps} deps
 */
export function initRide(deps) {
  ({ app, isPhone, renderPhone, setDevPop, look, zoneHex, gradeHex, setZc, NUM_FONT } = deps);
  canvas = $('#r-chart');
  new ResizeObserver(() => { if (app.screen === 'ride') { sizeChart(); drawChart(); } }).observe(canvas);
  for (const id of ['r-interval', 'rp-hero']) {
    document.getElementById(id).addEventListener('animationend', (e) => {
      if (e.animationName === 'int-fresh') /** @type {HTMLElement} */ (e.currentTarget).classList.remove('int-fresh');
    });
  }
  $('#r-erg').onclick = (e) => { /** @type {HTMLElement} */ (e.currentTarget).blur(); action('ergToggle'); };
}

// ------------------------------------------------------------------ ride rendering
// time of day on the desktop ride screen (#r-tod), 12 h whatever the system locale; ticks only while the ride screen shows
let todTimer = 0;
const timeOfDay = (d = new Date()) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
function tickTod() { const el = $('#r-tod'), t = timeOfDay(); if (el && el.textContent !== t) el.textContent = t; }
/** show() in app.js: ticks while the ride screen shows, stops on any other screen. */
export function rideClock(on) {
  clearInterval(todTimer); todTimer = 0;
  if (on) { tickTod(); todTimer = setInterval(tickTod, 1000); }
}

export function renderRideStatus() {
  const el = $('#r-status');
  if (!el) return;
  // quiet dots in the bottom bar; a device that is off turns red
  const dot = (label, ok) => `<span class="cx ${ok ? '' : 'off'}">${label}</span>`;
  const t = app.trainer?.state === 'connected', h = app.hr?.state === 'connected';
  const c = app.controllers.some((x) => x.state === 'connected');
  const html = dot(app.demo ? 'Demo' : 'Trainer', t || app.demo) + dot('HR', h || app.demo) + dot('Controller', c) +
    (app.session ? `<span>${app.session.mode === 'erg' ? 'ERG' : 'Slope'}</span>` : '') +
    (app.session?.maxed ? '<span class="off">Max resistance</span>' : '');
  if (el.innerHTML !== html) el.innerHTML = html;
}

export { fmtDist }; // lives in js/ridepage.js next to fmtTime (js/profile.js uses it too)
export const segAmount = (g) => (g.dist ? fmtDist(g.dist) : fmtTime(g.dur));

/** Remaining workout time ("~" while distance steps make it an estimate), shared by the desktop list and the phone. */
/** @param {Session} s */
export function workoutLeft(s) {
  const last = s.segs.at(-1), est = s.segs.some((g) => g.estDur && s.segs.indexOf(g) >= Math.max(0, s.segIndex));
  return s.seg ? `${est ? '~' : ''}${fmtTime(last.end - s.chartPos)}` : 'Done';
}

/**
 * Interval list (desktop, left column). Header (workout name, n/N) and footer (time left) stay put; rows scroll
 * between them. Scroll rule (Agustín, Nov 10): if every row fits nothing scrolls; otherwise the current row never
 * goes below the middle of the box, and near the end the list stops and the current row moves down.
 */
/** @param {Session} s */
function renderSegList(s) {
  const body = $('#r-body');
  body.classList.toggle('with-segs', !!s.segs);
  if (!s.segs) return;
  const { rows, cur, doneN } = segRows(s);
  const box = $('#r-seg-rows');
  const html = rows.join('');
  if (box.innerHTML !== html) box.innerHTML = html;
  $('#r-segn').textContent = `${doneN}/${s.segs.length}`;
  $('#r-left').textContent = workoutLeft(s);
  if (app._segI !== cur) {
    const first = app._segI === undefined;
    app._segI = cur;
    const row = /** @type {HTMLElement} */ (box.querySelector('.seg.current'));
    const rowTop = row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop : 0; // offsetTop depends on the layout's offsetParent
    const top = row ? Math.max(0, rowTop - box.clientHeight / 2 + row.offsetHeight / 2) : box.scrollHeight;
    box.scrollTo({ top, behavior: first || reducedMotion() ? 'auto' : 'smooth' }); // the box only, never the page
  }
}

/** @param {Session} s */
function renderNextCard(s, next, setHTML, v) {
  const el = $('#r-next'), c = nextCard(s, next, v);
  el.classList.toggle('none', c.none);
  if (c.none) return;
  el.classList.toggle('finish', c.finish);
  el.style.setProperty('--nc', c.nc);
  setHTML(el, c.html);
}

/**
 * Interval change (desktop): the Next card grows over the current card, the current card pulses once as it is
 * uncovered, then a new Next card slides in from the right edge of the screen. The old current card is frozen in a
 * copy (.rt-ghost) while the real one already shows the new interval underneath.
 */
export const slide = { busy: false, parts: [] };
export function slideEnd() {
  slide.parts.forEach((x) => x.remove());
  slide.parts = [];
  $('#r-next').style.visibility = '';
  slide.busy = false;
}
/** @param {Session} s */
function slideNextIn(s) {
  const card = /** @type {RideCard} */ ($('#r-interval')), next = $('#r-next');
  const i = s.started ? s.segIndex : -1;
  if (card._ses !== s || card._seg < 0 || i < 0 || i === card._seg) return;
  if (reducedMotion() || next.classList.contains('none') || !next.offsetWidth) return; // pulseCard handles it
  if (slide.busy) slideEnd(); // skips in a row: finish the last one at once
  const host = $('#ride'), h = host.getBoundingClientRect();
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - h.left, y: r.top - h.top, w: r.width, h: r.height }; };
  const a = at(next), b = at(card);
  const copy = (el, cls, r) => {
    const c = el.cloneNode(true);
    c.removeAttribute('id'); c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
    c.classList.remove('int-fresh', 'int-ending');
    c.classList.add(cls);
    Object.assign(c.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    host.appendChild(c);
    slide.parts.push(c);
    return c;
  };
  slide.busy = true;
  card._seg = i; // pulseCard must not pulse now; it happens on landing
  copy(card, 'rt-ghost', b);
  const mover = copy(next, 'rt-mover', a);
  next.style.visibility = 'hidden';
  const ease = 'cubic-bezier(.3, 1.25, .5, 1)';
  mover.animate([
    { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` },
    { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` },
  ], { duration: 380, easing: ease, fill: 'forwards' }).finished.then(() => {
    if (!slide.busy) return;
    slide.parts.filter((x) => x !== mover).forEach((x) => x.remove());
    slide.parts = [mover];
    mover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    card.classList.remove('int-fresh'); void card.offsetWidth; card.classList.add('int-fresh');
    next.style.visibility = '';
    if (!next.classList.contains('none')) {
      const n = next.getBoundingClientRect();
      next.animate([{ transform: `translateX(${innerWidth - n.left}px)` }, { transform: 'none' }], { duration: 480, easing: ease });
    }
    setTimeout(() => { if (slide.parts[0] === mover) slideEnd(); }, 170);
  }).catch(() => {});
}

/** Segment rows shared by the desktop sidebar and the phone list view. */
/** @param {Session} s */
export function segRows(s) {
  const ftp = app.settings.ftp, cur = s.segIndex < 0 ? s.segs.length : s.segIndex;
  const doneN = Math.min(cur, s.segs.length);
  const rows = s.segs.map((g, i) => {
    const state = i < cur ? 'done' : i === cur ? 'current' : 'todo';
    // ramps: the current row follows the live target like the interval card; other rows show the ramp's average
    const color = g.kind !== 'erg' ? gradeHex(g.grade) : zoneHex(state === 'current' ? segTarget(g, s.segProgress) : (g.from + g.to) / 2);
    const tgtW = g.kind === 'erg' ? (g.from === g.to ? `${Math.round(g.from * ftp * s.intensity)} W` : `${Math.round(g.from * ftp * s.intensity)}-${Math.round(g.to * ftp * s.intensity)} W`) : `${((g.grade + s.gradeOffset) * 100).toFixed(0)}%`;
    const name = `${esc(g.label)}${g.rep ? ` <span class="muted">${g.rep.i}/${g.rep.of}</span>` : ''}`;
    const a = s.segAgg[i];
    const avgP = a?.n ? Math.round(a.p / a.n) : null, avgHr = a?.hrN ? Math.round(a.hr / a.hrN) : null;
    const cadChip = (g.cad ? `<span class="cad-chip">${g.cad.label}</span>` : '') + (g.kind === 'sim' && g.aim ? `<span class="cad-chip">~${Math.round(g.aim.mid * ftp)} W</span>` : '');
    if (g.kind === 'erg') {
      const bar = state === 'current' ? `<div class="bar" style="width:${Math.min(100, s.segProgress * 100).toFixed(1)}%"></div>` : '';
      const time = state === 'current' ? fmtTime(s.segRemaining.sec ?? 0) : segAmount(g);
      return `<div class="seg erg ${state}" style="--c:${color}" data-i="${i}"><div class="seg-name">${state === 'done' ? '<span class="check">&#10003;</span>' : ''}<span class="big">${tgtW}</span>${cadChip}</div><div class="seg-r"><span class="big">${time}</span></div>${bar}</div>`;
    }
    let right;
    if (state === 'todo') right = `<span class="big">${segAmount(g)}</span>`;
    else if (!avgP) right = state === 'done' ? '<span class="muted">skipped</span>' : `<span class="big">${segAmount(g)}</span>`;
    else {
      right = `<span class="big">${avgP} W</span><br><span class="muted">${avgHr ? `&hearts; ${avgHr}` : ''}${state === 'current' ? ` &middot; ${s.segRemaining.sec !== undefined ? fmtTime(s.segRemaining.sec) : fmtDist(s.segRemaining.m)} left` : ''}</span>`;
    }
    const bar = state === 'current' ? `<div class="bar" style="width:${Math.min(100, s.segProgress * 100).toFixed(1)}%"></div>` : '';
    return `<div class="seg ${state}" style="--c:${color}" data-i="${i}"><div><div class="seg-name">${state === 'done' ? '<span class="check">&#10003;</span>' : ''}${name}</div><div class="seg-tgt">${tgtW} &middot; ${segAmount(g)} ${cadChip}</div></div><div class="seg-r">${right}</div>${bar}</div>`;
  });
  return { rows, cur, doneN };
}

/** Gear tile's sub line: cogs (easiest first) and rings with the ones in use in ink, and the ratio. `look` = { INK, RULE }. */
export function gearViz(gb, { INK, RULE }) {
  if (gb.seq) return `gear ${gb.rear + 1}/${gb.nRear} &middot; ratio ${gb.ratio.toFixed(2)}`;
  const cogs = gb.cogsEasyFirst, max = cogs[0];
  const bars = cogs.map((c, i) => `<rect x="${i * 9}" y="${22 - (c / max) * 20}" width="6" height="${(c / max) * 20}" rx="1.5" fill="${i === gb.rear ? INK : RULE}"/>`).join('');
  const rings = gb.d.rings.map((r, i) => `<circle cx="${cogs.length * 9 + 10 + i * 14}" cy="12" r="${3 + (r / gb.d.rings.at(-1)) * 6}" fill="none" stroke="${i === gb.front ? INK : RULE}" stroke-width="2.5"/>`).join('');
  return `<svg class="gearviz" viewBox="0 0 ${cogs.length * 9 + 14 + gb.d.rings.length * 14} 24">${bars}${rings}</svg><span>ratio ${gb.ratio.toFixed(2)}</span>`;
}

// ---- what the desktop ride screen says, as pure functions of the session (unit tests: test/ride.mjs).
// `v` = rideView(s), built once per draw (the phone's renderPhone() uses the same one): { ftp, riderKg, hrBpm, track, zoneHex, gradeHex, INK, RULE }.
// `track` is the road of a slope-only workout (cached per session), null otherwise.
/** @param {Session} s @returns {RideView} */
export const rideView = (s) => ({
  ftp: app.settings.ftp, riderKg: app.settings.riderKg, hrBpm: app.hr?.bpm,
  track: s.segs && isTrack(s.segs) ? rideTrack(s) : null, zoneHex, gradeHex, ...look(),
});

/** The tiles (power, HR, cadence, gear, Climbed / To the top, speed) and the clock: text or markup for each. */
/** @param {Session} s @param {RideView} v */
export function rideTiles(s, v) {
  const td = s.trainer.data || {};
  const hr = Math.round(v.hrBpm || td.hr || 0);
  const p = Math.round(s.powerShown);
  const r = s.target ? p / s.target : 0;
  const hrs = s.samples.filter((x) => x.hr).slice(-600);
  const cs = s.cadStatus;
  // slope step with a power aim (Nov 20, Agustín): the power tile works like the cadence one, green on target, red + pulse off it
  const aim = s.mode !== 'erg' && s.seg?.kind === 'sim' ? s.seg.aim : null, as = aim ? s.aimStatus : null;
  const aimW = (f) => Math.round(f * v.ftp);
  // Climbed / To the top (UX roadmap item 7): replaces the Grade tile, the grade is already the interval card's big number.
  // Real climbs say what's left, out of the workout's total climb (Nov 20, Agustín: the tile is about climbing only,
  // distance and speed have their own tile, so no "km to go" here). Only when the climbs are distance steps: a timed
  // climb's metres depend on how fast he rides it, so there the tile counts the real metres climbed instead.
  let up = s.climbed || 0, upSub = '', upLabel = 'Climbed';
  if (v.track && climbsByDist(s.segs)) {
    const tr = v.track, d = trackDist(tr, s.segs, s.chartPos);
    up = Math.max(0, tr.ascent - trackClimbed(tr, d)); upLabel = 'To the top';
    upSub = `of ${Math.round(tr.ascent)} m`;
  }
  return {
    elapsed: fmtTime(s.elapsed),
    power: p,
    powerCls: s.target ? (r < 0.95 ? 'low' : r > 1.05 ? 'high' : 'ok') : as === 'ok' ? 'aim-ok' : as ? 'aim-bad' : '',
    target: s.target ? `target <b style="color:var(--text)">${s.target}</b> W`
      : as === 'low' ? '<b>&#9650; Push harder</b>' : as === 'high' ? '<b>&#9660; Ease off</b>'
        : aim ? `target <b style="color:var(--text)">${aimW(aim.lo)}-${aimW(aim.hi)}</b> W` : `${(p / v.riderKg).toFixed(1)} W/kg`,
    effortShown: !(s.mode !== 'erg' || Math.abs(s.intensity - 1) < 0.001),
    effort: `${Math.round(s.intensity * 100)}%`,
    hr: hr || '--',
    hrAvg: hrs.length ? `avg ${Math.round(hrs.reduce((a, x) => a + x.hr, 0) / hrs.length)} (10 min)` : '',
    cad: Math.round(td.cadence || 0),
    cadState: cs === 'ok' ? 'ok' : cs === 'low' || cs === 'high' ? 'bad' : '',
    cadTarget: !s.seg?.cad ? '' : cs === 'low' ? '<b>&#9650; Pedal faster</b>' : cs === 'high' ? '<b>&#9660; Pedal slower</b>' : `target ${s.seg.cad.label}`,
    gearDim: s.mode === 'erg',
    gear: s.gb.seq ? s.gb.label : s.gb.label.replace('x', '\u00d7'),
    gearCombo: !s.gb.seq,
    ratio: s.mode === 'erg' ? 'ERG: gears not used' : gearViz(s.gb, v),
    climbLabel: upLabel,
    climb: `${Math.round(up)}<span class="unit">m</span>`,
    climbSub: upSub,
    speed: (s.bike.v * 3.6).toFixed(1),
    dist: `${(s.bike.dist / 1000).toFixed(2)} km`,
    trip: `<b>${(s.bike.dist / 1000).toFixed(1)}</b> km \u00b7 <b>${(s.bike.v * 3.6).toFixed(1)}</b> km/h`,
  };
}

/**
 * Interval card: color (`zc`), label, small line, the big sentence ("Hold 216 W for 4:00", "Ramp to 140 W in 9:30",
 * "6% grade for 150 m", "Done. Nice work.", "2.0% grade") and the progress bar's width (null: no bar).
 */
/** @param {Session} s @param {RideView} v */
export function intervalCard(s, v) {
  const seg = s.seg;
  const num = (x, u = '') => `<span class="num">${x}</span>${u ? `<span class="u">${u}</span>` : ''}`;
  const word = (w) => `<span class="w">${w}</span>`;
  if (seg) {
    const rem = s.segRemaining;
    const left = rem.sec !== undefined ? num(fmtTime(rem.sec)) : num(fmtDist(rem.m).replace(/ (k?m)$/, ''), rem.m < 1000 ? 'm' : 'km');
    const cad = seg.cad ? ` &middot; ${seg.cad.label}` : '';
    let big, sub, zc;
    if (seg.kind === 'erg') {
      const tgt = segTarget(seg, s.segProgress);
      const w = s.target || Math.round(tgt * v.ftp * s.intensity);
      zc = v.zoneHex(tgt);
      if (seg.from === seg.to) {
        big = `${word('Hold')}${num(w, 'W')}${word('for')}${left}`;
        sub = `${Math.round(tgt * 100 * s.intensity)}% FTP${cad}`;
      } else {
        big = `${word('Ramp to')}${num(Math.round(seg.to * v.ftp * s.intensity), 'W')}${word('in')}${left}`;
        sub = `now ${w} W${cad}`;
      }
    } else {
      const g = seg.grade + s.gradeOffset;
      zc = v.gradeHex(g);
      big = `${num((g * 100).toFixed(0), '%')}${word('grade for')}${left}`;
      sub = `${seg.aim ? `use your gears, aim ${Math.round(seg.aim.mid * v.ftp)} W` : 'use your gears'}${cad}`;
    }
    // slope profile moved with up/down: said here now that the Grade tile is gone (UX roadmap item 7)
    const off = seg.kind !== 'erg' && s.gradeOffset ? `profile ${s.gradeOffset > 0 ? '+' : ''}${(s.gradeOffset * 100).toFixed(0)}% &middot; ` : '';
    return {
      zc,
      label: `${esc(seg.label)}${seg.rep ? ` ${seg.rep.i}/${seg.rep.of}` : ''}${s.ergOff && seg.kind === 'erg' ? ' (ERG off)' : ''}`,
      text: off + (seg.text ? `${esc(seg.kind === 'sim' ? ftpWatts(seg.text, v.ftp) : seg.text)}${cad}` : sub),
      big,
      bar: `${Math.min(100, Math.max(0, s.segProgress * 100)).toFixed(2)}%`,
    };
  }
  if (s.segs) return { zc: 'var(--ok-bg)', label: 'Workout complete', text: 'keep riding or hold B to finish', big: '<span class="msg">Done. Nice work.</span>', bar: null };
  return { zc: v.gradeHex(s.grade), label: 'Free ride', text: 'up/down changes the grade by 1%, shift to hold your cadence', big: `${num((s.grade * 100).toFixed(1), '%')}${word('grade')}`, bar: null };
}

/** Next card: "4:00 @ 216 W" (+ cadence target; a slope step's aim, "60-65 rpm · ~216 W"); "Finish" on the last interval; `none` when there is no next step. */
/** @param {Session} s @param {Segment | undefined} next @param {RideView} v */
export function nextCard(s, next, v) {
  if (!s.segs || !s.seg) return { none: true };
  if (!next) return { none: false, finish: true, nc: 'var(--rule)', html: '<div class="rt-k">Next</div><div class="amt">Finish</div>' };
  const w = (f) => Math.round(f * v.ftp * s.intensity);
  const tgt = next.kind === 'erg'
    ? `<span class="num">${next.from === next.to ? w(next.from) : `${w(next.from)}-${w(next.to)}`}</span><span class="u">W</span>`
    : `<span class="num">${((next.grade + s.gradeOffset) * 100).toFixed(0)}</span><span class="u">%</span>`;
  return {
    none: false, finish: false,
    nc: next.kind === 'erg' ? v.zoneHex(next.from) : v.gradeHex(next.grade), // a ramp: the zone it starts in, so the hand-off doesn't change color
    html: `<div class="rt-k">Next</div><div class="amt"><span class="num">${segAmount(next)}</span><span class="at">@</span>${tgt}</div><div class="cad">${[next.cad?.label, next.kind === 'sim' && next.aim ? `~${Math.round(next.aim.mid * v.ftp)} W` : ''].filter(Boolean).join(' &middot; ')}</div>`,
  };
}

/** @param {Session} s */
function renderPaused(s) {
  $('#r-paused').classList.toggle('hidden', !s.paused);
  if (!s.paused && $('#devpop').classList.contains('on-ride') && !$('#devpop').classList.contains('hidden')) setDevPop(false); // riding again: it went with the pause screen
  if (s.paused) {
    $('#r-paused-title').textContent = !s.started ? 'Ready' : 'Paused';
    $('#r-paused-sub').textContent = !s.started ? 'Start pedaling to begin' : s.autoPaused ? 'Start pedaling to resume' : isPhone() ? 'Tap Resume or press A' : 'Press A or Space to resume';
  }
}

// Interval card pulse (desktop card and phone hero): one beat when a new interval starts,
// a steady beat once per second through its last 10 seconds. Distance steps estimate the
// seconds left from current speed. Nothing pulses before the start or while paused.
/** @param {Session} s */
export function intervalEnding(s) {
  const rem = s.segRemaining;
  if (!rem || !s.started || s.paused) return false;
  if (rem.sec !== undefined) return rem.sec > 0 && rem.sec < 10.5; // the countdown reads 0:10
  return s.bike.v > 1 && rem.m > 0 && rem.m / s.bike.v < 10.5;
}
/** @param {RideCard} card */
/** @param {Session} s */
function pulseCard(s, card) {
  if (card._ses !== s) { card._ses = s; card._seg = -1; card.classList.remove('int-fresh', 'int-ending'); }
  const i = s.started ? s.segIndex : -1;
  if (i >= 0 && i !== card._seg) {
    card.classList.remove('int-fresh');
    void card.offsetWidth; // restart the one-shot animation
    card.classList.add('int-fresh');
  }
  card._seg = i;
  card.classList.toggle('int-ending', intervalEnding(s));
}

export function renderRide() {
  const s = app.session;
  if (!s || app.screen !== 'ride') return;
  if (!isPhone()) slideNextIn(s); // before pulseCard: a slide pulses the card when it lands, not now
  pulseCard(s, isPhone() ? $('#rp-hero') : $('#r-interval'));
  if (isPhone()) { renderPhone(s); renderPaused(s); return; }
  const v = rideView(s), t = rideTiles(s, v);
  $('#r-elapsed').textContent = t.elapsed;
  // @ts-expect-error textContent takes the number as it is (the DOM writes its text)
  $('#r-power').textContent = t.power;
  const pt = $('.tile.power');
  pt.classList.remove('low', 'high', 'ok', 'aim-ok', 'aim-bad');
  if (t.powerCls) pt.classList.add(t.powerCls);
  $('#r-target').innerHTML = t.target;
  const pctEl = $('#r-pct'); // effort: only when it isn't 100%
  pctEl.classList.toggle('hidden', !t.effortShown);
  if (pctEl.innerHTML !== t.effort) pctEl.innerHTML = t.effort;
  // @ts-expect-error textContent takes the number as it is (the DOM writes its text)
  $('#r-hr').textContent = t.hr;
  $('#r-hrzone').textContent = t.hrAvg;
  // @ts-expect-error textContent takes the number as it is (the DOM writes its text)
  $('#r-cad').textContent = t.cad;
  const ct = $('.tile.cad');
  ct.classList.toggle('ok', t.cadState === 'ok');
  ct.classList.toggle('bad', t.cadState === 'bad');
  $('#r-cadtarget').innerHTML = t.cadTarget;
  $('.tile.gear').classList.toggle('dim', t.gearDim);
  $('#r-gear').textContent = t.gear;
  $('#r-gear').classList.toggle('combo', t.gearCombo);
  $('#r-ratio').innerHTML = t.ratio;
  $('#r-climb-label').textContent = t.climbLabel;
  $('#r-climb').innerHTML = t.climb;
  $('#r-climbsub').textContent = t.climbSub;
  $('#r-speed').textContent = t.speed;
  $('#r-dist').textContent = t.dist;
  $('#r-trip').innerHTML = t.trip;

  // interval card
  $('.tiles').classList.toggle('erg', s.mode === 'erg');
  const card = $('#r-interval'), bar = $('#r-int-bar');
  const setHTML = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
  const c = intervalCard(s, v);
  setZc(card, c.zc);
  setHTML($('#r-int-label'), c.label);
  setHTML($('#r-int-text'), c.text);
  setHTML($('#r-int-big'), c.big);
  bar.classList.toggle('hidden', c.bar === null);
  if (c.bar !== null) /** @type {HTMLElement} */ (bar.firstElementChild).style.width = c.bar;
  renderNextCard(s, s.seg ? s.segs[s.segIndex + 1] : undefined, setHTML, v);
  renderSegList(s);

  renderPaused(s);
  $('#r-pause').textContent = !s.started ? 'Start' : s.paused ? 'Resume' : 'Pause';
  // in a workout every interval is its own lap, so Z only laps in free ride (or after the workout ends)
  const lapOrSkip = s.seg ? '<b>Hold Y</b> skip' : '<b>Z</b> lap';
  $('#r-hints').innerHTML = (s.mode === 'erg'
    ? `<b>Shifters</b> or <b>Up/Down</b> effort &plusmn;1% &middot; ${lapOrSkip} &middot; <b>A</b> pause &middot; <b>Hold B</b> end`
    : `<b>Shifters</b> gears &middot; <b>Up/Down</b> grade &plusmn;1% &middot; ${lapOrSkip} &middot; <b>A</b> pause &middot; <b>Hold B</b> end`) + (app.demo ? ' &middot; demo: <b>+/-</b> rider power' : '');
  const ergBtn = $('#r-erg'), segNow = s.seg;
  ergBtn.classList.toggle('hidden', !segNow || (segNow.kind !== 'erg' && !s.ergOff));
  ergBtn.textContent = s.ergOff ? 'ERG back on' : 'ERG off';
  renderRideStatus();
  drawChart();
}

// ------------------------------------------------------------------ chart
// Geometry of the ride chart, pure (unit tests: test/ride.mjs). Canvas pixels: y grows down, `bot` is the baseline.
/** Power to y: 0 W on `bot`, the top of the plot at FTP x 1.6 (`base`) or the last 20 minutes' peak + 20 W if higher. */
export function powerScale(samples, base, bot, plotH) {
  const maxP = Math.max(base, ...samples.slice(-1200).map((x) => x.power + 20));
  return { maxP, Yp: (p) => bot - (Math.min(p, maxP) / maxP) * plotH };
}
/** Workout time to x: the whole workout fills the width (or the ride so far, once it runs past the end). */
/** @param {Session} s */
export function workoutX(s, W) {
  const T = Math.max(s.segs[s.segs.length - 1].end, s.chartPos + 1);
  return (t) => (t / T) * W;
}
/** Height of a grade bar (fraction, -3% sits on the baseline, 12% fills `k` of the plot), at least `min`. */
export const gradeBarH = (g, plotH, k, min) => Math.max(min, ((g + 0.03) / 0.15) * plotH * k);
/** An ERG step's block: baseline, its start and end targets in watts (a ramp slopes), baseline. */
export function ergShape(g, X, Yp, ftp, intensity, bot) {
  return [[X(g.start), bot], [X(g.start), Yp(g.from * ftp * intensity)], [X(g.end), Yp(g.to * ftp * intensity)], [X(g.end), bot]];
}
/**
 * A slope-only ride's road on the chart: distance to x over the stretch in view (`view` = trackView()), elevation to y
 * in the top `area` of the plot over at least `elevMin` metres, a 6% floor kept clear under the lowest point.
 */
export function trackFrame(tr, view, { W, top, bot, area, elevMin }) {
  const plotH = bot - top, v0 = view.v0, VD = tr.D - v0;
  const X = (d) => ((d - v0) / VD) * W;
  const rng = Math.max(view.hi - view.lo, elevMin), aTop = bot - plotH * area, floor = plotH * 0.06;
  const Y = (h) => aTop + (1 - (h - view.lo) / rng) * (bot - floor - aTop);
  return { v0, VD, X, Y };
}

let canvas; // #r-chart, set by initRide()
export function sizeChart() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, r.width * devicePixelRatio);
  canvas.height = Math.max(100, r.height * devicePixelRatio);
}

function drawChart() {
  const s = app.session;
  if (!s) return;
  const { INK, MUTED, FTP_LINE } = look();
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, dpr = devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const pad = 10 * dpr;
  const plotH = H - pad * 2;
  ctx.font = `600 ${12 * dpr}px ${NUM_FONT}`;

  const ftp = app.settings.ftp;
  const { Yp } = powerScale(s.samples, ftp * 1.6, H - pad, plotH);

  if (s.segs && isTrack(s.segs)) return drawTrack(ctx, s, { W, H, dpr, top: pad, bot: H - pad, area: 0.6, compact: false });
  if (s.segs) {
    const X = workoutX(s, W);
    for (const g of s.segs) {
      if (g.kind === 'erg') {
        const a = g.end <= s.chartPos ? '66' : 'cc';
        if (g.from === g.to) ctx.fillStyle = zoneHex(g.from) + a;
        else {
          const gr = ctx.createLinearGradient(X(g.start), 0, X(g.end), 0);
          for (const [o, c] of rampStops(g.from, g.to, zoneHex)) gr.addColorStop(o, c + a);
          ctx.fillStyle = gr;
        }
        const [p0, p1, p2, p3] = ergShape(g, X, Yp, ftp, s.intensity, H - pad);
        ctx.beginPath(); ctx.moveTo(...p0);
        ctx.lineTo(...p1); ctx.lineTo(...p2);
        ctx.lineTo(...p3); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = gradeHex(g.grade) + (g.end <= s.chartPos ? '66' : 'cc');
        const h = gradeBarH(g.grade, plotH, 0.6, 6 * dpr);
        ctx.fillRect(X(g.start), H - pad - h, X(g.end) - X(g.start), h);
      }
    }
    // FTP line
    ctx.strokeStyle = FTP_LINE; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = MUTED; ctx.fillText(`FTP ${ftp}`, 6 * dpr, Yp(ftp) - 4 * dpr);
    if (s.test?.prevBest) { // ramp test: where the last test's best minute was
      const y = Yp(s.test.prevBest);
      ctx.strokeStyle = INK; ctx.globalAlpha = 0.55; ctx.setLineDash([2 * dpr, 5 * dpr]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = INK; ctx.fillText(`Last test ${s.test.prevBest}`, 6 * dpr, y - 4 * dpr);
    }
    // power trace
    ctx.strokeStyle = INK; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
    const sp = smoothPower(s.samples);
    s.samples.forEach((x, i) => { const px = X(x.wx ?? x.wt), py = Yp(sp[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    drawHrTrace(ctx, s.samples, (x) => X(x.wx ?? x.wt), W, H, pad, dpr);
    ctx.fillStyle = INK; ctx.fillRect(X(s.chartPos) - dpr, 0, 2 * dpr, H);
    return;
  }

  // free ride: last 10 minutes of power with grade underlay
  const win = 600, data = s.samples.slice(-win);
  const X = (i) => (i / win) * W;
  // each second in its grade color, like the phone chart, slope workouts and the ride page (was one flat UNDERLAY gray)
  data.forEach((x, i) => {
    const g = (x.grade || 0) / 100, h = gradeBarH(g, plotH, 0.6, 2 * dpr);
    const x0 = Math.floor(X(i)); ctx.fillStyle = gradeHex(g) + '88'; ctx.fillRect(x0, H - pad - h, Math.floor(X(i + 1)) - x0, h); // edge to edge: overlapping see-through bars leave stripes
  });
  ctx.strokeStyle = FTP_LINE; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = INK; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  const sp = smoothPower(s.samples).slice(-win);
  data.forEach((x, i) => { i ? ctx.lineTo(X(i), Yp(sp[i])) : ctx.moveTo(X(i), Yp(sp[i])); });
  ctx.stroke();
  drawHrTrace(ctx, data, (x, i) => X(i), W, H, pad, dpr);
  ctx.fillStyle = MUTED; ctx.fillText('Last 10 min', 6 * dpr, 16 * dpr);
}

// ------------------------------------------------------------------ slope workouts on the ride screen
const trackCache = new WeakMap(); // session -> track(segs)
const rideTrack = (s) => { let t = trackCache.get(s); if (!t) { t = track(s.segs); trackCache.set(s, t); } return t; };
export const trackKmStep = (D) => (D > 40000 ? 10 : D > 12000 ? 5 : D > 5000 ? 2 : 1);
/**
 * The stretch of road the ride chart shows. A real climb's warm-up (profile.lead) leaves the chart once it's ridden,
 * so the climb fills the width (Nov 12, Agustín): v0 = metres where the view starts, km marks and progress count
 * from there, lo/hi are the elevation range of what's shown.
 */
/** @param {Session} s */
export function trackView(s, tr) {
  const n = s.workout?.profile?.lead?.length || 0;
  const past = n && n < s.segs.length && (s.segIndex >= n || s.chartPos >= s.segs[n - 1].end);
  if (!past) return { v0: 0, lo: tr.lo, hi: tr.hi, up0: 0, first: 0 };
  const parts = tr.parts.slice(n), v0 = parts[0].d0;
  const hs = parts.flatMap((p) => [p.h0, p.h1]);
  return { v0, lo: Math.min(...hs), hi: Math.max(...hs), up0: trackClimbed(tr, v0), first: n };
}

/**
 * Slope-only workout on the ride screen (desktop and phone; Nov 11, picked by Agustín from the mockups): the road's
 * elevation over distance, filled with each stretch's grade color and faded where ridden, power and HR on top, a dot
 * where the rider is, and on a climb (3%+) a flag at the top with a tag: "618 m to the top · +37 m".
 */
export function drawTrack(ctx, s, { W, H, dpr, top, bot, area, compact }) {
  const { INK, MUTED, FTP_LINE, TOK } = look();
  const segs = s.segs, tr = rideTrack(s), ftp = app.settings.ftp, plotH = bot - top;
  const pos = trackDist(tr, segs, s.chartPos), hNow = trackHeight(tr, pos);
  const view = trackView(s, tr), { v0, VD, X, Y } = trackFrame(tr, view, { W, top, bot, area, elevMin: ELEV_MIN });
  const xOf = (x) => X(trackDist(tr, segs, x.wx ?? x.wt));

  // the road: ridden part faded, the rest at full strength
  segs.forEach((g, i) => {
    if (i < view.first) return; // warm-up already ridden and out of view
    const p = tr.parts[i];
    const pieces = p.d1 <= pos ? [[p.d0, p.d1, true]] : p.d0 >= pos ? [[p.d0, p.d1, false]] : [[p.d0, pos, true], [pos, p.d1, false]];
    ctx.fillStyle = gradeHex(g.grade);
    for (const [a, b, done] of pieces) {
      ctx.globalAlpha = done ? 0.4 : 0.8;
      ctx.beginPath(); ctx.moveTo(X(a), bot); ctx.lineTo(X(a), Y(trackHeight(tr, a)));
      ctx.lineTo(X(b) + 0.5 * dpr, Y(trackHeight(tr, b))); ctx.lineTo(X(b) + 0.5 * dpr, bot); ctx.closePath(); ctx.fill();
    }
  });
  ctx.globalAlpha = 0.55; ctx.strokeStyle = INK; ctx.lineWidth = 1.25 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  tr.parts.slice(view.first).forEach((p, i) => (i ? ctx.lineTo(X(p.d0), Y(p.h0)) : ctx.moveTo(X(p.d0), Y(p.h0))));
  ctx.lineTo(W, Y(tr.parts.at(-1).h1)); ctx.stroke();
  ctx.globalAlpha = 1;
  if (!compact) { // km marks along the bottom
    ctx.fillStyle = MUTED; ctx.textAlign = 'center';
    const step = trackKmStep(VD);
    for (let k = step; k * 1000 < VD * 0.97; k += step) ctx.fillText(`${k} km`, X(v0 + k * 1000), bot - 5 * dpr);
    ctx.textAlign = 'left';
  }

  // FTP line, power and heart rate over the ridden part
  const { Yp } = powerScale(s.samples, ftp * (compact ? 1.4 : 1.6), bot, plotH);
  ctx.strokeStyle = FTP_LINE; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = MUTED; ctx.fillText(`FTP ${ftp}`, (compact ? 2 : 6) * dpr, Math.max(10 * dpr, Yp(ftp) - 4 * dpr));
  ctx.strokeStyle = INK; ctx.lineWidth = (compact ? 1.8 : 2) * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  const sp = smoothPower(s.samples);
  s.samples.forEach((x, i) => { const px = xOf(x), py = Yp(sp[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
  drawHrTrace(ctx, s.samples, xOf, W, H, top, dpr);

  // where you are: a line through the chart and a dot on the road
  const mx = X(pos), my = Y(hNow);
  ctx.fillStyle = INK; ctx.fillRect(mx - dpr, compact ? top - 4 * dpr : 0, 2 * dpr, compact ? bot - top + 4 * dpr : H);
  ctx.beginPath(); ctx.arc(mx, my, (compact ? 5 : 7) * dpr, 0, Math.PI * 2);
  ctx.fillStyle = TOK.sheet; ctx.fill(); ctx.lineWidth = (compact ? 2.5 : 3) * dpr; ctx.strokeStyle = INK; ctx.stroke();

  // on a climb: flag at the top and what's left to it
  const seg = s.seg;
  if (seg && (seg.grade || 0) >= 0.03) {
    const c = climbAhead(tr, segs, s.segIndex, pos);
    if (c.m > 1) {
      const tx = X(c.top), ty = Y(c.h), pole = (compact ? 16 : 20) * dpr, fl = (compact ? 8 : 10) * dpr;
      ctx.fillStyle = INK;
      ctx.fillRect(tx - 0.75 * dpr, ty - pole, 1.5 * dpr, pole);
      ctx.beginPath(); ctx.moveTo(tx, ty - pole); ctx.lineTo(tx + fl, ty - pole + fl * 0.35); ctx.lineTo(tx, ty - pole + fl * 0.7); ctx.closePath(); ctx.fill();
      const big = fmtDist(c.m), small = `${compact ? '' : ' to the top'} · +${Math.round(c.rise)} m`; // phone: short, the flag marks the top
      const fb = `800 ${(compact ? 15 : 19) * dpr}px ${NUM_FONT}`, fs = `600 ${(compact ? 12 : 13.5) * dpr}px ${NUM_FONT}`;
      ctx.font = fb; const wb = ctx.measureText(big).width;
      ctx.font = fs; const ws = ctx.measureText(small).width;
      const px = 8 * dpr, th = (compact ? 24 : 30) * dpr, tw = wb + ws + px * 2;
      // behind the dot (over the ridden part) so it never hides the road ahead; ahead only when there's no room behind
      const bx = mx - 12 * dpr - tw >= 2 * dpr ? mx - 12 * dpr - tw : Math.min(mx + 12 * dpr, W - tw - 2 * dpr);
      const by = Math.max(top, my - th - 14 * dpr);
      ctx.fillStyle = INK; ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(bx, by, tw, th, 5 * dpr) : ctx.rect(bx, by, tw, th); ctx.fill();
      ctx.textBaseline = 'middle'; ctx.fillStyle = TOK.sheet;
      ctx.font = fb; ctx.fillText(big, bx + px, by + th / 2 + dpr);
      ctx.globalAlpha = 0.72; ctx.font = fs; ctx.fillText(small, bx + px + wb, by + th / 2 + dpr);
      ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
    }
  }

  if (!compact) { // progress along the road, top right
    ctx.font = `600 ${13 * dpr}px ${NUM_FONT}`; ctx.fillStyle = MUTED; ctx.textAlign = 'right';
    ctx.fillText(trackProgress(s), W - 12 * dpr, 20 * dpr);
    ctx.textAlign = 'left';
  }
}

/** "12.5 of 24.9 km · +215 of 495 m" for a slope-only ride. */
/** @param {Session} s */
export function trackProgress(s) {
  const tr = rideTrack(s), { v0, up0 } = trackView(s, tr), d = trackDist(tr, s.segs, s.chartPos);
  return `${((d - v0) / 1000).toFixed(1)} of ${((tr.D - v0) / 1000).toFixed(1)} km · +${Math.round(trackClimbed(tr, d) - up0)} of ${Math.round((tr.ascent - up0) / 5) * 5} m`;
}

// Heart rate on its own scale (at least 80-190 bpm, widened to fit).
// HR line is drawn as a trailing rolling average (display only: stored samples, FIT, averages and the live number stay raw).
// Strap jitter of a few bpm made the raw 1 Hz line spiky. 3 s (Agustín, Nov 10).
const HR_SMOOTH_S = 3;
// Power line on the ride screen: same trailing average as the power box (POWER_SHOW_S, 5 s; 3 s felt spiky, Nov 11).
// Display only: samples, FIT, NP and averages stay raw.
export function smoothPower(samples) {
  const out = new Array(samples.length);
  let sum = 0;
  samples.forEach((x, i) => {
    sum += x.power || 0;
    if (i >= POWER_SHOW_S) sum -= samples[i - POWER_SHOW_S].power || 0;
    out[i] = sum / Math.min(i + 1, POWER_SHOW_S);
  });
  return out;
}
export function smoothHr(samples) {
  const out = new Array(samples.length);
  let sum = 0, win = [];
  samples.forEach((x, i) => {
    if (!(x.hr > 0)) { out[i] = 0; sum = 0; win = []; return; } // gaps break the line and restart the average
    win.push(x.hr); sum += x.hr;
    if (win.length > HR_SMOOTH_S) sum -= win.shift();
    out[i] = sum / win.length;
  });
  return out;
}
export function drawHrTrace(ctx, samples, xOf, W, H, pad, dpr) {
  const { HR_LINE } = look();
  const sm = smoothHr(samples);
  if (!sm.some((h) => h > 0)) return;
  let lo = 80, hi = 190;
  for (const h of sm) { if (!h) continue; if (h < lo + 5) lo = h - 5; if (h > hi - 5) hi = h + 5; }
  // HR keeps to the top half of the chart so it doesn't sit on the power line.
  const bottom = H / 2;
  const Y = (h) => bottom - ((h - lo) / (hi - lo)) * (bottom - pad);
  ctx.save();
  ctx.strokeStyle = HR_LINE; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  let pen = false;
  samples.forEach((x, i) => {
    if (!sm[i]) { pen = false; return; }
    const px = xOf(x, i), py = Y(sm[i]);
    pen ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    pen = true;
  });
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------ workout messages
// Timed messages from the workout (session 'message' events) float over the top of the ride chart.
// One at a time: a new one waits until the current one has been up for at least MSG_MIN ms,
// except the first message of a new step, which replaces the old step's message right away.
const MSG_MIN = 3500;
export const rideMsgQ = { list: [], shownAt: 0, timer: 0, stale: false };
export const msgMs = (t) => Math.min(11000, Math.max(5000, 2500 + t.length * 70));
export function rideMsgReset() {
  clearTimeout(rideMsgQ.timer); rideMsgQ.list = []; rideMsgQ.shownAt = 0; rideMsgQ.stale = false;
  const el = $('#r-msg'); el.classList.remove('show'); el.textContent = '';
}
export function rideMsg(text) {
  rideMsgQ.list.push(text);
  if (!rideMsgQ.shownAt || rideMsgQ.stale) return rideMsgNext();
  const up = Date.now() - rideMsgQ.shownAt;
  clearTimeout(rideMsgQ.timer);
  rideMsgQ.timer = setTimeout(rideMsgNext, Math.max(0, MSG_MIN - up));
}
function rideMsgNext() {
  clearTimeout(rideMsgQ.timer);
  const el = $('#r-msg');
  const text = rideMsgQ.list.shift();
  if (text == null) { el.classList.remove('show'); rideMsgQ.shownAt = 0; return; }
  el.classList.remove('show'); void el.offsetWidth; // restart the animation for each message
  el.textContent = text; el.classList.add('show');
  rideMsgQ.shownAt = Date.now(); rideMsgQ.stale = false;
  rideMsgQ.timer = setTimeout(rideMsgNext, rideMsgQ.list.length ? MSG_MIN : msgMs(text));
}

// ------------------------------------------------------------------ ramp test coach
// Hard test steps and the result take over the screen for a moment (desktop): the interval card grows
// to fill the window with the coach's line and the target, then shrinks back into place.
/** Best minute of the last ramp test in the history, or null. */
export function lastTestBest() {
  const t = (app.rows || []).filter((r) => !r.demo && r.summary?.workoutId === 'ramp-test' && r.summary.bests?.[60])
    .sort((a, b) => String(a.summary.start).localeCompare(String(b.summary.start))).at(-1);
  return t ? t.summary.bests[60] : null;
}
/** @param {Session} s */
export function testStep(s) {
  const g = s.seg;
  if (!s.test || !g?.untilFail) return;
  const n = s.segs.slice(0, s.segIndex + 1).filter((x) => x.untilFail).length;
  const watts = Math.round(g.from * s.s.ftp * s.intensity);
  const cue = stepCue({ n, watts, ftp: s.s.ftp, prevBest: s.test.prevBest, name: app.settings.riderName, st: s.test.st });
  if (cue.finish && !g.msgs.some((m) => m.text === cue.finish)) g.msgs.push({ t: Math.max(0, g.dur - 15), text: cue.finish });
  if (cue.takeover) takeover(cue.takeover, { color: zoneHex(g.from) });
  if (cue.msg) rideMsg(cue.msg);
}
/** @param {Session} s */
export function testEnded(s, e) {
  app.controllers.forEach((c) => c.vibrate?.());
  const best60 = bestAvg(s.samples.map((x) => x.power), 60);
  const r = resultCue({ best60, ftp: s.s.ftp, name: app.settings.riderName });
  s.test.result = r;
  takeover(r.takeover, { dark: true, hold: 4500 }).then(() => rideMsg(r.msg));
}
let takeoverAnims = [];
export function hideTakeover() { takeoverAnims.forEach((a) => a.cancel()); takeoverAnims = []; $('#takeover').classList.add('hidden'); }
/** Full-window coach card grown out of the interval card. Resolves when it is back in place. */
function takeover({ line, big, sub }, { color = null, dark = false, hold = 2200 } = {}) {
  const el = $('#takeover');
  takeoverAnims.forEach((a) => a.cancel());
  takeoverAnims = [];
  if (isPhone() || app.screen !== 'ride') { el.classList.add('hidden'); return Promise.resolve(); }
  $('#to-line').textContent = line; $('#to-big').textContent = big; $('#to-sub').textContent = sub || '';
  el.classList.toggle('dark', dark);
  if (color) el.style.setProperty('--zc', color);
  el.classList.remove('hidden');
  const r = $('#r-interval').getBoundingClientRect(), W = innerWidth, H = innerHeight;
  const card = `inset(${r.top}px ${W - r.right}px ${H - r.bottom}px ${r.left}px round 14px)`, full = 'inset(0px 0px 0px 0px round 0px)';
  const io = 520, total = io * 2 + hold, a = io / total, b = 1 - a;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const grow = reduce
    ? el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], { duration: total })
    : el.animate([
      { clipPath: card, easing: 'cubic-bezier(.2, .9, .25, 1.05)' }, { clipPath: full, offset: a },
      { clipPath: full, offset: b, easing: 'cubic-bezier(.6, 0, .8, .4)' }, { clipPath: card },
    ], { duration: total });
  takeoverAnims.push(grow);
  if (!reduce) {
    const kids = /** @type {[string, number][]} */ ([['#to-line', 0.06], ['#to-big', 0], ['#to-sub', 0.1]]);
    kids.forEach(([sel, d]) => takeoverAnims.push($(sel).animate([
      { opacity: 0, transform: 'translateY(18px) scale(.94)' }, { opacity: 0, transform: 'translateY(18px) scale(.94)', offset: a * 0.6 + d * a },
      { opacity: 1, transform: 'none', offset: Math.min(b - 0.02, a * 1.5 + d * a), easing: 'ease-out' },
      { opacity: 1, transform: 'none', offset: b - a * 0.25 }, { opacity: 0, transform: 'scale(.97)', offset: b }, { opacity: 0 },
    ], { duration: total })));
    takeoverAnims.push($('#to-big').animate([{ scale: 1 }, { scale: 1, offset: a * 1.6 }, { scale: 1.06, offset: a * 2.1 }, { scale: 1, offset: a * 2.8 }, { scale: 1 }], { duration: total, composite: 'add' }));
  }
  return grow.finished.then(() => { el.classList.add('hidden'); takeoverAnims = []; }, () => {});
}
