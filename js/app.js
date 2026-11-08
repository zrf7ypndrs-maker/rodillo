import { Trainer } from './ble/trainer.js?v=202611082251';
import { HeartRate } from './ble/hr.js?v=202611082251';
import { ZwiftRide } from './ble/zwiftride.js?v=202611082251';
import { SimTrainer, SimHr } from './ble/sim.js?v=202611082251';
import { log, logMsg } from './ble/base.js?v=202611082251';
import { Session, DEFAULT_SETTINGS } from './engine/session.js?v=202611082251';
import { DRIVETRAINS } from './engine/drivetrain.js?v=202611082251';
import { flatten, totalDuration, estimateTSS, parseZwo, segTarget } from './engine/workout.js?v=202611082251';
import { encodeActivity } from './fit.js?v=202611082251';
import { buildRide, loadSeries, weekly, powerCurve, ftpEstimate, formLabel, CURVE_DURS } from './stats.js?v=202611082251';
import { GitHubSync, DEFAULT_REPO, PLAN_PATH, WORKOUTS_PATH } from './sync.js?v=202611082251';
import { ls, rides } from './store.js?v=202611082251';

const BUILD = new URL(import.meta.url).searchParams.get('v') || 'dev';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const zoneColor = (f) => f < 0.56 ? 'var(--z1)' : f < 0.76 ? 'var(--z2)' : f < 0.88 ? 'var(--z3)' : f < 1.06 ? 'var(--z4)' : f < 1.21 ? 'var(--z5)' : 'var(--z6)';
const ZC = { z1: '#7d8590', z2: '#3d8bfd', z3: '#3ccf7a', z4: '#ffcc33', z5: '#ff8a33', z6: '#ff4d5e' };
const zoneHex = (f) => f < 0.56 ? ZC.z1 : f < 0.76 ? ZC.z2 : f < 0.88 ? ZC.z3 : f < 1.06 ? ZC.z4 : f < 1.21 ? ZC.z5 : ZC.z6;
const gradeHex = (g) => g < 0 ? '#5aa9a0' : g < 0.03 ? '#6c8db8' : g < 0.06 ? '#c9a640' : g < 0.09 ? '#e07b39' : '#e0484f';

// ------------------------------------------------------------------ state
const app = {
  settings: { ...DEFAULT_SETTINGS, ...ls.get('settings', {}) },
  trainer: null, hr: null, controllers: [],
  demo: false,
  library: [], plan: null,
  session: null, rideId: null,
  screen: 'home', tab: 'workouts', focus: 0,
  endArmed: 0,
};

// ------------------------------------------------------------------ logging
const logLines = [];
log.on('log', (l) => {
  logLines.push(`${new Date(l.t).toLocaleTimeString()} [${l.src}] ${l.msg}`);
  if (logLines.length > 400) logLines.shift();
  if (!$('#log').classList.contains('hidden')) $('#log-body').textContent = logLines.join('\n');
});

// ------------------------------------------------------------------ devices
async function connect(kind) {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not available. Open this page in Google Chrome on your Mac.');
    return;
  }
  if (app.demo) exitDemo();
  try {
    if (kind === 'trainer') {
      const t = app.trainer instanceof Trainer ? app.trainer : new Trainer();
      bindDevice(t);
      app.trainer = t;
      await t.pick(Trainer.requestOptions());
      ls.set('dev.trainer', t.device.id);
    } else if (kind === 'hr') {
      const h = app.hr instanceof HeartRate ? app.hr : new HeartRate();
      bindDevice(h);
      app.hr = h;
      await h.pick(HeartRate.requestOptions());
      ls.set('dev.hr', h.device.id);
    } else {
      const side = kind === 'controllerR' ? 'right' : kind === 'controller2' ? 'all' : 'left';
      if (side === 'left') { for (const old of app.controllers) old.disconnect(); app.controllers = []; }
      const c = new ZwiftRide();
      c.side = side;
      bindDevice(c);
      c.on('press', (b) => onButton(b, c));
      c.on('release', onRelease);
      app.controllers.push(c);
      await c.pick(ZwiftRide.requestOptions(side));
      ls.set('dev.controllers', app.controllers.map((x) => x.device?.id).filter(Boolean));
    }
  } catch (e) {
    if (kind.startsWith('controller')) app.controllers = app.controllers.filter((c) => c.device);
    if (e.name !== 'NotFoundError') { logMsg('app', e.message); alert(e.message); }
  }
  renderDevices();
}

function bindDevice(d) {
  if (d._bound) return;
  d._bound = true;
  d.on('state', renderDevices);
  d.on('battery', renderDevices);
}

/** On reload Chrome can hand back previously-permitted devices without the chooser. */
async function autoReconnect() {
  if (!navigator.bluetooth?.getDevices) return;
  try {
    const devs = await navigator.bluetooth.getDevices();
    const ids = { trainer: ls.get('dev.trainer'), hr: ls.get('dev.hr'), ctl: ls.get('dev.controllers', []) };
    for (const d of devs) {
      let obj = null;
      if (d.id === ids.trainer) { obj = app.trainer = new Trainer(); }
      else if (d.id === ids.hr) { obj = app.hr = new HeartRate(); }
      else if (ids.ctl.includes(d.id)) { obj = new ZwiftRide(); obj.on('press', (b) => onButton(b, obj)); obj.on('release', onRelease); app.controllers.push(obj); }
      if (!obj) continue;
      bindDevice(obj);
      obj.device = d;
      d.addEventListener('gattserverdisconnected', () => obj._onDisconnect());
      // wait for the device to advertise, then connect
      const go = () => obj.connect().catch(() => {}).finally(renderDevices);
      if (d.watchAdvertisements) {
        d.addEventListener('advertisementreceived', function once() { d.removeEventListener('advertisementreceived', once); go(); });
        d.watchAdvertisements().catch(go);
      } else go();
    }
    renderDevices();
  } catch (e) { logMsg('app', `auto-reconnect: ${e.message}`); }
}

function enterDemo() {
  app.demo = true;
  app.trainer = new SimTrainer({ realDev: 5.2, trainerMass: 78 });
  app.hr = new SimHr(app.trainer);
  renderDevices();
  toast('Demo mode: + / - change rider power');
}
function exitDemo() {
  app.demo = false;
  app.trainer = null; app.hr = null;
}

function renderDevices() {
  const card = (kind, dev, extra = '') => {
    const el = $(`.device[data-kind="${kind}"]`);
    const st = dev?.state || 'disconnected';
    el.classList.toggle('connected', st === 'connected');
    el.classList.toggle('connecting', st === 'connecting');
    el.querySelector('.dev-name').textContent = dev && st !== 'disconnected' ? dev.name : dev?.device ? `${dev.name} (reconnecting...)` : 'Not connected';
    const meta = [];
    if (dev?.info?.firmware) meta.push(`fw ${dev.info.firmware}`);
    if (dev?.info?.battery != null) meta.push(`battery ${dev.info.battery}%`);
    if (dev?.battery != null) meta.push(`battery ${dev.battery}%`);
    el.querySelector('.dev-meta').innerHTML = meta.join(' &middot; ') + extra;
    const btn = el.querySelector('[data-connect]');
    btn.textContent = st === 'connected' ? 'Reconnect' : 'Connect';
  };
  card('trainer', app.trainer, app.demo ? 'Simulated' : '');
  card('hr', app.hr);
  const ctl = app.controllers.find((c) => c.state === 'connected') || app.controllers[0];
  const names = app.controllers.filter((c) => c.state === 'connected').map((c) => c.name);
  const sides = app.controllers.filter((c) => c.state === 'connected').map((c) => c.side || 'left');
  card('controller', ctl, sides.length ? `<br>Connected: ${sides.join(' + ')}` : '');
  const anyCtl = app.controllers.some((c) => c.state === 'connected');
  $('[data-connect="controller2"]').classList.toggle('hidden', anyCtl);
  $('[data-connect="controllerR"]').classList.toggle('hidden', !anyCtl || app.controllers.some((c) => c.side === 'right' && c.state === 'connected'));
  const fw = ctl?.info?.firmware;
  if (fw && /^(\d+)\.(\d+)/.test(fw)) {
    const [, a, b] = fw.match(/^(\d+)\.(\d+)/).map(Number);
    if (a > 1 || (a === 1 && b > 2)) $('.device[data-kind="controller"] .dev-meta').innerHTML += '<br><span style="color:var(--warn)">Firmware above 1.2 is locked to Zwift</span>';
  }
  renderRideStatus();
}

// ------------------------------------------------------------------ library
async function loadLibrary() {
  const src = $('#library-source');
  try {
    const idx = await (await fetch('workouts/index.json', { cache: 'no-cache' })).json();
    const list = await Promise.all(idx.workouts.map((f) => fetch(`workouts/${f}`, { cache: 'no-cache' }).then((r) => r.json()).catch(() => null)));
    app.baseLibrary = list.filter(Boolean);
    src.textContent = `${app.baseLibrary.length} workouts from the coach library`;
  } catch {
    app.baseLibrary = [];
    src.textContent = 'Could not load the coach library (open the app from its GitHub Pages URL).';
  }
  try { app.basePlan = await (await fetch('plans/current.json', { cache: 'no-cache' })).json(); } catch { app.basePlan = null; }
  app.coachPlan = ls.get('coachPlan', null);
  app.coachWorkouts = ls.get('coachWorkouts', []);
  applyLibrary();
  await loadCoachData();
}

/** Coach edits (plan + workouts) live in rodillo-data/coach/ and win over the public library. */
async function loadCoachData() {
  const gh = syncClient();
  if (!gh) return;
  try {
    const [p, w] = await Promise.all([gh.getJson(PLAN_PATH), gh.getJson(WORKOUTS_PATH)]);
    app.coachPlan = p?.json || null;
    app.coachWorkouts = w?.json?.workouts || [];
    ls.set('coachPlan', app.coachPlan);
    ls.set('coachWorkouts', app.coachWorkouts);
    applyLibrary();
  } catch (e) { logMsg('coach', `could not load coach data: ${e.message}`); }
}

function applyLibrary() {
  const custom = new Map((app.coachWorkouts || []).map((w) => [w.id, { ...w, _source: 'coach' }]));
  const lib = (app.baseLibrary || []).map((w) => custom.get(w.id) || w);
  for (const [id, w] of custom) if (!lib.some((x) => x.id === id)) lib.push(w);
  for (const w of ls.get('imported', [])) lib.push(w);
  app.library = lib;
  app.plan = app.coachPlan || app.basePlan || null;
  renderLibrary();
  refreshPlanViews();
}

