// @ts-check
// Pain vision (Nov 25, Agustín: "Zwift has a special animation where things get blurry at the end of a hard
// interval"). Near the end of a hard interval, or when W' runs low, the ride screen's edges blur, lose colour and
// darken, throbbing with the rider's heart rate; a quick clear flash when a hard rep ends. The interval card, tiles,
// Elapsed and Next (desktop) and the top, hero, power, metrics and buttons (phone) sit above it and stay sharp.
// strain 0..1 = the larger of an interval part and a W' part, times the setting (Settings > Ride > Pain vision).
// paintPain() only sets --pain / --beat and two classes on #ride; CSS (end of css/app.css) draws it and its
// registered --pain transition smooths the 4 Hz steps, so no per-tick drawing work.

import { segTarget } from './engine/workout.js';

export const W_PRIME = 18000; // J; a typical W', not measured for him
const LEVELS = { off: 0, subtle: 0.55, full: 1 };

const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => Math.max(a, Math.min(b, v));

/** The setting as one of 'off' | 'subtle' | 'full' (anything unknown is the default, full). @param {unknown} v */
export const painChoice = (v) => (typeof v === 'string' && v in LEVELS ? v : 'full');
/** How strong the effect can get, 0..1. @param {unknown} v */
export const painLevel = (v) => LEVELS[painChoice(v)];

/**
 * Interval part: the last third of a step at 105%+ FTP, eased in, full at 110%+ (105% gets two thirds).
 * @param {number|null} frac target as a fraction of FTP @param {number} p progress through the step, 0..1
 */
export function intervalStrain(frac, p) {
  if (frac == null || frac < 1.05) return 0;
  const tail = clamp((p - 2 / 3) * 3, 0, 1);
  return tail ** 1.6 * clamp((frac - 0.95) / 0.15, 0.3, 1);
}

/**
 * W' part: starts once half of W' is spent, full at 95% spent; only while near or above CP, so a recovery always
 * clears the screen. @param {number} wbal J left @param {number} power W @param {number} cp W
 */
export function wprimeStrain(wbal, power, cp) {
  if (!(cp > 0) || power < cp * 0.9) return 0;
  return clamp((1 - wbal / W_PRIME - 0.5) / 0.45, 0, 1);
}

/** One step of Skiba's W' balance (differential form). @param {number} wbal @param {number} power @param {number} cp @param {number} dt s */
export function wbalStep(wbal, power, cp, dt) {
  if (power > cp) return Math.max(0, wbal - (power - cp) * dt);
  const tau = 546 * Math.exp(-0.01 * (cp - power)) + 316;
  return Math.min(W_PRIME, wbal + (W_PRIME - wbal) * (1 - Math.exp(-dt / tau)));
}

/** @type {WeakMap<object, {t: number, wbal: number, last: number, seg: number, flash: number}>} */
const state = new WeakMap();

/**
 * Called from renderRide() on every tick (phone and desktop). Returns what it set, for tests.
 * @param {import('./engine/session.js').Session} s @param {HTMLElement} root #ride @param {number} level painLevel()
 */
export function paintPain(s, root, level) {
  let st = state.get(s);
  if (!st) { st = { t: s.elapsed, wbal: W_PRIME, last: 0, seg: s.segIndex, flash: -1 }; state.set(s, st); }
  const dt = Math.max(0, s.elapsed - st.t);
  st.t = s.elapsed;
  const buf = s.powerBuf || [], n = Math.min(buf.length, Math.max(1, Math.round(3 / (s._dt || 0.25))));
  const power = n ? buf.slice(-n).reduce((a, b) => a + b, 0) / n : 0; // 3 s average
  const cp = s.s.ftp;
  if (dt > 0) st.wbal = wbalStep(st.wbal, power, cp, dt); // W' is tracked even when the effect is off
  const g = s.seg, live = s.started && !s.paused && !s.finished; // free ride: only the W' part
  const frac = !live || !g ? null : g.kind === 'erg' ? segTarget(g, s.segProgress) * (s.intensity || 1) : g.aim ? g.aim.mid : null;
  const strain = live ? Math.max(intervalStrain(frac, s.segProgress), wprimeStrain(st.wbal, power, cp)) * level : 0;
  if (s.segIndex !== st.seg) { // a hard rep just ended: clear flash
    if (st.last > 0.3) { root.classList.remove('pain-release'); void root.offsetWidth; root.classList.add('pain-release'); st.flash = s.elapsed; }
    st.seg = s.segIndex;
  }
  if (st.flash >= 0 && s.elapsed - st.flash > 1) { root.classList.remove('pain-release'); st.flash = -1; }
  st.last = strain;
  root.style.setProperty('--pain', strain.toFixed(3));
  const hr = s.hr?.bpm || 0;
  if (hr > 40) root.style.setProperty('--beat', `${(60 / hr).toFixed(2)}s`); // throb at his heart rate
  root.classList.toggle('pain-nohr', !(hr > 40)); // no strap: no throb
  root.classList.toggle('pain-on', strain > 0.01);
  return { strain, wbal: st.wbal };
}
