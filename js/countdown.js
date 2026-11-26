// @ts-check
// Interval countdown sounds (Nov 26). In the last 3 s of a timed step, one soft pulse per second, each landing on
// the interval card's beat as the countdown number changes (3, 2, 1). When the next step starts, a sound that lands
// with the card change: rising bells for a work step, a reward chime for a rest step (and when the workout ends).
// On the desktop the change is the Next card sliding onto the interval card (380 ms, slideNextIn in js/ride.js): the
// GO's lead-in plays during the slide and its hit lands with the card. On the phone (no slide) the file starts at the
// hit. The sounds are files in sounds/, rendered by tools/countdown-sounds.py. Settings > Ride > Countdown sounds.
// Project doc: claude/rodillo-countdown-sound.md.

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

/** Work or rest: what a step asks for. ERG by its higher end, slope by its power aim, or its grade (4% and up).
 * @param {Segment | null | undefined} g @returns {'work' | 'rest'} */
export function stepKind(g) {
  if (!g) return 'rest';
  if (g.kind === 'erg') return Math.max(g.from ?? 0, g.to ?? 0) >= WORK_FROM ? 'work' : 'rest';
  if (g.free) return 'rest';
  if (g.aim) return g.aim.mid >= WORK_FROM ? 'work' : 'rest';
  return (g.grade ?? 0) >= 0.04 ? 'work' : 'rest';
}

/** Seconds left as the ride screen shows them (secsLeft in js/ride.js): on the elapsed clock, so the countdown steps
 * when Math.round(elapsed) does, at every x.5. @param {number} e @param {number} sec */
export const shownLeft = (e, sec) => Math.max(0, Math.round(e + sec) - Math.round(e));
/** Where the card's 1 s beat is (0 to 1): 0 when the countdown number changes. @param {number} e Elapsed s */
export const beatPhase = (e) => e + 0.5 - Math.floor(e + 0.5);

/** The next tick, if the coming number change shows 3, 2 or 1 on a timed step: the number and the seconds until it.
 * @param {number} e Elapsed s @param {Segment | null} g The current step @param {{ sec?: number, m?: number } | null} rem
 * @returns {{ n: number, in: number } | null} */
export function nextTick(e, g, rem) {
  if (!g || !rem || rem.sec === undefined || g.dur < MIN_STEP) return null;
  const n = shownLeft(e, rem.sec) - 1;
  return n >= 1 && n <= 3 ? { n, in: 1 - beatPhase(e) } : null;
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
let sessionType = '';
/** What was decided, newest last (the smoke test reads it): tick n, or the GO kind and whether it had the lead-in. */
export const countdownLog = /** @type {{ cue: string, n?: number, seg: number, in?: number, slide?: boolean }[]} */ ([]);
const log = (x) => { countdownLog.push(x); if (countdownLog.length > 40) countdownLog.shift(); };

const choice = () => countdownChoice(app?.settings.countdownSound);

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
    out.gain.value = countdownLevel(choice());
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

/** iPhone: let the ride's sounds play with the silent switch on (Safari's audio session); put it back after. */
function rideAudio(on) {
  const as = /** @type {{ audioSession?: { type: string } }} */ (/** @type {unknown} */ (navigator)).audioSession;
  if (!as) return;
  if (on && !sessionType) { sessionType = as.type || 'auto'; as.type = 'playback'; }
  else if (!on && sessionType) { as.type = sessionType; sessionType = ''; }
}

/** Every engine tick (js/app.js beginSession): puts the next tick on the audio clock when it's close. Cheap.
 * @param {RideSession} s */
export function countdownTick(s) {
  if (s !== ses) { cancel(); done.clear(); ses = s; }
  if (choice() === 'off' || !s.started || s.paused || s.finished) { cancel(); return; }
  rideAudio(true);
  const t = nextTick(s.elapsed, s.seg, s.segRemaining);
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
  if (choice() === 'off') return;
  cancel(); // a skip: the old step's ticks are moot
  const cue = stepKind(s.segs?.[i]);
  log({ cue, seg: i, slide });
  play(cue, ctx ? ctx.currentTime : 0, slide ? 0 : FLY);
}

/** The workout's last step is done: the rest chime, once. @param {RideSession} s */
export function countdownDone(s) {
  if (choice() === 'off') return;
  cancel();
  log({ cue: 'rest', seg: s.segs?.length ?? -1, slide: false });
  play('rest', ctx ? ctx.currentTime : 0, FLY);
}

/** The ride is over: nothing more plays, and the audio session goes back to how it was. */
export function countdownStop() {
  cancel();
  done.clear();
  ses = null;
  rideAudio(false);
}

/** The setting changed (here or on another device): the new level, and the files if it was just turned on. */
export function syncCountdown() {
  if (!app || !ctx) return;
  out.gain.setValueAtTime(countdownLevel(choice()), ctx.currentTime);
  if (choice() !== 'off') load();
}

/** @param {CountdownDeps} deps */
export function initCountdown(deps) {
  ({ app, makeAudio } = deps);
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, unlock, { capture: true, passive: true });
}
