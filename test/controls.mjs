// js/controls.js: what every Zwift Ride button, key and on-screen verb does on every screen.
// The expected tables are written out by hand (not derived from the module), so a changed mapping has to be
// changed here on purpose. '-' = does nothing, '*' = holding the button repeats it.
import assert from 'node:assert/strict';
import { BUTTONS } from '../js/ble/zwiftride.js';
import {
  screenOf, SCREENS, VERBS, actionFor, BUTTON_VERBS, SHIFT_BUTTONS, buttonPlan, buttonAction, shiftFor, pairsFront, KEY_VERBS, keyVerb, keyAction,
} from '../js/controls.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const table = (s) => Object.fromEntries(s.trim().split(/\s+/).map((x) => { const i = x.lastIndexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
const un = (v) => (v === '-' ? null : v);

// the states the app can be in when a button arrives (screenOf reads these from the app at the press)
const STATES = {
  home: { screen: 'home' },
  homePanel: { screen: 'home', panel: true },
  rideNoSession: { screen: 'ride' }, // the ride screen before its session exists
  rideErg: { screen: 'ride', session: true, erg: true },
  rideSlope: { screen: 'ride', session: true, erg: false },
  rideErgPanel: { screen: 'ride', session: true, erg: true, panel: true },
  rideSlopePanel: { screen: 'ride', session: true, erg: false, panel: true },
  modalHome: { screen: 'home', modal: true },
  modalRideErg: { screen: 'ride', session: true, erg: true, modal: true },
  modalRideSlope: { screen: 'ride', session: true, erg: false, modal: true, panel: true },
  builder: { screen: 'home', builder: true },
  builderModal: { screen: 'home', builder: true, modal: true }, // e.g. "Delete this workout?" over the builder
  ridepage: { screen: 'ridepage' },
  busy: { screen: 'home', launching: true },
  busyRide: { screen: 'ride', session: true, erg: false, launching: true },
};

test('screenOf: precedence launching > modal > builder > ride page > ride > home', () => {
  const want = {
    home: 'home', homePanel: 'home', rideNoSession: 'home', rideErg: 'ride-erg', rideSlope: 'ride-slope', rideErgPanel: 'ride-erg-panel',
    rideSlopePanel: 'ride-slope-panel', modalHome: 'modal', modalRideErg: 'modal', modalRideSlope: 'modal', builder: 'builder',
    builderModal: 'modal', ridepage: 'ridepage', busy: 'busy', busyRide: 'busy',
  };
  for (const [k, st] of Object.entries(STATES)) assert.equal(screenOf(st), want[k], k);
  assert.deepEqual([...new Set(Object.values(want))].sort(), [...SCREENS].sort());
  assert.equal(screenOf({ screen: 'ridepage', panel: true, session: true }), 'ridepage');
});

test('actionFor: every verb on every screen', () => {
  const WANT = {
    busy: 'up:- down:- left:- right:- select:- back:- skip:- lap:- ergToggle:- easier:- harder:- front:-',
    modal: 'up:modalFirst down:modalLast left:modalFirst right:modalLast select:modalPress back:modalCancel skip:- lap:- ergToggle:- easier:modalFirst harder:modalLast front:-',
    builder: 'up:- down:- left:- right:- select:- back:closeBuilder skip:- lap:- ergToggle:- easier:- harder:- front:-',
    ridepage: 'up:pageUp down:pageDown left:pagePrev right:pageNext select:pageSelect back:pageBack skip:- lap:- ergToggle:- easier:pagePrev harder:pageNext front:-',
    'ride-erg': 'up:effortUp down:effortDown left:- right:- select:pause back:holdEnd skip:holdSkip lap:lap ergToggle:ergToggle easier:effortDown harder:effortUp front:front',
    'ride-slope': 'up:gradeUp down:gradeDown left:- right:- select:pause back:holdEnd skip:holdSkip lap:lap ergToggle:ergToggle easier:shiftEasier harder:shiftHarder front:front',
    'ride-erg-panel': 'up:effortUp down:effortDown left:- right:- select:pause back:closePanels skip:holdSkip lap:lap ergToggle:ergToggle easier:effortDown harder:effortUp front:front',
    'ride-slope-panel': 'up:gradeUp down:gradeDown left:- right:- select:pause back:closePanels skip:holdSkip lap:lap ergToggle:ergToggle easier:shiftEasier harder:shiftHarder front:front',
    home: 'up:focusPrev down:focusNext left:tabPrev right:tabNext select:pick back:closePanels skip:- lap:- ergToggle:- easier:focusPrev harder:focusNext front:-',
  };
  assert.deepEqual(Object.keys(WANT).sort(), [...SCREENS].sort());
  for (const screen of SCREENS) {
    const want = table(WANT[screen]);
    assert.deepEqual(Object.keys(want).sort(), [...VERBS].sort(), screen);
    for (const v of VERBS) assert.equal(actionFor(screen, v), un(want[v]), `${screen} ${v}`);
  }
  assert.equal(actionFor('home', 'nope'), null);
  assert.equal(actionFor('nowhere', 'select'), null);
});

