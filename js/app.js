// @ts-check
import { Trainer } from './ble/trainer.js';
import { HeartRate } from './ble/hr.js';
import { ZwiftRide } from './ble/zwiftride.js';
import { SimTrainer, SimHr } from './ble/sim.js';
import { log, logMsg } from './ble/base.js';
import { Session, DEFAULT_SETTINGS } from './engine/session.js';
import { currentBike, shiftStyleFor, gearingName, migrateGarage } from './engine/garage.js';
import { flatten, parseZwo } from './engine/workout.js';
import { encodeActivity } from './fit.js';
import { buildRide, powerCurve, ftpFromRide } from './stats.js';
import { ZONES, zoneOf } from './zones.js';
import { GitHubSync, DEFAULT_REPO, PLAN_PATH, WORKOUTS_PATH, rideSources, syncedToPrune, deleteScope, deletedElsewhere } from './sync.js';
import { reconcile, applyPending } from './settings-sync.js';
import { ls, rides, docs } from './store.js';
import { dkey, dayDate } from './dates.js';
import { rideSegs, pageHtml, chartSvg, tipHtml, selHtml, stepSeg, samplesFromDoc, doneHeadline, lastSameWorkout, vsLastTime } from './ridepage.js';
import { MINE_PATH, emptyMine, applyMinePending, mineView } from './mine.js';
import { initBuilder, openBuilder, builderOpen } from './builder.js';
import { initGarage, openGarage, openGearing, dtSpec, forgetBikePhotos } from './garage.js';
import { initSettings, numField, detectTrainer, shiftLine, renderSignIn } from './settings.js';
import { initTraining, renderTraining } from './training.js';
import { initLibrary, renderLibrary, setWoKind, refreshGradeRanges, cutClimb, gradeBand } from './library.js';
import { initToday, renderHero, renderWeek, renderCalendar, refreshPlanViews, trainingRows, whoopDay, recZone, BIKE_ICO } from './today.js';
import { $, $$, esc, toast, placeInk, inkObserver, slideIn } from './ui.js';
import { profileSvg } from './profile.js';
import { initRidePhone, renderPhone, sizePhoneChart } from './ridephone.js';
import { initControls, onButton, onRelease, focusables, applyFocus } from './controls.js';
import { initRide, renderRide, renderRideStatus, rideClock, sizeChart, slide, slideEnd, rideMsg, rideMsgReset, rideMsgQ, lastTestBest, testStep, testEnded, hideTakeover } from './ride.js';
import { authEnabled, authSession, authToken, takeSignIn } from './auth.js';
import { initMusic, syncMusic } from './music.js';
import { initCountdown, countdownTick, countdownDone, countdownStop, syncCountdown } from './countdown.js';
import { initSound } from './sound.js';
/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('./types.js').ElementEvent} ElementEvent */
/** @typedef {import('./types.js').FieldEvent} FieldEvent */
/** @typedef {import('./types.js').LocalRide} LocalRide */

const BUILD = new URL(import.meta.url).searchParams.get('v') || 'dev';
const ZC = { z1: '#a3a9ae', z2: '#2d7ff9', z3: '#1fa855', z4: '#f4be1a', z5: '#f47b20', z6: '#e23b44' }; // keep in sync with --z1..--z6 in app.css
// Canvas/SVG drawing colors, read from the CSS tokens so they follow the light/dark theme.
let INK, MUTED, RULE, FAINT, FTP_LINE, UNDERLAY, HR_LINE, FITNESS, FATIGUE, GRADE = [], TOK = {};
// WebKit (Safari, Bluefy) can run this module before css/app.css has loaded (WebKit bug 261655), which happens when the CSS
// isn't cached, i.e. right after every deploy (new ?v=). Every color below would then read blank for the whole session:
// blank SVG fills draw black, blank strokes draw nothing, canvas keeps black (Nov 18: all-black charts in Bluefy).
// So nothing starts until the stylesheet is in. Chrome already waits, so there this resolves at once.
const cssReady = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() !== '';
await /** @type {Promise<void>} */ (new Promise((done) => {
  const css = document.querySelector('link[rel="stylesheet"][href*="app.css"]');
  if (!css || cssReady()) return done();
  css.addEventListener('load', /** @type {() => void} */ (done), { once: true });
  css.addEventListener('error', /** @type {() => void} */ (done), { once: true });
  window.addEventListener('load', /** @type {() => void} */ (done), { once: true });
  setTimeout(done, 10000);
}));
/** Re-read the tokens if they came back blank (belt and braces for the wait above); call before drawing. */
const ensureTokens = () => { if (!INK && cssReady()) readTokens(); };
function readTokens() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  [INK, MUTED, RULE, FAINT, FTP_LINE, UNDERLAY, HR_LINE, FITNESS, FATIGUE] = ['--ink', '--muted', '--rule', '--faint', '--ftp-line', '--underlay', '--hr-line', '--fitness', '--fatigue'].map(v);
  GRADE = ['--g-down', '--g0', '--g1', '--g2', '--g3', '--g4'].map(v);
  // the ride page chart (js/ridepage.js) takes its colors as one object
  TOK = { ink: INK, rule: RULE, faint: FAINT, ftp: FTP_LINE, hr: HR_LINE, info: v('--info'), infoLine: v('--info-line'), band: v('--sheet2'), dim: v('--dim'), sheet: v('--sheet') };
}
readTokens();
// colors and layout the Training charts (js/training.js) draw with, read at draw time so they follow the theme
const chartLook = () => (ensureTokens(), { phone: isPhone(), INK, MUTED, RULE, FAINT, UNDERLAY, FITNESS, FATIGUE, TOK, ZC, zoneHex });
// colors the ride screen (js/ride.js) draws with, read at draw time like chartLook()
const rideLook = () => (ensureTokens(), { INK, MUTED, RULE, FTP_LINE, HR_LINE, TOK });
// what the workout profiles (js/profile.js) draw with, read at draw time: the rider's FTP, zone and grade colors (theme)
const profileLook = () => ({ ftp: app.settings.ftp, zoneHex, gradeHex });
// what the Workouts library rows (js/library.js) draw with, read at draw time: settings, plan and theme change
const libView = () => ({ settings: app.settings, plan: app.plan, today: dkey(new Date()), signedIn: signedIn(), GRADE, ZC, prof: profileLook() });
// what Today and Calendar (js/today.js) draw with, read at draw time: the plan, rides, WHOOP and settings change, colors follow the theme
const todayView = () => ({ plan: app.plan, library: app.library, rows: app.rows, whoop: app.whoop, settings: app.settings, today: dkey(new Date()), gradeHex, zoneHex, prof: profileLook() });
const NUM_FONT = 'Archivo, system-ui, sans-serif';
const zoneHex = (f) => ZC[ZONES[zoneOf(f)].color]; // Coggan zones from zones.js
// rampStops(from, to, zoneHex), a ramp's zone color stops, lives in js/profile.js (profiles and the ride chart)
/** Fill an interval card / phone hero; the darkest grade (12%+) needs light text. */
const setZc = (el, c) => { el.style.setProperty('--zc', c); el.style.setProperty('--on-zone', c === GRADE[5] ? 'var(--on-zone-inv)' : ''); };
// gradeBand(g), the grade -> GRADE index, lives in js/library.js (the open row's Time by grade uses the same bands)
const gradeHex = (g) => GRADE[gradeBand(g)];

// ------------------------------------------------------------------ state
/** @type {import('./types.js').AppState} */
const app = {
  settings: { ...DEFAULT_SETTINGS, ...ls.get('settings', {}) },
  trainer: null, hr: null, controllers: [],
  demo: false,
  library: [], plan: null,
  session: null, rideId: null,
  screen: 'home', tab: 'today', focus: 0, woKind: ls.get('woKind', 'erg'),
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
    tell('Open this page in Google Chrome on your Mac (or Bluefy on iPhone).', 'Web Bluetooth is not available');
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
      /** @type {ZwiftRide & { side?: string }} */ (c).side = side; // which hood(s) this connection is for
      bindDevice(c);
      c.on('press', (b) => onButton(b, c));
      c.on('release', onRelease);
      app.controllers.push(c);
      await c.pick(ZwiftRide.requestOptions(side));
      ls.set('dev.controllers', app.controllers.map((x) => x.device?.id).filter(Boolean));
    }
  } catch (e) {
    if (kind.startsWith('controller')) app.controllers = app.controllers.filter((c) => c.device);
    if (e.name !== 'NotFoundError') { logMsg('app', e.message); tell(e.message, 'Could not connect'); }
  }
  renderDevices();
}

