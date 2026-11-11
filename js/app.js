import { Trainer } from './ble/trainer.js?v=202611102147';
import { HeartRate } from './ble/hr.js?v=202611102147';
import { ZwiftRide } from './ble/zwiftride.js?v=202611102147';
import { SimTrainer, SimHr } from './ble/sim.js?v=202611102147';
import { log, logMsg } from './ble/base.js?v=202611102147';
import { Session, DEFAULT_SETTINGS } from './engine/session.js?v=202611102147';
import { DRIVETRAINS, WHEELS, CUSTOM, parseTeeth, checkSpec, presetFor, speeds } from './engine/drivetrain.js?v=202611102147';
import { TRAINERS, CUSTOM_TRAINER, matchTrainer, trainerFor, trainerFits, cleanRange } from './engine/trainers.js?v=202611102147';
import { flatten, totalDuration, estimateTSS, parseZwo, segTarget, isTrack, track, trackDist, trackHeight, trackClimbed, climbAhead } from './engine/workout.js?v=202611102147';
import { withDetail, defaultDetail, detailLabel, clampDetail, DETAIL_MIN, DETAIL_MAX } from './engine/climb.js?v=202611102147';
import { encodeActivity } from './fit.js?v=202611102147';
import { buildRide, loadSeries, weekly, powerCurve, ftpEstimate, ftpFromRide, formLabel, zoneTotals, CURVE_DURS } from './stats.js?v=202611102147';
import { stepCue, resultCue, bestAvg } from './testcoach.js?v=202611102147';
import { ZONES, zoneOf, zoneRange } from './zones.js?v=202611102147';
import { GitHubSync, DEFAULT_REPO, PLAN_PATH, WORKOUTS_PATH } from './sync.js?v=202611102147';
import { reconcile, applyPending } from './settings-sync.js?v=202611102147';
import { ls, rides, docs } from './store.js?v=202611102147';
import { rideSegs, pageHtml, chartSvg, tipHtml, selHtml, samplesFromDoc } from './ridepage.js?v=202611102147';
import { MINE_PATH, emptyMine, applyMinePending, mineView } from './mine.js?v=202611102147';
import { initBuilder, openBuilder, builderOpen, closeBuilder } from './builder.js?v=202611102147';
import { authEnabled, authSession, authToken, startSignIn, takeSignIn, signOut } from './auth.js?v=202611102147';

const BUILD = new URL(import.meta.url).searchParams.get('v') || 'dev';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const ZC = { z1: '#a3a9ae', z2: '#2d7ff9', z3: '#1fa855', z4: '#f4be1a', z5: '#f47b20', z6: '#e23b44' }; // keep in sync with --z1..--z6 in app.css
// Canvas/SVG drawing colors, read from the CSS tokens so they follow the light/dark theme.
let INK, MUTED, RULE, FAINT, FTP_LINE, UNDERLAY, HR_LINE, TOK = {};
function readTokens() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  [INK, MUTED, RULE, FAINT, FTP_LINE, UNDERLAY, HR_LINE] = ['--ink', '--muted', '--rule', '--faint', '--ftp-line', '--underlay', '--hr-line'].map(v);
  // the ride page chart (js/ridepage.js) takes its colors as one object
  TOK = { ink: INK, rule: RULE, faint: FAINT, ftp: FTP_LINE, hr: HR_LINE, info: v('--info'), infoLine: v('--info-line'), band: v('--sheet2'), dim: v('--dim'), sheet: v('--sheet') };
}
readTokens();
const NUM_FONT = 'Archivo, system-ui, sans-serif';
const zoneHex = (f) => ZC[ZONES[zoneOf(f)].color]; // Coggan zones from zones.js
const gradeHex = (g) => g < 0 ? '#3fa596' : g < 0.03 ? '#6f8fbf' : g < 0.06 ? '#d2a531' : g < 0.09 ? '#e27a35' : '#d9434b';

// ------------------------------------------------------------------ state
const app = {
  settings: { ...DEFAULT_SETTINGS, ...ls.get('settings', {}) },
  trainer: null, hr: null, controllers: [],
  demo: false,
  library: [], plan: null,
  session: null, rideId: null,
  screen: 'home', tab: 'workouts', focus: 0, woKind: ls.get('woKind', 'erg'),
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
    if (e.name !== 'NotFoundError') { logMsg('app', e.message); tell(e.message, 'Could not connect'); }
  }
  renderDevices();
}

function bindDevice(d) {
  if (d._bound) return;
  d._bound = true;
  d.on('state', renderDevices);
  d.on('battery', renderDevices);
  if (d.kind === 'trainer') d.on('state', (st) => { if (st === 'connected') detectTrainer(d); });
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
  // status dots on the top-bar link button
  const dotState = (d) => (app.demo && d ? 'on' : d?.state === 'connected' ? 'on' : d?.state === 'connecting' ? 'wait' : '');
  const states = { trainer: dotState(app.trainer), hr: dotState(app.hr), controller: anyCtl ? 'on' : app.controllers.some((c) => c.state === 'connecting') ? 'wait' : '' };
  $$('#btn-devices .ldots i').forEach((i) => { i.className = states[i.dataset.k]; });
  const n = Object.values(states).filter((v) => v === 'on').length;
  $('#btn-devices').title = `Bluetooth connections (${n} of 3 connected)`;
  renderRideStatus();
}

// connections popover
function setDevPop(open) {
  $('#devpop').classList.toggle('hidden', !open);
  $('#btn-devices').setAttribute('aria-expanded', String(open));
}
const devPopOpen = () => !$('#devpop').classList.contains('hidden');

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
    app.coachPlan = p?.json || null;
    app.coachWorkouts = w?.json?.workouts || [];
    app.mineDoc = m?.json || emptyMine();
    ls.set('mineDoc', app.mineDoc);
    reconcileSettings();
    await flushSettings(gh);
    ls.set('coachPlan', app.coachPlan);
    ls.set('coachWorkouts', app.coachWorkouts);
    app.coachError = null;
    applyLibrary();
    flushMine(gh);
  } catch (e) {
    app.coachError = e.message;
    logMsg('coach', `could not load coach data: ${e.message}`);
    renderWeek();
  }
}

/**
 * Settings are shared by every device through the plan (see settings-sync.js): FTP as plan.ftp (the
 * morning coach writes it after a ramp test), everything else under plan.settings. Newest change wins,
 * per setting. Sign-in and theme stay per device (stored outside settings).
 */
function reconcileSettings(source = 'settings') {
  const r = reconcile({ plan: app.coachPlan, settings: app.settings, base: ls.get('settingsBase', null), pending: ls.get('settingsPending', {}), defaults: DEFAULT_SETTINGS, source });
  app.settings = r.settings;
  ls.set('settings', app.settings);
  ls.set('settingsBase', r.base);
  ls.set('settingsPending', r.pending);
  if (r.adopted.length) logMsg('coach', `settings from the plan: ${r.adopted.map((k) => `${k} ${JSON.stringify(app.settings[k])}`).join(', ')}`);
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
  return Object.entries(app.plan?.days || {}).filter(([d, x]) => d >= today && x === id).map(([d]) => new Date(`${d}T12:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
}

function applyLibrary() {
  const custom = new Map((app.coachWorkouts || []).map((w) => [w.id, { ...w, _source: 'coach' }]));
  const lib = (app.baseLibrary || []).map((w) => custom.get(w.id) || w);
  for (const [id, w] of custom) if (!lib.some((x) => x.id === id)) lib.push(w);
  for (const w of ls.get('imported', [])) lib.push(w);
  // Agustín's own workouts (builder) are private: only with access to rodillo-data (GitHub sign-in or token).
  const mine = !signedIn() ? [] : mineView(app.mineDoc, ls.get('minePending', {})).map((w) => ({ ...w, _source: 'mine' }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  app.plan = app.coachPlan || app.basePlan || null;
  reconcileSettings();
  app.library = [...mine, ...lib].map(cutClimb); // newest edit first; real climbs cut at the rider's detail
  renderLibrary();
  refreshPlanViews();
}

// ------------------------------------------------------------------ real climbs: detail slider
// A climb workout carries its full elevation profile (js/engine/climb.js); the open row in the Slope list has a
// Detail slider (right = finer stretches) and a Default button. The choice is saved per climb in
// settings.climbDetail and syncs like every other setting (Nov 11, asked for by Agustín).
const climbLevel = (w) => clampDetail(app.settings.climbDetail?.[w.id] ?? defaultDetail(w));
const cutClimb = (w) => (w.profile ? withDetail(w, climbLevel(w)) : w);
const sliderOf = (lv) => DETAIL_MAX + DETAIL_MIN - lv; // slider value grows with detail, levels grow with stretch length
const climbSteps = (w) => w.steps.length - (w.profile?.lead?.length || 0);
const detailText = (w) => `${detailLabel(w.profile, w.detail)} &middot; ${climbSteps(w)} steps`;

function detailRow(w, i) {
  if (!w.profile) return '';
  return `<div class="wo-detail">
    <label for="det-${i}">Detail</label>
    <input type="range" id="det-${i}" data-detail="${i}" min="${DETAIL_MIN}" max="${DETAIL_MAX}" step="1" value="${sliderOf(w.detail)}" tabindex="-1" aria-describedby="detv-${i}">
    <span class="wo-det-v" id="detv-${i}">${detailText(w)}</span>
    <button class="ghost small" data-detdef="${i}" tabindex="-1"${w.detail === defaultDetail(w) ? ' hidden' : ''}>Default</button>
  </div>`;
}

/** Re-cut one climb in the library and redraw its row; commit = save the choice and refresh the plan views. */
function setClimbDetail(i, lv, commit) {
  const w = withDetail(app.library[i], lv);
  app.library[i] = w;
  const card = document.querySelector(`.wo[data-i="${i}"]`);
  if (card) {
    const mini = card.querySelector(':scope > .profile');
    if (mini) mini.outerHTML = profileSvg(w);
    card.querySelector('.wo-meta').innerHTML = woMeta(w);
    const old = card.querySelector('.wo-prof');
    if (old) {
      const box = document.createElement('div');
      box.className = 'wo-prof prof-hover';
      box.innerHTML = profileSvg(w, 1000, 100);
      old.replaceWith(box);
      if (card.classList.contains('expanded')) { card.dataset.prof = '1'; bindProfileHover(box, w); } else delete card.dataset.prof;
    }
    card.querySelector('.wo-det-v').innerHTML = detailText(w);
    card.querySelector('.wo-detail input').value = sliderOf(w.detail);
    card.querySelector('[data-detdef]').hidden = w.detail === defaultDetail(w);
  }
  if (!commit) return;
  const cd = { ...(app.settings.climbDetail || {}) };
  if (w.detail === defaultDetail(w)) delete cd[w.id]; else cd[w.id] = w.detail;
  app.settings.climbDetail = cd;
  ls.set('settings', app.settings);
  saveSettings();
  refreshPlanViews();
}

function bindDetailSliders() {
  $$('.wo-detail input').forEach((inp) => {
    const i = +inp.dataset.detail, lv = () => sliderOf(+inp.value);
    inp.addEventListener('input', () => setClimbDetail(i, lv(), false));
    inp.addEventListener('change', () => setClimbDetail(i, lv(), true));
  });
  $$('[data-detdef]').forEach((b) => b.addEventListener('click', () => setClimbDetail(+b.dataset.detdef, defaultDetail(app.library[+b.dataset.detdef]), true)));
}

// Elevation profiles are at least this tall in metres, so a flat ride looks flat instead of filling the chart.
const ELEV_MIN = 60;
const ascentText = (m) => `+${Math.round(m / 5) * 5} m`;

/** Slope-only workouts: elevation over distance, each stretch filled with its grade color, an ink line on top. */
function trackSvg(segs, width, height) {
  const tr = track(segs), rng = Math.max(tr.hi - tr.lo, ELEV_MIN);
  const top = height * 0.06, floor = height * 0.14; // floor: the lowest stretch still shows a band (and stays tappable)
  const X = (d) => +((d / tr.D) * width).toFixed(1);
  const Y = (h) => +(top + (1 - (h - tr.lo) / rng) * (height - top - floor)).toFixed(1);
  let out = '';
  segs.forEach((g, i) => {
    const p = tr.parts[i], x0 = X(p.d0), x1 = X(p.d1) + 0.3; // 0.3: no hairline gaps between stretches
    out += `<polygon data-i="${i}" points="${x0},${height} ${x0},${Y(p.h0)} ${x1},${Y(p.h1)} ${x1},${height}" fill="${gradeHex(g.grade)}" opacity=".9"/>`;
  });
  out += `<polyline class="prof-line" points="${tr.parts.map((p) => `${X(p.d0)},${Y(p.h0)}`).join(' ')} ${width},${Y(tr.parts.at(-1).h1)}"/>`;
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${out}</svg>`;
}

function profileSvg(w, width = 340, height = 54) {
  const segs = flatten(w, app.settings.ftp);
  if (isTrack(segs)) return trackSvg(segs, width, height);
  const T = segs.length ? segs[segs.length - 1].end : 1;
  const maxF = 1.5;
  let out = '';
  segs.forEach((s, i) => {
    const x = (s.start / T) * width, wd = Math.max(0.5, (s.dur / T) * width);
    if (s.kind === 'erg') {
      const y0 = height - (Math.min(s.from, maxF) / maxF) * height, y1 = height - (Math.min(s.to, maxF) / maxF) * height;
      out += `<polygon data-i="${i}" points="${x},${height} ${x},${y0} ${x + wd},${y1} ${x + wd},${height}" fill="${zoneHex((s.from + s.to) / 2)}" opacity=".9"/>`;
    } else {
      const g = s.grade;
      const h = Math.max(4, ((g + 0.03) / 0.15) * height);
      out += `<rect data-i="${i}" x="${x}" y="${height - h}" width="${wd}" height="${h}" fill="${gradeHex(g)}" opacity=".9"/>`;
    }
  });
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${out}</svg>`;
}

const isSim = (w) => flatten(w).some((s) => s.kind === 'sim');
function woMeta(w) {
  const segs = flatten(w);
  const dist = segs.filter((x) => x.dist).reduce((a, x) => a + x.dist, 0);
  const mins = Math.round(totalDuration(w) / 60);
  if (isTrack(segs)) return `${dist ? '~' : ''}${mins} min &middot; ${ascentText(track(segs).ascent)}`; // short: library meta column
  if (dist) return `~${mins} min &middot; ${+(dist / 1000).toFixed(1)} km`; // short: must fit the library's meta column
  const tss = estimateTSS(w);
  return `${mins} min${isSim(w) ? '' : ` &middot; TSS ~${tss}`}`;
}

const isSlopeOnly = (w) => flatten(w).every((x) => x.kind === 'sim');

// Not shown as chips: 'sim' has its own chip; weekday tags are leftovers from old plans (the calendar says when).
const HIDDEN_TAGS = new Set(['sim', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
function workoutCard(w, i) {
  return `
    <div class="wo" data-i="${i}" tabindex="0">
      <div class="wo-top"><div class="wo-name">${esc(w.name)}${w._source === 'coach' ? ' <span class="tag coach">coach</span>' : ''}</div><div class="wo-meta">${woMeta(w)}</div></div>
      ${profileSvg(w)}
      <div class="wo-more"><div class="wo-more-in">
        <div class="wo-tags">${(w.tags || []).filter((t) => !HIDDEN_TAGS.has(t)).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <div class="wo-desc">${esc(w.description)}</div>
        <div class="wo-prof prof-hover">${profileSvg(w, 1000, 100)}</div>
        ${detailRow(w, i)}
        <div class="start-row"><button class="primary small" data-start="${i}" tabindex="-1">Start</button>${w._source === 'mine' ? `<button class="ghost small" data-edit="${i}" tabindex="-1">Edit</button>` : signedIn() ? `<button class="ghost small" data-copy="${i}" tabindex="-1">Edit a copy</button>` : ''}${w.tags?.includes('imported') ? `<button class="ghost small" data-remove="${i}" tabindex="-1">Remove</button>` : ''}</div>
      </div></div>
    </div>`;
}

function renderLibrary() {
  const erg = [], slope = [], mine = [];
  app.library.forEach((w, i) => (w._source === 'mine' ? mine : isSlopeOnly(w) ? slope : erg).push(workoutCard(w, i)));
  $('#workout-list').innerHTML = erg.join('') || '<p class="muted empty-list">No ERG workouts yet.</p>';
  $('#slope-list').innerHTML = slope.join('') || '<p class="muted empty-list">No slope sessions yet.</p>';
  $('#mine-list').innerHTML = mine.join('') || '<p class="muted empty-list mine-empty">Nothing here yet. Build one with New workout, or open any workout and use Edit a copy.</p>';
  $('#kind-btn-mine').classList.toggle('hidden', !signedIn());
  setWoKind(app.woKind);
  bindDetailSliders();
  $$('.wo').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.dataset.start) return startWorkout(app.library[+e.target.dataset.start]);
    if (e.target.dataset.remove) return removeImported(app.library[+e.target.dataset.remove]);
    if (e.target.dataset.edit) return openBuilder(app.library[+e.target.dataset.edit], { mine: true });
    if (e.target.dataset.copy) return openBuilder(app.library[+e.target.dataset.copy]);
    if (e.target.closest('.wo-prof')) return; // the open chart has its own hover/tap readout
    if (e.target.closest('.wo-detail')) return; // detail slider and Default (own handlers)
    // One open row at a time (across the ERG and slope lists).
    const open = !c.classList.contains('expanded');
    $$('.wo.expanded').forEach((x) => { x.classList.remove('expanded'); x.querySelectorAll('.start-row button, .wo-detail input, .wo-detail button').forEach((b) => (b.tabIndex = -1)); });
    c.classList.toggle('expanded', open);
    if (open) c.querySelectorAll('.start-row button, .wo-detail input, .wo-detail button').forEach((b) => (b.tabIndex = 0));
    // Big chart with the same readout as the today hero; bound on first open (one document listener per chart).
    if (open && !c.dataset.prof) { c.dataset.prof = '1'; bindProfileHover(c.querySelector('.wo-prof'), app.library[+c.dataset.i]); }
  }));
  applyFocus();
}

/** Workouts tab: ERG and slope sessions share one list area, switched by a pill toggle. */
function setWoKind(k, animate = false) {
  const prev = app.woKind;
  app.woKind = k === 'slope' ? 'slope' : k === 'mine' && signedIn() ? 'mine' : 'erg';
  if (k !== 'mine' || app.woKind === 'mine') ls.set('woKind', app.woKind); // signed out: keep "mine" for next sign-in
  $$('#wo-kind button').forEach((b) => { const on = b.dataset.kind === app.woKind; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  for (const x of WO_KINDS) $(`#kind-${x}`).classList.toggle('hidden', app.woKind !== x);
  placeInk($('#wo-kind'), $('#wo-kind button.on'));
  if (animate && prev !== app.woKind) slideIn($(`#kind-${app.woKind}`), WO_KINDS.indexOf(app.woKind) > WO_KINDS.indexOf(prev) ? 1 : -1);
}
const WO_KINDS = ['erg', 'slope', 'mine'];

// ------------------------------------------------------------------ sliding indicators (ERG/Slope pill, tab underline)
/** Moves a container's indicator (CSS ::before/::after reading --ink-x/--ink-w) under the active element.
 *  The first placement and resizes jump; user switches slide (the .ink-ready class turns the transition on). */
function placeInk(box, el) {
  if (!box || !el || !el.offsetWidth) return;
  box.style.setProperty('--ink-x', `${el.offsetLeft}px`);
  box.style.setProperty('--ink-w', `${el.offsetWidth}px`);
  if (!box.classList.contains('ink-ready')) requestAnimationFrame(() => box.classList.add('ink-ready'));
}
const inkObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  for (const { target } of entries) {
    target.classList.remove('ink-ready'); // fonts loading, rotation, tab shown: jump, don't slide
    placeInk(target, target.querySelector('.on, .active'));
  }
}) : null;

/** Fades a newly shown pane in from the side it came from (dir 1 = from the right). */
function slideIn(el, dir) {
  if (!el) return;
  el.classList.remove('slide-in');
  el.style.setProperty('--from', `${dir * 14}px`);
  void el.offsetWidth; // restart the animation
  el.classList.add('slide-in');
}

// ------------------------------------------------------------------ rider overview (top of home)
const fmtHours = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

/** Recovery, this week's riding vs plan, fatigue/form, FTP. Uses the same numbers as the Training tab. */
function renderOverview() {
  const el = $('#overview');
  const real = (app.rows || []).filter((r) => !r.demo).map((r) => r.summary);
  const series = loadSeries(real, new Date(), 90);
  const t = series.at(-1) || { ctl: 0, atl: 0, tsb: 0 };
  const monday = mondayOf(new Date());
  const weekKeys = Array.from({ length: 7 }, (_, i) => dkey(addDays(monday, i)));
  const ridden = real.filter((r) => weekKeys.includes(r.id.slice(0, 10)));
  const doneSec = ridden.reduce((a, r) => a + (r.durSec || 0), 0);
  const weekTss = ridden.reduce((a, r) => a + (r.tss || 0), 0);
  // Planned = this week's plan workouts, optional days left out.
  const planned = weekKeys.map(dayInfo).filter((d) => d.workout && !d.optional);
  const planSec = planned.reduce((a, d) => a + totalDuration(d.workout), 0);
  const tile = (v, l, sub = '', info = '') => `<div class="stat">${info ? infoTip(info, l) : ''}<div class="v">${v}</div><div class="l"><b>${l}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div></div>`;

  // One slim row under the hero: value big, label + short context on one line.
  const w = whoopDay(dkey(new Date()));
  const rec = w?.recovery != null
    ? tile(`<span class="rz ${recZone(w.recovery)}">${w.recovery}%</span>`, 'Recovery', `${w.hrv ? `HRV ${Math.round(w.hrv)}` : ''}${w.sleepHours ? `<span class="wide-only">${w.hrv ? ' &middot; ' : ''}${w.sleepHours} h sleep</span>` : ''}`)
    : tile('-', 'Recovery', app.whoop ? 'not scored yet' : 'WHOOP off');
  const week = tile(`${fmtHours(doneSec)}${planSec ? ` <span class="of">/ ${fmtHours(planSec)}</span>` : ''}`, 'This week',
    `${ridden.length} ride${ridden.length === 1 ? '' : 's'}${weekTss ? ` &middot; ${weekTss} TSS` : ''}`);
  const tsb = Math.round(t.tsb);
  const fat = tile(`${tsb > 0 ? '+' : ''}${tsb}`, 'Form', `${formLabel(t.tsb).toLowerCase()}<span class="wide-only"> &middot; fitness ${Math.round(t.ctl)}</span>`,
    `${LOAD_INFO.tsb}<br><br>${LOAD_INFO.atl} Fatigue now: ${Math.round(t.atl)}.`);
  const est = ftpEstimate(real);
  const ftp = tile(`${app.settings.ftp} W`, 'FTP', `${(app.settings.ftp / (app.settings.riderKg || 77)).toFixed(1)} W/kg${est.fromRamp ? ` &middot; ramp ${est.fromRamp}` : ''}`);
  el.innerHTML = rec + week + fat + ftp;
}

// ------------------------------------------------------------------ plan: week carousel + calendar
const dkey = (d) => d.toLocaleDateString('en-CA');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

function workoutColor(w) {
  const segs = flatten(w);
  if (segs.every((x) => x.kind === 'sim')) return '#6f8fbf';
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
    note: app.plan?.notes?.[key] || '', ridden, done, optional: (app.plan?.optional || []).includes(key),
    isToday: key === dkey(new Date()), isPast: key < dkey(new Date()),
  };
}

