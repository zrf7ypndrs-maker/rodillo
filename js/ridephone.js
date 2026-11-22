// @ts-check
// The phone ride screen (#rp, Zwift Companion style): top line, hero card, power gauge, heart rate / cadence / effort or
// gear boxes, the Next line, the workout as a chart or a list, the buttons and the ··· sheet (grade, Skip and End holds,
// Lap, ERG, theme). renderPhone() is called by renderRide() in js/ride.js on every engine tick (4 Hz) while the phone
// layout shows, so nothing here may do more per tick than it did in app.js.
// Pure parts (unit tests: test/ridephone.mjs): phoneTop, phoneHero, phoneBoxes, phoneNext, phoneButtons, phoneViewK and
// the chart geometry (phoneFreeScale, phoneScale, phoneSlices), taking `v` = rideView(s) from js/ride.js like the desktop.
// The DOM and canvas part: test/ridephone-dom.mjs. Never imports app.js: app state and app.js hooks come in
// initRidePhone(deps); theme colors come from `look()` at draw time.
import { segTarget, isTrack } from './engine/workout.js';
import { fmtTime } from './ridepage.js';
import { action, holdStart, holdEnd } from './controls.js';
import { renderRide, rideView, segRows, workoutLeft, fmtDist, segAmount, drawTrack, trackProgress, smoothPower, drawHrTrace, workoutX, gradeBarH } from './ride.js';
import { ls } from './store.js';
import { $, esc } from './ui.js';

/** @typedef {import('./types.js').RidePhoneDeps} Deps */
/** @typedef {import('./types.js').ElementEvent} ElementEvent */
/** @typedef {import('./types.js').RideSession} Session */
/** @typedef {import('./types.js').RideView} RideView */
/** @typedef {import('./types.js').Segment} Segment */
/** @type {Deps['app']} */ let app;
/** @type {Deps['isPhone']} */ let isPhone;
/** @type {Deps['look']} */ let look;
/** @type {Deps['zoneHex']} */ let zoneHex;
/** @type {Deps['gradeHex']} */ let gradeHex;
/** @type {Deps['setZc']} */ let setZc;
/** @type {Deps['setTheme']} */ let setTheme;
/** @type {Deps['NUM_FONT']} */ let NUM_FONT;
/**
 * deps: app state and app.js hooks. `look()` = { INK, MUTED, FTP_LINE, ... } read at draw time (the light / dark theme,
 * the same as the desktop's); zoneHex, gradeHex and setZc are app.js's color helpers; setTheme is the ··· sheet's theme
 * switch; NUM_FONT is shared with the desktop chart.
 * @param {Deps} deps
 */
export function initRidePhone(deps) {
  ({ app, isPhone, look, zoneHex, gradeHex, setZc, setTheme, NUM_FONT } = deps);
  rpCanvas = $('#rp-chart');
  new ResizeObserver(() => { if (app.screen === 'ride' && isPhone()) { sizePhoneChart(); drawPhoneChart(); } }).observe(rpCanvas.parentElement);
  app.phoneView = ls.get('phoneView', 'chart') === 'list' ? 'list' : 'chart';
  $('#rp-view-tg').onclick = (/** @type {ElementEvent} */ e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (!v || v === app.phoneView) return;
    e.preventDefault();
    app.phoneView = v;
    ls.set('phoneView', v);
    app._rpSegI = undefined;
    if (app.screen === 'ride' && app.session) {
      renderPhoneView(app.session);
      if (v === 'chart') { sizePhoneChart(); drawPhoneChart(); }
    }
  };
  rpTap('rp-minus', () => action(app.session?.mode === 'erg' ? 'down' : 'easier'));
  rpTap('rp-plus', () => action(app.session?.mode === 'erg' ? 'up' : 'harder'));
  rpTap('rp-pause', () => app.session?.togglePause());
  rpTap('rp-more', () => $('#rp-sheet').classList.toggle('hidden'));
  rpTap('rp-sheet-close', () => $('#rp-sheet').classList.add('hidden'));
  rpTap('rp-gdown', () => action('down'));
  rpTap('rp-gup', () => action('up'));
  rpTap('rp-lap', () => { action('lap'); $('#rp-sheet').classList.add('hidden'); });
  rpTap('rp-erg', () => { action('ergToggle'); $('#rp-sheet').classList.add('hidden'); });
  rpTap('rp-theme', () => { setTheme(app.theme === 'dark' ? 'light' : 'dark'); $('#rp-sheet').classList.add('hidden'); });
  bindHold('rp-skip', 'skip');
  bindHold('rp-end', 'end');
}

