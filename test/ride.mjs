// Desktop ride screen (js/ride.js): the pure pieces. What the interval card says, the Next card, the tiles (power,
// HR, cadence, gear, Climbed / To the top, speed) and the chart geometry. renderRide / drawChart / drawTrack and the
// message queue and takeover are DOM / canvas code, checked by the smoke test (demo rides with a paused clock).
// Expectations are written out by hand (FTP 200), not computed with the module's own formulas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  rideTiles, intervalCard, nextCard, gearViz, powerScale, workoutX, gradeBarH, ergShape, trackFrame, trackView, trackKmStep,
  trackProgress, workoutLeft, smoothPower, smoothHr, msgMs, intervalEnding, fmtDist, segAmount,
} from '../js/ride.js';
import { flatten, track, trackDist, trackClimbed, climbsByDist } from '../js/engine/workout.js';
import { Gearbox } from '../js/engine/drivetrain.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const W = (id) => JSON.parse(fs.readFileSync(new URL(`../workouts/${id}.json`, import.meta.url)));
const look = { INK: '#111', RULE: '#ddd' };
const v = { ftp: 200, riderKg: 80, hrBpm: undefined, track: null, zoneHex: (f) => `zone(${f.toFixed(2)})`, gradeHex: (g) => `grade(${g.toFixed(3)})`, ...look };
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&#9650;/g, '▲').replace(/&#9660;/g, '▼');

const ss = flatten(W('sweetspot-3x12')); // 0 warm-up ramp 45-70%, 1 sweet spot 90% @ 90 rpm (1/3), 2 recovery 50%, ..., 7 cool-down ramp
const cr = flatten(W('sim-climb-repeats')); // 0 warm-up roll 1%, 1 climb 6% @ 85 rpm "Hold ~100% FTP" (aim 1: 190-210 W), 2 flat roll 0%
const rt = flatten(W('ramp-test'));

/** A session as renderRide() sees it: the fields the ride screen reads, defaults for an ERG ride at 100%. */
function ses(x = {}) {
  const segs = 'segs' in x ? x.segs : ss, segIndex = x.segIndex ?? 1;
  const seg = segs && segIndex >= 0 ? segs[segIndex] : null;
  return {
    segs, segIndex, seg, segProgress: 0.25, segRemaining: seg ? (seg.dist ? { m: seg.dist * 0.75 } : { sec: seg.dur * 0.75 }) : null,
    target: null, intensity: 1, gradeOffset: 0, grade: 0, ergOff: false, mode: 'erg', chartPos: seg ? seg.start + 10 : 0,
    trainer: { data: { hr: 0, cadence: 0 } }, powerShown: 0, samples: [], cadStatus: null, climbed: 0,
    gb: new Gearbox(), bike: { v: 0, dist: 0 }, elapsed: 0, started: true, paused: false,
    ...x,
  };
}

