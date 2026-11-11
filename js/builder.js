// Workout builder: drag blocks from a palette onto a timeline, drag them to reorder (or into a repeat),
// pull a selected bar's top edge for power/grade and its right edge for length. The selected block's
// details (cadence, name, cue, exact numbers) are edited below the timeline.
// Saving goes through deps.onSave (app.js stores it in rodillo-data workouts/mine.json).
import { flatten, parseMessageLines, formatMessageLines } from './engine/workout.js?v=202611102147';
import { parseDur, fmtDur, workoutProblems, cleanWorkout, newMineId } from './mine.js?v=202611102147';

let D = null;   // deps from app.js
let st = null;  // { w, isNew, mine, snap, kind, sel, untouched, undo: [], scale }
let drag = null;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = (x) => JSON.parse(JSON.stringify(x));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAXF = 1.5; // top of the timeline = 150% FTP (same scale as the library profiles)
const gradeH = (g) => Math.min(1, Math.max(0.04, (g / 100 + 0.03) / 0.15)); // grade % -> bar height fraction

// ---------------------------------------------------------------- presets (palette tiles)
const P = {
  warmup: () => ({ dur: 600, from: 0.45, to: 0.7, label: 'Warm-up' }),
  steady: () => ({ dur: 600, power: 0.75 }),
  ramp: () => ({ dur: 300, from: 0.6, to: 0.9 }),
  intervals: () => ({ repeat: 5, steps: [{ dur: 240, power: 1.1 }, { dur: 240, power: 0.5 }] }),
  recovery: () => ({ dur: 180, power: 0.5 }),
  cooldown: () => ({ dur: 300, from: 0.6, to: 0.4, label: 'Cool-down' }),
  climb: () => ({ dur: 300, grade: 6 }),
  climbKm: () => ({ dist: 1500, grade: 6 }),
  flat: () => ({ dur: 180, grade: 0 }),
  free: () => ({ dur: 300, free: true }),
  repeat: () => ({ repeat: 3, steps: [{ dur: 300, grade: 6 }, { dur: 180, grade: 0 }] }),
};
const TILES = {
  erg: [['warmup', 'Warm-up'], ['steady', 'Steady'], ['ramp', 'Ramp'], ['intervals', 'Intervals'], ['recovery', 'Recovery'], ['cooldown', 'Cool-down']],
  slope: [['climb', 'Climb'], ['climbKm', 'Climb by km'], ['flat', 'Flat'], ['free', 'Free ride'], ['repeat', 'Repeat']],
};
// little monochrome shapes for the tiles (color is for data only)
const TILE_ICO = {
  warmup: '<path d="M2 18 L22 8 V18 Z"/>', cooldown: '<path d="M2 8 L22 14 V18 H2 Z"/>', steady: '<rect x="2" y="9" width="20" height="9"/>',
  ramp: '<path d="M2 14 L22 5 V18 H2 Z"/>', recovery: '<rect x="2" y="13" width="20" height="5"/>',
  intervals: '<path d="M2 6h4v12H2zM6 13h3v5H6zM9 6h4v12H9zM13 13h3v5h-3zM16 6h4v12h-4z"/>',
  climb: '<path d="M2 18 L22 6 V18 Z"/>', climbKm: '<path d="M2 18 L22 6 V18 Z"/>', flat: '<rect x="2" y="14" width="20" height="4"/>',
  free: '<rect x="2" y="14" width="20" height="4" opacity=".5"/>', repeat: '<path d="M2 9h6v9H2zM8 14h4v4H8zM12 9h6v9h-6zM18 14h4v4h-4z"/>',
};
const TEMPLATE = {
  erg: () => [P.warmup(), { dur: 1200, power: 0.75 }, P.cooldown()],
  slope: () => [{ dur: 600, grade: 1, label: 'Warm-up roll' }, P.repeat(), { dur: 300, grade: 0, label: 'Cool-down' }],
};
const TYPES = [['steady', 'Steady'], ['ramp', 'Ramp'], ['watts', 'Watts'], ['grade', 'Grade'], ['free', 'Free ride']];
const typeOf = (s) => (s.repeat != null ? 'repeat' : s.free ? 'free' : s.grade != null ? 'grade' : s.watts != null ? 'watts' : s.from != null ? 'ramp' : 'steady');

