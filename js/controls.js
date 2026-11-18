// Controller and keyboard: what each Zwift Ride button and key does on each screen.
// Pure (tested in test/controls.mjs): the screen from the app's state (screenOf), a button or key to a verb, and the
// verb to the action the dispatch table in js/app.js runs (actionFor). Never import app.js from here.
//
// Verbs: up, down, left, right, select, back, skip, lap, ergToggle, easier, harder, front. The phone's on-screen
// buttons send verbs too (action('down') ...); Ride buttons and keys become verbs here first.
import { shiftStyleFor } from './engine/garage.js?v=202611102147';

/** What decides the controls, read from the app at the press: { launching, modal, builder, screen ('home' | 'ride' |
 *  'ridepage'), session (a ride exists), erg (the ride is in ERG mode), panel (a panel or Connections is open) }. */
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
