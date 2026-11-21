// js/ride.js, the DOM and canvas part: renderRide() on a real Session (engine + demo trainer), the chart drawn into a
// recording canvas context, the interval list, the slide and pulse of the interval card, workout messages, the ramp
// test coach and its takeover, the time of day. Fake document, clock (setTimeout / setInterval / Date.now) and Web
// Animations; Math.random seeded. The browser version is the ride run in test/smoke.mjs.
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
const flush = () => new Promise((r) => setImmediate(r));
let seed = 7; // mulberry32: the demo trainer's noise
Math.random = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---- fake Web Animations: every animate() is kept; finish() / cancel() by hand
const anims = [];
function animate(el, frames, opts) {
  let done, fail;
  const a = { el, frames, opts, state: 'running', finished: new Promise((r, j) => { done = r; fail = j; }) };
  a.finish = () => { if (a.state === 'running') { a.state = 'finished'; done(a); } };
  a.cancel = () => { if (a.state === 'running') { a.state = 'cancelled'; fail(new Error('AbortError')); } };
  a.finished.catch(() => {}); // like the browser: a cancelled animation's promise counts as handled
  anims.push(a);
  return a;
}
const finishAll = async () => { for (const a of anims) a.finish(); await flush(); await flush(); };

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

// ---- fake DOM: any selector gives one element, made on first use
class El {
  constructor(sel) {
    this.sel = sel; this.cls = new Set(); this.textContent = ''; this.innerHTML = ''; this.children = []; this.listeners = {};
    this.scrolls = []; this.offsetWidth = 300; this.offsetHeight = 40; this.clientHeight = 200; this.scrollHeight = 900; this.scrollTop = 0;
    this.width = 0; this.height = 0; this.rect = { left: 10, top: 20, right: 310, bottom: 120, width: 300, height: 100 };
    this.attrs = {};
    this.style = { props: {}, setProperty: (k, v) => { this.style.props[k] = v; }, removeProperty: (k) => { delete this.style.props[k]; } };
    this.classList = {
      add: (...c) => c.forEach((x) => this.cls.add(x)), remove: (...c) => c.forEach((x) => this.cls.delete(x)),
      contains: (c) => this.cls.has(c), toggle: (c, on) => ((on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c)),
    };
    this.firstElementChild = sel === '#r-int-bar' ? new El('bar-fill') : null;
    if (sel === '#r-chart') this.ctx = fakeCtx();
  }
  getContext() { return this.ctx; }
  getBoundingClientRect() { return this.rect; }
  querySelector(s) { return s === '.seg.current' ? (/class="seg[^"]* current"/.test(this.innerHTML) ? new El('.seg.current') : null) : null; }
  querySelectorAll() { return []; }
  addEventListener(type, f) { (this.listeners[type] ||= []).push(f); }
  scrollTo(o) { this.scrolls.push(o); }
  cloneNode() { const c = new El(`${this.sel} copy`); c.cls = new Set(this.cls); c.innerHTML = this.innerHTML; c.removed = false; return c; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); c.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.removed = true; }
  animate(frames, opts) { return animate(this, frames, opts); }
  blur() {}
}
const els = {};
const $ = (sel) => (els[sel] ||= new El(sel));
globalThis.document = { querySelector: $, querySelectorAll: () => [], getElementById: (id) => $(`#${id}`) };
const media = { reduce: false };
Object.assign(globalThis, {
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  matchMedia: (q) => ({ matches: /reduced-motion/.test(q) ? media.reduce : false }),
  ResizeObserver: class { constructor(f) { this.f = f; ResizeObserver.all.push(this); } observe(el) { this.el = el; } },
});
ResizeObserver.all = [];

