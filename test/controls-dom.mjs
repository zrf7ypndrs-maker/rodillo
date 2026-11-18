// js/controls.js, the DOM part: the dispatch table, Ride buttons (repeat, de-dupe, shift styles), hold to confirm and
// the keyboard listener, run against a fake document, window and clock (setTimeout / performance.now) with
// recording app.js hooks. The browser version of the same is the controller run in test/smoke.mjs.
import assert from 'node:assert/strict';

const print = console.log; // logMsg() prints every controller press; keep the output to the test lines
console.log = (...a) => { if (!String(a[0]).startsWith('[controller]')) print(...a); };

// ---- fake clock: setTimeout / clearTimeout / performance.now follow clock.t, advanced by hand
const clock = { t: 0, timers: [], id: 0 };
globalThis.setTimeout = (f, ms = 0) => { const id = ++clock.id; clock.timers.push({ id, at: clock.t + ms, f }); return id; };
globalThis.clearTimeout = (id) => { clock.timers = clock.timers.filter((x) => x.id !== id); };
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock.t }, configurable: true });
const advance = (ms) => {
  const end = clock.t + ms;
  for (;;) {
    const next = clock.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!next) break;
    clock.timers = clock.timers.filter((x) => x !== next);
    clock.t = next.at;
    next.f();
  }
  clock.t = end;
};

// ---- fake DOM: elements by selector, classes, the listeners initControls() adds
class El {
  constructor(name, cls = []) {
    this.name = name; this.cls = new Set(cls); this.dataset = {}; this.textContent = ''; this.clicks = 0; this.scrolled = 0; this.offsetWidth = 1;
    this.style = { props: {}, setProperty: (k, v) => { this.style.props[k] = v; } };
    this.classList = {
      add: (...c) => c.forEach((x) => this.cls.add(x)), remove: (...c) => c.forEach((x) => this.cls.delete(x)),
      contains: (c) => this.cls.has(c), toggle: (c, on) => (on ?? !this.cls.has(c) ? this.cls.add(c) : this.cls.delete(c)),
    };
    this.startday = null;
  }
  click() { this.clicks++; }
  scrollIntoView() { this.scrolled++; }
  querySelector(s) { return s === '[data-startday]' ? this.startday : null; }
}
const one = {}, many = {}, all = [];
const el = (name, cls) => { const e = new El(name, cls); all.push(e); return e; };
for (const id of ['#hold', '#hold-msg', '#hold-key', '#hold-sub', '#rp-sheet', '#toast', '#btn-new-wo']) one[id] = el(id);
one['#hold'].classList.add('hidden');
const panels = [el('panel-settings', ['panel', 'hidden']), el('panel-controls', ['panel', 'hidden'])];
const kinds = [el('kind-erg'), el('kind-slope')];
const rows = [0, 1, 2].map((i) => { const r = el(`row${i}`, ['wo']); r.dataset.i = String(i); return r; });
const slopeRows = [el('slope0', ['wo'])]; slopeRows[0].dataset.i = '5';
const day = el('day', ['day']); day.startday = el('startday');
const hero = [day, el('hero-free')];
many['.panel'] = () => panels;
many['#wo-kind button:not(.hidden)'] = () => kinds.filter((k) => !k.cls.has('hidden'));
many['#workout-list .wo'] = () => rows;
many['#slope-list .wo'] = () => slopeRows;
many['#mine-list .wo'] = () => [];
many['#today .hero-btns button'] = () => hero;
many['.focus'] = () => all.filter((e) => e.cls.has('focus'));
const listeners = [];
globalThis.document = {
  hidden: false,
  querySelector: (s) => one[s] ?? null,
  querySelectorAll: (s) => (many[s] ? many[s]() : []),
  addEventListener: (type, f, capture) => listeners.push({ on: 'document', type, f, capture: !!capture }),
};
globalThis.window = { addEventListener: (type, f) => listeners.push({ on: 'window', type, f }) };

const { initControls, action, onButton, onRelease, holdStart, holdEnd, focusables, applyFocus, SCREENS, VERBS, actionFor } = await import('../js/controls.js');

