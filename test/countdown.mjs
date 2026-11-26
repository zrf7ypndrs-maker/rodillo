// Countdown sounds (js/countdown.js): work vs rest, the countdown's clock, when each tick goes on the audio clock,
// and the player against a fake document, fetch, AudioContext and audio session. Expectations are written out by
// hand, not computed with the module's own formulas.
import assert from 'node:assert/strict';

// ---- fakes (before the module loads)
const listeners = {};
globalThis.document = /** @type {any} */ ({ addEventListener: (ev, f) => { (listeners[ev] ||= []).push(f); } });
const fire = (ev) => (listeners[ev] || []).forEach((f) => f());
const flush = () => new Promise((r) => setImmediate(r));
const session = { type: 'auto' };
Object.defineProperty(globalThis.navigator, 'audioSession', { value: session, configurable: true });
let fetchOk = false;
const fetched = [];
globalThis.fetch = /** @type {any} */ (async (url) => { fetched.push(url); return { ok: fetchOk, status: fetchOk ? 200 : 404, arrayBuffer: async () => ({ url }) }; });
const store = {};
globalThis.localStorage = /** @type {any} */ ({ getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } });
const warn = console.warn;
console.warn = () => {};

const starts = [], stops = [];
class FakeCtx {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.gainNode = null; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createGain() { this.gainNode = { gain: { value: 1, setValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; } }, connect() {} }; return this.gainNode; }
  decodeAudioData(b) { return Promise.resolve({ name: b.url.match(/countdown-(.+)\.wav$/)[1] }); }
  createBufferSource() {
    const src = { buffer: null, connect() {}, start: (when, offset) => starts.push({ name: src.buffer.name, when, offset }), stop: () => stops.push(src.buffer.name) };
    return src;
  }
}
let made = 0;
/** @type {FakeCtx} */
let audio;
const app = { settings: /** @type {Record<string, any>} */ ({}) };

const m = await import('../js/countdown.js');
const { FLY, WORK_FROM, MIN_STEP, SOUNDS, countdownChoice, countdownLevel, muteLook, stepKind, shownLeft, shownElapsed, beatPhase, nextTick,
  countdownLog, countdownTick, countdownGo, countdownDone, countdownStop, syncCountdown, initCountdown,
  countdownMuted, muteNow, toggleRideMute, onCountdownChange } = m;

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ---- constants and the setting
assert.equal(FLY, 0.38);
assert.equal(WORK_FROM, 0.76);
assert.equal(MIN_STEP, 5);
assert.deepEqual(SOUNDS, ['tick-3', 'tick-2', 'tick-1', 'work', 'rest']);
assert.equal(countdownChoice(undefined), 'on');
assert.equal(countdownChoice('soft'), 'soft');
assert.equal(countdownChoice('off'), 'off');
assert.equal(countdownChoice('loud'), 'on');
assert.equal(countdownLevel('on'), 0.9);
assert.equal(countdownLevel('soft'), 0.45);
assert.equal(countdownLevel('off'), 0);
assert.deepEqual(muteLook(false, 'on'), { hidden: false, muted: false, text: 'Mute', label: 'Mute countdown sounds' });
assert.deepEqual(muteLook(true, 'soft'), { hidden: false, muted: true, text: 'Unmute', label: 'Countdown sounds muted: turn them back on' });
assert.equal(muteLook(false, 'off').hidden, true);
ok('lead-in 0.38 s (the desktop slide), work from 76% FTP, steps under 5 s get no ticks; On by default, Soft, Off; the mute button\'s look');

// ---- work or rest
const erg = (from, to = from) => ({ kind: 'erg', from, to });
assert.equal(stepKind(erg(0.9)), 'work');
assert.equal(stepKind(erg(0.76)), 'work');
assert.equal(stepKind(erg(0.75)), 'rest');
assert.equal(stepKind(erg(0.5, 0.75)), 'rest'); // a warm-up ramp
assert.equal(stepKind(erg(0.6, 0.8)), 'work');  // a ramp into work
assert.equal(stepKind(erg(1.2, 0.5)), 'work');
assert.equal(stepKind({ kind: 'sim', grade: 0.06, aim: { lo: 0.55, hi: 0.65, mid: 0.6 } }), 'rest'); // the aim decides
assert.equal(stepKind({ kind: 'sim', grade: 0.02, aim: { lo: 0.95, hi: 1.05, mid: 1 } }), 'work');
assert.equal(stepKind({ kind: 'sim', grade: 0.04 }), 'work');
assert.equal(stepKind({ kind: 'sim', grade: 0.03 }), 'rest');
assert.equal(stepKind({ kind: 'sim', grade: 0.08, free: true }), 'rest');
assert.equal(stepKind(null), 'rest');
ok('work or rest: ERG by the step\'s higher end, slope by its power aim, else by grade (4%+); free and none = rest');