const ride = await import('../js/ride.js');
const { initRide, renderRide, renderRideStatus, rideClock, sizeChart, slide, rideMsg, rideMsgReset, rideMsgQ, lastTestBest, testStep, testEnded, hideTakeover } = ride;
const { Session, DEFAULT_SETTINGS } = await import('../js/engine/session.js');
const { SimTrainer, SimHr } = await import('../js/ble/sim.js');
const { track, trackDist, climbAhead } = await import('../js/engine/workout.js');

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const W = (id) => JSON.parse(fs.readFileSync(new URL(`../workouts/${id}.json`, import.meta.url)));
const log = [];
const phone = { on: false };
const app = { screen: 'ride', settings: { ...DEFAULT_SETTINGS }, demo: true, controllers: [{ vibrate: () => log.push('vibrate') }], rows: [], session: null };
const look = () => ({ INK: 'ink', MUTED: 'muted', RULE: 'rule', FTP_LINE: 'ftpline', HR_LINE: 'hrline', TOK: { sheet: 'sheet' } });
initRide({
  app, isPhone: () => phone.on, renderPhone: (s) => log.push(`renderPhone ${s.name}`), setDevPop: (v) => log.push(`setDevPop ${v}`), look,
  zoneHex: (f) => `#z${Math.round(f * 100)}`, gradeHex: (g) => `#g${Math.round(g * 100)}`,
  setZc: (el, c) => el.style.setProperty('--zc', c), NUM_FONT: 'Archivo',
});
const canvas = $('#r-chart'), ctx = canvas.ctx;
canvas.rect = { left: 0, top: 0, width: 800, height: 300 };
sizeChart();

/** A demo ride like enterDemo() + beginSession(): the demo trainer and HR, ridden with 4 Hz ticks. */
function begin(workout, x = {}) {
  const trainer = new SimTrainer({ realDev: 5.2, trainerMass: 78 }), hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: app.settings, ...(workout ? { workout } : {}) });
  Object.assign(s, x);
  s.on('segment', () => { rideMsgQ.list = []; rideMsgQ.stale = true; testStep(s); });
  s.on('message', (t) => rideMsg(t));
  s.test = s.segs?.some((g) => g.untilFail) ? { st: {}, prevBest: lastTestBest() } : null;
  app.session = s; app.hr = hr; app.trainer = trainer; app._segI = undefined;
  return s;
}
function pedal(sec) {
  const s = app.session;
  for (let i = 0; i < sec * 4; i++) { s.trainer.step(); app.hr.step(0.25); s.tick(0.25); advance(250); renderRide(); }
}
const texts = () => ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
const count = (k) => ctx.calls.filter((c) => c[0] === k).length;
const draw = () => { ctx.calls.length = 0; renderRide(); };
const strip = (h) => h.replace(/<[^>]+>/g, '');

