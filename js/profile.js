// @ts-check
// Workout profiles and the meta line, shared by the Workouts library (js/library.js), Today and Calendar (js/today.js),
// the builder (js/builder.js), the ride page and, for ramp colors and the road's minimum height, the ride screen
// (js/ride.js). Moved out of js/app.js Nov 20 (code-health plan step 4) with no change in behavior.
// Pure (tested in test/profile.mjs): the charts (`profileSvg`, `trackSvg`), `rampStops`, `previewOf`, `woMeta`,
// `isSim`, `workSummary`, `ascentText` and the readout's parts (`profileHit`, `profileTip`, `profileMid`, `tipLeft`,
// `tipTarget`, `riseHtml`). The charts take a `look` = { ftp, zoneHex, gradeHex }, built at draw time by
// `profileLook()` in app.js (the rider's FTP, the zone colors, the grade colors of the light / dark theme); the
// library and Today views carry it as `v.prof`. `bindProfileHover(box, w, look)` is the DOM part (the readout under
// the pointer or finger), tested against a fake document in test/profile-dom.mjs.
// Never imports app.js. No DOM access at import.
import { flatten, totalDuration, estimateTSS, mainSet, isTrack, track } from './engine/workout.js';
import { ZONES } from './zones.js';
import { fmtTime, fmtDist } from './ridepage.js';
import { esc } from './ui.js';
/** @typedef {import('./types.js').Workout} Workout */
/** @typedef {import('./types.js').Segment} Segment */
/** @typedef {import('./types.js').Track} Track */
/** @typedef {import('./types.js').ProfileLook} ProfileLook */
/** @typedef {import('./types.js').ZoneHex} ZoneHex */

/** A ramp as hard color stops [[t 0..1, hex], ...]: each stretch in the zone its target is in at that moment
 *  (UX roadmap item 7: charts show a ramp's zones along it, the live card and current row its zone right now).
 * @param {number} from
 * @param {number} to
 * @param {ZoneHex} zoneHex
 */
export function rampStops(from, to, zoneHex) {
  const cuts = ZONES.slice(0, 6).map((z) => z.max).filter((b) => (b - from) * (b - to) < 0).map((b) => (b - from) / (to - from)).sort((a, b) => a - b);
  const edges = [0, ...cuts, 1], out = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const c = zoneHex(from + (to - from) * (edges[k] + edges[k + 1]) / 2);
    out.push([edges[k], c], [edges[k + 1], c]);
  }
  return out;
}
let rampN = 0;

/**
 * Profile previews of a real climb leave out its warm-up (lead steps): the chart is the climb (Nov 11, Agustín).
 * @param {Workout | null | undefined} w
 */
export const previewOf = (w) => (w?.profile?.lead?.length ? { ...w, steps: w.steps.slice(w.profile.lead.length) } : w);

// Elevation profiles are at least this tall in metres, so a flat ride looks flat instead of filling the chart.
export const ELEV_MIN = 60;
export const ascentText = (m) => `+${Math.round(m / 5) * 5} m`;

/**
 * Slope-only workouts: elevation over distance, each stretch filled with its grade color, an ink line on top.
 * @param {Segment[]} segs
 * @param {number} width
 * @param {number} height
 * @param {ProfileLook} look
 */