function bindDevice(d) {
  if (d._bound) return;
  d._bound = true;
  d.on('state', renderDevices);
  d.on('battery', renderDevices);
  if (d.kind === 'trainer') {
    d.useZwift = app.settings.trainerShifting !== 'app';
    d.on('state', (st) => { if (st === 'connected') detectTrainer(d); const l = $('#shift-line'); if (l) l.textContent = shiftLine(); });
  }
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
      obj.listen(d);
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
  const tz = app.trainer?.state === 'connected' && !app.demo ? `<br>Shifting: ${/** @type {Trainer} */ (app.trainer).zwiftShifting && app.settings.trainerShifting !== 'app' ? 'in the trainer (Zwift protocol)' : 'in Rodillo (FTMS)'}` : '';
  card('trainer', app.trainer, app.demo ? 'Simulated' : tz);
  card('hr', app.hr);
  const ctl = app.controllers.find((c) => c.state === 'connected') || app.controllers[0];
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
  // status dots on the top-bar link button
  const dotState = (d) => (app.demo && d ? 'on' : d?.state === 'connected' ? 'on' : d?.state === 'connecting' ? 'wait' : '');
  const states = { trainer: dotState(app.trainer), hr: dotState(app.hr), controller: anyCtl ? 'on' : app.controllers.some((c) => c.state === 'connecting') ? 'wait' : '' };
  $$('.ldots i').forEach((i) => { i.className = states[i.dataset.k]; }); // top bar + pause screen
  const n = Object.values(states).filter((v) => v === 'on').length;
  $('#btn-devices').title = `Bluetooth connections (${n} of 3 connected)`;
  renderRideStatus();
}

// connections popover
// One popover, two homes: the home top bar, or the pause screen of a ride (where = 'ride').
function setDevPop(open, where) {
  const pop = $('#devpop');
  if (open) {
    const host = where === 'ride' ? $('#r-paused') : $('#home .topbar');
    if (pop.parentElement !== host) host.appendChild(pop);
    pop.classList.toggle('on-ride', where === 'ride');
  }
  pop.classList.toggle('hidden', !open);
  const onRide = open && where === 'ride';
  $('#btn-devices').setAttribute('aria-expanded', String(open && !onRide));
  $('#pz-devices').setAttribute('aria-expanded', String(onRide));
}
// open = shown on screen (a popover left open on a pause screen that has since gone away doesn't count)
const devPopOpen = () => !$('#devpop').classList.contains('hidden') && !!$('#devpop').offsetParent;

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
  app.mineDoc = ls.get('mineDoc', null);
  applyLibrary();
  await loadCoachData();
}

/** Coach edits (plan + workouts) live in rodillo-data/coach/ and win over the public library. */
async function loadCoachData() {
  const gh = syncClient();
  if (!gh) return;
  try {
    const [p, w, m] = await Promise.all([gh.getJson(PLAN_PATH), gh.getJson(WORKOUTS_PATH), gh.getJson(MINE_PATH)]);
    app.coachPlan = p?.json || (await starterPlan(gh));
    app.coachWorkouts = w?.json?.workouts || [];
    app.mineDoc = m?.json || emptyMine();
    ls.set('mineDoc', app.mineDoc);
    reconcileSettings();
    await flushSettings(gh);
    ls.set('coachPlan', app.coachPlan);
    ls.set('coachWorkouts', app.coachWorkouts);
    app.coachError = null;
    app.coachNoRepo = null;
    applyLibrary();
    flushMine(gh);
  } catch (e) {
    app.coachError = e.message;
    app.coachNoRepo = e.noRepo || null;
    logMsg('coach', `could not load coach data: ${e.message}`);
    renderWeek();
  }
}

/**
 * A friend's own data repo (not Agustín's) with no plan yet: create an empty one, so settings sync has
 * somewhere to go and the home screen doesn't fall back to Agustín's public plan. A repo this sign-in
 * can't reach (GitHub App not installed on it) is reported instead. Never runs on DEFAULT_REPO.
 */
async function starterPlan(gh) {
  if (gh.repo.toLowerCase() === DEFAULT_REPO.toLowerCase()) return null;
  if (!(await gh.api(''))) throw Object.assign(new Error(`can't reach ${gh.repo}`), { noRepo: gh.repo });
  const plan = { name: 'My plan', ftp: app.settings.ftp, days: {} };
  try { await gh.putJson(PLAN_PATH, plan, 'Start my plan'); }
  catch (e) { if (e.status !== 409 && e.status !== 422) throw e; return (await gh.getJson(PLAN_PATH))?.json || null; }
  logMsg('coach', `created ${PLAN_PATH} in ${gh.repo}`);
  return plan;
}

/**
 * Settings are shared by every device through the plan (see settings-sync.js): FTP as plan.ftp (the
 * morning coach writes it after a ramp test), everything else under plan.settings. Newest change wins,
 * per setting. Sign-in and theme stay per device (stored outside settings).
 */
function reconcileSettings(source = 'settings') {
  const r = reconcile({ plan: app.coachPlan, settings: app.settings, base: ls.get('settingsBase', null), pending: ls.get('settingsPending', {}), defaults: DEFAULT_SETTINGS, source });
  app.settings = /** @type {Settings} */ (r.settings);
  // bikes saved before gearing left the bike (Nov 12): their gearings move to the rider's own; the next save sends it
  const moved = migrateGarage(app.settings);
  if (moved) Object.assign(app.settings, moved);
  // the bike in use decides the wheel (older settings took it from the gearing)
  const cb = currentBike(app.settings);
  if (cb && app.settings.wheelCirc !== cb.wheel) app.settings.wheelCirc = cb.wheel;
  ls.set('settings', app.settings);
  ls.set('settingsBase', r.base);
  ls.set('settingsPending', r.pending);
  if (r.adopted.length) logMsg('coach', `settings from the plan: ${r.adopted.map((k) => `${k} ${JSON.stringify(app.settings[k])}`).join(', ')}`);
  syncMusic(); // Title music set here or on another device
  syncCountdown(); // Countdown sounds, the same
  return r;
}

/** Writes local setting changes into the plan. True when nothing is left to send. */
let flushing = null;
async function flushSettings(gh = syncClient()) {
  if (flushing) await flushing.catch(() => {});
  const pend = ls.get('settingsPending', {});
  if (!Object.keys(pend).length) return true;
  if (!gh || !app.coachPlan) return false;
  flushing = (async () => {
    let written = [];
    const plan = await gh.updatePlan((p) => { written = applyPending(p, pend); },
      `Settings: ${Object.entries(pend).map(([k, x]) => `${k} ${JSON.stringify(x.v)}`).join(', ')}`);
    app.coachPlan = plan;
    ls.set('coachPlan', plan);
    const base = ls.get('settingsBase', {}), left = ls.get('settingsPending', {});
    for (const k of written) { base[k] = { v: pend[k].v, at: pend[k].at }; if (left[k]?.at === pend[k].at) delete left[k]; }
    ls.set('settingsBase', base);
    ls.set('settingsPending', left);
    reconcileSettings(); // keys we lost to a newer change elsewhere: take theirs
    return !Object.keys(left).length;
  })();
  try { return await flushing; }
  catch (e) { logMsg('coach', `settings not saved to the plan yet: ${e.message}`); return false; }
  finally { flushing = null; }
}

/** Every settings change goes through here: saved on this device now, sent to the plan shortly after. */
let flushTimer;
function saveSettings(source = 'settings') {
  reconcileSettings(source);
  refreshGradeRanges();
  // changed from the pause screen: bike, gearing and weights apply to the ride in progress
  if (app.session && !app.session.finished) { app.session.applySettings(app.settings); if (app.screen === 'ride') renderRide(); }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushSettings(), 1500);
}

/** "Keep" after a ramp test: tells the morning coach not to apply that test's FTP. */
async function declineTestFtp(rideId) {
  const gh = syncClient();
  if (!gh) return;
  try {
    app.coachPlan = await gh.updatePlan((p) => { p.ftpDeclinedAt = new Date().toISOString(); }, `FTP kept after ramp test ${rideId.slice(0, 10)}`);
    ls.set('coachPlan', app.coachPlan);
  } catch (e) { logMsg('coach', `could not record kept FTP: ${e.message}`); }
}

