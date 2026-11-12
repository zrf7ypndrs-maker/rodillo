import assert from 'node:assert/strict';
import { bests, normalizedPower, decoupling, buildRide, loadSeries, weekly, tssByZone, powerCurve, ftpEstimate, ftpFromRide, rideIdFor } from '../js/stats.js';
import { GitHubSync } from '../js/sync.js';
import { flatten } from '../js/engine/workout.js';
import fs from 'node:fs';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };

// ---- bests / NP
const p = [...Array(600).fill(150), ...Array(300).fill(300), ...Array(600).fill(150)];
const b = bests(p);
assert.equal(b[300], 300); assert.equal(b[60], 300); assert.equal(b[1200], Math.round((300 * 300 + 900 * 150) / 1200));
assert.ok(normalizedPower(p) > 190 && normalizedPower(p) < 230);
ok('bests and NP');

// ---- decoupling: steady power, HR drifting up 8% in second half
const N = 3600;
const pw = Array(N).fill(140), hr = Array.from({ length: N }, (_, i) => (i < 1950 ? 130 : 141));
const d = decoupling(pw, hr);
assert.ok(d > 6 && d < 9, `decoupling ${d}`);
assert.equal(decoupling(pw.slice(0, 1200), hr.slice(0, 1200)), null);
ok('aerobic decoupling');

// ---- intervals + compliance from a VO2 workout where the rider fades on the last rep
const wo = JSON.parse(fs.readFileSync(new URL('../workouts/vo2-5x4.json', import.meta.url)));
const segs = flatten(wo);
const ftp = 200, t0 = Date.parse('2026-11-10T18:30:00');
const samples = [];
for (let t = 0; t < segs.at(-1).end; t++) {
  const seg = segs.find((s) => t < s.end);
  const f = seg.from + (seg.to - seg.from) * ((t - seg.start) / seg.dur);
  let target = Math.round(f * ftp), power = target;
  if (seg.rep?.i === 5 && f > 1) power = Math.round(target * 0.9); // fades on rep 5
  samples.push({ t: t0 + t * 1000, wt: t, power, target, hr: 150, cadence: 95, speed: 9, distance: t * 9, grade: 0 });
}
const ride = buildRide(samples, { name: wo.name, workoutId: wo.id, tags: wo.tags, ftp, startMs: t0, segs });
const work = ride.intervals.filter((x) => x.work);
assert.equal(work.length, 6, 'opener + 5 reps'); // opener at 95% counts as work
const reps = work.filter((x) => x.rep);
assert.deepEqual(reps.map((x) => x.pct), [100, 100, 100, 100, 90]);
assert.equal(ride.summary.compliance.min, 90);
assert.equal(ride.summary.id, rideIdFor(t0));
assert.equal(ride.streams.power.length, samples.length);
assert.ok(ride.summary.tss > 50 && ride.summary.tss < 90, `tss ${ride.summary.tss}`);
ok(`interval compliance (TSS ${ride.summary.tss}, IF ${ride.summary.if})`);

// ---- load series / weekly / curve / ftp
const fake = [];
const base = new Date('2026-09-01T18:00:00');
for (let i = 0; i < 70; i++) {
  if (i % 7 === 1 || i % 7 === 3 || i % 7 === 5) {
    const dd = new Date(base); dd.setDate(dd.getDate() + i);
    fake.push({ id: rideIdFor(+dd), start: dd.toISOString(), durSec: 3600, tss: 60, bests: { 60: 280, 1200: 210 }, tags: i === 64 ? ['test'] : [] });
  }
}
const series = loadSeries(fake, new Date('2026-11-09T12:00:00'), 200);
const last = series.at(-1);
assert.ok(last.ctl > 15 && last.ctl < 26, `ctl ${last.ctl}`);
assert.ok(Math.abs(last.atl - 180 / 7) < 8, `atl ${last.atl}`);
const wk = weekly(fake, 4, new Date('2026-11-09T12:00:00'));
assert.equal(wk.length, 4);
assert.ok(wk.slice(0, 3).every((w) => w.tss === 180 || w.tss === 120 || w.tss === 0), JSON.stringify(wk));
assert.equal(powerCurve(fake)[1200], 210);
const est = ftpEstimate(fake, Date.parse('2026-11-09T12:00:00'));
assert.equal(est.from20min, 200); assert.equal(est.fromRamp, 210);
ok(`load series (CTL ${last.ctl}, ATL ${last.atl}, TSB ${last.tsb}), weekly, curve, FTP estimate`);

