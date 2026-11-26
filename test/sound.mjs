// Tap sounds and phone haptics (js/sound.js): the setting, which controls play what, the controller actions, the
// one-sound-per-action rule, how a device ticks; then the player and the iPhone label overlays against a fake
// document, AudioContext and clock. Expectations are written out by hand.
import assert from 'node:assert/strict';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };

// ---- fakes (before the module loads: it reads them at call time)
const clock = { t: 0, timers: [], id: 0 };
globalThis.setTimeout = /** @type {any} */ ((f, ms = 0) => { const id = ++clock.id; clock.timers.push({ id, at: clock.t + ms, f }); return id; });
globalThis.clearTimeout = /** @type {any} */ ((id) => { clock.timers = clock.timers.filter((x) => x.id !== id); });
const advance = (ms) => {
  const end = clock.t + ms;
  for (;;) {
    const next = clock.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    clock.timers = clock.timers.filter((x) => x !== next);
    clock.t = next.at;
    next.f();
  }
  clock.t = end;
};
globalThis.performance = /** @type {any} */ ({ now: () => clock.t });
const flush = () => new Promise((r) => setImmediate(r));

/** A fake element: `is` = the selectors it matches itself, parent for closest(). */
function el(is = [], parent = null, id = '') {
  const e = {
    id, is, parent, children: [], classes: new Set(), attrs: {}, dataset: {}, clicks: 0,
    closest(sel) {
      const parts = sel.split(',').map((s) => s.trim());
      for (let x = e; x; x = x.parent) if (parts.some((p) => x.is.includes(p))) return x;
      return null;
    },
    querySelector(sel) { return sel === ':scope > .hx' ? e.children.find((c) => c.className === 'hx') || null : null; },
    classList: { add: (c) => e.classes.add(c) },
    append(c) { c.parent = e; c.parentElement = e; c.is = [...(c.is || []), '.hx', 'label.hx']; e.children.push(c); },
    contains(x) { for (let y = x; y; y = y.parent) if (y === e) return true; return false; },
    click() { e.clicks++; },
    dispatchEvent(ev) { if (ev.type === 'click') e.clicks++; return true; },
    setAttribute(k, v) { e.attrs[k] = v; },
    addEventListener() {},
  };
  return e;
}

// ---- the pure half
const s = await import('../js/sound.js');
const { tapChoice, soundWanted, hapticWanted, hapticKind, roleOf, actionSound, shouldPlay, DEDUPE, NAV_GAP } = s;

assert.equal(tapChoice(undefined), 'all');
assert.equal(tapChoice('sound'), 'sound');
assert.equal(tapChoice('haptic'), 'haptic');
assert.equal(tapChoice('off'), 'off');
assert.equal(tapChoice('loud'), 'all');
assert.equal(soundWanted('all', 'home'), true);
assert.equal(soundWanted('sound', 'ridepage'), true);
assert.equal(soundWanted('haptic', 'home'), false);
assert.equal(soundWanted('off', 'home'), false);
assert.equal(soundWanted('all', 'ride'), false);
assert.equal(hapticWanted('all', 'home'), true);
assert.equal(hapticWanted('haptic', 'home'), true);
assert.equal(hapticWanted('sound', 'home'), false);
assert.equal(hapticWanted('all', 'ride'), false);
ok('setting: sound and haptics on, either alone, or off; never on the ride screen');

assert.equal(hapticKind({ phone: false, vibrate: true, ios: false }), 'none');
assert.equal(hapticKind({ phone: true, vibrate: true, ios: false }), 'vibrate');
assert.equal(hapticKind({ phone: true, vibrate: false, ios: true }), 'switch');
assert.equal(hapticKind({ phone: true, vibrate: false, ios: false }), 'none');
ok('haptics: Android vibrates, iPhone uses the switch, desktop and others none');

