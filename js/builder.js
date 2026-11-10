// Workout builder: a panel to create and edit workouts (ERG, slope or both) with a live profile.
// Saving goes through deps.onSave (app.js stores it in rodillo-data workouts/mine.json).
import { flatten } from './engine/workout.js?v=202611102147';
import { parseDur, fmtDur, workoutProblems, cleanWorkout, newMineId } from './mine.js?v=202611102147';

let D = null;   // deps from app.js
let st = null;  // { w, isNew, mine, snap, kind, sel, untouched }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- presets
const P = {
  warmup: () => ({ dur: 600, from: 0.45, to: 0.7, label: 'Warm-up' }),
  steady: () => ({ dur: 600, power: 0.75 }),
  ramp: () => ({ dur: 300, from: 0.6, to: 0.9 }),
  intervals: () => ({ repeat: 5, steps: [{ dur: 240, power: 1.1 }, { dur: 240, power: 0.5 }] }),
  cooldown: () => ({ dur: 300, from: 0.6, to: 0.4, label: 'Cool-down' }),
  climb: () => ({ dur: 300, grade: 6 }),
  climbKm: () => ({ dist: 1500, grade: 6 }),
  flat: () => ({ dur: 180, grade: 0 }),
  free: () => ({ dur: 300, free: true }),
  repeat: () => ({ repeat: 3, steps: [{ dur: 300, grade: 6 }, { dur: 180, grade: 0 }] }),
};
const ADD = {
  erg: [['warmup', 'Warm-up'], ['steady', 'Steady'], ['ramp', 'Ramp'], ['intervals', 'Intervals'], ['cooldown', 'Cool-down']],
  slope: [['climb', 'Climb'], ['climbKm', 'Climb by km'], ['flat', 'Flat'], ['free', 'Free ride'], ['repeat', 'Repeat']],
};
const TEMPLATE = {
  erg: () => [P.warmup(), { dur: 1200, power: 0.75 }, P.cooldown()],
  slope: () => [{ dur: 600, grade: 1, label: 'Warm-up roll' }, P.repeat(), { dur: 300, grade: 0, label: 'Cool-down' }],
};
const TYPES = [['steady', 'Steady'], ['ramp', 'Ramp'], ['watts', 'Watts'], ['grade', 'Grade'], ['free', 'Free ride']];
const typeOf = (s) => (s.repeat != null ? 'repeat' : s.free ? 'free' : s.grade != null ? 'grade' : s.watts != null ? 'watts' : s.from != null ? 'ramp' : 'steady');

