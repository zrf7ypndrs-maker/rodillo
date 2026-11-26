// Title music (js/music.js): the score, the DSP helpers, the folded loop, and the player against a fake document,
// AudioContext and clock. The loop is rendered once (a few seconds), through the player, and checked there.
// Expectations are written out by hand, not computed with the module's own formulas.
import assert from 'node:assert/strict';

// ---- fake clock and document (before the module loads: it reads them at call time)
const realTimeout = setTimeout;
const clock = { t: 0, timers: [], id: 0 };
globalThis.setTimeout = (f, ms = 0) => { const id = ++clock.id; clock.timers.push({ id, at: clock.t + ms, f }); return id; };
globalThis.clearTimeout = (id) => { clock.timers = clock.timers.filter((x) => x.id !== id); };
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
const flush = () => new Promise((r) => setImmediate(r));
const listeners = {};
globalThis.document = /** @type {any} */ ({ hidden: false, addEventListener: (ev, f) => { (listeners[ev] ||= []).push(f); } });
const fire = (ev) => (listeners[ev] || []).forEach((f) => f());

const m = await import('../js/music.js');
const { BPM, BEAT, BAR, LOOP, SR, CHORDS, rng, energy, midiHz, score, pump, normalize, sinT, blep, panGains, biquad, voices, hall,
  musicWanted, musicLevel, musicChoice, musicNow, syncMusic, initMusic } = m;

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ---- tempo and helpers
assert.equal(BPM, 90);
near(BAR, 8 / 3);
assert.equal(LOOP, 64);
assert.equal(Math.round(LOOP * SR), 3072000);
near(midiHz(69), 440);
near(midiHz(57), 220);
near(midiHz(62), 293.6648, 1e-4);
ok('90 bpm, 24 bars = 64 s, MIDI to Hz');

const a = rng(26), b = rng(26), c = rng(27);
const sa = [a(), a(), a()], sb = [b(), b(), b()];
assert.deepEqual(sa, sb);
assert.notDeepEqual(sa, [c(), c(), c()]);
assert.ok(sa.every((x) => x >= 0 && x < 1));
ok('seeded random: same seed, same numbers, in [0, 1)');

near(energy(0), 0);
near(energy(32), 1);
near(energy(16), 0.5);
near(energy(48), 0.5);
near(energy(64), 0);
near(energy(10), energy(74));
ok('energy: quiet at the loop point, full halfway, periodic');

near(pump(0), 1); // energy 0 at the loop point: no dip
near(pump(32 + 0.012), 1 - 0.32 * Math.exp(-0.012 / 0.22), 1e-9); // a kick at full energy: dips 32 %, recovering
near(pump(32 + 0.006), 1 - 0.32 * Math.exp(-0.006 / 0.22) * 0.5, 1e-9); // the dip comes in over 12 ms (no click)
assert.ok(pump(32 + 1.3) > 0.99); // back up before the next kick (2 beats later)
near(pump(32 + 0.1), pump(32 + 0.1 + LOOP), 1e-9);
ok('pump: a soft dip after each kick, scaled by energy, periodic');

near(sinT(0), 0, 1e-6); near(sinT(0.25), 1, 1e-6); near(sinT(0.5), 0, 1e-6); near(sinT(-0.25), -1, 1e-6); near(sinT(3.125), Math.SQRT1_2, 1e-5);
assert.equal(blep(0.5, 0.01), 0);
near(blep(0, 0.01), -1); // at the jump: half a step either side
near(blep(0.999999, 0.01), 1, 1e-3);
near(panGains(0)[0], Math.SQRT1_2); near(panGains(0)[1], Math.SQRT1_2);
near(panGains(-1)[0], 1); near(panGains(-1)[1], 0, 1e-9); near(panGains(1)[1], 1);
const lp = biquad('lowpass', 1000, 0.7), hp = biquad('highpass', 1000, 0.7), bp = biquad('bandpass', 1000, 1);
near((lp.b0 + lp.b1 + lp.b2) / (1 + lp.a1 + lp.a2), 1); // DC passes a lowpass
near((hp.b0 + hp.b1 + hp.b2) / (1 + hp.a1 + hp.a2), 0); // and is blocked by a highpass
near((bp.b0 + bp.b1 + bp.b2) / (1 + bp.a1 + bp.a2), 0);
ok('table sine, polyBLEP, constant-power pan, biquads (DC gain)');

