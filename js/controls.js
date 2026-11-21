// @ts-check
// Controller and keyboard: what each Zwift Ride button and key does on each screen.
// First half, pure (tested in test/controls.mjs): the screen from the app's state (screenOf), a button or key to a
// verb, and the verb to the action the dispatch table runs (actionFor). Second half, the DOM part (tested with a fake
// document and clock in test/controls-dom.mjs): the dispatch table DO, Ride buttons, hold to confirm, the keyboard
// listener and the home focus ring, wired by initControls(). Never import app.js from here.
//
// Verbs: up, down, left, right, select, back, skip, lap, ergToggle, easier, harder, front. The phone's on-screen
// buttons send verbs too (action('down') ...); Ride buttons and keys become verbs here first.
import { shiftStyleFor } from './engine/garage.js?v=202611102147';
import { builderOpen, closeBuilder } from './builder.js?v=202611102147';
import { logMsg } from './ble/base.js?v=202611102147';
import { $, $$, toast } from './ui.js?v=202611102147';
/**
 * @typedef {object} ControlState
 * @property {boolean} [launching]
 * @property {boolean} [modal]
 * @property {boolean} [builder]
 * @property {string} [screen]
 * @property {boolean} [session]
 * @property {boolean} [erg]
 * @property {boolean} [panel]
 */

/** What decides the controls, read from the app at the press: { launching, modal, builder, screen ('home' | 'ride' |
 *  'ridepage'), session (a ride exists), erg (the ride is in ERG mode), panel (a panel or Connections is open) }.
 * @param {ControlState} st
 */
export function screenOf(st) {
  if (st.launching) return 'busy'; // the Start / Free ride launch animation is playing
  if (st.modal) return 'modal';
  if (st.builder) return 'builder'; // keyboard / touch only: B or Esc closes it
  if (st.screen === 'ridepage') return 'ridepage';
  if (st.screen === 'ride' && st.session) return `ride-${st.erg ? 'erg' : 'slope'}${st.panel ? '-panel' : ''}`;
  return 'home'; // home tabs (a panel open on top too), and the ride screen before its session exists
}
export const SCREENS = ['busy', 'modal', 'builder', 'ridepage', 'ride-erg', 'ride-slope', 'ride-erg-panel', 'ride-slope-panel', 'home'];
export const VERBS = ['up', 'down', 'left', 'right', 'select', 'back', 'skip', 'lap', 'ergToggle', 'easier', 'harder', 'front'];

// The ride screen. ERG: easier / harder and up / down change the effort 1%. Slope (or free ride, or ERG turned
// off): easier / harder shift the rear, up / down change the grade 1%. Back and skip only start a hold (hold to confirm).
const RIDE = {
  select: 'pause', back: 'holdEnd', skip: 'holdSkip', lap: 'lap', ergToggle: 'ergToggle', front: 'front',
};
const TABLE = {
  busy: {},
  modal: { left: 'modalFirst', up: 'modalFirst', easier: 'modalFirst', right: 'modalLast', down: 'modalLast', harder: 'modalLast', select: 'modalPress', back: 'modalCancel' },
  builder: { back: 'closeBuilder' },
  ridepage: { back: 'pageBack', select: 'pageSelect', left: 'pagePrev', easier: 'pagePrev', right: 'pageNext', harder: 'pageNext', up: 'pageUp', down: 'pageDown' },
  'ride-erg': { ...RIDE, easier: 'effortDown', harder: 'effortUp', down: 'effortDown', up: 'effortUp' },
  'ride-slope': { ...RIDE, easier: 'shiftEasier', harder: 'shiftHarder', down: 'gradeDown', up: 'gradeUp' },
  home: { up: 'focusPrev', easier: 'focusPrev', down: 'focusNext', harder: 'focusNext', left: 'tabPrev', right: 'tabNext', select: 'pick', back: 'closePanels' },
};
// a panel or Connections opened from the pause screen: back closes it instead of ending the ride; the rest still rides
TABLE['ride-erg-panel'] = { ...TABLE['ride-erg'], back: 'closePanels' };
TABLE['ride-slope-panel'] = { ...TABLE['ride-slope'], back: 'closePanels' };

/** The action (a key of the dispatch table in js/app.js) a verb runs on a screen, or null. */
export const actionFor = (screen, verb) => TABLE[screen]?.[verb] ?? null;

// ---- Zwift Ride buttons (js/ble/zwiftride.js BUTTONS, plus the analog paddles)
/** Every Ride button and its verb. Shifters and paddles: left side easier, right side harder (the ride screen turns
 *  them into gear shifts or ERG effort, buttonPlan). Power-up and on/off do nothing. ERG off is on screen only
 *  (button, phone sheet, E key). */