let rpCanvas; // #rp-chart, set by initRidePhone()
export function sizePhoneChart() {
  const r = rpCanvas.parentElement.getBoundingClientRect();
  rpCanvas.width = Math.max(200, Math.round(r.width * devicePixelRatio));
  rpCanvas.height = Math.max(60, Math.round(r.height * devicePixelRatio));
}

// ---- what the phone ride screen says, as pure functions of the session. `v` = rideView(s) from js/ride.js, built once
// per draw: { ftp, hrBpm, zoneHex, gradeHex, ... }.
/** Top line: elapsed, the workout's name, time left (a workout) or distance (free ride). */
/** @param {Session} s */
export function phoneTop(s) {
  return {
    elapsed: fmtTime(s.elapsed), name: esc(s.name),
    leftK: s.segs ? 'Left' : 'Distance', left: s.segs ? (s.seg ? workoutLeft(s) : '0:00') : fmtDist(s.bike.dist),
  };
}

/** Hero card: color (`zc`), interval label, countdown (time or metres), target (watts or grade) and its sub line. */
/** @param {Session} s @param {RideView} v */
export function phoneHero(s, v) {
  const seg = s.seg;
  if (seg) {
    const rem = s.segRemaining;
    const tgt = seg.kind === 'erg' ? segTarget(seg, s.segProgress) : null;
    const cad = seg.cad ? ` &middot; ${seg.cad.label}` : '';
    return {
      zc: seg.kind === 'erg' ? v.zoneHex(tgt) : v.gradeHex(seg.grade + s.gradeOffset),
      label: `${esc(seg.label)}${seg.rep ? ` ${seg.rep.i}/${seg.rep.of}` : ''}${s.ergOff && seg.kind === 'erg' ? ' &middot; ERG off' : ''}`,
      count: rem.sec !== undefined ? fmtTime(rem.sec) : fmtDist(rem.m),
      target: seg.kind === 'erg' ? `${s.target || Math.round(tgt * v.ftp * s.intensity)} W` : `${((seg.grade + s.gradeOffset) * 100).toFixed(0)}%`,
      targetSub: seg.kind === 'erg' ? `${Math.round(tgt * 100 * s.intensity)}% FTP${cad}` : `${seg.aim ? `grade, aim ${Math.round(seg.aim.mid * v.ftp)} W` : 'grade, use your gears'}${cad}`,
    };
  }
  if (s.segs) return { zc: 'var(--ok-bg)', label: 'Workout complete', count: 'Done', target: '', targetSub: 'Keep riding. End ride is in the menu.' };
  return { zc: v.gradeHex(s.grade), label: 'Free ride', count: `${(s.grade * 100).toFixed(1)}%`, target: '', targetSub: 'D-pad &#9650;&#9660; changes the grade' };
}

/**
 * Power (and its on-target gauge: centre = target, ends = ±20%; a slope step's aim works like the cadence box),
 * heart rate, cadence, and the third box: Effort in ERG, Gear in slope (ring × cog, cogs counted from the largest = 1).
 * `gaugeAt` is the dot's left (null: the gauge is off); `powerState` / `cadState` are 'ok', 'bad' or ''.
 */
/** @param {Session} s @param {RideView} v */
export function phoneBoxes(s, v) {
  return { ...phonePower(s, v), ...phoneHrCad(s, v), ...phoneThird(s) };
}
/** @param {Session} s */
function phonePower(s, v) {
  const p = Math.round(s.powerShown);
  const aim = s.mode !== 'erg' && s.seg?.kind === 'sim' ? s.seg.aim : null, as = aim ? s.aimStatus : null;
  const gt = s.target || (aim ? aim.mid * v.ftp : 0);
  return {
    power: p,
    gaugeAt: gt ? `${Math.max(0, Math.min(1, (p / gt - 0.8) / 0.4)) * 100}%` : null,
    powerState: as === 'ok' ? 'ok' : as === 'low' || as === 'high' ? 'bad' : '',
    powerSub: !aim ? '' : as === 'low' ? '&#9650; push harder' : as === 'high' ? '&#9660; ease off' : `${Math.round(aim.lo * v.ftp)}-${Math.round(aim.hi * v.ftp)} W`,
  };
}
/** @param {Session} s */
function phoneHrCad(s, v) {
  const td = s.trainer.data || {}, cs = s.cadStatus, cad = s.seg?.cad;
  return {
    hr: Math.round(v.hrBpm || td.hr || 0) || '--',
    cad: Math.round(td.cadence || 0),
    cadState: cs === 'ok' ? 'ok' : cs === 'low' || cs === 'high' ? 'bad' : '',
    cadSub: !cad ? '' : cs === 'low' ? '&#9650; faster' : cs === 'high' ? '&#9660; slower' : cad.label,
  };
}
/** @param {Session} s */
function phoneThird(s) {
  if (s.mode === 'erg') {
    return { m3k: 'Effort', m3: `${Math.round(s.intensity * 100)}%`, m3sub: s.intensity > 1.001 ? 'harder than plan' : s.intensity < 0.999 ? 'easier than plan' : 'as planned', up: s.intensity > 1.001, down: s.intensity < 0.999 };
  }
  const gb = s.gb, kmh = Math.round(s.bike.v * 3.6);
  return { m3k: 'Gear', m3: gb.seq ? gb.label : gb.isDouble ? `${gb.front + 1}×${gb.rear + 1}` : `${gb.rear + 1}`, m3sub: gb.seq ? `${kmh} km/h` : `${gb.ring}×${gb.cog} · ${kmh} km/h`, up: false, down: false };
}