const loud = normalize([Float32Array.from([0.5, -2, 1]), Float32Array.from([1, 0, 0])], 0.5);
assert.deepEqual([...loud[0]], [0.125, -0.5, 0.25]);
assert.deepEqual([...loud[1]], [0.25, 0, 0]);
assert.deepEqual([...normalize([new Float32Array(2)])[0]], [0, 0]); // silence stays silence
ok('normalize: loudest sample to the peak, silence untouched');

// ---- the score
const ev = score();
const all = [...ev.pad, ...ev.bass, ...ev.arp, ...ev.bell, ...ev.kick, ...ev.hat, ...ev.rim];
assert.ok(all.every((e) => e.t >= 0 && e.t < LOOP), 'every note starts inside the loop (the fold handles the rest)');
assert.equal(ev.pad.length, 12 * 4); // 12 chords of 4 notes
assert.equal(ev.bass.length, 24);    // one per bar
assert.equal(ev.arp.length, 24 * 8); // 8ths
assert.equal(ev.bell.length, 26 + 5); // tune + answer, sparkles
ok('score: every part inside the loop, the expected counts');

const D_MAJOR = new Set([2, 4, 6, 7, 9, 11, 1]);
assert.ok(ev.bell.every((e) => D_MAJOR.has(e.midi % 12)), 'tune in D major');
const chordAt = (t) => CHORDS[Math.floor(t / (2 * BAR) + 1e-9) % 4];
const has = (ch, midi) => ch.tones.includes(midi % 12);
assert.ok(CHORDS.every((ch) => [ch.bass, ...ch.pad, ...ch.arp].every((x) => has(ch, x))), 'bass, pad and arp only use chord tones');
assert.deepEqual(CHORDS.map((ch) => ch.tones.length), [5, 4, 5, 5]);
assert.ok(ev.arp.every((e) => has(chordAt(e.t), e.midi)), 'arp notes land under their own chord');
assert.ok(ev.bass.every((e) => e.midi === chordAt(e.t).bass));
assert.deepEqual(CHORDS.map((ch) => ch.name), ['Gmaj9', 'D/F#', 'Em9', 'Bm11']);
// voice leading: each pad voice moves by 2 semitones at most, also from the last chord back to the first
CHORDS.forEach((ch, i) => {
  const nx = CHORDS[(i + 1) % 4];
  ch.pad.forEach((p, v) => assert.ok(Math.abs(p - nx.pad[v]) <= 2, `${ch.name} -> ${nx.name} voice ${v}`));
});
ok('harmony: tune in key, arp on chord tones, smooth pad voices (loop wrap included)');

assert.equal(ev.kick.filter((k) => k.t < 7).length, 0); // the groove is away around the loop point
near(ev.kick.find((k) => Math.abs(k.t - 32) < 1e-9).vel, 1); // full kick halfway
assert.ok(ev.rim.every((r) => r.t > 14 && r.t < 50));
assert.ok(ev.bell.filter((e) => e.vel > 0.4).every((e) => e.t >= 8 * BAR && e.t < 20 * BAR)); // the tune: bars 9-20
const swung = ev.arp.filter((_, i) => i % 2 === 1).every((e) => (e.t / (BEAT / 2)) % 1 > 0.05);
assert.ok(swung, 'offbeat 8ths sit a little late');
ok('shape: drums and tune in the middle of the loop, calm at the loop point, swing');

const vs = voices(ev);
assert.equal(vs.length, 48 * 3 + 24 + 192 + 31 + ev.kick.length + ev.hat.length + ev.rim.length);
assert.ok(vs.every((v, i) => i === 0 || vs[i - 1].s0 <= v.s0), 'sorted by start');
assert.ok(vs.every((v) => v.stop > v.s0));
ok('voices: three saws per pad note, sorted by start');

