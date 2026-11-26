// Phone ride screen (js/ridephone.js): the pure pieces. What the top line, the hero card, the power gauge and the
// boxes (heart rate, cadence, effort or gear), the Next line and the buttons say, the label over the chart / list, and
// the phone chart's geometry. The DOM and canvas half: test/ridephone-dom.mjs; in Chrome: the phone ride run in
// test/smoke.mjs. Expectations are written out by hand (FTP 200), not computed with the module's own formulas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { phoneTop, phoneHero, phoneBoxes, phoneNext, phoneButtons, phoneViewK, phoneFreeScale, phoneScale, phoneSlices } from '../js/ridephone.js';
import { repBadge } from '../js/ride.js';
import { flatten, track, trackDist, trackClimbed } from '../js/engine/workout.js';
import { Gearbox } from '../js/engine/drivetrain.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const W = (id) => JSON.parse(fs.readFileSync(new URL(`../workouts/${id}.json`, import.meta.url)));
const v = { ftp: 200, riderKg: 80, hrBpm: undefined, track: null, zoneHex: (f) => `zone(${f.toFixed(2)})`, gradeHex: (g) => `grade(${g.toFixed(3)})` };
/** The gauge dot's left as a number (the string carries float noise: 0.2 / 0.4 x 100 = 49.999...). */
const at = (b) => (b.gaugeAt === null ? null : +parseFloat(b.gaugeAt).toFixed(6));
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&#9650;/g, '▲').replace(/&#9660;/g, '▼').replace(/&minus;/g, '−').replace(/&amp;/g, '&').replace(/&lt;/g, '<');

const ss = flatten(W('sweetspot-3x12')); // 0 warm-up ramp 45-70% 10:00, 1 sweet spot 90% 12:00 @ 90 rpm (1/3), 2 recovery 50% 4:00 (1/3), ..., 7 cool-down; ends at 3780 s
const cr = flatten(W('sim-climb-repeats')); // 0 warm-up roll 1% 10:00, 1 climb 6% 6:00 @ 85 rpm, aim 190-210 W (1/4), 2 flat roll 0% 4:00; ends at 3300 s

/** A session as renderPhone() sees it: the fields the phone screen reads, defaults for an ERG ride at 100%. */
function ses(x = {}) {
  const segs = 'segs' in x ? x.segs : ss, segIndex = x.segIndex ?? 1;
  const seg = segs && segIndex >= 0 ? segs[segIndex] : null;
  return {
    segs, segIndex, seg, segProgress: 0.25, segRemaining: seg ? (seg.dist ? { m: seg.dist * 0.75 } : { sec: seg.dur * 0.75 }) : null,
    target: null, intensity: 1, gradeOffset: 0, grade: 0, ergOff: false, mode: 'erg', chartPos: seg ? seg.start + 10 : 0,
    trainer: { data: { hr: 0, cadence: 0 } }, powerShown: 0, samples: [], cadStatus: null, aimStatus: null,
    gb: new Gearbox(), bike: { v: 0, dist: 0 }, elapsed: 0, started: true, paused: false, name: 'Sweet spot 3 x 12',
    ...x,
  };
}

// ---- top line
{
  assert.deepEqual(phoneTop(ses({ elapsed: 1234, chartPos: 610 })), { elapsed: '20:34', name: 'Sweet spot 3 x 12', leftK: 'Left', left: '52:50' });
  assert.equal(phoneTop(ses({ name: 'Mine <b>&</b>' })).name, 'Mine &lt;b&gt;&amp;&lt;/b&gt;');
  // workout over: 0:00 left; free ride: the distance instead (metres under a km)
  assert.deepEqual(phoneTop(ses({ segIndex: -1, seg: null, chartPos: 3790 })).left, '0:00');
  assert.deepEqual(phoneTop(ses({ segs: null, segIndex: -1, bike: { v: 8, dist: 850 } })), { elapsed: '0:00', name: 'Sweet spot 3 x 12', leftK: 'Distance', left: '850 m' });
  assert.equal(phoneTop(ses({ segs: null, segIndex: -1, bike: { v: 8, dist: 12345 } })).left, '12.35 km');
  // distance steps make the time left an estimate
  const road = flatten({ steps: [{ dur: 60, grade: 0 }, { dist: 500, grade: 4 }] });
  assert.match(phoneTop(ses({ segs: road, segIndex: 1, chartPos: 70 })).left, /^~\d+:\d\d$/);
  ok('top line: elapsed, name escaped, time left (0:00 when done, ~ with distance steps), distance in a free ride');
}

