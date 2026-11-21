// @ts-check
// Workouts library (#tab-workouts): the ERG / Slope / Mine switch, rows grouped by purpose, the open row (facts,
// big chart, Start / Edit), and a real climb's detail slider and grade range. Moved out of js/app.js Nov 18
// (code-health plan step 4) with no change in behavior.
// The row builders are pure (data and a view `v` in, markup out; tested in test/library.mjs):
// `v` = { settings, plan, today, signedIn, GRADE, ZC, prof }, which app.js builds at draw time (libView()): settings and
// the plan change, the colors follow the light / dark theme. The profile charts, meta line, main set phrase and the
// readout come from js/profile.js, drawn with `v.prof` (their look).
// The DOM part (renderLibrary, setWoKind, the detail slider) gets app.js state and hooks through initLibrary().
// Never import app.js from here.
import { DEFAULT_SETTINGS } from './engine/session.js?v=202611102147';
import { gearList, resolveDrivetrain } from './engine/drivetrain.js?v=202611102147';
import { TRAINERS, steepestGrade } from './engine/trainers.js?v=202611102147';
import { flatten, totalDuration, estimateTSS, isTrack } from './engine/workout.js?v=202611102147';
import { withDetail, defaultDetail, detailLabel, clampDetail, DETAIL_MIN, DETAIL_MAX } from './engine/climb.js?v=202611102147';
import { ZONES, zoneOf } from './zones.js?v=202611102147';
import { ls } from './store.js?v=202611102147';
import { dayDate } from './dates.js?v=202611102147';
import { openBuilder } from './builder.js?v=202611102147';
import { previewOf, profileSvg, woMeta, workSummary, bindProfileHover } from './profile.js?v=202611102147';
import { $, $$, esc, placeInk, slideIn } from './ui.js?v=202611102147';
/** @typedef {import('./types.js').ElementEvent} ElementEvent */

// from app.js, set by initLibrary()
/** @typedef {import('./types.js').LibraryDeps} Deps */
/** @typedef {import('./types.js').LibView} LibView */
/** @typedef {import('./types.js').Workout} Workout */
/** @typedef {import('./types.js').Settings} Settings */
/** @type {Deps['app']} */ let app;
/** @type {Deps['view']} */ let view;
/** @type {Deps['saveSettings']} */ let saveSettings;
/** @type {Deps['refreshPlanViews']} */ let refreshPlanViews;
/** @type {Deps['startWorkout']} */ let startWorkout;
/** @type {Deps['focusables']} */ let focusables;
/** @type {Deps['applyFocus']} */ let applyFocus;
/** @type {Deps['signedIn']} */ let signedIn;

/** Wires the ERG / Slope / Mine switch. Called once from app.js, before the library first loads. */
/** @param {import('./types.js').LibraryDeps} deps */
export function initLibrary(deps) {
  ({ app, view, saveSettings, refreshPlanViews, startWorkout, focusables, applyFocus, signedIn } = deps);
  setWoKind(app.woKind);
  $$('#wo-kind button').forEach((b) => (b.onclick = () => { setWoKind(b.dataset.kind, true); app.focus = Math.max(0, focusables().indexOf(b)); applyFocus(); }));
}

/** Grade band of a stretch: the slope colors (GRADE in app.js) and the open row's Time by grade. */
/** @param {number} g Grade, fraction. */
export const gradeBand = (g) => (g < 0 ? 0 : g < 0.03 ? 1 : g < 0.06 ? 2 : g < 0.09 ? 3 : g < 0.12 ? 4 : 5); // index into GRADE: down, 0-3, 3-6, 6-9, 9-12, 12%+

// ------------------------------------------------------------------ real climbs: detail slider
// A climb workout carries its full elevation profile (js/engine/climb.js); the open row in the Slope list has a
// Detail slider (right = finer stretches) and a Default button. The choice is saved per climb in
// settings.climbDetail and syncs like every other setting (Nov 11, asked for by Agustín).
/** @param {Workout} w @param {Settings} settings */
export const climbLevel = (w, settings) => clampDetail(settings.climbDetail?.[w.id] ?? defaultDetail(w));
/** @param {Workout} w @param {Settings} settings */
export const cutClimb = (w, settings) => (w.profile ? withDetail(w, climbLevel(w, settings)) : w);
/** @param {number} lv */
export const sliderOf = (lv) => DETAIL_MAX + DETAIL_MIN - lv; // slider value grows with detail, levels grow with stretch length
const climbSteps = (w) => w.steps.length - (w.profile?.lead?.length || 0);
/** @param {Workout} w */
export const detailText = (w) => `${detailLabel(w.profile, w.detail)} &middot; ${climbSteps(w)} steps`;


