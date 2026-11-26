// @ts-check
// Title music (Nov 26): a calm loop for the home screens, made in the browser with Web Audio. No audio file and no
// service: the score below is synthesized once, in plain JS, into a 64 s buffer; the reverb and delay tails that
// run past the end are folded back onto the start, and the buffer loops sample-exact, so there is no seam to
// hear. Playback starts at a random point with a fade-in, so there is no clear beginning either. It goes quiet on
// the ride screen (ride or pause) and when the tab is hidden; Settings > Ride > Title music turns it off or softer.
// Project doc: claude/rodillo-title-music.md.

/** @typedef {import('./types.js').MusicDeps} MusicDeps */
/** @typedef {{ t: number, dur: number, midi: number, vel: number }} Note */
/** @typedef {{ t: number, vel: number }} Hit */
/** @typedef {{ pad: Note[], bass: Note[], arp: Note[], bell: Note[], kick: Hit[], hat: Hit[], rim: Hit[] }} Score */

export const BPM = 90;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const BARS = 24;
export const LOOP = BARS * BAR; // 64 s
export const TAIL = 8;          // rendered past the loop and folded back onto its start
export const SR = 48000;     // most Macs and phones play at 48 kHz

// Four chords, two bars each, in D major without a V-I anywhere: IV, I/3, ii, vi, and back to IV. The progression
// keeps turning instead of landing, which is what lets the loop have no end. Pads voice-lead by a step at most.
// `tones`: the chord's pitch classes (C = 0), what bass, pad and arp may use.
export const CHORDS = [
  { name: 'Gmaj9', tones: [7, 11, 2, 6, 9], bass: 43, pad: [59, 62, 66, 69], arp: [67, 71, 74, 78, 81] },
  { name: 'D/F#', tones: [2, 6, 9, 4], bass: 42, pad: [57, 62, 64, 69], arp: [66, 69, 74, 76, 81] },
  { name: 'Em9', tones: [4, 7, 11, 2, 6], bass: 40, pad: [55, 62, 66, 71], arp: [64, 67, 71, 74, 78] },
  { name: 'Bm11', tones: [11, 2, 6, 9, 4], bass: 35, pad: [57, 62, 66, 71], arp: [66, 69, 71, 74, 76] },
];
// 8th notes over a chord's two bars (indexes into its arp tones)
const ARP = [0, 2, 3, 4, 3, 2, 1, 2, 0, 2, 3, 4, 2, 3, 1, 2];
const SWING = 0.035; // s, offbeat 8ths a touch late
// The tune: [beat from bar 9, midi, beats, velocity]. Bars 9-16 over one pass of the chords, an answer in 17-20.
const MELODY = [
  [0, 71, 1.5, 0.9], [1.5, 74, 0.5, 0.7], [2, 78, 2, 1], [4, 76, 1, 0.8], [5, 74, 1, 0.75], [6, 69, 2, 0.8],
  [8, 76, 1.5, 0.9], [9.5, 78, 0.5, 0.7], [10, 81, 3, 1], [13, 78, 1, 0.8], [14, 76, 2, 0.8],
  [16, 79, 1.5, 0.9], [17.5, 78, 0.5, 0.7], [18, 76, 2, 0.95], [20, 71, 1, 0.75], [21, 74, 1, 0.75], [22, 76, 2, 0.85],
  [24, 78, 3, 1], [27, 76, 1, 0.8], [28, 74, 2, 0.85], [30, 69, 2, 0.75],
  [32, 74, 2, 0.6], [34, 71, 2, 0.55], [36, 69, 3, 0.55], [39, 66, 1, 0.45], [40, 69, 4, 0.45],
];
const MELODY_BAR = 8;
// a few far-off bell notes while the groove is still away (bars 2-6 and 22-23): [bar + beat, midi]
const SPARKLE = [[2.5, 81], [4, 78], [5.5, 83], [21.5, 81], [22.5, 78]];