// ---- hero card
{
  let h = phoneHero(ses({ target: 180 }), v);
  assert.deepEqual(h, { zc: 'zone(0.90)', label: 'Sweet spot', rep: repBadge(ss, 1), count: '9:00', target: '180 W', targetSub: '90% FTP &middot; 90 rpm' });
  // no target yet: the plan's watts at the effort; 105% says so in the % line
  h = phoneHero(ses({ intensity: 1.05 }), v);
  assert.equal(h.target, '189 W');
  assert.equal(text(h.targetSub), '95% FTP · 90 rpm');
  // the ERG guard's eased target is what the hero says
  assert.equal(phoneHero(ses({ target: 108 }), v).target, '108 W');
  // a ramp: the live target and its zone; no cadence
  h = phoneHero(ses({ segIndex: 0, segProgress: 0.5, segRemaining: { sec: 300 } }), v);
  assert.deepEqual(h, { zc: 'zone(0.57)', label: 'Warm-up', rep: '', count: '5:00', target: '115 W', targetSub: '57% FTP' }); // 0.575 x 100 is 57.4999... in doubles
  // ERG off on an ERG step; the label is escaped
  assert.equal(text(phoneHero(ses({ ergOff: true }), v).label), 'Sweet spot · ERG off');
  assert.equal(phoneHero(ses({ segs: [{ ...ss[1], label: 'A<b>', rep: null }], segIndex: 0 }), v).label, 'A&lt;b&gt;');
  // slope: grade with the profile offset, its color, the aim in watts, cadence
  h = phoneHero(ses({ segs: cr, segIndex: 1, mode: 'sim', gradeOffset: 0.01 }), v);
  assert.deepEqual(h, { zc: 'grade(0.070)', label: 'Climb', rep: repBadge(cr, 1), count: '4:30', target: '7%', targetSub: 'grade, aim 200 W &middot; 85 rpm' });
  h = phoneHero(ses({ segs: cr, segIndex: 0, mode: 'sim', gradeOffset: -0.02 }), v);
  assert.deepEqual(h, { zc: 'grade(-0.010)', label: 'Warm-up roll', rep: '', count: '7:30', target: '-1%', targetSub: 'grade, use your gears' });
  // a distance step counts metres, then km
  const road = flatten({ steps: [{ dist: 400, grade: 5 }, { dist: 2000, grade: 3 }] });
  assert.equal(phoneHero(ses({ segs: road, segIndex: 0, mode: 'sim' }), v).count, '300 m');
  assert.equal(phoneHero(ses({ segs: road, segIndex: 1, mode: 'sim' }), v).count, '1.50 km');
  // workout complete, free ride
  assert.deepEqual(phoneHero(ses({ segIndex: -1, seg: null }), v), { zc: 'var(--ok-bg)', label: 'Workout complete', count: 'Done', target: '', targetSub: 'Keep riding. End ride is in the menu.', rep: '' });
  assert.deepEqual(phoneHero(ses({ segs: null, segIndex: -1, grade: 0.035 }), v), { zc: 'grade(0.035)', label: 'Free ride', count: '3.5%', target: '', targetSub: 'D-pad &#9650;&#9660; changes the grade', rep: '' });
  ok('hero card: hold, effort, eased target, ramp, ERG off, escaping, slope grade with offset and aim, metres, complete, free ride');
}