const ICON = {
  up: '<path d="m15 18-6-6 6-6"/>', // "up" = earlier = left on the timeline
  down: '<path d="m9 18 6-6-6-6"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  del: '<path d="M18 6 6 18M6 6l12 12"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
};
const icon = (k, n = 16) => `<svg viewBox="0 0 24 24" width="${n}" height="${n}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const ACT_LABEL = { up: 'Move earlier', down: 'Move later', dup: 'Duplicate', del: 'Delete' };

// ---------------------------------------------------------------- paths ("2" or "2.1": indexes into steps arrays)
const parts = (p) => String(p).split('.').map(Number);
const parentOf = (p) => parts(p).slice(0, -1).join('.');
function listOf(p) { // the array holding step p, and its index
  const ix = parts(p);
  let arr = st.w.steps;
  for (const i of ix.slice(0, -1)) arr = arr[i].steps;
  return [arr, ix.at(-1)];
}
const stepAt = (p) => { const [a, i] = listOf(p); return a[i]; };
const safeStep = (p) => { try { return stepAt(p) || null; } catch { return null; } };
const arrAt = (list) => (list === '' ? st.w.steps : stepAt(list).steps);
function pathOf(obj) {
  let found = null;
  const walk = (steps, pre) => steps.forEach((s, i) => {
    const p = pre ? `${pre}.${i}` : `${i}`;
    if (s === obj) found = p;
    else if (s.repeat != null) walk(s.steps, p);
  });
  walk(st.w.steps, '');
  return found;
}
/** Seconds one pass of a step takes (distance steps estimated like the engine does). */
const durOf = (s) => { const g = flatten({ steps: [s] }, D.ftp()); return g.length ? g.at(-1).end : 0; };

// ---------------------------------------------------------------- public
export function initBuilder(deps) {
  D = deps;
  const panel = $('#builder');
  panel.addEventListener('input', onInput);
  panel.addEventListener('change', onChange);
  panel.addEventListener('click', onClick);
  panel.addEventListener('focusin', (e) => {
    if (e.target.matches('.b-in')) pushUndo(); // one undo step per field edit
    const r = e.target.closest('#b-steps [data-p]');
    if (r) select(r.dataset.p, false);
  });
  // drags: pointer events, plus a touch fallback for web views that don't send them (Bluefy)
  panel.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (start(e.clientX, e.clientY, e.target, 'pointer') && e.pointerType === 'mouse') e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => { if (drag?.via === 'pointer') move(e.clientX, e.clientY); });
  window.addEventListener('pointerup', (e) => { if (drag?.via === 'pointer') end(e.clientX, e.clientY); });
  window.addEventListener('pointercancel', () => { if (drag?.via === 'pointer') cancelDrag(); });
  panel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0], el = e.target;
    // pointer events already started this gesture: just keep the page from scrolling under the drag
    if (!drag && !start(t.clientX, t.clientY, el, 'touch')) return;
    // cancel it: browsers otherwise hold back small moves (touch slop), and end() already handles taps
    if (e.cancelable) e.preventDefault();
    // touch events keep going to the start element even after a re-render detaches it, so listen there
    const mv = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      if (drag.via === 'touch') move(ev.touches[0].clientX, ev.touches[0].clientY);
    };
    const up = (ev) => {
      el.removeEventListener('touchmove', mv); el.removeEventListener('touchend', up); el.removeEventListener('touchcancel', up);
      if (drag?.via !== 'touch') return;
      if (ev.type === 'touchcancel') return cancelDrag();
      const c = ev.changedTouches[0];
      if (ev.cancelable) ev.preventDefault(); // no synthetic click afterwards: end() already handled the tap
      end(c.clientX, c.clientY);
    };
    el.addEventListener('touchmove', mv, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
  }, { passive: false });
  window.addEventListener('resize', () => { if (builderOpen() && !drag) renderTimeline(); });
  document.addEventListener('keydown', (e) => {
    if (!builderOpen() || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return; // native undo inside fields
    e.preventDefault();
    undo();
  });
}
export const builderOpen = () => !!st && !$('#builder').classList.contains('hidden');

/** w: workout to edit (null = new). mine: true when it's one of Agustín's (edit in place), else a copy is made. */
export function openBuilder(w = null, { mine = false, kind = 'erg' } = {}) {
  if (!D.signedIn()) return; // the builder saves to the private repo: signed in only
  let work;
  if (!w) work = { id: null, name: '', description: '', tags: [], steps: TEMPLATE[kind]() };
  else if (mine) work = clone(stripUi(w));
  else {
    work = clone(stripUi(w));
    work.basedOn = w.id;
    work.id = null;
    work.name = `${w.name} (copy)`;
    work.tags = (w.tags || []).filter((t) => !['imported', 'coach', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(t));
  }
  const allSim = w && flatten(w).every((s) => s.kind === 'sim');
  st = { w: work, isNew: !w || !mine, mine, kind: w ? (allSim ? 'slope' : 'erg') : kind, sel: null, untouched: !w, undo: [] };
  st.snap = JSON.stringify(work);
  $$('.panel').forEach((p) => p.classList.add('hidden'));
  $('#builder').classList.remove('hidden'); // shown first: the timeline sizes itself from its width
  render();
  $('#builder').scrollTop = 0;
  if (!w) setTimeout(() => $('#b-name')?.focus({ preventScroll: true }), 60);
}
const stripUi = (w) => { const { _source, updatedAt, ...rest } = w; return rest; };
const dirty = () => st && JSON.stringify(st.w) !== st.snap;

/** Close, asking first when there are unsaved changes. Resolves true when closed. */
export async function closeBuilder() {
  if (!st) return true;
  if (dirty() && !(await D.ask('Your changes to this workout will be lost.', { title: 'Discard changes?', ok: 'Discard', danger: true }))) return false;
  cleanupDrag();
  $('#builder').classList.add('hidden');
  st = null;
  return true;
}

// ---------------------------------------------------------------- undo
function pushUndo() {
  const s = JSON.stringify(st.w.steps);
  if (st.undo.at(-1) !== s) st.undo.push(s);
  if (st.undo.length > 60) st.undo.shift();
  $('#b-undo')?.removeAttribute('disabled');
}
function undo() {
  const now = JSON.stringify(st.w.steps);
  while (st.undo.length && st.undo.at(-1) === now) st.undo.pop(); // snapshots taken without a change since
  if (!st.undo.length) { $('#b-undo').setAttribute('disabled', ''); return; }
  st.w.steps = JSON.parse(st.undo.pop());
  if (st.sel != null && !safeStep(st.sel)) st.sel = null;
  renderSteps(); renderTimeline();
  $('#b-undo').toggleAttribute('disabled', !st.undo.length);
}

// ---------------------------------------------------------------- render
function render() {
  const w = st.w;
  $('#builder-body').innerHTML = `
    <div class="b-top">
      <input id="b-name" class="b-name" data-f="name" placeholder="Workout name" value="${D.esc(w.name)}" autocomplete="off" enterkeyhint="done">
    </div>
    <div class="b-pal-row">
      <div class="wo-kind seg-tg b-kind" id="b-kind" role="tablist" aria-label="Blocks for">
        <button data-kind="erg" role="tab" class="${st.kind === 'erg' ? 'on' : ''}">ERG</button><button data-kind="slope" role="tab" class="${st.kind === 'slope' ? 'on' : ''}">Slope</button>
      </div>
      <span class="b-pal-hint muted">Drag a block onto the timeline</span>
      <button class="b-ico b-undo" id="b-undo" aria-label="Undo" title="Undo" disabled>${icon('undo', 18)}</button>
    </div>
    <div class="b-pal-wrap">
      <div class="b-pal" id="b-pal"></div>
      <div class="b-trash" id="b-trash">${icon('del', 18)} Drop here to delete</div>
    </div>
    <div class="b-tl" id="b-tl"></div>
    <div class="b-meta" id="b-meta"></div>
    <div class="b-steps" id="b-steps"></div>
    <label class="b-lab" for="b-desc">Description</label>
    <textarea id="b-desc" class="b-desc" data-f="description" rows="3" placeholder="What the session is for and how it should feel">${D.esc(w.description)}</textarea>
    <div class="b-problems hidden" id="b-problems" role="alert"></div>`;
  $('#builder-title').textContent = st.isNew ? (w.basedOn ? 'Copy of a workout' : 'New workout') : 'Edit workout';
  $('#b-delete').classList.toggle('hidden', st.isNew);
  renderPalette();
  renderSteps();
  renderTimeline();
  requestAnimationFrame(() => D.placeInk($('#b-kind'), $('#b-kind button.on')));
}

function renderPalette() {
  $('#b-pal').innerHTML = TILES[st.kind].map(([k, t]) =>
    `<button class="b-tile" data-tile="${k}" title="Drag onto the timeline, or tap to add"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">${TILE_ICO[k]}</svg><span>${t}</span></button>`).join('');
}