// ---- ERG workout
{
  const s = begin(W('sweetspot-3x12'));
  pedal(20);
  assert.ok(s.started && s.samples.length > 10);
  assert.equal($('#r-int-label').innerHTML, 'Warm-up');
  assert.match(strip($('#r-int-big').innerHTML), /^Ramp to140Win9:\d\d$/);
  assert.equal(strip($('#r-next').innerHTML), 'Next12:00@180W90 rpm');
  assert.equal($('#r-next').style.props['--nc'], '#z90');
  assert.ok(!$('#r-int-bar').cls.has('hidden') && /^\d+\.\d\d%$/.test($('#r-int-bar').firstElementChild.style.width));
  assert.equal($('#r-segn').textContent, '0/8');
  assert.match($('#r-left').textContent, /^1:02:\d\d$/);
  assert.equal($('#r-power').textContent, Math.round(s.powerShown));
  assert.equal($('#r-target').innerHTML, `target <b style="color:var(--text)">${s.target}</b> W`);
  assert.ok($('.tile.gear').cls.has('dim') && $('.tiles').cls.has('erg'));
  assert.ok($('#r-pct').cls.has('hidden'));
  assert.equal($('#r-pause').textContent, 'Pause');
  assert.match($('#r-hints').innerHTML, /effort &plusmn;1% &middot; <b>Hold Y<\/b> skip .* demo: <b>\+\/-<\/b> rider power$/);
  assert.ok(!$('#r-erg').cls.has('hidden') && $('#r-erg').textContent === 'ERG off');
  assert.equal($('#r-status').innerHTML, '<span class="cx ">Demo</span><span class="cx ">HR</span><span class="cx off">Controller</span><span>ERG</span>');
  assert.ok($('#r-body').cls.has('with-segs'));
  // the list scrolled to the current row once (first time: no animation), not again until the interval changes
  assert.deepEqual($('#r-seg-rows').scrolls.map((x) => x.behavior), ['auto']);
  ok('ERG ride: card, Next card, bar, list count and time left, tiles, hints, ERG button, status dots');
}
{
  // the chart: one block per ERG step (ramps with a gradient), the FTP line, the power trace, the position marker
  draw();
  assert.equal(count('fill'), 8);
  assert.equal(count('createLinearGradient'), 2); // warm-up and cool-down ramps
  // each ramp in its zones along it (rampStops in js/profile.js), not yet ridden: the warm-up 45 -> 70% FTP crosses
  // 55% at 40% of the way, so Z1 then Z2, each colored at its middle (50% and 62.5%)
  const warm = ctx.calls.find((c) => c[0] === 'createLinearGradient')[1].stops.map(([o, c]) => [+o.toFixed(3), c]);
  assert.deepEqual(warm, [[0, '#z50cc'], [0.4, '#z50cc'], [0.4, '#z63cc'], [1, '#z63cc']]);
  assert.deepEqual(texts(), ['FTP 200']);
  const s = app.session, X = ride.workoutX(s, canvas.width);
  const hr = ride.smoothHr(s.samples), runs = hr.filter((h, i) => h && !hr[i - 1]).length;
  assert.equal(count('lineTo'), 8 * 3 + 1 + (s.samples.length - 1) + (hr.filter(Boolean).length - runs)); // blocks, FTP line, power, heart rate
  assert.equal(count('stroke'), 3); // FTP line, power, heart rate
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'fillRect').at(-1), ['fillRect', X(s.chartPos) - 1, 0, 2, canvas.height]);
  assert.ok(ctx.calls.some((c) => c[0] === '=strokeStyle' && c[1] === 'hrline'));
  ok('ERG chart: a block per step, gradients on ramps, FTP line, power and HR traces, where you are');
}
{
  const s = app.session;
  s.intensity = 1.03;
  renderRide();
  assert.ok(!$('#r-pct').cls.has('hidden'));
  assert.equal($('#r-pct').innerHTML, '103%');
  assert.equal(strip($('#r-next').innerHTML), 'Next12:00@185W90 rpm');
  s.intensity = 1;
  // a skip: the Next card grows over the card (copies on #ride), the card pulses when it lands, a new Next card slides in
  const card = $('#r-interval');
  assert.ok(card.cls.has('int-fresh')); // the first interval's beat; its animationend takes the class off
  card.listeners.animationend.forEach((f) => f({ animationName: 'int-fresh', currentTarget: card }));
  assert.ok(!card.cls.has('int-fresh'));
  anims.length = 0;
  s.skip(); renderRide();
  const host = $('#ride');
  assert.equal(host.children.length, 2);
  assert.ok(host.children[0].cls.has('rt-ghost') && host.children[1].cls.has('rt-mover'));
  assert.equal($('#r-next').style.visibility, 'hidden');
  assert.equal(slide.busy, true);
  assert.ok(!$('#r-interval').cls.has('int-fresh')); // not before it lands
  await finishAll();
  assert.ok($('#r-interval').cls.has('int-fresh'));
  assert.equal($('#r-next').style.visibility, '');
  advance(200); await flush();
  assert.equal(host.children.length, 0);
  assert.equal(slide.busy, false);
  assert.equal($('#r-int-label').innerHTML, 'Sweet spot 1/3');
  assert.equal($('#r-segn').textContent, '1/8');
  assert.deepEqual($('#r-seg-rows').scrolls.map((x) => x.behavior), ['auto', 'smooth']);
  // reduced motion: no slide, the card pulses at once
  media.reduce = true;
  $('#r-interval').classList.remove('int-fresh');
  s.skip(); renderRide();
  assert.equal(host.children.length, 0);
  assert.ok($('#r-interval').cls.has('int-fresh'));
  media.reduce = false;
  // the last 10 seconds of an interval beat once a second
  pedal(2);
  assert.ok(!$('#r-interval').cls.has('int-ending'));
  pedal(Math.ceil(s.segRemaining.sec) - 8);
  assert.ok($('#r-interval').cls.has('int-ending'));
  ok('effort 103%; a skip slides the Next card over, the card pulses on landing; reduced motion; last 10 s beat');
}
{
  const s = app.session;
  s.togglePause(); renderRide();
  assert.ok(!$('#r-paused').cls.has('hidden'));
  assert.deepEqual([$('#r-paused-title').textContent, $('#r-paused-sub').textContent, $('#r-pause').textContent], ['Paused', 'Press A or Space to resume', 'Resume']);
  $('#devpop').classList.add('on-ride');
  s.togglePause(); renderRide();
  assert.ok($('#r-paused').cls.has('hidden'));
  assert.equal(log.at(-1), 'setDevPop false'); // Connections went with the pause screen
  $('#devpop').classList.remove('on-ride');
  // ERG off on an ERG step: slope mode, the button says so, the card label too
  s.toggleErg();
  pedal(1);
  assert.equal($('#r-erg').textContent, 'ERG back on');
  assert.match($('#r-int-label').innerHTML, /\(ERG off\)$/);
  assert.ok(!$('.tile.gear').cls.has('dim') && strip($('#r-ratio').innerHTML).startsWith('ratio'));
  s.toggleErg();
  // the end of the workout: done card, Finish, then nothing next; Z laps again
  while (s.segIndex >= 0 && s.segIndex < s.segs.length - 1) s.skip();
  pedal(1);
  assert.equal(strip($('#r-next').innerHTML), 'NextFinish');
  assert.ok($('#r-next').cls.has('finish'));
  s.skip(); pedal(1);
  assert.equal($('#r-int-label').innerHTML, 'Workout complete');
  assert.equal(strip($('#r-int-big').innerHTML), 'Done. Nice work.');
  assert.ok($('#r-int-bar').cls.has('hidden') && $('#r-next').cls.has('none'));
  assert.equal($('#r-left').textContent, 'Done');
  assert.match($('#r-hints').innerHTML, /<b>Z<\/b> lap/);
  assert.ok($('#r-erg').cls.has('hidden'));
  ok('pause screen (and Connections closing with it), ERG off, Finish, workout complete');
}