function dayCardHtml(info) {
  const d = new Date(info.key + 'T12:00');
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
  return `<div class="day ${info.workout ? '' : 'nowo'} ${info.isPast ? 'past' : ''} ${info.done ? 'done' : ''}" data-day="${info.key}" style="--c:${info.workout ? workoutColor(info.workout) : 'transparent'}" tabindex="0">
    <div class="d-top"><span class="d-dow">${dow} ${d.getDate()}</span></div>${body}${status}</div>`;
}

const fmtSpan = (s) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

/** The main set in one phrase: "4 x 4 min at 229 W", "40 min at 136 W". Empty for tests and slope sessions. */
function workSummary(w) {
  if (!w || isSim(w) || (w.tags || []).includes('test')) return '';
  const ftp = app.settings.ftp;
  const segs = flatten(w, ftp).filter((x) => x.kind === 'erg' && x.dur >= 20);
  if (!segs.length) return '';
  const avg = (x) => (x.from + x.to) / 2;
  const top = Math.max(...segs.map(avg));
  const reps = segs.filter((x) => Math.abs(avg(x) - top) < 0.005);
  const watts = Math.round(top * ftp);
  if (reps.length === 1) return reps[0].dur >= 600 ? `${fmtSpan(reps[0].dur)} at ${watts} W` : '';
  return reps.every((x) => x.dur === reps[0].dur) ? `${reps.length} x ${fmtSpan(reps[0].dur)} at ${watts} W` : `up to ${watts} W`;
}

// Inline so the crank can spin on hover / controller focus (css: .bike-ico). Same drawing as the old icons/bike.png.
const BIKE_ICO = '<svg class="bike-ico" viewBox="0 0 156 96" aria-hidden="true">'
  + '<g fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="32.5" cy="64.5" r="25.5"/><circle cx="122.5" cy="64.5" r="25.5"/>'
  + '<path d="M32.5 64.5H73L106 28H56.5zM32.5 64.5L57 28M73 64.5L54 19M100 15L122.5 64.5M100 15L117 12"/></g>'
  + '<rect x="43" y="15" width="25" height="7.5" rx="3.75" fill="currentColor"/>'
  + '<g class="crank"><circle cx="73" cy="64.5" r="7" fill="currentColor"/>'
  + '<path d="M73 51V78" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></g></svg>';
const PLAY_ICO = '<svg class="play-ico" viewBox="0 0 16 18" aria-hidden="true"><path d="M2 1.5v15l13-7.5z"/></svg>';

/** Recovery + the coach's call (or the built-in advice), one line under the profile. */
function heroRecovery(today) {
  const d = whoopDay(today.key);
  const decided = coachDecision(today.key);
  const z = d?.recovery != null ? recZone(d.recovery) : '';
  const rec = z ? `<span class="rdot ${z}"></span><span><b class="rz ${z}">Recovery ${d.recovery}%.</b> ` : '<span>';
  if (decided) return `<div class="hero-rec">${rec}${decided.replace(/^<p class="coach-call">|<\/p>$/g, '')}</span></div>`;
  if (!z) return '';
  const adv = today.workout && !today.done ? recoveryAdvice(today) : '';
  // recoveryAdvice() returns a block; pull its sentence and buttons into the hero line.
  const p = adv.match(/<p>(.*?)<\/p>/)?.[1] || '';
  const btns = adv.match(/<div class="row-btns">(.*?)<\/div>/s)?.[1] || '';
  return `<div class="hero-rec">${rec}${p}</span>${btns ? `<span class="row-btns">${btns}</span>` : ''}</div>`;
}

const DONE_ICO = '<svg class="done-ico" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16"/><path d="M9 16.5l4.8 4.8L23.5 11"/></svg>';
const SEE_ICO = '<svg class="see-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>';