/** Timeline: one element per step, width proportional to time (px per second held fixed while an edge is dragged). */
function renderTimeline(fixedScale) {
  const box = $('#b-tl');
  if (!box) return;
  const steps = st.w.steps, ftp = D.ftp();
  const total = steps.reduce((a, s) => a + durOf(s), 0); // durOf already counts every pass of a repeat
  const cw = (box.clientWidth || 800) - 2;
  const scale = fixedScale || (total ? Math.min(cw / total, 1.5) : 1); // px per second
  st.scale = scale;
  const bar = (s) => {
    const t = typeOf(s);
    let a, b, col;
    if (t === 'grade' || t === 'free') { a = b = gradeH(s.grade || 0) * 100; col = D.gradeHex((s.grade || 0) / 100); }
    else {
      const f0 = t === 'ramp' ? s.from : t === 'watts' ? s.watts / ftp : s.power, f1 = t === 'ramp' ? s.to : f0;
      a = Math.min(f0 / MAXF, 1) * 100; b = Math.min(f1 / MAXF, 1) * 100; col = D.zoneHex((f0 + f1) / 2);
    }
    return { a, b, col, t };
  };
  const leaf = (s, p, cls, copy) => {
    const { a, b, col, t } = bar(s), w = Math.max(cls === 'tl-c' ? 3 : 10, durOf(s) * scale);
    const sel = st.sel === p;
    let handles = '';
    if (sel && drag?.kind !== 'move') {
      if (t === 'ramp') handles = `<i class="tl-h tl-hy" data-h="from" style="bottom:${a}%;left:0"></i><i class="tl-h tl-hy" data-h="to" style="bottom:${b}%;right:0"></i>`;
      else if (t !== 'free') handles = `<i class="tl-h tl-hy tl-hy-wide" data-h="y" style="bottom:${a}%"></i>`;
      if (w >= 26) handles += '<i class="tl-h tl-hx" data-h="x"></i>'; // narrower: the block itself stays draggable (length in the fields below)
    }
    return `<div class="${cls}${sel ? ' sel' : ''}" data-p="${p}"${copy != null ? ` data-copy="${copy}"` : ''} style="width:${w}px"><div class="tl-bar" style="background:${col};clip-path:polygon(0 100%,0 ${100 - a}%,100% ${100 - b}%,100% 100%)"></div>${handles}</div>`;
  };
  let html = '';
  steps.forEach((s, i) => {
    const p = `${i}`;
    if (s.repeat != null) {
      // every pass drawn out; a repeat inside a repeat too (its cells keep the outer pass number first: "2-1")
      const cells = (kids, pre, copy) => kids.map((c, j) => (c.repeat != null
        ? Array.from({ length: c.repeat }, (_, r2) => cells(c.steps, `${pre}.${j}`, `${copy}-${r2}`)).join('')
        : leaf(c, `${pre}.${j}`, 'tl-c', copy))).join('');
      let inner = '';
      for (let r = 0; r < s.repeat; r++) inner += cells(s.steps, p, `${r}`);
      html += `<div class="tl-b tl-rep${st.sel === p ? ' sel' : ''}" data-p="${p}"><div class="tl-rep-k" data-p="${p}">${s.repeat} &times;</div><div class="tl-rep-in">${inner}</div></div>`;
    } else html += leaf(s, p, 'tl-b');
  });
  box.innerHTML = `<div class="tl-in">${html || '<div class="tl-empty muted">Drag blocks here</div>'}<i class="tl-mark hidden" id="tl-mark"></i></div>`;
  if (drag?.kind === 'move') $$(`[data-p="${drag.path}"]`, box).forEach((x) => x.classList.add('dragging'));
  renderMeta();
}