function profileSvg(w, width = 340, height = 54) {
  const segs = flatten(w, app.settings.ftp);
  const T = segs.length ? segs[segs.length - 1].end : 1;
  const maxF = 1.5;
  let out = '';
  for (const s of segs) {
    const x = (s.start / T) * width, wd = Math.max(0.5, (s.dur / T) * width);
    if (s.kind === 'erg') {
      const y0 = height - (Math.min(s.from, maxF) / maxF) * height, y1 = height - (Math.min(s.to, maxF) / maxF) * height;
      out += `<polygon points="${x},${height} ${x},${y0} ${x + wd},${y1} ${x + wd},${height}" fill="${zoneHex((s.from + s.to) / 2)}" opacity=".9"/>`;
    } else {
      const g = s.grade;
      const h = Math.max(4, ((g + 0.03) / 0.15) * height);
      out += `<rect x="${x}" y="${height - h}" width="${wd}" height="${h}" fill="${gradeHex(g)}" opacity=".9"/>`;
    }
  }
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${out}</svg>`;
}

const isSim = (w) => flatten(w).some((s) => s.kind === 'sim');
function woMeta(w) {
  const dist = flatten(w).filter((x) => x.dist).reduce((a, x) => a + x.dist, 0);
  const mins = Math.round(totalDuration(w) / 60);
  if (dist) return `${(dist / 1000).toFixed(1)} km of climbing steps &middot; ~${mins} min`;
  const tss = estimateTSS(w);
  return `${mins} min${isSim(w) ? '' : ` &middot; TSS ~${tss}`}`;
}

const isSlopeOnly = (w) => flatten(w).every((x) => x.kind === 'sim');

function workoutCard(w, i) {
  return `
    <div class="wo" data-i="${i}" tabindex="0">
      <div class="wo-top"><div class="wo-name">${esc(w.name)}</div><div class="wo-meta">${woMeta(w)}</div></div>
      ${profileSvg(w)}
      <div>${isSim(w) ? '<span class="tag sim">slope + gears</span>' : '<span class="tag">ERG</span>'}${w._source === 'coach' ? '<span class="tag coach">coach</span>' : ''}${(w.tags || []).filter((t) => !['sim'].includes(t)).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="wo-desc">${esc(w.description)}</div>
      <div class="start-row"><button class="primary small" data-start="${i}">Start</button>${w.tags?.includes('imported') ? `<button class="ghost small" data-remove="${i}">Remove</button>` : ''}</div>
    </div>`;
}

function renderLibrary() {
  const erg = [], slope = [];
  app.library.forEach((w, i) => (isSlopeOnly(w) ? slope : erg).push(workoutCard(w, i)));
  $('#workout-list').innerHTML = erg.join('');
  $('#slope-list').innerHTML = slope.join('') || '<p class="muted">No slope sessions yet.</p>';
  $$('.wo').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.dataset.start) return startWorkout(app.library[+e.target.dataset.start]);
    if (e.target.dataset.remove) return removeImported(app.library[+e.target.dataset.remove]);
    c.classList.toggle('expanded');
  }));
  applyFocus();
}

// ------------------------------------------------------------------ plan: week carousel + calendar
const dkey = (d) => d.toLocaleDateString('en-CA');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

function workoutColor(w) {
  const segs = flatten(w);
  if (segs.every((x) => x.kind === 'sim')) return '#6c8db8';
  const work = Math.max(...segs.filter((x) => x.kind === 'erg' && x.dur >= 30).map((x) => (x.from + x.to) / 2));
  return zoneHex(work);
}

/** What's planned and what was ridden on a given date. */
function dayInfo(key) {
  const entry = app.plan?.days?.[key];
  const w = entry && app.library.find((x) => x.id === entry);
  const ridden = (app.rows || []).filter((r) => !r.demo && r.summary.id.slice(0, 10) === key).map((r) => r.summary);
  const done = w ? ridden.find((r) => r.workoutId === w.id) || ridden[0] : ridden[0];
  return {
    key, workout: w || null, kind: w ? 'ride' : entry || null,
    note: app.plan?.notes?.[key] || '', ridden, done,
    isToday: key === dkey(new Date()), isPast: key < dkey(new Date()),
  };
}

function dayCardHtml(info) {
  const d = new Date(info.key + 'T12:00');
  const dow = d.toLocaleDateString([], { weekday: 'short' });
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  let body, status = '';
  if (info.workout) {
    const w = info.workout;
    body = `<div class="d-name">${esc(w.name)}</div><div class="d-meta">${woMeta(w)}</div>${profileSvg(w, 220, 34)}`;
  } else if (info.kind === 'strength') body = '<div class="d-name muted">Strength</div><div class="d-meta">Gym day, no ride</div>';
  else if (info.kind === 'rest') body = '<div class="d-name muted">Rest</div>';
  else body = '<div class="d-name muted">Nothing planned</div>';
  if (info.done) status = `<div class="d-done">&#10003; ${info.done.workoutId === info.workout?.id ? 'Done' : esc(info.done.name)} &middot; ${info.done.tss} TSS</div>`;
  else if (info.workout && info.isPast) status = '<div class="d-missed">Missed</div>';
  else if (info.workout && info.isToday) status = `<button class="primary small" data-startday="${info.key}">Start</button>`;
  return `<div class="day ${info.isToday ? 'today' : ''} ${info.isPast ? 'past' : ''} ${info.done ? 'done' : ''}" data-day="${info.key}" style="--c:${info.workout ? workoutColor(info.workout) : '#2a2f37'}" tabindex="0">
    <div class="d-top"><span class="d-dow">${info.isToday ? 'Today' : dow}</span><span class="d-date">${date}</span></div>${body}${status}${recoveryPill(info.key)}</div>`;
}

function renderWeek() {
  const el = $('#week');
  if (!app.plan) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const start = mondayOf(new Date());
  const days = Array.from({ length: 14 }, (_, i) => dayInfo(dkey(addDays(start, i))));
  const today = days.find((x) => x.isToday);
  const note = (today?.workout && today.note ? `<p class="week-note"><b>Today:</b> ${esc(today.note)}</p>` : '') + recoveryAdvice(today);
  el.innerHTML = `<div class="week-head"><div><span class="eyebrow">${esc(app.plan.name || 'Plan')}</span> <span class="muted">this week and next</span></div>
    <div class="row-btns"><button class="ghost small" data-scroll="-1">&lsaquo;</button><button class="ghost small" data-scroll="1">&rsaquo;</button></div></div>
    <div class="week-strip" id="week-strip">${days.map(dayCardHtml).join('')}</div>${note}`;
  const strip = $('#week-strip');
  el.querySelectorAll('[data-scroll]').forEach((b) => (b.onclick = () => strip.scrollBy({ left: +b.dataset.scroll * strip.clientWidth * 0.8, behavior: 'smooth' })));
  bindDayCards(el);
  bindRecoveryAdvice(el);
  const t = strip.querySelector('.day.today');
  if (t) strip.scrollLeft = Math.max(0, t.offsetLeft - strip.offsetLeft - 8);
}

function bindDayCards(root) {
  root.querySelectorAll('[data-startday]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const i = dayInfo(b.dataset.startday); if (i.workout) startWorkout(i.workout); }));
  root.querySelectorAll('.day[data-day], .cal-cell[data-day]').forEach((c) => (c.onclick = () => { app.calMonth = c.dataset.day.slice(0, 7); app.calSel = c.dataset.day; setTab('calendar'); }));
}

function renderCalendar() {
  const now = new Date();
  const ym = app.calMonth || dkey(now).slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const start = mondayOf(first);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.getMonth() !== m - 1) break;
    cells.push(d);
  }
  const sel = app.calSel || dkey(now);
  $('#cal-title').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });
  $('#cal-grid').innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('') +
    cells.map((d) => {
      const info = dayInfo(dkey(d));
      const chip = info.workout ? `<div class="cal-chip" style="--c:${workoutColor(info.workout)}">${esc(info.workout.name)}<span>${Math.round(totalDuration(info.workout) / 60)}'</span></div>`
        : info.kind === 'strength' ? '<div class="cal-chip ghost">Strength</div>' : info.kind === 'rest' ? '<div class="cal-chip ghost">Rest</div>' : '';
      const done = info.done ? `<div class="cal-done">&#10003; ${info.done.tss} TSS</div>` : info.workout && info.isPast ? '<div class="cal-missed">missed</div>' : '';
      return `<div class="cal-cell ${d.getMonth() !== m - 1 ? 'other' : ''} ${info.isToday ? 'today' : ''} ${info.key === sel ? 'sel' : ''}" data-day="${info.key}">
        <div class="cal-num">${d.getDate()}</div>${chip}${done}</div>`;
    }).join('');
  $('#cal-grid').querySelectorAll('.cal-cell').forEach((c) => (c.onclick = () => { app.calSel = c.dataset.day; if (c.dataset.day.slice(0, 7) !== ym) app.calMonth = c.dataset.day.slice(0, 7); renderCalendar(); }));
  // detail for the selected day
  const info = dayInfo(sel);
  const date = new Date(sel + 'T12:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  let html = `<h3>${date}</h3>`;
  if (info.workout) {
    const w = info.workout;
    html += `<div class="cal-wo"><div class="wo-top"><div class="wo-name">${esc(w.name)}</div><div class="wo-meta">${woMeta(w)}</div></div>${profileSvg(w, 600, 60)}
      ${info.note ? `<p><b>Coach:</b> ${esc(info.note)}</p>` : ''}<p class="muted">${esc(w.description)}</p>
      <button class="primary small" data-startday="${sel}">${info.isToday ? 'Start' : 'Ride it now'}</button></div>`;
  } else html += `<p class="muted">${info.kind === 'strength' ? 'Strength day: no ride planned.' : info.kind === 'rest' ? 'Rest day.' : 'Nothing planned.'}</p>`;
  html += coachDecision(sel);
  const wd = whoopDay(sel);
  if (wd?.recovery != null) html += `<div class="cal-ride" style="color:var(--muted)">WHOOP: recovery <b class="rz ${recZone(wd.recovery)}">${wd.recovery}%</b>${wd.hrv ? ` &middot; HRV ${Math.round(wd.hrv)} ms` : ''}${wd.rhr ? ` &middot; RHR ${wd.rhr}` : ''}${wd.sleepHours ? ` &middot; sleep ${wd.sleepHours} h` : ''}${wd.strain != null ? ` &middot; strain ${wd.strain}` : ''}</div>`;
  for (const r of info.ridden) {
    html += `<div class="cal-ride">&#10003; <b>${esc(r.name)}</b> &middot; ${fmtTime(r.durSec)} &middot; NP ${r.np} W &middot; TSS ${r.tss}${r.avgHr ? ` &middot; HR ${r.avgHr}` : ''}${r.compliance ? ` &middot; intervals ${r.compliance.avg}% (min ${r.compliance.min}%)` : ''}</div>`;
  }
  $('#cal-detail').innerHTML = html;
  $('#cal-detail').querySelectorAll('[data-startday]').forEach((b) => (b.onclick = () => startWorkout(info.workout)));
}

// ------------------------------------------------------------------ WHOOP recovery
const recZone = (r) => (r >= 67 ? 'green' : r >= 34 ? 'yellow' : 'red');
const whoopDay = (key) => app.whoop?.[key];

function recoveryPill(key) {
  const d = whoopDay(key);
  if (d?.recovery == null) return '';
  return `<div class="rec-pill ${recZone(d.recovery)}">Recovery ${d.recovery}%${d.hrv ? ` &middot; HRV ${Math.round(d.hrv)}` : ''}</div>`;
}