const tabs = el(['#tabs']);
assert.equal(roleOf(el(['button', '#tabs button'], tabs)), 'navigate');
assert.equal(roleOf(el(['button', '#cal-prev'])), 'navigate');
assert.equal(roleOf(el(['button', '#set-tabs button'])), 'navigate');
assert.equal(roleOf(el(['button', '[data-close]'])), 'back');
assert.equal(roleOf(el(['#scrim'])), 'back');
assert.equal(roleOf(el(['button', '[data-rd="back"]'])), 'back');
assert.equal(roleOf(el([], null, 'modal')), 'back');
const card = el(['.day[data-day]']);
assert.equal(roleOf(el(['span'], card)), 'click', 'text inside a day card');
assert.equal(roleOf(el(['button'])), 'click');
assert.equal(roleOf(el(['.wo'])), 'click');
assert.equal(roleOf(el(['div'])), null, 'not a control');
assert.equal(roleOf(el(['input'])), null, 'form fields: none');
assert.equal(roleOf(el(['button'], el(['#ride']))), null, 'ride screen: none');
assert.equal(roleOf(el(['label.hx', '.hx'], el(['button']))), null, 'the iPhone label itself');
assert.equal(roleOf(null), null);
ok('clicks: tabs, months and settings tabs navigate; Close, scrim, backdrop and the ride page back go back; other controls click');

assert.equal(actionSound('focusNext'), 'navigate');
assert.equal(actionSound('focusNext', { moved: false }), null, 'end of the list: nothing');
assert.equal(actionSound('tabPrev'), 'navigate');
assert.equal(actionSound('modalLast'), 'navigate');
assert.equal(actionSound('pageUp'), 'navigate');
assert.equal(actionSound('closePanels', { open: true }), 'back');
assert.equal(actionSound('closePanels', { open: false }), null, 'B with nothing open');
assert.equal(actionSound('modalCancel'), 'back');
assert.equal(actionSound('pageBack'), 'back');
assert.equal(actionSound('closeBuilder'), 'back');
assert.equal(actionSound('pick'), null, 'pick clicks an element: that click plays');
assert.equal(actionSound('modalPress'), null);
assert.equal(actionSound('effortUp'), null, 'ride actions: none');
assert.equal(actionSound('holdEnd'), null);
assert.equal(actionSound(null), null);
ok('controller: focus, tabs, modal and ride page moves navigate; closes go back; presses and ride actions play nothing themselves');

assert.equal(DEDUPE, 50); assert.equal(NAV_GAP, 30);
assert.equal(shouldPlay('click', 1000, { any: 960, nav: 0 }), false, 'within 50 ms of the last sound');
assert.equal(shouldPlay('click', 1000, { any: 950, nav: 0 }), true);
assert.equal(shouldPlay('navigate', 1000, { any: 900, nav: 980 }), false, 'navigate within 30 ms of the last navigate');
assert.equal(shouldPlay('navigate', 1000, { any: 900, nav: 970 }), true);
ok('one sound per action (50 ms), navigate at most every 30 ms');

s.tap('click'); // before initSound: nothing to do, no error
ok('tap() before init does nothing');

// ---- the DOM half: the player and the iPhone overlays
const listeners = {};
const fire = (ev, e = {}) => (listeners[ev] || []).forEach((f) => f({ stopPropagation() { e.stopped = true; }, preventDefault() { e.prevented = true; }, ...e }));
const body = el(['body']);
const switches = [];
const button = el(['button']), dayCard = el(['.day[data-day]']), rideBtn = el(['button'], el(['#ride']));
let observer = null;
globalThis.document = /** @type {any} */ ({
  body,
  addEventListener: (ev, f) => { (listeners[ev] ||= []).push(f); },
  querySelectorAll: (sel) => (sel === '.hx' ? [button, dayCard].flatMap((x) => x.children) : [button, dayCard, rideBtn]),
  createElement: (tag) => { const x = el([tag]); if (tag === 'input') switches.push(x); x.classList.contains = (c) => x.className === c; return x; },
  elementsFromPoint: () => underTap,
});
const inner = el(['span'], button); inner.classList.contains = () => false;

body.append = (x) => { x.parent = body; };
let underTap = [];
globalThis.MutationObserver = /** @type {any} */ (class { constructor(f) { observer = f; } observe() {} });
globalThis.MouseEvent = /** @type {any} */ (class { constructor(type, init) { this.type = type; Object.assign(this, init); } });
globalThis.window = /** @type {any} */ (globalThis);
globalThis.requestAnimationFrame = /** @type {any} */ ((f) => setTimeout(f, 16));
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'iPhone', vibrate: undefined }, configurable: true });
const fetched = [];
globalThis.fetch = /** @type {any} */ ((url) => { fetched.push(url); return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve({ url }) }); });
const fake = {
  state: 'suspended', made: 0, starts: [], resumes: 0, suspends: 0, destination: {},
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); },
  suspend() { this.state = 'suspended'; this.suspends++; return Promise.resolve(); },
  createGain() { return { gain: { value: 1 }, connect() {} }; },
  decodeAudioData(b) { return Promise.resolve({ decoded: b.url }); },
  createBufferSource() { const src = { detune: { value: 0 }, connect() {}, start: () => fake.starts.push({ buf: src.buffer.decoded, detune: src.detune.value }) }; return src; },
};
const app = /** @type {any} */ ({ settings: { taps: 'all' }, screen: 'home' });
s.initSound({ app, makeAudio: () => { fake.made++; return /** @type {any} */ (fake); }, isPhone: () => true });