function renderMeta() {
  const w = st.w, segs = flatten(w, D.ftp());
  const total = segs.length ? segs.at(-1).end : 0, cap = D.maxMinutes();
  const s = st.sel != null && safeStep(st.sel);
  $('#b-meta').innerHTML = `<span class="b-tot">${segs.length ? D.woMeta(w) : '0 min'}</span>${s ? `<span class="b-selinfo">${D.esc(describe(s))}</span>` : ''}${cap && total > cap * 60 ? `<span class="b-cap">Over the plan's ${cap}-min cap</span>` : ''}`;
}
function describe(s) {
  const ftp = D.ftp(), t = typeOf(s);
  const len = s.dist != null ? `${+(s.dist / 1000).toFixed(2)} km` : fmtDur(s.dur);
  if (t === 'repeat') return `${s.repeat} x (${s.steps.map((c) => (c.repeat != null ? `${c.repeat} x ...` : describe(c))).join(', ')})`;
  if (t === 'steady') return `${len} at ${Math.round(s.power * 100)}% (${Math.round(s.power * ftp)} W)`;
  if (t === 'ramp') return `${len}, ${Math.round(s.from * 100)} to ${Math.round(s.to * 100)}% (${Math.round(s.from * ftp)}-${Math.round(s.to * ftp)} W)`;
  if (t === 'watts') return `${len} at ${s.watts} W`;
  if (t === 'grade') return `${len} at ${s.grade}%`;
  return `${len} free ride`;
}

function acts(p) {
  return `<span class="b-acts">${['up', 'down', 'dup', 'del'].map((a) => `<button class="b-ico" data-act="${a}" data-ap="${p}" aria-label="${ACT_LABEL[a]}" title="${ACT_LABEL[a]}">${icon(a)}</button>`).join('')}</span>`;
}