// ---- power gauge, heart rate, cadence, effort / gear
{
  let b = phoneBoxes(ses({ target: 200, powerShown: 199.6, trainer: { data: { hr: 141.4, cadence: 88.6 } } }), v);
  assert.equal(b.power, 200);
  assert.match(b.gaugeAt, /%$/);
  assert.equal(at(b), 50); // on target: the middle
  assert.equal(b.powerState, '');
  assert.equal(b.powerSub, '');
  assert.equal(b.hr, 141);
  assert.equal(b.cad, 89);
  // the ends are ±20%, clamped past them
  assert.equal(at(phoneBoxes(ses({ target: 200, powerShown: 160 }), v)), 0);
  assert.equal(at(phoneBoxes(ses({ target: 200, powerShown: 220 }), v)), 75);
  assert.equal(at(phoneBoxes(ses({ target: 200, powerShown: 300 }), v)), 100);
  assert.equal(at(phoneBoxes(ses({ target: 200, powerShown: 100 }), v)), 0);
  // no target and no aim: the gauge is off
  assert.equal(phoneBoxes(ses(), v).gaugeAt, null);
  assert.equal(phoneBoxes(ses({ segs: cr, segIndex: 0, mode: 'sim', powerShown: 150 }), v).gaugeAt, null);
  // heart rate: the strap over the trainer's, -- with neither
  assert.equal(phoneBoxes(ses({ trainer: { data: { hr: 120 } } }), { ...v, hrBpm: 150.6 }).hr, 151);
  assert.equal(phoneBoxes(ses({ trainer: { data: {} } }), v).hr, '--');
  assert.equal(phoneBoxes(ses({ trainer: {} }), v).cad, 0);
  // cadence target: ok / low / high
  assert.deepEqual([phoneBoxes(ses({ cadStatus: 'ok' }), v).cadState, phoneBoxes(ses({ cadStatus: 'ok' }), v).cadSub], ['ok', '90 rpm']);
  assert.deepEqual([phoneBoxes(ses({ cadStatus: 'low' }), v).cadState, text(phoneBoxes(ses({ cadStatus: 'low' }), v).cadSub)], ['bad', '▲ faster']);
  assert.deepEqual([phoneBoxes(ses({ cadStatus: 'high' }), v).cadState, text(phoneBoxes(ses({ cadStatus: 'high' }), v).cadSub)], ['bad', '▼ slower']);
  assert.deepEqual([phoneBoxes(ses({ segIndex: 2, cadStatus: 'low' }), v).cadState, phoneBoxes(ses({ segIndex: 2 }), v).cadSub], ['bad', '']); // no target on the recovery
  // effort box in ERG
  b = phoneBoxes(ses(), v);
  assert.deepEqual([b.m3k, b.m3, b.m3sub, b.up, b.down], ['Effort', '100%', 'as planned', false, false]);
  b = phoneBoxes(ses({ intensity: 1.03 }), v);
  assert.deepEqual([b.m3, b.m3sub, b.up, b.down], ['103%', 'harder than plan', true, false]);
  b = phoneBoxes(ses({ intensity: 0.95 }), v);
  assert.deepEqual([b.m3, b.m3sub, b.up, b.down], ['95%', 'easier than plan', false, true]);
  ok('power box: gauge in the middle on target, ±20% at the ends, off with no target; HR strap first; cadence ok / low / high; effort box');
}
{
  // slope: the aim works like the cadence box; the gauge centres on it
  const climb = (x) => ses({ segs: cr, segIndex: 1, mode: 'sim', powerShown: 190, ...x });
  let b = phoneBoxes(climb(), v);
  assert.deepEqual([at(b), b.powerState, b.powerSub], [37.5, '', '190-210 W']); // 190 of 200 W; settling: just the band
  b = phoneBoxes(climb({ aimStatus: 'ok' }), v);
  assert.deepEqual([b.powerState, b.powerSub], ['ok', '190-210 W']);
  b = phoneBoxes(climb({ aimStatus: 'low' }), v);
  assert.deepEqual([b.powerState, text(b.powerSub)], ['bad', '▲ push harder']);
  b = phoneBoxes(climb({ aimStatus: 'high' }), v);
  assert.deepEqual([b.powerState, text(b.powerSub)], ['bad', '▼ ease off']);
  // ERG back on over a slope step (mode erg): no aim; an aim on an ERG step never counts
  b = phoneBoxes(climb({ mode: 'erg', aimStatus: 'low' }), v);
  assert.deepEqual([b.gaugeAt, b.powerState, b.powerSub], [null, '', '']);
  // gear box: 2x (ring and cog positions, teeth and speed), 1x, sequential
  b = phoneBoxes(climb({ bike: { v: 8.2, dist: 0 } }), v);
  assert.deepEqual([b.m3k, b.m3, b.m3sub, b.up, b.down], ['Gear', '2×6', '50×19 · 30 km/h', false, false]);
  b = phoneBoxes(climb({ gb: new Gearbox('mtb-1x12-sram-t-32'), bike: { v: 5, dist: 0 } }), v);
  assert.deepEqual([b.m3, b.m3sub], ['10', '32×14 · 18 km/h']);
  b = phoneBoxes(climb({ gb: new Gearbox('zwift-24'), bike: { v: 5, dist: 0 } }), v);
  assert.deepEqual([b.m3, b.m3sub], ['12', '18 km/h']);
  // free ride: gear box, no gauge
  b = phoneBoxes(ses({ segs: null, segIndex: -1, mode: 'sim', powerShown: 150 }), v);
  assert.deepEqual([b.gaugeAt, b.m3k, b.cadSub], [null, 'Gear', '']);
  ok('power box on a slope step: settling band, ok, push harder, ease off; no aim in ERG; gear box 2x, 1x, sequential; free ride');
}

