import { Trainer } from './ble/trainer.js';
import { HeartRate } from './ble/hr.js';
import { ZwiftRide } from './ble/zwiftride.js';
import { SimTrainer, SimHr } from './ble/sim.js';
import { log, logMsg } from './ble/base.js';
import { Session, DEFAULT_SETTINGS } from './engine/session.js';
import { GEAR_RATIOS } from './engine/physics.js';
import { flatten, totalDuration, estimateTSS, parseZwo, segTarget } from './engine/workout.js';
import { parseGpx } from './engine/route.js';
import { encodeActivity, statsFor } from './fit.js';
import { ls, rides } from './store.js';

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
  library: [], routes: ls.get('routes', []), plan: null,
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
      const c = new ZwiftRide();
      bindDevice(c);
      c.on('press', (b) => onButton(b));
      c.on('release', onRelease);
      app.controllers.push(c);
      await c.pick(ZwiftRide.requestOptions());
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
      else if (ids.ctl.includes(d.id)) { obj = new ZwiftRide(); obj.on('press', onButton); obj.on('release', onRelease); app.controllers.push(obj); }
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
  card('controller', ctl, names.length > 1 ? `<br>${names.length} connected` : '');
  $('[data-connect="controller2"]').classList.toggle('hidden', !app.controllers.some((c) => c.state === 'connected'));
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
    app.library = list.filter(Boolean);
    src.textContent = `${app.library.length} workouts from the coach library`;
  } catch {
    app.library = [];
    src.textContent = 'Could not load the coach library (open the app from its GitHub Pages URL).';
  }
  for (const w of ls.get('imported', [])) app.library.push(w);
  try { app.plan = await (await fetch('plans/current.json', { cache: 'no-cache' })).json(); } catch { app.plan = null; }
  renderLibrary();
  renderToday();
}

function profileSvg(w, width = 340, height = 54) {
  const segs = flatten(w);
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
  const mins = Math.round(totalDuration(w) / 60);
  const tss = estimateTSS(w);
  return `${mins} min${isSim(w) ? '' : ` &middot; TSS ~${tss}`}`;
}

function renderLibrary() {
  const el = $('#workout-list');
  el.innerHTML = app.library.map((w, i) => `
    <div class="wo" data-i="${i}" tabindex="0">
      <div class="wo-top"><div class="wo-name">${esc(w.name)}</div><div class="wo-meta">${woMeta(w)}</div></div>
      ${profileSvg(w)}
      <div>${isSim(w) ? '<span class="tag sim">slope + gears</span>' : '<span class="tag">ERG</span>'}${(w.tags || []).filter((t) => !['sim'].includes(t)).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="wo-desc">${esc(w.description)}</div>
      <div class="start-row"><button class="primary small" data-start="${i}">Start</button>${w.tags?.includes('imported') ? `<button class="ghost small" data-remove="${i}">Remove</button>` : ''}</div>
    </div>`).join('');
  el.querySelectorAll('.wo').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.dataset.start) return startWorkout(app.library[+e.target.dataset.start]);
    if (e.target.dataset.remove) return removeImported(app.library[+e.target.dataset.remove]);
    c.classList.toggle('expanded');
  }));
  applyFocus();
}

function renderToday() {
  const el = $('#today');
  const key = new Date().toLocaleDateString('en-CA');
  const id = app.plan?.days?.[key];
  const w = id && app.library.find((x) => x.id === id);
  if (!w) {
    const note = app.plan?.days?.[key] === 'rest' ? 'Rest day. Lift, walk, sleep.' : null;
    el.classList.toggle('hidden', !note);
    if (note) el.innerHTML = `<div><div class="eyebrow">Today</div><h2>${note}</h2></div>`;
    return;
  }
  el.classList.remove('hidden');
  const note = app.plan.notes?.[key] || '';
  el.innerHTML = `
    <div><div class="eyebrow">Today &middot; ${esc(app.plan.name || 'Plan')}</div><h2>${esc(w.name)}</h2>
    <p>${esc(note || w.description)}</p></div>
    <div>${profileSvg(w, 340, 60)}<div class="muted" style="font-size:13px;margin-top:4px">${woMeta(w)}</div></div>
    <button class="primary" id="btn-today">Start</button>`;
  $('#btn-today').onclick = () => startWorkout(w);
  el.dataset.workout = w.id;
}