// the hall: an impulse comes back as a decaying, stereo tail
const verb = hall(), imp = new Float32Array(48000), right = new Float32Array(48000);
imp[0] = 1;
verb(imp, right, 48000);
const energyOf = (x, s, e) => x.slice(s, e).reduce((acc, v) => acc + v * v, 0);
assert.equal(energyOf(imp, 0, 900), 0); // 20 ms predelay, then the first comb at ~25 ms
assert.ok(energyOf(imp, 2000, 12000) > energyOf(imp, 24000, 34000) * 4, 'decays');
assert.ok(energyOf(imp, 24000, 34000) > 0, 'still ringing at half a second');
assert.ok(energyOf(imp, 6000, 6100) > 0 && imp.slice(6000, 6100).some((x, i) => x !== right[6000 + i]));
ok('hall: predelay, decaying tail, left and right differ');

// ---- when it plays
assert.equal(musicWanted({ choice: 'normal', screen: 'home', riding: false, hidden: false }), 'play');
assert.equal(musicWanted({ choice: undefined, screen: 'ridepage', riding: false, hidden: false }), 'play');
assert.equal(musicWanted({ choice: 'soft', screen: 'ride', riding: true, hidden: false }), 'quiet');
assert.equal(musicWanted({ choice: 'normal', screen: 'home', riding: true, hidden: false }), 'quiet'); // a ride is on
assert.equal(musicWanted({ choice: 'normal', screen: 'home', riding: false, hidden: true }), 'quiet');
assert.equal(musicWanted({ choice: 'off', screen: 'home', riding: false, hidden: false }), 'off');
assert.equal(musicLevel('normal'), 0.32); assert.equal(musicLevel('soft'), 0.16);
assert.equal(musicChoice(undefined), 'normal'); assert.equal(musicChoice('soft'), 'soft'); assert.equal(musicChoice('off'), 'off'); assert.equal(musicChoice('loud'), 'normal');
ok('when: home screens and the ride page; quiet riding or hidden; off / soft / normal');

// ---- the player, on a fake AudioContext
syncMusic(); // before initMusic: nothing to do, no throw
const ramps = [];
const param = (v) => ({
  value: v,
  cancelScheduledValues() {},
  setValueAtTime(x) { this.value = x; },
  linearRampToValueAtTime(x, at) { ramps.push({ to: x, sec: +(at - fake.currentTime).toFixed(3) }); this.value = x; },
});
let resumeWorks = true;
const fake = {
  state: 'suspended', currentTime: 5, destination: {}, made: 0, suspends: 0, starts: [], channels: [],
  resume() { if (resumeWorks) this.state = 'running'; return Promise.resolve(); },
  suspend() { this.state = 'suspended'; this.suspends++; return Promise.resolve(); },
  createGain() { return { gain: param(1), connect() {} }; },
  createBuffer(ch, len, rate) { return { ch, len, rate, copyToChannel: (d, i) => { fake.channels[i] = d; } }; },
  createBufferSource() { return { connect() {}, start: (when, off) => fake.starts.push(off) }; },
};
const app = /** @type {any} */ ({ settings: { titleMusic: 'normal' }, screen: 'home', session: null });
initMusic({ app, makeAudio: () => { fake.made++; return /** @type {any} */ (fake); } });
assert.deepEqual(musicNow(), { state: 'waiting', started: false });
assert.equal(fake.made, 0); // no sound before a tap or key
ok('player: waits for a tap, makes no context before');

// render (2 s after it's wanted, in steps), driving the fake clock until the loop is there
advance(1999);
await flush();
for (let i = 0; i < 100000; i++) {
  advance(1);
  await flush();
  if (clock.timers.length === 0) break;
}
fire('pointerdown');
await flush(); await flush();
assert.equal(fake.made, 1);
assert.equal(fake.state, 'running');
assert.deepEqual(musicNow(), { state: 'playing', started: true });
assert.equal(fake.starts.length, 1);
assert.ok(fake.starts[0] >= 0 && fake.starts[0] < LOOP, 'starts somewhere inside the loop');
assert.deepEqual(ramps.at(-1), { to: 0.32, sec: 3 });
ok('player: the first tap makes the context, starts the loop at a random point, fades in over 3 s');