const WARN_ICO = '<svg class="ico-warn" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'; // Lucide triangle-alert (ISC)
const pct1 = (f) => `${+(f * 100).toFixed(1)}%`;

/**
 * Open row of a slope workout: steepest and lowest grade, and whether your gears can ride the steepest stretch
 * inside the trainer's range (Settings > Trainer). Shifting is virtual, so the trainer only feels the road force
 * scaled by gear (`steepestGrade()`): an easy gear rides far steeper than the trainer's own max (Nov 11, Agustín).
 * Uphill is taken after grade realism, like the session sends it. Updates with the detail slider and settings.
 */
/** @param {Workout} w @param {number} i Index in app.library. @param {Settings} settings */
export function gradeRangeHtml(w, i, settings) {
  const segs = flatten(previewOf(w));
  if (!isTrack(segs)) return '';
  const st = { ...DEFAULT_SETTINGS, ...settings }, gs = st.gradeScale ?? 1;
  const hi = Math.max(...segs.map((g) => g.grade)), lo = Math.min(...segs.map((g) => g.grade));
  const need = hi > 0 ? hi * gs : 0;
  const who = TRAINERS[st.trainerModel]?.name || 'your trainer';
  const gears = gearList(resolveDrivetrain(st), st.wheelCirc).map((g) => ({ ...g, max: steepestGrade(g.dev, st) }));
  const fits = gears.filter((g) => g.max >= need - 1e-9);
  let note = '', over = false;
  if (need > 0 && !fits.length) {
    over = true;
    note = `<span class="wo-gnote warn">${WARN_ICO}Too steep for ${who} even in ${gears[0].label}: it tops out at ${pct1(gears[0].max)} there, so the steepest stretches will feel easier than the road</span>`;
  } else if (need > 0 && fits.length < gears.length) {
    note = `<span class="wo-gnote">Steepest stretch: ${fits.at(-1).label} or easier stays inside ${who}'s range</span>`;
  }
  return `<div class="wo-grades" data-gi="${i}">
    <span class="${over ? 'over' : ''}">Max <b>${pct1(hi)}</b>${over ? WARN_ICO : ''}</span>
    <span>Min <b>${pct1(lo)}</b></span>
    ${note}
  </div>`;
}
/** Settings changed (trainer range, grade realism): redraw every grade line on screen. */
export function refreshGradeRanges() {
  $$('.wo-grades[data-gi]').forEach((el) => { const w = app.library[+el.dataset.gi]; if (w) el.outerHTML = gradeRangeHtml(w, +el.dataset.gi, app.settings); });
}

/** @param {Workout} w @param {number} i */
export function detailRow(w, i) {
  if (!w.profile) return '';
  return `<div class="wo-detail">
    <label for="det-${i}">Detail</label>
    <input type="range" id="det-${i}" data-detail="${i}" min="${DETAIL_MIN}" max="${DETAIL_MAX}" step="1" value="${sliderOf(w.detail)}" tabindex="-1" aria-describedby="detv-${i}">
    <span class="wo-det-v" id="detv-${i}">${detailText(w)}</span>
    <button class="ghost small" data-detdef="${i}" tabindex="-1"${w.detail === defaultDetail(w) ? ' hidden' : ''}>Default</button>
  </div>`;
}

