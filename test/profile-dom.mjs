// The profile readout (bindProfileHover in js/profile.js) against a fake document: which stretch the mouse or a finger
// is on, the highlight, the text, where it sits, and how it comes and goes. The smoke test checks it in Chrome too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const root = path.resolve(new URL('..', import.meta.url).pathname);
const W = (id) => JSON.parse(fs.readFileSync(path.join(root, 'workouts', `${id}.json`), 'utf8'));

// ---- a fake document: just what bindProfileHover touches
const classes = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) }; };
const docListeners = { pointerdown: new Set() };
let hoverNone = false;
globalThis.matchMedia = (q) => ({ matches: q === '(hover: none)' && hoverNone });
globalThis.document = {
  createElement: () => {
    const el = { className: '', attrs: {}, style: {}, offsetWidth: 120, writes: 0, _html: '' };
    el.setAttribute = (k, v) => (el.attrs[k] = v);
    Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el.writes++; el._html = v; } });
    return el;
  },
  addEventListener: (t, f) => docListeners[t].add(f),
  removeEventListener: (t, f) => docListeners[t].delete(f),
};
const { bindProfileHover } = await import('../js/profile.js');

/** A chart box like the app draws: a .profile svg with `k` shapes, box and svg `width` px wide from x = 100. */
function chart(k, width = 1000) {
  const L = {};
  const svg = { classList: classes(), getBoundingClientRect: () => ({ left: 100, width }) };
  const shapes = Array.from({ length: k }, (_, i) => ({ dataset: { i: String(i) }, classList: classes(), closest: function () { return this; } }));
  svg.querySelectorAll = (sel) => (sel === '[data-i]' ? shapes : shapes.filter((s) => s.classList.contains('on')));
  svg.contains = (el) => shapes.includes(el) || el === svg;
  svg.closest = () => null;
  const box = {
    classList: classes(), kids: [], isConnected: true,
    getBoundingClientRect: () => ({ left: 100, width }),
    querySelector: (sel) => (sel === '.profile' ? svg : null),
    append: (el) => box.kids.push(el),
    addEventListener: (t, f) => (L[t] = f),
    contains: (el) => el === box || el === svg || shapes.includes(el) || box.kids.includes(el),
  };
  const fire = (t, e) => L[t](e);
  const on = () => shapes.filter((s) => s.classList.contains('on')).map((s) => +s.dataset.i);
  return { box, svg, shapes, L, fire, on, tip: () => box.kids[0], hov: () => box.classList.contains('hov') };
}
const look = { ftp: 200, zoneHex: () => '#z', gradeHex: () => '#g' };
const two = { steps: [{ dur: 600, power: 0.5, label: 'Easy' }, { dur: 600, power: 1.0, label: 'Hard', cadence: '90' }] };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();

// ---- nothing to bind
bindProfileHover(null, two, look);
const empty = chart(0);
bindProfileHover(empty.box, { steps: [] }, look);
assert.equal(empty.box.kids.length, 0, 'no steps: no readout, no listeners');
assert.deepEqual(Object.keys(empty.L), []);
ok('no chart or no steps: nothing bound');

// ---- mouse: only over a shape, centred over it, rewritten only when the stretch changes
{
  const c = chart(2), before = docListeners.pointerdown.size;
  bindProfileHover(c.box, two, look);
  const tip = c.tip();
  assert.equal(tip.className, 'prof-tip');
  assert.equal(tip.attrs.role, 'status');
  assert.deepEqual(Object.keys(c.L).sort(), ['pointerdown', 'pointerleave', 'pointermove'], 'hover devices: no click fallback');
  assert.equal(docListeners.pointerdown.size, before + 1, 'one document listener for taps elsewhere');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 700, target: c.shapes[1] });
  assert.ok(c.hov());
  assert.deepEqual(c.on(), [1]);
  assert.equal(text(tip.innerHTML), 'Hard 200 W 100% FTP 10:00 · 90 rpm 10:00 to 20:00');
  assert.equal(tip.style.left, '750px', 'centred over the stretch (x 600-1200 s of 1200 on a 1000 px chart)');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 1050, target: c.shapes[1] });
  assert.equal(tip.writes, 1, 'the same stretch: the text is not rewritten');
  assert.equal(tip.style.left, '750px');
  tip.offsetWidth = 600;
  c.fire('pointermove', { pointerType: 'pen', clientX: 300, target: c.shapes[0] });
  assert.deepEqual(c.on(), [0]);
  assert.match(text(tip.innerHTML), /^Easy 100 W 50% FTP 10:00 0:00 to 10:00$/);
  assert.equal(tip.style.left, '300px', 'kept inside the chart: its centre at least half its width from the edge');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 300, target: c.svg });
  assert.ok(!c.hov() && !c.on().length, 'the empty space above the curve hides it');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 700, target: { closest: () => ({ dataset: { i: '1' } }) } });
  assert.ok(!c.hov(), 'a data-i outside this chart (a library row) does not count');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 700, target: {} });
  assert.ok(!c.hov(), 'a target without closest()');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 700, target: c.shapes[1] });
  assert.equal(tip.writes, 3, 'back after hiding: written again');
  c.fire('pointerleave', { pointerType: 'mouse' });
  assert.ok(!c.hov() && !c.on().length, 'the mouse leaving hides it');
  ok('mouse: a shape under the pointer, highlighted, its readout centred and kept inside, hidden off the curve and when leaving');
}