/** Details of the selected block (a repeat shows all its steps). */
function renderSteps() {
  const row = (s, p) => {
    if (s.repeat != null) {
      return `<div class="b-rep${st.sel === p ? ' sel' : ''}" data-p="${p}">
        <div class="brep-head"><span class="b-rep-k">Repeat</span><input class="b-in b-n" data-f="repeat" data-fp="${p}" value="${s.repeat}" inputmode="numeric" aria-label="Times"><span class="muted">times</span><span class="b-sum muted" data-sum="${p}"></span>${acts(p)}</div>
        <div class="brep-body">${s.steps.map((c, j) => row(c, `${p}.${j}`)).join('')}
          <button class="ghost small b-add-in" data-addin="${p}">+ Step in repeat</button></div>
      </div>`;
    }
    const t = typeOf(s), km = s.dist != null;
    let tgt;
    if (t === 'steady') tgt = `<input class="b-in b-n" data-f="pct" data-fp="${p}" value="${Math.round(s.power * 100)}" inputmode="numeric" aria-label="Power, % of FTP"><span class="b-u">%</span>`;
    else if (t === 'ramp') tgt = `<input class="b-in b-n" data-f="from" data-fp="${p}" value="${Math.round(s.from * 100)}" inputmode="numeric" aria-label="Ramp from, % of FTP"><span class="b-u">to</span><input class="b-in b-n" data-f="to" data-fp="${p}" value="${Math.round(s.to * 100)}" inputmode="numeric" aria-label="Ramp to, % of FTP"><span class="b-u">%</span>`;
    else if (t === 'watts') tgt = `<input class="b-in b-n" data-f="watts" data-fp="${p}" value="${s.watts}" inputmode="numeric" aria-label="Watts"><span class="b-u">W</span>`;
    else if (t === 'grade') tgt = `<input class="b-in b-n" data-f="grade" data-fp="${p}" value="${s.grade}" type="number" step="0.5" min="-10" max="25" aria-label="Grade, %"><span class="b-u">%</span>`;
    else tgt = '<span class="b-u b-free">you pick the grade</span>';
    return `<div class="b-step${st.sel === p ? ' sel' : ''}" data-p="${p}">
      <div class="b-line1">
        <i class="b-sw" data-sw="${p}"></i>
        <select class="b-in b-type" data-f="type" data-fp="${p}" aria-label="Step type">${TYPES.map(([k, l]) => `<option value="${k}"${k === t ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <span class="b-len"><input class="b-in b-dur" data-f="len" data-fp="${p}" value="${km ? +(s.dist / 1000).toFixed(2) : fmtDur(s.dur)}" ${km ? 'inputmode="decimal"' : ''} aria-label="${km ? 'Distance, km' : 'Duration'}"><button class="b-in b-unit" data-unitp="${p}" title="${km ? 'Switch to time' : 'Switch to distance'}" aria-label="${km ? 'By distance. Switch to time' : 'By time. Switch to distance'}">${km ? 'km' : 'min'}</button></span>
        <span class="b-tgt">${tgt}<span class="b-w muted" data-w="${p}"></span></span>
        <input class="b-in b-cad" data-f="cadence" data-fp="${p}" value="${D.esc(s.cadence ?? '')}" placeholder="rpm" aria-label="Cadence target: 90, 80-90 or 100+">
        ${acts(p)}
      </div>
      <div class="b-line2">
        <input class="b-in" data-f="label" data-fp="${p}" value="${D.esc(s.label || '')}" placeholder="Name on screen" aria-label="Step name">
        <input class="b-in" data-f="text" data-fp="${p}" value="${D.esc(s.text || '')}" placeholder="Cue on screen" aria-label="Cue">
        <span class="b-msgs-k muted">Messages over the chart, one per line</span>
        <textarea class="b-in b-msgs" data-f="messages" data-fp="${p}" rows="${Math.min(6, Math.max(2, (s.messages?.length || 0) + 1))}" placeholder="0:30 Settle in  ·  -0:15 Hold it  ·  50% Halfway  ·  last -0:20 Last one  ·  {watts} = target watts" aria-label="Messages, one per line">${D.esc(formatMessageLines(s.messages))}</textarea>
      </div>
    </div>`;
  };
  const box = $('#b-steps');
  if (st.sel == null || !safeStep(st.sel)) {
    box.innerHTML = `<p class="b-hint muted">${st.w.steps.length ? 'Tap a block to edit it. Drag blocks to move them, or onto the bin to delete. On a selected block, drag the top edge for power or grade and the right edge for length.' : 'Drag a block from above onto the timeline to start.'}</p>`;
    return;
  }
  const top = `${parts(st.sel)[0]}`;
  box.innerHTML = row(stepAt(top), top);
  refreshReadouts();
}

/** Watts next to targets, swatch colors, repeat totals: cheap, done on every keystroke. */
function refreshReadouts() {
  const ftp = D.ftp();
  for (const el of $$('#b-steps [data-w]')) {
    const s = stepAt(el.dataset.w), t = typeOf(s);
    el.textContent = t === 'steady' ? `${Math.round(s.power * ftp)} W` : t === 'ramp' ? `${Math.round(s.from * ftp)}-${Math.round(s.to * ftp)} W` : t === 'watts' ? `${Math.round((s.watts / ftp) * 100)}% FTP` : '';
  }
  for (const el of $$('#b-steps [data-sw]')) {
    const s = stepAt(el.dataset.sw), t = typeOf(s);
    el.style.background = t === 'grade' || t === 'free' ? D.gradeHex((s.grade || 0) / 100) : D.zoneHex(t === 'ramp' ? (s.from + s.to) / 2 : t === 'watts' ? s.watts / ftp : s.power);
  }
  for (const el of $$('#b-steps [data-sum]')) {
    const segs = flatten({ steps: [stepAt(el.dataset.sum)] }, ftp);
    el.textContent = segs.length ? `= ${segs.some((g) => g.estDur) ? '~' : ''}${fmtDur(segs.at(-1).end)}` : '';
  }
}

function select(p, rerenderSteps = true) {
  if (st.sel === p) return;
  const prevTop = st.sel == null ? null : parts(st.sel)[0];
  st.sel = p;
  if (rerenderSteps && (p == null || parts(p)[0] !== prevTop)) renderSteps();
  else $$('#b-steps [data-p]').forEach((x) => x.classList.toggle('sel', x.dataset.p === p));
  renderTimeline();
}

// ---------------------------------------------------------------- drag and drop
// drag.kind: 'tile' (from the palette), 'move' (a block on the timeline), 'handle' (edge of the selected block).
// Before the pointer moves 7 px it's a tap: a tile adds its block, a block gets selected.
function start(x, y, target, via) {
  if (drag || !st) return false;
  const tile = target.closest('.b-tile');
  const h = target.closest('#b-tl .tl-h');
  const blk = target.closest('#b-tl [data-p]');
  if (tile) drag = { via, kind: 'tile', key: tile.dataset.tile, x0: x, y0: y };
  else if (h) {
    const p = h.closest('[data-p]').dataset.p;
    pushUndo();
    drag = { via, kind: 'handle', h: h.dataset.h, path: p, x0: x, y0: y, s0: clone(stepAt(p)), scale: st.scale, rect: $('#b-tl .tl-in').getBoundingClientRect() };
    document.body.classList.add('b-dragging-h', h.dataset.h === 'x' ? 'b-drag-x' : 'b-drag-y');
  } else if (blk) drag = { via, kind: 'move', path: blk.dataset.p, x0: x, y0: y };
  else return false;
  return true;
}

function move(x, y) {
  if (!drag) return;
  if (drag.kind === 'handle') return handleMove(x, y);
  if (!drag.moving) {
    if (Math.hypot(x - drag.x0, y - drag.y0) < 7) return;
    drag.moving = true;
    const s = drag.kind === 'tile' ? P[drag.key]() : stepAt(drag.path);
    drag.isRepeat = s.repeat != null;
    const g = document.createElement('div');
    g.className = 'b-ghost';
    g.textContent = drag.kind === 'tile' ? $(`.b-tile[data-tile="${drag.key}"] span`).textContent : s.label || (s.repeat != null ? `${s.repeat} x repeat` : describe(s));
    document.body.append(g);
    drag.ghost = g;
    document.body.classList.add('b-dragging');
    if (drag.kind === 'move') { $('#b-trash').classList.add('on'); $$(`#b-tl [data-p="${drag.path}"]`).forEach((e) => e.classList.add('dragging')); }
  }
  drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
  drag.target = dropTarget(x, y);
  showMark(drag.target);
}

/** Where a drop at (x, y) would go: { list: '' | '<repeat path>', index, markX, inner } or 'trash' or null. */
function dropTarget(x, y) {
  if (drag.kind === 'move') {
    const tr = $('#b-trash').getBoundingClientRect();
    if (x >= tr.left && x <= tr.right && y >= tr.top - 8 && y <= tr.bottom + 8) return 'trash';
  }
  const tl = $('#b-tl'), r = tl.getBoundingClientRect();
  if (y < r.top - 50 || y > r.bottom + 50 || x < r.left - 30 || x > r.right + 30) return null;
  const inR = tl.querySelector('.tl-in').getBoundingClientRect(), rel = (px) => px - inR.left; // marker lives in .tl-in
  const blocks = $$('#b-tl .tl-in > .tl-b');
  if (!blocks.length) return { list: '', index: 0, markX: 4 };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i].getBoundingClientRect();
    if (x > b.right && i < blocks.length - 1) continue;
    if (blocks[i].classList.contains('tl-rep') && !drag.isRepeat && x > b.left + 10 && x < b.right - 10) {
      // inside a repeat: a position within one pass of its steps
      const p = blocks[i].dataset.p, n = stepAt(p).steps.length;
      const cells = $$(':scope > .tl-rep-in > [data-p]', blocks[i]);
      const cell = cells.find((c) => { const cr = c.getBoundingClientRect(); return x >= cr.left && x <= cr.right; }) || cells.at(-1);
      const passNo = (c) => c.dataset.copy.split('-')[0], kid = (c) => parts(c.dataset.p)[1]; // direct child of this repeat
      const pass = cells.filter((c) => passNo(c) === passNo(cell));
      const j = kid(cell), span = pass.filter((c) => kid(c) === j);
      const sl = span[0].getBoundingClientRect().left, sr = span.at(-1).getBoundingClientRect().right;
      const idx = j + (x > (sl + sr) / 2 ? 1 : 0);
      const edge = idx >= n ? pass.at(-1).getBoundingClientRect().right : pass.find((c) => kid(c) === idx).getBoundingClientRect().left;
      return { list: p, index: idx, markX: rel(edge), inner: true };
    }
    const after = x > b.left + b.width / 2;
    return { list: '', index: i + (after ? 1 : 0), markX: rel(after ? b.right : b.left) };
  }
  return null;
}