function isHard(w) {
  if (!w) return false;
  if ((w.tags || []).some((t) => ['vo2', 'threshold', 'test'].includes(t))) return true;
  return flatten(w).some((x) => x.kind === 'erg' && x.dur >= 120 && (x.from + x.to) / 2 >= 0.88);
}

/** Coach's read of today's recovery vs today's session. */
function recoveryAdvice(today) {
  if (!today) return '';
  const d = whoopDay(today.key);
  if (d?.recovery == null) return coachDecision(today.key) || (app.whoop ? '<p class="week-note muted">WHOOP: today\'s recovery isn\'t scored yet.</p>' : '');
  const z = recZone(d.recovery), w = today.workout;
  const facts = `Recovery <b class="rz ${z}">${d.recovery}%</b>${d.hrv ? `, HRV ${Math.round(d.hrv)} ms` : ''}${d.rhr ? `, RHR ${d.rhr}` : ''}${d.sleepHours ? `, slept ${d.sleepHours} h` : ''}.`;
  let advice = '', btns = '';
  // The morning coach run already weighed recovery against the plan: show its call, don't adjust twice.
  const decided = coachDecision(today.key);
  if (decided) return `<div class="rec-advice ${z} stacked"><p>${facts}</p>${decided}</div>`;
  if (!w || today.done) advice = '';
  else if (z === 'red' && isHard(w)) {
    advice = ` Hard session on a red day is a bad trade. Swap to easy Zone 2, or ride it at 90%.`;
    btns = `<button class="primary small" data-rec="swap">Swap to Zone 2, 60 min</button><button class="ghost small" data-rec="0.9">Ride it at 90%</button>`;
  } else if (z === 'red') {
    advice = ' Keep it truly easy today; drop to 95% if HR runs high.';
    btns = `<button class="ghost small" data-rec="0.95">Ride at 95%</button>`;
  } else if (z === 'yellow' && isHard(w)) {
    advice = ' Ride as planned. If the first rep feels like a fight, nudge effort down 2-3% with the left shifter.';
    btns = `<button class="ghost small" data-rec="0.97">Start at 97%</button>`;
  } else advice = ' Green light: ride as planned.';
  return `<div class="rec-advice ${z}"><p>${facts}${advice}</p>${btns ? `<div class="row-btns">${btns}</div>` : ''}</div>`;
}

const DECISION_LABEL = { kept: 'Ride as planned', scaled: 'Adjusted', swapped: 'Swapped', moved: 'Moved', rest: 'Rest instead' };

/** The daily coach run's decision for a day (plan.daily[key]), as HTML. */
function coachDecision(key) {
  const d = app.plan?.daily?.[key];
  if (!d?.reason) return '';
  const label = DECISION_LABEL[d.action] || 'Coach';
  return `<p class="coach-call"><span class="tag coach">coach &middot; ${esc(label)}</span> ${esc(d.reason)}</p>`;
}

function bindRecoveryAdvice(root) {
  root.querySelectorAll('[data-rec]').forEach((b) => (b.onclick = () => {
    const today = dayInfo(dkey(new Date()));
    if (b.dataset.rec === 'swap') { const z2 = app.library.find((x) => x.id === 'z2-60'); if (z2) startWorkout(z2); }
    else if (today.workout) startWorkout(today.workout, Number(b.dataset.rec));
  }));
}

async function loadWhoop() {
  app.whoop = ls.get('whoop', null);
  const gh = syncClient();
  if (!gh) return;
  try {
    const r = await gh.getJson('whoop/daily.json');
    if (r?.json?.days) { app.whoop = r.json.days; ls.set('whoop', app.whoop); }
  } catch (e) { logMsg('whoop', e.message); }
}

async function refreshPlanViews() {
  app.rows = await trainingRows();
  await loadWhoop();
  renderWeek();
  if (app.tab === 'calendar') renderCalendar();
}

function removeImported(w) {
  ls.set('imported', ls.get('imported', []).filter((x) => x.id !== w.id));
  app.library = app.library.filter((x) => x !== w);
  renderLibrary();
}

async function trainingRows() {
  const remote = ls.get('remoteIndex', []);
  let local = [];
  try { local = (await rides.list()).filter((r) => r.status === 'done' || r.status === 'inprogress'); } catch { /* no idb */ }
  const rows = new Map();
  for (const r of remote) rows.set(r.id, { summary: r, synced: true });
  for (const l of local) {
    if (!l.summary?.id) continue; // rides from before history tracking
    const row = rows.get(l.summary.id) || { summary: l.summary, synced: false };
    row.local = l;
    row.demo = l.demo;
    if (l.status === 'inprogress') row.interrupted = true;
    rows.set(l.summary.id, row);
  }
  return [...rows.values()].sort((x, y) => (x.summary.id < y.summary.id ? 1 : -1));
}

function svgLoad(series) {
  const W = 560, H = 230, top = 150, n = series.length;
  if (n < 2) return '<p class="muted">Ride a few times to see fitness and fatigue.</p>';
  const maxL = Math.max(10, ...series.map((d) => Math.max(d.ctl, d.atl))) * 1.1;
  const maxB = Math.max(10, ...series.map((d) => Math.abs(d.tsb)));
  const X = (i) => (i / (n - 1)) * (W - 40) + 30;
  const Y = (v) => top - (v / maxL) * (top - 10);
  const B = (v) => 190 - (v / maxB) * 35;
  const line = (k, c) => `<polyline fill="none" stroke="${c}" stroke-width="2.5" points="${series.map((d, i) => `${X(i)},${Y(d[k])}`).join(' ')}"/>`;
  const bw = Math.max(1, (W - 40) / n - 1);
  const bars = series.map((d, i) => `<rect x="${X(i) - bw / 2}" y="${Math.min(B(d.tsb), 190)}" width="${bw}" height="${Math.abs(B(d.tsb) - 190)}" fill="${d.tsb >= 0 ? '#3ccf7a' : '#ff8a33'}" opacity=".75"/>`).join('');
  const ticks = series.map((d, i) => d.date.endsWith('-01') || i === 0 ? `<text x="${X(i)}" y="226" fill="#8b93a1" font-size="12">${new Date(d.date + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart">
    <text x="0" y="14" fill="#8b93a1" font-size="12">${Math.round(maxL)}</text>
    <line x1="30" x2="${W - 10}" y1="190" y2="190" stroke="#2a2f37"/>${bars}${line('atl', '#ff6b9a')}${line('ctl', '#3d8bfd')}${ticks}
    <text x="${W - 10}" y="14" text-anchor="end" font-size="11"><tspan fill="#3d8bfd">&#9632; Fitness</tspan> <tspan fill="#ff6b9a">&#9632; Fatigue</tspan> <tspan fill="#3ccf7a">&#9632; Form</tspan></text></svg>`;
}

function svgWeekly(weeks) {
  const W = 560, H = 200, n = weeks.length;
  const max = Math.max(100, ...weeks.map((w) => w.tss));
  const bw = (W - 20) / n;
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart">${weeks.map((w, i) => {
    const h = (w.tss / max) * 120, x = 10 + i * bw;
    return `<rect x="${x + 6}" y="${165 - h}" width="${bw - 12}" height="${h}" rx="4" fill="${i === n - 1 ? '#ff5a36' : '#3d8bfd'}" opacity=".85"/>
      ${w.tss ? `<text x="${x + bw / 2}" y="${158 - h}" text-anchor="middle" fill="#eef1f5" font-size="13">${w.tss}</text><text x="${x + bw / 2}" y="${144 - h}" text-anchor="middle" fill="#8b93a1" font-size="11">${w.hours}h</text>` : ''}
      ${i % 2 === n % 2 ? '' : `<text x="${x + bw / 2}" y="190" text-anchor="middle" fill="#8b93a1" font-size="11">${new Date(w.start + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>`}`;
  }).join('')}</svg>`;
}

function svgCurve(c90, cAll) {
  const W = 1000, H = 220, labels = ['5s', '15s', '30s', '1m', '3m', '5m', '10m', '20m', '60m'];
  const max = Math.max(100, ...Object.values(cAll)) * 1.1;
  const X = (i) => 40 + (i / (CURVE_DURS.length - 1)) * (W - 70);
  const Y = (w) => 185 - (w / max) * 170;
  const pts = (c) => CURVE_DURS.map((d, i) => (c[d] ? `${X(i)},${Y(c[d])}` : null)).filter(Boolean).join(' ');
  const dots = (c, col) => CURVE_DURS.map((d, i) => (c[d] ? `<circle cx="${X(i)}" cy="${Y(c[d])}" r="4" fill="${col}"/><text x="${X(i)}" y="${Y(c[d]) - 9}" text-anchor="middle" fill="${col}" font-size="12">${c[d]}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart">
    <polyline fill="none" stroke="#5b6472" stroke-width="2" stroke-dasharray="5 5" points="${pts(cAll)}"/>
    <polyline fill="none" stroke="#ff5a36" stroke-width="2.5" points="${pts(c90)}"/>${dots(c90, '#ff5a36')}
    ${labels.map((l, i) => `<text x="${X(i)}" y="210" text-anchor="middle" fill="#8b93a1" font-size="12">${l}</text>`).join('')}
    <text x="${W - 10}" y="14" text-anchor="end" font-size="12"><tspan fill="#ff5a36">&#9632; Last 90 days</tspan> <tspan fill="#8b93a1">- - All time</tspan></text></svg>`;
}