export function trackSvg(segs, width, height, look) {
  const tr = track(segs), rng = Math.max(tr.hi - tr.lo, ELEV_MIN);
  const top = height * 0.06, floor = height * 0.14; // floor: the lowest stretch still shows a band (and stays tappable)
  const X = (d) => +((d / tr.D) * width).toFixed(1);
  const Y = (h) => +(top + (1 - (h - tr.lo) / rng) * (height - top - floor)).toFixed(1);
  let out = '';
  segs.forEach((g, i) => {
    const p = tr.parts[i], x0 = X(p.d0), x1 = X(p.d1) + 0.3; // 0.3: no hairline gaps between stretches
    out += `<polygon data-i="${i}" points="${x0},${height} ${x0},${Y(p.h0)} ${x1},${Y(p.h1)} ${x1},${height}" fill="${look.gradeHex(g.grade)}" opacity=".9"/>`;
  });
  out += `<polyline class="prof-line" points="${tr.parts.map((p) => `${X(p.d0)},${Y(p.h0)}`).join(' ')} ${width},${Y(tr.parts.at(-1).h1)}"/>`;
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${out}</svg>`;
}

/**
 * @param {Workout} w
 * @param {ProfileLook} look
 * @param {number} [width]
 * @param {number} [height]
 */
export function profileSvg(w, look, width = 340, height = 54) {
  w = previewOf(w);
  const segs = flatten(w, look.ftp);
  if (isTrack(segs)) return trackSvg(segs, width, height, look);
  const T = segs.length ? segs[segs.length - 1].end : 1;
  const maxF = 1.5;
  let out = '';
  segs.forEach((s, i) => {
    const x = (s.start / T) * width, wd = Math.max(0.5, (s.dur / T) * width);
    if (s.kind === 'erg') {
      const y0 = height - (Math.min(s.from, maxF) / maxF) * height, y1 = height - (Math.min(s.to, maxF) / maxF) * height;
      let fill = look.zoneHex(s.from);
      if (s.from !== s.to) {
        const id = `rmp${++rampN}`;
        out += `<defs><linearGradient id="${id}">${rampStops(s.from, s.to, look.zoneHex).map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs>`;
        fill = `url(#${id})`;
      }
      out += `<polygon data-i="${i}" points="${x},${height} ${x},${y0} ${x + wd},${y1} ${x + wd},${height}" fill="${fill}" opacity=".9"/>`;
    } else {
      const g = s.grade;
      const h = Math.max(4, ((g + 0.03) / 0.15) * height);
      out += `<rect data-i="${i}" x="${x}" y="${height - h}" width="${wd}" height="${h}" fill="${look.gradeHex(g)}" opacity=".9"/>`;
    }
  });
  return `<svg class="profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${out}</svg>`;
}

/**
 * @param {Workout} w
 */
export const isSim = (w) => flatten(w).some((s) => s.kind === 'sim');
/**
 * @param {Workout} w
 */
export function woMeta(w) {
  const segs = flatten(w);
  const dist = segs.filter((x) => x.dist).reduce((a, x) => a + x.dist, 0);
  const mins = Math.round(totalDuration(w) / 60);
  // numbers wrapped for their own style (premium look: phone Nov 12, desktop Nov 13)
  const n = (x) => `<span class="n">${x}</span>`;
  if (isTrack(segs)) return `${n(`${dist ? '~' : ''}${mins}`)} min &middot; ${ascentText(track(segs).ascent)}`; // short: library meta column
  if (dist) return `${n(`~${mins}`)} min &middot; ${n(+(dist / 1000).toFixed(1))} km`; // short: must fit the library's meta column
  const tss = estimateTSS(w);
  return `${n(mins)} min${isSim(w) ? '' : ` &middot; TSS ${n(`~${tss}`)}`}`;
}

/**
 * The main set in one phrase at the rider's FTP (`mainSet()` in js/engine/workout.js).
 * @param {Workout} w
 * @param {number} ftp
 */
export const workSummary = (w, ftp) => mainSet(w, ftp);

/**
 * What one interval asks for, for the profile readout: "216 W", "120-180 W", "7% grade".
 * @param {Segment} g
 * @param {number} ftp
 */
export function tipTarget(g, ftp) {
  if (g.kind === 'sim') return g.free ? 'Free ride' : `${+(g.grade * 100).toFixed(1)}% grade`;
  const a = Math.round(g.from * ftp), b = Math.round(g.to * ftp);
  return a === b ? `${a} W` : `${a}-${b} W`;
}

/** Height gained or lost over one stretch of an elevation profile: " +90 m" / " -12 m", nothing on the flat. */
export function riseHtml(p) {
  const m = Math.round(p.h1 - p.h0);
  return m ? ` <span>${m > 0 ? '+' : '&minus;'}${Math.abs(m)} m</span>` : '';
}

/**
 * Which stretch a finger at `f` across the chart (0 left, 1 right) is on: anywhere in its column counts, -1 for none.
 * @param {number} f Pointer position across the chart, 0..1.
 * @param {Segment[]} segs
 * @param {Track | null} tr
 */
export function profileHit(f, segs, tr) {
  const T = segs[segs.length - 1].end;
  f = Math.min(Math.max(f, 0), 0.9999);
  return tr ? tr.parts.findIndex((p) => f * tr.D >= p.d0 && f * tr.D < p.d1) : segs.findIndex((g) => f * T >= g.start && f * T < g.end);
}

