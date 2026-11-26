// @ts-check
// Interval countdown sounds (Nov 26). In the last 3 s of a timed step, one soft pulse per second, each landing on
// the interval card's beat as the countdown number changes (3, 2, 1). When the next step starts, a sound that lands
// with the card change: rising bells for a work step, a reward chime for a rest step (and when the workout ends).
// On the desktop the change is the Next card sliding onto the interval card (380 ms, slideNextIn in js/ride.js): the
// GO's lead-in plays during the slide and its hit lands with the card. On the phone (no slide) the file starts at the
// hit. The sounds are files in sounds/, rendered by tools/countdown-sounds.py. Settings > Ride > Countdown sounds;
// a mute button on the ride screen (desktop and phone) silences them on this device until it's pressed again.
// Project doc: claude/rodillo-countdown-sound.md.

import { ls } from './store.js';

/** @typedef {import('./types.js').CountdownDeps} CountdownDeps */
/** @typedef {import('./types.js').Segment} Segment */
/** @typedef {import('./types.js').RideSession} RideSession */

export const FLY = 0.38;       // s: the GO files' lead-in, the length of the desktop slide
export const WORK_FROM = 0.76; // fraction of FTP: from here (Z3 and up) a step counts as work
export const MIN_STEP = 5;     // s: shorter steps get the start sound only
export const SOUNDS = ['tick-3', 'tick-2', 'tick-1', 'work', 'rest'];
const AHEAD = 0.6;             // s: ticks are put on the audio clock this far ahead at most (the engine ticks at 4 Hz)

/** The Settings select's value for a stored choice. */
export const countdownChoice = (v) => (v === 'off' || v === 'soft' ? v : 'on');
/** Output level for a choice. */
export const countdownLevel = (c) => (c === 'off' ? 0 : c === 'soft' ? 0.45 : 0.9);
/** The ride screen's mute button: hidden when the setting is Off; otherwise what pressing it does.
 * @param {boolean} muted @param {string} choice countdownChoice()
 * @returns {{ hidden: boolean, muted: boolean, text: string, label: string }} */
export const muteLook = (muted, choice) => ({
  hidden: choice === 'off', muted,
  text: muted ? 'Unmute' : 'Mute',
  label: muted ? 'Countdown sounds muted: turn them back on' : 'Mute countdown sounds',
});

/** Work or rest: what a step asks for. ERG by its higher end, slope by its power aim, or its grade (4% and up).
 * @param {Segment | null | undefined} g @returns {'work' | 'rest'} */
export function stepKind(g) {
  if (!g) return 'rest';
  if (g.kind === 'erg') return Math.max(g.from ?? 0, g.to ?? 0) >= WORK_FROM ? 'work' : 'rest';
  if (g.free) return 'rest';
  if (g.aim) return g.aim.mid >= WORK_FROM ? 'work' : 'rest';
  return (g.grade ?? 0) >= 0.04 ? 'work' : 'rest';
}

// The ride clock (Nov 26, Agustín: "0 should be the start of the next interval"). A step starts on whichever engine
// tick crossed the last one's end, so not on a whole second of elapsed. Elapsed and the countdowns are both shown on
// the current step's own seconds: elapsed steps at its start plus every whole second after, so the countdown reads
// 3, 2, 1 and the next step starts where 0 would be (no 0 on the card), in step with elapsed the whole time.
const EPS = 1e-6;
/** The fraction of a second the current step started at (its segT0). @param {number} [t0] */
export const clockOff = (t0 = 0) => t0 - Math.floor(t0);
/** Whole seconds shown on the elapsed clock. @param {number} e Elapsed s @param {number} [t0] The step's start */
export const shownElapsed = (e, t0 = 0) => Math.max(0, Math.floor(e - clockOff(t0) + EPS));
/** Seconds left as the ride screen shows them (secsLeft in js/ride.js): the end on the elapsed clock minus elapsed
 * shown, so the two step together and a step's last second reads 1. @param {number} e @param {number} sec
 * @param {number} [t0] */
export const shownLeft = (e, sec, t0 = 0) => Math.max(0, Math.round(e + sec - clockOff(t0)) - shownElapsed(e, t0));
/** Where the card's 1 s beat is (0 to 1): 0 when the countdown number changes. @param {number} e Elapsed s
 * @param {number} [t0] */
export const beatPhase = (e, t0 = 0) => { const x = e - clockOff(t0); return Math.max(0, x - Math.floor(x + EPS)); };

/** The next tick, if the coming number change shows 3, 2 or 1 on a timed step: the number and the seconds until it.
 * @param {number} e Elapsed s @param {Segment | null} g The current step @param {{ sec?: number, m?: number } | null} rem
 * @param {number} [t0] The step's start (segT0) @returns {{ n: number, in: number } | null} */
export function nextTick(e, g, rem, t0 = 0) {
  if (!g || !rem || rem.sec === undefined || g.dur < MIN_STEP) return null;
  const n = shownLeft(e, rem.sec, t0) - 1;
  return n >= 1 && n <= 3 ? { n, in: 1 - beatPhase(e, t0) } : null;
}

// ------------------------------------------------------------------ the player