// ---- free ride
{
  phone.on = false;
  const s = begin(null);
  pedal(5);
  s.gradeOffset = 0.02; pedal(10);
  assert.equal($('#r-int-label').innerHTML, 'Free ride');
  assert.equal(strip($('#r-int-big').innerHTML), `${(s.grade * 100).toFixed(1)}%grade`);
  assert.ok($('#r-next').cls.has('none') && !$('#r-body').cls.has('with-segs'));
  assert.equal($('#r-climb-label').textContent, 'Climbed');
  assert.equal($('#r-climb').innerHTML, `${Math.round(s.climbed)}<span class="unit">m</span>`);
  assert.equal($('#r-status').innerHTML.includes('<span>Slope</span>'), true);
  assert.ok(!$('.tile.gear').cls.has('dim'));
  assert.match($('#r-ratio').innerHTML, /^<svg class="gearviz"/);
  draw();
  assert.deepEqual(texts(), ['Last 10 min']);
  assert.equal(count('fillRect'), s.samples.length); // one grade bar a second
  s.maxed = true; renderRideStatus();
  assert.ok($('#r-status').innerHTML.endsWith('<span class="off">Max resistance</span>'));
  ok('free ride: grade card, no Next card or list, Climbed, gears, last 10 min chart with a grade bar a second');
}