assert.equal(s.soundLog().kind, 'switch');
const sw = switches[0];
assert.equal(sw.id, 'hx-switch'); assert.equal(sw.type, 'checkbox'); assert.equal(sw.attrs.switch, ''); assert.equal(sw.tabIndex, -1);
const labelOf = (x) => x.children.find((c) => c.className === 'hx');
assert.equal(labelOf(button).htmlFor, 'hx-switch');
assert.ok(labelOf(dayCard) && button.classes.has('hx-host'));
assert.equal(rideBtn.children.length, 0, 'nothing on the ride screen');
observer(); advance(20);
assert.equal(button.children.length, 1, 'armed once, even after another render');
ok('iPhone: one hidden switch, a label pointing at it on each control (once), none on the ride screen');

assert.equal(fake.made, 0, 'no audio context before a tap or key');
advance(1500); await flush(); await flush();
assert.deepEqual(fetched, ['sounds/tap-navigate.wav', 'sounds/tap-click.wav', 'sounds/tap-back.wav']);
fire('pointerdown'); await flush(); await flush();
assert.equal(fake.made, 1); assert.equal(fake.state, 'running');
ok('files fetched 1.5 s after load; the first tap makes the context and decodes them');

// a tap on a button's label: the label's click stops, the button gets its own click, the switch toggles (by itself)
underTap = [labelOf(button), inner, button];
const tapEvent = { target: labelOf(button) };
fire('click', tapEvent);
assert.equal(tapEvent.stopped, true); assert.equal(tapEvent.prevented, undefined, 'haptics on: the switch toggles');
assert.equal(inner.clicks, 1, 'what the finger is on gets the tap (the text inside the button), not the label');
underTap = [];
fire('click', { target: labelOf(button) });
assert.equal(button.clicks, 1, 'nothing found under the finger: the control itself');
advance(60);
// the button's click bubbles to the document: its sound
fire('click', { target: button });
assert.deepEqual(fake.starts.at(-1), { buf: 'sounds/tap-click.wav', detune: 0 });
advance(60);
fire('click', { target: el(['button', '#tabs button']) });
assert.equal(fake.starts.at(-1).buf, 'sounds/tap-navigate.wav');
assert.ok(Math.abs(fake.starts.at(-1).detune) <= 15);
fire('click', { target: button });
assert.equal(fake.starts.length, 2, 'a second sound within 50 ms: dropped');
advance(60);
fire('click', { target: el(['#scrim']) });
assert.equal(fake.starts.at(-1).buf, 'sounds/tap-back.wav');
assert.deepEqual(s.soundLog().played, ['click', 'navigate', 'back']);
ok('a tap: the switch ticks, the control gets one click, and its sound plays (click, navigate, back); one per 50 ms');

advance(10000);
assert.equal(fake.suspends, 1, 'idle 10 s: the context sleeps');
advance(60);
fire('click', { target: button });
assert.equal(fake.state, 'running'); assert.equal(fake.starts.length, 4);
ok('idle for 10 s the context suspends; the next sound wakes it');

app.settings.taps = 'sound';
advance(60);
const quiet = { target: labelOf(button) };
fire('click', quiet);
assert.equal(quiet.prevented, true, 'Sound only: the switch does not toggle (no tick)');
assert.equal(button.clicks, 2, 'the control still gets the tap');
app.settings.taps = 'haptic';
advance(60);
fire('click', { target: button });
assert.equal(fake.starts.length, 4, 'Haptics only: no sound');
app.settings.taps = 'all';
app.screen = 'ride';
advance(60);
const onRide = { target: labelOf(button) };
fire('click', onRide);
fire('click', { target: button });
assert.equal(onRide.prevented, true); assert.equal(fake.starts.length, 4);
app.screen = 'home';
ok('Sound only: no tick; Haptics only: no sound; on the ride screen neither');

assert.equal(s.soundLog().switchToggles, 0, 'the fake switch is only toggled by a real label tap (WebKit), not here');
sw.dataset.n = '0';
console.log(`sound: ${n} checks passed`);