/** @type {CountdownDeps['app']} */
let app;
/** @type {CountdownDeps['makeAudio']} */
let makeAudio;
/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let out = null;
/** @type {Record<string, AudioBuffer>} */
const bufs = {};
/** @type {Promise<void> | null} */
let loading = null;
/** Ticks on the audio clock that haven't played yet. @type {{ src: AudioBufferSourceNode, at: number, key: string }[]} */
let pending = [];
/** Ticks already decided this session ("step:n"). */
const done = new Set();
/** @type {RideSession | null} */
let ses = null;
let muted = false;
/** @type {(() => void)[]} */
const watchers = [];
/** What was decided, newest last (the smoke test reads it): tick n, or the GO kind and whether it had the lead-in. */
export const countdownLog = /** @type {{ cue: string, n?: number, seg: number, in?: number, slide?: boolean }[]} */ ([]);
const log = (x) => { countdownLog.push(x); if (countdownLog.length > 40) countdownLog.shift(); };

const choice = () => countdownChoice(app?.settings.countdownSound);
const wanted = () => !muted && choice() !== 'off';
const level = () => (muted ? 0 : countdownLevel(choice()));

/** Fetches and decodes the five files, once. */
function load() {
  loading ||= Promise.all(SOUNDS.map((name) => fetch(`sounds/countdown-${name}.wav`)
    .then((r) => { if (!r.ok) throw new Error(`${name}: ${r.status}`); return r.arrayBuffer(); })
    .then((b) => ctx.decodeAudioData(b))
    .then((buf) => { bufs[name] = buf; })))
    .then(() => {}, (e) => { loading = null; console.warn('countdown sounds', e); });
  return loading;
}

/** First tap or key: browsers only let sound start from one. Also brings back a context the system interrupted. */
function unlock() {
  if (choice() === 'off') return;
  if (!ctx) {
    ctx = makeAudio();
    out = ctx.createGain();
    out.gain.value = level();
    out.connect(ctx.destination);
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {}); // inside the tap: iOS only resumes from one
  load();
}

/** Plays a sound at `when` on the audio clock, from `offset` s into the file. Null when it can't play (yet).
 * @param {string} name @param {number} when @param {number} [offset] */
function play(name, when, offset = 0) {
  if (!ctx || ctx.state !== 'running' || !bufs[name]) return null;
  const src = ctx.createBufferSource();
  src.buffer = bufs[name];
  src.connect(out);
  src.start(when, offset);
  return src;
}

/** Stops ticks that haven't played yet, so they can be put back on the clock later (after a pause). */
function cancel() {
  const now = ctx ? ctx.currentTime : 0;
  for (const p of pending) {
    if (p.at > now) { try { p.src.stop(); } catch { /* already stopped */ } done.delete(p.key); }
  }
  pending = [];
}

/** Every engine tick (js/app.js beginSession): puts the next tick on the audio clock when it's close. Cheap.
 * @param {RideSession} s */
export function countdownTick(s) {
  if (s !== ses) { cancel(); done.clear(); ses = s; }
  if (!wanted() || !s.started || s.paused || s.finished) { cancel(); return; }
  const t = nextTick(s.elapsed, s.seg, s.segRemaining, s.segT0);
  if (!t || t.in > AHEAD) return;
  const key = `${s.segIndex}:${t.n}`;
  if (done.has(key)) return;
  done.add(key);
  log({ cue: 'tick', n: t.n, seg: s.segIndex, in: Math.round(t.in * 1000) / 1000 });
  const at = ctx ? ctx.currentTime + t.in : 0, src = play(`tick-${t.n}`, at);
  if (src) pending.push({ src, at, key });
}

/** A new step is on the card (js/ride.js): the work or rest sound. `slide`: the desktop slide is starting now, so the
 * lead-in plays first and the hit lands with the card; without it the file starts at the hit.
 * @param {RideSession} s @param {number} i The new step @param {boolean} slide */
export function countdownGo(s, i, slide) {
  if (!wanted()) return;
  cancel(); // a skip: the old step's ticks are moot
  const cue = stepKind(s.segs?.[i]);
  log({ cue, seg: i, slide });
  play(cue, ctx ? ctx.currentTime : 0, slide ? 0 : FLY);
}

/** The workout's last step is done: the rest chime, once. @param {RideSession} s */
export function countdownDone(s) {
  if (!wanted()) return;
  cancel();
  log({ cue: 'rest', seg: s.segs?.length ?? -1, slide: false });
  play('rest', ctx ? ctx.currentTime : 0, FLY);
}

/** The ride is over: nothing more plays. (The silent switch mutes it like every sound: js/sound.js followSilentSwitch.) */
export function countdownStop() {
  cancel();
  done.clear();
  ses = null;
}

/** The setting changed (here or on another device): the new level, the files if it was just turned on, and the mute
 * buttons (hidden when it's Off). */
export function syncCountdown() {
  if (!app) return;
  watchers.forEach((f) => f());
  if (!ctx) return;
  out.gain.setValueAtTime(level(), ctx.currentTime);
  if (choice() !== 'off') load();
}

/** Is the ride screen's mute on (this device)? */
export const countdownMuted = () => muted;
/** What the mute button shows now. */
export const muteNow = () => muteLook(muted, choice());

/** The mute button: silences the countdown at once (a sound playing fades out in ~50 ms, ticks on the clock come off)
 * and remembers it on this device. */
export function toggleRideMute() {
  muted = !muted;
  ls.set('rideMute', muted);
  if (muted) cancel();
  if (ctx) out.gain.setTargetAtTime(level(), ctx.currentTime, 0.015);
  watchers.forEach((f) => f());
}

/** Called after the mute or the setting changes (the ride screens repaint their mute buttons). @param {() => void} f */
export function onCountdownChange(f) { watchers.push(f); }

/** @param {CountdownDeps} deps */
export function initCountdown(deps) {
  ({ app, makeAudio } = deps);
  muted = ls.get('rideMute', false) === true;
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, unlock, { capture: true, passive: true });
  watchers.forEach((f) => f()); // buttons painted before the saved mute was read
}