// ---- interval card
{
  let c = intervalCard(ses({ target: 180 }), v);
  assert.equal(c.label, 'Sweet spot 1/3');
  assert.equal(text(c.big), 'Hold180Wfor9:00');
  assert.equal(text(c.text), '90% FTP · 90 rpm');
  assert.equal(c.zc, 'zone(0.90)');
  assert.equal(c.bar, '25.00%');
  // no target yet (first tick): the plan's watts at the effort; effort 105% says so in the % line
  c = intervalCard(ses({ intensity: 1.05 }), v);
  assert.equal(text(c.big), 'Hold189Wfor9:00');
  assert.equal(text(c.text), '95% FTP · 90 rpm');
  // the ERG guard's eased target is what the card says
  c = intervalCard(ses({ target: 108 }), v);
  assert.equal(text(c.big), 'Hold108Wfor9:00');
  // ramp: where it goes and the target now; color follows the live target
  c = intervalCard(ses({ segIndex: 0, segProgress: 0.5, segRemaining: { sec: 300 }, target: 115 }), v);
  assert.equal(c.label, 'Warm-up');
  assert.equal(text(c.big), 'Ramp to140Win5:00');
  assert.equal(text(c.text), 'now 115 W');
  assert.equal(c.zc, 'zone(0.57)'); // 45% -> 70%, halfway (0.575)
  // ERG off on an ERG step; a step's own text wins over the % line, escaped, cadence kept
  c = intervalCard(ses({ ergOff: true }), v);
  assert.equal(c.label, 'Sweet spot 1/3 (ERG off)');
  const custom = { ...ss[1], text: 'Stay <seated> & smooth' };
  c = intervalCard(ses({ segs: [ss[0], custom], seg: custom }), v);
  assert.equal(c.text, 'Stay &lt;seated&gt; &amp; smooth &middot; 90 rpm');
  // the bar stays inside 0-100%
  assert.equal(intervalCard(ses({ segProgress: 1.2 }), v).bar, '100.00%');
  assert.equal(intervalCard(ses({ segProgress: -0.1 }), v).bar, '0.00%');
  ok('interval card, ERG: hold, ramp, effort, the guard target, ERG off, own text, bar');
}
{
  let c = intervalCard(ses({ segs: cr, segIndex: 1, mode: 'sim' }), v);
  assert.equal(c.label, 'Climb 1/4');
  assert.equal(text(c.big), '6%grade for4:30');
  assert.equal(text(c.text), 'Hold ~200 W · 85 rpm'); // "% FTP" in a slope step's text reads in watts
  assert.equal(c.zc, 'grade(0.060)');
  // the profile moved up / down with the D-pad: said first, and the grade includes it
  c = intervalCard(ses({ segs: cr, segIndex: 1, mode: 'sim', gradeOffset: 0.02 }), v);
  assert.equal(text(c.big), '8%grade for4:30');
  assert.equal(text(c.text), 'profile +2% · Hold ~200 W · 85 rpm');
  // no text of its own: the aim goes in the small line
  const aimed = flatten({ steps: [{ dur: 300, grade: 7, aim: 0.9, cadence: '60-65' }] });
  c = intervalCard(ses({ segs: aimed, segIndex: 0, mode: 'sim' }), v);
  assert.equal(text(c.text), 'use your gears, aim 180 W · 60-65 rpm');
  c = intervalCard(ses({ segs: cr, segIndex: 2, mode: 'sim', gradeOffset: -0.01 }), v);
  assert.equal(text(c.big), '-1%grade for3:00');
  assert.equal(text(c.text), 'profile -1% · use your gears');
  // distance steps count metres, then km
  const climb = flatten(W('climb-el-durazno')), d = climb.findIndex((g) => g.dist);
  c = intervalCard(ses({ segs: climb, segIndex: d, mode: 'sim', segRemaining: { m: 87.4 } }), v);
  assert.match(text(c.big), /grade for87m$/);
  c = intervalCard(ses({ segs: climb, segIndex: d, mode: 'sim', segRemaining: { m: 1530 } }), v);
  assert.match(text(c.big), /grade for1\.53km$/);
  ok('interval card, slope: grade, profile offset up and down, own text in watts, aim and cadence, metres and km left');
}
{
  let c = intervalCard(ses({ segIndex: -1 }), v);
  assert.deepEqual([c.label, c.text, text(c.big), c.bar, c.zc], ['Workout complete', 'keep riding or hold B to finish', 'Done. Nice work.', null, 'var(--ok-bg)']);
  c = intervalCard(ses({ segs: null, segIndex: -1, mode: 'sim', grade: 0.0349 }), v);
  assert.deepEqual([c.label, text(c.big), c.bar, c.zc], ['Free ride', '3.5%grade', null, 'grade(0.035)']);
  assert.equal(c.text, 'up/down changes the grade by 1%, shift to hold your cadence');
  ok('interval card: workout complete, free ride');
}