// ------------------------------------------------------------------ my workouts (built in the app)
// Stored in rodillo-data workouts/mine.json (see js/mine.js). Changes are shown at once and queued in
// localStorage until they're written, so the builder works offline or signed out.
async function saveMine(w) { await queueMine(w.id, w); setTab('workouts'); setWoKind('mine', true); }
async function deleteMine(id) { await queueMine(id, null); }
async function queueMine(id, w) {
  const pend = ls.get('minePending', {});
  pend[id] = { w, at: new Date().toISOString() };
  ls.set('minePending', pend);
  applyLibrary();
  if (!(await flushMine())) toast("Couldn't reach GitHub. Saved here for now; it goes to rodillo-data on the next load.");
}
let mineFlushing = null;
async function flushMine(gh = syncClient()) {
  if (mineFlushing) await mineFlushing.catch(() => {});
  const pend = ls.get('minePending', {});
  if (!Object.keys(pend).length) return true;
  if (!gh) return false;
  mineFlushing = (async () => {
    let handled = [];
    const names = Object.entries(pend).map(([id, x]) => (x.w ? x.w.name : `delete ${id}`));
    app.mineDoc = await gh.updateJson(MINE_PATH, (doc) => { handled = applyMinePending(doc, pend); }, `My workouts: ${names.join(', ')}`, emptyMine);
    ls.set('mineDoc', app.mineDoc);
    const left = ls.get('minePending', {});
    for (const id of handled) if (left[id]?.at === pend[id].at) delete left[id];
    ls.set('minePending', left);
    applyLibrary();
  })();
  try { await mineFlushing; return true; }
  catch (e) { logMsg('coach', `my workouts not saved to rodillo-data yet: ${e.message}`); return false; }
  finally { mineFlushing = null; }
}
/** Dates from today on where the plan has this workout. */
function plannedOn(id) {
  const today = dkey(new Date());
  return Object.entries(app.plan?.days || {}).filter(([d, x]) => d >= today && x === id).map(([d]) => dayDate(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
}

function applyLibrary() {
  const custom = new Map((signedIn() ? app.coachWorkouts || [] : []).map((w) => [w.id, { ...w, _source: /** @type {'coach'} */ ('coach') }]));
  const lib = (app.baseLibrary || []).map((w) => custom.get(w.id) || w);
  for (const [id, w] of custom) if (!lib.some((x) => x.id === id)) lib.push(w);
  for (const w of ls.get('imported', [])) lib.push(w);
  // Agustín's own workouts (builder) are private: only with access to rodillo-data (GitHub sign-in or token).
  const mine = !signedIn() ? [] : mineView(app.mineDoc, ls.get('minePending', {})).map((w) => ({ ...w, _source: /** @type {'mine'} */ ('mine') }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  app.plan = (signedIn() && app.coachPlan) || app.basePlan || null; // the coach's plan is private: signed out shows the public one
  reconcileSettings();
  app.library = [...mine, ...lib].map((w) => cutClimb(w, app.settings)); // newest edit first; real climbs cut at the rider's detail
  renderLibrary();
  refreshPlanViews();
}

// ------------------------------------------------------------------ workout profiles and meta line
// js/profile.js: profileSvg, trackSvg, woMeta, workSummary, the readout (bindProfileHover) and rampStops, shared by the
// library, Today, Calendar, the builder, the ride page and the ride screen. Their colors come in profileLook() (top).

// ---- Training tab (stats card, charts, rides list): js/training.js. trainingRows() is in js/today.js with refreshPlanViews().
// Touch screens have no hover: tap (i) to toggle the tip, tap anywhere else to close it (infoTip() tips: the Training tab and
// Today's overview tiles).
document.addEventListener('click', (/** @type {ElementEvent} */ e) => {
  const btn = e.target.closest('.info-btn');
  $$('.info.open').forEach((x) => { if (!btn || x !== btn.parentElement) x.classList.remove('open'); });
  if (btn) btn.parentElement.classList.toggle('open');
});

// ------------------------------------------------------------------ imports
$('#import-workout').addEventListener('change', async (/** @type {FieldEvent} */ e) => {
  const failed = [];
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
    } catch (err) { failed.push(`${f.name}: ${err.message}`); }
  }
  e.target.value = '';
  renderLibrary();
  if (failed.length) tell(failed.join('\n'), failed.length > 1 ? 'Could not import these files' : 'Could not import this file');
});

// ------------------------------------------------------------------ rides
async function canRide() {
  if (app.trainer && (app.trainer.state === 'connected')) return true;
  return ask('Use Demo mode to try without hardware.', { title: 'No trainer connected. Start anyway?', ok: 'Start anyway' });
}
/** `btn` = the hero's Start workout button: with a trainer (or Demo mode) ready, it plays the launch animation first. */
async function startWorkout(w, intensity = 1, btn = null) {
  if (app.launching || app.session) return;
  const go = () => { if (!app.session) beginSession({ workout: w, intensity }); };
  const ready = app.demo || app.trainer?.state === 'connected';
  if (!(btn && ready) && !await canRide()) return;
  if (btn && ready) return launchFrom(btn, go);
  go();
}

/** Start workout / Free ride launch (asked for by Agustín, Nov 11): each button plays its own intro
   (workoutIntro / freeIntro), the icon sprints off to the right and the button grows over the whole screen
   in its own color; the ride screen is set up behind it and the cover fades away. Skipped under reduced motion. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The color a button shows, made solid so it can fill the screen: the light glass buttons on the zone
   color read as white over it, a transparent one shows the sheet behind it. */
function solidBg(btn) {
  const m = getComputedStyle(btn).backgroundColor.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1];
  const [r, g, b, a = 1] = m;
  if (a >= 1) return `rgb(${r}, ${g}, ${b})`;
  if (a === 0) return getComputedStyle(document.documentElement).getPropertyValue('--sheet').trim() || '#fff';
  const mix = (c) => Math.round(c * a + 255 * (1 - a));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
async function launchFrom(btn, go, kind = 'workout') {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !btn.animate) return go();
  app.launching = true;
  const free = kind === 'free';
  const ico = btn.querySelector(free ? '.bike-ico' : '.play-ico'), label = btn.querySelector('.hs-label');
  const text = label?.textContent || '';
  try {
    btn.classList.add('launching');
    const fx = free ? await freeIntro(btn, ico, label) : (await workoutIntro(ico, label, text), null);
    // 2. sprint: a small wind-up, then off the right edge, stretched by the speed
    const b = btn.getBoundingClientRect(), r = ico.getBoundingClientRect();
    const dx = b.right - r.left + 12;
    // the bike keeps its wheelie (and its -2px lift) while it sprints
    const pose = free ? ' translateY(-2px) rotate(-14deg)' : '';
    if (fx) { // free ride: a burst of dust as the bike launches, air lines trailing it
      for (let k = 0; k < 4; k++) puff(btn, fx.wx - Math.random() * 4, fx.wy, true);
      speedLines(btn, fx, dx);
    }
    await ico.animate([{ transform: `translateX(0)${pose} scale(1, 1)` }, { transform: `translateX(-9px)${pose} scale(.8, 1.12)`, offset: 0.3 },
      { transform: `translateX(${dx}px)${pose} scale(1.9, .8)` }],
      { duration: 480, easing: 'cubic-bezier(.6, 0, .9, .5)', fill: 'forwards' }).finished;
    // 3. the button grows to fill the screen in its own color
    const rect = btn.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    const cover = document.createElement('div');
    cover.className = 'launch-cover';
    document.body.append(cover);
    const rad = Math.min(rect.height / 2, parseFloat(getComputedStyle(btn).borderTopLeftRadius) || 0);
    const from = `inset(${rect.top}px ${W - rect.right}px ${H - rect.bottom}px ${rect.left}px round ${rad}px)`;
    cover.style.background = solidBg(btn);
    await cover.animate([{ clipPath: from }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }],
      { duration: 640, easing: 'cubic-bezier(.75, 0, .25, 1)', fill: 'forwards' }).finished;
    // 4. ride screen behind the cover, then reveal it
    go();
    btn.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    btn.querySelectorAll('.lz-fx').forEach((x) => x.remove());
    btn.classList.remove('launching', 'pedal');
    if (label) label.textContent = text;
    await sleep(200);
    await cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: 'ease-out', fill: 'forwards' }).finished;
    cover.remove();
  } catch (e) {
    logMsg('app', `launch: ${e.message}`);
    $$('.launch-cover, .lz-fx').forEach((x) => x.remove());
    btn.classList.remove('launching', 'pedal');
    if (label) label.textContent = text;
    go();
  } finally { app.launching = false; }
}

/** Start workout: the play icon rocks while a wave runs through the label, then the letters fall. */
async function workoutIntro(ico, label, text) {
  // 1. the icon rocks while a wave runs through the label from the first letter to the last; then the
  //    letters fall from right to left and vanish as they cross the line they sat on (clip-path on .hs-label)
  const WAVE = 420, WAVE_STEP = 45, FALL = 380, FALL_STEP = 40;
  const n = [...text].length;
  const fallStart = (n - 1) * WAVE_STEP + WAVE;
  const textEnd = fallStart + (n - 1) * FALL_STEP + FALL;
  const tilt = [0, -18, 16, -14, 12, -11, 9, -7, 5, -3, 0];
  ico.animate(tilt.map((d) => ({ transform: `rotate(${d}deg)` })), { duration: textEnd, easing: 'ease-in-out', fill: 'forwards' });
  if (label) {
    label.innerHTML = [...text].map((c) => `<i>${c === ' ' ? '&nbsp;' : esc(c)}</i>`).join('');
    const kids = [...label.children];
    kids.forEach((ch, i) => {
      ch.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-0.45em)', easing: 'ease-in' }, { transform: 'translateY(0)' }],
        { duration: WAVE, delay: i * WAVE_STEP, easing: 'ease-out', composite: 'add' });
      const tip = (Math.random() * 2 - 1) * 10;
      ch.animate([{ transform: 'translateY(0) rotate(0)' }, { transform: `translateY(1.6em) rotate(${tip}deg)` }],
        { duration: FALL, delay: fallStart + (n - 1 - i) * FALL_STEP, easing: 'cubic-bezier(.5, 0, .9, .4)', fill: 'forwards', composite: 'add' });
    });
  }
  await sleep(textEnd);
}

/** Free ride (asked for by Agustín, Nov 11): the bike pops onto its rear wheel and pedals; the label winds up
   and rushes off to the left while the bike leans back further, then settles before the sprint. */