const ICON = {
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  del: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const ACT_LABEL = { up: 'Move up', down: 'Move down', dup: 'Duplicate', del: 'Delete' };

// ---------------------------------------------------------------- paths ("2" or "2.1": indexes into steps arrays)
const parts = (p) => String(p).split('.').map(Number);
function listOf(p) { // the array holding step p, and its index
  const ix = parts(p);
  let arr = st.w.steps;
  for (const i of ix.slice(0, -1)) arr = arr[i].steps;
  return [arr, ix.at(-1)];
}
const stepAt = (p) => { const [a, i] = listOf(p); return a[i]; };
const inSel = (p) => st.sel != null && (p === st.sel || p.startsWith(st.sel + '.'));
/** Path of the step behind each flattened segment, in flatten()'s order. */
function segPaths() {
  const out = [];
  const walk = (steps, pre) => steps.forEach((s, i) => {
    const p = pre ? `${pre}.${i}` : `${i}`;
    if (s.repeat != null) { for (let r = 0; r < s.repeat; r++) walk(s.steps, p); } else out.push(p);
  });
  walk(st.w.steps, '');
  return out;
}

// ---------------------------------------------------------------- public
export function initBuilder(deps) {
  D = deps;
  const panel = $('#builder');
  panel.addEventListener('input', onInput);
  panel.addEventListener('change', onChange);
  panel.addEventListener('click', onClick);
  panel.addEventListener('focusin', (e) => { const r = e.target.closest('#b-steps [data-p]'); if (r) select(r.dataset.p); });
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
  st = { w: work, isNew: !w || !mine, mine, kind: w ? (allSim ? 'slope' : 'erg') : kind, sel: null, untouched: !w };
  st.snap = JSON.stringify(work);
  render();
  $$('.panel').forEach((p) => p.classList.add('hidden'));
  $('#builder').classList.remove('hidden');
  $('#builder').scrollTop = 0;
  if (!w) setTimeout(() => $('#b-name')?.focus({ preventScroll: true }), 60);
}
const stripUi = (w) => { const { _source, updatedAt, ...rest } = w; return rest; };
const dirty = () => st && JSON.stringify(st.w) !== st.snap;

/** Close, asking first when there are unsaved changes. Resolves true when closed. */
export async function closeBuilder() {
  if (!st) return true;
  if (dirty() && !(await D.ask('Your changes to this workout will be lost.', { title: 'Discard changes?', ok: 'Discard', danger: true }))) return false;
  $('#builder').classList.add('hidden');
  st = null;
  return true;
}

// ---------------------------------------------------------------- render
function render() {
  const w = st.w;
  $('#builder-body').innerHTML = `
    <div class="b-top">
      <input id="b-name" class="b-name" data-f="name" placeholder="Workout name" value="${D.esc(w.name)}" autocomplete="off" enterkeyhint="done">
    </div>
    <div class="b-chart" id="b-chart"></div>
    <div class="b-steps" id="b-steps"></div>
    <div class="b-add">
      <div class="wo-kind seg-tg b-kind" id="b-kind" role="tablist" aria-label="Add steps for">
        <button data-kind="erg" role="tab" class="${st.kind === 'erg' ? 'on' : ''}">ERG</button><button data-kind="slope" role="tab" class="${st.kind === 'slope' ? 'on' : ''}">Slope</button>
      </div>
      <div class="b-add-btns" id="b-add-btns"></div>
    </div>
    <label class="b-lab" for="b-desc">Description</label>
    <textarea id="b-desc" class="b-desc" data-f="description" rows="3" placeholder="What the session is for and how it should feel">${D.esc(w.description)}</textarea>
    <div class="b-problems hidden" id="b-problems" role="alert"></div>`;
  $('#builder-title').textContent = st.isNew ? (w.basedOn ? 'Copy of a workout' : 'New workout') : 'Edit workout';
  $('#b-delete').classList.toggle('hidden', st.isNew);
  renderAdd();
  renderSteps();
  renderChart();
  requestAnimationFrame(() => D.placeInk($('#b-kind'), $('#b-kind button.on')));
}

function renderAdd() {
  $('#b-add-btns').innerHTML = ADD[st.kind].map(([k, t]) => `<button class="ghost small" data-add="${k}">+ ${t}</button>`).join('');
}

function acts(p) {
  return `<span class="b-acts">${['up', 'down', 'dup', 'del'].map((a) => `<button class="b-ico" data-act="${a}" data-ap="${p}" aria-label="${ACT_LABEL[a]}" title="${ACT_LABEL[a]}">${icon(a)}</button>`).join('')}</span>`;
}

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
      </div>
    </div>`;
  };
  $('#b-steps').innerHTML = st.w.steps.map((s, i) => row(s, `${i}`)).join('') || '<p class="muted b-empty">No steps yet. Add some below.</p>';
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
    const s = stepAt(el.dataset.sum);
    const segs = flatten({ steps: [s] }, ftp);
    el.textContent = segs.length ? `= ${segs.some((g) => g.estDur) ? '~' : ''}${fmtDur(segs.at(-1).end)}` : '';
  }
}

function renderChart() {
  const w = st.w, box = $('#b-chart');
  const segs = flatten(w, D.ftp());
  const total = segs.length ? segs.at(-1).end : 0;
  const cap = D.maxMinutes();
  box.innerHTML = `${D.profileSvg(w, 1000, 110)}
    <div class="b-meta"><span class="b-tot">${segs.length ? D.woMeta(w) : '0 min'}</span>${cap && total > cap * 60 ? `<span class="b-cap">Over the plan's ${cap}-min cap: the coach won't schedule it in this block.</span>` : ''}</div>`;
  const paths = segPaths();
  $$('[data-i]', box).forEach((el) => {
    el.style.cursor = 'pointer';
    if (st.sel != null) el.style.opacity = inSel(paths[+el.dataset.i]) ? '1' : '.35';
  });
}

function select(p) {
  if (st.sel === p) return;
  st.sel = p;
  $$('#b-steps [data-p]').forEach((x) => x.classList.toggle('sel', x.dataset.p === p));
  renderChart();
}

// ---------------------------------------------------------------- edits
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
  }
  el.classList.toggle('bad', !ok);
  touched();
  if (ok) { refreshReadouts(); renderChart(); }
}

function onChange(e) {
  const el = e.target, f = el.dataset.f;
  if (f === 'len' && !el.classList.contains('bad')) {
    const s = stepAt(el.dataset.fp);
    el.value = s.dist != null ? +(s.dist / 1000).toFixed(2) : fmtDur(s.dur);
  }
  if (f === 'type') { setType(stepAt(el.dataset.fp), el.value); touched(); renderSteps(); renderChart(); focusRow(el.dataset.fp, '[data-f="type"]'); }
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
  const r = e.target.closest('#b-steps [data-p]');
  if (r) select(r.dataset.p);
  const b = e.target.closest('button, [data-i]');
  if (!b) return;
  if (b.dataset.i !== undefined && b.closest('#b-chart')) { // bar in the chart: jump to its step
    const p = segPaths()[+b.dataset.i];
    select(p);
    const row = $(`#b-steps [data-p="${p}"]`);
    row?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row?.querySelector('[data-f="len"]')?.focus({ preventScroll: true });
    return;
  }
  if (b.dataset.unitp) { // min <-> km
    const p = b.dataset.unitp, s = stepAt(p);
    if (s.dist == null) { s.dist = 1000; delete s.dur; } else { s.dur = 300; delete s.dist; }
    touched(); renderSteps(); renderChart(); focusRow(p, '[data-f="len"]');
    return;
  }
  if (b.dataset.kind) {
    st.kind = b.dataset.kind;
    $$('#b-kind button').forEach((x) => x.classList.toggle('on', x === b));
    D.placeInk($('#b-kind'), b);
    if (st.untouched) { st.w.steps = TEMPLATE[st.kind](); st.snap = JSON.stringify(st.w); st.sel = null; renderSteps(); renderChart(); }
    renderAdd();
    return;
  }
  if (b.dataset.add) {
    const steps = st.w.steps, k = b.dataset.add, isCool = (x) => /cool/i.test(x?.label || '');
    // warm-up first, cool-down last; anything else after the selected block, or before the cool-down
    const top = k === 'warmup' ? 0 : k === 'cooldown' ? steps.length
      : st.sel != null ? parts(st.sel)[0] + 1 : steps.length - (isCool(steps.at(-1)) ? 1 : 0);
    st.w.steps.splice(top, 0, P[b.dataset.add]());
    return structural(`${top}`);
  }
  if (b.dataset.addin) {
    const rep = stepAt(b.dataset.addin), last = rep.steps.at(-1);
    rep.steps.push(last && last.repeat == null ? clone(last) : P[st.kind === 'slope' ? 'flat' : 'steady']());
    return structural(`${b.dataset.addin}.${rep.steps.length - 1}`);
  }
  if (b.dataset.act) {
    const p = b.dataset.ap, [arr, i] = listOf(p), pre = parts(p).slice(0, -1).join('.'), at = (j) => (pre ? `${pre}.${j}` : `${j}`);
    switch (b.dataset.act) {
      case 'up': if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; return structural(at(i - 1), `[data-act="up"]`); } return;
      case 'down': if (i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; return structural(at(i + 1), `[data-act="down"]`); } return;
      case 'dup': arr.splice(i + 1, 0, clone(arr[i])); return structural(at(i + 1));
      case 'del': {
        arr.splice(i, 1);
        if (pre && !arr.length) listOf(pre)[0].splice(parts(pre).at(-1), 1); // emptied a repeat: drop it
        st.sel = null;
        return structural(null);
      }
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
  renderChart();
  if (sel != null) {
    const row = $(`#b-steps [data-p="${sel}"]`);
    if (row) {
      row.classList.add('sel', 'b-flash');
      setTimeout(() => row.classList.remove('b-flash'), 700);
      row.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      if (focusSel) row.querySelector(focusSel)?.focus({ preventScroll: true });
    }
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
  if (list.length) box.scrollIntoView({ block: 'nearest' });
}
async function del() {
  const id = st.w.id;
  const when = D.plannedOn(id);
  if (!(await D.ask(when.length ? `It's in your plan on ${when.join(', ')}. Those days will show no workout.` : 'It goes away on every device.', { title: `Delete "${st.w.name}"?`, ok: 'Delete', danger: true }))) return;
  await D.onDelete(id);
  $('#builder').classList.add('hidden');
  st = null;
}