function showMark(t) {
  const m = $('#tl-mark');
  $('#b-trash').classList.toggle('hot', t === 'trash');
  if (!m) return;
  if (!t || t === 'trash') { m.classList.add('hidden'); return; }
  m.classList.remove('hidden');
  m.classList.toggle('inner', !!t.inner);
  m.style.left = `${t.markX}px`;
}

function end(x, y) {
  if (!drag) return;
  const d = drag;
  if (d.kind === 'handle') {
    cleanupDrag();
    touched();
    renderTimeline(); renderSteps();
    return;
  }
  if (!d.moving) { // a tap
    drag = null;
    if (d.kind === 'tile') addTile(d.key);
    else select(d.path);
    return;
  }
  const t = dropTarget(x, y);
  cleanupDrag();
  if (!t) { renderTimeline(); return; }
  pushUndo();
  if (t === 'trash') { removePath(d.path); st.sel = null; return structural(null); }
  const item = d.kind === 'tile' ? P[d.key]() : stepAt(d.path);
  placeItem(item, d.kind === 'move' ? d.path : null, t);
  structural(pathOf(item));
}

function cleanupDrag() {
  drag?.ghost?.remove();
  drag = null;
  document.body.classList.remove('b-dragging', 'b-dragging-h', 'b-drag-x', 'b-drag-y');
  $('#b-trash')?.classList.remove('on', 'hot');
}
function cancelDrag() {
  if (!drag) return;
  const wasHandle = drag.kind === 'handle';
  cleanupDrag();
  if (st) { if (wasHandle) undo(); else renderTimeline(); }
}