// ---- slope road: Climbed on timed climbs, km marks, the flag on a climb
{
  const w = W('sim-climb-repeats'), s = begin(w);
  pedal(5); s.skip(); pedal(30);
  const tr = track(s.segs), d = trackDist(tr, s.segs, s.chartPos);
  // timed climbs: the tile counts the real metres climbed (To the top only on distance climbs, test/ride.mjs)
  assert.equal($('#r-climb-label').textContent, 'Climbed');
  assert.equal($('#r-climb').innerHTML, `${Math.round(s.climbed)}<span class="unit">m</span>`);
  draw();
  const t = texts(), c = climbAhead(tr, s.segs, s.segIndex, d);
  const km = t.filter((x) => / km$/.test(x));
  assert.ok(km.length >= 3 && km[0] === `${ride.trackKmStep(tr.D)} km`);
  assert.ok(t.includes('FTP 200'));
  assert.ok(t.includes(ride.fmtDist(c.m)) && t.includes(` to the top · +${Math.round(c.rise)} m`), t.join(' | ')); // the flag's tag
  assert.equal(t.at(-1), ride.trackProgress(s));
  assert.ok(ctx.calls.some((x) => x[0] === 'arc')); // the dot on the road
  // on the flat roll, no flag
  s.skip(); pedal(2); draw();
  assert.ok(!texts().some((x) => /to the top/.test(x)));
  ok('slope road: Climbed on timed climbs, km marks, the flag and what is left to the top on a climb, progress line, none on the flat');
}

// ---- workout messages: one at a time, at least 3.5 s each, a new step's first message replaces at once
{
  rideMsgReset();
  const m = $('#r-msg');
  assert.ok(!m.cls.has('show'));
  rideMsg('One'); assert.deepEqual([m.textContent, m.cls.has('show')], ['One', true]);
  advance(1000); rideMsg('Two');
  advance(2000); assert.equal(m.textContent, 'One'); // up for 3 s
  advance(600); assert.equal(m.textContent, 'Two'); // 3.5 s
  advance(ride.msgMs('Two') - 200); assert.ok(m.cls.has('show')); // shown at 3.5 s, up for its length
  advance(200); assert.ok(!m.cls.has('show'));
  rideMsg('Three'); advance(500);
  rideMsgQ.list = []; rideMsgQ.stale = true; // a new step
  rideMsg('Four'); assert.equal(m.textContent, 'Four');
  rideMsgReset(); assert.deepEqual([m.textContent, m.cls.has('show'), rideMsgQ.list.length], ['', false, 0]);
  ok('workout messages: queue with a 3.5 s minimum, shown for their length, a new step replaces, reset clears');
}