test('Ride buttons: the map lists every button the Ride sends (js/ble/zwiftride.js + paddles)', () => {
  assert.deepEqual(Object.keys(BUTTON_VERBS).sort(), [...Object.keys(BUTTONS), 'paddleL', 'paddleR'].sort());
  assert.deepEqual([...SHIFT_BUTTONS].sort(), ['paddleL', 'paddleR', 'shiftDnL', 'shiftDnR', 'shiftUpL', 'shiftUpR']);
});

test('Ride buttons: every button on every screen', () => {
  const L = (a) => `shiftUpL:${a} shiftDnL:${a} paddleL:${a}`, R = (a) => `shiftUpR:${a} shiftDnR:${a} paddleR:${a}`;
  const NOP = 'powerUpL:- onOffL:- powerUpR:- onOffR:-';
  const WANT = {
    home: `up:focusPrev down:focusNext left:tabPrev right:tabNext a:pick b:closePanels y:- z:- ${L('focusPrev')} ${R('focusNext')} ${NOP}`,
    homePanel: `up:focusPrev down:focusNext left:tabPrev right:tabNext a:pick b:closePanels y:- z:- ${L('focusPrev')} ${R('focusNext')} ${NOP}`,
    // the ride screen repeats a held D-pad up / down even before the session exists (old behavior, kept)
    rideNoSession: `up:focusPrev* down:focusNext* left:tabPrev right:tabNext a:pick b:closePanels y:- z:- ${L('focusPrev')} ${R('focusNext')} ${NOP}`,
    rideErg: `up:effortUp* down:effortDown* left:- right:- a:pause b:holdEnd y:holdSkip z:lap ${L('effortDown*')} ${R('effortUp*')} ${NOP}`,
    rideSlope: `up:gradeUp* down:gradeDown* left:- right:- a:pause b:holdEnd y:holdSkip z:lap ${L('shift')} ${R('shift')} ${NOP}`,
    rideErgPanel: `up:effortUp* down:effortDown* left:- right:- a:pause b:closePanels y:holdSkip z:lap ${L('effortDown*')} ${R('effortUp*')} ${NOP}`,
    rideSlopePanel: `up:gradeUp* down:gradeDown* left:- right:- a:pause b:closePanels y:holdSkip z:lap ${L('shift')} ${R('shift')} ${NOP}`,
    modalHome: `up:modalFirst down:modalLast left:modalFirst right:modalLast a:modalPress b:modalCancel y:- z:- ${L('modalFirst')} ${R('modalLast')} ${NOP}`,
    // on the ride the shifters send ERG's down / up even to a modal (left shifter = last button; old behavior, kept)
    modalRideErg: `up:modalFirst* down:modalLast* left:modalFirst right:modalLast a:modalPress b:modalCancel y:- z:- ${L('modalLast*')} ${R('modalFirst*')} ${NOP}`,
    // slope: the shifters keep shifting while a message shows
    modalRideSlope: `up:modalFirst* down:modalLast* left:modalFirst right:modalLast a:modalPress b:modalCancel y:- z:- ${L('shift')} ${R('shift')} ${NOP}`,
    builder: `up:- down:- left:- right:- a:- b:closeBuilder y:- z:- ${L('-')} ${R('-')} ${NOP}`,
    builderModal: `up:modalFirst down:modalLast left:modalFirst right:modalLast a:modalPress b:modalCancel y:- z:- ${L('modalFirst')} ${R('modalLast')} ${NOP}`,
    ridepage: `up:pageUp down:pageDown left:pagePrev right:pageNext a:pageSelect b:pageBack y:- z:- ${L('pagePrev')} ${R('pageNext')} ${NOP}`,
    busy: `up:- down:- left:- right:- a:- b:- y:- z:- ${L('-')} ${R('-')} ${NOP}`,
    busyRide: `up:- down:- left:- right:- a:- b:- y:- z:- ${L('shift')} ${R('shift')} ${NOP}`, // slope shifting rides on
  };
  for (const [k, st] of Object.entries(STATES)) {
    const want = table(WANT[k]);
    assert.deepEqual(Object.keys(want).sort(), Object.keys(BUTTON_VERBS).sort(), k);
    for (const b of Object.keys(BUTTON_VERBS)) assert.equal(buttonAction(st, b), un(want[b]), `${k} ${b}`);
  }
});