async function renderTraining() {
  const rows = await trainingRows();
  const real = rows.filter((r) => !r.demo).map((r) => r.summary);
  const series = loadSeries(real, new Date(), 90);
  const today = series.at(-1) || { ctl: 0, atl: 0, tsb: 0 };
  const wk = weekly(real, 12);
  const thisWeek = wk.at(-1);
  const est = ftpEstimate(real);
  const card = (v, l, sub = '') => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const cfg = ls.get('sync', {});
  const at = ls.get('remoteIndexAt');
  $('#sync-status').innerHTML = cfg.token
    ? `Synced with <b>${esc(cfg.repo || DEFAULT_REPO)}</b>${at ? `, last checked ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} <button class="ghost small" id="btn-syncnow">Sync now</button>`
    : 'History is only on this Mac. Add your GitHub token in <b>Settings</b> to sync it to rodillo-data so your coach can see it.';
  if ($('#btn-syncnow')) $('#btn-syncnow').onclick = () => syncPending();
  $('#training-cards').innerHTML = [
    card(Math.round(today.ctl), 'Fitness (CTL)'), card(Math.round(today.atl), 'Fatigue (ATL)'),
    card(`${today.tsb > 0 ? '+' : ''}${Math.round(today.tsb)}`, 'Form (TSB)', formLabel(today.tsb)),
    card(`${thisWeek.hours}h`, 'This week', `${thisWeek.tss} TSS &middot; ${thisWeek.rides} rides`),
    (() => {
      const days = Object.entries(app.whoop || {}).slice(-7).map(([, v]) => v).filter((v) => v.hrv);
      const t = whoopDay(dkey(new Date())) || Object.values(app.whoop || {}).at(-1);
      return t?.recovery != null ? card(`<span class="rz ${recZone(t.recovery)}">${t.recovery}%</span>`, 'Recovery (WHOOP)', days.length ? `HRV 7-day avg ${Math.round(days.reduce((a, v) => a + v.hrv, 0) / days.length)} ms` : '') : card('-', 'Recovery (WHOOP)', 'not connected');
    })(),
    card(`${app.settings.ftp} W`, 'FTP', [est.from20min && `20-min est ${est.from20min}`, est.fromRamp && `ramp ${est.fromRamp}`].filter(Boolean).join(' &middot; ') || 'no estimate yet'),
  ].join('');
  $('#chart-load').innerHTML = svgLoad(series);
  $('#chart-weekly').innerHTML = svgWeekly(wk);
  $('#chart-curve').innerHTML = real.length ? svgCurve(powerCurve(real, 90), powerCurve(real)) : '<p class="muted">No rides yet.</p>';
  $('#ride-table').innerHTML = rows.length ? `<table><tr><th>Date</th><th>Ride</th><th>Time</th><th>NP</th><th>IF</th><th>TSS</th><th>HR</th><th>Intervals</th><th>Drift</th><th></th></tr>
    ${rows.map((r) => {
      const x = r.summary;
      const comp = x.compliance ? `<span class="pct ${x.compliance.min < 95 ? 'low' : 'ok'}">${x.compliance.avg}%</span> <span class="muted">min ${x.compliance.min}%</span>` : '';
      const status = r.demo ? '<span class="tag">demo</span>' : r.interrupted ? '<span class="tag">interrupted</span>' : r.synced ? '' : '<span class="tag warn">not synced</span>';
      return `<tr><td>${new Date(x.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td>
      <td>${esc(x.name)} ${status}</td><td>${fmtTime(x.durSec)}</td><td>${x.np} W</td><td>${x.if}</td><td>${x.tss}</td><td>${x.avgHr ?? '-'}</td>
      <td>${comp}</td><td>${x.decoupling != null ? x.decoupling + '%' : ''}</td>
      <td class="nowrap">${r.local ? `<button class="ghost small" data-fit="${r.local.id}">.FIT</button> <button class="ghost small" data-del="${r.local.id}">Delete</button>` : ''}</td></tr>`;
    }).join('')}</table>` : '<p class="muted">No rides yet.</p>';
  $$('[data-fit]').forEach((b) => (b.onclick = async () => downloadFit(await rides.get(+b.dataset.fit))));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this ride from this Mac? (Synced copies stay in rodillo-data.)')) { await rides.del(+b.dataset.del); renderTraining(); } }));
}

// ------------------------------------------------------------------ imports
$('#import-workout').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    const text = await f.text();
    try {
      const w = f.name.endsWith('.json') ? JSON.parse(text) : parseZwo(text);
      w.id ||= 'import-' + Date.now();
      w.tags = [...new Set([...(w.tags || []), 'imported'])];
      flatten(w);
      const imported = ls.get('imported', []).filter((x) => x.id !== w.id);
      imported.push(w);
      ls.set('imported', imported);
      app.library.push(w);
    } catch (err) { alert(`Could not import ${f.name}: ${err.message}`); }
  }
  e.target.value = '';
  renderLibrary();
});

// ------------------------------------------------------------------ rides
function canRide() {
  if (app.trainer && (app.trainer.state === 'connected')) return true;
  return confirm('No trainer connected. Start anyway? (Use Demo mode to try without hardware.)');
}
function startWorkout(w, intensity = 1) { if (canRide()) beginSession({ workout: w, intensity }); }
function startFree() { if (canRide()) beginSession({}); }

let wakeLock = null;
function beginSession(opts) {
  const trainer = app.trainer || new SimTrainer();
  const { intensity = 1, ...sessionOpts } = opts;
  app.session = new Session({ trainer, hr: app.hr, settings: app.settings, ...sessionOpts });
  app.session.intensity = intensity;
  app.rideId = Date.now();
  const s = app.session;
  s.on('shift', (g) => { const t = $('.tile.gear'); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); app.controllers.forEach((c) => c.vibrate?.()); });
  s.on('lap', () => toast('Lap'));
  s.on('autostart', () => toast('Go!'));
  s.on('autopause', () => toast('Auto-paused'));
  s.on('autoresume', () => toast('Resumed'));
  s.on('workoutDone', () => toast('Workout complete. Free ride, or B twice to finish'));
  show('ride');
  $('#r-name').textContent = s.name;
  sizeChart(); sizePhoneChart();
  $('#rp-sheet').classList.add('hidden');
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
  renderRide();
}

async function endSession() {
  const s = app.session;
  if (!s) return;
  s.finish();
  wakeLock?.release?.().catch(() => {});
  if (s.samples.length < 10) { app.session = null; show('home'); return; }
  // remember what the app learned about this trainer (real rides only)
  if (!app.demo) {
    const simSamples = s.samples.filter((x) => x.grade !== 0).length;
    if (simSamples > 120) Object.assign(app.settings, s.learned());
    else app.settings.realDev = s.devEst.dev;
    ls.set('settings', app.settings);
  }
  const ride = await saveRide('done');
  showSummary(ride);
}

function rideDoc(ride) {
  return buildRide(ride.samples, ride.meta);
}

async function saveRide(status) {
  const s = app.session;
  const meta = {
    name: s.name, workoutId: s.workout?.id || null, tags: s.workout?.tags || (s.segs ? [] : ['free-slope']),
    ftp: app.settings.ftp, startMs: s.startMs || app.rideId, segs: s.segs, source: app.demo ? 'demo' : 'rodillo',
  };
  const doc = buildRide(s.samples, meta);
  const ride = {
    id: app.rideId, name: s.name, status, demo: app.demo, synced: false,
    samples: s.samples, laps: s.laps, meta, summary: doc.summary, intervals: doc.intervals,
  };
  try { await rides.put(ride); } catch (e) { logMsg('app', `save failed: ${e.message}`); }
  return ride;
}

// ------------------------------------------------------------------ GitHub sync
function syncClient() {
  const cfg = ls.get('sync', {});
  return cfg.token ? new GitHubSync({ token: cfg.token, repo: cfg.repo || DEFAULT_REPO }) : null;
}

async function syncRide(ride) {
  const gh = syncClient();
  const el = $('#s-sync');
  const say = (t) => { if (el && app.screen === 'summary') el.textContent = t; };
  if (ride.demo) { say('Demo ride: kept on this Mac only, not added to your training history.'); return false; }
  if (!gh) { say('Not synced: add your GitHub token in Settings to send rides to rodillo-data.'); return false; }
  try {
    say('Syncing to rodillo-data...');
    const doc = { ...rideDoc(ride), laps: ride.laps };
    const index = await gh.pushRide(doc);
    ride.synced = true;
    await rides.put(ride);
    ls.set('remoteIndex', index.rides);
    say('Synced to rodillo-data. Your coach can see it.');
    return true;
  } catch (e) {
    logMsg('sync', e.message);
    say(`Sync failed, will retry next launch: ${e.message}`);
    return false;
  }
}

async function syncPending() {
  if (!syncClient()) return;
  let all = [];
  try { all = await rides.list(); } catch { return; }
  for (const meta of all) {
    if (meta.status !== 'done' || meta.synced || meta.demo || !meta.meta) continue;
    const ride = await rides.get(meta.id);
    if (await syncRide(ride)) logMsg('sync', `synced ${ride.summary.id}`);
  }
  await refreshRemoteIndex();
}

async function refreshRemoteIndex() {
  const gh = syncClient();
  if (!gh) return;
  try { ls.set('remoteIndex', await gh.fetchIndex()); ls.set('remoteIndexAt', Date.now()); }
  catch (e) { logMsg('sync', `index fetch failed: ${e.message}`); }
  if (app.tab === 'training') renderTraining();
  refreshPlanViews();
}

function downloadFit(ride) {
  if (!ride?.samples?.length) return alert('No data in this ride.');
  const bytes = encodeActivity(ride.samples, ride.laps, { tss: ride.summary?.tss });
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  const d = new Date(ride.id);
  a.href = URL.createObjectURL(blob);
  a.download = `rodillo-${d.toLocaleDateString('en-CA')}-${ride.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.fit`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function showSummary(ride) {
  const st = ride.summary;
  $('#s-name').textContent = ride.name;
  $('#s-date').textContent = new Date(ride.id).toLocaleString();
  const stat = (v, l) => `<div class="stat"><div class="v">${v ?? '-'}</div><div class="l">${l}</div></div>`;
  $('#s-stats').innerHTML = [
    stat(fmtTime(st.durSec), 'Ride time'), stat(`${st.distKm.toFixed(1)} km`, 'Distance'),
    stat(`${st.avgP} W`, 'Avg power'), stat(`${st.np} W`, 'Normalized'),
    stat(st.avgHr ?? '-', 'Avg HR'), stat(st.maxHr ?? '-', 'Max HR'),
    stat(st.tss, 'TSS'), stat(st.if, 'Intensity'),
  ].join('');
  let extra = '';
  if (st.tags?.includes('test') && st.bests?.[60]) {
    const ftp = Math.round(st.bests[60] * 0.75);
    extra += `<div class="callout"><div>Best 1-min power <b>${st.bests[60]} W</b> &rarr; estimated FTP <b>${ftp} W</b> (currently ${app.settings.ftp} W)</div><button class="primary small" id="s-setftp">Set FTP to ${ftp}</button></div>`;
  }
  const work = (ride.intervals || []).filter((x) => x.work);
  if (work.length) {
    extra += `<h4>Work intervals</h4><table class="ints"><tr><th>Interval</th><th>Target</th><th>Actual</th><th></th><th>HR</th><th>Cadence</th></tr>
      ${work.map((x) => `<tr><td>${esc(x.label)}${x.rep ? ' ' + x.rep : ''}</td><td>${x.target ? x.target + ' W' : (x.grade ?? '') + (x.grade != null ? '%' : '')}</td><td>${x.avgP} W</td>
      <td>${x.pct ? `<span class="pct ${x.pct < 95 ? 'low' : x.pct > 105 ? 'high' : 'ok'}">${x.pct}%</span>` : ''}</td><td>${x.avgHr ?? '-'}</td><td>${x.avgCad}${x.cadTarget ? ` <span class="muted">(${x.cadTarget}, ${x.cadInRange ?? '-'}% in range)</span>` : ''}</td></tr>`).join('')}</table>`;
  }
  if (st.decoupling != null) extra += `<p class="muted">Aerobic decoupling (Pw:HR): <b style="color:var(--text)">${st.decoupling}%</b> ${st.decoupling < 5 ? '(steady: aerobic base is handling this power)' : '(HR drifted: this power is at the edge of your Z2)'}</p>`;
  $('#s-extra').innerHTML = extra;
  if ($('#s-setftp')) $('#s-setftp').onclick = (e) => { app.settings.ftp = Math.round(st.bests[60] * 0.75); ls.set('settings', app.settings); e.target.textContent = 'Saved'; };
  $('#s-sync').textContent = ride.demo ? 'Demo ride: saving keeps it on this Mac only.' : syncClient() ? 'Saving adds it to your training history in rodillo-data.' : 'Saving keeps it on this Mac. Add your GitHub token in Settings to sync it.';
  $('#s-fit').onclick = () => downloadFit(ride);
  $('#s-home').onclick = async () => {
    app.session = null;
    show('home');
    if (!ride.demo && syncClient()) {
      toast('Syncing ride...');
      toast((await syncRide(ride)) ? 'Ride synced' : 'Sync failed, will retry next launch');
    } else toast('Ride saved');
    if (app.tab === 'training') renderTraining();
    refreshPlanViews();
  };
  $('#s-discard').onclick = async () => {
    if (!confirm('Discard this ride? It will not be saved or synced.')) return;
    try { await rides.del(ride.id); } catch { /* ignore */ }
    app.session = null;
    show('home');
    toast('Ride discarded');
    if (app.tab === 'training') renderTraining();
  };
  show('summary');
}

// ------------------------------------------------------------------ actions (controller + keyboard)
function action(a) {
  const s = app.session;
  if (app.screen === 'ride' && s) {
    switch (a) {
      case 'easier': if (s.mode === 'erg') return action('down'); s.shift(-1); break;
      case 'harder': if (s.mode === 'erg') return action('up'); s.shift(+1); break;
      case 'front': if (s.gb.isDouble) s.toggleFront(); else toast('1x: no front shifting'); break;
      case 'up': s.bump(+1); toast(s.mode === 'erg' ? `Intensity ${Math.round(s.intensity * 100)}%` : `Grade ${fmtGradeSet(s)}`); break;
      case 'down': s.bump(-1); toast(s.mode === 'erg' ? `Intensity ${Math.round(s.intensity * 100)}%` : `Grade ${fmtGradeSet(s)}`); break;
      case 'select': s.togglePause(); break;
      case 'back': {
        const now = Date.now();
        if (now - app.endArmed < 3000) { app.endArmed = 0; endSession(); }
        else { app.endArmed = now; toast('Press B again to end ride'); }
        break;
      }
      case 'skip': if (s.segs) { s.skip(); toast('Skipped'); } break;
      case 'lap': s.lap(); break;
      case 'ergToggle': if (s.segs) { s.toggleErg(); toast(s.ergOff ? 'ERG off: slope mode' : 'ERG on'); } break;
    }
    renderRide();
    return;
  }
  if (app.screen === 'summary') { if (a === 'select') $('#s-home').click(); return; }
  // home navigation
  const items = focusables();
  switch (a) {
    case 'up': case 'easier': app.focus = Math.max(0, app.focus - 1); applyFocus(); break;
    case 'down': case 'harder': app.focus = Math.min(items.length - 1, app.focus + 1); applyFocus(); break;
    case 'left': case 'right': {
      const tabs = ['workouts', 'free', 'calendar', 'training'];
      const i = (tabs.indexOf(app.tab) + (a === 'right' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[i]);
      break;
    }
    case 'select': {
      const el = items[app.focus];
      if (!el) break;
      if (el.classList.contains('day')) el.querySelector('[data-startday]')?.click();
      else if (el.dataset.i !== undefined) startWorkout(app.library[+el.dataset.i]);
      else el.click();
      break;
    }
    case 'back': $$('.panel').forEach((p) => p.classList.add('hidden')); break;
  }
}
const fmtGradeSet = (s) => `${(s.gradeOffset * 100).toFixed(0)}%`;

const BUTTON_ACTIONS = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  a: 'select', b: 'back', y: 'skip', z: 'lap', powerUpL: 'ergToggle',
};
const SHIFT_BUTTONS = new Set(['shiftUpL', 'shiftDnL', 'paddleL', 'shiftUpR', 'shiftDnR', 'paddleR']);
const isLeft = (b) => b.endsWith('L');

/**
 * Shifting styles on the Zwift Ride:
 *  SRAM:    right side (both buttons + paddle) = harder, left side = easier,
 *           left + right together = front shift (2x only).
 *  Shimano: right shift-up = harder, right shift-down = easier (rear);
 *           left shift-up = big ring, left shift-down = small ring (2x);
 *           paddles: right harder / left easier. On 1x the left buttons also shift the rear.
 */
function shiftFor(b) {
  const s = app.session;
  const style = app.settings.shiftStyle || 'sram';
  const double = s?.gb.isDouble;
  if (style === 'shimano') {
    if (b === 'shiftUpR' || b === 'paddleR') return ['rear', +1];
    if (b === 'shiftDnR' || b === 'paddleL') return ['rear', -1];
    if (b === 'shiftUpL') return double ? ['front', +1] : ['rear', +1];
    if (b === 'shiftDnL') return double ? ['front', -1] : ['rear', -1];
  }
  return ['rear', isLeft(b) ? -1 : +1];
}

let pendingShift = null; // SRAM: wait briefly to see if the other side joins (front shift)
function onShiftButton(b) {
  const s = app.session;
  if (app.screen !== 'ride' || !s) return action(isLeft(b) ? 'easier' : 'harder'); // menus
  if (s.mode === 'erg') { // ERG: left side -1%, right side +1% of target watts (hold to repeat)
    const a = isLeft(b) ? 'down' : 'up';
    action(a);
    clearTimeout(holdTimers[b]);
    const rep = () => { action(a); holdTimers[b] = setTimeout(rep, 120); };
    holdTimers[b] = setTimeout(rep, 450);
    return;
  }
  const sramFront = (app.settings.shiftStyle || 'sram') === 'sram' && s.gb.isDouble;
  if (!sramFront) { const [kind, dir] = shiftFor(b); doShift(kind, dir); return; }
  if (pendingShift && isLeft(pendingShift.b) !== isLeft(b)) {
    clearTimeout(pendingShift.t); pendingShift = null;
    doShift('toggle', 0);
    return;
  }
  clearTimeout(pendingShift?.t);
  pendingShift = { b, t: setTimeout(() => { pendingShift = null; doShift('rear', isLeft(b) ? -1 : +1); }, 140) };
}
function doShift(kind, dir) {
  const s = app.session;
  if (!s) return;
  if (kind === 'rear') s.shift(dir);
  else if (kind === 'front') s.shiftFront(dir);
  else s.toggleFront();
  renderRide();
}

const REPEATABLE = new Set(['up', 'down']);
const holdTimers = {};
const lastPress = {};
function onButton(b, dev) {
  // with both hoods connected, a button may arrive from both devices: keep the first
  const now = performance.now();
  if (now - (lastPress[b] || 0) < 90) return;
  lastPress[b] = now;
  if (SHIFT_BUTTONS.has(b)) { logMsg('controller', `${dev?.side || ''} ${b}`); return onShiftButton(b); }
  const a = BUTTON_ACTIONS[b];
  logMsg('controller', `${dev?.side || ''} ${b}${a ? ' -> ' + a : ''}`);
  if (!a) return;
  action(a);
  if (REPEATABLE.has(a) && app.screen === 'ride') {
    clearTimeout(holdTimers[b]);
    const rep = () => { action(a); holdTimers[b] = setTimeout(rep, 120); };
    holdTimers[b] = setTimeout(rep, 450);
  }
}
function onRelease(b) { clearTimeout(holdTimers[b]); delete holdTimers[b]; }

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const map = { ArrowLeft: app.screen === 'ride' ? 'easier' : 'left', ArrowRight: app.screen === 'ride' ? 'harder' : 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'select', Enter: 'select', Escape: 'back', s: 'skip', l: 'lap', e: 'ergToggle', '[': 'easier', ']': 'harder', f: 'front' };
  if (app.demo && app.trainer && (e.key === '+' || e.key === '=' || e.key === '-')) {
    app.trainer.riderPower = Math.max(0, app.trainer.riderPower + (e.key === '-' ? -20 : 20));
    toast(`Demo rider: ${app.trainer.riderPower} W`);
    return;
  }
  const a = map[e.key];
  if (a) { e.preventDefault(); action(a); }
});

function focusables() {
  const list = [];
  if (app.tab === 'workouts') {
    const t = $('#week .day.today [data-startday]');
    if (t) list.push(t.closest('.day'));
    list.push(...$$('#workout-list .wo'));
  } else if (app.tab === 'free') {
    list.push($('#btn-free'), ...$$('#slope-list .wo'));
  }
  return list;
}
function applyFocus() {
  const items = focusables();
  $$('.focus').forEach((x) => x.classList.remove('focus'));
  const el = items[Math.min(app.focus, items.length - 1)];
  if (el && app.screen === 'home' && app.usedNav) { el.classList.add('focus'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
document.addEventListener('keydown', () => { app.usedNav = true; }, true);

// ------------------------------------------------------------------ ride rendering
function show(name) {
  app.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
  if (name === 'home') { renderDevices(); applyFocus(); }
}

function renderRideStatus() {
  const el = $('#r-status');
  if (!el) return;
  const pill = (label, ok) => `<span class="pill ${ok ? '' : 'off'}">${label}</span>`;
  const t = app.trainer?.state === 'connected', h = app.hr?.state === 'connected';
  const c = app.controllers.some((x) => x.state === 'connected');
  el.innerHTML = pill(app.demo ? 'Demo' : 'Trainer', t || app.demo) + pill('HR', h || app.demo) + pill('Controller', c) +
    (app.session ? `<span class="pill">${app.session.mode === 'erg' ? 'ERG' : 'SLOPE'}</span>` : '') +
    (app.session?.maxed ? '<span class="pill off">Max resistance</span>' : '');
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
const segAmount = (g) => (g.dist ? fmtDist(g.dist) : fmtTime(g.dur));

function renderSegList(s) {
  const body = $('#r-body');
  body.classList.toggle('with-segs', !!s.segs);
  if (!s.segs) return;
  const ftp = app.settings.ftp, cur = s.segIndex < 0 ? s.segs.length : s.segIndex;
  const doneN = Math.min(cur, s.segs.length);
  const rows = s.segs.map((g, i) => {
    const state = i < cur ? 'done' : i === cur ? 'current' : 'todo';
    const color = g.kind === 'erg' ? zoneHex((g.from + g.to) / 2) : gradeHex(g.grade);
    const tgtW = g.kind === 'erg' ? (g.from === g.to ? `${Math.round(g.from * ftp * s.intensity)} W` : `${Math.round(g.from * ftp * s.intensity)}-${Math.round(g.to * ftp * s.intensity)} W`) : `${((g.grade + s.gradeOffset) * 100).toFixed(0)}%`;
    const name = `${esc(g.label)}${g.rep ? ` <span class="muted">${g.rep.i}/${g.rep.of}</span>` : ''}`;
    const a = s.segAgg[i];
    const avgP = a?.n ? Math.round(a.p / a.n) : null, avgHr = a?.hrN ? Math.round(a.hr / a.hrN) : null;
    const cadChip = g.cad ? `<span class="cad-chip">${g.cad.label}</span>` : '';
    if (g.kind === 'erg') {
      const bar = state === 'current' ? `<div class="bar" style="width:${Math.min(100, s.segProgress * 100).toFixed(1)}%"></div>` : '';
      const time = state === 'current' ? fmtTime(s.segRemaining.sec ?? 0) : segAmount(g);
      return `<div class="seg erg ${state}" style="--c:${color}" data-i="${i}"><div class="seg-name">${state === 'done' ? '<span class="check">&#10003;</span>' : ''}<span class="big">${tgtW}</span>${cadChip}</div><div class="seg-r"><span class="big">${time}</span></div>${bar}</div>`;
    }
    let right;
    if (state === 'todo') right = `<span class="big">${segAmount(g)}</span>`;
    else if (!avgP) right = state === 'done' ? '<span class="muted">skipped</span>' : `<span class="big">${segAmount(g)}</span>`;
    else {
      const pct = g.kind === 'erg' && !s.ergOff ? ` <span class="pct ${avgP / ((g.from + g.to) / 2 * ftp * s.intensity) < 0.95 ? 'low' : 'ok'}">${Math.round((avgP / ((g.from + g.to) / 2 * ftp * s.intensity)) * 100)}%</span>` : '';
      right = `<span class="big">${avgP} W</span>${pct}<br><span class="muted">${avgHr ? `&hearts; ${avgHr}` : ''}${state === 'current' ? ` &middot; ${s.segRemaining.sec !== undefined ? fmtTime(s.segRemaining.sec) : fmtDist(s.segRemaining.m)} left` : ''}</span>`;
    }
    const bar = state === 'current' ? `<div class="bar" style="width:${Math.min(100, s.segProgress * 100).toFixed(1)}%"></div>` : '';
    return `<div class="seg ${state}" style="--c:${color}" data-i="${i}"><div><div class="seg-name">${state === 'done' ? '<span class="check">&#10003;</span>' : ''}${name}</div><div class="seg-tgt">${tgtW} &middot; ${segAmount(g)} ${cadChip}</div></div><div class="seg-r">${right}</div>${bar}</div>`;
  });
  const el = $('#r-segs');
  el.innerHTML = `<div class="seg-head"><span>Segments</span><span>${doneN}/${s.segs.length} done</span></div>` + rows.join('');
  if (app._segI !== cur) {
    app._segI = cur;
    el.querySelector('.seg.current')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function gearViz(gb) {
  if (gb.seq) return `gear ${gb.rear + 1}/${gb.nRear} &middot; ratio ${gb.ratio.toFixed(2)}`;
  const cogs = gb.cogsEasyFirst, max = cogs[0];
  const bars = cogs.map((c, i) => `<rect x="${i * 9}" y="${22 - (c / max) * 20}" width="6" height="${(c / max) * 20}" rx="1.5" fill="${i === gb.rear ? '#ff5a36' : '#3a414c'}"/>`).join('');
  const rings = gb.d.rings.map((r, i) => `<circle cx="${cogs.length * 9 + 10 + i * 14}" cy="12" r="${3 + (r / gb.d.rings.at(-1)) * 6}" fill="none" stroke="${i === gb.front ? '#ff5a36' : '#3a414c'}" stroke-width="2.5"/>`).join('');
  return `<svg class="gearviz" viewBox="0 0 ${cogs.length * 9 + 14 + gb.d.rings.length * 14} 24">${bars}${rings}</svg><span>ratio ${gb.ratio.toFixed(2)}</span>`;
}

function renderPaused(s) {
  $('#r-paused').classList.toggle('hidden', !s.paused);
  if (s.paused) {
    $('#r-paused-title').textContent = !s.started ? 'Ready' : 'Paused';
    $('#r-paused-sub').textContent = !s.started ? 'Start pedaling to begin' : s.autoPaused ? 'Start pedaling to resume' : isPhone() ? 'Tap Resume or press A' : 'Press A or Space to resume';
  }
}

function renderRide() {
  const s = app.session;
  if (!s || app.screen !== 'ride') return;
  if (isPhone()) { renderPhone(s); renderPaused(s); return; }
  const td = s.trainer.data || {};
  const hr = Math.round(app.hr?.bpm || td.hr || 0);
  $('#r-elapsed').textContent = fmtTime(s.elapsed);
  const p = Math.round(s.power3s);
  $('#r-power').textContent = p;
  const pt = $('.tile.power');
  pt.classList.remove('low', 'high', 'ok');
  if (s.target) {
    $('#r-target').innerHTML = `target <b style="color:var(--text)">${s.target}</b> W`;
    const r = p / s.target;
    pt.classList.add(r < 0.95 ? 'low' : r > 1.05 ? 'high' : 'ok');
  } else {
    $('#r-target').textContent = `${(p / app.settings.riderKg).toFixed(1)} W/kg`;
  }
  const pctEl = $('#r-pct');
  pctEl.classList.toggle('hidden', s.mode !== 'erg');
  pctEl.textContent = `${Math.round(s.intensity * 100)}%`;
  pctEl.className = `t-pct ${s.mode !== 'erg' ? 'hidden' : s.intensity > 1.001 ? 'up' : s.intensity < 0.999 ? 'down' : ''}`;
  $('#r-hr').textContent = hr || '--';
  const hrs = s.samples.filter((x) => x.hr).slice(-600);
  $('#r-hrzone').textContent = hrs.length ? `avg ${Math.round(hrs.reduce((a, x) => a + x.hr, 0) / hrs.length)} (10 min)` : '';
  $('#r-cad').textContent = Math.round(td.cadence || 0);
  const cs = s.cadStatus, ct = $('.tile.cad');
  ct.classList.toggle('ok', cs === 'ok');
  ct.classList.toggle('bad', cs === 'low' || cs === 'high');
  $('#r-cadtarget').innerHTML = !s.seg?.cad ? '' : cs === 'low' ? '<b>&#9650; Pedal faster</b>' : cs === 'high' ? '<b>&#9660; Pedal slower</b>' : `target ${s.seg.cad.label}`;
  const gearTile = $('.tile.gear');
  gearTile.classList.toggle('dim', s.mode === 'erg');
  $('#r-gear').textContent = s.gb.seq ? s.gb.label : s.gb.label.replace('x', '\u00d7');
  $('#r-gear').classList.toggle('combo', !s.gb.seq);
  $('#r-ratio').innerHTML = s.mode === 'erg' ? 'ERG: gears not used' : gearViz(s.gb);
  $('#r-grade').innerHTML = `${(s.mode === 'sim' ? s.grade * 100 : 0).toFixed(1)}<span class="unit">%</span>`;
  $('#r-gradesub').textContent = s.mode !== 'sim' ? '' : !s.seg ? 'up/down to change' : s.gradeOffset ? `profile ${s.gradeOffset > 0 ? '+' : ''}${(s.gradeOffset * 100).toFixed(0)}%` : '';
  $('#r-speed').textContent = (s.bike.v * 3.6).toFixed(1);
  $('#r-dist').textContent = `${(s.bike.dist / 1000).toFixed(2)} km`;

  // interval card
  $('.tiles').classList.toggle('erg', s.mode === 'erg');
  const seg = s.seg;
  const card = $('#r-interval');
  if (seg) {
    const rem = s.segRemaining;
    const tgt = seg.kind === 'erg' ? segTarget(seg, s.segProgress) : null;
    card.style.borderLeftColor = seg.kind === 'erg' ? zoneHex(tgt) : gradeHex(seg.grade);
    $('#r-int-label').textContent = `${seg.label}${seg.rep ? ` ${seg.rep.i}/${seg.rep.of}` : ''}${s.ergOff && seg.kind === 'erg' ? ' (ERG off)' : ''}`;
    $('#r-int-text').textContent = seg.text || (seg.kind === 'erg' ? `${Math.round(tgt * 100)}% FTP` : `${((seg.grade + s.gradeOffset) * 100).toFixed(0)}% grade, use your gears`);
    $('#r-int-left').textContent = rem.sec !== undefined ? fmtTime(rem.sec) : fmtDist(rem.m);
    const next = s.segs[s.segIndex + 1];
    $('#r-int-next').innerHTML = next ? `Next<br><b style="color:var(--text)">${segAmount(next)} ${next.kind === 'erg' ? `@ ${Math.round(next.from * app.settings.ftp * s.intensity)} W` : `@ ${((next.grade + s.gradeOffset) * 100).toFixed(0)}%`}</b>` : 'Last interval';
  } else {
    card.style.borderLeftColor = '#3d8bfd';
    $('#r-int-label').textContent = s.segs ? 'Workout complete' : `Free slope: ${fmtGradeSet(s)}`;
    $('#r-int-text').textContent = s.segs ? 'Keep riding or press B twice to finish' : 'Up/down changes the grade by 1%. Shift to hold your cadence.';
    $('#r-int-left').textContent = '';
    $('#r-int-next').textContent = '';
  }
  renderSegList(s);

  renderPaused(s);
  $('#r-pause').textContent = !s.started ? 'Start' : s.paused ? 'Resume' : 'Pause';
  $('#r-hints').innerHTML = s.mode === 'erg'
    ? '<b>Shifters</b> or <b>Up/Down</b> effort &plusmn;1% &middot; <b>Y</b> skip &middot; <b>Z</b> lap &middot; <b>Left power-up</b> ERG off &middot; <b>A</b> pause &middot; <b>B&times;2</b> end'
    : '<b>Shifters</b> gears &middot; <b>Up/Down</b> grade &plusmn;1% &middot; <b>Z</b> lap &middot; <b>A</b> pause &middot; <b>B&times;2</b> end' + (app.demo ? ' &middot; demo: <b>+/-</b> rider power' : '');
  renderRideStatus();
  drawChart();
}

// ------------------------------------------------------------------ chart
const canvas = $('#r-chart');
function sizeChart() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, r.width * devicePixelRatio);
  canvas.height = Math.max(100, r.height * devicePixelRatio);
}
new ResizeObserver(() => { if (app.screen === 'ride') { sizeChart(); drawChart(); } }).observe(canvas);

function drawChart() {
  const s = app.session;
  if (!s) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, dpr = devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const pad = 10 * dpr;
  const plotH = H - pad * 2;
  ctx.font = `${11 * dpr}px -apple-system, sans-serif`;

  const ftp = app.settings.ftp;
  const maxP = Math.max(ftp * 1.6, ...s.samples.slice(-1200).map((x) => x.power + 20));
  const Yp = (p) => H - pad - (Math.min(p, maxP) / maxP) * plotH;

  if (s.segs) {
    const T = Math.max(s.segs[s.segs.length - 1].end, s.chartPos + 1);
    const X = (t) => (t / T) * W;
    for (const g of s.segs) {
      if (g.kind === 'erg') {
        ctx.fillStyle = zoneHex((g.from + g.to) / 2) + '55';
        ctx.beginPath(); ctx.moveTo(X(g.start), H - pad);
        ctx.lineTo(X(g.start), Yp(g.from * ftp * s.intensity)); ctx.lineTo(X(g.end), Yp(g.to * ftp * s.intensity));
        ctx.lineTo(X(g.end), H - pad); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = gradeHex(g.grade) + '55';
        const h = Math.max(6 * dpr, ((g.grade + 0.03) / 0.15) * plotH * 0.6);
        ctx.fillRect(X(g.start), H - pad - h, X(g.end) - X(g.start), h);
      }
    }
    // FTP line
    ctx.strokeStyle = '#ffffff22'; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#8b93a1'; ctx.fillText(`FTP ${ftp}`, 6 * dpr, Yp(ftp) - 4 * dpr);
    // power trace
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6 * dpr; ctx.beginPath();
    s.samples.forEach((x, i) => { const px = X(x.wx ?? x.wt), py = Yp(x.power); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    ctx.fillStyle = '#ff5a36'; ctx.fillRect(X(s.chartPos) - dpr, 0, 2 * dpr, H);
    return;
  }

  // free ride: last 10 minutes of power with grade underlay
  const win = 600, data = s.samples.slice(-win);
  const X = (i) => (i / win) * W;
  ctx.fillStyle = '#26303d';
  data.forEach((x, i) => { const g = (x.grade || 0) / 100; const h = Math.max(0, ((g + 0.03) / 0.15) * plotH * 0.6); ctx.fillRect(X(i), H - pad - h, W / win + 1, h); });
  ctx.strokeStyle = '#ffffff22'; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6 * dpr; ctx.beginPath();
  data.forEach((x, i) => { i ? ctx.lineTo(X(i), Yp(x.power)) : ctx.moveTo(X(i), Yp(x.power)); });
  ctx.stroke();
  ctx.fillStyle = '#8b93a1'; ctx.fillText('last 10 min', 6 * dpr, 16 * dpr);
}


// ------------------------------------------------------------------ phone ride screen (Zwift Companion style)
// Keep this query identical to the phone @media rule in css/app.css.
const PHONE_MQ = matchMedia('(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 520px)');
function isPhone() { return PHONE_MQ.matches; }
const rpCanvas = $('#rp-chart');
function sizePhoneChart() {
  const r = rpCanvas.parentElement.getBoundingClientRect();
  rpCanvas.width = Math.max(200, Math.round(r.width * devicePixelRatio));
  rpCanvas.height = Math.max(60, Math.round(r.height * devicePixelRatio));
}
new ResizeObserver(() => { if (app.screen === 'ride' && isPhone()) { sizePhoneChart(); drawPhoneChart(); } }).observe(rpCanvas.parentElement);
PHONE_MQ.addEventListener('change', () => { if (app.screen === 'ride') { sizeChart(); sizePhoneChart(); renderRide(); } });

const segColor = (g, s, t = 0.5) => (g.kind === 'erg' ? zoneHex(segTarget(g, t)) : gradeHex(g.grade + (s?.gradeOffset || 0)));
const segTargetText = (g, s) => (g.kind === 'erg'
  ? (g.from === g.to ? `${Math.round(g.from * app.settings.ftp * s.intensity)} W` : `${Math.round(g.from * app.settings.ftp * s.intensity)}-${Math.round(g.to * app.settings.ftp * s.intensity)} W`)
  : `${((g.grade + s.gradeOffset) * 100).toFixed(0)}%`);

function renderPhone(s) {
  const td = s.trainer.data || {};
  const ftp = app.settings.ftp;
  const hr = Math.round(app.hr?.bpm || td.hr || 0);
  const p = Math.round(s.power3s);
  const seg = s.seg;
  const set = (id, v) => { const el = document.getElementById(id); if (el.innerHTML !== String(v)) el.innerHTML = v; };

  set('rp-elapsed', fmtTime(s.elapsed));
  set('rp-name', esc(s.name));
  if (s.segs) {
    const last = s.segs.at(-1), est = s.segs.some((g) => g.estDur && s.segs.indexOf(g) >= Math.max(0, s.segIndex));
    set('rp-left-k', 'Left');
    set('rp-left', seg ? `${est ? '~' : ''}${fmtTime(last.end - s.chartPos)}` : '0:00');
  } else {
    set('rp-left-k', 'Distance');
    set('rp-left', fmtDist(s.bike.dist));
  }

  // hero: interval countdown + target
  const hero = $('#rp');
  let zc;
  if (seg) {
    const rem = s.segRemaining;
    const tgt = seg.kind === 'erg' ? segTarget(seg, s.segProgress) : null;
    zc = seg.kind === 'erg' ? zoneHex(tgt) : gradeHex(seg.grade + s.gradeOffset);
    set('rp-int-label', `${esc(seg.label)}${seg.rep ? ` ${seg.rep.i}/${seg.rep.of}` : ''}${s.ergOff && seg.kind === 'erg' ? ' &middot; ERG off' : ''}`);
    set('rp-count', rem.sec !== undefined ? fmtTime(rem.sec) : fmtDist(rem.m));
    const cad = seg.cad ? ` &middot; ${seg.cad.label}` : '';
    if (seg.kind === 'erg') {
      set('rp-target', `${s.target || Math.round(tgt * ftp * s.intensity)} W`);
      set('rp-target-sub', `${Math.round(tgt * 100 * s.intensity)}% FTP${cad}`);
    } else {
      set('rp-target', `${((seg.grade + s.gradeOffset) * 100).toFixed(0)}%`);
      set('rp-target-sub', `grade, use your gears${cad}`);
    }
  } else if (s.segs) {
    zc = '#3ccf7a';
    set('rp-int-label', 'Workout complete');
    set('rp-count', 'Done');
    set('rp-target', '');
    set('rp-target-sub', 'Keep riding, or End ride from &middot;&middot;&middot;');
  } else {
    zc = gradeHex(s.grade);
    set('rp-int-label', 'Free slope');
    set('rp-count', `${(s.grade * 100).toFixed(1)}%`);
    set('rp-target', '');
    set('rp-target-sub', `set ${fmtGradeSet(s)} &middot; D-pad or &middot;&middot;&middot; to change`);
  }
  hero.style.setProperty('--zc', zc);

  // power + on-target gauge (centre = target, ends = ±20%)
  set('rp-power', p);
  const gauge = $('#rp-gauge');
  gauge.classList.toggle('off', !s.target);
  if (s.target) gauge.querySelector('b').style.left = `${Math.max(0, Math.min(1, (p / s.target - 0.8) / 0.4)) * 100}%`;

  set('rp-hr', hr || '--');
  set('rp-cad', Math.round(td.cadence || 0));
  const cs = s.cadStatus, cb = $('#rp-cad-box');
  cb.classList.toggle('ok', cs === 'ok');
  cb.classList.toggle('bad', cs === 'low' || cs === 'high');
  set('rp-cad-sub', !seg?.cad ? '' : cs === 'low' ? '&#9650; faster' : cs === 'high' ? '&#9660; slower' : seg.cad.label);

  const m3 = $('#rp-m3').parentElement;
  if (s.mode === 'erg') {
    set('rp-m3-k', 'Effort');
    set('rp-m3', `${Math.round(s.intensity * 100)}%`);
    set('rp-m3-sub', s.intensity > 1.001 ? 'harder than plan' : s.intensity < 0.999 ? 'easier than plan' : 'as planned');
    m3.classList.toggle('up', s.intensity > 1.001);
    m3.classList.toggle('down', s.intensity < 0.999);
  } else {
    set('rp-m3-k', 'Gear');
    set('rp-m3', s.gb.seq ? s.gb.label : s.gb.label.replace('x', '×'));
    set('rp-m3-sub', `${(s.bike.v * 3.6).toFixed(1)} km/h`);
    m3.classList.remove('up', 'down');
  }

  const next = s.segs && s.segIndex >= 0 ? s.segs[s.segIndex + 1] : null;
  set('rp-next', next
    ? `Next <span class="sw" style="background:${segColor(next, s)}"></span><b>${segAmount(next)} @ ${segTargetText(next, s)}</b>${next.cad ? ` &middot; ${next.cad.label}` : ''}`
    : seg ? 'Last interval' : `${(s.bike.v * 3.6).toFixed(1)} km/h &middot; ${fmtDist(s.bike.dist)}`);

  // buttons
  const erg = s.mode === 'erg';
  set('rp-minus', erg ? '&minus;1%' : 'Gear &minus;');
  set('rp-plus', erg ? '+1%' : 'Gear +');
  set('rp-pause', !s.started ? 'Start' : s.paused ? 'Resume' : 'Pause');
  $('#rp-grade-row').classList.toggle('hidden', erg);
  $('#rp-skip').classList.toggle('hidden', !seg);
  $('#rp-erg').classList.toggle('hidden', !seg || (seg.kind !== 'erg' && !s.ergOff));
  set('rp-erg', s.ergOff ? 'ERG back on' : 'ERG off for this interval');
  if (app.endArmed && Date.now() - app.endArmed > 3000) app.endArmed = 0;
  set('rp-end', app.endArmed ? 'Tap again to end ride' : 'End ride');

  drawPhoneChart();
}

/** Workout bars like Zwift: solid zone-coloured blocks, done part dimmed under the power trace. */
function drawPhoneChart() {
  const s = app.session;
  if (!s || !isPhone()) return;
  const ctx = rpCanvas.getContext('2d');
  const W = rpCanvas.width, H = rpCanvas.height, dpr = devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const top = 14 * dpr, bot = H - 2 * dpr, plotH = bot - top;
  const ftp = app.settings.ftp;
  ctx.font = `600 ${10.5 * dpr}px -apple-system, sans-serif`;

  if (!s.segs) {
    // free slope: last 10 minutes of power over the grade
    const win = 600, data = s.samples.slice(-win);
    const maxP = Math.max(ftp * 1.5, ...data.map((x) => x.power + 20));
    const Y = (v) => bot - (Math.min(v, maxP) / maxP) * plotH;
    data.forEach((x, i) => {
      const g = (x.grade || 0) / 100, h = Math.max(2 * dpr, ((g + 0.03) / 0.15) * plotH * 0.7);
      ctx.fillStyle = gradeHex(g) + '88'; ctx.fillRect((i / win) * W, bot - h, W / win + 1, h);
    });
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
    data.forEach((x, i) => { const px = (i / win) * W; i ? ctx.lineTo(px, Y(x.power)) : ctx.moveTo(px, Y(x.power)); });
    ctx.stroke();
    ctx.fillStyle = '#8b93a1'; ctx.fillText('LAST 10 MIN', 2 * dpr, 10 * dpr);
    return;
  }

  const segs = s.segs, pos = s.chartPos;
  const T = Math.max(segs.at(-1).end, pos + 1);
  const X = (t) => (t / T) * W;
  const ergMax = Math.max(1.3, ...segs.filter((g) => g.kind === 'erg').map((g) => Math.max(g.from, g.to) * s.intensity)) * 1.08;
  const maxP = Math.max(ergMax * ftp, ...s.samples.slice(-1800).map((x) => x.power + 10));
  const Yp = (w) => bot - (Math.min(w, maxP) / maxP) * plotH;
  const gap = segs.length > 60 ? 0 : 1 * dpr;
  const cur = s.segIndex;

  segs.forEach((g, i) => {
    const x0 = X(g.start), x1 = X(g.end);
    const n = g.kind === 'erg' && g.from !== g.to ? Math.max(1, Math.ceil((x1 - x0) / (3 * dpr))) : 1;
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      const sx0 = Math.round(x0 + (x1 - x0) * a), sx1 = Math.round(x0 + (x1 - x0) * b);
      let y, col;
      if (g.kind === 'erg') { const f = segTarget(g, (a + b) / 2); y = Yp(f * ftp * s.intensity); col = zoneHex(f); }
      else { const gr = g.grade + s.gradeOffset; y = bot - Math.max(4 * dpr, ((gr + 0.03) / 0.15) * plotH * 0.7); col = gradeHex(gr); }
      const tMid = g.start + (g.end - g.start) * (a + b) / 2;
      ctx.globalAlpha = tMid < pos ? 0.38 : 1;
      ctx.fillStyle = col;
      ctx.fillRect(sx0, y, Math.max(1, sx1 - sx0 - (k === n - 1 ? gap : 0)), bot - y);
    }
    ctx.globalAlpha = 1;
    if (i === cur) { // outline the current block
      const y = g.kind === 'erg' ? Math.min(Yp(g.from * ftp * s.intensity), Yp(g.to * ftp * s.intensity)) : bot - Math.max(4 * dpr, ((g.grade + s.gradeOffset + 0.03) / 0.15) * plotH * 0.7);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(x0 + dpr * 0.75, y - dpr * 0.75, Math.max(2, x1 - x0 - gap - dpr * 1.5), bot - y + dpr * 0.75);
    }
  });

  // FTP line
  ctx.strokeStyle = '#ffffff40'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#8b93a1'; ctx.fillText(`FTP ${ftp}`, 2 * dpr, Math.max(10 * dpr, Yp(ftp) - 4 * dpr));

  // power trace over the done part
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  s.samples.forEach((x, i) => { const px = X(x.wx ?? x.wt), py = Yp(x.power); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();

  // position marker
  const mx = X(pos);
  ctx.fillStyle = '#fff';
  ctx.fillRect(mx - dpr, top - 4 * dpr, 2 * dpr, bot - top + 4 * dpr);
  ctx.beginPath(); ctx.moveTo(mx - 6 * dpr, top - 10 * dpr); ctx.lineTo(mx + 6 * dpr, top - 10 * dpr); ctx.lineTo(mx, top - 2 * dpr); ctx.closePath(); ctx.fill();
}

// phone buttons
const rpTap = (id, fn) => { const el = document.getElementById(id); el.onclick = (e) => { e.preventDefault(); fn(); renderRide(); }; };
rpTap('rp-minus', () => action(app.session?.mode === 'erg' ? 'down' : 'easier'));
rpTap('rp-plus', () => action(app.session?.mode === 'erg' ? 'up' : 'harder'));
rpTap('rp-pause', () => app.session?.togglePause());
rpTap('rp-more', () => $('#rp-sheet').classList.toggle('hidden'));
rpTap('rp-sheet-close', () => $('#rp-sheet').classList.add('hidden'));
rpTap('rp-gdown', () => action('down'));
rpTap('rp-gup', () => action('up'));
rpTap('rp-skip', () => { action('skip'); $('#rp-sheet').classList.add('hidden'); });
rpTap('rp-lap', () => { action('lap'); $('#rp-sheet').classList.add('hidden'); });
rpTap('rp-erg', () => { action('ergToggle'); $('#rp-sheet').classList.add('hidden'); });
rpTap('rp-end', () => {
  if (app.endArmed && Date.now() - app.endArmed < 3000) { app.endArmed = 0; $('#rp-sheet').classList.add('hidden'); endSession(); }
  else app.endArmed = Date.now();
});

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

// ------------------------------------------------------------------ settings
const FIELDS = [
  ['section', 'Rider'],
  ['ftp', 'FTP (W)', 1], ['riderKg', 'Rider weight (kg)', 0.1], ['bikeKg', 'Bike weight (kg)', 0.1],
  ['section', 'Road feel'],
  ['gradeScale', 'Grade realism (%)', 5, 100, 'Zwift defaults to 50%. 100% = real climbs. Descents are always 100%.'],
  ['cda', 'CdA (m²)', 0.01, 1, 'Aero drag. 0.32 hoods, 0.25 drops.'], ['crr', 'Rolling resistance', 0.001],
  ['section', 'Trainer (learned automatically)'],
  ['realDev', 'Real development (m / crank rev)', 0.01, 1, 'What the trainer reports per pedal turn; learned while riding.'],
  ['maxSendGrade', 'Max grade sent to trainer (%)', 1, 100],
  ['section', 'Ride'],
  ['autoPauseSec', 'Auto-pause after (s, 0 = off)', 1, 1, 'ERG: no pedaling. Slope: bike stopped.'],
];
function renderSettings() {
  const f = $('#settings-form');
  f.innerHTML = FIELDS.map(([k, label, step, mult = 1, help, offset = 0]) => k === 'section'
    ? `<div class="section">${label}</div>`
    : `<label for="set-${k}">${label}</label><input id="set-${k}" type="number" step="${step}" value="${+((app.settings[k] * mult + offset).toFixed(3))}" data-k="${k}" data-mult="${mult}" data-off="${offset}">${help ? `<div class="help">${help}</div>` : ''}`).join('') +
    `<div class="help" id="tm-line">Slope correction learned from your trainer: ${((app.settings.gradeTrim || 0) * 100).toFixed(1)}% grade. <a href="#" id="tm-reset">Reset</a></div>
     <div class="section">Gearing</div>
     <label for="set-dt">Drivetrain</label><select id="set-dt" class="wide-select">${Object.entries(DRIVETRAINS).map(([k, d]) => `<option value="${k}">${d.name}</option>`).join('')}</select>
     <label for="set-style">Shifting style</label><select id="set-style"><option value="sram">SRAM</option><option value="shimano">Shimano</option></select>
     <div class="help">SRAM: right = harder, left = easier, both together = front shift. Shimano: right buttons = rear harder/easier, left buttons = big/small ring. Takes effect on the next ride.</div>
     <label for="set-guard">ERG low-cadence guard</label><select id="set-guard"><option value="1">On</option><option value="0">Off</option></select>
     <div class="help">If cadence drops under 40 rpm in ERG, the target eases to 60% until you're spinning again.</div>`;
  $('#set-guard').value = app.settings.ergCadenceGuard ? '1' : '0';
  $('#tm-reset').onclick = (e) => { e.preventDefault(); app.settings.gradeTrim = 0; app.settings.realDev = DEFAULT_SETTINGS.realDev; ls.set('settings', app.settings); renderSettings(); };
  $('#set-dt').value = app.settings.drivetrain || 'road-2x12-shimano-50-34';
  $('#set-style').value = app.settings.shiftStyle || 'sram';
  f.oninput = (e) => {
    const el = e.target;
    if (el.id === 'set-guard') app.settings.ergCadenceGuard = el.value === '1';
    else if (el.id === 'set-dt') app.settings.drivetrain = el.value;
    else if (el.id === 'set-style') app.settings.shiftStyle = el.value;
    else if (el.dataset.k && el.value !== '') app.settings[el.dataset.k] = (Number(el.value) - Number(el.dataset.off)) / Number(el.dataset.mult);
    ls.set('settings', app.settings);
  };
}