/** Today's hero once the planned ride is done: result headline, the ride's real numbers, See ride + Free ride. */
function heroDoneBody(w, r, date) {
  const same = r.workoutId === w.id;
  const at = r.start ? new Date(r.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const c = r.compliance;
  const sub = !same ? `Instead of ${esc(w.name)}.`
    : c ? (c.min >= 95 ? `All ${c.reps} ${c.reps === 1 ? 'rep' : 'reps'} on target.` : `Weakest rep at ${c.min}% of target.`) : '';
  const stat = (v, l, extra = '', cls = '') => `<div class="hs"><div class="v ${cls}">${v}</div><div class="l"><b>${l}</b>${extra ? `<span class="wide-only"> &middot; ${extra}</span>` : ''}</div></div>`;
  const stats = [
    r.durSec != null && stat(fmtTime(r.durSec), 'Time', same ? `plan ${fmtTime(totalDuration(w))}` : ''),
    r.np && stat(`${r.np} W`, 'NP', r.avgP ? `avg ${r.avgP} W` : ''),
    r.tss != null && stat(r.tss, 'TSS', same && !isSim(w) ? `plan ~${estimateTSS(w)}` : ''),
    r.if && stat(Number(r.if).toFixed(2), 'IF', r.kj ? `${r.kj} kJ` : ''),
    r.avgHr && stat(r.avgHr, 'Avg HR', r.maxHr ? `max ${r.maxHr}` : '', 'hr'),
    c && stat(`${c.avg}%`, 'Intervals', `${c.reps} ${c.reps === 1 ? 'rep' : 'reps'} &middot; min ${c.min}%`, c.min >= 95 ? 'ok' : 'warn'),
  ].filter(Boolean).join('');
  return `<div class="hero-main">
      <div class="hero-text">
        <div class="hero-top"><b>Today</b><span>${date}${at ? ` &middot; ${at}` : ''}</span></div>
        <h2 class="hero-name">${DONE_ICO}<span><span class="ok">Done.</span> ${esc(same ? w.name : r.name)}</span></h2>
        ${sub ? `<p class="hero-desc">${sub}</p>` : ''}
      </div>
      <div class="hero-btns">
        <button class="ghost hero-see" id="hero-see">${SEE_ICO}See ride</button>
        <button class="ghost hero-free" id="btn-free"><span class="hs-label">Free ride</span>${BIKE_ICO}</button>
      </div>
    </div>
    ${stats ? `<div class="hero-stats">${stats}</div>` : ''}
    ${same ? `<div class="hero-prof prof-hover">${profileSvg(w, 1000, 100)}</div>` : ''}`;
}

/** The next planned ride after today (skipping strength and rest days), shown under a done hero. */
function upNextHtml() {
  const start = new Date(); start.setHours(12, 0, 0, 0);
  const tomorrow = dayInfo(dkey(addDays(start, 1)));
  let next = null;
  for (let i = 1; i <= 13 && !next; i++) { const d = dayInfo(dkey(addDays(start, i))); if (d.workout) next = d; }
  if (!next) return '';
  const w = next.workout;
  const dow = (k, opts) => new Date(k + 'T12:00').toLocaleDateString([], opts);
  const when = next.key === tomorrow.key ? `Tomorrow, ${dow(next.key, { month: 'short', day: 'numeric' })}` : dow(next.key, { weekday: 'short', month: 'short', day: 'numeric' });
  const between = next.key !== tomorrow.key && (tomorrow.kind === 'strength' || tomorrow.kind === 'rest')
    ? `<span>${dow(tomorrow.key, { weekday: 'short' })} is ${tomorrow.kind}</span>` : '';
  const work = workSummary(w);
  return `<section class="up-next" data-day="${next.key}" style="--c:${workoutColor(w)}" aria-label="Up next">
    <div class="un-text">
      <div class="un-top"><b>Up next</b><span>${when}</span>${between}</div>
      <h3 class="un-name">${esc(w.name)}${w._source === 'coach' ? ' <span class="tag coach">coach</span>' : ''}</h3>
      <div class="un-meta">${woMeta(w)}${work ? ` &middot; ${work}` : ''}${next.optional ? ' &middot; optional' : ''}</div>
    </div>
    <div class="un-prof prof-hover">${profileSvg(w, 1000, 100)}</div>
  </section>`;
}

function bindUpNext(root) {
  const card = root.querySelector('.up-next');
  if (!card) return;
  const info = dayInfo(card.dataset.day);
  bindProfileHover(card.querySelector('.un-prof'), info.workout);
  // The card opens that day in Calendar; the chart keeps its own tap readout.
  card.onclick = (e) => { if (e.target.closest('.un-prof')) return; app.calMonth = card.dataset.day.slice(0, 7); app.calSel = card.dataset.day; setTab('calendar'); };
}

/** Today: a full-width card in the color of the day's main effort, with Start up front and Free ride as the second choice. */
function renderHero() {
  const el = $('#today');
  const today = dayInfo(dkey(new Date()));
  const w = today.workout;
  const date = new Date(today.key + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const src = !app.plan ? '' : !syncClient()
    ? `<p class="plan-src">Showing the public copy of the plan. ${syncHint()} in <a href="#" data-open-settings="sync">Settings</a> to get the coach's daily changes on this device.</p>`
    : app.coachError ? `<p class="plan-src">Couldn't load the coach plan (${esc(app.coachError.slice(0, 80))}). Showing the last saved copy. Check sync in <a href="#" data-open-settings="sync">Settings</a>.</p>` : '';
  const free = (primary) => `<button class="${primary ? 'primary' : 'ghost'} hero-free" id="btn-free"><span class="hs-label">${primary ? 'Start free ride' : 'Free ride'}</span>${BIKE_ICO}</button>`;
  let body;
  // Done = the planned workout, or another structured workout in its place (e.g. the red-recovery Zone 2 swap).
  // A free ride alone leaves today's workout open.
  const doneRide = w && (today.ridden.find((r) => r.workoutId === w.id) || today.ridden.find((r) => r.workoutId));
  if (doneRide) {
    // Done: a quiet sheet card with the ride's real numbers, then the next planned ride.
    el.innerHTML = `${src}<section class="hero done" style="--c:${workoutColor(w)}" aria-label="Today, done">${heroDoneBody(w, doneRide, date)}</section>${upNextHtml()}`;
    $('#btn-free').onclick = (e) => startFree(e.currentTarget);
    $('#hero-see').onclick = () => openRide(doneRide.id);
    if (doneRide.workoutId === w.id) bindProfileHover(el.querySelector('.hero-prof'), w);
    bindUpNext(el);
    return;
  }
  if (w) {
    const work = workSummary(w);
    const status = today.done
      ? `<div class="hero-done">&#10003; ${today.done.workoutId === w.id ? 'Done' : esc(today.done.name)} &middot; ${today.done.tss} TSS<button class="ghost small hero-done-see" data-ride="${esc(today.done.id)}">See ride</button></div>` : '';
    const start = `<button class="primary hero-start" id="hero-start">${PLAY_ICO}<span class="hs-label">Start workout</span></button>`;
    body = `<div class="hero-main">
        <div class="hero-text">
          <div class="hero-top"><b>Today</b><span>${date}</span></div>
          <h2 class="hero-name">${esc(w.name)}${w._source === 'coach' ? ' <span class="tag coach">coach</span>' : ''}</h2>
          <div class="hero-meta">${woMeta(w)}${work ? ` &middot; ${work}` : ''}</div>
          ${today.note ? `<p class="hero-desc"><b>Coach:</b> ${esc(today.note)}</p>` : w.description ? `<p class="hero-desc">${esc(w.description)}</p>` : ''}
          ${status}
        </div>
        <div class="hero-btns">${start}${free(false)}</div>
      </div>
      <div class="hero-prof prof-hover">${profileSvg(w, 1000, 100)}</div>
      ${heroRecovery(today)}`;
  } else {
    const [name, sub] = today.kind === 'strength' ? ['Strength day', 'Gym day, no ride planned.']
      : today.kind === 'rest' ? ['Rest day', 'Nothing planned. Spin easy if you feel like it.']
      : [app.plan ? 'Nothing planned' : 'No plan loaded', 'Set the grade with D-pad up/down and ride it with your gears.'];
    body = `<div class="hero-main">
        <div class="hero-text">
          <div class="hero-top"><b>Today</b><span>${date}</span></div>
          <h2 class="hero-name">${name}</h2>
          <p class="hero-desc">${sub}</p>
          ${today.done ? `<div class="hero-done">&#10003; ${esc(today.done.name)} &middot; ${today.done.tss} TSS<button class="ghost small hero-done-see" data-ride="${esc(today.done.id)}">See ride</button></div>` : ''}
        </div>
        <div class="hero-btns">${free(true)}</div>
      </div>${heroRecovery(today)}`;
  }
  el.innerHTML = `${src}<section class="hero ${w ? '' : 'nowo'}" style="--c:${w ? workoutColor(w) : 'transparent'}" aria-label="Today">${body}</section>`;
  $('#btn-free').onclick = (e) => startFree(e.currentTarget);
  el.querySelectorAll('.hero-done-see').forEach((b) => (b.onclick = () => openRide(b.dataset.ride)));
  const s = $('#hero-start');
  if (s) s.onclick = () => startWorkout(w, 1, s);
  if (w) bindProfileHover(el.querySelector('.hero-prof'), w);
  bindRecoveryAdvice(el);
}

/** What one interval asks for, for the profile readout: "216 W", "120-180 W", "7% grade". */
function tipTarget(g, ftp) {
  if (g.kind === 'sim') return g.free ? 'Free ride' : `${+(g.grade * 100).toFixed(1)}% grade`;
  const a = Math.round(g.from * ftp), b = Math.round(g.to * ftp);
  return a === b ? `${a} W` : `${a}-${b} W`;
}

/** Height gained or lost over one stretch of an elevation profile: " +90 m" / " -12 m", nothing on the flat. */
function riseHtml(p) {
  const m = Math.round(p.h1 - p.h0);
  return m ? ` <span>${m > 0 ? '+' : '&minus;'}${Math.abs(m)} m</span>` : '';
}

/** Hover (or tap on the phone) on a workout profile (today hero, calendar day, open library row): highlight the interval under the pointer and show its watts and time. */
function bindProfileHover(box, w) {
  if (!box) return;
  const segs = flatten(w, app.settings.ftp);
  if (!segs.length) return;
  const T = segs[segs.length - 1].end, ftp = app.settings.ftp;
  const tr = isTrack(segs) ? track(segs) : null; // elevation profile: the x axis is distance
  const tip = document.createElement('div');
  tip.className = 'prof-tip';
  tip.setAttribute('role', 'status');
  box.append(tip);
  const svg = box.querySelector('.profile');
  let cur = -1;
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    let i;
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
      // A finger is imprecise: anywhere in the interval's column counts.
      const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 0.9999);
      i = tr ? tr.parts.findIndex((p) => f * tr.D >= p.d0 && f * tr.D < p.d1) : segs.findIndex((g) => f * T >= g.start && f * T < g.end);
    } else {
      // Mouse: only inside the filled area under the curve, not the empty space above it.
      const hit = e.target.closest?.('[data-i]');
      i = hit && svg.contains(hit) ? +hit.dataset.i : -1; // library rows carry data-i too
    }
    if (i < 0) return hide();
    if (i !== cur) {
      cur = i;
      const g = segs[i];
      svg.querySelectorAll('[data-i]').forEach((el) => el.classList.toggle('on', +el.dataset.i === i));
      const pct = g.kind === 'erg' ? (g.from === g.to ? `${Math.round(g.from * 100)}%` : `${Math.round(g.from * 100)}-${Math.round(g.to * 100)}%`) + ' FTP' : '';
      const rep = g.rep ? ` &middot; ${g.rep.i} of ${g.rep.of}` : '';
      const len = g.dist ? `${fmtDist(g.dist)} (~${fmtTime(g.dur)})` : fmtTime(g.dur);
      const cad = g.cadence !== '' ? ` &middot; ${esc(g.cadence)} rpm` : '';
      tip.innerHTML = `<div class="pt-lbl">${esc(g.label)}${rep}</div>
        <div class="pt-tgt">${tipTarget(g, ftp)}${pct ? ` <span>${pct}</span>` : ''}${tr ? riseHtml(tr.parts[i]) : ''}</div>
        <div class="pt-time">${len}${cad}<br><span>${fmtTime(g.start)} to ${fmtTime(g.end)}</span></div>`;
      box.classList.add('hov');
    }
    // Centered over the interval, kept inside the chart.
    const b = box.getBoundingClientRect(), g = segs[cur];
    const f = tr ? (tr.parts[cur].d0 + tr.parts[cur].d1) / 2 / tr.D : (g.start + g.end) / 2 / T;
    const mid = r.left - b.left + f * r.width;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(mid, half), b.width - half)}px`;
  };
  const hide = () => {
    cur = -1;
    box.classList.remove('hov');
    svg.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
  };
  box.addEventListener('pointermove', show);
  box.addEventListener('pointerdown', show);
  // Fallback for phone browsers that don't send pointer events for a tap on a plain chart (iOS web views): the click does.
  if (matchMedia('(hover: none)').matches) box.addEventListener('click', (e) => show({ clientX: e.clientX, pointerType: 'touch' }));
  // A finger lifts right after the tap, so on touch the readout stays until a tap elsewhere.
  box.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  const outside = (e) => { if (!box.isConnected) return document.removeEventListener('pointerdown', outside); if (!box.contains(e.target)) hide(); };
  document.addEventListener('pointerdown', outside);
}

function renderWeek() {
  const el = $('#week');
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
  const days = Array.from({ length: 13 }, (_, i) => dayInfo(dkey(addDays(start, i + 1))));
  el.innerHTML = `<div class="week-head"><h3 class="eyebrow">Next days</h3>
    <div class="row-btns"><button class="ghost small" data-scroll="-1" aria-label="Earlier">&lsaquo;</button><button class="ghost small" data-scroll="1" aria-label="Later">&rsaquo;</button></div></div>
    <div class="week-strip" id="week-strip" data-start="${dkey(start)}">${days.map(dayCardHtml).join('')}</div>`;
  const strip = $('#week-strip');
  el.querySelectorAll('[data-scroll]').forEach((b) => (b.onclick = () => strip.scrollBy({ left: +b.dataset.scroll * strip.clientWidth * 0.8, behavior: 'smooth' })));
  const back = el.querySelector('[data-scroll="-1"]');
  const syncBack = () => (back.disabled = strip.scrollLeft <= 4);
  strip.addEventListener('scroll', syncBack, { passive: true });
  strip.scrollLeft = keepScroll;
  syncBack();
  bindDayCards(el);
  bindRecoveryAdvice(el);
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
      const done = info.done ? `<div class="cal-done">&#10003; ${info.done.tss} TSS</div>` : info.workout && info.isPast ? `<div class="cal-missed">${info.optional ? 'optional' : 'missed'}</div>` : info.optional ? '<div class="cal-missed">optional</div>' : '';
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
    html += `<div class="cal-wo"><div class="wo-top"><div class="wo-name">${esc(w.name)}</div><div class="wo-meta">${woMeta(w)}</div></div><div class="cal-prof prof-hover">${profileSvg(w, 600, 60)}</div>
      ${info.note ? `<p><b>Coach:</b> ${esc(info.note)}</p>` : ''}<p class="muted">${esc(w.description)}</p>
      <button class="primary small" data-startday="${sel}">${info.isToday ? 'Start' : 'Ride it now'}</button></div>`;
  } else html += `<p class="muted">${info.kind === 'strength' ? 'Strength day: no ride planned.' : info.kind === 'rest' ? 'Rest day.' : 'Nothing planned.'}</p>`;
  html += coachDecision(sel);
  const wd = whoopDay(sel);
  if (wd?.recovery != null) html += `<div class="cal-ride" style="color:var(--muted)">WHOOP: recovery <b class="rz ${recZone(wd.recovery)}">${wd.recovery}%</b>${wd.hrv ? ` &middot; HRV ${Math.round(wd.hrv)} ms` : ''}${wd.rhr ? ` &middot; RHR ${wd.rhr}` : ''}${wd.sleepHours ? ` &middot; sleep ${wd.sleepHours} h` : ''}</div>`;
  for (const r of info.ridden) {
    html += `<div class="cal-ride">&#10003; <b>${esc(r.name)}</b> &middot; ${fmtTime(r.durSec)}${r.np != null ? ` &middot; NP ${r.np} W` : ''} &middot; TSS ${r.tss}${r.tssFrom === 'hr' ? ' (from HR)' : ''}${r.avgHr ? ` &middot; HR ${r.avgHr}` : ''}${r.compliance ? ` &middot; intervals ${r.compliance.avg}% (min ${r.compliance.min}%)` : ''}<button class="ghost small cal-see" data-ride="${esc(r.id)}">${SEE_ICO}See ride</button></div>`;
  }
  $('#cal-detail').innerHTML = html;
  $('#cal-detail').querySelectorAll('[data-ride]').forEach((b) => (b.onclick = () => openRide(b.dataset.ride)));
  $('#cal-detail').querySelectorAll('[data-startday]').forEach((b) => (b.onclick = () => startWorkout(info.workout)));
  if (info.workout) bindProfileHover($('#cal-detail .cal-prof'), info.workout);
}

// ------------------------------------------------------------------ WHOOP recovery
const recZone = (r) => (r >= 67 ? 'green' : r >= 34 ? 'yellow' : 'red');
const whoopDay = (key) => app.whoop?.[key];

function isHard(w) {
  if (!w) return false;
  if ((w.tags || []).some((t) => ['vo2', 'threshold', 'test'].includes(t))) return true;
  return flatten(w).some((x) => x.kind === 'erg' && x.dur >= 120 && (x.from + x.to) / 2 >= 0.88);
}

/** Coach's read of today's recovery vs today's session. */
function recoveryAdvice(today) {
  if (!today) return '';
  const d = whoopDay(today.key);
  // The recovery number itself lives only in the overview tile at the top; here just the call.
  // The morning coach run already weighed recovery against the plan: show its call, don't adjust twice.
  const decided = coachDecision(today.key);
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
  const bars = series.map((d, i) => `<rect x="${X(i) - bw / 2}" y="${Math.min(B(d.tsb), 190)}" width="${bw}" height="${Math.abs(B(d.tsb) - 190)}" fill="${d.tsb >= 0 ? ZC.z3 : ZC.z5}" opacity=".8"/>`).join('');
  const ticks = series.map((d, i) => d.date.endsWith('-01') || i === 0 ? `<text x="${X(i)}" y="226" fill="${MUTED}" font-size="12">${new Date(d.date + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart">
    <text x="0" y="14" fill="${MUTED}" font-size="12">${Math.round(maxL)}</text>
    <line x1="30" x2="${W - 10}" y1="190" y2="190" stroke="${RULE}"/>${bars}${line('atl', '#c2255c')}${line('ctl', INK)}${ticks}
    <text x="${W - 10}" y="14" text-anchor="end" font-size="11"><tspan fill="${INK}">&#9632; Fitness</tspan> <tspan fill="#c2255c">&#9632; Fatigue</tspan> <tspan fill="${ZC.z3}">&#9632; Form</tspan></text></svg>`;
}

function svgWeekly(weeks) {
  const W = 560, H = 200, n = weeks.length;
  const max = Math.max(100, ...weeks.map((w) => w.tss));
  const bw = (W - 20) / n;
  return `<svg viewBox="0 0 ${W} ${H}" class="svgchart">${weeks.map((w, i) => {
    const h = (w.tss / max) * 120, x = 10 + i * bw;
    return `<rect x="${x + 6}" y="${165 - h}" width="${bw - 12}" height="${h}" rx="2" fill="${i === n - 1 ? INK : FAINT}"/>
      ${w.tss ? `<text x="${x + bw / 2}" y="${158 - h}" text-anchor="middle" fill="${INK}" font-size="14" font-weight="700">${w.tss}</text><text x="${x + bw / 2}" y="${144 - h}" text-anchor="middle" fill="${MUTED}" font-size="11">${w.hours}h</text>` : ''}
      ${i % 2 === n % 2 ? '' : `<text x="${x + bw / 2}" y="190" text-anchor="middle" fill="${MUTED}" font-size="11">${new Date(w.start + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>`}`;
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
    <polyline fill="none" stroke="${FAINT}" stroke-width="2" stroke-dasharray="5 5" points="${pts(cAll)}"/>
    <polyline fill="none" stroke="${INK}" stroke-width="2.5" points="${pts(c90)}"/>${dots(c90, INK)}
    ${labels.map((l, i) => `<text x="${X(i)}" y="210" text-anchor="middle" fill="${MUTED}" font-size="12">${l}</text>`).join('')}
    <text x="${W - 10}" y="14" text-anchor="end" font-size="12"><tspan fill="${INK}">&#9632; Last 90 days</tspan> <tspan fill="${MUTED}">- - All time</tspan></text></svg>`;
}

/** Time-in-zone rows (Z1..Z7). With ftp, ranges are in watts (one ride); without, % of FTP. */
const fmtLong = (sec) => (sec < 3600 ? fmtTime(sec) : `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`);
function zoneBars(secs, ftp) {
  const total = (secs || []).reduce((a, b) => a + (b || 0), 0);
  if (!total) return '<p class="muted">No rides in this period.</p>';
  const max = Math.max(...secs);
  return `<div class="zbars">${ZONES.map((z, i) => {
    const sec = secs[i] || 0;
    return `<div class="zb-z">Z${z.z}</div><div class="zb-n">${z.name}<span>${zoneRange(i, ftp)}</span></div>
      <div class="zb-bar"><i style="width:${(sec / max) * 100}%;background:var(--${z.color})"></i></div>
      <div class="zb-t">${sec ? fmtLong(sec) : '-'}</div><div class="zb-p">${sec ? Math.round((sec / total) * 100) + '%' : ''}</div>`;
  }).join('')}</div>`;
}

function renderZones(real, thisWeekStart) {
  const since28 = dkey(new Date(Date.now() - 27 * 864e5));
  const pick = (from) => real.filter((r) => r.id.slice(0, 10) >= from);
  const col = (title, rs) => {
    const z = zoneTotals(rs), tot = z.reduce((a, b) => a + b, 0);
    return `<div><h4>${title} <span class="muted">${tot ? `${fmtLong(tot)} &middot; ${rs.length} ride${rs.length === 1 ? '' : 's'}` : ''}</span></h4>${zoneBars(z)}</div>`;
  };
  $('#chart-zones').innerHTML = col('This week', pick(thisWeekStart)) + col('Last 4 weeks', pick(since28));
}

const LOAD_INFO = {
  ctl: '<b>Chronic Training Load.</b> Your average daily training stress (TSS) over roughly the last 6 weeks (42-day weighted average, recent days count more). It climbs slowly with consistent training and is the best single number for fitness. A 1-hour ride at FTP is 100 TSS.',
  atl: '<b>Acute Training Load.</b> The same average over roughly the last week (7 days). It jumps after hard days and drops fast with rest, so it tracks fatigue. ATL above CTL means you are training harder than your recent normal.',
  tsb: '<b>Training Stress Balance</b> = yesterday\'s CTL minus ATL, so today\'s ride shows up tomorrow. Above +5: fresh, good for a test or race. -10 to +5: balanced. -10 to -30: productive fatigue, normal in a build block. Below -30: overreaching, back off.',
};
const infoTip = (html, label) => `<span class="info"><button type="button" class="info-btn" aria-label="What is ${esc(label)}?"><svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="3.6" r="1.25"/><rect x="5.95" y="5.9" width="2.1" height="5.5" rx=".6"/></svg></button><span class="tip" role="tooltip">${html}</span></span>`;
// Touch screens have no hover: tap (i) to toggle the tip, tap anywhere else to close it.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.info-btn');
  $$('.info.open').forEach((x) => { if (!btn || x !== btn.parentElement) x.classList.remove('open'); });
  if (btn) btn.parentElement.classList.toggle('open');
});