/** Puts item at target. Inserts a marker first, then removes item from where it was, so no index goes stale. */
function placeItem(item, fromPath, t) {
  const MARK = {}, src = fromPath != null ? listOf(fromPath)[0] : null; // array refs, not paths: inserting shifts paths
  arrAt(t.list).splice(t.index, 0, MARK);
  if (src) src.splice(src.indexOf(item), 1);
  const put = (arr) => { const i = arr.indexOf(MARK); if (i >= 0) { arr[i] = item; return true; } return arr.some((s) => s.repeat != null && put(s.steps)); };
  put(st.w.steps);
  dropEmptyRepeats();
}
function removePath(p) { const [a, i] = listOf(p); a.splice(i, 1); dropEmptyRepeats(); }
function dropEmptyRepeats() {
  const clean = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].repeat != null) { clean(arr[i].steps); if (!arr[i].steps.length) arr.splice(i, 1); } };
  clean(st.w.steps);
}

/** Dragging the selected block's edge: top = power or grade, right = length. */
function handleMove(x, y) {
  const d = drag, s = stepAt(d.path), s0 = d.s0, ftp = D.ftp(), t = typeOf(s);
  if (d.h === 'x') {
    const dsec = (x - d.x0) / d.scale;
    if (s0.dist != null) {
      const perSec = s0.dist / Math.max(1, durOf(s0));
      s.dist = Math.max(50, Math.round((s0.dist + dsec * perSec) / 50) * 50);
    } else {
      const raw = Math.max(5, s0.dur + dsec);
      s.dur = raw < 60 ? Math.round(raw / 5) * 5 : Math.round(raw / 15) * 15;
    }
  } else {
    const frac = Math.min(1, Math.max(0, (d.rect.bottom - y) / d.rect.height));
    if (t === 'grade') s.grade = Math.min(12, Math.max(-3, Math.round((frac * 15 - 3) * 2) / 2));
    else {
      const f = Math.max(0.05, Math.round(frac * MAXF * 100) / 100);
      if (t === 'watts') s.watts = Math.max(10, Math.round((f * ftp) / 5) * 5);
      else if (t === 'ramp') s[d.h] = f;
      else s.power = f;
    }
  }
  st.untouched = false;
  renderTimeline(d.scale);
}

function addTile(key) {
  pushUndo();
  const steps = st.w.steps, isCool = (x) => /cool/i.test(x?.label || '');
  // warm-up first, cool-down last; anything else after the selected block, or before the cool-down
  const top = key === 'warmup' ? 0 : key === 'cooldown' ? steps.length
    : st.sel != null ? parts(st.sel)[0] + 1 : steps.length - (isCool(steps.at(-1)) ? 1 : 0);
  steps.splice(top, 0, P[key]());
  structural(`${top}`);
}

// ---------------------------------------------------------------- field edits
function touched() { st.untouched = false; }