/** Re-cut one climb in the library and redraw its row; commit = save the choice and refresh the plan views. */
function setClimbDetail(i, lv, commit) {
  const w = withDetail(app.library[i], lv);
  app.library[i] = w;
  const card = /** @type {HTMLElement} */ (document.querySelector(`.wo[data-i="${i}"]`));
  if (card) {
    const pl = view().prof;
    const mini = card.querySelector(':scope > .profile');
    if (mini) mini.outerHTML = profileSvg(w, pl);
    card.querySelector('.wo-meta').innerHTML = woMeta(w);
    const old = card.querySelector('.wo-prof');
    if (old) {
      const box = document.createElement('div');
      box.className = 'wo-prof prof-hover';
      box.innerHTML = profileSvg(w, pl, 1000, 100);
      old.replaceWith(box);
      if (card.classList.contains('expanded')) { card.dataset.prof = '1'; bindProfileHover(box, w, pl); } else delete card.dataset.prof;
    }
    card.querySelector('.wo-det-v').innerHTML = detailText(w);
    const gr = card.querySelector('.wo-grades');
    if (gr) gr.outerHTML = gradeRangeHtml(w, i, app.settings);
    /** @type {HTMLInputElement} */ (card.querySelector('.wo-detail input')).value = String(sliderOf(w.detail));
    /** @type {HTMLElement} */ (card.querySelector('[data-detdef]')).hidden = w.detail === defaultDetail(w);
  }
  if (!commit) return;
  const cd = { ...(app.settings.climbDetail || {}) };
  if (w.detail === defaultDetail(w)) delete cd[w.id]; else cd[w.id] = w.detail;
  app.settings.climbDetail = cd;
  ls.set('settings', app.settings);
  saveSettings();
  refreshPlanViews();
}

function bindDetailSliders() {
  $$('.wo-detail input').forEach((/** @type {HTMLInputElement} */ inp) => {
    const i = +inp.dataset.detail, lv = () => sliderOf(+inp.value);
    inp.addEventListener('input', () => setClimbDetail(i, lv(), false));
    inp.addEventListener('change', () => setClimbDetail(i, lv(), true));
  });
  $$('[data-detdef]').forEach((b) => b.addEventListener('click', () => setClimbDetail(+b.dataset.detdef, defaultDetail(app.library[+b.dataset.detdef]), true)));
}

/** @param {Workout} w */
export const isSlopeOnly = (w) => flatten(w).every((x) => x.kind === 'sim');