// ---- Next line
{
  assert.equal(text(phoneNext(ses(), v)), 'Next 4:00 @ 100 W');
  assert.match(phoneNext(ses(), v), /background:zone\(0\.50\)/);
  assert.equal(text(phoneNext(ses({ segIndex: 0 }), v)), 'Next 12:00 @ 180 W · 90 rpm · rep 1/3');
  assert.equal(text(phoneNext(ses({ segIndex: 0, intensity: 1.01 }), v)), 'Next 12:00 @ 182 W · 90 rpm · rep 1/3');
  // a ramp next: its range, and the zone it starts in
  const ramp = flatten({ steps: [{ dur: 60, power: 0.5 }, { dur: 300, from: 0.6, to: 0.9 }] });
  assert.equal(text(phoneNext(ses({ segs: ramp, segIndex: 0 }), v)), 'Next 5:00 @ 120-180 W');
  assert.match(phoneNext(ses({ segs: ramp, segIndex: 0 }), v), /background:zone\(0\.60\)/);
  // slope: the grade with the profile offset, its color too
  const sim = phoneNext(ses({ segs: cr, segIndex: 0, mode: 'sim', gradeOffset: 0.01 }), v);
  assert.equal(text(sim), 'Next 6:00 @ 7% · 85 rpm · rep 1/4');
  assert.match(sim, /background:grade\(0\.070\)/);
  // a distance step
  const road = flatten({ steps: [{ dur: 60, grade: 0 }, { dist: 1500, grade: 4 }] });
  assert.equal(text(phoneNext(ses({ segs: road, segIndex: 0, mode: 'sim' }), v)), 'Next 1.50 km @ 4%');
  // last interval; workout complete and free ride: speed and distance
  assert.equal(phoneNext(ses({ segIndex: ss.length - 1 }), v), 'Last interval');
  assert.equal(text(phoneNext(ses({ segIndex: -1, seg: null, bike: { v: 8.25, dist: 15300 } }), v)), '29.7 km/h · 15.30 km');
  assert.equal(text(phoneNext(ses({ segs: null, segIndex: -1, bike: { v: 0, dist: 0 } }), v)), '0.0 km/h · 0 m');
  ok('Next line: hold, cadence, effort, a ramp and its start zone, slope with the offset, distance, last, speed and distance');
}

// ---- buttons and the sheet
{
  assert.deepEqual(phoneButtons(ses()), { minus: '&minus;1%', plus: '+1%', pause: 'Pause', hidden: { 'rp-grade-row': true, 'rp-skip': false, 'rp-lap': true, 'rp-erg': false }, erg: 'ERG off' });
  assert.equal(phoneButtons(ses({ started: false, paused: true })).pause, 'Start');
  assert.equal(phoneButtons(ses({ paused: true })).pause, 'Resume');
  // slope step: gears, the grade row, no ERG button (unless ERG was turned off on an ERG step)
  assert.deepEqual(phoneButtons(ses({ segs: cr, mode: 'sim' })), { minus: 'Gear &minus;', plus: 'Gear +', pause: 'Pause', hidden: { 'rp-grade-row': false, 'rp-skip': false, 'rp-lap': true, 'rp-erg': true }, erg: 'ERG off' });
  const off = phoneButtons(ses({ mode: 'sim', ergOff: true }));
  assert.deepEqual([off.hidden['rp-erg'], off.erg, off.hidden['rp-grade-row']], [false, 'ERG back on', false]);
  assert.equal(phoneButtons(ses({ segs: cr, mode: 'sim', ergOff: true })).hidden['rp-erg'], false);
  // free ride and workout complete: Lap instead of Skip, no ERG button
  assert.deepEqual(phoneButtons(ses({ segs: null, segIndex: -1, mode: 'sim' })).hidden, { 'rp-grade-row': false, 'rp-skip': true, 'rp-lap': false, 'rp-erg': true });
  assert.deepEqual(phoneButtons(ses({ segIndex: -1, seg: null })).hidden, { 'rp-grade-row': true, 'rp-skip': true, 'rp-lap': false, 'rp-erg': true });
  ok('buttons: ERG effort / slope gears, Start / Pause / Resume, the sheet\'s grade row, Skip or Lap, ERG off / back on');
}