test('buttonPlan: shifters are menu easier / harder off the ride, ERG down / up (repeating) or a gear on it', () => {
  assert.deepEqual(buttonPlan(STATES.home, 'shiftUpL'), { verb: 'easier', repeat: false });
  assert.deepEqual(buttonPlan(STATES.home, 'paddleR'), { verb: 'harder', repeat: false });
  assert.deepEqual(buttonPlan(STATES.rideErg, 'shiftUpL'), { verb: 'down', repeat: true });
  assert.deepEqual(buttonPlan(STATES.rideErg, 'shiftDnR'), { verb: 'up', repeat: true });
  assert.deepEqual(buttonPlan(STATES.rideSlope, 'shiftDnR'), { shift: true });
  assert.deepEqual(buttonPlan(STATES.rideErg, 'up'), { verb: 'up', repeat: true });
  assert.deepEqual(buttonPlan(STATES.rideErg, 'a'), { verb: 'select', repeat: false });
  assert.deepEqual(buttonPlan(STATES.home, 'down'), { verb: 'down', repeat: false });
  assert.deepEqual(buttonPlan(STATES.ridepage, 'down'), { verb: 'down', repeat: false });
  assert.deepEqual(buttonPlan(STATES.rideErg, 'onOffR'), { verb: null, repeat: false });
  assert.deepEqual(buttonPlan(STATES.rideErg, 'nope'), { verb: null, repeat: false });
});

test('shiftFor / pairsFront: every shifter, every style, 1x / 2x / sequential', () => {
  const oneX = { isDouble: false }, twoX = { isDouble: true }, seq = { isDouble: false, seq: true };
  const fmt = (r) => (r ? `${r[0]}${r[1] > 0 ? '+' : '-'}` : '-');
  const cases = [
    // [style, gearbox, 'shiftUpL shiftDnL paddleL shiftUpR shiftDnR paddleR']
    ['right', oneX, '- - - rear+ rear- rear+'],
    ['sram', oneX, '- - - rear+ rear- rear+'], // a 1x reads any style but 'left' as the right-hand shifter
    ['shimano', oneX, '- - - rear+ rear- rear+'],
    ['left', oneX, 'rear+ rear- rear+ - - -'],
    ['sram', twoX, 'rear- rear- rear- rear+ rear+ rear+'],
    ['', twoX, 'rear- rear- rear- rear+ rear+ rear+'], // no style saved = SRAM
    [undefined, twoX, 'rear- rear- rear- rear+ rear+ rear+'],
    ['shimano', twoX, 'front+ front- rear- rear+ rear- rear+'],
    ['shimano', seq, 'rear+ rear- rear- rear+ rear- rear+'],
    ['sram', seq, 'rear- rear- rear- rear+ rear+ rear+'],
    ['right', seq, 'rear- rear- rear- rear+ rear+ rear+'],
  ];
  const order = ['shiftUpL', 'shiftDnL', 'paddleL', 'shiftUpR', 'shiftDnR', 'paddleR'];
  for (const [style, gb, want] of cases) assert.equal(order.map((b) => fmt(shiftFor(b, style, gb))).join(' '), want, `${style} ${JSON.stringify(gb)}`);
  assert.equal(pairsFront('sram', twoX), true);
  assert.equal(pairsFront(undefined, twoX), true);
  assert.equal(pairsFront('right', twoX), true); // a 1x style left on a 2x bike shifts like SRAM
  assert.equal(pairsFront('shimano', twoX), false);
  assert.equal(pairsFront('sram', oneX), false);
  assert.equal(pairsFront('sram', seq), false);
});