// ---- the countdown's clock (a step that started at elapsed 40 and ends at 100)
assert.equal(shownLeft(97, 3, 40), 3);
assert.equal(shownLeft(97.4, 2.6, 40), 3);
assert.equal(shownLeft(97.6, 2.4, 40), 3);
assert.equal(shownLeft(98, 2, 40), 2); // the number changes on the step's whole seconds
assert.equal(shownLeft(99.75, 0.25, 40), 1); // the last second reads 1, never 0
assert.equal(shownLeft(100.2, 0), 0);
near(beatPhase(97), 0);
near(beatPhase(97.25), 0.25);
near(beatPhase(97.75), 0.75);
// a step that started off the second (the tick that crossed the last end): elapsed and left still step together
for (let e = 60.3; e < 120.3; e += 0.25) {
  assert.equal(shownElapsed(e, 60.3) + shownLeft(e, 120.3 - e, 60.3), 120, `at ${e.toFixed(2)} s`);
  assert.ok(shownLeft(e, 120.3 - e, 60.3) >= 1, `no 0 at ${e.toFixed(2)} s`);
}
assert.deepEqual([shownLeft(60.3, 60, 60.3), shownLeft(119.25, 1.05, 60.3), shownLeft(119.35, 0.95, 60.3)], [60, 2, 1]);
assert.deepEqual([shownElapsed(60.3, 60.3), shownElapsed(61.29, 60.3), shownElapsed(61.3, 60.3)], [60, 60, 61]);
near(beatPhase(61.3, 60.3), 0); near(beatPhase(61.55, 60.3), 0.25);
ok('shown seconds step on the step\'s own seconds, elapsed with them; the last one reads 1; the beat\'s phase is 0 right there');

const g = { kind: 'erg', from: 0.5, to: 0.5, dur: 60 };
const at = (e) => nextTick(e, g, { sec: 100 - e }, 40);
const t3 = at(96.4); assert.equal(t3.n, 3); near(t3.in, 0.6); // shows 4; 3 at 97
const t2 = at(97.1); assert.equal(t2.n, 2); near(t2.in, 0.9);
const t1 = at(98.5); assert.equal(t1.n, 1); near(t1.in, 0.5);
assert.equal(at(95.4), null); // shows 5: 4 is next, no tick
assert.equal(at(99.5), null); // shows 1: the step change plays next, where 0 would be
assert.equal(nextTick(96, { ...g, dur: 4 }, { sec: 4 }), null);
assert.equal(nextTick(96, g, { m: 40 }), null); // distance step
assert.equal(nextTick(96, null, null), null);
ok('next tick: 3, 2, 1 on the number changes of timed steps (none on distance steps or steps under 5 s)');

// ---- the player
initCountdown({ app: /** @type {any} */ (app), makeAudio: () => { made++; audio = new FakeCtx(); return /** @type {any} */ (audio); } });
syncCountdown(); // no context yet: nothing to do
// the step started at 40.5 and ends at 99.5, so its seconds (and the ticks) fall on every x.5
const ses = (e, over = {}) => ({ started: true, paused: false, finished: false, elapsed: e, segT0: 40.5, seg: g, segIndex: 2, segRemaining: { sec: 99.5 - e }, segs: [erg(0.5), erg(0.95), g, erg(0.92)], ...over });
let s = ses(96);
countdownTick(/** @type {any} */ (s));
assert.deepEqual(countdownLog.at(-1), { cue: 'tick', n: 3, seg: 2, in: 0.5 });
assert.equal(made, 0);
ok('before the first tap: ticks are decided (logged) but nothing is made or played');

fire('pointerdown');
await flush(); await flush();
assert.equal(made, 1);
assert.equal(audio.state, 'running');
assert.equal(fetched.length, 5);
assert.equal(audio.gainNode.gain.value, 0.9);
fetchOk = true;
fire('keydown'); // a failed load is tried again on the next tap
await flush(); await flush(); await flush();
assert.equal(made, 1);
assert.deepEqual(fetched.slice(5), ['sounds/countdown-tick-3.wav', 'sounds/countdown-tick-2.wav', 'sounds/countdown-tick-1.wav', 'sounds/countdown-work.wav', 'sounds/countdown-rest.wav']);
fire('touchend'); await flush();
assert.equal(fetched.length, 10); // loaded once
ok('first tap: one AudioContext at 90%, resumed in the tap; the five files fetched, again after a failure, then once');