async function freeIntro(btn, bike, label) {
  // bike layout box (no transform) in the button's own coordinates; the rear tyre contact (transform-origin 21% 93%)
  // stays put while the bike rotates, so the dust comes from there
  const was = bike.style.transform;
  bike.style.transform = 'none';
  const bb = btn.getBoundingClientRect(), r0 = bike.getBoundingClientRect();
  bike.style.transform = was;
  const k = bb.width / btn.offsetWidth || 1; // the button may be grown by hover
  const box = { x: (r0.left - bb.left) / k - btn.clientLeft, y: (r0.top - bb.top) / k - btn.clientTop, w: r0.width / k, h: r0.height / k };
  box.wx = box.x + box.w * 0.21; box.wy = box.y + box.h * 0.93 - 2;
  btn.classList.add('pedal');
  const T = 1000;
  bike.animate([
    { transform: getComputedStyle(bike).transform }, // already tilted if hovered
    { transform: 'translateY(-2px) rotate(-14deg)', offset: 0.18 },
    { transform: 'translateY(-2px) rotate(-14deg)', offset: 0.3 },
    { transform: 'translateY(-3px) rotate(-26deg)', offset: 0.6 },
    { transform: 'translateY(-2px) rotate(-12deg)', offset: 0.82 },
    { transform: 'translateY(-2px) rotate(-14deg)' }],
    { duration: T, easing: 'ease-in-out', fill: 'forwards' });
  if (label) {
    const r = label.getBoundingClientRect();
    const dx = (r.right - bb.left) / k + 16;
    label.animate([
      { transform: 'translateX(0) scale(1, 1)', filter: 'blur(0)' },
      { transform: 'translateX(8px) scale(.92, 1.04)', filter: 'blur(0)', offset: 0.32, easing: 'cubic-bezier(.6, 0, .9, .5)' },
      { transform: `translateX(-${dx}px) scale(1.5, .9)`, filter: 'blur(1.5px)' }],
      { duration: 760, delay: 120, fill: 'forwards' });
  }
  // dust off the rear wheel for as long as the front is up
  await sleep(T * 0.18);
  const dust = setInterval(() => puff(btn, box.wx - Math.random() * 3, box.wy), 50);
  await sleep(T * 0.82);
  clearInterval(dust);
  return box;
}