// ---- weekly TSS by zone
{
  const split = tssByZone({ tss: 80, zones: [600, 1800, 0, 1200, 0, 0, 0] });
  assert.ok(Math.abs(split.reduce((a, b) => a + b, 0) - 80) < 1e-9, 'parts add up to the ride TSS');
  assert.ok(split[3] > split[1], 'threshold minutes weigh more than endurance minutes');
  assert.equal(tssByZone({ tss: 50, np: null, tssFrom: 'hr' }), null, 'HR-only ride has no split');
  const d = '2026-11-03T18:00:00';
  const w = weekly([{ id: rideIdFor(Date.parse(d)), start: new Date(d).toISOString(), durSec: 3600, tss: 80, zones: [600, 1800, 0, 1200, 0, 0, 0] },
    { id: rideIdFor(Date.parse(d) + 864e5), start: new Date(Date.parse(d) + 864e5).toISOString(), durSec: 3600, tss: 50, tssFrom: 'hr' }], 1, new Date('2026-11-05T12:00:00'))[0];
  assert.equal(w.tss, 130); assert.equal(w.otherTss, 50);
  assert.ok(Math.abs(w.zoneTss.reduce((a, b) => a + b, 0) - 80) < 0.5, JSON.stringify(w));
  ok('weekly TSS split by zone (HR-only rides kept apart)');
}

// ---- GitHub sync against an in-memory contents API
function mockGitHub() {
  const files = {};
  let shaN = 0;
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/contents\/(.+)|\/git\/blobs\/(.+))?$/);
    calls.push(`${opts.method || 'GET'} ${u.pathname}`);
    assert.ok(opts.headers.Authorization.startsWith('Bearer '));
    if (!m[2]) return res(200, { full_name: m[1], permissions: { push: true } });
    if (m[4]) { const f = Object.values(files).find((x) => x.sha === m[4]); return res(200, { content: f.content }); }
    const path = m[3];
    if (!opts.method) return files[path] ? res(200, { sha: files[path].sha, content: files[path].content.length > 1.5e6 ? '' : files[path].content, download_url: 'x' }) : res(404, {});
    const body = JSON.parse(opts.body);
    if (files[path] && body.sha !== files[path].sha) return res(409, { message: 'sha mismatch' });
    if (!files[path] && body.sha) return res(409, { message: 'no such file' });
    files[path] = { sha: 's' + ++shaN, content: body.content };
    return res(201, { content: { sha: files[path].sha } });
  };
  return { files, calls, fetchImpl };
}
const gh = mockGitHub();
gh.files['index.json'] = { sha: 's0', content: Buffer.from(JSON.stringify({ version: 1, rides: [{ id: '2026-11-01T0900', name: 'old' }] })).toString('base64') };
const sync = new GitHubSync({ token: 'github_pat_x', fetchImpl: gh.fetchImpl });
await sync.test();
const idx = await sync.pushRide(ride);
assert.deepEqual(idx.rides.map((r) => r.id), ['2026-11-01T0900', ride.summary.id]);
const stored = JSON.parse(Buffer.from(gh.files[`rides/2026/${ride.summary.id}.json`].content, 'base64').toString());
assert.equal(stored.streams.power.length, samples.length);
// pushing the same ride again overwrites, no duplicate in index
const idx2 = await sync.pushRide(ride);
assert.equal(idx2.rides.length, 2);
assert.deepEqual((await sync.fetchIndex()).map((r) => r.id), ['2026-11-01T0900', ride.summary.id]);
ok(`GitHub sync: ride file + index upsert (${gh.calls.length} API calls)`);

// ---- FTP from a single ride + FTP stored in the plan
{
  assert.deepEqual(ftpFromRide({ tags: ['test'], bests: { 60: 320, 1200: 180 } }).ftp, 240);
  assert.equal(ftpFromRide({ bests: { 60: 400, 1200: 252 } }).ftp, 239);
  assert.equal(ftpFromRide({ bests: { 60: 400 } }), null); // under 20 min, not a test
  const g = mockGitHub();
  const put = (path, obj) => { g.files[path] = { sha: 'p' + Math.random(), content: Buffer.from(JSON.stringify(obj)).toString('base64') }; };
  const read = (path) => JSON.parse(Buffer.from(g.files[path].content, 'base64').toString());
  put('coach/plan.json', { name: 'Block 1', ftp: 200, days: { '2026-11-11': 'ramp-test' } });
  const s2 = new GitHubSync({ token: 't', fetchImpl: g.fetchImpl });
  await s2.updatePlan((p) => { p.ftp = 240; p.ftpSetAt = '2026-11-11T20:00:00Z'; }, 'FTP');
  assert.deepEqual(read('coach/plan.json'), { name: 'Block 1', ftp: 240, days: { '2026-11-11': 'ramp-test' }, ftpSetAt: '2026-11-11T20:00:00Z' });
  // another writer (the coach) changes the plan between our read and write: we retry and keep their edit
  let raced = false;
  await s2.updatePlan((p) => {
    if (!raced) { raced = true; put('coach/plan.json', { ...read('coach/plan.json'), notes: { x: 'coach' } }); }
    p.ftp = 245;
  }, 'FTP');
  assert.equal(read('coach/plan.json').ftp, 245); assert.equal(read('coach/plan.json').notes.x, 'coach');
  ok('FTP from one ride; plan FTP write survives a concurrent coach edit');
}