async function renderTraining() {
  const rows = await trainingRows();
  const real = rows.filter((r) => !r.demo).map((r) => r.summary);
  const series = loadSeries(real, new Date(), 90);
  const today = series.at(-1) || { ctl: 0, atl: 0, tsb: 0 };
  const wk = weekly(real, 12);
  const thisWeek = wk.at(-1);
  const est = ftpEstimate(real);
  const card = (v, l, sub = '', info = '') => `<div class="stat">${info ? infoTip(info, l) : ''}<div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const cfg = ls.get('sync', {});
  const at = ls.get('remoteIndexAt');
  $('#sync-status').innerHTML = syncClient()
    ? `Synced with <b>${esc(cfg.repo || DEFAULT_REPO)}</b>${at ? `, last checked ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} <button class="ghost small" id="btn-syncnow">Sync now</button>`
    : `History is only on this device. ${syncHint()} in <a href="#" data-open-settings="sync">Settings</a> to sync it to rodillo-data so your coach can see it.`;
  if ($('#btn-syncnow')) $('#btn-syncnow').onclick = () => syncPending();
  $('#training-cards').innerHTML = [
    card(Math.round(today.ctl), 'Fitness (CTL)', '', LOAD_INFO.ctl), card(Math.round(today.atl), 'Fatigue (ATL)', '', LOAD_INFO.atl),
    card(`${today.tsb > 0 ? '+' : ''}${Math.round(today.tsb)}`, 'Form (TSB)', formLabel(today.tsb), LOAD_INFO.tsb),
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
  renderZones(real, thisWeek.start);
  $('#chart-curve').innerHTML = real.length ? svgCurve(powerCurve(real, 90), powerCurve(real)) : '<p class="muted">No rides yet.</p>';
  $('#ride-table').innerHTML = rows.length ? `<table><tr><th>Date</th><th>Ride</th><th>Time</th><th>NP</th><th>IF</th><th>TSS</th><th>HR</th><th>Intervals</th><th>Drift</th><th></th></tr>
    ${rows.map((r) => {
      const x = r.summary;
      const comp = x.compliance ? `<span class="pct ${x.compliance.min < 95 ? 'low' : 'ok'}">${x.compliance.avg}%</span> <span class="muted">min ${x.compliance.min}%</span>` : '';
      const status = r.demo ? '<span class="tag">demo</span>' : r.interrupted ? '<span class="tag">interrupted</span>' : r.synced ? '' : '<span class="tag warn">not synced</span>';
      return `<tr data-ride="${esc(x.id)}"><td>${new Date(x.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</td>
      <td>${esc(x.name)} ${status}</td><td>${fmtTime(x.durSec)}</td><td>${x.np != null ? `${x.np} W` : '-'}</td><td>${x.if ?? '-'}</td><td>${x.tss}${x.tssFrom === 'hr' ? ' <span class="muted">HR</span>' : ''}</td><td>${x.avgHr ?? '-'}</td>
      <td>${comp}</td><td>${x.decoupling != null ? x.decoupling + '%' : ''}</td>
      <td class="nowrap">${r.local ? `<button class="ghost small" data-fit="${r.local.id}">.FIT</button> <button class="ghost small" data-del="${r.local.id}">Delete</button>` : ''}</td></tr>`;
    }).join('')}</table>` : '<p class="muted">No rides yet.</p>';
  // a row opens its ride page (the .FIT / Delete buttons keep their own job)
  $$('#ride-table tr[data-ride]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('button')) openRide(tr.dataset.ride); }));
  $$('[data-fit]').forEach((b) => (b.onclick = async () => downloadFit(await rides.get(+b.dataset.fit))));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (await ask('Synced copies stay in rodillo-data.', { title: 'Delete this ride from this Mac?', ok: 'Delete', danger: true })) { await rides.del(+b.dataset.del); renderTraining(); } }));
}

// ------------------------------------------------------------------ imports
$('#import-workout').addEventListener('change', async (e) => {
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
  if (btn && (app.demo || app.trainer?.state === 'connected')) return launchFrom(btn, go);
  if (await canRide()) go();
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
  if (btn && (app.demo || app.trainer?.state === 'connected')) return launchFrom(btn, go, 'free');
  if (await canRide()) go();
}

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
  s.on('workoutDone', () => toast('Workout complete. Free ride, or hold B to finish'));
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
    segsChanged: !!s.segsChanged, // open-ended test: the steps ridden differ from the workout file
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
  const repo = cfg.repo || DEFAULT_REPO;
  if (authEnabled() && authSession()) return new GitHubSync({ token: authToken, repo });
  return cfg.token ? new GitHubSync({ token: cfg.token, repo }) : null;
}
const signedIn = () => !!syncClient();
/** Lost access to rodillo-data: the builder can't save anymore, close it (unsaved edits are dropped). */
function closeBuilderNow() { if (builderOpen()) $('#builder').classList.add('hidden'); }
const syncHint = () => (authEnabled() ? 'Sign in with GitHub' : 'Add your GitHub token');

async function syncRide(ride) {
  const gh = syncClient();
  const el = $('#s-sync');
  const say = (t) => { if (el && app.screen === 'summary') el.textContent = t; };
  if (ride.demo) { say('Demo ride: kept on this Mac only, not added to your training history.'); return false; }
  if (!gh) { say(`Not synced: ${syncHint().toLowerCase()} in Settings to send rides to rodillo-data.`); return false; }
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
  if (!ride?.samples?.length) { tell('This ride has no recorded data to export.', 'Nothing to export'); return; }
  const bytes = encodeActivity(ride.samples, ride.laps, { tss: ride.summary?.tss });
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  const d = new Date(ride.id);
  a.href = URL.createObjectURL(blob);
  a.download = `rodillo-${d.toLocaleDateString('en-CA')}-${ride.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.fit`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ ride page (one completed ride, js/ridepage.js)
// Opened from the done hero's "See ride", a Training row or a ridden Calendar day. Back / Esc / controller B returns.
const rd = { id: null, doc: null, local: null, segs: [], sel: null, t: null, geo: null, from: null, scrollY: 0 };
const RD_BACK = { training: 'Training', calendar: 'Calendar' };
const BACK_ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const canHover = matchMedia('(hover: hover)');

async function openRide(id) {
  if (!id) return;
  Object.assign(rd, { id, doc: null, local: null, segs: [], sel: null, t: null, geo: null, from: app.tab, scrollY: window.scrollY });
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

/** This device's recording first (full samples), then the cached copy, then rodillo-data (cached after). */
async function loadRideDoc(id) {
  let row = null;
  try { row = (await rides.list()).find((r) => r.summary?.id === id); } catch { /* no idb */ }
  if (row) {
    const full = await rides.get(row.id);
    if (full?.samples?.length && full.meta) return { doc: { ...rideDoc(full), laps: full.laps }, local: full };
  }
  try { const c = await docs.get(id); if (c) return { doc: c, local: null }; } catch { /* no idb */ }
  const gh = syncClient();
  if (!gh) return null;
  const r = await gh.getJson(`rides/${id.slice(0, 4)}/${id}.json`);
  if (!r?.json?.summary) return null;
  try { await docs.put(id, r.json); } catch { /* cache is optional */ }
  return { doc: r.json, local: null };
}

function closeRide() {
  rd.id = null;
  show('home');
  window.scrollTo(0, rd.scrollY);
}

const rideFtp = () => rd.doc?.summary?.ftp || app.settings.ftp;

function renderRidePage() {
  const doc = rd.doc, st = doc.summary;
  const w = st.workoutId ? app.library.find((x) => x.id === st.workoutId) : null;
  // the steps as ridden (stored with this device's recording), else the workout as it is in the library now
  rd.segs = rideSegs(doc, rd.local?.meta?.segs || doc.segs || (w ? flatten(w, rideFtp()) : null));
  const season = powerCurve((app.rows || []).filter((r) => !r.demo).map((r) => r.summary), 90);
  $('#rd').innerHTML = pageHtml(doc, {
    segs: rd.segs, ftp: rideFtp(), zoneHex, gradeHex, season, sel: rd.sel, phone: isPhone(),
    profile: w ? profileSvg(w, 1000, 100) : '', backLabel: RD_BACK[rd.from] || 'Home',
    canFit: !!(rd.local?.samples?.length || doc.streams?.power || doc.streams?.hr), canDelete: !!rd.local,
  });
  bindRideChart();
  drawRideChart();
}

function drawRideChart() {
  const wrap = $('#rd-wrap');
  if (!wrap || !rd.doc) return;
  const c = chartSvg(rd.doc, { width: wrap.clientWidth, phone: isPhone(), ftp: rideFtp(), segs: rd.segs, sel: rd.sel, tok: TOK, zoneHex, gradeHex });
  const svg = $('#rd-chart');
  svg.setAttribute('viewBox', `0 0 ${c.width} ${c.height}`);
  svg.setAttribute('height', c.height);
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
  wrap.addEventListener('click', (e) => {
    const strip = e.target.closest('.rd-strip [data-i]');
    if (strip) return selectRideSeg(+strip.dataset.i);
    const t = tAt(e.clientX);
    if (!canHover.matches) return rideCrosshair(t);
    const s = rd.segs.find((x) => t >= x.start && t < x.end);
    if (s) selectRideSeg(s.i);
  });
}

function rideAction(a) {
  const segs = rd.segs.filter((s) => s.res);
  const step = (d) => {
    if (!segs.length) return;
    const k = segs.findIndex((s) => s.i === rd.sel);
    const n = k < 0 ? (d > 0 ? 0 : segs.length - 1) : Math.max(0, Math.min(segs.length - 1, k + d));
    selectRideSeg(segs[n].i, true);
  };
  switch (a) {
    case 'back': if (rd.sel != null) selectRideSeg(null); else closeRide(); break;
    case 'left': case 'easier': step(-1); break;
    case 'right': case 'harder': step(+1); break;
    case 'up': window.scrollBy({ top: -240, behavior: 'smooth' }); break;
    case 'down': window.scrollBy({ top: 240, behavior: 'smooth' }); break;
  }
}

$('#rd').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rd]');
  if (b) {
    const a = b.dataset.rd;
    if (a === 'back') closeRide();
    else if (a === 'clear') selectRideSeg(null);
    else if (a === 'fit') {
      const st = rd.doc.summary;
      downloadFit(rd.local || { id: Date.parse(st.start), name: st.name, samples: samplesFromDoc(rd.doc), laps: rd.doc.laps, summary: st });
    } else if (a === 'delete' && rd.local) {
      if (!(await ask('Synced copies stay in rodillo-data.', { title: 'Delete this ride from this device?', ok: 'Delete', danger: true }))) return;
      await rides.del(rd.local.id);
      closeRide();
      toast('Ride deleted');
      if (app.tab === 'training') renderTraining();
      refreshPlanViews();
    }
    return;
  }
  const tr = e.target.closest('#rd-ints tr[data-i]');
  if (tr) selectRideSeg(+tr.dataset.i, true);
});
// phone: a tap outside the chart puts the reading away
document.addEventListener('touchstart', (e) => { if (app.screen === 'ridepage' && rd.t != null && !e.target.closest('#rd-wrap')) rideCrosshair(null); }, { passive: true });
let rdResize = 0;
window.addEventListener('resize', () => { if (app.screen !== 'ridepage') return; cancelAnimationFrame(rdResize); rdResize = requestAnimationFrame(drawRideChart); });

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
  // New FTP: any ride that beats the current one, or a ramp test that says something different
  const found = ride.demo ? null : ftpFromRide(st);
  const cur = app.settings.ftp;
  if (found && (found.ftp > cur || (found.test && found.ftp !== cur))) {
    extra += `<div class="callout ftp-callout"><div><b>${found.ftp > cur ? 'New FTP detected' : 'Ramp test result'}: ${found.ftp} W</b> <span class="muted">(${found.basis}; currently ${cur} W)</span><div class="muted" id="s-ftpmsg">Updating saves it to your plan, so every device gets it.</div></div>
      <div class="ftp-btns"><button class="primary small" id="s-setftp">Update to ${found.ftp} W</button><button class="ghost small" id="s-keepftp">Keep ${cur} W</button></div></div>`;
  }
  const work = (ride.intervals || []).filter((x) => x.work);
  if (work.length) {
    extra += `<h4>Work intervals</h4><table class="ints"><tr><th>Interval</th><th>Target</th><th>Actual</th><th></th><th>HR</th><th>Cadence</th></tr>
      ${work.map((x) => `<tr><td>${esc(x.label)}${x.rep ? ' ' + x.rep : ''}</td><td>${x.target ? x.target + ' W' : (x.grade ?? '') + (x.grade != null ? '%' : '')}</td><td>${x.avgP} W</td>
      <td>${x.pct ? `<span class="pct ${x.pct < 95 ? 'low' : x.pct > 105 ? 'high' : 'ok'}">${x.pct}%</span>` : ''}</td><td>${x.avgHr ?? '-'}</td><td>${x.avgCad}${x.cadTarget ? ` <span class="muted">(${x.cadTarget}, ${x.cadInRange ?? '-'}% in range)</span>` : ''}</td></tr>`).join('')}</table>`;
  }
  if (st.zones?.some(Boolean)) extra += `<h4>Time in zones <span class="muted">at FTP ${st.ftp} W</span></h4>${zoneBars(st.zones, st.ftp)}`;
  if (st.decoupling != null) extra += `<p class="muted">Aerobic decoupling (Pw:HR): <b style="color:var(--text)">${st.decoupling}%</b> ${st.decoupling < 5 ? '(steady: aerobic base is handling this power)' : '(HR drifted: this power is at the edge of your Z2)'}</p>`;
  $('#s-extra').innerHTML = extra;
  if ($('#s-setftp')) {
    const done = (msg) => { $$('.ftp-callout button').forEach((b) => b.remove()); $('#s-ftpmsg').textContent = msg; };
    $('#s-setftp').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Saving...';
      app.settings.ftp = found.ftp;
      reconcileSettings(`${found.test ? 'ramp test' : 'ride'} ${st.id.slice(0, 10)}`);
      const synced = await flushSettings();
      refreshPlanViews();
      done(synced ? `FTP is now ${found.ftp} W on all devices.` : `FTP is now ${found.ftp} W here. It goes to your plan on the next sync.`);
    };
    $('#s-keepftp').onclick = () => { if (found.test) declineTestFtp(st.id); done(`Kept ${cur} W.`); };
  }
  $('#s-sync').textContent = ride.demo ? 'Demo ride: saving keeps it on this Mac only.' : syncClient() ? 'Saving adds it to your training history in rodillo-data.' : `Saving keeps it on this device. ${syncHint()} in Settings to sync it.`;
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
    if (!(await ask('It will not be saved or synced.', { title: 'Discard this ride?', ok: 'Discard', danger: true }))) return;
    try { await rides.del(ride.id); } catch { /* ignore */ }
    app.session = null;
    show('home');
    toast('Ride discarded');
    if (app.tab === 'training') renderTraining();
  };
  show('summary');
}