// ---- ramp test: last test's line, takeovers, the finish cue, the result
{
  app.rows = [
    { summary: { workoutId: 'ramp-test', start: '2026-10-01T18:00:00Z', bests: { 60: 240 } } },
    { demo: true, summary: { workoutId: 'ramp-test', start: '2026-11-10T18:00:00Z', bests: { 60: 400 } } },
    { summary: { workoutId: 'ramp-test', start: '2026-11-01T18:00:00Z', bests: { 60: 262 } } },
    { summary: { workoutId: 'z2-60', start: '2026-11-15T18:00:00Z', bests: { 60: 300 } } },
  ];
  assert.equal(lastTestBest(), 262);
  app.settings.riderName = 'Agustín';
  const s = begin(W('ramp-test'));
  assert.deepEqual(s.test, { st: {}, prevBest: 262 });
  pedal(2);
  assert.equal($('#r-msg').textContent, 'Ramp test today. Easy spin for the first 5 minutes.');
  draw();
  assert.ok(texts().includes('Last test 262'));
  anims.length = 0;
  s.skip(); s.skip(); // step 1: 100 W
  const to = $('#takeover');
  assert.ok(!to.cls.has('hidden'));
  assert.deepEqual([$('#to-line').textContent, $('#to-big').textContent], ['Here we go, Agustín.', '100 W']);
  assert.equal(to.style.props['--zc'], '#z50');
  assert.equal(anims.filter((a) => a.el === to).length, 1);
  await finishAll();
  assert.ok(to.cls.has('hidden'));
  // the first hard step (200 W = FTP): its own takeover, and a "15 seconds" cue added once at the end of the step
  while (s.seg.from * 200 < 200 - 1e-9) s.skip();
  const g = s.seg;
  assert.equal($('#to-line').textContent, 'Past your FTP, Agustín. Every step counts now.');
  assert.deepEqual(g.msgs.filter((x) => x.text === '15 seconds. Finish the step!').map((x) => x.t), [g.dur - 15]);
  testStep(s);
  assert.equal(g.msgs.filter((x) => x.text === '15 seconds. Finish the step!').length, 1);
  await finishAll();
  // the end of the test: controllers buzz, the result takes over (dark), then says the new FTP over the chart
  s.samples.push(...Array(60).fill(0).map(() => ({ power: 300, wt: 0 })));
  testEnded(s, {});
  assert.equal(log.at(-1), 'vibrate');
  assert.ok(to.cls.has('dark') && !to.cls.has('hidden'));
  assert.deepEqual([$('#to-line').textContent, $('#to-big').textContent], ['Huge effort, Agustín!', 'FTP 225 W']);
  assert.equal(s.test.result.ftp, 225);
  await finishAll();
  assert.ok(to.cls.has('hidden'));
  assert.equal($('#r-msg').textContent, 'New FTP 225 W, up 25 W. Spin easy, then update it on the summary.');
  // hideTakeover (end of ride) stops it at once; the phone and other screens never show it
  testEnded(s, {}); assert.ok(!to.cls.has('hidden'));
  hideTakeover(); assert.ok(to.cls.has('hidden'));
  assert.equal(anims.filter((a) => a.el === to).at(-1).state, 'cancelled');
  phone.on = true; testEnded(s, {}); assert.ok(to.cls.has('hidden'));
  phone.on = false; app.screen = 'home'; testEnded(s, {}); assert.ok(to.cls.has('hidden'));
  app.screen = 'ride'; app.settings.riderName = '';
  ok('ramp test: last test line, "Here we go" and "Past your FTP" takeovers, the 15 s cue once, the result, hidden on end / phone');
}

// ---- the phone, the time of day
{
  phone.on = true; log.length = 0;
  const s = begin(W('sweetspot-3x12'));
  $('#r-int-label').innerHTML = 'untouched';
  pedal(2);
  assert.equal(log.filter((x) => x.startsWith('renderPhone')).length, 8);
  assert.equal($('#r-int-label').innerHTML, 'untouched'); // the desktop card isn't drawn on the phone
  s.togglePause(); renderRide();
  assert.equal($('#r-paused-sub').textContent, 'Tap Resume or press A');
  phone.on = false;
  app.screen = 'home'; log.length = 0; renderRide(); assert.equal($('#r-int-label').innerHTML, 'untouched');
  app.screen = 'ride';
  rideClock(true);
  assert.match($('#r-tod').textContent, /^6:\d\d PM$/);
  advance(Date.parse('2026-11-19T19:00:01') - clock.t); // ticks once a second
  assert.equal($('#r-tod').textContent, '7:00 PM');
  rideClock(false); advance(5 * 60000);
  assert.equal($('#r-tod').textContent, '7:00 PM');
  // the chart follows its box
  canvas.rect = { left: 0, top: 0, width: 900, height: 320 };
  ResizeObserver.all.find((o) => o.el === canvas).f();
  assert.deepEqual([canvas.width, canvas.height], [900, 320]);
  ok('phone: renderPhone instead of the desktop screen; nothing off the ride screen; time of day ticks only while shown; chart resize');
}

console.log(`ride (DOM part): ${n} tests passed`);