// ---- settings shared through the plan: newest wins per key; first run never pushes untouched defaults
{
  const { reconcile, applyPending, SEED_AT } = await import('../js/settings-sync.js');
  const defaults = { ftp: 200, riderKg: 77, shiftStyle: 'sram', realDev: 5.1 };
  const plan = { name: 'Block 1', ftp: 200 };
  // Mac first run: customized values get seeded, defaults stay put
  const mac = reconcile({ plan, settings: { ...defaults, riderKg: 74.5, shiftStyle: 'shimano', gradeTrim: 0.012 }, base: null, defaults });
  assert.deepEqual(Object.keys(mac.pending).sort(), ['gradeTrim', 'riderKg', 'shiftStyle']);
  assert.ok(Object.values(mac.pending).every((x) => x.at === SEED_AT));
  assert.deepEqual(applyPending(plan, mac.pending).sort(), ['gradeTrim', 'riderKg', 'shiftStyle']);
  assert.equal(plan.settings.riderKg, 74.5); assert.equal(plan.ftpSetAt, undefined);
  // phone first run with defaults: adopts the Mac's values, pushes nothing
  const phone = reconcile({ plan, settings: { ...defaults }, base: null, defaults });
  assert.deepEqual(phone.pending, {});
  assert.equal(phone.settings.riderKg, 74.5); assert.equal(phone.settings.shiftStyle, 'shimano'); assert.equal(phone.settings.gradeTrim, 0.012);
  // phone changes FTP after a ride: pending, then written with source
  const s2 = { ...phone.settings, ftp: 238 };
  const ph2 = reconcile({ plan, settings: s2, base: phone.base, pending: phone.pending, defaults, now: '2026-11-11T20:00:00.000Z', source: 'ramp test 2026-11-11' });
  assert.deepEqual(Object.keys(ph2.pending), ['ftp']);
  applyPending(plan, ph2.pending);
  assert.equal(plan.ftp, 238); assert.equal(plan.ftpSetAt, '2026-11-11T20:00:00.000Z'); assert.equal(plan.ftpSource, 'ramp test 2026-11-11');
  // Mac next load: adopts FTP; its own older unsent change to riderKg loses to nothing (still pending) and survives
  const m2 = reconcile({ plan, settings: { ...mac.settings, riderKg: 75 }, base: { ...mac.base, riderKg: { v: 74.5, at: SEED_AT }, shiftStyle: { v: 'shimano', at: SEED_AT }, gradeTrim: { v: 0.012, at: SEED_AT } }, defaults, now: '2026-11-11T21:00:00.000Z' });
  assert.equal(m2.settings.ftp, 238); assert.deepEqual(m2.adopted, ['ftp']);
  assert.equal(m2.pending.riderKg.v, 75);
  // a newer value in the plan beats an older pending one
  plan.settingsSetAt.riderKg = '2026-11-11T22:00:00.000Z'; plan.settings.riderKg = 76;
  assert.deepEqual(applyPending(plan, m2.pending), []);
  const m3 = reconcile({ plan, settings: m2.settings, base: m2.base, pending: m2.pending, defaults });
  assert.equal(m3.settings.riderKg, 76); assert.deepEqual(m3.pending, {});
  ok('settings sync: first-run seeding, adopt on other device, newest wins per key');
}