/** Next line: the next step (its color, amount, target, cadence), "Last interval", or speed and distance in a free ride. */
/** @param {Session} s @param {RideView} v */
export function phoneNext(s, v) {
  const next = s.segs && s.segIndex >= 0 ? s.segs[s.segIndex + 1] : null;
  if (!next) return s.seg ? 'Last interval' : `${(s.bike.v * 3.6).toFixed(1)} km/h &middot; ${fmtDist(s.bike.dist)}`;
  const color = next.kind === 'erg' ? v.zoneHex(segTarget(next, 0)) : v.gradeHex(next.grade + (s?.gradeOffset || 0));
  const target = next.kind === 'erg'
    ? (next.from === next.to ? `${Math.round(next.from * v.ftp * s.intensity)} W` : `${Math.round(next.from * v.ftp * s.intensity)}-${Math.round(next.to * v.ftp * s.intensity)} W`)
    : `${((next.grade + s.gradeOffset) * 100).toFixed(0)}%`;
  return `Next <span class="sw" style="background:${color}"></span><b>${segAmount(next)} @ ${target}</b>${next.cad ? ` &middot; ${next.cad.label}` : ''}`;
}

/** The buttons' labels and which sheet buttons show (`hidden`: grade row, skip, lap, erg). */
/** @param {Session} s */
export function phoneButtons(s) {
  const erg = s.mode === 'erg', seg = s.seg;
  return {
    minus: erg ? '&minus;1%' : 'Gear &minus;', plus: erg ? '+1%' : 'Gear +',
    pause: !s.started ? 'Start' : s.paused ? 'Resume' : 'Pause',
    hidden: {
      'rp-grade-row': erg, 'rp-skip': !seg,
      'rp-lap': !!seg, // workouts lap every interval on their own
      'rp-erg': !seg || (seg.kind !== 'erg' && !s.ergOff),
    },
    erg: s.ergOff ? 'ERG back on' : 'ERG off',
  };
}

/** The label over the chart / list: road progress on a slope-only workout, else "Workout · 3/8 done". */
/** @param {Session} s */
export function phoneViewK(s) {
  const n = s.segs.length, done = Math.min(s.segIndex < 0 ? n : s.segIndex, n);
  return isTrack(s.segs) ? trackProgress(s) : `Workout &middot; ${done}/${n} done`;
}

/** @param {Session} s */
export function renderPhone(s) {
  const v = rideView(s);
  const set = (id, x) => { const el = document.getElementById(id); if (el.innerHTML !== String(x)) el.innerHTML = x; };

  const t = phoneTop(s);
  set('rp-elapsed', t.elapsed);
  set('rp-name', t.name);
  set('rp-left-k', t.leftK);
  set('rp-left', t.left);

  const h = phoneHero(s, v);
  set('rp-int-label', h.label);
  set('rp-count', h.count);
  set('rp-target', h.target);
  set('rp-target-sub', h.targetSub);
  setZc($('#rp'), h.zc);

  const b = phoneBoxes(s, v);
  set('rp-power', b.power);
  const gauge = $('#rp-gauge');
  gauge.classList.toggle('off', b.gaugeAt === null);
  if (b.gaugeAt !== null) gauge.querySelector('b').style.left = b.gaugeAt;
  const pb = $('#rp-power-box');
  pb.classList.toggle('ok', b.powerState === 'ok');
  pb.classList.toggle('bad', b.powerState === 'bad');
  set('rp-power-sub', b.powerSub);
  set('rp-hr', b.hr);
  set('rp-cad', b.cad);
  const cb = $('#rp-cad-box');
  cb.classList.toggle('ok', b.cadState === 'ok');
  cb.classList.toggle('bad', b.cadState === 'bad');
  set('rp-cad-sub', b.cadSub);
  const m3 = $('#rp-m3').parentElement;
  set('rp-m3-k', b.m3k);
  set('rp-m3', b.m3);
  set('rp-m3-sub', b.m3sub);
  m3.classList.toggle('up', b.up);
  m3.classList.toggle('down', b.down);

  set('rp-next', phoneNext(s, v));

  const k = phoneButtons(s);
  set('rp-minus', k.minus);
  set('rp-plus', k.plus);
  set('rp-pause', k.pause);
  for (const [id, hide] of Object.entries(k.hidden)) $(`#${id}`).classList.toggle('hidden', hide);
  set('rp-erg', k.erg);

  renderPhoneView(s);
  drawPhoneChart();
}

