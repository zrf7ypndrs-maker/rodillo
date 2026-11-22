// js/ridephone.js, the DOM and canvas part: renderPhone() (through renderRide() in js/ride.js, as on the bike) on a
// real Session (engine + demo trainer), the phone chart drawn into a recording canvas context, chart vs list view,
// the buttons, the ··· sheet and its hold buttons (through js/controls.js). Fake document, clock (setTimeout /
// setInterval / Date.now), localStorage and Web Animations; Math.random seeded. The browser version is the phone ride
// run in test/smoke.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ---- fake clock
const clock = { t: Date.parse('2026-11-19T18:00:00'), timers: [], id: 0 };
const addTimer = (f, ms, every) => { const id = ++clock.id; clock.timers.push({ id, at: clock.t + (ms || 0), f, every }); return id; };
globalThis.setTimeout = (f, ms) => addTimer(f, ms, 0);
globalThis.setInterval = (f, ms) => addTimer(f, ms, ms);
globalThis.clearTimeout = globalThis.clearInterval = (id) => { clock.timers = clock.timers.filter((x) => x.id !== id); };
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock.t])); } static now() { return clock.t; } };
const advance = (ms) => {
  const end = clock.t + ms;
  for (;;) {
    const next = clock.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!next) break;
    clock.t = next.at;
    if (next.every) next.at += next.every; else clock.timers = clock.timers.filter((x) => x !== next);
    next.f();
  }
  clock.t = end;
};
let seed = 11; // mulberry32: the demo trainer's noise
Math.random = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---- recording canvas context: method calls and property sets, in order
function fakeCtx() {
  const calls = [], props = {};
  return new Proxy({}, {
    get(_, k) {
      if (k === 'calls') return calls;
      if (k === 'measureText') return (t) => ({ width: String(t).length * 7 });
      if (k === 'createLinearGradient') return (...a) => { const g = { a, stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; calls.push(['createLinearGradient', g]); return g; };
      if (k in props) return props[k];
      return (...a) => calls.push([k, ...a]);
    },
    set(_, k, v) { props[k] = v; calls.push([`=${k}`, v]); return true; },
  });
}

// ---- fake DOM: any selector gives one element, made on first use; innerHTML writes are counted
class El {
  constructor(sel) {
    this.sel = sel; this.cls = new Set(); this.textContent = ''; this.html = ''; this.writes = 0; this.children = []; this.listeners = {};
    this.scrolls = []; this.offsetWidth = 300; this.offsetHeight = 40; this.offsetTop = 0; this.clientHeight = 200; this.scrollTop = 0;
    this.width = 0; this.height = 0; this.rect = { left: 0, top: 0, right: 350, bottom: 180, width: 350, height: 180 };
    this.attrs = {}; this.dataset = {}; this.tagName = 'DIV';
    this.style = { props: {}, setProperty: (k, v) => { this.style.props[k] = v; }, removeProperty: (k) => { delete this.style.props[k]; } };
    this.classList = {
      add: (...c) => c.forEach((x) => this.cls.add(x)), remove: (...c) => c.forEach((x) => this.cls.delete(x)),
      contains: (c) => this.cls.has(c), toggle: (c, on) => ((on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c)),
    };
    this.firstElementChild = sel === '#r-int-bar' ? new El('bar-fill') : null;
    if (sel === '#r-chart' || sel === '#rp-chart') this.ctx = fakeCtx();
  }
  get innerHTML() { return this.html; }
  set innerHTML(h) { this.html = String(h); this.writes++; } // the browser keeps a string
  get parentElement() { return this.sel === '#rp-m3' ? $('#rp-m3 box') : this.sel === '#rp-chart' ? $('#rp-chart box') : null; }
  get lastElementChild() { return this.sel === '#rp-segs' && this.html ? new El('last row') : null; }
  getContext() { return this.ctx; }
  getBoundingClientRect() { return this.rect; }
  querySelector(s) {
    if (s === 'b') return (this.b ||= new El(`${this.sel} b`));
    if (s === '.seg.current') { // the current row, 40 px per row
      const rows = this.html.match(ROW) || [], i = rows.findIndex((r) => / current"$/.test(r));
      if (i < 0) return null;
      const row = new El('.seg.current'); row.offsetTop = i * 40; return row;
    }
    return null;
  }
  querySelectorAll() { return []; }
  closest(s) { return s === 'button' && this.tagName === 'BUTTON' ? this : null; }
  addEventListener(type, f, o) { (this.listeners[type] ||= []).push({ f, o }); }
  fire(type, e = {}) { const ev = { type, prevented: 0, preventDefault() { this.prevented++; }, ...e }; (this.listeners[type] || []).forEach((l) => l.f(ev)); return ev; }
  scrollTo(o) { this.scrolls.push(o); }
  cloneNode() { const c = new El(`${this.sel} copy`); c.cls = new Set(this.cls); c.html = this.html; return c; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); c.parent = this; }
  remove() { this.removed = true; }
  animate() { const a = { finished: new Promise(() => {}), cancel() {}, finish() {} }; return a; }
  blur() {}
}
const ROW = /<div class="seg( erg)? (done|current|todo)"/g; // a row of the interval list (not its inner divs)
const els = {};
const $ = (sel) => (els[sel] ||= new El(sel));
const viewBtn = (view) => { const b = new El(`view ${view}`); b.tagName = 'BUTTON'; b.dataset.view = view; return b; };
$('#rp-view-tg').children = [viewBtn('chart'), viewBtn('list')];
const store = new Map();
const docListeners = {};
Object.assign(globalThis, {
  document: { querySelector: $, querySelectorAll: () => [], getElementById: (id) => $(`#${id}`), addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); } },
  window: { addEventListener: () => {} },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  devicePixelRatio: 2, innerWidth: 390, innerHeight: 844,
  matchMedia: () => ({ matches: false }),
  ResizeObserver: class { constructor(f) { this.f = f; ResizeObserver.all.push(this); } observe(el) { this.el = el; } },
});
ResizeObserver.all = [];