// ------------------------------------------------------------------ actions (controller + keyboard)
function action(a, src = 'tap') {
  if (app.launching) return;
  if (modalOpen()) return modalAction(a);
  if (builderOpen()) { if (a === 'back') closeBuilder(); return; } // the builder is keyboard/touch only
  if (app.screen === 'ridepage') return rideAction(a);
  const s = app.session;
  if (app.screen === 'ride' && s) {
    switch (a) {
      case 'easier': if (s.mode === 'erg') return action('down'); s.shift(-1); break;
      case 'harder': if (s.mode === 'erg') return action('up'); s.shift(+1); break;
      case 'front': if (s.gb.isDouble) s.toggleFront(); else toast('1x: no front shifting'); break;
      case 'up': s.bump(+1); toast(s.mode === 'erg' ? `Intensity ${Math.round(s.intensity * 100)}%` : `Grade ${fmtGradeSet(s)}`); break;
      case 'down': s.bump(-1); toast(s.mode === 'erg' ? `Intensity ${Math.round(s.intensity * 100)}%` : `Grade ${fmtGradeSet(s)}`); break;
      case 'select': s.togglePause(); break;
      case 'back': holdStart('end', src); break;
      case 'skip': holdStart('skip', src); break;
      case 'lap': if (s.seg) toast('Laps are automatic per interval'); else s.lap(); break;
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
      const tabs = ['workouts', 'calendar', 'training'];
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
    case 'back': $$('.panel').forEach((p) => p.classList.add('hidden')); setDevPop(false); break;
  }
}
const fmtGradeSet = (s) => `${(s.gradeOffset * 100).toFixed(0)}%`;

const BUTTON_ACTIONS = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  a: 'select', b: 'back', y: 'skip', z: 'lap', // ERG off is on screen only (button / phone sheet / E key)
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
  action(a, 'ctl');
  if (REPEATABLE.has(a) && app.screen === 'ride') {
    clearTimeout(holdTimers[b]);
    const rep = () => { action(a); holdTimers[b] = setTimeout(rep, 120); };
    holdTimers[b] = setTimeout(rep, 450);
  }
}
function onRelease(b) {
  clearTimeout(holdTimers[b]); delete holdTimers[b];
  const a = BUTTON_ACTIONS[b];
  if (a === 'skip') holdEnd('skip');
  else if (a === 'back') holdEnd('end');
}

// ------------------------------------------------------------------ hold to confirm
// Skip (Y) and End ride (B) only happen if the button is held the whole time; letting go early cancels.
// Same for the S / Esc keys (big ring overlay). Phone sheet buttons hold too, shorter, and fill left to right
// instead of the ring. Mouse clicks (desktop End ride) get a confirm screen.
const HOLDS = {
  skip: { ms: 3000, tapMs: 1000, ctl: 'Y', key: 'S', msg: '', sub: (k) => `Keep holding ${k} to skip` },
  end: { ms: 5000, tapMs: 2000, ctl: 'B', key: 'Esc', msg: 'End ride?', sub: (k) => (tooShort() ? 'Under 10 s, nothing will be saved' : `Keep holding ${k} to end`) },
};
let hold = null; // { kind, t, btn }
function holdStart(kind, src, btn) {
  const s = app.session;
  if (!s || app.screen !== 'ride') return;
  if (kind === 'skip' && !s.segs) return;
  if (hold) { if (hold.kind === kind) return; holdEnd(); }
  const h = HOLDS[kind];
  if (src === 'tap') { // phone sheet button fills left to right
    if (!btn) return;
    btn.style.setProperty('--hold-ms', `${h.tapMs}ms`);
    btn.classList.remove('filling'); void btn.offsetWidth; btn.classList.add('filling');
    hold = { kind, btn, t: setTimeout(() => holdDone(kind), h.tapMs) };
    return;
  }
  if (src !== 'ctl' && src !== 'key') return;
  const k = src === 'ctl' ? h.ctl : h.key;
  const el = $('#hold');
  el.classList.remove('run', 'skip', 'end');
  el.classList.add(kind);
  el.style.setProperty('--hold-ms', `${h.ms}ms`);
  const test = kind === 'end' && s.inTest; // in a ramp test, B ends the test and the cool-down follows
  $('#hold-msg').textContent = test ? 'End the test?' : h.msg;
  const key = $('#hold-key');
  key.textContent = k;
  key.classList.toggle('word', k.length > 1);
  $('#hold-sub').textContent = test ? `Keep holding ${k}: cool-down next` : h.sub(k);
  el.classList.remove('hidden');
  void el.offsetWidth; // restart the fill animation
  el.classList.add('run');
  hold = { kind, t: setTimeout(() => holdDone(kind), h.ms) };
}
function holdEnd(kind) {
  if (!hold || (kind && hold.kind !== kind)) return;
  clearTimeout(hold.t);
  hold.btn?.classList.remove('filling');
  hold = null;
  $('#hold').classList.add('hidden');
  $('#hold').classList.remove('run');
}
function hideTakeover() { takeoverAnims.forEach((a) => a.cancel()); takeoverAnims = []; $('#takeover').classList.add('hidden'); }
function holdDone(kind) {
  holdEnd(kind);
  const s = app.session;
  if (!s || app.screen !== 'ride') return;
  app.controllers.forEach((c) => c.vibrate?.());
  $('#rp-sheet').classList.add('hidden');
  if (kind === 'skip') { if (s.segs) { s.skip(); toast('Skipped'); } renderRide(); }
  else if (s.inTest) { s.endTest('manual'); renderRide(); }
  else endSession();
}
// a key released while the window is in the background never sends keyup
window.addEventListener('blur', () => holdEnd());
document.addEventListener('visibilitychange', () => { if (document.hidden) holdEnd(); });

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) { if (e.key === 'Escape' && builderOpen()) closeBuilder(); return; }
  if (builderOpen() && e.key !== 'Escape') return; // Space/Enter press the builder's own buttons
  const map = { ArrowLeft: app.screen === 'ride' ? 'easier' : 'left', ArrowRight: app.screen === 'ride' ? 'harder' : 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'select', Enter: 'select', Escape: 'back', s: 'skip', l: 'lap', e: 'ergToggle', '[': 'easier', ']': 'harder', f: 'front' };
  if (app.demo && app.trainer && (e.key === '+' || e.key === '=' || e.key === '-')) {
    app.trainer.riderPower = Math.max(0, app.trainer.riderPower + (e.key === '-' ? -20 : 20));
    toast(`Demo rider: ${app.trainer.riderPower} W`);
    return;
  }
  const a = map[e.key];
  if (!a) return;
  e.preventDefault();
  if (e.repeat && (a === 'skip' || a === 'back') && app.screen === 'ride') return; // held: the first keydown started the hold
  action(a, 'key');
});
document.addEventListener('keyup', (e) => {
  if (e.key === 's') holdEnd('skip');
  else if (e.key === 'Escape') holdEnd('end');
});

function focusables() {
  const list = [];
  if (app.tab === 'workouts') {
    list.push(...$$('#today .hero-btns button'), ...$$('#wo-kind button:not(.hidden)'), ...(app.woKind === 'mine' ? [$('#btn-new-wo'), ...$$('#mine-list .wo')] : $$(app.woKind === 'slope' ? '#slope-list .wo' : '#workout-list .wo')));
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
  // quiet dots in the bottom bar; a device that is off turns red
  const dot = (label, ok) => `<span class="cx ${ok ? '' : 'off'}">${label}</span>`;
  const t = app.trainer?.state === 'connected', h = app.hr?.state === 'connected';
  const c = app.controllers.some((x) => x.state === 'connected');
  const html = dot(app.demo ? 'Demo' : 'Trainer', t || app.demo) + dot('HR', h || app.demo) + dot('Controller', c) +
    (app.session ? `<span>${app.session.mode === 'erg' ? 'ERG' : 'Slope'}</span>` : '') +
    (app.session?.maxed ? '<span class="off">Max resistance</span>' : '');
  if (el.innerHTML !== html) el.innerHTML = html;
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
const segAmount = (g) => (g.dist ? fmtDist(g.dist) : fmtTime(g.dur));

/** Remaining workout time ("~" while distance steps make it an estimate), shared by the desktop list and the phone. */
function workoutLeft(s) {
  const last = s.segs.at(-1), est = s.segs.some((g) => g.estDur && s.segs.indexOf(g) >= Math.max(0, s.segIndex));
  return s.seg ? `${est ? '~' : ''}${fmtTime(last.end - s.chartPos)}` : 'Done';
}

/**
 * Interval list (desktop, left column). Header (workout name, n/N) and footer (time left) stay put; rows scroll
 * between them. Scroll rule (Agustín, Nov 10): if every row fits nothing scrolls; otherwise the current row never
 * goes below the middle of the box, and near the end the list stops and the current row moves down.
 */
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
    const row = box.querySelector('.seg.current');
    const top = row ? Math.max(0, row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2) : box.scrollHeight;
    box.scrollTo({ top, behavior: first || reducedMotion() ? 'auto' : 'smooth' }); // the box only, never the page
  }
}
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Next card: "4:00 @ 216 W" (+ cadence target); "Finish" on the last interval; hidden when there is no next step. */
function renderNextCard(s, next, setHTML) {
  const el = $('#r-next');
  const none = !s.segs || !s.seg;
  el.classList.toggle('none', none);
  if (none) return;
  el.classList.toggle('finish', !next);
  if (!next) { el.style.setProperty('--nc', 'var(--rule)'); setHTML(el, '<div class="rt-k">Next</div><div class="amt">Finish</div>'); return; }
  el.style.setProperty('--nc', next.kind === 'erg' ? zoneHex((next.from + next.to) / 2) : gradeHex(next.grade));
  const w = (f) => Math.round(f * app.settings.ftp * s.intensity);
  const tgt = next.kind === 'erg'
    ? `<span class="num">${next.from === next.to ? w(next.from) : `${w(next.from)}-${w(next.to)}`}</span><span class="u">W</span>`
    : `<span class="num">${((next.grade + s.gradeOffset) * 100).toFixed(0)}</span><span class="u">%</span>`;
  setHTML(el, `<div class="rt-k">Next</div><div class="amt"><span class="num">${segAmount(next)}</span><span class="at">@</span>${tgt}</div><div class="cad">${next.cad ? next.cad.label : ''}</div>`);
}

/**
 * Interval change (desktop): the Next card grows over the current card, the current card pulses once as it is
 * uncovered, then a new Next card slides in from the right edge of the screen. The old current card is frozen in a
 * copy (.rt-ghost) while the real one already shows the new interval underneath.
 */