// Chart vs list for the workout area (app.phoneView, read in initRidePhone()). Remembered across rides; switchable mid-ride.
const phoneList = (s) => !!s?.segs && app.phoneView === 'list';

/** @param {Session} s */
function renderPhoneView(s) {
  const wrap = $('#rp-wrap'), list = phoneList(s);
  wrap.classList.toggle('no-segs', !s.segs);
  wrap.classList.toggle('as-list', list);
  for (const b of /** @type {HTMLCollectionOf<HTMLElement>} */ ($('#rp-view-tg').children)) b.classList.toggle('on', b.dataset.view === (list ? 'list' : 'chart'));
  if (!s.segs) return;
  const k = phoneViewK(s);
  const kEl = $('#rp-view-k');
  if (kEl.innerHTML !== k) kEl.innerHTML = k;
  if (!list) return;
  const { rows, cur } = segRows(s);
  const el = /** @type {HTMLElement & { _html?: string }} */ ($('#rp-segs')), html = rows.join('');
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  if (app._rpSegI !== cur) { // keep the current interval centred when it changes (or the list was just opened)
    const jump = app._rpSegI === undefined;
    app._rpSegI = cur;
    const row = /** @type {HTMLElement} */ (el.querySelector('.seg.current') || el.lastElementChild);
    if (row) el.scrollTo({ top: Math.max(0, row.offsetTop - (el.clientHeight - row.offsetHeight) / 2), behavior: jump ? 'auto' : 'smooth' });
  }
}

// Geometry of the phone chart, pure. Canvas pixels: y grows down, `bot` is the baseline.
/** Free ride: the last 10 minutes; power to y with the top at FTP x 1.5 or the window's peak + 20 W if higher. */
export function phoneFreeScale(data, ftp, bot, plotH) {
  const maxP = Math.max(ftp * 1.5, ...data.map((x) => x.power + 20));
  return { maxP, Y: (v) => bot - (Math.min(v, maxP) / maxP) * plotH };
}
/** A workout: power to y with the top at the hardest ERG step (at least 130% FTP) + 8%, or the last 30 minutes' peak + 10 W. */
/** @param {Session} s */
export function phoneScale(s, ftp, bot, plotH) {
  const ergMax = Math.max(1.3, ...s.segs.filter((g) => g.kind === 'erg').map((g) => Math.max(g.from, g.to) * s.intensity)) * 1.08;
  const maxP = Math.max(ergMax * ftp, ...s.samples.slice(-1800).map((x) => x.power + 10));
  return { maxP, Yp: (w) => bot - (Math.min(w, maxP) / maxP) * plotH };
}
/** How many slices a block is drawn in: a ramp one per 3 px so it steps up, anything else one. */
export const phoneSlices = (g, x0, x1, dpr) => (g.kind === 'erg' && g.from !== g.to ? Math.max(1, Math.ceil((x1 - x0) / (3 * dpr))) : 1);