const { initRide, renderRide, smoothPower, smoothHr, trackProgress, workoutLeft } = await import('../js/ride.js');
const { initControls } = await import('../js/controls.js');
const { initRidePhone, renderPhone, drawPhoneChart, sizePhoneChart, phoneSlices } = await import('../js/ridephone.js');
const { Session, DEFAULT_SETTINGS } = await import('../js/engine/session.js');
const { SimTrainer, SimHr } = await import('../js/ble/sim.js');
const { segTarget } = await import('../js/engine/workout.js');
const { fmtTime } = await import('../js/ridepage.js');

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const W = (id) => JSON.parse(fs.readFileSync(new URL(`../workouts/${id}.json`, import.meta.url)));
const log = [];
const phone = { on: true };
const app = { screen: 'ride', settings: { ...DEFAULT_SETTINGS, ftp: 200 }, demo: true, controllers: [], rows: [], session: null, theme: 'light' };
const look = () => ({ INK: 'ink', MUTED: 'muted', RULE: 'rule', FTP_LINE: 'ftpline', HR_LINE: 'hrline', TOK: { sheet: 'sheet' } });
const zoneHex = (f) => `#z${Math.round(f * 100)}`, gradeHex = (g) => `#g${Math.round(g * 100)}`;
const setZc = (el, c) => el.style.setProperty('--zc', c);
initRide({
  app, isPhone: () => phone.on, renderPhone, setDevPop: (x) => log.push(`setDevPop ${x}`), look, zoneHex, gradeHex,
  setZc, NUM_FONT: 'Archivo',
});
initControls({
  app, modalOpen: () => false, devPopOpen: () => false, setDevPop: () => {}, setTab: () => {}, TABS: ['today'], startWorkout: () => {},
  rideAction: () => {}, modalAction: () => {}, renderRide, tooShort: () => (app.session?.samples.length || 0) < 10, endSession: () => { log.push('endSession'); app.session = null; },
});
store.set('rodillo.phoneView', JSON.stringify('list')); // remembered from the last ride
initRidePhone({ app, isPhone: () => phone.on, look, zoneHex, gradeHex, setZc, setTheme: (t) => { log.push(`setTheme ${t}`); app.theme = t; }, NUM_FONT: 'Archivo' });
const canvas = $('#rp-chart'), ctx = canvas.ctx;