// ---- the app: state and recording hooks
const log = [];
const vib = { n: 0 };
const app = {
  screen: 'home', tab: 'workouts', woKind: 'erg', focus: 0, usedNav: false, launching: false, session: null, settings: { shiftStyle: 'sram' },
  library: [{ name: 'W0' }, { name: 'W1' }, { name: 'W2' }, , , { name: 'W5' }], controllers: [{ vibrate: () => vib.n++ }, {}], demo: false, trainer: null,
};
const flags = { modal: false, devpop: false, short: false };
const TABS = ['today', 'workouts', 'calendar', 'training'];
initControls({
  app, TABS,
  modalOpen: () => flags.modal, devPopOpen: () => flags.devpop,
  setDevPop: (v) => { flags.devpop = !!v; log.push(`setDevPop ${v}`); },
  setTab: (t) => { app.tab = t; app.focus = 0; log.push(`setTab ${t}`); },
  startWorkout: (w) => log.push(`startWorkout ${w.name}`),
  rideAction: (what) => log.push(`rideAction ${what}`),
  modalAction: (what, a) => log.push(`modalAction ${what} ${a}`),
  renderRide: () => log.push('renderRide'),
  tooShort: () => flags.short,
  endSession: () => { log.push('endSession'); app.session = null; app.screen = 'home'; },
});
function session({ erg = true, double = true, seq = false, segs = true, seg = true, inTest = false } = {}) {
  const s = {
    mode: erg ? 'erg' : 'sim', intensity: 1, gradeOffset: 0, ergOff: false, inTest, segs: segs ? [{}, {}, {}] : null, seg: seg ? {} : null, rear: 3, front: 1,
    gb: { isDouble: double, seq },
    bump(d) { if (this.mode === 'erg') this.intensity = Math.round((this.intensity + d / 100) * 100) / 100; else this.gradeOffset = Math.round((this.gradeOffset + d / 100) * 100) / 100; },
    shift(d) { this.rear += d; log.push(`shift ${d}`); }, shiftFront(d) { this.front += d; log.push(`shiftFront ${d}`); }, toggleFront() { this.front = 1 - this.front; log.push('toggleFront'); },
    togglePause() { log.push('togglePause'); }, lap() { log.push('lap'); }, toggleErg() { this.ergOff = !this.ergOff; log.push('toggleErg'); },
    skip() { log.push('skip'); }, endTest(r) { log.push(`endTest ${r}`); },
  };
  app.session = s; app.screen = 'ride';
  return s;
}
const reset = () => {
  log.length = 0; Object.assign(flags, { modal: false, devpop: false, short: false });
  holdEnd(); clock.timers = []; clock.t += 1000; // past any de-dupe window
  panels.forEach((p) => p.classList.add('hidden'));
  Object.assign(app, { screen: 'home', tab: 'workouts', woKind: 'erg', focus: 0, usedNav: false, launching: false, session: null, demo: false, trainer: null });
  all.forEach((e) => e.cls.delete('focus'));
};
const press = (b, ms = 40) => { onButton(b, { side: 'left' }); advance(ms); onRelease(b); advance(100); };
const toastText = () => one['#toast'].textContent;
const shown = (e) => !e.cls.has('hidden');
const key = (k, extra = {}) => {
  const ev = { key: k, repeat: false, target: { tagName: 'BODY' }, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  for (const l of listeners.filter((x) => x.type === 'keydown').sort((a, b) => b.capture - a.capture)) l.f(ev);
  return ev;
};
const keyup = (k) => listeners.filter((x) => x.type === 'keyup').forEach((l) => l.f({ key: k }));

let n = 0;
const test = (name, fn) => { reset(); fn(); n++; console.log('ok -', name); };

test('initControls adds blur, visibility, keydown, keyup and the capture keydown that marks keyboard use', () => {
  assert.deepEqual(listeners.map((l) => `${l.on} ${l.type}${l.capture ? ' capture' : ''}`), ['window blur', 'document visibilitychange', 'document keydown', 'document keyup', 'document keydown capture']);
});

test('every action the table can return has a handler, on every screen', () => {
  const states = {
    busy: () => { app.launching = true; }, modal: () => { flags.modal = true; }, builder: null, ridepage: () => { app.screen = 'ridepage'; },
    'ride-erg': () => session(), 'ride-slope': () => session({ erg: false }), 'ride-erg-panel': () => { session(); flags.devpop = true; },
    'ride-slope-panel': () => { session({ erg: false }); panels[0].classList.remove('hidden'); }, home: () => {},
  };
  for (const screen of SCREENS) {
    if (!states[screen]) continue; // the builder needs js/builder.js open: its one action (closeBuilder) is the smoke test's
    for (const v of VERBS) {
      reset(); states[screen]();
      assert.doesNotThrow(() => action(v, 'key'), `${screen} ${v} -> ${actionFor(screen, v)}`);
    }
  }
});

test('home: focus ring, tabs wrap both ways, pick by kind of item, B closes panels and Connections', () => {
  action('down');
  assert.equal(app.focus, 1);
  assert.equal(all.filter((e) => e.cls.has('focus')).length, 0, 'no ring before a key or button was used');
  press('down'); // a Ride button counts as navigation
  assert.equal(app.usedNav, true);
  assert.equal(app.focus, 2);
  assert.deepEqual(all.filter((e) => e.cls.has('focus')).map((e) => e.name), ['row0']);
  assert.equal(rows[0].scrolled, 1);
  press('shiftUpR'); press('paddleR'); press('paddleR'); press('paddleR');
  assert.equal(app.focus, 4, 'clamped at the last item');
  press('shiftDnL'); assert.equal(app.focus, 3);
  press('a'); assert.deepEqual(log.slice(-1), ['startWorkout W1']);
  const clicks = () => [kinds[0].clicks, day.startday.clicks, hero[1].clicks].join();
  const c0 = [kinds[0].clicks, day.startday.clicks, hero[1].clicks];
  app.focus = 0; press('a'); assert.equal(clicks(), [c0[0] + 1, c0[1], c0[2]].join(), 'a switch is clicked');
  app.tab = 'today'; app.focus = 0; press('a'); assert.equal(clicks(), [c0[0] + 1, c0[1] + 1, c0[2]].join(), 'a day card presses its Start');
  app.focus = 1; press('a'); assert.equal(clicks(), [c0[0] + 1, c0[1] + 1, c0[2] + 1].join(), 'a hero button is clicked');
  app.tab = 'calendar'; app.focus = 0; press('down'); assert.equal(app.focus, -1, 'no controller list: focus goes to -1 (old behavior)');
  press('up'); assert.equal(app.focus, 0);
  press('a'); // nothing to pick
  app.tab = 'workouts';
  for (const t of ['calendar', 'training', 'today', 'workouts']) { press('right'); assert.equal(app.tab, t); }
  press('left'); press('left'); assert.equal(app.tab, 'training');
  app.tab = 'workouts';
  app.woKind = 'slope'; assert.deepEqual(focusables().map((e) => e.name), ['kind-erg', 'kind-slope', 'slope0']);
  app.woKind = 'mine'; assert.deepEqual(focusables().map((e) => e.name), ['kind-erg', 'kind-slope', '#btn-new-wo']);
  app.focus = 2; app.woKind = 'slope'; press('a'); assert.equal(log.at(-1), 'startWorkout W5');
  panels[1].classList.remove('hidden'); flags.devpop = true;
  press('b');
  assert.ok(panels.every((p) => p.cls.has('hidden')) && !flags.devpop);
  app.screen = 'ride'; app.usedNav = true; app.focus = 0; applyFocus();
  assert.equal(all.filter((e) => e.cls.has('focus')).length, 0, 'no ring off the home screen');
});

test('a button sent by both hoods within 90 ms counts once; again after 90 ms', () => {
  onButton('right', { side: 'left' }); onButton('right', { side: 'right' }); advance(89); onButton('right', { side: 'right' });
  assert.equal(app.tab, 'calendar');
  advance(1); onButton('right', { side: 'left' });
  assert.equal(app.tab, 'training');
  onButton('powerUpL'); onButton('onOffR'); // nothing
  assert.equal(app.tab, 'training');
});

test('ride, ERG: shifters / D-pad change the effort, repeat while held (450 ms, then every 120 ms), stop on release', () => {
  const s = session();
  press('shiftUpR'); assert.equal(s.intensity, 1.01); assert.equal(toastText(), 'Intensity 101%');
  press('paddleL'); assert.equal(s.intensity, 1);
  onButton('shiftDnR'); advance(449); assert.equal(s.intensity, 1.01);
  advance(1); assert.equal(s.intensity, 1.02);
  advance(120 * 3); assert.equal(s.intensity, 1.05);
  onRelease('shiftDnR'); advance(1000); assert.equal(s.intensity, 1.05);
  onButton('down'); advance(450 + 120); onRelease('down'); advance(1000); assert.equal(s.intensity, 1.02);
  press('a'); assert.ok(log.includes('togglePause'));
  press('z'); assert.equal(toastText(), 'Laps are automatic per interval');
  key('f'); assert.ok(log.includes('toggleFront'));
  s.gb.isDouble = false; key('f'); assert.equal(toastText(), '1x: no front shifting');
  key('e'); assert.equal(toastText(), 'ERG off: slope mode');
  key('e'); assert.equal(toastText(), 'ERG on');
  key('ArrowLeft'); assert.equal(s.intensity, 1.01);
  assert.ok(log.filter((x) => x === 'renderRide').length >= 10);
});

test('ride, slope: D-pad grade, arrows rear; free ride laps, no ERG toggle', () => {
  const s = session({ erg: false, segs: false, seg: false });
  press('up'); assert.equal(s.gradeOffset, 0.01); assert.equal(toastText(), 'Grade 1%');
  key('ArrowRight'); key('['); key(']');
  assert.deepEqual(log.filter((x) => x.startsWith('shift')), ['shift 1', 'shift -1', 'shift 1']);
  press('z'); assert.ok(log.includes('lap'));
  key('e'); assert.ok(!log.includes('toggleErg'));
});

test('ride, slope shifters: SRAM 2x pairs left + right within 140 ms (front), Shimano, 1x, sequential', () => {
  let s = session({ erg: false });
  onButton('shiftUpR'); advance(139); assert.equal(s.rear, 3); advance(1); assert.equal(s.rear, 4);
  onButton('shiftUpL'); advance(100); onButton('shiftDnR'); advance(500);
  assert.equal(s.front, 0); assert.equal(s.rear, 4, 'left + right together: front only');
  onButton('paddleL'); advance(140); onButton('paddleR'); advance(200);
  assert.equal(s.rear, 4, 'apart: one each way');
  reset(); app.settings.shiftStyle = 'shimano'; s = session({ erg: false });
  onButton('shiftUpL'); assert.equal(s.front, 2); onButton('shiftDnR'); assert.equal(s.rear, 2);
  reset(); app.settings.shiftStyle = 'left'; s = session({ erg: false, double: false });
  onButton('shiftUpR'); onButton('shiftUpL'); assert.equal(s.rear, 4);
  reset(); app.settings.shiftStyle = 'shimano'; s = session({ erg: false, double: false, seq: true });
  onButton('shiftDnL'); assert.equal(s.rear, 2);
  app.settings.shiftStyle = 'sram';
});

test('B / Esc with a panel or Connections open on the ride close it, without a hold', () => {
  session(); panels[0].classList.remove('hidden');
  press('b');
  assert.ok(panels[0].cls.has('hidden'));
  assert.ok(one['#hold'].cls.has('hidden'));
  assert.ok(!log.includes('renderRide'), 'closing a panel does not redraw the ride');
  flags.devpop = true; key('Escape'); assert.equal(flags.devpop, false);
  advance(6000); assert.ok(!log.includes('endSession'));
});

test('hold to confirm: B 5 s ends, Y 3 s skips, let go early cancels; ring text per source', () => {
  const s = session();
  onButton('b');
  assert.ok(shown(one['#hold']) && one['#hold'].cls.has('end') && one['#hold'].cls.has('run'));
  assert.equal(one['#hold-key'].textContent, 'B'); assert.equal(one['#hold-msg'].textContent, 'End ride?');
  assert.equal(one['#hold-sub'].textContent, 'Keep holding B to end'); assert.equal(one['#hold'].style.props['--hold-ms'], '5000ms');
  advance(4999); onRelease('b');
  assert.ok(one['#hold'].cls.has('hidden') && !log.includes('endSession'));
  onButton('y'); advance(2999); onRelease('y');
  assert.ok(one['#hold'].cls.has('hidden') && !log.includes('skip'), 'Y let go before 3 s');
  advance(150);
  onButton('y'); assert.equal(one['#hold-sub'].textContent, 'Keep holding Y to skip'); assert.ok(one['#hold'].cls.has('skip'));
  advance(3000); onRelease('y');
  assert.ok(log.includes('skip')); assert.equal(toastText(), 'Skipped'); assert.equal(vib.n, 1);
  flags.short = true;
  const ev = key('Escape');
  assert.ok(ev.prevented); assert.equal(one['#hold-key'].textContent, 'Esc'); assert.ok(one['#hold-key'].cls.has('word'));
  assert.equal(one['#hold-sub'].textContent, 'Under 10 s, nothing will be saved');
  key('Escape', { repeat: true }); key('s'); // auto-repeat doesn't restart it; another kind replaces it
  assert.ok(one['#hold'].cls.has('skip')); keyup('s'); assert.ok(one['#hold'].cls.has('hidden'));
  key('Escape'); advance(5000);
  assert.ok(log.includes('endSession')); assert.equal(app.session, null);
  assert.ok(one['#rp-sheet'].cls.has('hidden'));
  void s;
});

test('hold to confirm: a ramp test ends the test (cool-down), no skip without steps, tap fills the sheet button', () => {
  let s = session({ inTest: true });
  onButton('b'); assert.equal(one['#hold-msg'].textContent, 'End the test?'); assert.equal(one['#hold-sub'].textContent, 'Keep holding B: cool-down next');
  advance(5000); assert.ok(log.includes('endTest manual')); assert.ok(app.session === s);
  reset(); s = session({ segs: false });
  onButton('y'); assert.ok(one['#hold'].cls.has('hidden'), 'free ride: nothing to skip');
  holdStart('end', 'tap'); assert.ok(one['#hold'].cls.has('hidden'), 'a tap hold needs its button');
  const btn = new El('rp-end');
  holdStart('end', 'tap', btn); holdStart('end', 'tap', btn); // the same hold again is ignored
  assert.ok(btn.cls.has('filling')); assert.equal(btn.style.props['--hold-ms'], '2000ms');
  holdEnd('skip'); assert.ok(btn.cls.has('filling'), 'ending another kind leaves it');
  holdEnd('end'); assert.ok(!btn.cls.has('filling'));
  holdStart('end', 'mouse'); assert.ok(one['#hold'].cls.has('hidden'), 'mouse clicks get the confirm screen instead');
  // pointerdown and touchstart both arrive for one press (Bluefy): the second must not restart the 2 s
  holdStart('end', 'tap', btn); advance(1500); holdStart('end', 'tap', btn); advance(500); assert.ok(log.includes('endSession'));
  holdStart('end', 'key'); assert.ok(one['#hold'].cls.has('hidden'), 'no ride: no hold');
});

test('a hold is dropped when the window loses focus or the page is hidden', () => {
  session();
  const blur = listeners.find((l) => l.type === 'blur'), vis = listeners.find((l) => l.type === 'visibilitychange');
  key('Escape'); blur.f(); assert.ok(one['#hold'].cls.has('hidden'));
  key('Escape'); vis.f(); assert.ok(shown(one['#hold']), 'visible page keeps it');
  document.hidden = true; vis.f(); document.hidden = false; assert.ok(one['#hold'].cls.has('hidden'));
  advance(6000); assert.ok(!log.includes('endSession'));
});

test('keyboard: inputs, demo rider power, unmapped keys, the capture listener, ride page and modal routing', () => {
  const ev = key('ArrowDown', { target: { tagName: 'INPUT' } });
  assert.ok(!ev.prevented); assert.equal(app.focus, 0); assert.equal(app.usedNav, true, 'any key marks keyboard use');
  assert.ok(!key('x').prevented);
  app.demo = true; app.trainer = { riderPower: 200 };
  key('+'); key('='); key('-'); assert.equal(app.trainer.riderPower, 220); assert.equal(toastText(), 'Demo rider: 220 W');
  app.demo = false; key('-'); assert.equal(app.trainer.riderPower, 220);
  app.screen = 'ridepage';
  key('ArrowLeft'); key('Enter'); press('b'); press('shiftUpR');
  assert.deepEqual(log.slice(-4), ['rideAction prev', 'rideAction select', 'rideAction back', 'rideAction next']);
  flags.modal = true;
  key('ArrowRight'); press('y'); key('Enter');
  assert.deepEqual(log.slice(-3), ['modalAction last right', 'modalAction null skip', 'modalAction press select']);
  app.launching = true; flags.modal = false; app.screen = 'home';
  key('ArrowRight'); assert.equal(app.tab, 'workouts');
});

console.log(`controls (DOM part): ${n} tests passed`);