const slide = { busy: false, parts: [] };
function slideEnd() {
  slide.parts.forEach((x) => x.remove());
  slide.parts = [];
  $('#r-next').style.visibility = '';
  slide.busy = false;
}
function slideNextIn(s) {
  const card = $('#r-interval'), next = $('#r-next');
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
function segRows(s) {
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
  return { rows, cur, doneN };
}

function gearViz(gb) {
  if (gb.seq) return `gear ${gb.rear + 1}/${gb.nRear} &middot; ratio ${gb.ratio.toFixed(2)}`;
  const cogs = gb.cogsEasyFirst, max = cogs[0];
  const bars = cogs.map((c, i) => `<rect x="${i * 9}" y="${22 - (c / max) * 20}" width="6" height="${(c / max) * 20}" rx="1.5" fill="${i === gb.rear ? INK : RULE}"/>`).join('');
  const rings = gb.d.rings.map((r, i) => `<circle cx="${cogs.length * 9 + 10 + i * 14}" cy="12" r="${3 + (r / gb.d.rings.at(-1)) * 6}" fill="none" stroke="${i === gb.front ? INK : RULE}" stroke-width="2.5"/>`).join('');
  return `<svg class="gearviz" viewBox="0 0 ${cogs.length * 9 + 14 + gb.d.rings.length * 14} 24">${bars}${rings}</svg><span>ratio ${gb.ratio.toFixed(2)}</span>`;
}

function renderPaused(s) {
  $('#r-paused').classList.toggle('hidden', !s.paused);
  if (s.paused) {
    $('#r-paused-title').textContent = !s.started ? 'Ready' : 'Paused';
    $('#r-paused-sub').textContent = !s.started ? 'Start pedaling to begin' : s.autoPaused ? 'Start pedaling to resume' : isPhone() ? 'Tap Resume or press A' : 'Press A or Space to resume';
  }
}

// Interval card pulse (desktop card and phone hero): one beat when a new interval starts,
// a steady beat once per second through its last 10 seconds. Distance steps estimate the
// seconds left from current speed. Nothing pulses before the start or while paused.
function intervalEnding(s) {
  const rem = s.segRemaining;
  if (!rem || !s.started || s.paused) return false;
  if (rem.sec !== undefined) return rem.sec > 0 && rem.sec < 10.5; // the countdown reads 0:10
  return s.bike.v > 1 && rem.m > 0 && rem.m / s.bike.v < 10.5;
}
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
for (const id of ['r-interval', 'rp-hero']) {
  document.getElementById(id).addEventListener('animationend', (e) => {
    if (e.animationName === 'int-fresh') e.currentTarget.classList.remove('int-fresh');
  });
}

function renderRide() {
  const s = app.session;
  if (!s || app.screen !== 'ride') return;
  if (!isPhone()) slideNextIn(s); // before pulseCard: a slide pulses the card when it lands, not now
  pulseCard(s, isPhone() ? $('#rp-hero') : $('#r-interval'));
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
  $('#r-trip').innerHTML = `<b>${(s.bike.dist / 1000).toFixed(1)}</b> km \u00b7 <b>${(s.bike.v * 3.6).toFixed(1)}</b> km/h`;

  // interval card
  $('.tiles').classList.toggle('erg', s.mode === 'erg');
  const seg = s.seg;
  const card = $('#r-interval'), bar = $('#r-int-bar');
  const num = (v, u = '') => `<span class="num">${v}</span>${u ? `<span class="u">${u}</span>` : ''}`;
  const word = (w) => `<span class="w">${w}</span>`;
  const setHTML = (el, v) => { if (el.innerHTML !== v) el.innerHTML = v; };
  if (seg) {
    const rem = s.segRemaining;
    const left = rem.sec !== undefined ? num(fmtTime(rem.sec)) : num(fmtDist(rem.m).replace(/ (k?m)$/, ''), rem.m < 1000 ? 'm' : 'km');
    const cad = seg.cad ? ` &middot; ${seg.cad.label}` : '';
    let big, sub;
    if (seg.kind === 'erg') {
      const tgt = segTarget(seg, s.segProgress);
      const w = s.target || Math.round(tgt * app.settings.ftp * s.intensity);
      card.style.setProperty('--zc', zoneHex(tgt));
      if (seg.from === seg.to) {
        big = `${word('Hold')}${num(w, 'W')}${word('for')}${left}`;
        sub = `${Math.round(tgt * 100 * s.intensity)}% FTP${cad}`;
      } else {
        big = `${word('Ramp to')}${num(Math.round(seg.to * app.settings.ftp * s.intensity), 'W')}${word('in')}${left}`;
        sub = `now ${w} W${cad}`;
      }
    } else {
      const g = seg.grade + s.gradeOffset;
      card.style.setProperty('--zc', gradeHex(g));
      big = `${num((g * 100).toFixed(0), '%')}${word('grade for')}${left}`;
      sub = `use your gears${cad}`;
    }
    setHTML($('#r-int-label'), `${esc(seg.label)}${seg.rep ? ` ${seg.rep.i}/${seg.rep.of}` : ''}${s.ergOff && seg.kind === 'erg' ? ' (ERG off)' : ''}`);
    setHTML($('#r-int-text'), seg.text ? `${esc(seg.text)}${cad}` : sub);
    setHTML($('#r-int-big'), big);
    bar.classList.remove('hidden');
    bar.firstElementChild.style.width = `${Math.min(100, Math.max(0, s.segProgress * 100)).toFixed(2)}%`;
    renderNextCard(s, s.segs[s.segIndex + 1], setHTML);
  } else if (s.segs) {
    card.style.setProperty('--zc', ZC.z3);
    setHTML($('#r-int-label'), 'Workout complete');
    setHTML($('#r-int-text'), 'keep riding or hold B to finish');
    setHTML($('#r-int-big'), '<span class="msg">Done. Nice work.</span>');
    bar.classList.add('hidden');
    renderNextCard(s, undefined, setHTML);
  } else {
    card.style.setProperty('--zc', gradeHex(s.grade));
    setHTML($('#r-int-label'), 'Free ride');
    setHTML($('#r-int-text'), 'up/down changes the grade by 1%, shift to hold your cadence');
    setHTML($('#r-int-big'), `${num((s.grade * 100).toFixed(1), '%')}${word('grade')}`);
    bar.classList.add('hidden');
    renderNextCard(s, undefined, setHTML);
  }
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
  ctx.font = `600 ${12 * dpr}px ${NUM_FONT}`;

  const ftp = app.settings.ftp;
  const maxP = Math.max(ftp * 1.6, ...s.samples.slice(-1200).map((x) => x.power + 20));
  const Yp = (p) => H - pad - (Math.min(p, maxP) / maxP) * plotH;

  if (s.segs && isTrack(s.segs)) return drawTrack(ctx, s, { W, H, dpr, top: pad, bot: H - pad, area: 0.6, compact: false });
  if (s.segs) {
    const T = Math.max(s.segs[s.segs.length - 1].end, s.chartPos + 1);
    const X = (t) => (t / T) * W;
    for (const g of s.segs) {
      if (g.kind === 'erg') {
        ctx.fillStyle = zoneHex((g.from + g.to) / 2) + (g.end <= s.chartPos ? '66' : 'cc');
        ctx.beginPath(); ctx.moveTo(X(g.start), H - pad);
        ctx.lineTo(X(g.start), Yp(g.from * ftp * s.intensity)); ctx.lineTo(X(g.end), Yp(g.to * ftp * s.intensity));
        ctx.lineTo(X(g.end), H - pad); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = gradeHex(g.grade) + (g.end <= s.chartPos ? '66' : 'cc');
        const h = Math.max(6 * dpr, ((g.grade + 0.03) / 0.15) * plotH * 0.6);
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
    s.samples.forEach((x, i) => { const px = X(x.wx ?? x.wt), py = Yp(x.power); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    drawHrTrace(ctx, s.samples, (x) => X(x.wx ?? x.wt), W, H, pad, dpr);
    ctx.fillStyle = INK; ctx.fillRect(X(s.chartPos) - dpr, 0, 2 * dpr, H);
    return;
  }

  // free ride: last 10 minutes of power with grade underlay
  const win = 600, data = s.samples.slice(-win);
  const X = (i) => (i / win) * W;
  ctx.fillStyle = UNDERLAY;
  data.forEach((x, i) => { const g = (x.grade || 0) / 100; const h = Math.max(0, ((g + 0.03) / 0.15) * plotH * 0.6); ctx.fillRect(X(i), H - pad - h, W / win + 1, h); });
  ctx.strokeStyle = FTP_LINE; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = INK; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  data.forEach((x, i) => { i ? ctx.lineTo(X(i), Yp(x.power)) : ctx.moveTo(X(i), Yp(x.power)); });
  ctx.stroke();
  drawHrTrace(ctx, data, (x, i) => X(i), W, H, pad, dpr);
  ctx.fillStyle = MUTED; ctx.fillText('Last 10 min', 6 * dpr, 16 * dpr);
}

// ------------------------------------------------------------------ slope workouts on the ride screen
const trackCache = new WeakMap(); // session -> track(segs)
const rideTrack = (s) => { let t = trackCache.get(s); if (!t) { t = track(s.segs); trackCache.set(s, t); } return t; };
const trackKmStep = (D) => (D > 40000 ? 10 : D > 12000 ? 5 : D > 5000 ? 2 : 1);

/**
 * Slope-only workout on the ride screen (desktop and phone; Nov 11, picked by Agustín from the mockups): the road's
 * elevation over distance, filled with each stretch's grade color and faded where ridden, power and HR on top, a dot
 * where the rider is, and on a climb (3%+) a flag at the top with a tag: "618 m to the top · +37 m".
 */
function drawTrack(ctx, s, { W, H, dpr, top, bot, area, compact }) {
  const segs = s.segs, tr = rideTrack(s), ftp = app.settings.ftp, plotH = bot - top;
  const pos = trackDist(tr, segs, s.chartPos), hNow = trackHeight(tr, pos);
  const X = (d) => (d / tr.D) * W;
  const xOf = (x) => X(trackDist(tr, segs, x.wx ?? x.wt));
  const rng = Math.max(tr.hi - tr.lo, ELEV_MIN), aTop = bot - plotH * area, floor = plotH * 0.06;
  const Y = (h) => aTop + (1 - (h - tr.lo) / rng) * (bot - floor - aTop);

  // the road: ridden part faded, the rest at full strength
  segs.forEach((g, i) => {
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
  tr.parts.forEach((p, i) => (i ? ctx.lineTo(X(p.d0), Y(p.h0)) : ctx.moveTo(X(p.d0), Y(p.h0))));
  ctx.lineTo(W, Y(tr.parts.at(-1).h1)); ctx.stroke();
  ctx.globalAlpha = 1;
  if (!compact) { // km marks along the bottom
    ctx.fillStyle = MUTED; ctx.textAlign = 'center';
    const step = trackKmStep(tr.D);
    for (let k = step; k * 1000 < tr.D * 0.97; k += step) ctx.fillText(`${k} km`, X(k * 1000), bot - 5 * dpr);
    ctx.textAlign = 'left';
  }

  // FTP line, power and heart rate over the ridden part
  const maxP = Math.max(ftp * (compact ? 1.4 : 1.6), ...s.samples.slice(-1200).map((x) => x.power + 20));
  const Yp = (p) => bot - (Math.min(p, maxP) / maxP) * plotH;
  ctx.strokeStyle = FTP_LINE; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Yp(ftp)); ctx.lineTo(W, Yp(ftp)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = MUTED; ctx.fillText(`FTP ${ftp}`, (compact ? 2 : 6) * dpr, Math.max(10 * dpr, Yp(ftp) - 4 * dpr));
  ctx.strokeStyle = INK; ctx.lineWidth = (compact ? 1.8 : 2) * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  s.samples.forEach((x, i) => { const px = xOf(x), py = Yp(x.power); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
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
function trackProgress(s) {
  const tr = rideTrack(s), d = trackDist(tr, s.segs, s.chartPos);
  return `${(d / 1000).toFixed(1)} of ${(tr.D / 1000).toFixed(1)} km · +${Math.round(trackClimbed(tr, d))} of ${Math.round(tr.ascent / 5) * 5} m`;
}

// Heart rate on its own scale (at least 80-190 bpm, widened to fit).
// HR line is drawn as a trailing rolling average (display only: stored samples, FIT, averages and the live number stay raw).
// Strap jitter of a few bpm made the raw 1 Hz line spiky. 3 s (Agustín, Nov 10).
const HR_SMOOTH_S = 3;
function smoothHr(samples) {
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
function drawHrTrace(ctx, samples, xOf, W, H, pad, dpr) {
  const sm = smoothHr(samples);
  if (!sm.some((h) => h > 0)) return;
  let lo = 80, hi = 190;
  for (const h of sm) { if (!h) continue; if (h < lo + 5) lo = h - 5; if (h > hi - 5) hi = h + 5; }
  const Y = (h) => H - pad - ((h - lo) / (hi - lo)) * (H - pad * 2);
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
PHONE_MQ.addEventListener('change', () => { if (app.screen === 'ridepage' && rd.doc) renderRidePage(); });

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
    set('rp-left-k', 'Left');
    set('rp-left', seg ? workoutLeft(s) : '0:00');
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
    zc = ZC.z3;
    set('rp-int-label', 'Workout complete');
    set('rp-count', 'Done');
    set('rp-target', '');
    set('rp-target-sub', 'Keep riding. End ride is in the menu.');
  } else {
    zc = gradeHex(s.grade);
    set('rp-int-label', 'Free ride');
    set('rp-count', `${(s.grade * 100).toFixed(1)}%`);
    set('rp-target', '');
    set('rp-target-sub', 'D-pad &#9650;&#9660; changes the grade');
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
    // Position first (ring × cog, cogs counted from the largest = 1), teeth in the sub line.
    const gb = s.gb, kmh = Math.round(s.bike.v * 3.6);
    set('rp-m3', gb.seq ? gb.label : gb.isDouble ? `${gb.front + 1}×${gb.rear + 1}` : `${gb.rear + 1}`);
    set('rp-m3-sub', gb.seq ? `${kmh} km/h` : `${gb.ring}×${gb.cog} · ${kmh} km/h`);
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
  $('#rp-lap').classList.toggle('hidden', !!seg); // workouts lap every interval on their own
  $('#rp-erg').classList.toggle('hidden', !seg || (seg.kind !== 'erg' && !s.ergOff));
  set('rp-erg', s.ergOff ? 'ERG back on' : 'ERG off');

  renderPhoneView(s);
  drawPhoneChart();
}

// Chart vs list for the workout area. Remembered across rides; switchable mid-ride.
app.phoneView = ls.get('phoneView', 'chart') === 'list' ? 'list' : 'chart';
const phoneList = (s) => !!s?.segs && app.phoneView === 'list';

function renderPhoneView(s) {
  const wrap = $('#rp-wrap'), list = phoneList(s);
  wrap.classList.toggle('no-segs', !s.segs);
  wrap.classList.toggle('as-list', list);
  for (const b of $('#rp-view-tg').children) b.classList.toggle('on', b.dataset.view === (list ? 'list' : 'chart'));
  if (!s.segs) return;
  const n = s.segs.length, done = Math.min(s.segIndex < 0 ? n : s.segIndex, n);
  const k = isTrack(s.segs) ? trackProgress(s) : `Workout &middot; ${done}/${n} done`;
  const kEl = $('#rp-view-k');
  if (kEl.innerHTML !== k) kEl.innerHTML = k;
  if (!list) return;
  const { rows, cur } = segRows(s);
  const el = $('#rp-segs'), html = rows.join('');
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  if (app._rpSegI !== cur) { // keep the current interval centred when it changes (or the list was just opened)
    const jump = app._rpSegI === undefined;
    app._rpSegI = cur;
    const row = el.querySelector('.seg.current') || el.lastElementChild;
    if (row) el.scrollTo({ top: Math.max(0, row.offsetTop - (el.clientHeight - row.offsetHeight) / 2), behavior: jump ? 'auto' : 'smooth' });
  }
}

$('#rp-view-tg').onclick = (e) => {
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

/** Workout bars like Zwift: solid zone-coloured blocks, done part dimmed under the power trace. */
function drawPhoneChart() {
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
    const maxP = Math.max(ftp * 1.5, ...data.map((x) => x.power + 20));
    const Y = (v) => bot - (Math.min(v, maxP) / maxP) * plotH;
    data.forEach((x, i) => {
      const g = (x.grade || 0) / 100, h = Math.max(2 * dpr, ((g + 0.03) / 0.15) * plotH * 0.7);
      ctx.fillStyle = gradeHex(g) + '88'; ctx.fillRect((i / win) * W, bot - h, W / win + 1, h);
    });
    ctx.strokeStyle = INK; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
    data.forEach((x, i) => { const px = (i / win) * W; i ? ctx.lineTo(px, Y(x.power)) : ctx.moveTo(px, Y(x.power)); });
    ctx.stroke();
    drawHrTrace(ctx, data, (x, i) => (i / win) * W, W, H, top, dpr);
    ctx.fillStyle = MUTED; ctx.fillText('Last 10 min', 2 * dpr, 10 * dpr);
    return;
  }

  if (isTrack(s.segs)) return drawTrack(ctx, s, { W, H, dpr, top, bot, area: 0.7, compact: true });
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
  s.samples.forEach((x, i) => { const px = X(x.wx ?? x.wt), py = Yp(x.power); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
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
rpTap('rp-minus', () => action(app.session?.mode === 'erg' ? 'down' : 'easier'));
rpTap('rp-plus', () => action(app.session?.mode === 'erg' ? 'up' : 'harder'));
rpTap('rp-pause', () => app.session?.togglePause());
rpTap('rp-more', () => $('#rp-sheet').classList.toggle('hidden'));
rpTap('rp-sheet-close', () => $('#rp-sheet').classList.add('hidden'));
rpTap('rp-gdown', () => action('down'));
rpTap('rp-gup', () => action('up'));
rpTap('rp-lap', () => { action('lap'); $('#rp-sheet').classList.add('hidden'); });
$('#r-erg').onclick = (e) => { e.currentTarget.blur(); action('ergToggle'); };
rpTap('rp-erg', () => { action('ergToggle'); $('#rp-sheet').classList.add('hidden'); });
rpTap('rp-theme', () => { setTheme(app.theme === 'dark' ? 'light' : 'dark'); $('#rp-sheet').classList.add('hidden'); });
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
bindHold('rp-skip', 'skip');
bindHold('rp-end', 'end');

// ------------------------------------------------------------------ workout messages
// Timed messages from the workout (session 'message' events) float over the top of the ride chart.
// One at a time: a new one waits until the current one has been up for at least MSG_MIN ms,
// except the first message of a new step, which replaces the old step's message right away.
const MSG_MIN = 3500;
const rideMsgQ = { list: [], shownAt: 0, timer: 0, stale: false };
const msgMs = (t) => Math.min(11000, Math.max(5000, 2500 + t.length * 70));
function rideMsgReset() {
  clearTimeout(rideMsgQ.timer); rideMsgQ.list = []; rideMsgQ.shownAt = 0; rideMsgQ.stale = false;
  const el = $('#r-msg'); el.classList.remove('show'); el.textContent = '';
}
function rideMsg(text) {
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
function lastTestBest() {
  const t = (app.rows || []).filter((r) => !r.demo && r.summary?.workoutId === 'ramp-test' && r.summary.bests?.[60])
    .sort((a, b) => String(a.summary.start).localeCompare(String(b.summary.start))).at(-1);
  return t ? t.summary.bests[60] : null;
}
function testStep(s) {
  const g = s.seg;
  if (!s.test || !g?.untilFail) return;
  const n = s.segs.slice(0, s.segIndex + 1).filter((x) => x.untilFail).length;
  const watts = Math.round(g.from * s.s.ftp * s.intensity);
  const cue = stepCue({ n, watts, ftp: s.s.ftp, prevBest: s.test.prevBest, name: app.settings.riderName, st: s.test.st });
  if (cue.finish && !g.msgs.some((m) => m.text === cue.finish)) g.msgs.push({ t: Math.max(0, g.dur - 15), text: cue.finish });
  if (cue.takeover) takeover(cue.takeover, { color: zoneHex(g.from) });
  if (cue.msg) rideMsg(cue.msg);
}
function testEnded(s, e) {
  app.controllers.forEach((c) => c.vibrate?.());
  const best60 = bestAvg(s.samples.map((x) => x.power), 60);
  const r = resultCue({ best60, ftp: s.s.ftp, name: app.settings.riderName });
  s.test.result = r;
  takeover(r.takeover, { dark: true, hold: 4500 }).then(() => rideMsg(r.msg));
}
let takeoverAnims = [];
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
    const kids = [['#to-line', 0.06], ['#to-big', 0], ['#to-sub', 0.1]];
    kids.forEach(([sel, d]) => takeoverAnims.push($(sel).animate([
      { opacity: 0, transform: 'translateY(18px) scale(.94)' }, { opacity: 0, transform: 'translateY(18px) scale(.94)', offset: a * 0.6 + d * a },
      { opacity: 1, transform: 'none', offset: Math.min(b - 0.02, a * 1.5 + d * a), easing: 'ease-out' },
      { opacity: 1, transform: 'none', offset: b - a * 0.25 }, { opacity: 0, transform: 'scale(.97)', offset: b }, { opacity: 0 },
    ], { duration: total })));
    takeoverAnims.push($('#to-big').animate([{ scale: 1 }, { scale: 1, offset: a * 1.6 }, { scale: 1.06, offset: a * 2.1 }, { scale: 1, offset: a * 2.8 }, { scale: 1 }], { duration: total, composite: 'add' }));
  }
  return grow.finished.then(() => { el.classList.add('hidden'); takeoverAnims = []; }, () => {});
}

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

// ------------------------------------------------------------------ modal
// In-app replacement for alert()/confirm(), which open as browser windows.
// ask() resolves true (OK) or false (Cancel, Esc, controller B, tap outside).
// tell() is the one-button version. Never use alert/confirm/prompt in this app.
let modalDone = null, modalFocus = 0;
const modalOpen = () => !!modalDone;
const modalBtns = () => $$('#modal .modal-btns button:not(.hidden)');
function ask(text, { title = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  modalDone?.(false);
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text;
  $('#modal-text').classList.toggle('hidden', !text);
  $('#modal-ok').textContent = ok;
  $('#modal-cancel').textContent = cancel || '';
  $('#modal-cancel').classList.toggle('hidden', !cancel);
  $('#modal').classList.remove('hidden');
  // destructive questions start on Cancel so a stray A / Enter is harmless
  modalFocus = danger && cancel ? 0 : modalBtns().length - 1;
  setModalFocus();
  return new Promise((resolve) => {
    modalDone = (v) => { modalDone = null; $('#modal').classList.add('hidden'); $$('#modal .focus').forEach((x) => x.classList.remove('focus')); resolve(v); };
  });
}
const tell = (text, title = '') => ask(text, { title, cancel: null });
function setModalFocus() {
  const btns = modalBtns();
  btns.forEach((b, i) => b.classList.toggle('focus', i === modalFocus && !!app.usedNav));
  btns[modalFocus]?.focus({ preventScroll: true });
}
function modalAction(a) {
  app.usedNav = true; // keyboard or controller: show which button A / Enter will press
  const btns = modalBtns();
  switch (a) {
    case 'left': case 'up': case 'easier': modalFocus = 0; setModalFocus(); break;
    case 'right': case 'down': case 'harder': modalFocus = btns.length - 1; setModalFocus(); break;
    case 'select': (btns.includes(document.activeElement) ? document.activeElement : btns[modalFocus])?.click(); break;
    case 'back': modalDone?.(btns.length < 2); break;
  }
}
$('#modal-ok').onclick = () => modalDone?.(true);
$('#modal-cancel').onclick = () => modalDone?.(false);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') modalDone?.(modalBtns().length < 2); });

// ------------------------------------------------------------------ settings
// One tab per section. Number fields: [key, label, step, mult, help, offset].
const SET_TABS = {
  rider: [['ftp', 'FTP (W)', 1], ['riderKg', 'Rider weight (kg)', 0.1], ['bikeKg', 'Bike weight (kg)', 0.1, 1, 'All settings are saved to your plan, so every device gets them.']],
  ride: [['autoPauseSec', 'Auto-pause after (s, 0 = off)', 1, 1, 'ERG: no pedaling. Slope: bike stopped.']],
  gearing: [],
  road: [
    ['gradeScale', 'Grade realism (%)', 5, 100, 'Zwift defaults to 50%. 100% = real climbs. Descents are always 100%.'],
    ['cda', 'CdA (m²)', 0.01, 1, 'Aero drag. 0.32 hoods, 0.25 drops.'], ['crr', 'Rolling resistance', 0.001],
  ],
  trainer: [],
};
const SET_TAB_IDS = ['rider', 'ride', 'gearing', 'road', 'trainer', 'sync'];
const numField = ([k, label, step, mult = 1, help, offset = 0]) =>
  `<label for="set-${k}">${label}</label><input id="set-${k}" type="number" step="${step}" value="${+((app.settings[k] * mult + offset).toFixed(3))}" data-k="${k}" data-mult="${mult}" data-off="${offset}">${help ? `<div class="help">${help}</div>` : ''}`;
const nameField = () => `<label for="set-name">Your name</label><input id="set-name" type="text" maxlength="30" autocomplete="given-name" value="${esc(app.settings.riderName || '')}" placeholder="First name">
  <div class="help">The coach uses it in workout messages.</div>`;
// ---- gearing: a known drivetrain, or your own chainrings and cogs
function dtOptions() {
  const groups = {};
  for (const [k, d] of Object.entries(DRIVETRAINS)) (groups[d.group] ||= []).push(`<option value="${k}">${esc(d.name)}</option>`);
  return Object.entries(groups).map(([g, o]) => `<optgroup label="${esc(g)}">${o.join('')}</optgroup>`).join('') +
    `<option value="${CUSTOM}">Custom (your own chainrings and cogs)</option>`;
}
/** The chainrings/cogs in use: the preset's, or the custom ones. */
function dtSpec() {
  const st = app.settings;
  if (st.drivetrain === CUSTOM) { const r = checkSpec(st.customDrivetrain || {}); if (r.spec) return r.spec; }
  return DRIVETRAINS[st.drivetrain] || DRIVETRAINS[DEFAULT_SETTINGS.drivetrain];
}
function dtSummary(d) {
  if (d.seq) return `${speeds(d)}, ratios ${d.seq[0].toFixed(2)} to ${d.seq.at(-1).toFixed(2)}. Takes effect on the next ride.`;
  const lo = d.rings[0], hi = d.rings.at(-1), big = d.cogs.at(-1), small = d.cogs[0];
  return `${speeds(d)}. Easiest ${lo}\u00d7${big} (${(lo / big).toFixed(2)}), hardest ${hi}\u00d7${small} (${(hi / small).toFixed(2)}). Takes effect on the next ride.`;
}
function fillDrivetrain() {
  const st = app.settings, d = dtSpec();
  $('#set-dt').value = st.drivetrain === CUSTOM && checkSpec(st.customDrivetrain || {}).spec ? CUSTOM : (DRIVETRAINS[st.drivetrain] ? st.drivetrain : DEFAULT_SETTINGS.drivetrain);
  $('.dt-fields').classList.toggle('hidden', !!d.seq);
  if (!d.seq) {
    $('#set-rings').value = [...d.rings].reverse().join('/');
    $('#set-cogs').value = d.cogs.join('-');
    const w = WHEELS.reduce((a, b) => (Math.abs(b[0] - d.wheel) < Math.abs(a[0] - d.wheel) ? b : a));
    $('#set-wheel').value = String(w[0]);
  }
  $('#dt-sum').textContent = dtSummary(d);
}
function pickDrivetrain(id) {
  if (id === CUSTOM) {
    // start from what's on screen (or the last preset) so there's something to edit
    const d = dtSpec();
    app.settings.customDrivetrain = d.seq ? { ...DRIVETRAINS[DEFAULT_SETTINGS.drivetrain] } : { rings: d.rings, cogs: d.cogs, wheel: d.wheel };
    delete app.settings.customDrivetrain.group; delete app.settings.customDrivetrain.name;
  }
  app.settings.drivetrain = id;
  fillDrivetrain();
  if (id === CUSTOM) $('#set-rings').focus();
}
/** Reads the chainring/cog fields. Saves only a valid set; returns false (and says why) otherwise. */
function editDrivetrain() {
  const r = checkSpec({ rings: parseTeeth($('#set-rings').value), cogs: parseTeeth($('#set-cogs').value), wheel: Number($('#set-wheel').value) });
  if (r.error) { $('#dt-sum').textContent = `Not saved yet. ${r.error}`; return false; }
  const id = presetFor(r.spec);
  if (id) app.settings.drivetrain = id;
  else { app.settings.drivetrain = CUSTOM; app.settings.customDrivetrain = r.spec; }
  $('#set-dt').value = app.settings.drivetrain;
  $('#dt-sum').textContent = dtSummary(r.spec);
  return true;
}

// ---- trainer: the grade range it can simulate
function trainerOptions() {
  return Object.entries(TRAINERS).map(([k, t]) => `<option value="${k}">${esc(t.name)}</option>`).join('') +
    `<option value="${CUSTOM_TRAINER}">Other (set the range yourself)</option>`;
}
const pct = (x) => +((x * 100).toFixed(1));
function fillTrainer() {
  const st = app.settings;
  const id = TRAINERS[st.trainerModel] && trainerFits(st.trainerModel, st.minSendGrade, st.maxSendGrade) ? st.trainerModel : CUSTOM_TRAINER;
  $('#set-trainer').value = id;
  $('#set-gmax').value = pct(st.maxSendGrade);
  $('#set-gmin').value = pct(st.minSendGrade);
}
function pickTrainer(id) {
  app.settings.trainerModel = id;
  const t = TRAINERS[id];
  if (t) { app.settings.maxSendGrade = t.max; app.settings.minSendGrade = t.min; }
  fillTrainer();
}
function editGradeRange() {
  const mx = $('#set-gmax').value, mn = $('#set-gmin').value;
  if (mx === '' || mn === '') return false;
  const r = cleanRange(Number(mn) / 100, Number(mx) / 100);
  app.settings.maxSendGrade = r.max;
  app.settings.minSendGrade = r.min;
  const cur = app.settings.trainerModel;
  app.settings.trainerModel = TRAINERS[cur] && trainerFits(cur, r.min, r.max) ? cur : trainerFor(r.min, r.max) || CUSTOM_TRAINER;
  $('#set-trainer').value = app.settings.trainerModel;
  return true;
}
/** First trainer connection with no trainer chosen yet: use the range of the model it reports. */
function detectTrainer(dev) {
  if (app.settings.trainerModel || app.demo) return;
  const id = matchTrainer(dev?.device?.name);
  if (!id) return;
  pickTrainer(id);
  saveSettings();
  const t = TRAINERS[id];
  toast(`${t.name}: grades from ${pct(t.min)}% to ${pct(t.max)}% (Settings > Trainer)`);
}
function renderSettings() {
  const f = $('#settings-form');
  const extra = {
    ride: `<label for="set-guard">ERG low-cadence guard</label><select id="set-guard"><option value="1">On</option><option value="0">Off</option></select>
      <div class="help">If cadence drops under 40 rpm in ERG, the target eases to 60% until you're spinning again.</div>`,
    gearing: `<label for="set-dt">Drivetrain</label><select id="set-dt" class="wide-select">${dtOptions()}</select>
      <div class="dt-fields">
        <label for="set-rings">Chainrings (teeth)</label><input id="set-rings" type="text" inputmode="numeric" autocomplete="off" placeholder="50/34">
        <label for="set-cogs">Cogs (teeth)</label><input id="set-cogs" class="wide-input" type="text" inputmode="numeric" autocomplete="off" placeholder="11-12-13-14-15-17-19-21-24-27-30-34">
        <label for="set-wheel">Wheel</label><select id="set-wheel">${WHEELS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select>
      </div>
      <div class="help" id="dt-sum"></div>
      <label for="set-style">Shifting style</label><select id="set-style"><option value="sram">SRAM</option><option value="shimano">Shimano</option></select>
      <div class="help">SRAM: right = harder, left = easier, both together = front shift. Shimano: right buttons = rear harder/easier, left buttons = big/small ring. Takes effect on the next ride.</div>`,
    trainer: `<label for="set-trainer">Trainer</label><select id="set-trainer" class="wide-select">${trainerOptions()}</select>
      <label for="set-gmax">Max grade (%)</label><input id="set-gmax" type="number" step="1" min="1" max="40">
      <label for="set-gmin">Min grade (%)</label><input id="set-gmin" type="number" step="1" min="-30" max="0">
      <div class="help">From the trainer's spec. Rodillo never sends a grade outside this range; past the max you'll see Max resistance. Brake trainers can't push you downhill: below 0% they just get as light as they can.</div>
      ${numField(['realDev', 'Real development (m / crank rev)', 0.01, 1, 'What the trainer reports per pedal turn; learned while riding.'])}
      <div class="help" id="tm-line">Slope correction learned from your trainer: ${((app.settings.gradeTrim || 0) * 100).toFixed(1)}% grade. <a href="#" id="tm-reset">Reset</a></div>`,
  };
  f.innerHTML = Object.entries(SET_TABS).map(([id, fields]) =>
    `<div class="settings-form stab-pane hidden" data-pane="${id}">${id === 'rider' ? nameField() : ''}${fields.map(numField).join('')}${extra[id] || ''}</div>`).join('');
  $('#set-guard').value = app.settings.ergCadenceGuard ? '1' : '0';
  $('#tm-reset').onclick = (e) => { e.preventDefault(); app.settings.gradeTrim = 0; app.settings.realDev = DEFAULT_SETTINGS.realDev; saveSettings(); renderSettings(); };
  fillDrivetrain();
  fillTrainer();
  $('#set-style').value = app.settings.shiftStyle || 'sram';
  f.oninput = (e) => {
    const el = e.target;
    if (el.id === 'set-name') app.settings.riderName = el.value.trim();
    else if (el.id === 'set-guard') app.settings.ergCadenceGuard = el.value === '1';
    else if (el.id === 'set-dt') pickDrivetrain(el.value);
    else if (['set-rings', 'set-cogs', 'set-wheel'].includes(el.id)) { if (!editDrivetrain()) return; }
    else if (el.id === 'set-trainer') pickTrainer(el.value);
    else if (el.id === 'set-gmax' || el.id === 'set-gmin') { if (!editGradeRange()) return; }
    else if (el.id === 'set-style') app.settings.shiftStyle = el.value;
    else if (el.dataset.k && el.value !== '') app.settings[el.dataset.k] = (Number(el.value) - Number(el.dataset.off)) / Number(el.dataset.mult);
    saveSettings();
  };
  // tidy the typed teeth / grades once the field is left (only when they were valid)
  f.onchange = (e) => {
    if (['set-rings', 'set-cogs'].includes(e.target.id) && !$('.dt-fields').classList.contains('hidden') && editDrivetrain()) fillDrivetrain();
    if (['set-gmax', 'set-gmin'].includes(e.target.id)) fillTrainer();
  };
  setSetTab(ls.get('setTab', 'rider'));
}
/** Shows one settings tab; remembered per browser. */
function setSetTab(id, animate = false) {
  if (!SET_TAB_IDS.includes(id)) id = 'rider';
  const prev = $('#set-tabs button.active')?.dataset.stab;
  $$('#set-tabs button').forEach((b) => { const on = b.dataset.stab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('#settings .stab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== id));
  const btn = $(`#set-tabs [data-stab="${id}"]`);
  placeInk($('#set-tabs'), btn);
  btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (animate && prev && prev !== id) slideIn($(`#settings [data-pane="${id}"]`), SET_TAB_IDS.indexOf(id) > SET_TAB_IDS.indexOf(prev) ? 1 : -1);
  ls.set('setTab', id);
}

// ------------------------------------------------------------------ controls (own panel, top-bar gamepad)
function renderControls() {
  const sram = (app.settings.shiftStyle || 'sram') === 'sram';
  const rows = [
    ['Riding'],
    ['Start / pause', 'A', 'Space'],
    ['End ride (hold 5 s)', 'Hold B', 'Hold Esc'],
    ['Skip interval (hold 3 s)', 'Hold Y', 'Hold S'],
    ['Lap (free ride; workouts lap every interval)', 'Z', 'L'],
    ['Slope'],
    ['Rear: easier / harder', sram ? 'Left side / right side' : 'Right shift-down / shift-up', '&larr; / &rarr;'],
    ['Front shift (2x)', sram ? 'Left + right together' : 'Left shift-up / shift-down', 'F'],
    ['Grade &plusmn;1%', 'D-pad up / down', '&uarr; / &darr;'],
    ['ERG'],
    ['Effort &plusmn;1% (hold to repeat)', 'Left shifters &minus; / right shifters + (also D-pad)', '&larr; / &rarr; or &darr; / &uarr;'],
    ['ERG off / back on (stays off until you turn it on)', 'ERG off button on screen', 'E'],
    ['Menus'],
    ['Move / select / back', 'D-pad / A / B', '&uarr;&darr; / Enter / Esc'],
    ['Switch home tabs', 'D-pad left / right', '&larr; / &rarr;'],
  ];
  $('#controls-body').innerHTML =
    `<p class="muted ctl-style">Shifting: ${sram ? 'SRAM' : 'Shimano'} style. <a href="#" data-open-settings="gearing">Change</a></p>
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
document.addEventListener('click', (e) => { if (devPopOpen() && !e.target.closest('#devpop, #btn-devices, #modal')) setDevPop(false); });
setWoKind(app.woKind);
initBuilder({
  esc, ask, placeInk, profileSvg, woMeta, zoneHex, gradeHex, plannedOn, signedIn,
  ftp: () => app.settings.ftp,
  maxMinutes: () => app.plan?.maxMinutes || 0,
  onSave: saveMine,
  onDelete: deleteMine,
  onRide: (id) => { const w = app.library.find((x) => x.id === id); if (w) startWorkout(w); },
});
$('#btn-new-wo').onclick = () => { setDevPop(false); if (signedIn()) openBuilder(null); };
if (inkObserver) { inkObserver.observe($('#wo-kind')); inkObserver.observe($('#tabs')); }
placeInk($('#tabs'), $('#tabs button.active'));
$$('#wo-kind button').forEach((b) => (b.onclick = () => { setWoKind(b.dataset.kind, true); app.focus = Math.max(0, focusables().indexOf(b)); applyFocus(); }));
// "Settings" links in notices open the panel (the top-bar button is just a gear)
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open-settings]');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.openSettings) ls.set('setTab', a.dataset.openSettings);
  $$('.panel').forEach((p) => p.classList.add('hidden'));
  $('#btn-settings').click();
});
$$('#set-tabs button').forEach((b) => (b.onclick = () => setSetTab(b.dataset.stab, true)));
if (inkObserver) inkObserver.observe($('#set-tabs'));
$('#btn-controls').onclick = () => {
  setDevPop(false);
  $('#settings').classList.add('hidden');
  renderControls();
  $('#controls').classList.remove('hidden');
};
$('#btn-settings').onclick = () => {
  renderSettings();
  const cfg = ls.get('sync', {});
  $('#set-token').value = cfg.token || '';
  $('#set-repo').value = cfg.repo || DEFAULT_REPO;
  $('#token-status').textContent = cfg.token ? 'Token saved' : '';
  renderSignIn();
  setDevPop(false);
  $('#controls').classList.add('hidden');
  $('#settings').classList.remove('hidden');
  setSetTab(ls.get('setTab', 'rider'));
};
$('#btn-token').onclick = async () => {
  const token = $('#set-token').value.trim();
  const repo = $('#set-repo').value.trim() || DEFAULT_REPO;
  const st = $('#token-status');
  if (!token) { ls.set('sync', { repo }); st.textContent = 'Sync turned off'; closeBuilderNow(); applyLibrary(); return; }
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
// ------------------------------------------------------------------ history import (Settings > Sync)
// Strava / Garmin export or loose activity files -> rides in rodillo-data, in one commit.
$('#imp-file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const st = $('#imp-status'), btn = $('#imp-btn');
  const gh = syncClient();
  if (!gh) { tell(`${syncHint()} above first: imported rides go to rodillo-data.`, 'Not connected'); return; }
  btn.classList.add('busy');
  try {
    const { scanFiles, buildImport, IMPORT_DAYS } = await import('./importer.js?v=202611102147');
    const since = Date.now() - IMPORT_DAYS * 864e5;
    st.textContent = 'Opening...';
    const { found, skip } = await scanFiles(files, { since, onProgress: (a, b) => { st.textContent = `Reading ${a} of ${b} activities...`; } });
    st.textContent = 'Checking your history...';
    const existing = await gh.fetchIndex();
    const rhrs = Object.values(app.whoop || {}).map((d) => d.rhr).filter(Boolean).sort((a, b) => a - b);
    const restHr = rhrs.length ? rhrs[Math.floor(rhrs.length / 2)] : 55;
    const { docs, stats, hrCfg, withPower } = buildImport(found, existing, { ftp: app.settings.ftp, restHr });
    const skipped = [
      stats.already && `${stats.already} already in Rodillo`, stats.dupes && `${stats.dupes} recorded twice`,
      skip.old && `${skip.old} older than 6 months`, skip.notRide && `${skip.notRide} not rides`, skip.ebike && `${skip.ebike} e-bike`,
      (stats.short + stats.noData) && `${stats.short + stats.noData} too short or without power and heart rate`, skip.unreadable && `${skip.unreadable} unreadable`,
    ].filter(Boolean).join(', ');
    if (!docs.length) { st.textContent = ''; tell(`No new rides to add.${skipped ? ` Skipped: ${skipped}.` : ''}`, 'Nothing to import'); return; }
    const day = (d) => new Date(d.summary.start).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const hrOnly = docs.length - withPower;
    const msg = `${day(docs[0])} to ${day(docs.at(-1))}: ${withPower} with power (TSS at your FTP of ${app.settings.ftp} W)${hrOnly ? `, ${hrOnly} with heart rate only (TSS from heart rate, threshold ${hrCfg.lthr} bpm, resting ${hrCfg.rest})` : ''}.${skipped ? ` Skipped: ${skipped}.` : ''}`;
    st.textContent = '';
    if (!(await ask(msg, { title: `Add ${docs.length} ride${docs.length > 1 ? 's' : ''} to your history?`, ok: 'Import' }))) return;
    st.textContent = 'Saving to rodillo-data...';
    const index = await gh.pushRides(docs, `Import ${docs.length} rides (${day(docs[0])} to ${day(docs.at(-1))})`, (a, b) => { st.textContent = `Saving ${a} of ${b}...`; });
    ls.set('remoteIndex', index.rides); ls.set('remoteIndexAt', Date.now());
    st.textContent = `Imported ${docs.length} rides.`;
    if (app.tab === 'training') renderTraining();
    refreshPlanViews();
  } catch (err) {
    logMsg('sync', `import failed: ${err.message}`);
    st.textContent = '';
    tell(err.message, 'Import failed');
  } finally { btn.classList.remove('busy'); }
};
// GitHub sign-in row at the top of the Sync tab (hidden until AUTH_URL is set in js/auth.js).
function renderSignIn(msg = '') {
  const el = $('#gh-signin');
  el.classList.toggle('hidden', !authEnabled());
  if (!authEnabled()) return;
  const s = authSession();
  el.innerHTML = s
    ? `<span>Signed in as <b>${esc(s.login || 'GitHub user')}</b></span> <button class="ghost small" id="btn-gh-out">Sign out</button>${msg ? ` <span class="muted">${esc(msg)}</span>` : ''}`
    : `<button class="primary small" id="btn-gh-in">Sign in with GitHub</button> <span class="muted">${esc(msg || 'Once per browser, about twice a year.')}</span>`;
  if ($('#btn-gh-in')) $('#btn-gh-in').onclick = startSignIn;
  if ($('#btn-gh-out')) $('#btn-gh-out').onclick = () => { signOut(); renderSignIn('Signed out on this browser'); renderHero(); closeBuilderNow(); applyLibrary(); };
  $('#token-label').textContent = s ? 'Or use a token (not needed while signed in)' : 'Or paste a token instead';
}
// ------------------------------------------------------------------ theme (light default, dark optional; index.html sets it before first paint)
function setTheme(t) {
  app.theme = t === 'dark' ? 'dark' : 'light';
  ls.set('theme', app.theme);
  document.documentElement.dataset.theme = app.theme;
  document.querySelector('meta[name="theme-color"]').content = app.theme === 'dark' ? '#0c0e0d' : '#e6e9e5';
  const label = app.theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('#btn-theme').title = `Switch to ${label.toLowerCase()}`;
  $('#btn-theme').setAttribute('aria-label', label);
  $('#rp-theme').textContent = label;
  readTokens();
  if (app.tab === 'training') renderTraining();
  if (app.screen === 'ride') renderRide();
  if (app.screen === 'ridepage') drawRideChart();
}
setTheme(ls.get('theme', 'light'));
$('#btn-theme').onclick = () => setTheme(app.theme === 'dark' ? 'light' : 'dark');
$('#btn-log').onclick = () => { setDevPop(false); $('#log-body').textContent = logLines.join('\n'); $('#log').classList.remove('hidden'); };
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('.panel').classList.add('hidden')));
$('#btn-diag').onclick = async () => {
  for (const d of [app.trainer, app.hr, ...app.controllers]) {
    if (!d?.listServices || d.state !== 'connected') continue;
    logMsg(d.kind, `${d.name} ${JSON.stringify(d.info)} services: ${(await d.listServices()).join(', ')}`);
  }
  if (app.trainer?.data) logMsg('trainer', `last data ${JSON.stringify(app.trainer.data)}`);
};
const TABS = ['workouts', 'calendar', 'training'];
function setTab(t) {
  const prev = app.tab;
  app.tab = t; app.focus = 0;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${t}`));
  placeInk($('#tabs'), $('#tabs button.active'));
  if (prev && prev !== t) slideIn($(`#tab-${t}`), TABS.indexOf(t) > TABS.indexOf(prev) ? 1 : -1);
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
window.rodillo = app; // for debugging from the console
