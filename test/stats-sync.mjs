import assert from 'node:assert/strict';
import { bests, normalizedPower, decoupling, buildRide, loadSeries, weekly, powerCurve, ftpEstimate, rideIdFor } from '../js/stats.js';
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

console.log(`\n${n} stats/sync tests passed`);
