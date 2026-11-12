// Ride page (js/ridepage.js): interval timing, page and chart markup, .FIT export from a synced document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRide } from '../js/stats.js';
import { flatten } from '../js/engine/workout.js';
import { encodeActivity } from '../js/fit.js';
import { rideSegs, pageHtml, chartSvg, tipHtml, selHtml, samplesFromDoc, laneKeys, segName, doneHeadline, lastSameWorkout, vsLastTime, doneBarHtml } from '../js/ridepage.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const zoneHex = () => '#f47b20', gradeHex = () => '#d2a531';
const tok = { ink: '#000', rule: '#ccc', faint: '#999', ftp: '#888', hr: '#c4196e', info: '#1f5fbf', infoLine: '#b9cdea', band: '#eee', dim: 'rgba(0,0,0,.5)', sheet: '#fff' };

// a VO2 ride recorded the way Session does: si = workout step, the rider skips 60 s of rep 2
const wo = JSON.parse(fs.readFileSync(new URL('../workouts/vo2-4x4-108.json', import.meta.url)));
const segs = flatten(wo), ftp = 200, t0 = Date.parse('2026-11-11T18:42:00');
const samples = [];
let rt = 0;
for (let wt = 0; wt < segs.at(-1).end; wt++) {
  const si = segs.findIndex((s) => wt < s.end), seg = segs[si];
  if (seg.rep?.i === 2 && seg.from > 1 && wt - seg.start >= 180) continue; // skipped the last minute of rep 2
  const target = Math.round((seg.from + (seg.to - seg.from) * ((wt - seg.start) / seg.dur)) * ftp);
  samples.push({ t: t0 + rt * 1000, wt, si, st: wt - seg.start, power: target, target, hr: 140 + (seg.from > 1 ? 30 : 0), cadence: seg.from > 1 ? 98 : 85, speed: 8, distance: rt * 8, grade: 0 });
  rt++;
}
const doc = buildRide(samples, { name: wo.name, workoutId: wo.id, tags: wo.tags, ftp, startMs: t0, segs });

assert.equal(doc.streams.seg.length, samples.length);
assert.deepEqual(doc.streams.seg.slice(0, 3), [0, 0, 0]);
const rs = rideSegs(doc, segs);
assert.equal(rs.length, segs.length);
const rep2 = rs.find((s) => s.rep === '2/4' && s.kind === 'erg' && s.work);
assert.equal(rep2.end - rep2.start, 180, 'rep 2 lasted 3 min in ride time, not 4');
const rec2 = rs[rs.indexOf(rep2) + 1];
assert.equal(rec2.start, rep2.end, 'the recovery starts when the skipped rep ended');
assert.equal(segName(rep2), 'VO2max 2 of 4');
assert.ok(rep2.cad && rep2.cad.lo === 95, 'cadence target from the workout');
ok('intervals timed from the seg stream, skips included');

// older synced rides have no seg stream: the workout's own timing is the fallback
const old = structuredClone(doc); delete old.streams.seg;
const rsOld = rideSegs(old, segs);
assert.equal(rsOld.length, segs.length);
assert.equal(rsOld[0].start, 0);
assert.ok(rsOld.every((s) => s.end <= old.streams.power.length));
assert.deepEqual(rideSegs(old, null), [], 'no workout and no seg stream: no interval bands');
ok('fallback timing for rides synced before the seg stream');