// ------------------------------------------------------------------ wiring
$$('[data-connect]').forEach((b) => (b.onclick = () => connect(b.dataset.connect)));
$('#btn-demo').onclick = enterDemo;
$('#btn-free').onclick = startFree;
$('#btn-settings').onclick = () => {
  renderSettings();
  const cfg = ls.get('sync', {});
  $('#set-token').value = cfg.token || '';
  $('#set-repo').value = cfg.repo || DEFAULT_REPO;
  $('#token-status').textContent = cfg.token ? 'Token saved' : '';
  $('#settings').classList.remove('hidden');
};
$('#btn-token').onclick = async () => {
  const token = $('#set-token').value.trim();
  const repo = $('#set-repo').value.trim() || DEFAULT_REPO;
  const st = $('#token-status');
  if (!token) { ls.set('sync', { repo }); st.textContent = 'Sync turned off'; return; }
  st.textContent = 'Testing...';
  try {
    await new GitHubSync({ token, repo }).test();
    ls.set('sync', { token, repo });
    st.textContent = 'Connected. Syncing past rides...';
    await syncPending();
    await loadCoachData();
    st.textContent = 'Connected and synced';
  } catch (e) { st.textContent = e.message; }
};
$('#btn-log').onclick = () => { $('#log-body').textContent = logLines.join('\n'); $('#log').classList.remove('hidden'); };
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('.panel').classList.add('hidden')));
$('#btn-diag').onclick = async () => {
  for (const d of [app.trainer, app.hr, ...app.controllers]) {
    if (!d?.listServices || d.state !== 'connected') continue;
    logMsg(d.kind, `${d.name} ${JSON.stringify(d.info)} services: ${(await d.listServices()).join(', ')}`);
  }
  if (app.trainer?.data) logMsg('trainer', `last data ${JSON.stringify(app.trainer.data)}`);
};
function setTab(t) {
  app.tab = t; app.focus = 0;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${t}`));
  if (t === 'training') { renderTraining(); refreshRemoteIndex(); }
  if (t === 'calendar') { renderCalendar(); refreshPlanViews(); }
  applyFocus();
}
$$('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
const shiftMonth = (n) => { const [y, m] = (app.calMonth || dkey(new Date()).slice(0, 7)).split('-').map(Number); const d = new Date(y, m - 1 + n, 1, 12); app.calMonth = dkey(d).slice(0, 7); renderCalendar(); };
$('#cal-prev').onclick = () => shiftMonth(-1);
$('#cal-next').onclick = () => shiftMonth(1);
$('#cal-today').onclick = () => { app.calMonth = null; app.calSel = null; renderCalendar(); };
$('#r-pause').onclick = () => { app.session?.togglePause(); renderRide(); };
$('#r-end').onclick = () => { if (confirm('End this ride?')) endSession(); };

// main loop: 4 Hz engine, render
let last = performance.now(), saveAcc = 0;
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(1, (now - last) / 1000);
  last = now;
  if (app.demo) { app.trainer.step(); app.hr.step(dt); }
  const s = app.session;
  if (s && !s.finished) {
    s.tick(dt);
    if (!s.paused) {
      saveAcc += dt;
      if (saveAcc > 30) { saveAcc = 0; saveRide('inprogress'); }
    }
    renderRide();
  }
}, 250);

window.addEventListener('beforeunload', (e) => {
  if (app.session && !app.session.finished && app.session.samples.length > 10) { saveRide('inprogress'); e.preventDefault(); }
});

$("#build-id").textContent = `build ${BUILD}`;
renderDevices();
loadLibrary();
autoReconnect();
syncPending();
window.rodillo = app; // for debugging from the console