// ---- label over the chart / list
{
  assert.equal(phoneViewK(ses({ segIndex: 0 })), 'Workout &middot; 0/8 done');
  assert.equal(phoneViewK(ses({ segIndex: 3 })), 'Workout &middot; 3/8 done');
  assert.equal(phoneViewK(ses({ segIndex: -1, seg: null })), 'Workout &middot; 8/8 done');
  // a slope-only workout: the road ("2.6 of 21.8 km · +29 of 495 m"), from the road laid out here
  const s = ses({ segs: cr, segIndex: 1, mode: 'sim', chartPos: 700 }), tr = track(cr), d = trackDist(tr, cr, 700);
  assert.equal(phoneViewK(s), `${(d / 1000).toFixed(1)} of ${(tr.D / 1000).toFixed(1)} km · +${Math.round(trackClimbed(tr, d))} of ${Math.round(tr.ascent / 5) * 5} m`);
  assert.match(phoneViewK(s), /^\d+\.\d of \d+\.\d km · \+\d+ of \d+[05] m$/); // the total to the nearest 5 m
  ok('label over the chart / list: n/N done (all done after the end), road progress on a slope-only workout');
}

// ---- phone chart geometry
{
  // free ride: top at FTP x 1.5 (300 W) or the window's peak + 20 W
  let f = phoneFreeScale([{ power: 150 }, { power: 250 }], 200, 400, 300);
  assert.equal(f.maxP, 300);
  assert.equal(f.Y(0), 400);
  assert.equal(f.Y(150), 250);
  assert.equal(f.Y(300), 100);
  assert.equal(f.Y(900), 100); // clipped
  f = phoneFreeScale([{ power: 150 }, { power: 380 }], 200, 400, 300);
  assert.equal(f.maxP, 400);
  assert.equal(f.Y(200), 250);
  assert.equal(phoneFreeScale([], 200, 400, 300).maxP, 300);
  // a workout: the hardest ERG step at the effort (at least 130%) + 8%, or the last 30 minutes' peak + 10 W
  let w = phoneScale(ses(), 200, 400, 300);
  assert.ok(Math.abs(w.maxP - 280.8) < 1e-9); // 1.3 x 1.08 x 200
  assert.equal(w.Yp(0), 400);
  assert.ok(Math.abs(w.Yp(140.4) - 250) < 1e-9);
  const vo2 = flatten({ steps: [{ dur: 60, power: 0.5 }, { dur: 30, power: 1.5 }] });
  w = phoneScale(ses({ segs: vo2, segIndex: 0, intensity: 1.1 }), 200, 400, 300);
  assert.ok(Math.abs(w.maxP - 356.4) < 1e-9); // 1.5 x 1.1 x 1.08 x 200
  w = phoneScale(ses({ samples: [{ power: 500 }, ...Array.from({ length: 1800 }, () => ({ power: 100 }))] }), 200, 400, 300);
  assert.ok(Math.abs(w.maxP - 280.8) < 1e-9); // the spike is 1801 samples ago: out of the window
  w = phoneScale(ses({ samples: [{ power: 400 }, ...Array.from({ length: 1000 }, () => ({ power: 100 }))] }), 200, 400, 300);
  assert.equal(w.maxP, 410); // a spike 17 minutes ago still counts
  w = phoneScale(ses({ samples: [...Array.from({ length: 1799 }, () => ({ power: 100 })), { power: 500 }] }), 200, 400, 300);
  assert.equal(w.maxP, 510);
  assert.equal(w.Yp(1000), 100);
  assert.equal(phoneScale(ses({ segs: cr, mode: 'sim' }), 200, 400, 300).maxP, 1.3 * 1.08 * 200); // slope only: the 130% floor
  // a ramp is drawn in slices of 3 px (per device pixel), anything else in one
  assert.equal(phoneSlices(ss[0], 0, 90, 1), 30);
  assert.equal(phoneSlices(ss[0], 0, 91, 1), 31);
  assert.equal(phoneSlices(ss[0], 0, 90, 2), 15);
  assert.equal(phoneSlices(ss[0], 10, 10, 1), 1);
  assert.equal(phoneSlices(ss[1], 0, 90, 1), 1);
  assert.equal(phoneSlices(cr[1], 0, 90, 1), 1);
  ok('phone chart: free ride scale (FTP x 1.5 or peak + 20 W), workout scale (hardest step x 1.08 or the last 30 min), ramp slices');
}

console.log(`ridephone: ${n} tests passed`);