/** Workout bars like Zwift: solid zone-coloured blocks, done part dimmed under the power trace. */
export function drawPhoneChart() {
  const { INK, MUTED, FTP_LINE } = look();
  const s = app.session;
  if (!s || !isPhone() || phoneList(s)) return;
  const ctx = rpCanvas.getContext('2d');
  const W = rpCanvas.width, H = rpCanvas.height, dpr = devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const top = 14 * dpr, bot = H - 2 * dpr, plotH = bot - top;
  const ftp = app.settings.ftp;
  ctx.font = `600 ${11.5 * dpr}px ${NUM_FONT}`;

  if (!s.segs) {
    // free ride: last 10 minutes of power over the grade
    const win = 600, data = s.samples.slice(-win);
    const { Y } = phoneFreeScale(data, ftp, bot, plotH);
    data.forEach((x, i) => {
      const g = (x.grade || 0) / 100, h = gradeBarH(g, plotH, 0.7, 2 * dpr);
      const x0 = Math.floor((i / win) * W); ctx.fillStyle = gradeHex(g) + '88'; ctx.fillRect(x0, bot - h, Math.floor(((i + 1) / win) * W) - x0, h);
    });
    ctx.strokeStyle = INK; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
    const sp = smoothPower(s.samples).slice(-win);
    data.forEach((x, i) => { const px = (i / win) * W; i ? ctx.lineTo(px, Y(sp[i])) : ctx.moveTo(px, Y(sp[i])); });
    ctx.stroke();
    drawHrTrace(ctx, data, (x, i) => (i / win) * W, W, H, top, dpr);
    ctx.fillStyle = MUTED; ctx.fillText('Last 10 min', 2 * dpr, 10 * dpr);
    return;
  }

  if (isTrack(s.segs)) return drawTrack(ctx, s, { W, H, dpr, top, bot, area: 0.7, compact: true });
  const segs = s.segs, pos = s.chartPos;
  const X = workoutX(s, W);
  const { Yp } = phoneScale(s, ftp, bot, plotH);
  const gap = segs.length > 60 ? 0 : 1 * dpr;
  const cur = s.segIndex;

  segs.forEach((g, i) => {
    const x0 = X(g.start), x1 = X(g.end);
    const n = phoneSlices(g, x0, x1, dpr);
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      const sx0 = Math.round(x0 + (x1 - x0) * a), sx1 = Math.round(x0 + (x1 - x0) * b);
      let y, col;
      if (g.kind === 'erg') { const f = segTarget(g, (a + b) / 2); y = Yp(f * ftp * s.intensity); col = zoneHex(f); }
      else { const gr = g.grade + s.gradeOffset; y = bot - gradeBarH(gr, plotH, 0.7, 4 * dpr); col = gradeHex(gr); }
      const tMid = g.start + (g.end - g.start) * (a + b) / 2;
      ctx.globalAlpha = tMid < pos ? 0.38 : 1;
      ctx.fillStyle = col;
      ctx.fillRect(sx0, y, Math.max(1, sx1 - sx0 - (k === n - 1 ? gap : 0)), bot - y);
    }
    ctx.globalAlpha = 1;
    if (i === cur) { // outline the current block
      const y = g.kind === 'erg' ? Math.min(Yp(g.from * ftp * s.intensity), Yp(g.to * ftp * s.intensity)) : bot - gradeBarH(g.grade + s.gradeOffset, plotH, 0.7, 4 * dpr);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(x0 + dpr * 0.75, y - dpr * 0.75, Math.max(2, x1 - x0 - gap - dpr * 1.5), bot - y + dpr * 0.75);
    }
  });

  // FTP line
  ctx.strokeStyle = FTP_LINE; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = MUTED; ctx.fillText(`FTP ${ftp}`, 2 * dpr, Math.max(10 * dpr, Yp(ftp) - 4 * dpr));

  // power trace over the done part
  ctx.strokeStyle = INK; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  const sp = smoothPower(s.samples);
    s.samples.forEach((x, i) => { const px = X(x.wx ?? x.wt), py = Yp(sp[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
  drawHrTrace(ctx, s.samples, (x) => X(x.wx ?? x.wt), W, H, top, dpr);

  // position marker
  const mx = X(pos);
  ctx.fillStyle = INK;
  ctx.fillRect(mx - dpr, top - 4 * dpr, 2 * dpr, bot - top + 4 * dpr);
  ctx.beginPath(); ctx.moveTo(mx - 6 * dpr, top - 10 * dpr); ctx.lineTo(mx + 6 * dpr, top - 10 * dpr); ctx.lineTo(mx, top - 2 * dpr); ctx.closePath(); ctx.fill();
}

// phone buttons
const rpTap = (id, fn) => { const el = document.getElementById(id); el.onclick = (e) => { e.preventDefault(); fn(); renderRide(); }; };
// phone sheet: press and hold (pointer + touch, since Bluefy doesn't always send pointer events); the sheet closes when it completes
function bindHold(id, kind) {
  const el = document.getElementById(id);
  const down = (e) => { e.preventDefault(); holdStart(kind, 'tap', el); };
  const up = () => holdEnd(kind);
  el.addEventListener('pointerdown', down);
  el.addEventListener('touchstart', down, { passive: false });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'touchend', 'touchcancel']) el.addEventListener(ev, up);
  el.addEventListener('click', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