const html = pageHtml(doc, { segs: rs, ftp, zoneHex, gradeHex, season: { 5: 999, 60: 100, 300: 100, 1200: 100 }, canFit: true, canDelete: false, sel: rep2.i, backLabel: 'Training' });
assert.match(html, /VO2max 4 x 4 min/);
assert.match(html, /Intervals<\/div>/, 'compliance stat');
assert.match(html, /id="rd-ints"/);
assert.match(html, /class=" sel"|class="\s*sel"/, 'selected row');
assert.match(html, /90-day best 999/);
assert.match(html, /Best in 90 days/);
assert.match(html, /data-rd="fit"/);
assert.doesNotMatch(html, /data-rd="delete"/);
assert.match(html, /&middot; ERG &middot;/);
const ch = chartSvg(doc, { width: 1000, phone: false, ftp, segs: rs, sel: rep2.i, tok, zoneHex, gradeHex });
assert.deepEqual(ch.geo.lanes.map((l) => l.k), ['power', 'hr', 'cadence']);
assert.match(ch.svg, /class="rd-strip"/);
assert.ok(!/NaN|undefined/.test(ch.svg), 'clean svg');
assert.ok(ch.geo.X(doc.streams.power.length) <= 1000);
const tip = tipHtml(doc, rs, rep2.start + 10);
assert.match(tip, /VO2max 2 of 4/); assert.match(tip, /216 W <span>target 216/); assert.match(tip, /170 <span>bpm/);
assert.match(selHtml(doc, rep2), /VO2max 2 of 4.*Show all/s);
ok('page, chart and readout for an ERG ride');

// imported outdoor ride: no power, no target or grade, no intervals
const imp = buildRide(Array.from({ length: 1800 }, (_, i) => ({ t: t0 + i * 1000, power: 0, hr: 130 + (i % 20), cadence: 80, speed: 7, distance: i * 7 })), { name: 'Morning ride', tags: ['imported', 'outdoor'], ftp, startMs: t0 });
Object.assign(imp.summary, { np: null, avgP: null, if: null, kj: null, bests: {}, zones: null, tssFrom: 'hr' });
delete imp.streams.power; delete imp.streams.grade; delete imp.streams.target; delete imp.streams.gear; delete imp.streams.seg;
imp.intervals = [];
assert.deepEqual(laneKeys(imp), ['hr', 'cadence', 'speed']);
const ih = pageHtml(imp, { segs: [], ftp, zoneHex, gradeHex, canFit: true });
assert.doesNotMatch(ih, /NP<\/div>|rd-ints|Best power|Time in zones/);
assert.match(ih, /from heart rate/);
assert.match(ih, /Imported/);
const ic = chartSvg(imp, { width: 390, phone: true, ftp, segs: [], tok, zoneHex, gradeHex });
assert.ok(!/NaN|undefined/.test(ic.svg));
assert.doesNotMatch(tipHtml(imp, [], 100), / W/);
ok('imported ride without power');

// a ride only in rodillo-data still exports a .FIT
const sm = samplesFromDoc({ ...doc, laps: [] });
assert.equal(sm.length, doc.streams.power.length);
assert.equal(sm[1].t - sm[0].t, 1000);
assert.ok(sm.at(-1).distance > sm[1].distance);
const fit = encodeActivity(sm, [], { tss: doc.summary.tss });
assert.ok(fit.length > 1000 && fit[8] === 0x2e);
ok('.FIT from a synced ride document');

