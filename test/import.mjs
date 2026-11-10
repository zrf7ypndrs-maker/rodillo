// History import: zip reading (Strava + nested Garmin exports), FIT/GPX/TCX parsing,
// dedup against existing rides, heart-rate TSS, and the one-commit push.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodeActivity } from '../js/fit.js';
import { scanFiles, buildImport, parseXmlActivity, toSamples, hrTss, zipEntries } from '../js/importer.js';
import { GitHubSync } from '../js/sync.js';
import { rideIdFor } from '../js/stats.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

// --- tiny zip writer (deflate) for building fake exports
function makeZip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data0] of Object.entries(files)) {
    const data = Buffer.from(data0);
    const comp = zlib.deflateRawSync(data);
    const nameB = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nameB, comp); central.push(ch, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const asFile = (name, buf) => new File([buf], name);

// --- fake rides
const DAY = 864e5;
const now = Date.parse('2026-11-10T18:00:00Z');
function ride(startMs, sec, { power = 180, hr = 140, step = 1 } = {}) {
  const out = [];
  for (let i = 0; i < sec; i += step) out.push({ t: startMs + i * 1000, power: power ? power + (i % 60 < 30 ? 40 : -40) : 0, hr: hr || 0, cadence: 88, distance: i * 8, speed: 8 });
  return Buffer.from(encodeActivity(out, null, {}));
}
const d1 = now - 20 * DAY, d2 = now - 10 * DAY, d3 = now - 5 * DAY, old = now - 300 * DAY;
const gpx = `<?xml version="1.0"?><gpx><trk><type>cycling</type><trkseg>${Array.from({ length: 1800 }, (_, i) => `<trkpt lat="${-33.4 + i * 1e-4}" lon="-70.6"><time>${new Date(d3 + i * 1000).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${130 + (i % 20)}</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`).join('')}</trkseg></trk></gpx>`;
const csvDate = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const csv = [
  'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Filename',
  `1,"${csvDate(d1)}","Zwift - Watopia, hills",Virtual Ride,,3600,30,activities/1.fit.gz`,
  `2,"${csvDate(d2)}",Cerro San Cristobal,Mountain Bike Ride,"a ""quoted"" note",2700,20,activities/2.fit.gz`,
  `3,"${csvDate(d3)}",Morning commute,Ride,,1800,10,activities/3.gpx.gz`,
  `4,"${csvDate(d2 + 3600e3)}",Run,Run,,1800,5,activities/4.fit.gz`,
  `5,"${csvDate(old)}",Old ride,Ride,,3600,30,activities/5.fit.gz`,
  `6,"${csvDate(d1 + 120e3)}",Same ride recorded on the watch,Ride,,3500,0,activities/6.fit.gz`,
  `7,"${csvDate(d2)}",Manual entry,Ride,,3600,0,`,
].join('\n');
const strava = makeZip({
  'activities.csv': csv,
  'activities/1.fit.gz': zlib.gzipSync(ride(d1, 3600)),
  'activities/2.fit.gz': zlib.gzipSync(ride(d2, 2700, { power: 0, hr: 150 })),
  'activities/3.gpx.gz': zlib.gzipSync(gpx),
  'activities/4.fit.gz': zlib.gzipSync(ride(d2 + 3600e3, 1800)),
  'activities/5.fit.gz': zlib.gzipSync(ride(old, 3600)),
  'activities/6.fit.gz': zlib.gzipSync(ride(d1 + 120e3, 3400, { power: 0 })),
  'media/photo.jpg': 'x',
});

const since = now - 183 * DAY;
let scanned;
await test('Strava export: reads csv, filters types and dates, parses fit.gz and gpx.gz', async () => {
  const prog = [];
  scanned = await scanFiles([asFile('export_123.zip', strava)], { since, onProgress: (a, b) => prog.push([a, b]) });
  const names = scanned.found.map((a) => a.name).sort();
  assert.deepEqual(names, ['Cerro San Cristobal', 'Morning commute', 'Same ride recorded on the watch', 'Zwift - Watopia, hills']);
  assert.equal(scanned.skip.notRide, 1); // the run
  assert.equal(scanned.skip.old, 1);
  assert.equal(scanned.found.find((a) => a.name.startsWith('Zwift')).kind, 'indoor');
  assert.equal(scanned.found.find((a) => a.name.startsWith('Cerro')).kind, 'mtb');
  assert.ok(scanned.found.every((a) => a.source === 'strava'));
  assert.deepEqual(prog.at(-1), [4, 4]); // the run and the old ride never get opened
});

let built;
await test('build: dedups two recordings of one ride, keeps power, skips rides already in Rodillo', async () => {
  const existing = [{ id: rideIdFor(d3 + 60e3), start: new Date(d3 + 60e3).toISOString(), durSec: 1700 }];
  built = buildImport(scanned.found, existing, { ftp: 200, restHr: 55 });
  assert.equal(built.stats.dupes, 1);
  assert.equal(built.stats.already, 1);
  assert.equal(built.docs.length, 2);
  const [z, mtb] = built.docs.map((d) => d.summary);
  assert.equal(z.name, 'Zwift - Watopia, hills');
  assert.deepEqual(z.tags, ['imported', 'indoor']);
  assert.equal(z.source, 'strava');
  assert.equal(z.durSec, 3600);
  assert.ok(z.np > 180 && z.np < 230, `np ${z.np}`);
  assert.ok(z.tss > 80 && z.tss < 130, `tss ${z.tss}`);
  assert.ok(z.bests[1200] >= 180);
  assert.equal(z.zones.reduce((a, b) => a + b, 0), 3600);
  assert.equal(mtb.np, null); assert.equal(mtb.tssFrom, 'hr'); assert.ok(mtb.tss > 30, `hr tss ${mtb.tss}`);
  assert.equal(built.docs[1].streams.power, undefined);
  assert.equal(built.docs[0].streams.grade, undefined);
});

await test('heart-rate TSS: an hour at threshold is 100, easy riding much less', () => {
  const cfg = { rest: 50, max: 190, lthr: 170 };
  assert.equal(hrTss(new Array(3600).fill(170), cfg), 100);
  const z2 = hrTss(new Array(3600).fill(135), cfg);
  assert.ok(z2 > 35 && z2 < 55, `z2 ${z2}`);
});

await test('Garmin export: activity files inside nested zips, other files ignored', async () => {
  const inner = makeZip({ 'a_ACTIVITY.fit': ride(d2, 1800), 'run.fit': (() => { const b = ride(d1, 900); return b; })(), 'notes.json': '{}' });
  const garmin = makeZip({ 'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': inner, 'DI_CONNECT/x.json': '{}' });
  const r = await scanFiles([asFile('garmin.zip', garmin)], { since });
  assert.equal(r.found.length, 2); // both are cycling here (encoder writes sport 2)
  assert.ok(r.found.every((a) => a.source === 'garmin' && a.name === 'Indoor ride'));
  const e = await zipEntries(new Blob([garmin]));
  assert.equal(e.length, 2);
});

await test('loose files and TCX', async () => {
  const tcx = `<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Lap><Track>${Array.from({ length: 900 }, (_, i) => `<Trackpoint><Time>${new Date(d3 + i * 2000).toISOString()}</Time><DistanceMeters>${i * 14}</DistanceMeters><HeartRateBpm><Value>140</Value></HeartRateBpm><Cadence>85</Cadence><Extensions><TPX><Watts>210</Watts></TPX></Extensions></Trackpoint>`).join('')}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const r = await scanFiles([asFile('ride.tcx', tcx), asFile('x.fit', ride(d2, 1200))], { since });
  assert.equal(r.found.length, 2);
  const s = toSamples(parseXmlActivity(tcx).points);
  assert.equal(s.length, 1799); // 2-s recording filled to 1 Hz
  assert.equal(s[1].power, 210);
});

await test('pushRides: one commit with all rides and the merged index, retried on a race', async () => {
  const calls = [];
  let head = 'c0', races = 1;
  const trees = [];
  const index = { version: 1, rides: [{ id: '2026-11-08T1115', start: '2026-11-08T17:15:06Z', durSec: 148 }] };
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opts = {}) => {
    const p = new URL(url).pathname.replace('/repos/o/r', '');
    calls.push(`${opts.method || 'GET'} ${p}`);
    if (p === '/git/ref/heads/main') return res(200, { object: { sha: head } });
    if (p.startsWith('/git/commits/')) return res(200, { tree: { sha: 't-' + head } });
    if (p === '/contents/index.json') return res(200, { sha: 'i', content: Buffer.from(JSON.stringify(index)).toString('base64') });
    if (p === '/git/trees') { const b = JSON.parse(opts.body); trees.push(b); return res(201, { sha: 'tree' + trees.length }); }
    if (p === '/git/commits') return res(201, { sha: 'new' });
    if (p === '/git/refs/heads/main') { if (races-- > 0) { head = 'c1'; return res(422, { message: 'Update is not a fast forward' }); } return res(200, {}); }
    return res(404, {});
  };
  const gh = new GitHubSync({ token: 't', repo: 'o/r', fetchImpl });
  const prog = [];
  const out = await gh.pushRides(built.docs, 'Import 2 rides', (a, b) => prog.push(`${a}/${b}`));
  assert.equal(out.rides.length, 3);
  assert.deepEqual(out.rides.map((r) => r.id), [...out.rides.map((r) => r.id)].sort());
  const last = trees.at(-1);
  assert.equal(last.base_tree, 't-c1'); // rebuilt on the new head after the race
  const paths = trees.slice(trees.length / 2).flatMap((t) => t.tree.map((x) => x.path));
  assert.ok(paths.includes('index.json'));
  assert.equal(paths.filter((x) => x.startsWith('rides/')).length, 2);
  assert.equal(calls.filter((c) => c === 'PATCH /git/refs/heads/main').length, 2);
  assert.equal(prog.at(-1), '2/2');
});

console.log(`import: ${passed} tests passed`);