// Not shown as chips: 'sim' has its own chip; weekday tags are leftovers from old plans (the calendar says when).
export const HIDDEN_TAGS = new Set(['sim', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
/** @param {Workout} w @param {number} i Index in app.library. @param {LibView} v */
export function workoutCard(w, i, v) {
  const facts = woFacts(w, v);
  return `
    <div class="wo" data-i="${i}" tabindex="0">
      <div class="wo-top"><div class="wo-name">${esc(w.name)}${w._source === 'coach' ? ' <span class="tag coach">coach</span>' : ''}</div><div class="wo-meta">${woMeta(w)}</div></div>
      ${profileSvg(w, v.prof)}
      <div class="wo-more"><div class="wo-more-in">
        <div class="wo-info${facts ? '' : ' nofacts'}"><div class="wo-text">
          <div class="wo-tags">${(w.tags || []).filter((t) => !HIDDEN_TAGS.has(t) && !GROUP_TAGS.has(t)).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          <div class="wo-desc">${esc(w.description)}</div>
        </div>${facts}</div>
        <div class="wo-prof prof-hover">${profileSvg(w, v.prof, 1000, 100)}</div>
        ${gradeRangeHtml(w, i, v.settings)}
        ${detailRow(w, i)}
        <div class="start-row"><button class="primary small" data-start="${i}" tabindex="-1">Start</button>${w._source === 'mine' ? `<button class="ghost small" data-edit="${i}" tabindex="-1">Edit</button>` : v.signedIn ? `<button class="ghost small" data-copy="${i}" tabindex="-1">Edit a copy</button>` : ''}${w.tags?.includes('imported') ? `<button class="ghost small" data-remove="${i}" tabindex="-1">Remove</button>` : ''}</div>
      </div></div>
    </div>`;
}

// ------------------------------------------------------------------ library groups (UX roadmap item 10, Nov 12)
// ERG and Slope lists are split by purpose, each group its own sheet. ERG easiest first (TSS), slope by duration.
// Mine stays one flat list. The group comes from the tags; untagged workouts (imported .zwo) go by their hardest step.
export const GROUPS = { erg: ['VO2max', 'Threshold', 'Endurance', 'Tests'], slope: ['Climb intervals', 'Real climbs', 'Endurance', 'Tests'] };
export const GROUP_TAGS = new Set(['vo2', 'threshold', 'z2', 'test', 'real climb', 'climb', 'endurance']); // the group label says these
/** @param {Workout} w @param {'erg' | 'slope'} kind */
export function groupOf(w, kind) {
  const t = w.tags || [];
  if (t.includes('test') || t.includes('max')) return 'Tests';
  const segs = flatten(w);
  if (kind === 'slope') {
    if (t.includes('real climb')) return 'Real climbs';
    if (t.includes('climb') || t.includes('strength')) return 'Climb intervals';
    if (t.includes('endurance')) return 'Endurance';
    if (isTrack(segs) && segs.length > 20) return 'Real climbs'; // untagged: a long distance profile is a real road
    return Math.max(...segs.map((x) => x.grade ?? 0)) >= 0.05 ? 'Climb intervals' : 'Endurance';
  }
  if (t.includes('vo2')) return 'VO2max';
  if (t.includes('threshold') || t.includes('sweetspot')) return 'Threshold';
  if (t.includes('z2') || t.includes('endurance') || t.includes('easy')) return 'Endurance';
  const top = Math.max(0, ...segs.filter((x) => x.kind === 'erg' && x.dur >= 60).map((x) => Math.max(x.from, x.to)));
  return top > 1.05 ? 'VO2max' : top > 0.88 ? 'Threshold' : 'Endurance';
}
/** @param {{ w: Workout, i: number }[]} items @param {'erg' | 'slope'} kind @param {LibView} v */
export function groupedHtml(items, kind, v) {
  const key = kind === 'slope' ? (x) => totalDuration(x.w) : (x) => estimateTSS(x.w);
  return GROUPS[kind].map((g) => {
    const rows = items.filter((x) => groupOf(x.w, kind) === g).sort((a, b) => key(a) - key(b));
    return rows.length ? `<section class="wo-sec"><h3 class="wo-gh">${g}</h3><div class="wo-sheet">${rows.map((x) => workoutCard(x.w, x.i, v)).join('')}</div></section>` : '';
  }).join('');
}

/** Open row, right of the description: main set, next date in the plan, time in zones (ERG) or by grade (slope). */
/** @param {Workout} w @param {LibView} v */
export function woFacts(w, v) {
  const out = [];
  const main = workSummary(w, v.prof.ftp);
  if (main) out.push(`<div class="f"><span class="fl">Main set</span><span class="fv">${main}</span></div>`);
  const today = v.today;
  const next = Object.keys(v.plan?.days || {}).sort().find((k) => k >= today && v.plan.days[k] === w.id);
  if (next) {
    const when = next === today ? 'Today' : dayDate(next).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    out.push(`<div class="f"><span class="fl">In the plan</span><span class="fv">${when}</span></div>`);
  }
  const segs = flatten(w, v.settings.ftp);
  const slope = segs.every((x) => x.kind === 'sim');
  if ((slope || !isTrack(segs)) && !segs.some((x) => x.untilFail)) {
    const t = {};
    for (const x of segs) {
      const parts = slope ? 1 : 10; // ramps: split so a ramp counts in every zone it crosses
      for (let k = 0; k < parts; k++) {
        const z = slope ? gradeBand(x.grade) : zoneOf(x.from + (x.to - x.from) * (k + 0.5) / parts);
        t[z] = (t[z] || 0) + x.dur / parts;
      }
    }
    const keys = Object.keys(t).map(Number).sort((a, b) => a - b);
    const col = (k) => (slope ? v.GRADE[k] : v.ZC[ZONES[k].color]);
    const lab = (k) => (slope ? GRADE_LABEL[k] : `Z${k + 1}`);
    const bar = keys.map((k) => `<i style="flex:${t[k]};background:${col(k)}"></i>`).join('');
    const leg = keys.filter((k) => t[k] >= 60).sort((a, b) => b - a).slice(0, 4)
      .map((k) => `<span><i style="background:${col(k)}"></i>${lab(k)} ${Math.round(t[k] / 60)} min</span>`).join('');
    out.push(`<div class="f zbar"><span class="fl">${slope ? 'Time by grade' : 'Time in zones'}</span><div class="zb">${bar}</div><div class="zl">${leg}</div></div>`);
  }
  return out.length ? `<div class="wo-facts">${out.join('')}</div>` : '';
}
export const GRADE_LABEL = ['Down', '0-3%', '3-6%', '6-9%', '9-12%', '12%+'];

export function renderLibrary() {
  const v = view();
  const erg = [], slope = [], mine = [];
  app.library.forEach((w, i) => (w._source === 'mine' ? mine : isSlopeOnly(w) ? slope : erg).push({ w, i }));
  mine.forEach((x, k) => (mine[k] = workoutCard(x.w, x.i, v)));
  $('#workout-list').innerHTML = groupedHtml(erg, 'erg', v) || '<p class="muted empty-list">No ERG workouts yet.</p>';
  $('#slope-list').innerHTML = groupedHtml(slope, 'slope', v) || '<p class="muted empty-list">No slope sessions yet.</p>';
  $('#mine-list').innerHTML = mine.join('') || '<p class="muted empty-list mine-empty">Nothing here yet. Build one with New workout, or open any workout and use Edit a copy.</p>';
  $('#kind-btn-mine').classList.toggle('hidden', !signedIn());
  setWoKind(ls.get('woKind', app.woKind)); // the kind last picked: "mine" signed out shows ERG but stays remembered
  bindDetailSliders();
  $$('.wo').forEach((c) => c.addEventListener('click', (/** @type {ElementEvent} */ e) => {
    if (e.target.dataset.start) return startWorkout(app.library[+e.target.dataset.start]);
    if (e.target.dataset.remove) return removeImported(app.library[+e.target.dataset.remove]);
    if (e.target.dataset.edit) return openBuilder(app.library[+e.target.dataset.edit], { mine: true });
    if (e.target.dataset.copy) return openBuilder(app.library[+e.target.dataset.copy]);
    if (e.target.closest('.wo-prof')) return; // the open chart has its own hover/tap readout
    if (e.target.closest('.wo-detail')) return; // detail slider and Default (own handlers)
    // One open row at a time (across the ERG and slope lists).
    const open = !c.classList.contains('expanded');
    $$('.wo.expanded').forEach((x) => { x.classList.remove('expanded'); x.querySelectorAll('.start-row button, .wo-detail input, .wo-detail button').forEach((/** @type {HTMLElement} */ b) => (b.tabIndex = -1)); });
    c.classList.toggle('expanded', open);
    if (open) c.querySelectorAll('.start-row button, .wo-detail input, .wo-detail button').forEach((/** @type {HTMLElement} */ b) => (b.tabIndex = 0));
    // Big chart with the same readout as the today hero; bound on first open (one document listener per chart).
    if (open && !c.dataset.prof) { c.dataset.prof = '1'; bindProfileHover(c.querySelector('.wo-prof'), app.library[+c.dataset.i], view().prof); }
  }));
  applyFocus();
}

/** Workouts tab: ERG and slope sessions share one list area, switched by a pill toggle. */
export function setWoKind(k, animate = false) {
  const prev = app.woKind;
  app.woKind = k === 'slope' ? 'slope' : k === 'mine' && signedIn() ? 'mine' : 'erg';
  if (k !== 'mine' || app.woKind === 'mine') ls.set('woKind', app.woKind); // signed out: keep "mine" for next sign-in
  $$('#wo-kind button').forEach((b) => { const on = b.dataset.kind === app.woKind; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  for (const x of WO_KINDS) $(`#kind-${x}`).classList.toggle('hidden', app.woKind !== x);
  placeInk($('#wo-kind'), $('#wo-kind button.on'));
  if (animate && prev !== app.woKind) slideIn($(`#kind-${app.woKind}`), WO_KINDS.indexOf(app.woKind) > WO_KINDS.indexOf(prev) ? 1 : -1);
}
const WO_KINDS = ['erg', 'slope', 'mine'];

function removeImported(w) {
  ls.set('imported', ls.get('imported', []).filter((x) => x.id !== w.id));
  app.library = app.library.filter((x) => x !== w);
  renderLibrary();
}