function onInput(e) {
  const el = e.target, f = el.dataset.f;
  if (!f || f === 'type') return;
  if (f === 'name') { st.w.name = el.value; touched(); return; }
  if (f === 'description') { st.w.description = el.value; touched(); return; }
  const s = stepAt(el.dataset.fp), v = el.value.trim();
  let ok = true;
  const num = (x, lo, hi) => { const n = Number(String(x).replace(',', '.')); return x !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  switch (f) {
    case 'len': {
      if (s.dist != null) { const n = num(v, 0.05, 100); ok = n != null; if (ok) s.dist = Math.round(n * 1000); }
      else { const n = parseDur(v); ok = n >= 5 && n <= 6 * 3600; if (ok) s.dur = n; }
      break;
    }
    case 'pct': { const n = num(v, 1, 300); ok = n != null; if (ok) s.power = n / 100; break; }
    case 'from': case 'to': { const n = num(v, 1, 300); ok = n != null; if (ok) s[f] = n / 100; break; }
    case 'watts': { const n = num(v, 10, 2000); ok = n != null; if (ok) s.watts = Math.round(n); break; }
    case 'grade': { const n = num(v, -10, 25); ok = n != null; if (ok) s.grade = n; break; }
    case 'repeat': { const n = num(v, 1, 50); ok = n != null && Number.isInteger(n); if (ok) s.repeat = n; break; }
    case 'cadence': ok = v === '' || /^\d{2,3}\s*(-\s*\d{2,3}|\+)?$/.test(v); if (ok) { if (v === '') delete s.cadence; else s.cadence = /^\d+$/.test(v) ? +v : v.replace(/\s+/g, ''); } break;
    case 'label': case 'text': if (v) s[f] = el.value; else delete s[f]; break;
    case 'messages': { const r = parseMessageLines(el.value); ok = !r.bad.length; if (ok) { if (r.messages.length) s.messages = r.messages; else delete s.messages; } break; }
  }
  el.classList.toggle('bad', !ok);
  touched();
  if (ok) { refreshReadouts(); renderTimeline(); }
}

function onChange(e) {
  const el = e.target, f = el.dataset.f;
  if (f === 'len' && !el.classList.contains('bad')) {
    const s = stepAt(el.dataset.fp);
    el.value = s.dist != null ? +(s.dist / 1000).toFixed(2) : fmtDur(s.dur);
  }
  if (f === 'type') { setType(stepAt(el.dataset.fp), el.value); touched(); renderSteps(); renderTimeline(); focusRow(el.dataset.fp, '[data-f="type"]'); }
}

function setType(s, t) {
  const ftp = D.ftp();
  const f = typeOf(s) === 'ramp' ? (s.from + s.to) / 2 : s.watts != null ? s.watts / ftp : s.power ?? 0.75;
  for (const k of ['power', 'from', 'to', 'watts', 'grade', 'free']) delete s[k];
  if (t === 'steady') s.power = Math.round(f * 100) / 100;
  if (t === 'ramp') { s.from = Math.round(Math.max(0.3, f - 0.15) * 100) / 100; s.to = Math.round((f + 0.15) * 100) / 100; }
  if (t === 'watts') s.watts = Math.round(f * ftp);
  if (t === 'grade') s.grade = 3;
  if (t === 'free') s.free = true;
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tile) { if (e.detail === 0) addTile(b.dataset.tile); return; } // keyboard; pointer taps go through end()
  if (b.dataset.unitp) { // min <-> km
    pushUndo();
    const p = b.dataset.unitp, s = stepAt(p);
    if (s.dist == null) { s.dist = 1000; delete s.dur; } else { s.dur = 300; delete s.dist; }
    touched(); renderSteps(); renderTimeline(); focusRow(p, '[data-f="len"]');
    return;
  }
  if (b.id === 'b-undo') return undo();
  if (b.dataset.kind) {
    st.kind = b.dataset.kind;
    $$('#b-kind button').forEach((x) => x.classList.toggle('on', x === b));
    D.placeInk($('#b-kind'), b);
    if (st.untouched) { st.w.steps = TEMPLATE[st.kind](); st.snap = JSON.stringify(st.w); st.sel = null; renderSteps(); renderTimeline(); }
    renderPalette();
    return;
  }
  if (b.dataset.addin) {
    pushUndo();
    const rep = stepAt(b.dataset.addin), last = rep.steps.at(-1);
    rep.steps.push(last && last.repeat == null ? clone(last) : P[st.kind === 'slope' ? 'flat' : 'steady']());
    return structural(`${b.dataset.addin}.${rep.steps.length - 1}`);
  }
  if (b.dataset.act) {
    pushUndo();
    const p = b.dataset.ap, [arr, i] = listOf(p), pre = parentOf(p), at = (j) => (pre ? `${pre}.${j}` : `${j}`);
    switch (b.dataset.act) {
      case 'up': if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; return structural(at(i - 1), '[data-act="up"]'); } return;
      case 'down': if (i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; return structural(at(i + 1), '[data-act="down"]'); } return;
      case 'dup': arr.splice(i + 1, 0, clone(arr[i])); return structural(at(i + 1));
      case 'del': removePath(p); st.sel = null; return structural(null);
    }
  }
  if (b.id === 'b-save' || b.id === 'b-ride') return save(b.id === 'b-ride');
  if (b.id === 'b-delete') return del();
  if (b.id === 'b-close') return closeBuilder();
}

function structural(sel, focusSel) {
  touched();
  st.sel = sel;
  renderSteps();
  renderTimeline();
  if (sel != null) {
    if (!reduced()) $$(`#b-tl [data-p="${sel}"]`).forEach((x) => x.classList.add('b-pop'));
    if (focusSel) $(`#b-steps [data-p="${sel}"] ${focusSel}`)?.focus({ preventScroll: true });
  }
}
function focusRow(p, q) { $(`#b-steps [data-p="${p}"] ${q}`)?.focus({ preventScroll: true }); }

// ---------------------------------------------------------------- save / delete
async function save(ride) {
  if ($$('#builder .b-in.bad').length) return showProblems(['Fix the fields in red first.']);
  const w = cleanWorkout({ ...st.w, id: st.w.id || newMineId(st.w.name) });
  const probs = workoutProblems(w);
  if (probs.length) return showProblems(probs);
  showProblems([]);
  st.w.id = w.id;
  st.snap = JSON.stringify(st.w);
  st.isNew = false; st.mine = true;
  const btns = $$('#builder .b-foot button');
  btns.forEach((x) => (x.disabled = true));
  $('#b-save').textContent = 'Saving...';
  try { await D.onSave(w); } finally { btns.forEach((x) => (x.disabled = false)); $('#b-save').textContent = 'Save'; }
  $('#builder').classList.add('hidden');
  st = null;
  if (ride) D.onRide(w.id);
}
function showProblems(list) {
  const box = $('#b-problems');
  box.innerHTML = list.map((x) => `<div>${D.esc(x)}</div>`).join('');
  box.classList.toggle('hidden', !list.length);
  if (list.length) box.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
}
async function del() {
  const id = st.w.id;
  const when = D.plannedOn(id);
  if (!(await D.ask(when.length ? `It's in your plan on ${when.join(', ')}. Those days will show no workout.` : 'It goes away on every device.', { title: `Delete "${st.w.name}"?`, ok: 'Delete', danger: true }))) return;
  await D.onDelete(id);
  $('#builder').classList.add('hidden');
  st = null;
}