// ---- finger: the whole column, kept after it lifts, gone on a tap elsewhere; click fallback on hover: none
{
  hoverNone = true;
  const c = chart(2);
  bindProfileHover(c.box, two, look);
  hoverNone = false;
  assert.ok(c.L.click, 'touch screens: the click fallback (iOS web views)');
  c.fire('pointerdown', { pointerType: 'touch', clientX: 150, target: c.svg });
  assert.deepEqual(c.on(), [0], 'anywhere in the column, even off the curve');
  c.fire('pointerdown', { pointerType: 'touch', clientX: 2000, target: c.svg });
  assert.deepEqual(c.on(), [1], 'past the right edge: the last stretch');
  c.fire('pointerdown', { pointerType: 'touch', clientX: 0, target: c.svg });
  assert.deepEqual(c.on(), [0], 'past the left edge: the first');
  c.fire('pointerleave', { pointerType: 'touch' });
  assert.ok(c.hov(), 'a finger lifting keeps the readout');
  for (const f of docListeners.pointerdown) f({ target: c.shapes[0] });
  assert.ok(c.hov(), 'a tap on the chart is not elsewhere');
  for (const f of docListeners.pointerdown) f({ target: {} });
  assert.ok(!c.hov() && !c.on().length, 'a tap elsewhere hides it');
  c.fire('click', { clientX: 900 });
  assert.deepEqual(c.on(), [1], 'a click counts as a tap');
  c.fire('pointerdown', { pointerType: '', clientX: 150, target: c.svg });
  assert.deepEqual(c.on(), [0], 'an unknown pointer is treated as a finger');
  const n0 = docListeners.pointerdown.size;
  c.box.isConnected = false;
  for (const f of [...docListeners.pointerdown]) f({ target: {} });
  assert.ok(docListeners.pointerdown.size < n0, 'a chart no longer on the page drops its document listener');
  ok('finger: the whole column counts, clamped, kept after lifting, hidden by a tap elsewhere; click fallback; listener dropped with the chart');
}

// ---- the rider's FTP, a real climb's preview, a road by distance
{
  const c = chart(2);
  bindProfileHover(c.box, { steps: [{ dur: 600, watts: 150, label: 'Steady' }, { dur: 600, power: 1 }] }, { ...look, ftp: 300 });
  c.fire('pointermove', { pointerType: 'mouse', clientX: 300, target: c.shapes[0] });
  assert.match(text(c.tip().innerHTML), /^Steady 150 W 50% FTP/, 'watts steps at the look\'s FTP');
  c.fire('pointermove', { pointerType: 'mouse', clientX: 700, target: c.shapes[1] });
  assert.match(text(c.tip().innerHTML), / 300 W 100% FTP /, 'power steps too');

  const climb = W('climb-el-durazno'), lead = climb.profile.lead.length;
  const { flatten, track } = await import('../js/engine/workout.js');
  const segs = flatten({ ...climb, steps: climb.steps.slice(lead) }, 200), tr = track(segs);
  const r = chart(segs.length);
  bindProfileHover(r.box, climb, look);
  r.fire('pointerdown', { pointerType: 'touch', clientX: 101, target: r.svg });
  assert.deepEqual(r.on(), [0]);
  assert.ok(text(r.tip().innerHTML).startsWith(`${segs[0].label} ${+(segs[0].grade * 100).toFixed(1)}% grade`), 'the first stretch of the climb, not the warm-up');
  // a finger over the middle of the road: the stretch holding the middle by distance
  const k = tr.parts.findIndex((p) => 0.5 * tr.D >= p.d0 && 0.5 * tr.D < p.d1);
  r.fire('pointerdown', { pointerType: 'touch', clientX: 600, target: r.svg });
  assert.deepEqual(r.on(), [k], 'by distance on a road');
  const m = Math.round(tr.parts[k].h1 - tr.parts[k].h0);
  assert.ok(m > 0, 'the middle of El Durazno climbs');
  assert.ok(r.tip().innerHTML.includes(`<span>+${m} m</span>`), 'its height gained');
  const mid = (tr.parts[k].d0 + tr.parts[k].d1) / 2 / tr.D * 1000;
  assert.equal(r.tip().style.left, `${Math.min(Math.max(mid, 60), 940)}px`, 'centred by distance');
  ok('the look\'s FTP, a real climb read without its warm-up, a road by distance with its height');
}

console.log(`profile (DOM part): ${n} tests passed`);