export const BUTTON_VERBS = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  a: 'select', b: 'back', y: 'skip', z: 'lap',
  shiftUpL: 'easier', shiftDnL: 'easier', paddleL: 'easier', shiftUpR: 'harder', shiftDnR: 'harder', paddleR: 'harder',
  powerUpL: null, onOffL: null, powerUpR: null, onOffR: null,
};
export const SHIFT_BUTTONS = new Set(['shiftUpL', 'shiftDnL', 'paddleL', 'shiftUpR', 'shiftDnR', 'paddleR']);
export const isLeft = (b) => b.endsWith('L');
const REPEATABLE = new Set(['up', 'down']);

/**
 * What a Ride button press does: { verb, repeat } (run through actionFor at the press; repeat = holding it repeats,
 * after 450 ms then every 120 ms), or { shift: true } (a gear by the shift style, shiftFor / pairsFront).
 * On the ride screen the shifters skip the menus' easier / harder: in ERG they send down / up (and repeat), in slope
 * they shift gears directly, even with a panel or a modal open (riding on while a message shows).
 */
export function buttonPlan(st, b) {
  if (SHIFT_BUTTONS.has(b)) {
    if (st.screen !== 'ride' || !st.session) return { verb: BUTTON_VERBS[b], repeat: false };
    if (st.erg) return { verb: isLeft(b) ? 'down' : 'up', repeat: true };
    return { shift: true };
  }
  const verb = BUTTON_VERBS[b] ?? null;
  return { verb, repeat: REPEATABLE.has(verb) && st.screen === 'ride' };
}
/** A Ride button's action in a state, for reading and testing: an action name, 'shift', or null; '*' = held repeats. */
export function buttonAction(st, b) {
  const p = buttonPlan(st, b);
  if (p.shift) return 'shift';
  const a = actionFor(screenOf(st), p.verb);
  return a && p.repeat ? `${a}*` : a;
}

/**
 * Shifting styles on the Zwift Ride:
 *  SRAM:    right side (both buttons + paddle) = harder, left side = easier,
 *           left + right together = front shift (2x only).
 *  Shimano: right shift-up = harder, right shift-down = easier (rear);
 *           left shift-up = big ring, left shift-down = small ring (2x);
 *           paddles: right harder / left easier. On 1x the left buttons also shift the rear.
 *  1x:      the shifter's side only ('right' or 'left', per bike): that side's shift-up and paddle = harder,
 *           its shift-down = easier. The other side doesn't shift. SRAM / Shimano only apply to 2x.
 * `gb` = the ride's gearbox ({ isDouble, seq }). Returns ['rear' | 'front', dir] or null.
 */
export function shiftFor(b, shiftStyle, gb = {}) {
  const style = shiftStyle || 'sram';
  const double = gb.isDouble;
  if (!double && !gb.seq) {
    const side = style === 'left' ? 'L' : 'R';
    if (b === `shiftUp${side}` || b === `paddle${side}`) return ['rear', +1];
    if (b === `shiftDn${side}`) return ['rear', -1];
    return null;
  }
  if (style === 'shimano') {
    if (b === 'shiftUpR' || b === 'paddleR') return ['rear', +1];
    if (b === 'shiftDnR' || b === 'paddleL') return ['rear', -1];
    if (b === 'shiftUpL') return double ? ['front', +1] : ['rear', +1];
    if (b === 'shiftDnL') return double ? ['front', -1] : ['rear', -1];
  }
  return ['rear', isLeft(b) ? -1 : +1];
}
/** SRAM on a 2x: a shift waits 140 ms to see if the other side joins (left + right together = front shift). */
export const pairsFront = (style, gb = {}) => shiftStyleFor(style, false) === 'sram' && !!gb.isDouble;

// ---- keyboard
/** Keys and their verbs; on the ride screen the left / right arrows are easier / harder instead. */
export const KEY_VERBS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'select', Enter: 'select', Escape: 'back',
  s: 'skip', l: 'lap', e: 'ergToggle', '[': 'easier', ']': 'harder', f: 'front',
};
/** The verb a key sends, or null. `repeat` = the browser's auto-repeat of a held key: on the ride screen it never
 *  restarts a skip / end hold (the first keydown started it). With the builder open only Esc reaches the controls
 *  (Space / Enter press the builder's own buttons). */