test('keys: every key on every screen', () => {
  assert.deepEqual(Object.keys(KEY_VERBS).sort(), ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'Escape', 's', 'l', 'e', '[', ']', 'f'].sort());
  const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Escape', 's', 'l', 'e', '[', ']', 'f', 'x', '+', 'S'];
  const key = (k) => (k === 'Space' ? ' ' : k);
  const tail = 'x:- +:- S:-'; // unmapped (the demo's + / - rider power is handled before the map); S with Shift held is not s
  const WANT = {
    home: `ArrowLeft:tabPrev ArrowRight:tabNext ArrowUp:focusPrev ArrowDown:focusNext Space:pick Enter:pick Escape:closePanels s:- l:- e:- [:focusPrev ]:focusNext f:- ${tail}`,
    homePanel: `ArrowLeft:tabPrev ArrowRight:tabNext ArrowUp:focusPrev ArrowDown:focusNext Space:pick Enter:pick Escape:closePanels s:- l:- e:- [:focusPrev ]:focusNext f:- ${tail}`,
    rideNoSession: `ArrowLeft:focusPrev ArrowRight:focusNext ArrowUp:focusPrev ArrowDown:focusNext Space:pick Enter:pick Escape:closePanels s:- l:- e:- [:focusPrev ]:focusNext f:- ${tail}`,
    rideErg: `ArrowLeft:effortDown ArrowRight:effortUp ArrowUp:effortUp ArrowDown:effortDown Space:pause Enter:pause Escape:holdEnd s:holdSkip l:lap e:ergToggle [:effortDown ]:effortUp f:front ${tail}`,
    rideSlope: `ArrowLeft:shiftEasier ArrowRight:shiftHarder ArrowUp:gradeUp ArrowDown:gradeDown Space:pause Enter:pause Escape:holdEnd s:holdSkip l:lap e:ergToggle [:shiftEasier ]:shiftHarder f:front ${tail}`,
    rideErgPanel: `ArrowLeft:effortDown ArrowRight:effortUp ArrowUp:effortUp ArrowDown:effortDown Space:pause Enter:pause Escape:closePanels s:holdSkip l:lap e:ergToggle [:effortDown ]:effortUp f:front ${tail}`,
    rideSlopePanel: `ArrowLeft:shiftEasier ArrowRight:shiftHarder ArrowUp:gradeUp ArrowDown:gradeDown Space:pause Enter:pause Escape:closePanels s:holdSkip l:lap e:ergToggle [:shiftEasier ]:shiftHarder f:front ${tail}`,
    modalHome: `ArrowLeft:modalFirst ArrowRight:modalLast ArrowUp:modalFirst ArrowDown:modalLast Space:modalPress Enter:modalPress Escape:modalCancel s:- l:- e:- [:modalFirst ]:modalLast f:- ${tail}`,
    modalRideErg: `ArrowLeft:modalFirst ArrowRight:modalLast ArrowUp:modalFirst ArrowDown:modalLast Space:modalPress Enter:modalPress Escape:modalCancel s:- l:- e:- [:modalFirst ]:modalLast f:- ${tail}`,
    modalRideSlope: `ArrowLeft:modalFirst ArrowRight:modalLast ArrowUp:modalFirst ArrowDown:modalLast Space:modalPress Enter:modalPress Escape:modalCancel s:- l:- e:- [:modalFirst ]:modalLast f:- ${tail}`,
    builder: `ArrowLeft:- ArrowRight:- ArrowUp:- ArrowDown:- Space:- Enter:- Escape:closeBuilder s:- l:- e:- [:- ]:- f:- ${tail}`,
    // over the builder only Esc gets through (Space / Enter press the focused modal button natively)
    builderModal: `ArrowLeft:- ArrowRight:- ArrowUp:- ArrowDown:- Space:- Enter:- Escape:modalCancel s:- l:- e:- [:- ]:- f:- ${tail}`,
    ridepage: `ArrowLeft:pagePrev ArrowRight:pageNext ArrowUp:pageUp ArrowDown:pageDown Space:pageSelect Enter:pageSelect Escape:pageBack s:- l:- e:- [:pagePrev ]:pageNext f:- ${tail}`,
    busy: `ArrowLeft:- ArrowRight:- ArrowUp:- ArrowDown:- Space:- Enter:- Escape:- s:- l:- e:- [:- ]:- f:- ${tail}`,
    busyRide: `ArrowLeft:- ArrowRight:- ArrowUp:- ArrowDown:- Space:- Enter:- Escape:- s:- l:- e:- [:- ]:- f:- ${tail}`,
  };
  for (const [k, st] of Object.entries(STATES)) {
    const want = table(WANT[k]);
    assert.deepEqual(Object.keys(want), KEYS, k);
    for (const kk of KEYS) assert.equal(keyAction(st, key(kk)), un(want[kk]), `${k} ${JSON.stringify(key(kk))}`);
  }
});

test('keys held: auto-repeat never restarts a skip / end hold on the ride; elsewhere it repeats', () => {
  assert.equal(keyAction(STATES.rideErg, 's', true), null);
  assert.equal(keyAction(STATES.rideSlope, 'Escape', true), null);
  assert.equal(keyAction(STATES.rideErgPanel, 'Escape', true), null); // the first keydown closed the panel
  assert.equal(keyAction(STATES.rideErg, 'ArrowUp', true), 'effortUp');
  assert.equal(keyAction(STATES.rideSlope, ']', true), 'shiftHarder');
  assert.equal(keyAction(STATES.home, 'Escape', true), 'closePanels');
  assert.equal(keyAction(STATES.ridepage, 'Escape', true), 'pageBack');
  assert.equal(keyVerb(STATES.rideErg, 's'), 'skip');
  assert.equal(keyVerb(STATES.rideErg, 's', true), null);
  assert.equal(keyVerb(STATES.builder, 'Enter'), null);
  assert.equal(keyVerb(STATES.builder, 'Escape'), 'back');
});

console.log(`controls: ${n} tests passed`);
