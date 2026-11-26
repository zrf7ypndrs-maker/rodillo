// @ts-check
// Settings panel: the Rider / Ride / Road feel / Trainer / Sync tabs (#settings, #set-tabs), the trainer grade range,
// GitHub token and sign-in row, and the ride history import (Settings > Sync). Moved out of js/app.js Nov 17
// (code-health plan step 4) with no change in behavior. Shared DOM helpers come from js/ui.js; app.js passes app
// state and its own hooks in through initSettings(). Never import app.js from here. When a change here affects other
// screens (sign-in, token, data repo, imported rides), call refreshAfterSettings(); never call a screen's renderer.
import { DEFAULT_SETTINGS } from './engine/session.js';
import { TRAINERS, CUSTOM_TRAINER, matchTrainer, trainerFor, trainerFits, cleanRange } from './engine/trainers.js';
import { GitHubSync } from './sync.js';
import { logMsg } from './ble/base.js';
import { ls } from './store.js';
import { painChoice } from './pain.js';
import { musicChoice } from './music.js';
import { countdownChoice } from './countdown.js';
import { tapChoice } from './sound.js';
import { authEnabled, authSession, startSignIn, signOut } from './auth.js';
import { $, $$, esc, toast, fld, placeInk, inkObserver, slideIn } from './ui.js';

// from app.js, set by initSettings()
/** @typedef {import('./types.js').ElementEvent} ElementEvent */
/** @typedef {import('./types.js').FieldEvent} FieldEvent */
/** @typedef {import('./types.js').SettingsDeps} Deps */
/** @type {Deps['app']} */ let app;
/** @type {Deps['saveSettings']} */ let saveSettings;
/** @type {Deps['ask']} */ let ask;
/** @type {Deps['tell']} */ let tell;
/** @type {Deps['setDevPop']} */ let setDevPop;
/** @type {Deps['dataRepo']} */ let dataRepo;
/** @type {Deps['syncClient']} */ let syncClient;
/** @type {Deps['syncHint']} */ let syncHint;
/** @type {Deps['loadCoachData']} */ let loadCoachData;
/** @type {Deps['syncPending']} */ let syncPending;
/** @type {Deps['refreshAfterSettings']} */ let refreshAfterSettings;
/** @type {Deps['leaveData']} */ let leaveData;

// One tab per section. Number fields: [key, label, step, mult, help, offset].
const SET_TABS = {
  rider: [['ftp', 'FTP (W)', 1], ['riderKg', 'Rider weight (kg)', 0.1]],
  ride: [['autoPauseSec', 'Auto-pause after (s, 0 = off)', 1, 1, 'ERG: no pedaling. Slope: bike stopped.']],
  road: [
    ['gradeScale', 'Grade realism (%)', 5, 100, 'Zwift defaults to 50%. 100% = real climbs. Descents are always 100%.'],
    ['cda', 'CdA (m²)', 0.01, 1, 'Aero drag. 0.32 hoods, 0.25 drops.'], ['crr', 'Rolling resistance', 0.001],
  ],
  trainer: [],
};
const SET_TAB_IDS = ['rider', 'ride', 'road', 'trainer', 'sync'];
export const numField = ([k, label, step, mult = 1, help, offset = 0, cls = '']) =>
  fld(`set-${k}`, label, `<input id="set-${k}" type="number" step="${step}" value="${+((app.settings[k] * mult + offset).toFixed(3))}" data-k="${k}" data-mult="${mult}" data-off="${offset}">`, help, cls);