// a ride: the clock maps elapsed 90 to audio time 0
// one session object, as in the app (a new object is a new ride)
const ride = async (from, to, over = {}) => {
  for (let e = from; e <= to + 1e-9; e += 0.25) { audio.currentTime = e - 90; Object.assign(s, ses(e, over)); countdownTick(/** @type {any} */ (s)); }
};
starts.length = 0;
countdownStop();
await ride(95, 99.75);
assert.deepEqual(starts.map((x) => x.name), ['tick-3', 'tick-2', 'tick-1']);
near(starts[0].when, 6.5); near(starts[1].when, 7.5); near(starts[2].when, 8.5); // elapsed 96.5, 97.5, 98.5
assert.deepEqual(starts.map((x) => x.offset), [0, 0, 0]);
assert.equal(session.type, 'auto', 'the countdown leaves the audio session alone: the silent switch mutes it (js/sound.js)');
ok('a timed step: tick 3, 2, 1 each once, on the audio clock exactly when the number changes; the silent switch still mutes it');

// pause before a tick plays: it's taken off the clock, and put back after the pause
starts.length = 0; stops.length = 0;
countdownStop();
await ride(96, 96.25);
assert.deepEqual(starts.map((x) => x.name), ['tick-3']);
audio.currentTime = 6.3; Object.assign(s, ses(96.3, { paused: true })); countdownTick(/** @type {any} */ (s));
assert.deepEqual(stops, ['tick-3']);
await ride(96.25, 96.25);
assert.deepEqual(starts.map((x) => x.name), ['tick-3', 'tick-3']);
ok('pause: a tick not yet played comes off the clock and goes back on after the pause');

// the step changes: work or rest, with or without the lead-in
starts.length = 0; stops.length = 0;
countdownGo(/** @type {any} */ (s), 3, true);
assert.deepEqual(starts.at(-1), { name: 'work', when: audio.currentTime, offset: 0 });
assert.deepEqual(countdownLog.at(-1), { cue: 'work', seg: 3, slide: true });
countdownGo(/** @type {any} */ (s), 0, false);
assert.deepEqual(starts.at(-1), { name: 'rest', when: audio.currentTime, offset: FLY });
countdownDone(/** @type {any} */ (s));
assert.deepEqual(starts.at(-1), { name: 'rest', when: audio.currentTime, offset: FLY });
assert.deepEqual(countdownLog.at(-1), { cue: 'rest', seg: 4, slide: false });
ok('new step: the work sound for 92% FTP, the rest sound for 50% and at the end; the lead-in only with the slide');

// a skip during the countdown: ticks still to come are dropped
starts.length = 0; stops.length = 0;
countdownStop();
await ride(97.75, 98);
assert.deepEqual(starts.map((x) => x.name), ['tick-1']);
countdownGo(/** @type {any} */ (s), 3, true);
assert.deepEqual(stops, ['tick-1']);
ok('a skip: the old step\'s tick still to come is dropped');

// the ride screen's mute: silent at once, remembered on this device, buttons told
let painted = 0;
onCountdownChange(() => painted++);
starts.length = 0; stops.length = 0;
countdownStop();
await ride(96, 96.25); // tick 3 on the clock
assert.equal(countdownMuted(), false);
toggleRideMute();
assert.equal(countdownMuted(), true);
assert.equal(store['rodillo.rideMute'], 'true');
assert.deepEqual(stops, ['tick-3']);
assert.equal(audio.gainNode.gain.value, 0);
assert.equal(painted, 1);
assert.equal(muteNow().text, 'Unmute');
const before = countdownLog.length;
await ride(96.5, 99.75);
countdownGo(/** @type {any} */ (s), 3, true);
countdownDone(/** @type {any} */ (s));
assert.equal(countdownLog.length, before);
assert.deepEqual(starts.map((x) => x.name), ['tick-3']);
toggleRideMute();
assert.equal(store['rodillo.rideMute'], 'false');
assert.equal(audio.gainNode.gain.value, 0.9);
assert.equal(painted, 2);
store['rodillo.rideMute'] = 'true';
initCountdown({ app: /** @type {any} */ (app), makeAudio: () => /** @type {any} */ (audio) });
assert.equal(countdownMuted(), true); // read back on load
assert.equal(painted, 3);
toggleRideMute();
ok('mute: the tick on the clock comes off, level 0, nothing decided while muted; back to 90%; saved and read back');

// setting: Soft, then Off
app.settings.countdownSound = 'soft';
syncCountdown();
assert.equal(audio.gainNode.gain.value, 0.45);
app.settings.countdownSound = 'off';
syncCountdown();
assert.equal(audio.gainNode.gain.value, 0);
assert.equal(muteNow().hidden, true);
const logged = countdownLog.length;
starts.length = 0;
countdownStop();
await ride(95, 99.75);
countdownGo(/** @type {any} */ (s), 3, true);
countdownDone(/** @type {any} */ (s));
assert.equal(countdownLog.length, logged);
assert.equal(starts.length, 0);
ok('Soft halves the level; Off: nothing decided, nothing played');

countdownStop();
assert.equal(session.type, 'auto');
ok('ride over: the audio session never changed');

console.warn = warn;
console.log(`countdown: ${n} checks passed`);