// ---- Next card
{
  const nx = (s, i) => nextCard(s, s.segs[i], v);
  let c = nx(ses({ segIndex: 0 }), 1);
  assert.equal(text(c.html), 'Next12:00@180W90 rpm');
  assert.equal(c.nc, 'zone(0.90)');
  assert.deepEqual([c.none, c.finish], [false, false]);
  c = nx(ses({ segIndex: 0, intensity: 1.1 }), 1);
  assert.equal(text(c.html), 'Next12:00@198W90 rpm');
  c = nx(ses({ segIndex: 6 }), 7); // the cool-down ramp: both ends, colored by where it starts
  assert.equal(text(c.html), 'Next5:00@120-80W');
  assert.equal(c.nc, 'zone(0.60)');
  c = nx(ses({ segs: cr, segIndex: 0, mode: 'sim', gradeOffset: 0.01 }), 1);
  assert.equal(text(c.html), 'Next6:00@7%85 rpm · ~200 W');
  assert.equal(c.nc, 'grade(0.060)'); // the step's own grade, like the workout's colors
  const climb = flatten(W('climb-el-durazno')), d = climb.findIndex((g) => g.dist);
  c = nx(ses({ segs: climb, segIndex: d - 1, mode: 'sim' }), d);
  assert.match(text(c.html), new RegExp(`^Next${climb[d].dist} m@\\d+%$`));
  c = nextCard(ses({ segIndex: 7 }), undefined, v);
  assert.deepEqual(c, { none: false, finish: true, nc: 'var(--rule)', html: '<div class="rt-k">Next</div><div class="amt">Finish</div>' });
  assert.deepEqual(nextCard(ses({ segIndex: -1 }), undefined, v), { none: true });
  assert.deepEqual(nextCard(ses({ segs: null, segIndex: -1 }), undefined, v), { none: true });
  ok('Next card: hold, effort, ramp, slope with the offset, distance, Finish, none after the end and in free ride');
}