const nameField = () => fld('set-name', 'Your name', `<input id="set-name" type="text" maxlength="30" autocomplete="given-name" value="${esc(app.settings.riderName || '')}" placeholder="First name">`, 'The coach uses it in workout messages.', 'full');
// ---- trainer: the grade range it can simulate
function trainerOptions() {
  return Object.entries(TRAINERS).map(([k, t]) => `<option value="${k}">${esc(t.name)}</option>`).join('') +
    `<option value="${CUSTOM_TRAINER}">Other (set the range yourself)</option>`;
}
const pct = (x) => +((x * 100).toFixed(1));
function fillTrainer() {
  const st = app.settings;
  const id = TRAINERS[st.trainerModel] && trainerFits(st.trainerModel, st.minSendGrade, st.maxSendGrade) ? st.trainerModel : CUSTOM_TRAINER;
  /** @type {HTMLSelectElement} */ ($('#set-trainer')).value = id;
  /** @type {HTMLInputElement} */ ($('#set-gmax')).value = String(pct(st.maxSendGrade));
  /** @type {HTMLInputElement} */ ($('#set-gmin')).value = String(pct(st.minSendGrade));
}
function pickTrainer(id) {
  app.settings.trainerModel = id;
  const t = TRAINERS[id];
  if (t) { app.settings.maxSendGrade = t.max; app.settings.minSendGrade = t.min; }
  fillTrainer();
}
function editGradeRange() {
  const mx = /** @type {HTMLInputElement} */ ($('#set-gmax')).value, mn = /** @type {HTMLInputElement} */ ($('#set-gmin')).value;
  if (mx === '' || mn === '') return false;
  const r = cleanRange(Number(mn) / 100, Number(mx) / 100);
  app.settings.maxSendGrade = r.max;
  app.settings.minSendGrade = r.min;
  const cur = app.settings.trainerModel;
  app.settings.trainerModel = TRAINERS[cur] && trainerFits(cur, r.min, r.max) ? cur : trainerFor(r.min, r.max) || CUSTOM_TRAINER;
  /** @type {HTMLSelectElement} */ ($('#set-trainer')).value = app.settings.trainerModel;
  return true;
}
/** First trainer connection with no trainer chosen yet: use the range of the model it reports. */
export function detectTrainer(dev) {
  if (app.settings.trainerModel || app.demo) return;
  const id = matchTrainer(dev?.device?.name);
  if (!id) return;
  pickTrainer(id);
  saveSettings();
  const t = TRAINERS[id];
  toast(`${t.name}: grades from ${pct(t.min)}% to ${pct(t.max)}% (Settings > Trainer)`);
}
/** Where virtual shifting happens right now, for Settings > Trainer. */
export function shiftLine() {
  const t = app.trainer, want = app.settings.trainerShifting !== 'app';
  if (!want) return 'Rodillo works out the gear and sends the trainer a grade (FTMS). Takes effect on the next trainer connection.';
  if (t?.state === 'connected' && /** @type {import('./ble/trainer.js').Trainer} */ (t).zwiftShifting) return 'Now: in the trainer. Rodillo sends the road grade and your gear; the trainer sets the resistance itself, like with Zwift.';
  if (t?.state === 'connected') return "Now: in Rodillo. This trainer didn't answer the Zwift protocol (KICKR CORE needs firmware 1.3.17 or newer), so Rodillo does the gearing.";
  return 'The trainer does the gearing when it speaks the Zwift protocol (KICKR CORE with firmware 1.3.17 or newer); otherwise Rodillo does. Checked when the trainer connects.';
}
function renderSettings() {
  const f = $('#settings-form');
  const extra = {
    rider: `<div class="help">Bike weight and wheel are per bike, in the Garage (<a href="#" data-open-garage>bike icon</a> at the top). Gearing is its own choice: <a href="#" data-open-gearing>Gearing</a>. All settings are saved to your plan, so every device gets them.</div>`,
    ride: fld('set-guard', 'ERG low-cadence guard', '<select id="set-guard"><option value="1">On</option><option value="0">Off</option></select>', 'If cadence drops under 40 rpm in ERG, the target eases to 60% until you\'re spinning again.') +
      fld('set-pain', 'Pain vision', '<select id="set-pain"><option value="full">Full</option><option value="subtle">Subtle</option><option value="off">Off</option></select>', 'Near the end of hard reps, or when your W\u2032 runs low, the screen edges blur and darken with your heart rate. Your numbers stay sharp.') +
      fld('set-music', 'Title music', '<select id="set-music"><option value="normal">On</option><option value="soft">Soft</option><option value="off">Off</option></select>', 'A calm loop on the home screens. It fades out when a ride starts and comes back after.') +
      fld('set-countdown', 'Countdown sounds', '<select id="set-countdown"><option value="on">On</option><option value="soft">Soft</option><option value="off">Off</option></select>', 'A soft pulse on each of the last 3 seconds of a step, then a sound as the next one starts: rising bells for work, a chime for rest.') +
      fld('set-taps', 'Taps', '<select id="set-taps"><option value="all">Sound and haptics</option><option value="sound">Sound only</option><option value="haptic">Haptics only</option><option value="off">Off</option></select>', 'A soft tap when you move around and press things on the home screens. Haptics are on phones. Never during a ride.'),
    trainer: `${fld('set-trainer', 'Trainer', `<select id="set-trainer">${trainerOptions()}</select>`, '', 'full')}
      ${fld('set-shift', 'Virtual shifting', '<select id="set-shift"><option value="auto">In the trainer when it can (like Zwift)</option><option value="app">Always in Rodillo</option></select>', '', 'full')}
      <div class="help" id="shift-line">${shiftLine()}</div>
      ${fld('set-gmax', 'Max grade (%)', '<input id="set-gmax" type="number" step="1" min="1" max="40">')}
      ${fld('set-gmin', 'Min grade (%)', '<input id="set-gmin" type="number" step="1" min="-30" max="0">')}
      <div class="help">From the trainer's spec. Rodillo never sends a grade outside this range; past the max you'll see Max resistance. Brake trainers can't push you downhill: below 0% they just get as light as they can.</div>
      ${numField(['realDev', 'Real development (m / crank rev)', 0.01, 1, 'What the trainer reports per pedal turn; learned while riding.', 0, 'full'])}
      <div class="help" id="tm-line">Slope correction learned from your trainer: ${((app.settings.gradeTrim || 0) * 100).toFixed(1)}% grade. <a href="#" id="tm-reset">Reset</a></div>`,
  };
  f.innerHTML = Object.entries(SET_TABS).map(([id, fields]) =>
    `<div class="settings-form stab-pane hidden" data-pane="${id}">${id === 'rider' ? nameField() : ''}${fields.map(numField).join('')}${extra[id] || ''}</div>`).join('');
  /** @type {HTMLSelectElement} */ ($('#set-guard')).value = app.settings.ergCadenceGuard ? '1' : '0';
  /** @type {HTMLSelectElement} */ ($('#set-pain')).value = painChoice(app.settings.painVision);
  /** @type {HTMLSelectElement} */ ($('#set-music')).value = musicChoice(app.settings.titleMusic);
  /** @type {HTMLSelectElement} */ ($('#set-countdown')).value = countdownChoice(app.settings.countdownSound);
  /** @type {HTMLSelectElement} */ ($('#set-taps')).value = tapChoice(app.settings.taps);
  $('#tm-reset').onclick = (e) => { e.preventDefault(); app.settings.gradeTrim = 0; app.settings.realDev = DEFAULT_SETTINGS.realDev; saveSettings(); renderSettings(); };
  fillTrainer();
  /** @type {HTMLSelectElement} */ ($('#set-shift')).value = app.settings.trainerShifting === 'app' ? 'app' : 'auto';
  f.oninput = (/** @type {import('./types.js').FieldEvent<InputEvent>} */ e) => {
    const el = e.target;
    if (el.id === 'set-name') app.settings.riderName = el.value.trim();
    else if (el.id === 'set-guard') app.settings.ergCadenceGuard = el.value === '1';
    else if (el.id === 'set-pain') app.settings.painVision = el.value;
    else if (el.id === 'set-music') app.settings.titleMusic = el.value;
    else if (el.id === 'set-countdown') app.settings.countdownSound = el.value;
    else if (el.id === 'set-taps') app.settings.taps = el.value;
    else if (el.id === 'set-trainer') pickTrainer(el.value);
    else if (el.id === 'set-gmax' || el.id === 'set-gmin') { if (!editGradeRange()) return; }
    else if (el.id === 'set-shift') { app.settings.trainerShifting = el.value; if (app.trainer) /** @type {import('./ble/trainer.js').Trainer} */ (app.trainer).useZwift = el.value !== 'app'; $('#shift-line').textContent = shiftLine(); }
    else if (el.dataset.k && el.value !== '') app.settings[el.dataset.k] = (Number(el.value) - Number(el.dataset.off)) / Number(el.dataset.mult);
    saveSettings();
  };
  // tidy the typed grades once the field is left (only when they were valid)
  f.onchange = (/** @type {FieldEvent} */ e) => {
    if (['set-gmax', 'set-gmin'].includes(e.target.id)) fillTrainer();
  };
  setSetTab(ls.get('setTab', 'rider'));
}
/** Shows one settings tab; remembered per browser. */
function setSetTab(id, animate = false) {
  if (!SET_TAB_IDS.includes(id)) id = 'rider';
  const prev = $('#set-tabs button.active')?.dataset.stab;
  $$('#set-tabs button').forEach((b) => { const on = b.dataset.stab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $$('#settings .stab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== id));
  const btn = $(`#set-tabs [data-stab="${id}"]`);
  placeInk($('#set-tabs'), btn);
  btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (animate && prev && prev !== id) slideIn($(`#settings [data-pane="${id}"]`), SET_TAB_IDS.indexOf(id) > SET_TAB_IDS.indexOf(prev) ? 1 : -1);
  ls.set('setTab', id);
}

// GitHub sign-in row at the top of the Sync tab (hidden until AUTH_URL is set in js/auth.js).
export function renderSignIn(msg = '') {
  const el = $('#gh-signin');
  el.classList.toggle('hidden', !authEnabled());
  if (!authEnabled()) return;
  const s = authSession();
  el.innerHTML = s
    ? `<span>Signed in as <b>${esc(s.login || 'GitHub user')}</b></span> <button class="ghost small" id="btn-gh-out">Sign out</button>${msg ? ` <span class="muted">${esc(msg)}</span>` : ''}`
    : `<button class="primary small" id="btn-gh-in">Sign in with GitHub</button> <span class="muted">${esc(msg || 'Once per browser, about twice a year.')}</span>`;
  if ($('#btn-gh-in')) $('#btn-gh-in').onclick = startSignIn;
  if ($('#btn-gh-out')) $('#btn-gh-out').onclick = async () => {
    // a pasted token keeps access to rodillo-data, so nothing is wiped then
    if (await leaveData(signOut, !!ls.get('sync', {}).token)) renderSignIn('Signed out on this browser');
  };
  $('#token-label').textContent = s ? 'Or use a token (not needed while signed in)' : 'Or paste a token instead';
}

/** Wires the Settings panel. Call once from app.js, after its helpers exist. */
/** @param {Deps} deps */
export function initSettings(deps) {
  ({ app, saveSettings, ask, tell, setDevPop, dataRepo, syncClient, syncHint, loadCoachData, syncPending, refreshAfterSettings, leaveData } = deps);
  document.addEventListener('click', (/** @type {ElementEvent} */ e) => {
    const a = /** @type {HTMLElement} */ (e.target.closest('[data-open-settings]'));
    if (!a) return;
    e.preventDefault();
    if (a.dataset.openSettings) ls.set('setTab', a.dataset.openSettings);
    $$('.panel').forEach((p) => p.classList.add('hidden'));
    $('#btn-settings').click();
  });
  $$('#set-tabs button').forEach((b) => (b.onclick = () => setSetTab(b.dataset.stab, true)));
  if (inkObserver) inkObserver.observe($('#set-tabs'));
  $('#btn-settings').onclick = () => {
    renderSettings();
    const cfg = ls.get('sync', {});
    /** @type {HTMLInputElement} */ ($('#set-token')).value = cfg.token || '';
    /** @type {HTMLInputElement} */ ($('#set-repo')).value = dataRepo();
    $('#token-status').textContent = cfg.token ? 'Token saved' : '';
    renderSignIn();
    setDevPop(false);
    $('#controls').classList.add('hidden');
    $('#garage').classList.add('hidden');
    $('#settings').classList.remove('hidden');
    setSetTab(ls.get('setTab', 'rider'));
  };
  $('#btn-token').onclick = async () => {
    const token = /** @type {HTMLInputElement} */ ($('#set-token')).value.trim();
    const repo = /** @type {HTMLInputElement} */ ($('#set-repo')).value.trim() || dataRepo();
    const st = $('#token-status');
    if (!token) {
      const signedInGh = authEnabled() && !!authSession();
      if (ls.get('sync', {}).token && !(await leaveData(() => ls.set('sync', { repo }), signedInGh))) { /** @type {HTMLInputElement} */ ($('#set-token')).value = ls.get('sync', {}).token; return; }
      ls.set('sync', { repo });
      if (authEnabled() && authSession()) { st.textContent = 'Saved. Loading...'; await loadCoachData(); st.textContent = app.coachError || `Syncing with ${repo}`; refreshAfterSettings(); return; }
      st.textContent = 'Sync turned off'; refreshAfterSettings(); return;
    }
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
  $('#imp-file').onchange = async (/** @type {FieldEvent} */ e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const st = $('#imp-status'), btn = $('#imp-btn');
    const gh = syncClient();
    if (!gh) { tell(`${syncHint()} above first: imported rides go to rodillo-data.`, 'Not connected'); return; }
    btn.classList.add('busy');
    try {
      const { scanFiles, buildImport, IMPORT_DAYS } = await import('./importer.js');
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
      refreshAfterSettings();
    } catch (err) {
      logMsg('sync', `import failed: ${err.message}`);
      st.textContent = '';
      tell(err.message, 'Import failed');
    } finally { btn.classList.remove('busy'); }
  };
}