// the rendered loop (what the buffer got)
const [L, R] = fake.channels;
assert.equal(L.length, 3072000); assert.equal(R.length, 3072000);
let peak = 0, step = 0;
for (let i = 0; i < L.length; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); if (i) step += Math.abs(L[i] - L[i - 1]); }
near(peak, 0.89, 1e-6);
const typical = step / (L.length - 1);
assert.ok(Math.abs(L[0] - L.at(-1)) < 3 * typical && Math.abs(R[0] - R.at(-1)) < 3 * typical, 'no jump at the loop point');
const rms = (x, s, e) => Math.sqrt(energyOf(x, s, e) / (e - s));
// the fold: the first 20 ms carry the last chord's release and the hall (without it they'd be near silent: the pads
// of bar 1 take 1.4 s to come in)
assert.ok(rms(L, 0, 960) > 0.5 * rms(L, L.length - 960, L.length), 'the start is as full as the end');
assert.ok(rms(L, 0, 960) > 0.01);
// quiet at the loop point, fuller halfway
assert.ok(rms(L, 30 * SR, 34 * SR) > 1.6 * rms(L, 0, 4 * SR));
assert.ok(L.some((x, i) => x !== R[i]), 'stereo');
ok('loop: 64 s at 48 kHz, peak 0.89, no seam, the tail folded onto the start, calm ends and a fuller middle');

// ride starts: fades out, then the context sleeps
app.screen = 'ride'; app.session = { finished: false };
syncMusic();
assert.deepEqual(ramps.at(-1), { to: 0, sec: 1.2 });
assert.equal(musicNow().state, 'quiet');
advance(1300);
assert.equal(fake.suspends, 1);
syncMusic(); // still riding: nothing new
assert.equal(ramps.at(-1).to, 0);
ok('player: a ride fades it out in 1.2 s, then suspends the context');

// the ride page: back, same loop (no restart)
app.screen = 'ridepage'; app.session.finished = true;
syncMusic();
await flush(); await flush();
assert.equal(fake.state, 'running');
assert.deepEqual(ramps.at(-1), { to: 0.32, sec: 3 });
assert.equal(fake.starts.length, 1);
assert.equal(musicNow().state, 'playing');
ok('player: after the ride it wakes the context and fades back in, carrying on where it was');

// a fade-out cut short keeps the context awake
app.screen = 'ride';
syncMusic();
app.screen = 'home'; app.session = null;
syncMusic();
advance(2000);
assert.equal(fake.suspends, 1);
assert.equal(musicNow().state, 'playing');
ok('player: back to home mid fade-out: no suspend');

// soft, off, hidden
app.settings.titleMusic = 'soft';
syncMusic();
assert.deepEqual(ramps.at(-1), { to: 0.16, sec: 3 });
app.settings.titleMusic = 'off';
syncMusic();
assert.deepEqual(ramps.at(-1), { to: 0, sec: 1.2 });
assert.deepEqual(musicNow(), { state: 'off', started: true });
advance(1300);
fire('keydown'); // a key with music off: nothing
assert.equal(fake.made, 1); assert.equal(fake.state, 'suspended');
app.settings.titleMusic = 'normal';
syncMusic();
await flush(); await flush();
assert.equal(musicNow().state, 'playing');
document.hidden = true;
fire('visibilitychange');
assert.equal(musicNow().state, 'quiet');
assert.deepEqual(ramps.at(-1), { to: 0, sec: 1.2 });
advance(1300);
ok('player: soft is half the level, off fades out, a hidden tab goes quiet');

// an interrupted context (iOS): resume doesn't take; the next tap tries again
resumeWorks = false;
document.hidden = false;
fire('visibilitychange');
await flush(); await flush();
assert.equal(musicNow().state, 'waiting');
syncMusic(); // a second try while one is pending: no new resume
resumeWorks = true;
fire('touchend');
await flush(); await flush();
assert.equal(fake.state, 'running');
assert.equal(musicNow().state, 'playing');
ok('player: an interrupted context waits for the next tap');

globalThis.setTimeout = realTimeout;
console.log(`music: ${n} checks passed`);