/** A demo ride like enterDemo() + beginSession(): the demo trainer and HR, ridden with 4 Hz ticks. */
function begin(workout) {
  const trainer = new SimTrainer({ realDev: 5.2, trainerMass: 78 }), hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: app.settings, ...(workout ? { workout } : {}) });
  app.session = s; app.hr = hr; app.trainer = trainer; app._rpSegI = undefined;
  return s;
}
function pedal(sec) {
  const s = app.session;
  for (let i = 0; i < sec * 4; i++) { s.trainer.step(); app.hr.step(0.25); s.tick(0.25); advance(250); renderRide(); }
}
const html = (id) => $(`#${id}`).innerHTML;
const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&minus;/g, '−').replace(/&#9650;/g, '▲').replace(/&#9660;/g, '▼');
const hidden = (id) => $(`#${id}`).cls.has('hidden');
const calls = (k) => ctx.calls.filter((c) => c[0] === k);
const texts = () => calls('fillText').map((c) => c[1]);
const draw = () => { ctx.calls.length = 0; drawPhoneChart(); };
const tap = (id) => $(`#${id}`).onclick({ preventDefault() { tap.prevented++; } });
tap.prevented = 0;

// ---- wiring
{
  assert.equal(app.phoneView, 'list');
  const ro = ResizeObserver.all.find((o) => o.el === $('#rp-chart box'));
  assert.ok(ro, 'the phone chart box is observed');
  for (const id of ['rp-minus', 'rp-plus', 'rp-pause', 'rp-more', 'rp-sheet-close', 'rp-gdown', 'rp-gup', 'rp-lap', 'rp-erg', 'rp-theme']) assert.equal(typeof $(`#${id}`).onclick, 'function', id);
  assert.equal(typeof $('#rp-view-tg').onclick, 'function');
  for (const id of ['rp-skip', 'rp-end']) {
    assert.deepEqual(Object.keys($(`#${id}`).listeners).sort(), ['click', 'contextmenu', 'pointercancel', 'pointerdown', 'pointerleave', 'pointerup', 'touchcancel', 'touchend', 'touchstart']);
    assert.deepEqual($(`#${id}`).listeners.touchstart[0].o, { passive: false }); // so preventDefault works on iOS
  }
  // the chart's size follows its box, in device pixels, at least 200 x 60
  $('#rp-chart box').rect = { width: 350, height: 180 };
  sizePhoneChart();
  assert.deepEqual([canvas.width, canvas.height], [700, 360]);
  $('#rp-chart box').rect = { width: 40.3, height: 10 };
  sizePhoneChart();
  assert.deepEqual([canvas.width, canvas.height], [200, 60]);
  $('#rp-chart box').rect = { width: 350.3, height: 180.2 };
  sizePhoneChart();
  assert.deepEqual([canvas.width, canvas.height], [701, 360]);
  // a resize redraws only on the phone ride screen
  app.session = null; ctx.calls.length = 0;
  ro.f(); assert.equal(ctx.calls.length, 0); // no session: nothing to draw
  ok('wiring: the list / chart choice read back, the chart box observed, the buttons, both hold buttons, chart size in device pixels');
}

// ---- ERG workout, chart view
app.phoneView = 'chart';
{
  const s = begin(W('sweetspot-3x12'));
  pedal(20);
  assert.ok(s.started && s.samples.length > 10);
  assert.equal(html('rp-elapsed'), fmtTime(s.elapsed));
  assert.equal(html('rp-name'), 'Sweet spot 3 x 12');
  assert.deepEqual([html('rp-left-k'), html('rp-left')], ['Left', workoutLeft(s)]);
  assert.equal(html('rp-int-label'), 'Warm-up');
  assert.equal(html('rp-count'), fmtTime(s.segRemaining.sec));
  assert.equal(html('rp-target'), `${s.target} W`);
  assert.equal(html('rp-target-sub'), `${Math.round(segTarget(s.seg, s.segProgress) * 100)}% FTP`);
  assert.equal($('#rp').style.props['--zc'], zoneHex(segTarget(s.seg, s.segProgress)));
  const p = Math.round(s.powerShown);
  assert.equal(html('rp-power'), String(p));
  assert.ok(!$('#rp-gauge').cls.has('off'));
  assert.equal($('#rp-gauge').querySelector('b').style.left, `${Math.max(0, Math.min(1, (p / s.target - 0.8) / 0.4)) * 100}%`);
  assert.ok(!$('#rp-power-box').cls.has('ok') && !$('#rp-power-box').cls.has('bad'));
  assert.equal(html('rp-power-sub'), '');
  assert.equal(html('rp-hr'), String(Math.round(app.hr.bpm)));
  assert.equal(html('rp-cad'), String(Math.round(s.trainer.data.cadence)));
  assert.equal(html('rp-cad-sub'), '');
  assert.deepEqual([html('rp-m3-k'), html('rp-m3'), html('rp-m3-sub')], ['Effort', '100%', 'as planned']);
  assert.ok(!$('#rp-m3 box').cls.has('up') && !$('#rp-m3 box').cls.has('down'));
  assert.equal(strip(html('rp-next')), 'Next 12:00 @ 180 W · 90 rpm');
  assert.match(html('rp-next'), /background:#z90/);
  assert.deepEqual([strip(html('rp-minus')), html('rp-plus'), html('rp-pause')], ['−1%', '+1%', 'Pause']);
  assert.deepEqual(['rp-grade-row', 'rp-skip', 'rp-lap', 'rp-erg'].map(hidden), [true, false, true, false]);
  assert.equal(html('rp-erg'), 'ERG off');
  assert.ok(!$('#rp-wrap').cls.has('no-segs') && !$('#rp-wrap').cls.has('as-list'));
  assert.deepEqual($('#rp-view-tg').children.map((b) => b.cls.has('on')), [true, false]);
  assert.equal(html('rp-view-k'), 'Workout &middot; 0/8 done');
  assert.equal($('#rp-segs').writes, 0); // the list isn't built in chart view
  // a value is written only when it changes
  const w = $('#rp-name').writes, wk = $('#rp-view-k').writes;
  pedal(5);
  assert.equal($('#rp-name').writes, w);
  assert.equal($('#rp-view-k').writes, wk);
  ok('ERG ride: top line, hero (ramp, countdown, target, zone), power and gauge, HR, cadence, effort box, Next line, buttons, chart view');
}
{
  // the chart: zone blocks (a ramp in 3 px slices), the done part dimmed, the current block outlined, FTP line, power and HR, the marker
  const s = app.session;
  draw();
  const W0 = canvas.width, T = s.segs.at(-1).end, X = (t) => (t / T) * W0, dpr = 2;
  const slices = s.segs.reduce((a, g) => a + phoneSlices(g, X(g.start), X(g.end), dpr), 0);
  assert.equal(calls('fillRect').length, slices + 1); // + the marker's stem
  assert.ok(slices > 8); // the ramps are sliced
  const alphas = calls('=globalAlpha').map((c) => c[1]);
  assert.equal(alphas[0], 0.38); // the warm-up's first slice is ridden: dimmed
  assert.equal(alphas.filter((a) => a === 0.38).length, 1); // 20 s in: the warm-up is 111 px wide, 19 slices of 32 s; one behind the marker
  assert.equal(alphas.at(-2), 1); // the cool-down ahead: full strength (then back to 1 after the block)
  assert.equal(calls('strokeRect').length, 1);
  assert.ok(Math.abs(calls('strokeRect')[0][1] - (X(0) + 1.5)) < 1e-9);
  assert.deepEqual(texts(), ['FTP 200']);
  assert.deepEqual(calls('setLineDash').map((c) => c[1]), [[8, 8], []]);
  const hr = smoothHr(s.samples), runs = hr.filter((h, i) => h && !hr[i - 1]).length;
  assert.equal(calls('lineTo').length, 1 + (s.samples.length - 1) + (hr.filter(Boolean).length - runs) + 2); // FTP line, power, HR, the marker's triangle
  assert.equal(calls('stroke').length, 3);
  assert.ok(calls('=strokeStyle').some((c) => c[1] === 'ftpline') && calls('=strokeStyle').some((c) => c[1] === 'hrline'));
  assert.deepEqual(calls('fillRect').at(-1), ['fillRect', X(s.chartPos) - dpr, 14 * dpr - 4 * dpr, 2 * dpr, canvas.height - 2 * dpr - 14 * dpr + 4 * dpr]);
  assert.equal(calls('=font')[0][1], `600 ${11.5 * dpr}px Archivo`);
  // the power line is the smoothed power, against the plot: 130% FTP x 1.08 or more
  const sp = smoothPower(s.samples), bot = canvas.height - 2 * dpr, plotH = bot - 14 * dpr;
  const maxP = Math.max(1.3 * 1.08 * 200, ...s.samples.slice(-1800).map((x) => x.power + 10));
  const power = ctx.calls.findIndex((c) => c[0] === '=lineWidth' && c[1] === 1.8 * dpr);
  const mv = ctx.calls.slice(power).find((c) => c[0] === 'moveTo');
  assert.ok(Math.abs(mv[2] - (bot - (Math.min(sp[0], maxP) / maxP) * plotH)) < 1e-9);
  ok('ERG chart: zone blocks with sliced ramps, ridden part dimmed, current block outlined, FTP line, power and HR, the marker');
}
{
  // not on the phone, no session, or the list showing: nothing drawn
  phone.on = false; draw(); assert.equal(ctx.calls.length, 0); phone.on = true;
  const s = app.session; app.session = null; draw(); assert.equal(ctx.calls.length, 0); app.session = s;
  app.phoneView = 'list'; draw(); assert.equal(ctx.calls.length, 0); app.phoneView = 'chart';
  // a resize on the phone ride screen redraws
  ctx.calls.length = 0;
  ResizeObserver.all.find((o) => o.el === $('#rp-chart box')).f();
  assert.ok(ctx.calls.length > 0);
  app.screen = 'home'; ctx.calls.length = 0; ResizeObserver.all.find((o) => o.el === $('#rp-chart box')).f(); assert.equal(ctx.calls.length, 0); app.screen = 'ride';
  ok('phone chart: not drawn off the phone, without a session or in list view; redrawn on a resize of its box');
}

// ---- the buttons
{
  const s = app.session;
  tap('rp-plus');
  assert.equal(s.intensity, 1.01);
  assert.deepEqual([html('rp-m3'), html('rp-m3-sub')], ['101%', 'harder than plan']);
  assert.ok($('#rp-m3 box').cls.has('up'));
  assert.match(strip(html('rp-next')), /^Next 12:00 @ 182 W · 90 rpm$/);
  tap('rp-minus'); tap('rp-minus');
  assert.equal(s.intensity, 0.99);
  assert.deepEqual([html('rp-m3-sub'), $('#rp-m3 box').cls.has('down'), $('#rp-m3 box').cls.has('up')], ['easier than plan', true, false]);
  tap('rp-plus');
  assert.equal(tap.prevented, 4);
  // pause / resume, the pause screen's line for the phone
  tap('rp-pause');
  assert.ok(s.paused && html('rp-pause') === 'Resume' && !hidden('r-paused'));
  assert.equal($('#r-paused-sub').textContent, 'Tap Resume or press A');
  tap('rp-pause');
  assert.ok(!s.paused && html('rp-pause') === 'Pause' && hidden('r-paused'));
  // the sheet opens and closes
  $('#rp-sheet').cls.add('hidden');
  tap('rp-more'); assert.ok(!hidden('rp-sheet'));
  tap('rp-more'); assert.ok(hidden('rp-sheet'));
  tap('rp-more'); tap('rp-sheet-close'); assert.ok(hidden('rp-sheet'));
  // Lap in a workout: laps are automatic, the sheet closes
  tap('rp-more'); tap('rp-lap');
  assert.ok(hidden('rp-sheet') && $('#toast').textContent === 'Laps are automatic per interval');
  // ERG off: slope mode, gears and grade; then back on
  tap('rp-more'); tap('rp-erg');
  assert.ok(hidden('rp-sheet') && s.ergOff);
  pedal(1); // the trainer leaves ERG on the next tick
  assert.equal(s.mode, 'sim');
  assert.equal(html('rp-erg'), 'ERG back on');
  assert.equal(strip(html('rp-int-label')), 'Warm-up · ERG off');
  assert.deepEqual([html('rp-m3-k'), html('rp-m3'), strip(html('rp-minus')), html('rp-plus')], ['Gear', `${s.gb.front + 1}×${s.gb.rear + 1}`, 'Gear −', 'Gear +']);
  assert.equal(html('rp-m3-sub'), `${s.gb.ring}×${s.gb.cog} · ${Math.round(s.bike.v * 3.6)} km/h`);
  assert.ok(!hidden('rp-grade-row') && !hidden('rp-erg') && !$('#rp-m3 box').cls.has('down'));
  const rear = s.gb.rear;
  tap('rp-plus'); assert.equal(s.gb.rear, rear + 1);
  tap('rp-minus'); assert.equal(s.gb.rear, rear);
  tap('rp-gup'); assert.equal(Math.round(s.gradeOffset * 100), 1);
  tap('rp-gdown'); assert.equal(Math.round(s.gradeOffset * 100), 0);
  tap('rp-erg'); pedal(1);
  assert.ok(!s.ergOff && s.mode === 'erg' && html('rp-erg') === 'ERG off' && hidden('rp-grade-row'));
  // the theme switch
  tap('rp-more'); tap('rp-theme');
  assert.ok(hidden('rp-sheet') && app.theme === 'dark' && log.at(-1) === 'setTheme dark');
  tap('rp-theme'); assert.equal(app.theme, 'light');
  ok('buttons: effort ±1% (box up / down), pause / resume, the sheet, Lap in a workout, ERG off (gears, grade) and back, the theme');
}

// ---- the sheet's hold buttons: Skip 1 s, End 2 s; letting go early does nothing
{
  const s = app.session, skip = $('#rp-skip'), seg = s.segIndex;
  tap('rp-more');
  let e = skip.fire('pointerdown');
  assert.equal(e.prevented, 1);
  assert.ok(skip.cls.has('filling') && skip.style.props['--hold-ms'] === '1000ms');
  skip.fire('touchstart'); // Bluefy sends both: one hold
  advance(600);
  skip.fire('pointerup');
  advance(1000);
  assert.ok(!skip.cls.has('filling') && s.segIndex === seg && !hidden('rp-sheet'));
  for (const ev of ['pointercancel', 'pointerleave', 'touchend', 'touchcancel']) { // each one lets go
    skip.fire('touchstart'); advance(500); skip.fire(ev); advance(1000);
    assert.equal(s.segIndex, seg, ev);
  }
  skip.fire('pointerdown'); advance(1000);
  assert.equal(s.segIndex, seg + 1);
  assert.ok(hidden('rp-sheet') && $('#toast').textContent === 'Skipped' && !skip.cls.has('filling'));
  assert.equal(html('rp-int-label'), 'Sweet spot 1/3');
  skip.fire('pointerup');
  assert.equal(skip.fire('click').prevented, 1);
  assert.equal(skip.fire('contextmenu').prevented, 1);
  // End: let go after 1.5 s keeps riding, 2 s ends
  const end = $('#rp-end');
  end.fire('pointerdown'); assert.equal(end.style.props['--hold-ms'], '2000ms');
  advance(1500); end.fire('pointerup'); advance(1000);
  assert.ok(app.session === s && !log.includes('endSession'));
  end.fire('touchstart'); advance(2000);
  assert.ok(log.includes('endSession') && app.session === null);
  ok('sheet holds: Skip fills for 1 s (double start ignored, every let-go cancels), skips and closes; End 2 s ends, earlier keeps riding');
}

// ---- list view
{
  const s = begin(W('sweetspot-3x12'));
  pedal(8);
  const tg = $('#rp-view-tg'), [chartBtn, listBtn] = tg.children;
  let e = { target: listBtn, prevented: 0, preventDefault() { this.prevented++; } };
  tg.onclick(e);
  assert.equal(e.prevented, 1);
  assert.equal(app.phoneView, 'list');
  assert.equal(store.get('rodillo.phoneView'), '"list"');
  assert.ok($('#rp-wrap').cls.has('as-list'));
  assert.deepEqual(tg.children.map((b) => b.cls.has('on')), [false, true]);
  const rows = html('rp-segs').match(ROW);
  assert.equal(rows.length, 8);
  assert.match(rows[0], / current"$/);
  assert.deepEqual($('#rp-segs').scrolls, [{ top: 0, behavior: 'auto' }]); // just opened: no animation
  // same rows: not rebuilt, not scrolled again
  const w = $('#rp-segs').writes;
  renderPhone(s);
  ctx.calls.length = 0; drawPhoneChart(); assert.equal(ctx.calls.length, 0);
  // an interval change: rebuilt and scrolled smoothly, the current row centred (row 1 at 40 px, box 200, row 40)
  s.skip(); pedal(1);
  assert.ok($('#rp-segs').writes > w);
  assert.deepEqual($('#rp-segs').scrolls.at(-1), { top: 0, behavior: 'smooth' });
  s.skip(); s.skip(); s.skip(); pedal(1);
  assert.deepEqual($('#rp-segs').scrolls.at(-1), { top: 4 * 40 - (200 - 40) / 2, behavior: 'smooth' });
  assert.equal(html('rp-view-k'), 'Workout &middot; 4/8 done');
  // the same button again, a click off the buttons: nothing
  e = { target: listBtn, prevented: 0, preventDefault() { this.prevented++; } };
  tg.onclick(e); assert.equal(e.prevented, 0);
  tg.onclick({ target: new El('gap'), preventDefault() { throw new Error('no'); } });
  // back to the chart: sized and drawn right away, remembered
  ctx.calls.length = 0;
  tg.onclick({ target: chartBtn, preventDefault() {} });
  assert.equal(app.phoneView, 'chart');
  assert.equal(store.get('rodillo.phoneView'), '"chart"');
  assert.ok(!$('#rp-wrap').cls.has('as-list') && ctx.calls.length > 0);
  // off the ride screen the choice is kept, nothing drawn
  app.screen = 'home'; ctx.calls.length = 0;
  tg.onclick({ target: listBtn, preventDefault() {} });
  assert.equal(app.phoneView, 'list'); assert.equal(ctx.calls.length, 0);
  app.screen = 'ride';
  tg.onclick({ target: chartBtn, preventDefault() {} });
  // a workout that's over: every row done, the last row in view
  const sc = $('#rp-segs').scrolls.length;
  app.phoneView = 'list'; app._rpSegI = undefined;
  while (s.seg) s.skip();
  pedal(1);
  assert.equal(html('rp-view-k'), 'Workout &middot; 8/8 done');
  assert.ok($('#rp-segs').scrolls.length === sc + 1 && $('#rp-segs').scrolls.at(-1).behavior === 'auto');
  assert.deepEqual([html('rp-int-label'), html('rp-count'), html('rp-target'), html('rp-target-sub')], ['Workout complete', 'Done', '', 'Keep riding. End ride is in the menu.']);
  assert.equal($('#rp').style.props['--zc'], 'var(--ok-bg)');
  assert.deepEqual([html('rp-left'), html('rp-next')], ['0:00', `${(s.bike.v * 3.6).toFixed(1)} km/h &middot; ${s.bike.dist < 1000 ? `${Math.round(s.bike.dist)} m` : `${(s.bike.dist / 1000).toFixed(2)} km`}`]);
  assert.deepEqual(['rp-skip', 'rp-lap', 'rp-erg'].map(hidden), [true, false, true]);
  app.phoneView = 'chart';
  ok('list view: rows, current row, scrolled once then smoothly on a change, not rebuilt when unchanged; back to the chart; workout complete');
}

// ---- slope-only workout: the road; a slope step's power aim
{
  const s = begin(W('sim-climb-repeats'));
  pedal(10);
  assert.equal(s.mode, 'sim');
  assert.deepEqual([html('rp-int-label'), html('rp-target'), html('rp-target-sub')], ['Warm-up roll', '1%', 'grade, use your gears']);
  assert.equal($('#rp').style.props['--zc'], '#g1');
  assert.ok($('#rp-gauge').cls.has('off'));
  assert.equal(html('rp-view-k'), trackProgress(s));
  assert.equal(strip(html('rp-next')), 'Next 6:00 @ 6% · 85 rpm');
  // the road (js/ride.js drawTrack, compact): a filled piece per stretch (the one ridden into split), no km marks or
  // progress text (the label above says it), no blocks
  draw();
  assert.equal(calls('fill').length, s.segs.length + 1 + 1); // + the split stretch, + the dot
  assert.deepEqual(texts(), ['FTP 200']);
  assert.equal(calls('arc').length, 1);
  assert.equal(calls('strokeRect').length, 0);
  s.skip(); pedal(2);
  draw();
  assert.match(texts().join('|'), /^FTP 200\|(\d+ m|\d+\.\d\d km)\| · \+\d+ m$/); // the flag on the climb: what's left to the top, the phone's short tag
  assert.deepEqual([html('rp-target'), html('rp-target-sub'), html('rp-power-sub')], ['6%', 'grade, aim 200 W &middot; 85 rpm', '190-210 W']);
  assert.ok(!$('#rp-gauge').cls.has('off'));
  assert.equal($('#rp-gauge').querySelector('b').style.left, `${Math.max(0, Math.min(1, (Math.round(s.powerShown) / 200 - 0.8) / 0.4)) * 100}%`);
  pedal(12);
  assert.ok(s.aimStatus);
  const pb = $('#rp-power-box');
  assert.equal(pb.cls.has('ok'), s.aimStatus === 'ok');
  assert.equal(pb.cls.has('bad'), s.aimStatus !== 'ok');
  assert.equal(strip(html('rp-power-sub')), s.aimStatus === 'ok' ? '190-210 W' : s.aimStatus === 'low' ? '▲ push harder' : '▼ ease off');
  const cs = s.cadStatus, cb = $('#rp-cad-box');
  assert.deepEqual([cb.cls.has('ok'), cb.cls.has('bad')], [cs === 'ok', cs === 'low' || cs === 'high']);
  assert.equal(strip(html('rp-cad-sub')), cs === 'low' ? '▲ faster' : cs === 'high' ? '▼ slower' : '85 rpm');
  ok('slope workout: grade hero, road progress, the road drawn, the climb\'s aim on the gauge, power and cadence boxes');
}

// ---- a workout with ERG and slope steps: the slope step is a grade bar among the blocks, outlined when current
{
  const s = begin({ id: 'mixed', name: 'Mixed', steps: [{ dur: 60, power: 0.6 }, { dur: 120, grade: 4 }] });
  pedal(5); s.skip(); pedal(3);
  assert.equal(s.seg.kind, 'sim');
  draw();
  const dpr = 2, bot = canvas.height - 2 * dpr, plotH = bot - 14 * dpr;
  const y = bot - Math.max(4 * dpr, ((0.04 + 0.03) / 0.15) * plotH * 0.7);
  assert.ok(calls('=fillStyle').some((c) => c[1] === '#g4'));
  assert.ok(calls('fillRect').some((c) => Math.abs(c[2] - y) < 1e-9 && Math.abs(c[4] - (bot - y)) < 1e-9));
  assert.equal(calls('strokeRect').length, 1);
  assert.ok(Math.abs(calls('strokeRect')[0][2] - (y - dpr * 0.75)) < 1e-9);
  // the profile moved up 1%: the bar follows
  s.gradeOffset = 0.01; draw();
  const y2 = bot - Math.max(4 * dpr, ((0.05 + 0.03) / 0.15) * plotH * 0.7);
  assert.ok(calls('=fillStyle').some((c) => c[1] === '#g5') && Math.abs(calls('strokeRect')[0][2] - (y2 - dpr * 0.75)) < 1e-9);
  ok('a workout with a slope step: its grade bar among the ERG blocks, outlined when current, moved with the profile');
}

// ---- free ride
{
  const s = begin(null);
  pedal(30);
  assert.deepEqual([html('rp-left-k'), html('rp-int-label'), html('rp-count'), html('rp-target')], ['Distance', 'Free ride', '0.0%', '']);
  assert.equal(strip(html('rp-target-sub')), 'D-pad ▲▼ changes the grade');
  assert.ok($('#rp-wrap').cls.has('no-segs') && !$('#rp-wrap').cls.has('as-list'));
  assert.deepEqual(['rp-grade-row', 'rp-skip', 'rp-lap', 'rp-erg'].map(hidden), [false, true, false, true]);
  tap('rp-gup'); tap('rp-gup');
  pedal(2);
  assert.equal(html('rp-count'), '2.0%');
  assert.equal($('#rp').style.props['--zc'], '#g2');
  draw();
  const n0 = s.samples.slice(-600).length;
  assert.equal(calls('fillRect').length, n0); // a grade bar a second
  assert.deepEqual(texts(), ['Last 10 min']);
  assert.ok(calls('=fillStyle').some((c) => c[1] === '#g288') && calls('=fillStyle').some((c) => c[1] === '#g088'));
  assert.equal(calls('stroke').length, 2); // power and HR
  // Lap in a free ride closes a lap
  tap('rp-more'); tap('rp-lap');
  assert.ok(hidden('rp-sheet') && s.laps.length === 1);
  // the list choice doesn't apply without intervals
  app.phoneView = 'list'; draw(); assert.ok(calls('fillRect').length > 0); app.phoneView = 'chart';
  ok('free ride: distance, grade hero, the sheet\'s grade buttons, grade bars and power over the last 10 min, Lap');
}

console.log(`ridephone (DOM part): ${n} tests passed`);