// ---- tiles
{
  const t = (x, w = v) => rideTiles(ses(x), w);
  let r = t({ powerShown: 181.4, target: 180, elapsed: 3725, bike: { v: 9.25, dist: 12345 } });
  assert.deepEqual([r.power, r.powerCls, text(r.target), r.elapsed], [181, 'ok', 'target 180 W', '1:02:05']);
  assert.deepEqual([r.speed, r.dist, text(r.trip)], ['33.3', '12.35 km', '12.3 km · 33.3 km/h']);
  assert.equal(t({ powerShown: 170, target: 180 }).powerCls, 'low'); // 94%
  assert.equal(t({ powerShown: 171, target: 180 }).powerCls, 'ok'); // 95%
  assert.equal(t({ powerShown: 190, target: 180 }).powerCls, 'high'); // 105.6%
  r = t({ powerShown: 240, target: null, mode: 'sim' });
  assert.deepEqual([r.powerCls, r.target], ['', '3.0 W/kg']);
  // effort: only in ERG, only when it isn't 100%
  assert.deepEqual([t({}).effortShown, t({ intensity: 1.03 }).effortShown, t({ intensity: 1.03 }).effort], [false, true, '103%']);
  assert.equal(t({ intensity: 0.97, mode: 'sim' }).effortShown, false);
  ok('tiles: power vs target (95-105% is on target), W/kg without one, effort, clock, speed and distance');
}
{
  const t = (x, w = v) => rideTiles(ses(x), w);
  assert.equal(t({ trainer: { data: { hr: 131 } } }).hr, 131);
  assert.equal(t({ trainer: { data: { hr: 131 } } }, { ...v, hrBpm: 142.6 }).hr, 143); // the strap wins over the trainer
  assert.equal(t({}).hr, '--');
  const samples = [...Array(100).fill({ hr: 180 }), { hr: 0 }, ...Array(600).fill({ hr: 140 })];
  assert.equal(t({ samples }).hrAvg, 'avg 140 (10 min)'); // the last 600 seconds with a heart rate
  assert.equal(t({ samples: [{ power: 100 }] }).hrAvg, '');
  // cadence: target from the step, a warning when off
  let r = t({ trainer: { data: { cadence: 88.6 } }, cadStatus: 'ok' });
  assert.deepEqual([r.cad, r.cadState, r.cadTarget], [89, 'ok', 'target 90 rpm']);
  r = t({ cadStatus: 'low' });
  assert.deepEqual([r.cadState, text(r.cadTarget)], ['bad', '▲ Pedal faster']);
  assert.equal(text(t({ cadStatus: 'high' }).cadTarget), '▼ Pedal slower');
  r = t({ segIndex: 0, cadStatus: null });
  assert.deepEqual([r.cadState, r.cadTarget], ['', '']);
  ok('tiles: heart rate (strap first, 10 min average), cadence target and warnings');
}
{
  // slope step with an aim: the power tile turns green on target, red (and pulses) with an arrow off it
  const t = (x) => rideTiles(ses({ segs: cr, segIndex: 1, mode: 'sim', ...x }), v);
  let r = t({ aimStatus: null });
  assert.deepEqual([r.powerCls, text(r.target)], ['', 'target 190-210 W']); // settling: just the band
  r = t({ aimStatus: 'ok' });
  assert.deepEqual([r.powerCls, text(r.target)], ['aim-ok', 'target 190-210 W']);
  r = t({ aimStatus: 'low' });
  assert.deepEqual([r.powerCls, text(r.target)], ['aim-bad', '▲ Push harder']);
  r = t({ aimStatus: 'high' });
  assert.deepEqual([r.powerCls, text(r.target)], ['aim-bad', '▼ Ease off']);
  r = t({ segIndex: 2, aimStatus: null, powerShown: 160 }); // flat roll: no aim, W/kg as before
  assert.deepEqual([r.powerCls, r.target], ['', '2.0 W/kg']);
  r = rideTiles(ses({ target: 180, powerShown: 180, aimStatus: 'low' }), v); // ERG keeps its own target line
  assert.deepEqual([r.powerCls, text(r.target)], ['ok', 'target 180 W']);
  ok('tiles: slope power aim, green on target, red with push harder / ease off, nothing without an aim or in ERG');
}
{
  const t = (x) => rideTiles(ses(x), v);
  let r = t({});
  assert.deepEqual([r.gearDim, r.gear, r.gearCombo, r.ratio], [true, '50×19', true, 'ERG: gears not used']);
  const gb = new Gearbox(); gb.shiftRear(1);
  r = t({ mode: 'sim', gb });
  assert.deepEqual([r.gearDim, r.gear], [false, '50×17']);
  assert.match(r.ratio, /<span>ratio 2\.94<\/span>$/);
  assert.equal(r.ratio, gearViz(gb, look));
  // the cog and ring in use are inked: 12 cogs easiest first (6th = 17 t), then 2 rings (big one in use)
  const fills = [...r.ratio.matchAll(/<rect [^>]*fill="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fills.map((f, i) => (f === '#111' ? i : null)).filter((i) => i !== null), [6]);
  const strokes = [...r.ratio.matchAll(/<circle [^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(strokes, ['#ddd', '#111']);
  // Zwift-style virtual gears: a number, no picture
  const seq = new Gearbox('zwift-24');
  r = t({ mode: 'sim', gb: seq });
  assert.deepEqual([r.gear, r.gearCombo], [String(seq.rear + 1), false]);
  assert.equal(r.ratio, `gear ${seq.rear + 1}/24 &middot; ratio ${seq.ratio.toFixed(2)}`);
  ok('tiles: gear (ERG dims it), ring x cog, the cog and ring in use inked, virtual gears');
}
{
  // Climbed in free ride and ERG / mixed workouts; To the top on a road (slope-only workout)
  let r = rideTiles(ses({ segs: null, segIndex: -1, climbed: 12.6 }), v);
  assert.deepEqual([r.climbLabel, r.climb, r.climbSub], ['Climbed', '13<span class="unit">m</span>', '']);
  // timed climbs (sim-climb-repeats): metres depend on speed, so the real Climbed, no estimate
  assert.equal(climbsByDist(cr), false);
  r = rideTiles(ses({ segs: cr, segIndex: 1, chartPos: cr[1].start + 60, mode: 'sim', climbed: 20.4 }), { ...v, track: track(cr) });
  assert.deepEqual([r.climbLabel, r.climb, r.climbSub], ['Climbed', '20<span class="unit">m</span>', '']);
  // distance climbs (hill repeats 1.5 km; its 1% warm-up and flat cool-down are timed): To the top, out of the total
  const hr = flatten(W('sim-hill-repeats-1500')), tr = track(hr);
  assert.equal(climbsByDist(hr), true);
  r = rideTiles(ses({ segs: hr, segIndex: 0, chartPos: 0, mode: 'sim' }), { ...v, track: tr });
  assert.equal(r.climbLabel, 'To the top');
  assert.equal(r.climb, `${Math.round(tr.ascent)}<span class="unit">m</span>`); // nothing climbed yet
  assert.equal(r.climbSub, `of ${Math.round(tr.ascent)} m`);
  const ci = hr.findIndex((g) => g.dist), mid = hr[ci].start + hr[ci].dur / 2, d = trackDist(tr, hr, mid);
  r = rideTiles(ses({ segs: hr, segIndex: ci, chartPos: mid, mode: 'sim' }), { ...v, track: tr });
  assert.equal(r.climb, `${Math.round(tr.ascent - trackClimbed(tr, d))}<span class="unit">m</span>`);
  r = rideTiles(ses({ segs: hr, segIndex: -1, chartPos: hr.at(-1).end + 50, mode: 'sim' }), { ...v, track: tr });
  assert.deepEqual([r.climb, r.climbSub], ['0<span class="unit">m</span>', `of ${Math.round(tr.ascent)} m`]);
  assert.equal(climbsByDist(flatten(W('climb-el-durazno'))), true);
  ok('tiles: Climbed in free ride and on timed climbs; To the top out of the total climb on distance climbs, down to 0 at the end');
}

// ---- chart geometry
{
  const sc = powerScale([], 320, 780, 760); // FTP 200 x 1.6, baseline at 780, 760 px tall
  assert.equal(sc.maxP, 320);
  assert.deepEqual([sc.Yp(0), sc.Yp(160), sc.Yp(320), sc.Yp(500)], [780, 400, 20, 20]); // clipped at the top
  // the last 20 minutes' peak + 20 W raises the top; an older spike doesn't
  const samples = [{ power: 900 }, ...Array(1200).fill({ power: 150 })];
  assert.equal(powerScale(samples, 320, 780, 760).maxP, 320);
  samples.push({ power: 480 });
  assert.equal(powerScale(samples, 320, 780, 760).maxP, 500);
  samples[1201 - 900] = { power: 700 }; // 15 min ago: still in the window
  assert.equal(powerScale(samples, 320, 780, 760).maxP, 720);
  ok('chart: power scale (FTP x 1.6 or the recent peak, older spikes ignored, clipped)');
}
{
  const s = ses({ chartPos: 100 }), end = ss.at(-1).end; // 600 + 3 x 960 + 300 = 3780 s
  const X = workoutX(s, 1000);
  assert.deepEqual([X(0), X(end / 2), X(end)], [0, 500, 1000]);
  const past = workoutX(ses({ chartPos: end + 199 }), 1000); // ridden on after the end: the chart squeezes
  assert.equal(past(end + 200), 1000);
  assert.deepEqual([gradeBarH(-0.03, 600, 0.6, 6), gradeBarH(0.12, 600, 0.6, 6), gradeBarH(0.045, 600, 0.6, 6), gradeBarH(-0.08, 600, 0.6, 6)], [6, 360, 180, 6]);
  const Yp = (w) => 800 - w; // 1 px a watt
  assert.deepEqual(ergShape(ss[1], (t) => t / 10, Yp, 200, 1, 800), [[60, 800], [60, 620], [132, 620], [132, 800]]); // 180 W block
  assert.deepEqual(ergShape(ss[0], (t) => t / 10, Yp, 200, 1.1, 800), [[0, 800], [0, 701], [60, 646], [60, 800]]); // ramp 99 -> 154 W
  ok('chart: workout time to x (squeezes after the end), grade bars, ERG blocks and ramps');
}
{
  const tr = track(cr), view = trackView(ses({ segs: cr, segIndex: 1 }), tr);
  assert.deepEqual(view, { v0: 0, lo: tr.lo, hi: tr.hi, up0: 0, first: 0 }); // no lead: the whole road
  const f = trackFrame(tr, view, { W: 1000, top: 10, bot: 610, area: 0.6, elevMin: 60 });
  assert.deepEqual([f.X(0), f.X(tr.D)], [0, 1000]);
  // elevation fills the top 60% of the plot, 6% of it (36 px) kept clear under the lowest point
  assert.ok(Math.abs(f.Y(tr.lo) - (610 - 36)) < 1e-9 && Math.abs(f.Y(tr.hi) - (610 - 360)) < 1e-9);
  // a flat road still gets 60 m of range: 10 m of rise is 1/6 of the band
  const flat = track([{ kind: 'sim', grade: 0, dist: 500 }, { kind: 'sim', grade: 0.01, dist: 1000 }]); // 10 m of rise
  const ff = trackFrame(flat, trackView(ses({ segs: null }), flat), { W: 1000, top: 10, bot: 610, area: 0.6, elevMin: 60 });
  assert.ok(Math.abs((ff.Y(0) - ff.Y(10)) - (610 - 36 - 250) / 6) < 1e-9);
  // a real climb: once its warm-up (profile.lead) is ridden, the view starts at the climb
  const w = W('climb-el-durazno'), climb = flatten(w), ctr = track(climb), lead = w.profile.lead.length;
  const before = trackView(ses({ segs: climb, segIndex: 0, workout: w, chartPos: 10 }), ctr);
  const after = trackView(ses({ segs: climb, segIndex: lead, workout: w, chartPos: climb[lead].start + 5 }), ctr);
  assert.equal(before.v0, 0);
  assert.equal(after.v0, ctr.parts[lead].d0);
  assert.equal(after.first, lead);
  assert.equal(after.lo, Math.min(...ctr.parts.slice(lead).flatMap((p) => [p.h0, p.h1])));
  assert.ok(after.up0 >= 0 && after.hi === Math.max(...ctr.parts.slice(lead).flatMap((p) => [p.h0, p.h1])));
  const p = trackProgress(ses({ segs: climb, segIndex: lead, workout: w, chartPos: climb[lead].start }));
  assert.match(p, /^0\.0 of \d+\.\d km · \+0 of \d+ m$/);
  assert.deepEqual([4000, 5001, 12001, 40001].map(trackKmStep), [1, 2, 5, 10]);
  ok('chart: the road (distance to x, elevation band and floor, 60 m minimum), a real climb\'s view after its lead, km marks');
}

// ---- small helpers
{
  assert.deepEqual(smoothPower([{ power: 100 }, { power: 200 }, {}, { power: 300 }, { power: 400 }, { power: 500 }]), [100, 150, 100, 150, 200, 280]); // 5 s trailing
  assert.deepEqual(smoothHr([{ hr: 120 }, { hr: 126 }, { hr: 0 }, { hr: 140 }, { hr: 143 }, { hr: 146 }, { hr: 149 }]), [120, 123, 0, 140, 141.5, 143, 146]); // 3 s, a gap restarts it
  assert.deepEqual([msgMs('Go.'), msgMs('x'.repeat(50)), msgMs('x'.repeat(200))], [5000, 6000, 11000]);
  const end = (rem, x = {}) => intervalEnding(ses({ segRemaining: rem, ...x }));
  assert.deepEqual([end({ sec: 10.4 }), end({ sec: 10.6 }), end({ sec: 0 }), end({ sec: 5 }, { paused: true }), end({ sec: 5 }, { started: false })], [true, false, false, false, false]);
  assert.deepEqual([end({ m: 90 }, { bike: { v: 10 } }), end({ m: 120 }, { bike: { v: 10 } }), end({ m: 5 }, { bike: { v: 0.5 } })], [true, false, false]);
  assert.equal(workoutLeft(ses({ chartPos: 600 })), '53:00');
  assert.equal(workoutLeft(ses({ segIndex: -1 })), 'Done');
  assert.deepEqual([fmtDist(999.6), fmtDist(1234), segAmount(ss[1]), segAmount({ dist: 150 })], ['1000 m', '1.23 km', '12:00', '150 m']);
  assert.equal(rt.filter((g) => g.untilFail).length, 12); // the ramp test the takeover coaches (smoke: "Here we go")
  ok('helpers: power and HR smoothing, message times, the last-10-seconds pulse, time left, distances');
}

console.log(`ride: ${n} tests passed`);