function removeImported(w) {
  ls.set('imported', ls.get('imported', []).filter((x) => x.id !== w.id));
  app.library = app.library.filter((x) => x !== w);
  renderLibrary();
}

function renderRoutes() {
  $('#route-list').innerHTML = app.routes.map((r, i) => `
    <div class="route"><div><b>${esc(r.name)}</b><div class="muted" style="font-size:13px">${(r.total / 1000).toFixed(1)} km &middot; ${Math.round(r.gain)} m climbing</div></div>
    <div class="row-btns"><button class="primary small" data-route="${i}">Ride</button><button class="ghost small" data-delroute="${i}">Remove</button></div></div>`).join('');
  $$('[data-route]').forEach((b) => (b.onclick = () => startRoute(app.routes[+b.dataset.route])));
  $$('[data-delroute]').forEach((b) => (b.onclick = () => { app.routes.splice(+b.dataset.delroute, 1); ls.set('routes', app.routes); renderRoutes(); }));
}

async function renderHistory() {
  let list = [];
  try { list = await rides.list(); } catch { /* no idb */ }
  $('#history-list').innerHTML = list.length ? `<table><tr><th>Date</th><th>Ride</th><th>Time</th><th>Avg / NP</th><th>HR</th><th>TSS</th><th></th></tr>
    ${list.map((r) => `<tr><td>${new Date(r.id).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${esc(r.name)}${r.status === 'inprogress' ? ' <span class="muted">(interrupted)</span>' : ''}</td><td>${fmtTime(r.summary?.timer || r.summary?.elapsed || 0)}</td>
    <td>${r.summary?.avgPower ?? '-'} / ${r.summary?.np ?? '-'} W</td><td>${r.summary?.avgHr ?? '-'}</td><td>${r.summary?.tss ?? '-'}</td>
    <td><button class="ghost small" data-fit="${r.id}">.FIT</button> <button class="ghost small" data-del="${r.id}">Delete</button></td></tr>`).join('')}</table>`
    : '<p class="muted">No rides yet.</p>';
  $$('[data-fit]').forEach((b) => (b.onclick = async () => downloadFit(await rides.get(+b.dataset.fit))));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this ride?')) { await rides.del(+b.dataset.del); renderHistory(); } }));
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

$('#import-gpx').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    try {
      const r = parseGpx(await f.text());
      if (r.name === 'Route') r.name = f.name.replace(/\.gpx$/i, '');
      r.ele = r.ele.map((x) => Math.round(x * 10) / 10);
      r.grade = r.grade.map((x) => Math.round(x * 10000) / 10000);
      app.routes.push(r);
      ls.set('routes', app.routes);
    } catch (err) { alert(`Could not read ${f.name}: ${err.message}`); }
  }
  e.target.value = '';
  renderRoutes();
});

// ------------------------------------------------------------------ rides
function canRide() {
  if (app.trainer && (app.trainer.state === 'connected')) return true;
  return confirm('No trainer connected. Start anyway? (Use Demo mode to try without hardware.)');
}
function startWorkout(w) { if (canRide()) beginSession({ workout: w }); }
function startFree() { if (canRide()) beginSession({}); }
function startRoute(r) { if (canRide()) beginSession({ route: r }); }