export function keyVerb(st, key, repeat = false) {
  if (st.builder && key !== 'Escape') return null;
  const onRide = st.screen === 'ride' && (key === 'ArrowLeft' || key === 'ArrowRight');
  const verb = onRide ? (key === 'ArrowLeft' ? 'easier' : 'harder') : (KEY_VERBS[key] ?? null);
  if (repeat && (verb === 'skip' || verb === 'back') && st.screen === 'ride') return null;
  return verb;
}
/** A key's action in a state, for reading and testing: an action name or null. */
export const keyAction = (st, key, repeat = false) => actionFor(screenOf(st), keyVerb(st, key, repeat));

// ---- the DOM part: runs the actions (dispatch table DO), Ride buttons, hold to confirm, the keyboard listener and
// the home focus ring. Moved out of js/app.js Nov 18 (code-health plan step 4) with no change in behavior.
// App state and app.js hooks come through initControls(); never import app.js from here.
/** @type {import('./types.js').AppState} */
let app;
let modalOpen, devPopOpen, setDevPop, setTab, TABS, startWorkout, rideAction, modalAction, renderRide, tooShort, endSession;

/** @param {import('./types.js').ControlsDeps} deps */
export function initControls(deps) {
  ({ app, modalOpen, devPopOpen, setDevPop, setTab, TABS, startWorkout, rideAction, modalAction, renderRide, tooShort, endSession } = deps);
  // a key released while the window is in the background never sends keyup
  window.addEventListener('blur', () => holdEnd());
  document.addEventListener('visibilitychange', () => { if (document.hidden) holdEnd(); });

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(/** @type {HTMLElement} */ (e.target).tagName)) { if (e.key === 'Escape' && builderOpen()) closeBuilder(); return; }
    if (builderOpen() && e.key !== 'Escape') return; // Space/Enter press the builder's own buttons
    if (app.demo && app.trainer && (e.key === '+' || e.key === '=' || e.key === '-')) {
      app.trainer.riderPower = Math.max(0, app.trainer.riderPower + (e.key === '-' ? -20 : 20));
      toast(`Demo rider: ${app.trainer.riderPower} W`);
      return;
    }
    const st = controlState();
    if (!keyVerb(st, e.key)) return; // keys and their verbs: KEY_VERBS above
    e.preventDefault();
    const a = keyVerb(st, e.key, e.repeat); // held: the first keydown started the hold
    if (a) action(a, 'key');
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 's') holdEnd('skip');
    else if (e.key === 'Escape') holdEnd('end');
  });
  document.addEventListener('keydown', () => { app.usedNav = true; }, true);
}

// ------------------------------------------------------------------ actions (controller + keyboard)
// What each Ride button, key and on-screen verb does on each screen is the pure part above (tested in
// test/controls.mjs): screenOf() + actionFor() name the action, and this table runs it.
const controlState = () => ({
  launching: app.launching, modal: modalOpen(), builder: builderOpen(), screen: app.screen, session: !!app.session,
  erg: app.session?.mode === 'erg', panel: devPopOpen() || $$('.panel').some((p) => !p.classList.contains('hidden')),
});
const fmtGradeSet = (s) => `${(s.gradeOffset * 100).toFixed(0)}%`;
// ERG: effort +-1%; slope: grade +-1%
const bump = (dir) => { const s = app.session; s.bump(dir); toast(s.mode === 'erg' ? `Intensity ${Math.round(s.intensity * 100)}%` : `Grade ${fmtGradeSet(s)}`); };
const DO = {
  // home: the focus ring moves through the tab's controller list (focusables()), left / right switch tabs
  focusPrev: () => { app.focus = Math.max(0, app.focus - 1); applyFocus(); },
  focusNext: () => { app.focus = Math.min(focusables().length - 1, app.focus + 1); applyFocus(); },
  tabPrev: () => setTab(TABS[(TABS.indexOf(app.tab) - 1 + TABS.length) % TABS.length]),
  tabNext: () => setTab(TABS[(TABS.indexOf(app.tab) + 1) % TABS.length]),
  pick: () => {
    const el = focusables()[app.focus];
    if (!el) return;
    if (el.classList.contains('day')) el.querySelector('[data-startday]')?.click();
    else if (el.dataset.i !== undefined) startWorkout(app.library[+el.dataset.i]);
    else el.click();
  },
  // home, or a panel / Connections opened from the pause screen (it doesn't end the ride)
  closePanels: () => { $$('.panel').forEach((p) => p.classList.add('hidden')); setDevPop(false); },
  // the ride
  effortUp: () => bump(+1), effortDown: () => bump(-1), gradeUp: () => bump(+1), gradeDown: () => bump(-1),
  shiftEasier: () => app.session.shift(-1), shiftHarder: () => app.session.shift(+1),
  front: () => { const s = app.session; if (s.gb.isDouble) s.toggleFront(); else toast('1x: no front shifting'); },
  pause: () => app.session.togglePause(),
  holdEnd: (src) => holdStart('end', src),
  holdSkip: (src) => holdStart('skip', src),
  lap: () => { const s = app.session; if (s.seg) toast('Laps are automatic per interval'); else s.lap(); },
  ergToggle: () => { const s = app.session; if (s.segs) { s.toggleErg(); toast(s.ergOff ? 'ERG off: slope mode' : 'ERG on'); } },
  // the ride page, a modal, the builder (keyboard / touch only: B or Esc closes it)
  pageBack: () => rideAction('back'), pageSelect: () => rideAction('select'), pagePrev: () => rideAction('prev'),
  pageNext: () => rideAction('next'), pageUp: () => rideAction('up'), pageDown: () => rideAction('down'),
  modalFirst: (src, a) => modalAction('first', a), modalLast: (src, a) => modalAction('last', a),
  modalPress: (src, a) => modalAction('press', a), modalCancel: (src, a) => modalAction('cancel', a),
  closeBuilder: () => closeBuilder(),
};
/** Run a verb (up, down, left, right, select, back, skip, lap, ergToggle, easier, harder, front) on the screen showing.
 *  src = 'ctl' (Ride button), 'key' or 'tap' (on screen): skip / end show the hold ring for 'ctl' / 'key'. */