/** One dust puff at (x, y) in the button's coordinates, thrown back and up, growing and fading. */
function puff(btn, x, y, big = false) {
  const d = document.createElement('span');
  const size = (big ? 4.5 : 3.5) + Math.random() * (big ? 3 : 4);
  d.className = 'lz-fx lz-dust';
  d.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px`;
  btn.append(d);
  const back = (12 + Math.random() * 22) * (big ? 1.6 : 1), up = 2 + Math.random() * (big ? 12 : 8);
  d.animate([{ transform: 'translate(0, 0) scale(.5)', opacity: big ? 0.38 : 0.42 },
    { transform: `translate(-${back}px, -${up}px) scale(${1.5 + Math.random()})`, opacity: 0 }],
    { duration: 480 + Math.random() * 300, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'forwards' })
    .finished.then(() => d.remove(), () => d.remove());
}

/** Air lines behind the sprinting bike: they ride the same curve as the bike and stretch out as it speeds up. */
function speedLines(btn, box, dx) {
  [[0.2, 30], [0.42, 46], [0.62, 38], [0.84, 24]].forEach(([fy, len], i) => {
    const l = document.createElement('span');
    l.className = 'lz-fx lz-line';
    const right = box.x + box.w * 0.12;
    l.style.cssText = `left:${right - len}px;top:${box.y + box.h * fy}px;width:${len}px`;
    btn.append(l);
    l.animate([{ transform: 'translateX(0) scaleX(0)', opacity: 0 }, { transform: 'translateX(-9px) scaleX(0)', opacity: 0, offset: 0.3 },
      { transform: `translateX(${dx}px) scaleX(1)`, opacity: 0.75 }],
      { duration: 480, delay: i * 10, easing: 'cubic-bezier(.6, 0, .9, .5)', fill: 'both' });
  });
}

/** `btn` = the Free ride button: with a trainer (or Demo mode) ready, it plays the launch animation first. */
async function startFree(btn = null) {
  if (app.launching || app.session) return;
  const go = () => { if (!app.session) beginSession({}); };
  const ready = app.demo || app.trainer?.state === 'connected';
  if (!(btn && ready) && !await canRide()) return;
  if (btn && ready) return launchFrom(btn, go, 'free');
  go();
}

// No bike check before a ride (Agustín, Nov 14: it cost the Start / Free ride launch animation, and picking every
// time was a chore). Rides start on the bike in use; the pause / Ready screen's Bike button opens the Garage and a
// pick applies to the ride at once (saveSettings -> session.applySettings).

let wakeLock = null;
// keep the screen on during a ride; the browser drops the lock when the page is hidden,
// so ask again whenever the ride screen comes back.
function keepAwake() { navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {}); }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.session && !app.session.finished) keepAwake();
});
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
  s.on('workoutDone', () => { toast('Workout complete. Free ride, or hold B to finish'); countdownDone(s); });
  s.on('tick', () => countdownTick(s)); // the last 3 s of a step: one soft pulse per second (js/countdown.js)
  s.on('testEnd', (e) => testEnded(s, e));
  rideMsgReset();
  s.on('message', (t) => rideMsg(t));
  // a new step: anything still waiting belongs to the step that just ended, and its first message can replace what's up
  s.on('segment', () => { rideMsgQ.list = []; rideMsgQ.stale = true; testStep(s); });
  s.test = s.segs?.some((g) => g.untilFail) ? { st: {}, prevBest: lastTestBest() } : null;
  show('ride');
  $('#r-name').textContent = s.name;
  sizeChart(); sizePhoneChart();
  $('#rp-sheet').classList.add('hidden');
  app._rpSegI = undefined; app._segI = undefined;
  if (slide.busy) slideEnd();
  keepAwake();
  renderRide();
}

// rides with fewer recorded seconds than this are dropped (no summary, not saved).
// Samples are 1 per second and only while riding, so Ready / Paused time doesn't count.
const MIN_SAMPLES = 10;
const tooShort = () => (app.session?.samples.length ?? 0) < MIN_SAMPLES;
async function endSession() {
  hideTakeover();
  const s = app.session;
  if (!s) return;
  s.finish();
  countdownStop();
  rideMsgReset();
  wakeLock?.release?.().catch(() => {});
  if (s.samples.length < MIN_SAMPLES) { app.session = null; show('home'); return; }
  // remember what the app learned about this trainer (real rides only)
  if (!app.demo) {
    const simSamples = s.samples.filter((x) => x.grade !== 0).length;
    if (simSamples > 120) Object.assign(app.settings, s.learned());
    else app.settings.realDev = s.devEst.dev;
    saveSettings();
  }
  const ride = await saveRide('done');
  app.session = null;
  openDone(ride);
}

function rideDoc(ride) {
  return buildRide(ride.samples, ride.meta);
}

async function saveRide(status) {
  const s = app.session;
  const meta = {
    name: s.name, workoutId: s.workout?.id || null, tags: s.workout?.tags || (s.segs ? [] : ['free-slope']),
    ftp: app.settings.ftp, startMs: s.startMs || app.rideId, segs: s.segs, source: app.demo ? 'demo' : 'rodillo',
    segsChanged: !!s.segsChanged, // open-ended test: the steps ridden differ from the workout file
    bike: currentBike(app.settings)?.name || null,
    gearing: s.segs && s.segs.every((g) => g.kind === 'erg') ? null : gearingName(app.settings), // the last one, if it changed mid-ride
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
// GitHub sign-in wins over a pasted token; the token stays as the fallback.
function syncClient() {
  const cfg = ls.get('sync', {});
  const repo = dataRepo();
  if (authEnabled() && authSession()) return new GitHubSync({ token: authToken, repo });
  return cfg.token ? new GitHubSync({ token: cfg.token, repo }) : null;
}
/**
 * The data repo this browser syncs with: the one typed in Settings > Sync, else the signed-in user's own
 * <login>/rodillo-data (so a friend who signs in gets their own repo with nothing to type), else Agustín's.
 * A saved DEFAULT_REPO doesn't stick to someone else's sign-in.
 */
function dataRepo() {
  const cfg = ls.get('sync', {});
  const s = authEnabled() ? authSession() : null;
  const own = s?.login ? `${s.login}/rodillo-data` : null;
  if (cfg.repo && !(own && cfg.repo.toLowerCase() === DEFAULT_REPO.toLowerCase())) return cfg.repo;
  return own || cfg.repo || DEFAULT_REPO;
}
const signedIn = () => !!syncClient();
/** Lost access to rodillo-data: the builder can't save anymore, close it (unsaved edits are dropped). */
function closeBuilderNow() { if (builderOpen()) $('#builder').classList.add('hidden'); }
const syncHint = () => (authEnabled() ? 'Sign in with GitHub' : 'Add your GitHub token');

async function syncRide(ride) {
  const gh = syncClient();
  const say = (state, text) => doneSync(ride, state, text);
  if (ride.demo || !gh) return false;
  try {
    say('busy', 'Syncing to rodillo-data');
    const doc = { ...rideDoc(ride), laps: ride.laps };
    const index = await gh.pushRide(doc);
    Object.assign(ride, { synced: true, syncedTo: gh.repo, syncedAt: Date.now() });
    if (!ride.discarded) await rides.put(ride);
    ls.set('remoteIndex', index.rides);
    say('ok', 'Synced. Your coach can see it.');
    return true;
  } catch (e) {
    logMsg('sync', e.message);
    say('err', 'Not synced yet, will retry next launch');
    return false;
  }
}

async function syncPending() {
  const gh = syncClient();
  if (!gh) return;
  for (const id of ls.get('pendingDeletes', [])) {
    try { ls.set('remoteIndex', (await gh.deleteRide(id)).rides); ls.set('pendingDeletes', ls.get('pendingDeletes', []).filter((x) => x !== id)); logMsg('sync', `deleted ${id}`); }
    catch (e) { logMsg('sync', `delete ${id} failed: ${e.message}`); }
  }
  let all = [];
  try { all = await rides.list(); } catch { return; }
  for (const meta of all) {
    if (meta.status !== 'done' || meta.synced || meta.demo || !meta.meta) continue;
    const ride = await rides.get(meta.id);
    if (await syncRide(ride)) logMsg('sync', `synced ${ride.summary.id}`);
  }
  await refreshRemoteIndex();
  await pruneSynced();
}

async function refreshRemoteIndex() {
  const gh = syncClient();
  if (!gh) return;
  try {
    const r = await gh.getJson('index.json');
    const list = r?.json?.rides;
    ls.set('remoteIndex', list || []); ls.set('remoteIndexAt', Date.now());
    if (list?.length) await dropDeletedElsewhere(list.map((x) => x.id), gh.repo); // an empty or missing index proves nothing
  } catch (e) { logMsg('sync', `index fetch failed: ${e.message}`); }
  if (app.tab === 'training') renderTraining();
  refreshPlanViews();
}

function downloadFit(ride) {
  if (!ride?.samples?.length) { tell('This ride has no recorded data to export.', 'Nothing to export'); return; }
  const bytes = encodeActivity(ride.samples, ride.laps, { tss: ride.summary?.tss });
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rodillo-${dkey(new Date(ride.id))}-${ride.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.fit`; // the local day it was ridden
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ ride page (one completed ride, js/ridepage.js)
// Opened from the done hero's "See ride", a Training row or a ridden Calendar day. Back / Esc / controller B returns.
const rd = { id: null, doc: null, local: null, segs: [], sel: null, t: null, geo: null, from: null, scrollY: 0 };
const RD_BACK = { today: 'Today', workouts: 'Workouts', training: 'Training', calendar: 'Calendar' };
const BACK_ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const canHover = matchMedia('(hover: hover)');

async function openRide(id, done = null) {
  if (!id) return;
  Object.assign(rd, { id, doc: null, local: null, segs: [], sel: null, t: null, geo: null, from: done ? 'home' : app.tab, scrollY: done ? 0 : window.scrollY, done });
  $$('.panel').forEach((p) => p.classList.add('hidden'));
  setDevPop(false);
  show('ridepage');
  window.scrollTo(0, 0);
  const shell = (msg) => `<div class="rd-nav"><button class="ghost small rd-back" data-rd="back">${BACK_ICO}${RD_BACK[rd.from] || 'Home'}</button></div><p class="muted rd-msg">${msg}</p>`;
  $('#rd').innerHTML = shell('Loading ride...');
  try {
    const got = await loadRideDoc(id);
    if (rd.id !== id || app.screen !== 'ridepage') return;
    if (!got) { $('#rd').innerHTML = shell(`This ride's details are in rodillo-data. ${syncHint()} in <a href="#" data-open-settings="sync">Settings</a> to see them on this device.`); return; }
    Object.assign(rd, got);
    renderRidePage();
  } catch (e) {
    if (rd.id === id) $('#rd').innerHTML = shell(`Couldn't load this ride (${esc(String(e.message || e).slice(0, 90))}). Check your connection and try again.`);
  }
}

/**
 * Where a ride comes from: an unsynced ride from this device's recording; a synced one from rodillo-data (fresh on
 * every open, so a fix made in the repo shows), then the cached copy (offline), then the recording. `rideSources()`.
 */
async function loadRideDoc(id) {
  let row = null, full = null;
  try { row = (await rides.list()).find((r) => r.summary?.id === id); } catch { /* no idb */ }
  const fromLocal = async () => {
    full ||= row && await rides.get(row.id);
    return full?.samples?.length && full.meta ? { doc: { ...rideDoc(full), laps: full.laps }, local: full } : null;
  };
  const fromCache = async () => { try { const c = await docs.get(id); return c ? { doc: c, local: null } : null; } catch { return null; } };
  const fromRemote = async () => {
    const gh = syncClient();
    if (!gh) return null;
    try {
      const r = await gh.getJson(`rides/${id.slice(0, 4)}/${id}.json`);
      if (!r?.json?.summary) return null;
      try { await docs.put(id, r.json); } catch { /* cache is optional */ }
      return { doc: r.json, local: null };
    } catch (e) { logMsg('sync', `ride ${id}: ${e.message}`); return null; }
  };
  const read = { local: fromLocal, cache: fromCache, remote: fromRemote };
  for (const src of rideSources(row)) {
    const got = await read[src]();
    if (got) return got;
  }
  return null;
}

/** Drop this device's recordings of rides deleted on another device (`deletedElsewhere()`), given a fresh index. */
async function dropDeletedElsewhere(remoteIds, repo) {
  try {
    const ids = deletedElsewhere(await rides.list(), remoteIds, repo);
    for (const k of ids) await rides.del(k);
    if (ids.length) logMsg('sync', `removed ${ids.length} ride${ids.length > 1 ? 's' : ''} deleted on another device`);
  } catch (e) { logMsg('sync', `deleted elsewhere: ${e.message}`); }
}

/** Drop full recordings of rides rodillo-data has had for a few days (`syncedToPrune()`); the repo copy is the ride. */
async function pruneSynced() {
  try {
    const ids = syncedToPrune(await rides.list(), ls.get('remoteIndex', []).map((r) => r.id));
    for (const k of ids) await rides.del(k);
    if (ids.length) logMsg('sync', `removed ${ids.length} synced ride${ids.length > 1 ? 's' : ''} from this device`);
  } catch (e) { logMsg('sync', `prune: ${e.message}`); }
}

function closeRide() {
  const wasDone = !!rd.done;
  rd.id = null; rd.done = null;
  show('home');
  if (wasDone) { setTab('today'); refreshPlanViews(); return; } // end of ride: back to Today with the done hero
  window.scrollTo(0, rd.scrollY);
}

// ------------------------------------------------------------------ end of ride: the ride page with a "done" bar
// The ride is already saved on this device (saveRide) and starts syncing right away. Done goes home;
// Discard deletes it here and, if it already reached rodillo-data, there too (queued when offline).
function openDone(ride) {
  const st = ride.summary;
  const found = ride.demo ? null : ftpFromRide(st);
  const cur = app.settings.ftp;
  const gh = syncClient();
  const sync = ride.demo ? { state: 'off', text: 'Demo ride: not added to your history' }
    : gh ? { state: 'busy', text: 'Syncing to rodillo-data' }
    : { state: 'off', text: `Kept on this device. ${syncHint()} in Settings to sync it.` };
  const done = {
    ride, sync, demo: ride.demo,
    headline: doneHeadline(ride),
    vs: vsLastTime(st, lastSameWorkout(st, app.rows)),
    ftp: found && (found.ftp > cur || (found.test && found.ftp !== cur)) ? { ...found, cur } : null,
  };
  openRide(st.id, done);
  if (!ride.demo && gh) done.syncP = syncRide(ride);
}

function doneSync(ride, state, text) {
  if (rd.done?.ride !== ride) return;
  rd.done.sync = { state, text };
  const el = $('#rd-syncst');
  if (el) { el.className = `dn-sync ${state}`; el.textContent = text; }
}

function doneDiscard() {
  const d = rd.done, ride = d.ride;
  return deleteRideEverywhere({ id: ride.summary.id, local: ride, demo: ride.demo, pushing: !!d.syncP, wait: d.syncP, title: 'Discard this ride?', ok: 'Discard', said: 'Ride discarded' });
}

/**
 * Deletes one ride everywhere after asking (the done page's Discard and the ride page's Delete): this device's recording
 * and cached copy, then rodillo-data when `deleteScope()` says it's there. The id goes into pendingDeletes first, so the
 * lists drop it right away and an offline delete retries in `syncPending()`. `wait`: a push still in flight lands first.
 * @param {{ id: string, local?: LocalRide | null, demo?: boolean, pushing?: boolean, wait?: Promise<any>, title: string, ok: string, said: string }} o
 */
async function deleteRideEverywhere({ id, local = null, demo = false, pushing = false, wait, title, ok, said }) {
  const gh = syncClient();
  const scope = deleteScope({ demo, synced: !!local?.synced, inIndex: ls.get('remoteIndex', []).some((r) => r.id === id), pushing, signedIn: !!gh });
  if (!(await ask(scope.text, { title, ok, danger: true })) || rd.id !== id) return;
  if (scope.remote) ls.set('pendingDeletes', [...new Set([...ls.get('pendingDeletes', []), id])]);
  if (local) { local.discarded = true; try { await rides.del(local.id); } catch { /* ignore */ } }
  try { await docs.del(id); } catch { /* ignore */ }
  closeRide();
  toast(said);
  if (app.tab === 'training') renderTraining();
  refreshPlanViews();
  if (!scope.remote) return;
  await wait;
  try {
    ls.set('remoteIndex', (await gh.deleteRide(id)).rides);
    ls.set('pendingDeletes', ls.get('pendingDeletes', []).filter((x) => x !== id));
    logMsg('sync', `deleted ${id}`);
  } catch (e) { logMsg('sync', `delete ${id} failed: ${e.message}`); }
}

async function doneFtp(take) {
  const f = rd.done?.ftp;
  if (!f || f.msg) return;
  const st = rd.done.ride.summary;
  const say = (msg) => { f.msg = msg; const b = $('#dn-ftp .dn-ftp-btns'); if (b) b.remove(); $('#dn-ftpmsg').textContent = msg; };
  if (!take) { if (f.test) declineTestFtp(st.id); say(`Kept ${f.cur} W.`); return; }
  $$('#dn-ftp button').forEach((/** @type {HTMLButtonElement} */ b) => (b.disabled = true));
  app.settings.ftp = f.ftp;
  reconcileSettings(`${f.test ? 'ramp test' : 'ride'} ${st.id.slice(0, 10)}`);
  const synced = await flushSettings();
  refreshPlanViews();
  say(synced ? `FTP is now ${f.ftp} W on all devices.` : `FTP is now ${f.ftp} W here. It goes to your plan on the next sync.`);
}

const rideFtp = () => rd.doc?.summary?.ftp || app.settings.ftp;

function renderRidePage() {
  const doc = rd.doc, st = doc.summary;
  const w = st.workoutId ? app.library.find((x) => x.id === st.workoutId) : null;
  // the steps as ridden (stored with this device's recording), else the workout as it is in the library now
  rd.segs = rideSegs(doc, rd.local?.meta?.segs || doc.segs || (w ? flatten(w, rideFtp()) : null));
  const sums = (app.rows || []).filter((r) => !r.demo).map((r) => r.summary);
  const season = powerCurve(sums, 90), allTime = powerCurve(sums);
  $('#rd').innerHTML = pageHtml(doc, {
    segs: rd.segs, ftp: rideFtp(), zoneHex, gradeHex, season, allTime, sel: rd.sel, phone: isPhone(),
    profile: w ? profileSvg(w, profileLook(), 1000, 100) : '', backLabel: RD_BACK[rd.from] || 'Home',
    canFit: !!(rd.local?.samples?.length || doc.streams?.power || doc.streams?.hr), canDelete: !!(rd.local || syncClient()),
    done: rd.done,
  });
  bindRideChart();
  drawRideChart();
}

function drawRideChart() {
  const wrap = $('#rd-wrap');
  if (!wrap || !rd.doc) return;
  ensureTokens();
  const c = chartSvg(rd.doc, { width: wrap.clientWidth, phone: isPhone(), ftp: rideFtp(), segs: rd.segs, sel: rd.sel, tok: TOK, zoneHex, gradeHex });
  const svg = $('#rd-chart');
  svg.setAttribute('viewBox', `0 0 ${c.width} ${c.height}`);
  svg.setAttribute('height', String(c.height));
  svg.innerHTML = c.svg;
  rd.geo = c.geo;
  const s = rd.segs.find((x) => x.i === rd.sel);
  $('#rd-sel').innerHTML = s ? selHtml(rd.doc, s) : '';
  $('#rd-sel').classList.toggle('on', !!s);
  $('#rd-hint').classList.toggle('hidden', !!s);
  rideCrosshair(rd.t);
}

/** Crosshair + ink tag at second t (null hides it). */
function rideCrosshair(t) {
  const g = rd.geo, xh = $('#rd-chart .rd-xh'), tip = $('#rd-tip');
  if (!g || !xh) return;
  if (t == null || !Number.isFinite(t)) { rd.t = null; xh.style.display = 'none'; tip.classList.remove('on'); return; }
  t = Math.max(0, Math.min(g.T - 1, Math.round(t)));
  rd.t = t;
  const x = g.X(t);
  xh.style.display = '';
  const line = xh.querySelector('line');
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  xh.querySelectorAll('circle').forEach((c) => {
    const l = g.lanes.find((q) => q.k === c.dataset.k), v = g.vals[c.dataset.k]?.[t];
    const off = c.dataset.k === 'hr' && !rd.doc.streams.hr[t];
    c.style.display = off || v == null ? 'none' : '';
    if (!off && v != null) { c.setAttribute('cx', x); c.setAttribute('cy', g.yOf(l, v)); }
  });
  tip.innerHTML = tipHtml(rd.doc, rd.segs, t);
  tip.style.left = `${x}px`;
  tip.style.top = `${g.lanes[0].y + 18}px`;
  // the tag sits beside the line, on the side with more room
  tip.style.transform = x > $('#rd-wrap').clientWidth / 2 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
  tip.classList.add('on');
}

function selectRideSeg(i, fromTable = false) {
  rd.sel = i == null || rd.sel === i ? null : i;
  $$('#rd-ints tr[data-i]').forEach((tr) => tr.classList.toggle('sel', +tr.dataset.i === rd.sel));
  drawRideChart();
  if (fromTable && rd.sel != null) $('.rd-charts')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** Mouse/pen: hover reads, click selects the interval under the pointer. Touch: drag or tap reads, tap on the strip selects. */
function bindRideChart() {
  const wrap = $('#rd-wrap');
  if (!wrap) return;
  const tAt = (clientX) => { const r = wrap.getBoundingClientRect(); return rd.geo ? ((clientX - r.left) / rd.geo.PW) * rd.geo.T : null; };
  const mouse = (e) => e.pointerType === 'mouse' || e.pointerType === 'pen';
  wrap.addEventListener('pointermove', (e) => { if (mouse(e)) rideCrosshair(tAt(e.clientX)); });
  wrap.addEventListener('pointerleave', (e) => { if (mouse(e)) rideCrosshair(null); });
  const touch = (e) => { if (e.touches.length === 1) rideCrosshair(tAt(e.touches[0].clientX)); };
  wrap.addEventListener('touchstart', touch, { passive: true });
  wrap.addEventListener('touchmove', touch, { passive: true });
  // click works in Bluefy too (its web view doesn't always send pointer events for taps on non-buttons)
  wrap.addEventListener('click', (/** @type {ElementEvent} */ e) => {
    const strip = /** @type {SVGElement} */ (e.target.closest('.rd-strip [data-i]'));
    if (strip) return selectRideSeg(+strip.dataset.i);
    const t = tAt(e.clientX);
    if (!canHover.matches) return rideCrosshair(t);
    const s = rd.segs.find((x) => t >= x.start && t < x.end);
    if (s) selectRideSeg(s.i);
  });
}

/** Controller / keyboard on the ride page: what = back | select | prev | next | up | down (js/controls.js page*). */
function rideAction(what) {
  const step = (d) => {
    const i = stepSeg(rd.segs.filter((s) => s.res).map((s) => s.i), rd.sel, d);
    if (i != null && i !== rd.sel) selectRideSeg(i, true); // same one at an end: stay (selectRideSeg would toggle it off)
  };
  switch (what) {
    case 'back': if (rd.sel != null) selectRideSeg(null); else closeRide(); break;
    case 'select': if (rd.done) closeRide(); break;
    case 'prev': step(-1); break;
    case 'next': step(+1); break;
    case 'up': window.scrollBy({ top: -240, behavior: 'smooth' }); break;
    case 'down': window.scrollBy({ top: 240, behavior: 'smooth' }); break;
  }
}

$('#rd').addEventListener('click', async (/** @type {ElementEvent} */ e) => {
  const b = /** @type {HTMLElement} */ (e.target.closest('[data-rd]'));
  if (b) {
    const a = b.dataset.rd;
    if (a === 'back' || a === 'done') closeRide();
    else if (a === 'discard') doneDiscard();
    else if (a === 'setftp' || a === 'keepftp') doneFtp(a === 'setftp');
    else if (a === 'clear') selectRideSeg(null);
    else if (a === 'fit') {
      const st = rd.doc.summary;
      downloadFit(rd.local || { id: Date.parse(st.start), name: st.name, samples: samplesFromDoc(rd.doc), laps: rd.doc.laps, summary: st });
    } else if (a === 'delete' && rd.doc) {
      const st = rd.doc.summary;
      deleteRideEverywhere({ id: rd.id, local: rd.local, demo: !!(rd.local?.demo || st.source === 'demo'), title: 'Delete this ride?', ok: 'Delete', said: 'Ride deleted' });
    }
    return;
  }
  const tr = /** @type {HTMLElement} */ (e.target.closest('#rd-ints tr[data-i]'));
  if (tr) selectRideSeg(+tr.dataset.i, true);
});
// phone: a tap outside the chart puts the reading away
document.addEventListener('touchstart', (/** @type {import('./types.js').ElementEvent<TouchEvent>} */ e) => { if (app.screen === 'ridepage' && rd.t != null && !e.target.closest('#rd-wrap')) rideCrosshair(null); }, { passive: true });
let rdResize = 0;
window.addEventListener('resize', () => { if (app.screen !== 'ridepage') return; cancelAnimationFrame(rdResize); rdResize = requestAnimationFrame(drawRideChart); });

// ---- actions (controller + keyboard), hold to confirm, the keyboard listener, home focus: js/controls.js
// (initControls() sits next to initToday(): it needs TABS)

// ---- the desktop ride screen (tiles, interval card, Next card, interval list, chart, slope roads, workout messages,
// the ramp test takeover): js/ride.js. The phone ride screen: js/ridephone.js.
function show(name) {
  app.screen = name;
  rideClock(name === 'ride');
  if ($('#devpop').classList.contains('on-ride')) setDevPop(false); // don't carry a pause-screen popover into the next screen
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
  if (name === 'home') { renderDevices(); applyFocus(); }
  syncMusic(); // title music: quiet on the ride screen, back everywhere else
}
initRide({ app, isPhone, renderPhone, setDevPop, look: rideLook, zoneHex, gradeHex, setZc, NUM_FONT });

// ------------------------------------------------------------------ phone ride screen (Zwift Companion style)
// Keep this query identical to the phone @media rule in css/app.css.
const PHONE_MQ = matchMedia('(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 520px)');
function isPhone() { return PHONE_MQ.matches; }
initRidePhone({ app, isPhone, look: rideLook, zoneHex, gradeHex, setZc, setTheme, NUM_FONT });
PHONE_MQ.addEventListener('change', () => { if (app.screen === 'ride') { sizeChart(); sizePhoneChart(); renderRide(); } });
PHONE_MQ.addEventListener('change', () => { if (app.screen === 'ridepage' && rd.doc) renderRidePage(); });

// ---- the phone ride screen (hero, gauge, boxes, Next line, chart or list, buttons and the ··· sheet): js/ridephone.js

// ---- workout messages and the ramp test coach (takeover): js/ride.js

// ------------------------------------------------------------------ modal
// In-app replacement for alert()/confirm(), which open as browser windows.
// ask() resolves true (OK) or false (Cancel, Esc, controller B, tap outside).
// tell() is the one-button version. Never use alert/confirm/prompt in this app.
// `body` = extra HTML under the text (the bike check's tiles), `nav(a)` = its own controller handling
// (return true when it used the action), `wide` = a wider box.
let modalDone = null, modalFocus = 0, modalNav = null;
const modalOpen = () => !!modalDone;
const modalBtns = () => $$('#modal .modal-btns button:not(.hidden)');
function ask(text, { title = '', ok = 'OK', cancel = 'Cancel', danger = false, body = '', nav = null, wide = false } = {}) {
  modalDone?.(false);
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text;
  $('#modal-text').classList.toggle('hidden', !text);
  $('#modal-body').innerHTML = body;
  $('#modal-body').classList.toggle('hidden', !body);
  $('#modal .modal-box').classList.toggle('wide', wide);
  modalNav = nav;
  $('#modal-ok').textContent = ok;
  $('#modal-cancel').textContent = cancel || '';
  $('#modal-cancel').classList.toggle('hidden', !cancel);
  $('#modal').classList.remove('hidden');
  // destructive questions start on Cancel so a stray A / Enter is harmless
  modalFocus = danger && cancel ? 0 : modalBtns().length - 1;
  setModalFocus();
  return new Promise((resolve) => {
    modalDone = (v) => { modalDone = null; modalNav = null; $('#modal').classList.add('hidden'); $$('#modal .focus').forEach((x) => x.classList.remove('focus')); resolve(v); };
  });
}
const tell = (text, title = '') => ask(text, { title, cancel: null });
function setModalFocus() {
  const btns = modalBtns();
  btns.forEach((b, i) => b.classList.toggle('focus', i === modalFocus && !!app.usedNav));
  btns[modalFocus]?.focus({ preventScroll: true });
}
/** Controller / keyboard in the modal: what = first | last | press | cancel | null (js/controls.js modal*); a = the verb. */
function modalAction(what, a) {
  app.usedNav = true; // keyboard or controller: show which button A / Enter will press
  if (modalNav?.(a)) return;
  const btns = modalBtns();
  switch (what) {
    case 'first': modalFocus = 0; setModalFocus(); break;
    case 'last': modalFocus = btns.length - 1; setModalFocus(); break;
    case 'press': (/** @type {HTMLElement} */ (btns.includes(/** @type {HTMLElement} */ (document.activeElement)) ? document.activeElement : btns[modalFocus]))?.click(); break;
    case 'cancel': modalDone?.(btns.length < 2); break;
  }
}
$('#modal-ok').onclick = () => modalDone?.(true);
$('#modal-cancel').onclick = () => modalDone?.(false);
$('#modal').addEventListener('click', (/** @type {ElementEvent} */ e) => { if (e.target.id === 'modal') modalDone?.(modalBtns().length < 2); });

// ---- garage and gearing (the #garage popup, Bikes | Gearing): js/garage.js
initGarage({ app, numField, saveSettings, ask, syncClient, setDevPop });

// ------------------------------------------------------------------ controls (own panel, top-bar gamepad)
function renderControls() {
  const d = dtSpec(), one = !d.seq && d.rings.length === 1;
  const style = shiftStyleFor(app.settings.shiftStyle, one);
  const rear = { sram: 'Left side / right side', shimano: 'Right shift-down / shift-up', right: 'Right shift-down / right shift-up or paddle', left: 'Left shift-down / left shift-up or paddle' }[style];
  const front = { sram: 'Left + right together', shimano: 'Left shift-up / shift-down', right: 'None (1x)', left: 'None (1x)' }[style];
  const name = { sram: 'SRAM 2x', shimano: 'Shimano 2x', right: '1x, shifter on the right', left: '1x, shifter on the left' }[style];
  const rows = [
    ['Riding'],
    ['Start / pause', 'A', 'Space'],
    ['End ride (hold 5 s)', 'Hold B', 'Hold Esc'],
    ['Skip interval (hold 3 s)', 'Hold Y', 'Hold S'],
    ['Lap (free ride; workouts lap every interval)', 'Z', 'L'],
    ['Slope'],
    ['Rear: easier / harder', rear, '&larr; / &rarr;'],
    ['Front shift (2x)', front, 'F'],
    ['Grade &plusmn;1%', 'D-pad up / down', '&uarr; / &darr;'],
    ['ERG'],
    ['Effort &plusmn;1% (hold to repeat)', 'Left shifters &minus; / right shifters + (also D-pad)', '&larr; / &rarr; or &darr; / &uarr;'],
    ['ERG off / back on (stays off until you turn it on)', 'ERG off button on screen', 'E'],
    ['Menus'],
    ['Move / select / back', 'D-pad / A / B', '&uarr;&darr; / Enter / Esc'],
    ['Switch home tabs', 'D-pad left / right', '&larr; / &rarr;'],
  ];
  $('#controls-body').innerHTML =
    `<p class="muted ctl-style">Shifting: ${name}, from the gearing in use (${esc(gearingName(app.settings))}). <a href="#" data-open-gearing>Change</a></p>
     <table class="keys"><tr><th></th><th>Zwift Ride</th><th>Keyboard</th></tr>${rows.map(([a, b, c]) => b === undefined
      ? `<tr class="keys-group"><td colspan="3">${a}</td></tr>`
      : `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join('')}</table>`;
}

// ------------------------------------------------------------------ wiring
$$('[data-connect]').forEach((b) => (b.onclick = () => connect(b.dataset.connect)));
$('#btn-demo').onclick = enterDemo;
$('#btn-devices').onclick = (e) => { e.stopPropagation(); setDevPop(!devPopOpen()); };
$('#devpop-close').onclick = () => setDevPop(false);
// click anywhere outside closes it (the Bluetooth chooser is browser chrome, so it doesn't count as outside)
document.addEventListener('click', (/** @type {ElementEvent} */ e) => { if (devPopOpen() && !e.target.closest('#devpop, #btn-devices, #pz-devices, #modal')) setDevPop(false); });
// pause screen of a ride: the same panels as the home top bar
$('#pz-devices').onclick = (e) => { e.stopPropagation(); setDevPop(!(devPopOpen() && $('#devpop').classList.contains('on-ride')), 'ride'); };
$('#pz-controls').onclick = () => $('#btn-controls').click();
$('#pz-bike').onclick = () => openGarage('bikes');
$('#pz-gearing').onclick = () => openGearing();
$('#pz-settings').onclick = () => $('#btn-settings').click();
// ---- Workouts library: js/library.js
initLibrary({ app, view: libView, saveSettings, refreshPlanViews, startWorkout, focusables, applyFocus, signedIn });
initBuilder({
  ask, zoneHex, gradeHex, plannedOn, signedIn,
  ftp: () => app.settings.ftp,
  maxMinutes: () => app.plan?.maxMinutes || 0,
  onSave: saveMine,
  onDelete: deleteMine,
  onRide: (id) => { const w = app.library.find((x) => x.id === id); if (w) startWorkout(w); },
});
$('#btn-new-wo').onclick = () => { setDevPop(false); if (signedIn()) openBuilder(null); };
if (inkObserver) { inkObserver.observe($('#wo-kind')); inkObserver.observe($('#tabs')); }
placeInk($('#tabs'), $('#tabs button.active'));
// "Settings" links in notices open the panel (the top-bar button is just a gear)
document.addEventListener('click', (/** @type {ElementEvent} */ e) => {
  if (!e.target.closest('[data-open-gearing]')) return;
  e.preventDefault();
  openGearing();
});
document.addEventListener('click', (/** @type {ElementEvent} */ e) => {
  if (!e.target.closest('[data-open-garage]')) return;
  e.preventDefault();
  $$('.panel').forEach((p) => p.classList.add('hidden'));
  $('#btn-garage').click();
});
// ---- Training tab: js/training.js
initTraining({ app, look: chartLook, trainingRows, syncClient, dataRepo, syncHint, syncPending, whoopDay, recZone, openRide, downloadFit });
// ---- Settings panel (Rider / Ride / Road feel / Trainer / Sync): js/settings.js
/**
 * Settings changed what other screens show: who is signed in, the token or data repo (Mine workouts, the plan and its source
 * line on Today), or rides imported into the history. Settings calls only this, so it doesn't know which screens exist.
 */
function refreshAfterSettings() {
  if (!signedIn()) closeBuilderNow(); // Mine workouts need rodillo-data
  renderHero(); // the plan source line, right away
  applyLibrary(); // the library (Mine), then Today, Next days and Calendar through refreshPlanViews()
  if (app.tab === 'training') renderTraining();
}

// ---- leaving rodillo-data on this browser (Sign out, or the token cleared): nothing private stays behind
// Everything that came from rodillo-data or is the rider's own: ride history, the coach's plan and workouts, Mine,
// WHOOP, settings (they live in the plan and come back on the next sign-in), bike photos, ride files.
const PRIVATE_KEYS = ['remoteIndex', 'remoteIndexAt', 'coachPlan', 'coachWorkouts', 'mineDoc', 'minePending', 'whoop',
  'settingsBase', 'settingsPending', 'pendingDeletes', 'garagePhotos'];
/** What this browser has that never reached rodillo-data, as words for the question ('' = nothing). */
async function unsentHere() {
  let n = 0;
  try { n = (await rides.list()).filter((r) => !r.demo && !r.synced && (r.status === 'done' || r.status === 'inprogress')).length; } catch { /* no idb */ }
  const parts = [n && `${n} ride${n > 1 ? 's' : ''}`, Object.keys(ls.get('settingsPending', {})).length && 'settings changes',
    Object.keys(ls.get('minePending', {})).length && 'workout edits'].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
}
/**
 * Called by Settings before it signs out or clears the token. `keepsAccess` = another way in stays (a token after
 * GitHub sign-out, or the reverse): then nothing is wiped. Otherwise sends what's pending, asks before deleting
 * anything that still didn't make it, runs `revoke`, and wipes this browser. False = the rider cancelled.
 */
async function leaveData(revoke, keepsAccess) {
  if (keepsAccess) { revoke(); refreshAfterSettings(); return true; }
  const gh = syncClient();
  if (gh) { await syncPending(); await flushSettings(gh); await flushMine(gh); }
  const left = await unsentHere();
  if (left && !(await ask(`${left} on this browser haven't reached rodillo-data yet. Signing out deletes them from here.`,
    { title: 'Sign out anyway?', ok: 'Sign out and delete', danger: true }))) return false;
  revoke();
  await forgetHere();
  refreshAfterSettings();
  return true;
}
async function forgetHere() {
  for (const k of PRIVATE_KEYS) localStorage.removeItem(`rodillo.${k}`);
  try { await rides.clear(); await docs.clear(); } catch (e) { logMsg('app', `could not clear rides: ${e.message}`); }
  Object.assign(app, { coachPlan: null, coachWorkouts: [], mineDoc: null, whoop: null, rows: [], coachError: null, coachNoRepo: null });
  forgetBikePhotos();
  if (!(app.session && !app.session.finished)) { // mid-ride the ride keeps its settings; the next load starts clean
    app.settings = { ...DEFAULT_SETTINGS };
    ls.set('settings', app.settings);
  }
  logMsg('sync', 'signed out: private data removed from this browser');
}
initSettings({ app, saveSettings, ask, tell, setDevPop, dataRepo, syncClient, syncHint, loadCoachData, syncPending, refreshAfterSettings, leaveData });
initMusic({ app, makeAudio: () => new AudioContext() });
initCountdown({ app, makeAudio: () => new AudioContext() });
// tap sounds on the home screens, phone haptics (js/sound.js); ?hx=1 = the iPhone label overlays, for the smoke test
initSound({ app, makeAudio: () => new AudioContext({ latencyHint: 'interactive' }), isPhone, forceSwitch: /[?&]hx=1\b/.test(location.search) });
$('#btn-garage').innerHTML = BIKE_ICO; // the same bicycle as the Free ride button
$('#btn-garage').onclick = () => openGarage('bikes');
$('#btn-controls').onclick = () => {
  setDevPop(false);
  $('#settings').classList.add('hidden');
  $('#garage').classList.add('hidden');
  renderControls();
  $('#controls').classList.remove('hidden');
};
// ------------------------------------------------------------------ theme (light default, dark optional; index.html sets it before first paint)
function setTheme(t) {
  app.theme = t === 'dark' ? 'dark' : 'light';
  ls.set('theme', app.theme);
  document.documentElement.dataset.theme = app.theme;
  /** @type {HTMLMetaElement} */ (document.querySelector('meta[name="theme-color"]')).content = app.theme === 'dark' ? '#0c0e0d' : '#e6e9e5';
  const label = app.theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('#btn-theme').title = `Switch to ${label.toLowerCase()}`;
  $('#btn-theme').setAttribute('aria-label', label);
  $('#r-theme').title = `Switch to ${label.toLowerCase()}`;
  $('#r-theme').setAttribute('aria-label', label);
  $('#rp-theme').textContent = label;
  readTokens();
  if (app.tab === 'training') renderTraining();
  if (app.screen === 'ride') renderRide();
  if (app.screen === 'ridepage') drawRideChart();
}
setTheme(ls.get('theme', 'light'));
$('#btn-theme').onclick = $('#r-theme').onclick = () => setTheme(app.theme === 'dark' ? 'light' : 'dark');
$('#btn-log').onclick = () => { setDevPop(false); $('#log-body').textContent = logLines.join('\n'); $('#log').classList.remove('hidden'); };
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('.panel').classList.add('hidden')));
// scrim: shown while any side panel is open; a click closes it (the builder has unsaved work, so only its Close does)
const syncScrim = () => $('#scrim').classList.toggle('hidden', !$$('.panel').some((p) => !p.classList.contains('hidden')));
const scrimObs = new MutationObserver(syncScrim);
$$('.panel').forEach((p) => scrimObs.observe(p, { attributes: true, attributeFilter: ['class'] }));
$('#scrim').onclick = () => { if (!builderOpen()) $$('.panel').forEach((p) => p.classList.add('hidden')); };
$('#btn-diag').onclick = async () => {
  for (const d of /** @type {import('./ble/base.js').BleDevice[]} */ ([app.trainer, app.hr, ...app.controllers])) {
    if (!d?.listServices || d.state !== 'connected') continue;
    logMsg(d.kind, `${d.name} ${JSON.stringify(d.info)} services: ${(await d.listServices()).join(', ')}`);
  }
  if (app.trainer?.data) logMsg('trainer', `last data ${JSON.stringify(app.trainer.data)}`);
};
// Four screens behind one nav (UX roadmap item 4, Nov 12): Today (hero, overview, Next days) and the three sections.
// #home[data-tab] decides what shows; css hides the rest.
const TABS = ['today', 'workouts', 'calendar', 'training'];
function setTab(t) {
  const prev = app.tab;
  app.tab = t; app.focus = 0;
  $('#home').dataset.tab = t;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${t}`));
  placeInk($('#tabs'), $('#tabs button.active'));
  if (prev && prev !== t) {
    window.scrollTo(0, 0);
    slideIn(t === 'today' ? $('#today') : $(`#tab-${t}`), TABS.indexOf(t) > TABS.indexOf(prev) ? 1 : -1);
  }
  if (t === 'training') { renderTraining(); refreshRemoteIndex(); }
  if (t === 'calendar') { renderCalendar(); refreshPlanViews(); }
  applyFocus();
}
$$('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
// ---- Today + Calendar (overview, hero, Next days, calendar): js/today.js
initToday({ app, view: todayView, isPhone, syncClient, syncHint, startFree, startWorkout, openRide, setTab });
// ---- controller and keyboard (action(), Ride buttons, hold to confirm, keys, home focus): js/controls.js
initControls({ app, modalOpen, devPopOpen, setDevPop, setTab, TABS, startWorkout, rideAction, modalAction, renderRide, tooShort, endSession });
$('#r-pause').onclick = () => { app.session?.togglePause(); renderRide(); };
$('#r-end').onclick = async () => {
  const short = tooShort();
  if (await ask(short ? 'Less than 10 seconds recorded. Nothing will be saved.' : '', { title: 'End this ride?', ok: 'End ride', danger: short })) endSession();
};

// main loop: 4 Hz engine, render
let last = performance.now(), saveAcc = 0;
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(1, (now - last) / 1000);
  last = now;
  if (app.demo) { /** @type {SimTrainer} */ (app.trainer).step(); /** @type {SimHr} */ (app.hr).step(dt); }
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
{
  // Back from GitHub sign-in: open Settings on Sync so the result is visible, then sync as usual below.
  const back = takeSignIn();
  if (back) {
    ls.set('setTab', 'sync');
    $('#btn-settings').click();
    renderSignIn(back.error || 'Connected');
    if (back.error) logMsg('sync', `sign-in failed: ${back.error}`);
  }
}
renderDevices();
loadLibrary();
autoReconnect();
syncPending();
/** @type {Window & { rodillo?: object }} */ (window).rodillo = app; // for debugging from the console