let wakeLock = null;
function beginSession(opts) {
  const trainer = app.trainer || new SimTrainer();
  app.session = new Session({ trainer, hr: app.hr, settings: app.settings, ...opts });
  app.rideId = Date.now();
  const s = app.session;
  s.on('shift', (g) => { const t = $('.tile.gear'); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); app.controllers.forEach((c) => c.vibrate?.()); });
  s.on('lap', () => toast('Lap'));
  s.on('workoutDone', () => toast('Workout complete. Free ride, or B twice to finish'));
  s.on('routeDone', () => toast('Route complete!'));
  show('ride');
  $('#r-name').textContent = s.name;
  sizeChart();
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
  renderRide();
}

async function endSession() {
  const s = app.session;
  if (!s) return;
  s.finish();
  wakeLock?.release?.().catch(() => {});
  if (s.samples.length < 10) { app.session = null; show('home'); return; }
  // remember what the app learned about this trainer
  const simSamples = s.samples.filter((x) => x.grade !== 0).length;
  if (simSamples > 120) Object.assign(app.settings, s.learned());
  else app.settings.realDev = s.devEst.dev;
  ls.set('settings', app.settings);
  const ride = await saveRide('done');
  showSummary(ride);
}

function summarize(s) {
  const st = statsFor(s.samples);
  const IF = st.np ? st.np / app.settings.ftp : 0;
  st.tss = Math.round((st.timer / 3600) * IF * IF * 100);
  st.if = Math.round(IF * 100) / 100;
  let best60 = 0;
  for (let i = 59; i < s.samples.length; i++) {
    let sum = 0;
    for (let j = i - 59; j <= i; j++) sum += s.samples[j].power;
    best60 = Math.max(best60, sum / 60);
  }
  st.best60 = Math.round(best60);
  return st;
}

async function saveRide(status) {
  const s = app.session;
  const ride = { id: app.rideId, name: s.name, status, samples: s.samples, laps: s.laps, summary: summarize(s), test: s.workout?.tags?.includes('test') };
  try { await rides.put(ride); } catch (e) { logMsg('app', `save failed: ${e.message}`); }
  return ride;
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
    stat(fmtTime(st.timer), 'Ride time'), stat(`${(st.distance / 1000).toFixed(1)} km`, 'Distance'),
    stat(`${st.avgPower} W`, 'Avg power'), stat(st.np ? `${st.np} W` : '-', 'Normalized'),
    stat(st.avgHr ? `${st.avgHr}` : '-', 'Avg HR'), stat(st.maxHr ?? '-', 'Max HR'),
    stat(st.tss, 'TSS'), stat(st.if || '-', 'Intensity'),
  ].join('');
  let extra = '';
  if (ride.test && st.best60) {
    const ftp = Math.round(st.best60 * 0.75);
    extra = `<div class="callout"><div>Best 1-min power <b>${st.best60} W</b> &rarr; estimated FTP <b>${ftp} W</b> (currently ${app.settings.ftp} W)</div><button class="primary small" id="s-setftp">Set FTP to ${ftp}</button></div>`;
  }
  $('#s-extra').innerHTML = extra;
  if (extra) $('#s-setftp').onclick = (e) => { app.settings.ftp = Math.round(st.best60 * 0.75); ls.set('settings', app.settings); e.target.textContent = 'Saved'; };
  $('#s-fit').onclick = () => downloadFit(ride);
  $('#s-home').onclick = () => { app.session = null; show('home'); renderHistory(); };
  show('summary');
}