/** Seeded random (mulberry32): the score and the noise are the same on every render. @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How busy the music is at t (0 to 1): lowest at the loop point, highest halfway, periodic in LOOP. */
export const energy = (t) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / LOOP);
/** @param {number} m MIDI note */
export const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** One pass of the chords: pads, bass and arp. @param {Score} ev @param {number} bar @param {() => number} r */
function chordPart(ev, bar, r) {
  const c = CHORDS[(bar / 2) % CHORDS.length], t0 = bar * BAR;
  for (const m of c.pad) ev.pad.push({ t: t0, dur: 2 * BAR, midi: m, vel: 1 });
  for (let b = 0; b < 2; b++) {
    const t = t0 + b * BAR;
    ev.bass.push({ t, dur: 0.94 * BAR, midi: c.bass, vel: 0.55 + 0.45 * energy(t) });
  }
  ARP.forEach((i, s) => {
    const t = t0 + (s * BEAT) / 2 + (s % 2 ? SWING : 0) + r() * 0.006; // a little late, never early
    const e = energy(t);
    ev.arp.push({ t, dur: BEAT / 2, midi: c.arp[i], vel: (s % 4 === 0 ? 1 : 0.72) * (0.4 + 0.6 * e) * (0.92 + 0.16 * r()) });
  });
}

/** Kick on 1 and 3, a soft rim on 2 and 4 once the groove is in, shaker on the offbeats; all follow energy().
 * @param {Score} ev @param {number} beat @param {() => number} r */
function drumPart(ev, beat, r) {
  const t = beat * BEAT, e = energy(t);
  if (beat % 2 === 0 && e > 0.12) ev.kick.push({ t, vel: e ** 1.2 });
  if (beat % 2 === 1 && e > 0.45) ev.rim.push({ t: t + 0.004, vel: (e - 0.45) / 0.55 });
  const ht = t + BEAT / 2 + SWING;
  if (e > 0.18) ev.hat.push({ t: ht, vel: (0.25 + 0.75 * energy(ht)) * (0.8 + 0.4 * r()) });
  if (e > 0.6) ev.hat.push({ t: t + 0.003, vel: 0.35 * e * (0.8 + 0.4 * r()) });
}

/** Every note of the loop, all starting inside [0, LOOP). @returns {Score} */
export function score() {
  const r = rng(26);
  /** @type {Score} */
  const ev = { pad: [], bass: [], arp: [], bell: [], kick: [], hat: [], rim: [] };
  for (let bar = 0; bar < BARS; bar += 2) chordPart(ev, bar, r);
  for (let beat = 0; beat < BARS * 4; beat++) drumPart(ev, beat, r);
  for (const [b, midi, d, vel] of MELODY) ev.bell.push({ t: (MELODY_BAR * 4 + b) * BEAT, dur: d * BEAT, midi, vel });
  for (const [pos, midi] of SPARKLE) ev.bell.push({ t: pos * BAR, dur: 2 * BEAT, midi, vel: 0.32 });
  return ev;
}

/** Scales every channel so the loudest sample sits at `peak`. @param {Float32Array[]} chans @param {number} [peak] */
export function normalize(chans, peak = 0.89) {
  let max = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i]));
  const k = max ? peak / max : 1;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k;
  return chans;
}

/** Pad and bass dip after each kick, a soft "breathing" sidechain. @param {number} t */
export const pump = (t) => {
  const since = t % (2 * BEAT);
  return 1 - 0.32 * energy(t - since) * Math.exp(-since / 0.22) * Math.min(1, since / 0.012);
};

// ------------------------------------------------------------------ rendering (plain JS, block by block)
// Voices add into per-block bus buffers; each block then goes through the bus filters, the pump, a ping-pong delay
// and a small hall (Freeverb-style), and lands in the loop at (sample % loop length): that is the fold. All of it
// is linear, so the folded loop is exactly what an endless performance would sound like. ~1 s on a laptop.

const BLOCK = 512;
const TAB = 4096;
const SINE = Float32Array.from({ length: TAB + 1 }, (_, i) => Math.sin((2 * Math.PI * i) / TAB));
/** sin(2π·ph) from a table. @param {number} ph Phase in cycles (any value). */
export function sinT(ph) {
  const x = (ph - Math.floor(ph)) * TAB, i = x | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i);
}
/** PolyBLEP correction for a saw at phase t, step dt (removes the aliasing of the jump). */
export function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
/** Constant-power pan, -1 left to 1 right. @returns {[number, number]} */
export const panGains = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];
const at = (sec) => Math.round(sec * SR);
const decayPer = (tau) => Math.exp(-1 / (tau * SR)); // per-sample factor of an exponential with time constant tau