// ---- end of ride: effort scored against the plan, done bar
{
  const w5 = JSON.parse(fs.readFileSync(new URL('../workouts/vo2-5x4-110.json', import.meta.url)));
  const sg = flatten(w5, ftp), T0 = Date.parse('2026-11-12T18:00:00');
  // rider drops effort to 95% on reps 4 and 5 and holds the lowered target exactly
  const sm = [];
  for (let wt = 0; wt < sg.at(-1).end; wt++) {
    const si = sg.findIndex((s) => wt < s.end), g = sg[si];
    const plan = Math.round((g.from + (g.to - g.from) * ((wt - g.start) / g.dur)) * ftp);
    const eff = g.rep?.i >= 4 ? 0.95 : undefined;
    const target = Math.round(plan * (eff ?? 1));
    sm.push({ t: T0 + wt * 1000, wt, si, st: wt - g.start, power: target, target, plan, eff, hr: 150, cadence: 95, speed: 8, distance: wt * 8, grade: 0 });
  }
  const d = buildRide(sm, { name: w5.name, workoutId: w5.id, tags: w5.tags, ftp, startMs: T0, segs: sg });
  const reps = d.intervals.filter((x) => x.work && x.rep);
  assert.deepEqual(reps.map((x) => x.pct), [100, 100, 100, 95, 95]);
  assert.deepEqual(reps.map((x) => x.effort), [undefined, undefined, undefined, 95, 95]);
  assert.equal(reps[3].target, 220); // the planned watts, not the 209 W sent
  assert.equal(d.summary.compliance.reps, 5); // the opener doesn't count
  assert.ok(Array.isArray(d.streams.plan));
  assert.deepEqual(doneHeadline(d), { h: 'Done. 5 of 5 reps on target.', note: 'Effort lowered to 95% on 2 reps.' });
  // 90% effort: under target
  const lo = sm.map((x) => (x.eff ? { ...x, eff: 0.9, power: Math.round(x.plan * 0.9), target: Math.round(x.plan * 0.9) } : x));
  const d2 = buildRide(lo, { name: w5.name, workoutId: w5.id, tags: w5.tags, ftp, startMs: T0, segs: sg });
  assert.equal(doneHeadline(d2).h, 'Done. 3 of 5 reps on target.');
  // old rides (no plan): unchanged, scored against the target sent
  const old = buildRide(sm.map(({ plan, eff, ...x }) => x), { name: w5.name, workoutId: w5.id, ftp, startMs: T0, segs: sg });
  assert.deepEqual(old.intervals.filter((x) => x.work && x.rep).map((x) => x.pct), [100, 100, 100, 100, 100]);
  assert.equal(old.streams.plan, undefined);
  assert.equal(doneHeadline({ intervals: [] }).h, 'Done. Nice work.');

  // vs last time: same workout, before this ride, demo rides skipped
  const st = d.summary;
  const rows = [
    { summary: { id: '2026-11-11T1800', workoutId: 'vo2-5x4-110', compliance: { avg: 90 }, avgHr: 170, ftp: 200 }, demo: true },
    { summary: { id: '2026-11-04T1800', workoutId: 'vo2-5x4-110', compliance: { avg: 96 }, avgHr: 156, ftp: 200 } },
    { summary: { id: '2026-10-28T1800', workoutId: 'vo2-5x4-110', compliance: { avg: 92 }, avgHr: 160, ftp: 200 } },
    { summary: { id: '2026-11-13T1800', workoutId: 'vo2-5x4-110', compliance: { avg: 99 }, avgHr: 150, ftp: 200 } },
    { summary: { id: '2026-11-05T1800', workoutId: 'z2-60', ftp: 200 } },
  ];
  const prev = lastSameWorkout(st, rows);
  assert.equal(prev.id, '2026-11-04T1800');
  const vs = vsLastTime(st, prev);
  assert.equal(vs.items[0].k, 'On target');
  assert.equal(vs.items[1].k, 'Avg HR');
  assert.equal(vsLastTime(st, { ...prev, ftp: 190 }).items.length, 1); // other FTP: no HR comparison
  assert.equal(lastSameWorkout({ ...st, workoutId: null }, rows), null);
  const html = doneBarHtml({ headline: doneHeadline(d), vs, sync: { state: 'ok', text: 'Synced' }, ftp: null });
  for (const t of ['Stop and save your Garmin', 'data-rd="done"', 'data-rd="discard"', 'data-rd="fit"', 'Effort lowered']) assert.ok(html.includes(t), t);
  assert.ok(!html.includes('—'));
  assert.ok(pageHtml(d, { segs: rideSegs(d, sg), ftp, zoneHex, gradeHex, done: { headline: doneHeadline(d), vs: null, sync: { state: 'off', text: 'x' }, ftp: null } }).includes('95% effort'));
  ok('end of ride: reps scored against the plan, effort noted, vs last time, done bar');
}

console.log(`ridepage: ${n} tests passed`);