/**
 * The readout over stretch i: its label and rep, what it asks for (+ % FTP, + height on a road), its length and when.
 * @param {Segment[]} segs
 * @param {number} i
 * @param {number} ftp
 * @param {Track | null} tr
 */
export function profileTip(segs, i, ftp, tr) {
  const g = segs[i];
  const pct = g.kind === 'erg' ? (g.from === g.to ? `${Math.round(g.from * 100)}%` : `${Math.round(g.from * 100)}-${Math.round(g.to * 100)}%`) + ' FTP' : '';
  const rep = g.rep ? ` &middot; ${g.rep.i} of ${g.rep.of}` : '';
  const len = g.dist ? `${fmtDist(g.dist)} (~${fmtTime(g.dur)})` : fmtTime(g.dur);
  const cad = g.cadence !== '' ? ` &middot; ${esc(g.cadence)} rpm` : '';
  return `<div class="pt-lbl">${esc(g.label)}${rep}</div>
        <div class="pt-tgt">${tipTarget(g, ftp)}${pct ? ` <span>${pct}</span>` : ''}${tr ? riseHtml(tr.parts[i]) : ''}</div>
        <div class="pt-time">${len}${cad}<br><span>${fmtTime(g.start)} to ${fmtTime(g.end)}</span></div>`;
}

/**
 * The middle of stretch i across the chart (0 left, 1 right): where the readout centres.
 * @param {Segment[]} segs
 * @param {number} i
 * @param {Track | null} tr
 */
export const profileMid = (segs, i, tr) => (tr ? (tr.parts[i].d0 + tr.parts[i].d1) / 2 / tr.D : (segs[i].start + segs[i].end) / 2 / segs[segs.length - 1].end);
/** The readout's centre (px) over `mid`, kept inside a chart `width` px wide; `half` = half the readout's width. */
export const tipLeft = (mid, half, width) => Math.min(Math.max(mid, half), width - half);

/**
 * Hover (or tap on the phone) on a workout profile (today hero, calendar day, open library row): highlight the interval under the pointer and show its watts and time.
 * @param {HTMLElement} box
 * @param {Workout} w
 * @param {ProfileLook} look
 */
export function bindProfileHover(box, w, look) {
  if (!box) return;
  w = previewOf(w); // same steps as the chart it reads
  const segs = flatten(w, look.ftp);
  if (!segs.length) return;
  const ftp = look.ftp;
  const tr = isTrack(segs) ? track(segs) : null; // elevation profile: the x axis is distance
  const tip = document.createElement('div');
  tip.className = 'prof-tip';
  tip.setAttribute('role', 'status');
  box.append(tip);
  const svg = box.querySelector('.profile');
  let cur = -1;
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    let i;
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
      // A finger is imprecise: anywhere in the interval's column counts.
      i = profileHit((e.clientX - r.left) / r.width, segs, tr);
    } else {
      // Mouse: only inside the filled area under the curve, not the empty space above it.
      const hit = e.target.closest?.('[data-i]');
      i = hit && svg.contains(hit) ? +hit.dataset.i : -1; // library rows carry data-i too
    }
    if (i < 0) return hide();
    if (i !== cur) {
      cur = i;
      /** @type {NodeListOf<SVGElement>} */ (svg.querySelectorAll('[data-i]')).forEach((el) => el.classList.toggle('on', +el.dataset.i === i));
      tip.innerHTML = profileTip(segs, i, ftp, tr);
      box.classList.add('hov');
    }
    // Centered over the interval, kept inside the chart.
    const b = box.getBoundingClientRect();
    const mid = r.left - b.left + profileMid(segs, cur, tr) * r.width;
    tip.style.left = `${tipLeft(mid, tip.offsetWidth / 2, b.width)}px`;
  };
  const hide = () => {
    cur = -1;
    box.classList.remove('hov');
    svg.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
  };
  box.addEventListener('pointermove', show);
  box.addEventListener('pointerdown', show);
  // Fallback for phone browsers that don't send pointer events for a tap on a plain chart (iOS web views): the click does.
  if (matchMedia('(hover: none)').matches) box.addEventListener('click', (e) => show({ clientX: e.clientX, pointerType: 'touch' }));
  // A finger lifts right after the tap, so on touch the readout stays until a tap elsewhere.
  box.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  const outside = (e) => { if (!box.isConnected) return document.removeEventListener('pointerdown', outside); if (!box.contains(e.target)) hide(); };
  document.addEventListener('pointerdown', outside);
}