// ---- power zones: one table for colors and stats (Coggan, upper bound inclusive)
{
  const { zoneOf, zoneRange } = await import('../js/zones.js');
  const { timeInZones } = await import('../js/stats.js');
  assert.deepEqual([0, 0.55, 0.56, 0.75, 0.76, 0.88, 0.9, 0.91, 1.05, 1.06, 1.2, 1.21, 1.5, 1.51, 3].map(zoneOf), [0, 0, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  assert.deepEqual(timeInZones([0, 110, 111, 150, 151, 180, 181, 210, 211, 240, 241, 300, 301], 200), [2, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual([0, 1, 3, 6].map((i) => zoneRange(i, 200)), ['0-110 W', '111-150 W', '181-210 W', '301+ W']);
  assert.deepEqual([0, 2, 6].map((i) => zoneRange(i)), ['up to 55%', '76-90%', '151%+']);
  ok('power zones (colors and time-in-zone share one table)');
}

// ---- my workouts (builder): merge across devices, parsing, validation
{
  const { applyMinePending, mineView, emptyMine, parseDur, fmtDur, workoutProblems, cleanWorkout, newMineId } = await import('../js/mine.js');
  const a = { id: 'mine-a', name: 'A', steps: [{ dur: 60, power: 0.5 }] };
  // Mac saves A
  const doc = emptyMine();
  assert.deepEqual(applyMinePending(doc, { 'mine-a': { w: a, at: '2026-11-10T10:00:00Z' } }), ['mine-a']);
  assert.equal(doc.workouts[0].updatedAt, '2026-11-10T10:00:00Z');
  // phone edited A later, Mac's older offline edit arrives after: phone's wins
  applyMinePending(doc, { 'mine-a': { w: { ...a, name: 'A phone' }, at: '2026-11-10T12:00:00Z' } });
  applyMinePending(doc, { 'mine-a': { w: { ...a, name: 'A mac' }, at: '2026-11-10T11:00:00Z' } });
  assert.equal(doc.workouts[0].name, 'A phone');
  // delete is a tombstone; an older edit can't bring it back, a newer one can
  applyMinePending(doc, { 'mine-a': { w: null, at: '2026-11-10T13:00:00Z' } });
  assert.equal(doc.workouts.length, 0); assert.ok(doc.deleted['mine-a']);
  applyMinePending(doc, { 'mine-a': { w: a, at: '2026-11-10T12:30:00Z' } });
  assert.equal(doc.workouts.length, 0);
  applyMinePending(doc, { 'mine-a': { w: a, at: '2026-11-10T14:00:00Z' } });
  assert.equal(doc.workouts.length, 1); assert.ok(!doc.deleted['mine-a']);
  // view = file + unsent local changes, file untouched
  const v = mineView(doc, { 'mine-b': { w: { ...a, id: 'mine-b' }, at: '2026-11-10T15:00:00Z' } });
  assert.deepEqual(v.map((w) => w.id).sort(), ['mine-a', 'mine-b']); assert.equal(doc.workouts.length, 1);
  assert.deepEqual(mineView(null), []);
  // durations
  assert.deepEqual(['4:30', '90', '1:02:00', '45s', '4.5', '0:61', 'x', ''].map(parseDur), [270, 5400, 3720, 45, 270, NaN, NaN, NaN]);
  assert.deepEqual([270, 3720, 5].map(fmtDur), ['4:30', '1:02:00', '0:05']);
  // validation + cleanup: the saved workout plays in the engine
  { const pr = workoutProblems({ name: '', steps: [] }); assert.equal(pr.length, 2); assert.equal(pr[0], 'Give it a name.'); }
  assert.ok(workoutProblems({ name: 'x', steps: [{ dur: 2, power: 0.5 }] })[0].includes('duration'));
  assert.ok(workoutProblems({ name: 'x', steps: [{ dur: 60, power: 0.5, cadence: 'fast' }] })[0].includes('cadence'));
  const built = cleanWorkout({ id: newMineId('Over-unders ñandú', 0), name: ' Over-unders ', description: '', tags: [], steps: [
    { dur: 600, from: 0.45, to: 0.7, label: 'Warm-up', text: '' },
    { repeat: 3, steps: [{ dur: 120, power: 0.95, cadence: '90' }, { dist: 1500, grade: 6, cadence: '80 - 90' }] },
    { dur: 300, free: true },
  ] });
  assert.equal(built.id, 'mine-over-unders-nandu-0');
  assert.equal(built.name, 'Over-unders');
  assert.deepEqual(built.steps[1].steps, [{ dur: 120, power: 0.95, cadence: 90 }, { dist: 1500, grade: 6, cadence: '80-90' }]);
  assert.deepEqual(workoutProblems(built), []);
  const segs = flatten(built);
  assert.equal(segs.length, 8); assert.equal(segs[2].kind, 'sim'); assert.equal(segs[2].cad.lo, 80); assert.ok(segs[7].free);
  ok('my workouts: newest change wins across devices, tombstones, parsing, validation');
}

console.log(`\n${n} stats/sync tests passed`);