/** RBJ biquad coefficients. @param {'lowpass' | 'highpass' | 'bandpass'} type @param {number} hz @param {number} q */
export function biquad(type, hz, q) {
  const w = (2 * Math.PI * Math.min(hz, SR * 0.45)) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b = type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : type === 'highpass' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [al, 0, -al];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
}
/** A filter's running state (one channel). */
const fstate = () => ({ x1: 0, x2: 0, y1: 0, y2: 0 });
/** Filters `buf` in place over [0, n). @param {ReturnType<typeof biquad>} k @param {ReturnType<typeof fstate>} s */
function runBiquad(k, s, buf, from, n) {
  let { x1, x2, y1, y2 } = s;
  for (let i = from; i < n; i++) {
    const x = buf[i], y = k.b0 * x + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
  Object.assign(s, { x1, x2, y1, y2 });
}

/** @typedef {{ s0: number, stop: number, bus: 'pad' | 'bass' | 'arp' | 'bell' | 'drums', add: (L: Float32Array, R: Float32Array, base: number, from: number, to: number) => void }} Voice */

/** One detuned saw of a pad note: slow attack, held, long release. @param {Note} n @returns {Voice} */
function sawVoice(n, cents, pan, ph0) {
  const s0 = at(n.t), end = at(n.t + n.dur), att = at(1.4), dt = (midiHz(n.midi) * 2 ** (cents / 1200)) / SR;
  const rel = decayPer(0.65), peak = 0.05 * n.vel, [gl, gr] = panGains(pan);
  let ph = ph0, e = 0;
  return { s0, stop: end + at(4.5), bus: 'pad', add(L, R, base, from, to) {
    for (let i = from; i < to; i++) {
      e = i >= end ? e * rel : Math.min(1, (i - s0) / att);
      ph += dt; if (ph >= 1) ph -= 1;
      const v = (2 * ph - 1 - blep(ph, dt)) * e * peak;
      L[i - base] += v * gl; R[i - base] += v * gr;
    }
  } };
}

/** Sine sub plus a quiet triangle an octave up (so laptop speakers hear the line). @param {Note} n @returns {Voice} */
function bassVoice(n) {
  const s0 = at(n.t), end = at(n.t + n.dur), att = at(0.04), hz = midiHz(n.midi) / SR, rel = decayPer(0.12), peak = 0.14 * n.vel;
  let ph = 0, e = 0;
  return { s0, stop: end + at(1), bus: 'bass', add(L, R, base, from, to) {
    for (let i = from; i < to; i++) {
      e = i >= end ? e * rel : Math.min(1, (i - s0) / att);
      ph += hz;
      const tri = 4 * Math.abs(2 * ph - Math.floor(2 * ph) - 0.5) - 1;
      const v = (sinT(ph) + 0.32 * tri) * e * peak;
      L[i - base] += v; R[i - base] += v;
    }
  } };
}

/** A soft pluck: triangle, plus a saw whose one-pole lowpass closes fast (the "pluck"), plus a quiet sine an octave
 * up. @param {Note} n @param {number} pan @returns {Voice} */
function arpVoice(n, pan) {
  const s0 = at(n.t), att = at(0.005), hz = midiHz(n.midi) / SR, dec = decayPer(0.16), peak = 0.3 * n.vel, [gl, gr] = panGains(pan);
  const close = decayPer(0.09), lo = 1 - Math.exp((-2 * Math.PI * 900) / SR);
  let ph = 0, e = 0, lp = 0, k = 1 - Math.exp((-2 * Math.PI * 9000) / SR);
  return { s0, stop: s0 + at(1.3), bus: 'arp', add(L, R, base, from, to) {
    for (let i = from; i < to; i++) {
      e = i - s0 < att ? (i - s0) / att : e * dec;
      ph += hz;
      const f = ph - Math.floor(ph);
      k = lo + (k - lo) * close;
      lp += k * (2 * f - 1 - blep(f, hz) - lp);
      const v = (4 * Math.abs(f - 0.5) - 1 + 0.45 * lp + 0.25 * sinT(2 * ph)) * e * peak;
      L[i - base] += v * gl; R[i - base] += v * gr;
    }
  } };
}

/** A warm FM bell: modulator at 2x, its depth dying away; decays to a soft hold, then releases. @param {Note} n @returns {Voice} */
function bellVoice(n) {
  const s0 = at(n.t), end = at(n.t + n.dur), att = at(0.008), hz = midiHz(n.midi) / SR;
  const toHold = decayPer(0.35), rel = decayPer(0.3), modDec = decayPer(0.25), peak = 0.12 * n.vel;
  let ph = 0, e = 0, ix = 1.3;
  return { s0, stop: end + at(2.4), bus: 'bell', add(L, R, base, from, to) {
    for (let i = from; i < to; i++) {
      const k = i - s0;
      e = k < att ? k / att : i >= end ? e * rel : 0.42 + (e - 0.42) * toHold;
      ix = 0.1 + (ix - 0.1) * modDec;
      ph += hz;
      const v = sinT(ph + (ix / (2 * Math.PI)) * sinT(2 * ph)) * e * peak;
      L[i - base] += v; R[i - base] += v;
    }
  } };
}

/** @param {Hit} h @returns {Voice} */
function kickVoice(h) {
  const s0 = at(h.t), att = at(0.003), dec = decayPer(0.11), drop = decayPer(0.035), peak = 0.38 * h.vel;
  let ph = 0, e = 0, f = 120 - 46;
  return { s0, stop: s0 + at(0.7), bus: 'drums', add(L, R, base, from, to) {
    for (let i = from; i < to; i++) {
      e = i - s0 < att ? (i - s0) / att : e * dec;
      f *= drop;
      ph += (46 + f) / SR;
      const v = sinT(ph) * e * peak;
      L[i - base] += v; R[i - base] += v;
    }
  } };
}

/** Filtered noise: shaker (highpass) or rim (bandpass). @param {Hit} h @param {number} seed @returns {Voice} */
function noiseVoice(h, seed, type, hz, level, tau, pan) {
  const s0 = at(h.t), att = at(0.002), dec = decayPer(tau), r = rng(seed), k = biquad(type, hz, type === 'bandpass' ? 1.4 : 0.7), st = fstate();
  const [gl, gr] = panGains(pan), tmp = new Float32Array(BLOCK), peak = level * h.vel;
  let e = 0;
  return { s0, stop: s0 + at(tau * 9), bus: 'drums', add(L, R, base, from, to) {
    for (let i = from; i < to; i++) { e = i - s0 < att ? (i - s0) / att : e * dec; tmp[i - from] = (r() * 2 - 1) * e * peak; }
    runBiquad(k, st, tmp, 0, to - from);
    for (let i = from; i < to; i++) { L[i - base] += tmp[i - from] * gl; R[i - base] += tmp[i - from] * gr; }
  } };
}

/** Every voice of the score, by start. @param {Score} ev @returns {Voice[]} */
export function voices(ev) {
  const r = rng(3);
  /** @type {Voice[]} */
  const v = [];
  for (const n of ev.pad) for (const [c, p] of [[-9, -0.6], [0, 0], [8, 0.6]]) v.push(sawVoice(n, c, p, r()));
  ev.bass.forEach((n) => v.push(bassVoice(n)));
  ev.arp.forEach((n, i) => v.push(arpVoice(n, i % 2 ? 0.3 : -0.3)));
  ev.bell.forEach((n) => v.push(bellVoice(n)));
  ev.kick.forEach((h) => v.push(kickVoice(h)));
  ev.hat.forEach((h, i) => v.push(noiseVoice(h, 100 + i, 'highpass', 7000, 0.22, 0.025, 0.25)));
  ev.rim.forEach((h, i) => v.push(noiseVoice(h, 900 + i, 'bandpass', 2300, 0.14, 0.035, -0.15)));
  return v.sort((a, b) => a.s0 - b.s0);
}

/** A small hall after Freeverb (8 damped combs and 4 allpasses per side), with a short predelay. */
export function hall({ feedback = 0.9, damp = 0.35, gain = 0.03 } = {}) {
  const sc = SR / 44100, mk = (len) => ({ b: new Float32Array(Math.round(len * sc)), i: 0, f: 0 });
  const side = (spread) => ({
    combs: [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((l) => mk(l + spread)),
    aps: [556, 441, 341, 225].map((l) => mk(l + spread)),
  });
  const L = side(0), R = side(23), pre = new Float32Array(at(0.02));
  let pi = 0;
  const run = (s, x) => {
    let y = 0;
    for (const c of s.combs) {
      const o = c.b[c.i];
      c.f = o * (1 - damp) + c.f * damp;
      c.b[c.i] = x + c.f * feedback;
      if (++c.i >= c.b.length) c.i = 0;
      y += o;
    }
    for (const a of s.aps) {
      const o = a.b[a.i];
      a.b[a.i] = y + o * 0.5;
      if (++a.i >= a.b.length) a.i = 0;
      y = o - y;
    }
    return y;
  };
  /** @param {Float32Array} inp Mono send, replaced by the left output @param {Float32Array} outR @param {number} n */
  return (inp, outR, n) => {
    for (let i = 0; i < n; i++) {
      const x = pre[pi] * gain;
      pre[pi] = inp[i];
      if (++pi >= pre.length) pi = 0;
      inp[i] = run(L, x); outR[i] = run(R, x);
    }
  };
}

/** Ping-pong delay at a dotted 8th, darker each repeat. */
function pingPong(fb = 0.38) {
  const d = at(0.75 * BEAT), l = new Float32Array(d), r = new Float32Array(d), tone = biquad('lowpass', 3200, 0.6), st = fstate();
  let i = 0;
  /** @param {Float32Array} inp Mono send @param {Float32Array} oL @param {Float32Array} oR @param {number} n */
  return (inp, oL, oR, n) => {
    runBiquad(tone, st, inp, 0, n);
    for (let j = 0; j < n; j++) {
      const lo = l[i], ro = r[i];
      l[i] = inp[j] + fb * ro; r[i] = lo;
      if (++i >= d) i = 0;
      oL[j] = lo * 0.97 + ro * 0.23; oR[j] = lo * 0.23 + ro * 0.97;
    }
  };
}

/** A lowpass whose cutoff follows fn(t), on a stereo bus. @param {(t: number) => number} fn */
function sweep(fn, q) {
  const sl = fstate(), sr = fstate();
  /** @param {Float32Array} L @param {Float32Array} R @param {number} base @param {number} n */
  return (L, R, base, n) => {
    for (let j = 0; j < n; j += 64) {
      const k = biquad('lowpass', fn((base + j) / SR), q), m = Math.min(n, j + 64);
      runBiquad(k, sl, L, j, m); runBiquad(k, sr, R, j, m);
    }
  };
}

/** Builds the bus processing. Mix levels: dry buses, then the sends. */
function mixer() {
  const B = () => [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const bus = { pad: B(), bass: B(), arp: B(), bell: B(), drums: B() };
  const padF = sweep((t) => 900 + 2400 * energy(t) + 300 * Math.sin((6 * Math.PI * t) / LOOP), 0.5);
  const arpF = sweep((t) => 2200 + 6000 * energy(t) ** 1.2, 0.8);
  const verb = hall(), delay = pingPong();
  const list = Object.values(bus);
  const dSend = new Float32Array(BLOCK), hL = new Float32Array(BLOCK), hR = new Float32Array(BLOCK), dL = new Float32Array(BLOCK), dR = new Float32Array(BLOCK);
  /** Mixes one block into (outL, outR) starting at base. @param {number} base @param {number} n
   * @param {(i: number, l: number, r: number) => void} put */
  const mix = (base, n, put) => {
    padF(bus.pad[0], bus.pad[1], base, n);
    arpF(bus.arp[0], bus.arp[1], base, n);
    for (let j = 0; j < n; j++) {
      const g = pump((base + j) / SR);
      bus.pad[0][j] *= g; bus.pad[1][j] *= g; bus.bass[0][j] *= g; bus.bass[1][j] *= g;
      const pad = bus.pad[0][j] + bus.pad[1][j], arp = bus.arp[0][j] + bus.arp[1][j], bell = bus.bell[0][j] + bus.bell[1][j];
      dSend[j] = arp * 0.22 + bell * 0.15;
      hL[j] = pad * 0.28 + arp * 0.17 + bell * 0.35 + (bus.drums[0][j] + bus.drums[1][j]) * 0.04;
    }
    delay(dSend, dL, dR, n);
    for (let j = 0; j < n; j++) hL[j] += (dL[j] + dR[j]) * 0.25;
    verb(hL, hR, n);
    for (let j = 0; j < n; j++) {
      let l = dL[j] * 0.5 + hL[j] * 0.42, r = dR[j] * 0.5 + hR[j] * 0.42;
      for (const b of list) { l += b[0][j]; r += b[1][j]; b[0][j] = 0; b[1][j] = 0; }
      put(base + j, l, r);
    }
  };
  return { bus, mix };
}

/** Renders the loop: 2 channels of LOOP * SR samples, folded and normalized.
 * @param {(() => Promise<void>) | null} [pause] Awaited every few blocks so the page stays responsive. */
export async function renderLoop(pause = null) {
  const n = at(LOOP), total = at(LOOP + TAIL), outL = new Float32Array(n), outR = new Float32Array(n);
  const all = voices(score()), { bus, mix } = mixer();
  /** @type {Voice[]} */
  let live = [];
  let next = 0;
  for (let base = 0, k = 0; base < total; base += BLOCK, k++) {
    const end = Math.min(total, base + BLOCK);
    while (next < all.length && all[next].s0 < end) live.push(all[next++]);
    for (const v of live) { const b = bus[v.bus]; v.add(b[0], b[1], base, Math.max(base, v.s0), Math.min(end, v.stop)); }
    live = live.filter((v) => v.stop > end);
    mix(base, end - base, (i, l, r) => { const w = i % n; outL[w] += l; outR[w] += r; });
    if (pause && k % 32 === 31) await pause();
  }
  return normalize([outL, outR]);
}

// ------------------------------------------------------------------ the player

/** What the title music should do. @param {{ choice?: string, screen: string, riding: boolean, hidden: boolean }} s
 * @returns {'off' | 'quiet' | 'play'} */
export function musicWanted({ choice, screen, riding, hidden }) {
  if (choice === 'off') return 'off';
  return screen === 'ride' || riding || hidden ? 'quiet' : 'play';
}
/** Output level for the setting ('normal' | 'soft'). */
export const musicLevel = (choice) => (choice === 'soft' ? 0.16 : 0.32);
/** The Settings select's value for a stored choice. */
export const musicChoice = (v) => (v === 'off' || v === 'soft' ? v : 'normal');

const FADE_IN = 3, FADE_OUT = 1.2;
/** @type {MusicDeps['app']} */
let app;
/** @type {MusicDeps['makeAudio']} */
let makeAudio;
/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let out = null;
/** @type {Float32Array[] | null} */
let loop = null;
/** @type {Promise<void> | null} */
let rendering = null;
let started = false, playing = false, waking = false, offTimer = 0;

/** For the smoke test: where the music is. 'waiting' = wanted but not audible yet (no tap / key yet, or rendering). */
export function musicNow() {
  const w = want();
  if (w !== 'play') return { state: w, started };
  return { state: playing && ctx?.state === 'running' ? 'playing' : 'waiting', started };
}

const want = () => musicWanted({ choice: musicChoice(app.settings.titleMusic), screen: app.screen, riding: !!(app.session && !app.session.finished), hidden: document.hidden });

const RENDER_AFTER = 2000; // ms: let the app finish loading first
/** Renders the loop once, when it's first wanted, in small steps so the page stays responsive. */
function prepare() {
  const pause = () => new Promise((r) => setTimeout(r, 0));
  rendering ||= new Promise((r) => setTimeout(r, RENDER_AFTER)).then(() => renderLoop(pause))
    .then((l) => { loop = l; syncMusic(); }).catch((e) => console.warn('title music', e));
}

/** First tap or key: browsers only let sound start from one. Also brings back a context the system interrupted. */
function unlock() {
  if (want() !== 'play') return;
  if (!ctx) {
    ctx = makeAudio();
    out = ctx.createGain();
    out.gain.value = 0;
    out.connect(ctx.destination);
  }
  waking = false;
  if (ctx.state !== 'running') wake(); // inside the tap: iOS only resumes from one
  else syncMusic();
}

/** Resumes a context this player suspended (once per try: an interrupted one waits for the next tap). */
function wake() {
  if (waking) return;
  waking = true;
  ctx.resume().then(() => { if (ctx.state === 'running') { waking = false; syncMusic(); } }, () => {});
}

/** Starts the loop at a random point (once), then fades to the wanted level. */
function fadeIn() {
  if (!started) {
    const buf = ctx.createBuffer(2, loop[0].length, SR);
    loop.forEach((ch, i) => buf.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (ch), i));
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(out);
    src.start(0, Math.random() * LOOP);
    started = true;
  }
  ramp(musicLevel(musicChoice(app.settings.titleMusic)), FADE_IN);
  playing = true;
}

/** @param {number} to @param {number} sec */
function ramp(to, sec) {
  clearTimeout(offTimer);
  const now = ctx.currentTime, g = out.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(to, now + sec);
}

/** Matches the music to the screen and the setting. Cheap: called on screen changes, settings and visibility. */
export function syncMusic() {
  if (!app) return;
  const w = want();
  if (w === 'play' && !loop) prepare();
  if (!ctx || !loop) return;
  if (w === 'play') { if (ctx.state === 'running') fadeIn(); else wake(); return; }
  if (!playing) return;
  playing = false;
  ramp(0, FADE_OUT);
  offTimer = setTimeout(() => { if (!playing) ctx.suspend().catch(() => {}); }, FADE_OUT * 1000 + 100);
}

/** @param {MusicDeps} deps */
export function initMusic(deps) {
  ({ app, makeAudio } = deps);
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', syncMusic);
  syncMusic();
}