// ------------------------------------------------------------------ actions (controller + keyboard)
function action(a) {
  const s = app.session;
  if (app.screen === 'ride' && s) {
    switch (a) {
      case 'easier': s.shift(-1); break;
      case 'harder': s.shift(+1); break;
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
  if (app.screen === 'summary') { if (a === 'select' || a === 'back') $('#s-home').click(); return; }
  // home navigation
  const items = focusables();
  switch (a) {
    case 'up': case 'easier': app.focus = Math.max(0, app.focus - 1); applyFocus(); break;
    case 'down': case 'harder': app.focus = Math.min(items.length - 1, app.focus + 1); applyFocus(); break;
    case 'left': case 'right': {
      const tabs = ['workouts', 'free', 'history'];
      const i = (tabs.indexOf(app.tab) + (a === 'right' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[i]);
      break;
    }
    case 'select': {
      const el = items[app.focus];
      if (!el) break;
      if (el.id === 'today') $('#btn-today')?.click();
      else if (el.dataset.i !== undefined) startWorkout(app.library[+el.dataset.i]);
      else el.click();
      break;
    }
    case 'back': $$('.panel').forEach((p) => p.classList.add('hidden')); break;
  }
}
const fmtGradeSet = (s) => `${(s.gradeOffset * 100).toFixed(0)}%`;

const BUTTON_ACTIONS = {
  shiftUpL: 'easier', shiftDnL: 'easier', paddleL: 'easier',
  shiftUpR: 'harder', shiftDnR: 'harder', paddleR: 'harder',
  up: 'up', down: 'down', left: 'left', right: 'right',
  a: 'select', b: 'back', y: 'skip', z: 'lap', powerUpL: 'ergToggle',
};
const REPEATABLE = new Set(['up', 'down']);
const holdTimers = {};
function onButton(b) {
  const a = BUTTON_ACTIONS[b];
  logMsg('controller', `${b}${a ? ' -> ' + a : ''}`);
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
  const map = { ArrowLeft: app.screen === 'ride' ? 'easier' : 'left', ArrowRight: app.screen === 'ride' ? 'harder' : 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'select', Enter: 'select', Escape: 'back', s: 'skip', l: 'lap', e: 'ergToggle', '[': 'easier', ']': 'harder' };
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
    if (!$('#today').classList.contains('hidden') && $('#btn-today')) list.push($('#today'));
    list.push(...$$('#workout-list .wo'));
  } else if (app.tab === 'free') {
    list.push($('#btn-free'), ...$$('[data-route]'));
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

function renderRide() {
  const s = app.session;
  if (!s || app.screen !== 'ride') return;
  const td = s.trainer.data || {};
  const hr = Math.round(app.hr?.bpm || td.hr || 0);
  $('#r-elapsed').textContent = fmtTime(s.elapsed);
  const p = Math.round(s.power3s);
  $('#r-power').textContent = p;
  const pt = $('.tile.power');
  pt.classList.remove('low', 'high', 'ok');
  if (s.target) {
    $('#r-target').innerHTML = `target <b style="color:var(--text)">${s.target}</b> W${s.intensity !== 1 ? ` (${Math.round(s.intensity * 100)}%)` : ''}`;
    const r = p / s.target;
    pt.classList.add(r < 0.95 ? 'low' : r > 1.05 ? 'high' : 'ok');
  } else {
    $('#r-target').textContent = `${(p / app.settings.riderKg).toFixed(1)} W/kg`;
  }
  $('#r-hr').textContent = hr || '--';
  const hrs = s.samples.filter((x) => x.hr).slice(-600);
  $('#r-hrzone').textContent = hrs.length ? `avg ${Math.round(hrs.reduce((a, x) => a + x.hr, 0) / hrs.length)} (10 min)` : '';
  $('#r-cad').textContent = Math.round(td.cadence || 0);
  $('#r-cadtarget').textContent = s.seg?.cadence ? `target ${s.seg.cadence}` : '';
  const gearTile = $('.tile.gear');
  gearTile.classList.toggle('dim', s.mode === 'erg');
  $('#r-gear').textContent = s.gear + 1;
  $('#r-ratio').textContent = s.mode === 'erg' ? 'ERG: gears not used' : `ratio ${GEAR_RATIOS[s.gear].toFixed(2)}`;
  $('#r-grade').innerHTML = `${(s.mode === 'sim' ? s.grade * 100 : 0).toFixed(1)}<span class="unit">%</span>`;
  $('#r-gradesub').textContent = s.mode === 'sim' && !s.route && !s.seg ? `set ${fmtGradeSet(s)} (up/down)` : s.route ? `${Math.round(s.altitude)} m` : '';
  $('#r-speed').textContent = (s.bike.v * 3.6).toFixed(1);
  $('#r-dist').textContent = `${(s.bike.dist / 1000).toFixed(2)} km`;

  // interval card
  const seg = s.seg;
  const card = $('#r-interval');
  if (seg) {
    const left = seg.end - s.workoutTime;
    const tgt = seg.kind === 'erg' ? segTarget(seg, s.workoutTime) : null;
    card.style.borderLeftColor = seg.kind === 'erg' ? zoneHex(tgt) : gradeHex(seg.grade);
    $('#r-int-label').textContent = `${seg.label}${seg.rep ? ` ${seg.rep.i}/${seg.rep.of}` : ''}${s.ergOff && seg.kind === 'erg' ? ' (ERG off)' : ''}`;
    $('#r-int-text').textContent = seg.text || (seg.kind === 'erg' ? `${Math.round(tgt * 100)}% FTP` : `${(seg.grade * 100).toFixed(0)}% grade, use your gears`);
    $('#r-int-left').textContent = fmtTime(left);
    const next = s.segs[s.segIndex + 1];
    $('#r-int-next').innerHTML = next ? `Next<br><b style="color:var(--text)">${fmtTime(next.dur)} ${next.kind === 'erg' ? `@ ${Math.round(next.from * app.settings.ftp * s.intensity)} W` : `@ ${(next.grade * 100).toFixed(0)}%`}</b>` : 'Last interval';
  } else if (s.route) {
    card.style.borderLeftColor = gradeHex(s.grade);
    $('#r-int-label').textContent = s.route.name;
    $('#r-int-text').textContent = `${((s.route.total - s.bike.dist) / 1000).toFixed(1)} km to go`;
    $('#r-int-left').textContent = `${Math.min(100, (s.bike.dist / s.route.total) * 100).toFixed(0)}%`;
    $('#r-int-next').textContent = '';
  } else {
    card.style.borderLeftColor = '#3d8bfd';
    $('#r-int-label').textContent = s.segs ? 'Workout complete' : 'Free ride';
    $('#r-int-text').textContent = s.segs ? 'Keep riding or press B twice to finish' : 'Shift to hold your cadence; up/down changes the grade';
    $('#r-int-left').textContent = '';
    $('#r-int-next').textContent = '';
  }

  $('#r-paused').classList.toggle('hidden', !s.paused);
  $('#r-pause').textContent = !s.started ? 'Start' : s.paused ? 'Resume' : 'Pause';
  $('#r-hints').innerHTML = s.mode === 'erg'
    ? '<b>Up/Down</b> intensity &middot; <b>Y</b> skip &middot; <b>Z</b> lap &middot; <b>Left power-up</b> ERG off &middot; <b>A</b> pause &middot; <b>B&times;2</b> end'
    : '<b>Shifters</b> gears &middot; <b>Up/Down</b> grade (free ride) &middot; <b>Z</b> lap &middot; <b>A</b> pause &middot; <b>B&times;2</b> end' + (app.demo ? ' &middot; demo: <b>+/-</b> rider power' : '');
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
window.addEventListener('resize', () => { if (app.screen === 'ride') { sizeChart(); drawChart(); } });

function drawChart() {
  const s = app.session;
  if (!s) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, dpr = devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const pad = 10 * dpr;
  const plotH = H - pad * 2;
  ctx.font = `${11 * dpr}px -apple-system, sans-serif`;

  if (s.route) {
    const r = s.route;
    const min = Math.min(...r.ele), max = Math.max(...r.ele) + 5;
    const X = (d) => (d / r.total) * W, Y = (e) => H - pad - ((e - min) / (max - min)) * plotH;
    ctx.beginPath(); ctx.moveTo(0, H);
    r.ele.forEach((e, i) => ctx.lineTo(X(i * r.step), Y(e)));
    ctx.lineTo(W, H); ctx.closePath();
    ctx.fillStyle = '#26303d'; ctx.fill();
    const pos = Math.min(r.total, s.bike.dist);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, X(pos), H); ctx.clip();
    ctx.beginPath(); ctx.moveTo(0, H);
    r.ele.forEach((e, i) => ctx.lineTo(X(i * r.step), Y(e)));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = 'rgba(255,90,54,.55)'; ctx.fill(); ctx.restore();
    const i = Math.min(r.ele.length - 1, Math.floor(pos / r.step));
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(pos), Y(r.ele[i]), 6 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = '#8b93a1'; ctx.fillText(`${Math.round(max)} m`, 6 * dpr, 16 * dpr); ctx.fillText(`${Math.round(min)} m`, 6 * dpr, H - 6 * dpr);
    return;
  }

  const ftp = app.settings.ftp;
  const maxP = Math.max(ftp * 1.6, ...s.samples.slice(-1200).map((x) => x.power + 20));
  const Yp = (p) => H - pad - (Math.min(p, maxP) / maxP) * plotH;

  if (s.segs) {
    const T = Math.max(s.segs[s.segs.length - 1].end, s.workoutTime + 1);
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
    s.samples.forEach((x, i) => { const px = X(x.wt), py = Yp(x.power); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    ctx.fillStyle = '#ff5a36'; ctx.fillRect(X(s.workoutTime) - dpr, 0, 2 * dpr, H);
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
  ['startGear', 'Starting gear (1-24)', 1, 1, null, 1],
  ['section', 'Trainer (learned automatically)'],
  ['realDev', 'Real development (m / crank rev)', 0.01, 1, 'What the trainer reports per pedal turn; learned while riding.'],
  ['trainerMassKg', 'Trainer sim mass (kg)', 0.5, 1, 'Mass the trainer assumes in slope mode; learned on climbs.'],
  ['maxSendGrade', 'Max grade sent to trainer (%)', 1, 100],
];
function renderSettings() {
  const f = $('#settings-form');
  f.innerHTML = FIELDS.map(([k, label, step, mult = 1, help, offset = 0]) => k === 'section'
    ? `<div class="section">${label}</div>`
    : `<label for="set-${k}">${label}</label><input id="set-${k}" type="number" step="${step}" value="${+((app.settings[k] * mult + offset).toFixed(3))}" data-k="${k}" data-mult="${mult}" data-off="${offset}">${help ? `<div class="help">${help}</div>` : ''}`).join('') +
    `<label for="set-guard">ERG low-cadence guard</label><select id="set-guard"><option value="1">On</option><option value="0">Off</option></select>
     <div class="help">If cadence drops under 40 rpm in ERG, the target eases to 60% until you're spinning again.</div>`;
  $('#set-guard').value = app.settings.ergCadenceGuard ? '1' : '0';
  f.oninput = (e) => {
    const el = e.target;
    if (el.id === 'set-guard') app.settings.ergCadenceGuard = el.value === '1';
    else if (el.dataset.k && el.value !== '') app.settings[el.dataset.k] = (Number(el.value) - Number(el.dataset.off)) / Number(el.dataset.mult);
    ls.set('settings', app.settings);
  };
}

// ------------------------------------------------------------------ wiring
$$('[data-connect]').forEach((b) => (b.onclick = () => connect(b.dataset.connect)));
$('#btn-demo').onclick = enterDemo;
$('#btn-free').onclick = startFree;
$('#btn-settings').onclick = () => { renderSettings(); $('#settings').classList.remove('hidden'); };
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
  if (t === 'history') renderHistory();
  applyFocus();
}
$$('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
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

renderDevices();
renderRoutes();
loadLibrary();
autoReconnect();
window.rodillo = app; // for debugging from the console