export function action(a, src = 'tap') {
  const screen = screenOf(controlState());
  const name = actionFor(screen, a);
  if (screen === 'modal' && !name) return modalAction(null, a); // still navigation: the modal shows its ring
  if (name) DO[name](src, a);
  if (screen.startsWith('ride-') && name !== 'closePanels') renderRide();
}

let pendingShift = null; // SRAM: wait briefly to see if the other side joins (front shift)
/** Slope on the ride screen: a shifter is a gear by the shift style (js/controls.js shiftFor / pairsFront). */
function shiftGear(b) {
  const s = app.session;
  if (!pairsFront(app.settings.shiftStyle, s.gb)) { const sh = shiftFor(b, app.settings.shiftStyle, s.gb); if (sh) doShift(...sh); return; }
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

const holdTimers = {};
const lastPress = {};
export function onButton(b, dev) {
  // with both hoods connected, a button may arrive from both devices: keep the first
  const now = performance.now();
  if (now - (lastPress[b] || 0) < 90) return;
  lastPress[b] = now;
  app.usedNav = true; // a controller press is navigation like a key: home shows its focus ring
  const p = buttonPlan(controlState(), b), shifter = SHIFT_BUTTONS.has(b);
  logMsg('controller', `${dev?.side || ''} ${b}${!shifter && p.verb ? ' -> ' + p.verb : ''}`);
  if (p.shift) return shiftGear(b);
  if (!p.verb) return;
  action(p.verb, shifter ? 'tap' : 'ctl');
  if (p.repeat) { // held: again after 450 ms, then every 120 ms, until released
    clearTimeout(holdTimers[b]);
    const rep = () => { action(p.verb); holdTimers[b] = setTimeout(rep, 120); };
    holdTimers[b] = setTimeout(rep, 450);
  }
}
export function onRelease(b) {
  clearTimeout(holdTimers[b]); delete holdTimers[b];
  const a = BUTTON_VERBS[b];
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
export function holdStart(kind, src, btn) {
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
export function holdEnd(kind) {
  if (!hold || (kind && hold.kind !== kind)) return;
  clearTimeout(hold.t);
  hold.btn?.classList.remove('filling');
  hold = null;
  $('#hold').classList.add('hidden');
  $('#hold').classList.remove('run');
}
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
export function focusables() {
  const list = [];
  if (app.tab === 'today') list.push(...$$('#today .hero-btns button'));
  if (app.tab === 'workouts') {
    list.push(...$$('#wo-kind button:not(.hidden)'), ...(app.woKind === 'mine' ? [$('#btn-new-wo'), ...$$('#mine-list .wo')] : $$(app.woKind === 'slope' ? '#slope-list .wo' : '#workout-list .wo')));
  }
  return list;
}
export function applyFocus() {
  const items = focusables();
  $$('.focus').forEach((x) => x.classList.remove('focus'));
  const el = items[Math.min(app.focus, items.length - 1)];
  if (el && app.screen === 'home' && app.usedNav) { el.classList.add('focus'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
