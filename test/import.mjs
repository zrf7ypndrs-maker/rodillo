// History import: zip reading (Strava + nested Garmin exports), FIT/GPX/TCX parsing,
// dedup against existing rides, heart-rate TSS, and the one-commit push.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodeActivity } from '../js/fit.js';
import { createRequire } from 'node:module';
import { scanFiles, buildImport, parseXmlActivity, parseFit, toSamples, hrTss, zipEntries } from '../js/importer.js';
import { GitHubSync } from '../js/sync.js';
import { rideIdFor } from '../js/stats.js';

const { Decoder, Stream } = createRequire(import.meta.url)('@garmin/fitsdk');

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

// ---------------------------------------------------------------- parseFit edge cases
// FIT files written byte by byte (not with js/fit.js), so the parser sees shapes our own
// encoder never makes: developer fields, compressed timestamps, invalid values, several
// sessions, chained segments, big-endian definitions. Records are cross-checked against
// Garmin's own decoder (@garmin/fitsdk) where it reads the same file (it has no compressed timestamps).
const FIT_EPOCH = 631065600;
const U8 = 0x02, ENUM = 0x00, U16 = 0x84, U32 = 0x86, U32Z = 0x8c, S16 = 0x83, STR = 0x07, U64 = 0x8f;
const REC = [[253, 4, U32], [3, 1, U8], [4, 1, U8], [5, 4, U32], [6, 2, U16], [7, 2, U16]]; // time, hr, cad, dist, speed, power
function crc16(bytes) {
  const t = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  let crc = 0;
  for (const b of bytes) {
    let x = t[crc & 0xf]; crc = ((crc >> 4) & 0x0fff) ^ x ^ t[b & 0xf];
    x = t[crc & 0xf]; crc = ((crc >> 4) & 0x0fff) ^ x ^ t[(b >> 4) & 0xf];
  }
  return crc;
}
class Fit {
  constructor() { this.b = []; this.defs = {}; }
  put(v, size, be) {
    if (Array.isArray(v)) { this.b.push(...v); return; }
    const out = [];
    for (let i = 0; i < size; i++) out.push(Math.floor(v / 256 ** i) & 255);
    this.b.push(...(be ? out.reverse() : out));
  }
  def(local, global, fields, { be = false, dev = [] } = {}) {
    this.b.push(0x40 | (dev.length ? 0x20 : 0) | local, 0, be ? 1 : 0);
    this.put(global, 2, be);
    this.b.push(fields.length);
    for (const f of fields) this.b.push(...f);
    if (dev.length) { this.b.push(dev.length); for (const f of dev) this.b.push(...f); }
    this.defs[local] = { fields, be, dev };
    return this;
  }
  /** values: one per field (a number, or raw bytes for odd sizes); dev: raw bytes; ct: compressed time offset 0-31 */
  msg(local, values, { ct = null, dev = [] } = {}) {
    const d = this.defs[local];
    this.b.push(ct == null ? local : 0x80 | (local << 5) | ct);
    d.fields.forEach(([, size], i) => this.put(values[i], size, d.be));
    this.b.push(...dev);
    return this;
  }
  bytes({ hs = 14, size = this.b.length } = {}) {
    const h = [hs, 0x20, 0x54, 0x08, size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255, 0x2e, 0x46, 0x49, 0x54];
    if (hs === 14) { const c = crc16(h); h.push(c & 255, c >> 8); }
    const body = [...h, ...this.b];
    const c = crc16(body);
    return Uint8Array.from([...body, c & 255, c >> 8]);
  }
}
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const T0 = ((Math.floor(d2 / 1000) - FIT_EPOCH) & ~0x1f) + 0x1c; // low 5 bits 28: compressed times roll over 4 s later
const ms = (t) => (t + FIT_EPOCH) * 1000;
const activity = (f, { created = T0 } = {}) => f.def(0, 0, [[0, 1, ENUM], [1, 2, U16], [4, 4, U32]]).msg(0, [4, 255, created]);
const pt = (t, hr, cad, dist, speed, power) => ({ t: ms(t), hr, cad, power, dist, speed });
function garmin(bytes) {
  const { messages, errors } = new Decoder(Stream.fromByteArray(bytes)).read({ expandComponents: false, mergeHeartRates: false });
  assert.deepEqual(errors, []);
  return (messages.recordMesgs || []).map((r) => ({ t: r.timestamp?.getTime() ?? null, hr: r.heartRate ?? null, power: r.power ?? null, cad: r.cadence ?? null }));
}
const sameAsGarmin = (bytes, points) => assert.deepEqual(garmin(bytes), points.map(({ t, hr, power, cad }) => ({ t, hr, power, cad })));

await test('parseFit: developer fields are skipped, the standard fields around them still read', () => {
  const f = activity(new Fit());
  f.def(1, 207, [[3, 1, U8]]).msg(1, [0]); // developer_data_id
  f.def(2, 206, [[0, 1, U8], [1, 1, U8], [2, 1, U8], [3, 8, STR]]); // field_description
  f.msg(2, [0, 0, U8, [...Buffer.from('smo2\0\0\0\0')]]).msg(2, [0, 1, U32, [...Buffer.from('core\0\0\0\0')]]);
  f.def(3, 20, REC, { dev: [[0, 1, 0], [1, 4, 0]] }); // 5 dev bytes after every record
  f.def(4, 20, [[253, 4, U32], [7, 2, U16]], { dev: [[1, 4, 0]] });
  for (let i = 0; i < 4; i++) f.msg(3, [T0 + i, 140 + i, 90, 1000 * i, 8000, 200 + i], { dev: [60 + i, 0xaa, 0xbb, 0xcc, 0xdd] });
  f.msg(4, [T0 + 4, 250], { dev: [1, 2, 3, 4] });
  f.msg(3, [T0 + 5, 150, 91, 5000, 8100, 210], { dev: [0xff, 0xff, 0xff, 0xff, 0xff] });
  const bytes = f.bytes();
  const r = parseFit(bytes);
  assert.deepEqual(r.points, [
    pt(T0, 140, 90, 0, 8, 200), pt(T0 + 1, 141, 90, 10, 8, 201), pt(T0 + 2, 142, 90, 20, 8, 202), pt(T0 + 3, 143, 90, 30, 8, 203),
    pt(T0 + 4, null, null, null, null, 250), pt(T0 + 5, 150, 91, 50, 8.1, 210),
  ]);
  assert.equal(r.start, ms(T0)); // no session: the first record
  sameAsGarmin(bytes, r.points);
});

await test('parseFit: compressed timestamps count from the last full time, roll over every 32 s, any of local types 0-3', () => {
  const f = activity(new Fit());
  f.def(1, 20, REC);
  f.def(2, 20, [[3, 1, U8], [7, 2, U16]]); // no timestamp field: these come compressed or take the last time
  f.def(3, 20, [[7, 2, U16]]);
  f.msg(1, [T0, 130, 85, 0, 7000, 150]); // full time, low bits 28
  f.msg(2, [131, 151], { ct: 29 }).msg(2, [132, 152], { ct: 31 }); // +1, +3
  f.msg(2, [133, 153], { ct: 0 }); // rolled over: +4
  f.msg(2, [134, 154], { ct: 5 }); // +9
  f.msg(2, [135, 155]); // normal header, no time field: the last time (+9)
  f.msg(3, [156], { ct: 5 }); // same offset as the last: +9 again
  f.msg(1, [T0 + 40, 136, 86, 100, 7100, 157]); // a full time resets the base (low bits 4)
  f.msg(3, [158], { ct: 4 }).msg(3, [159], { ct: 3 }); // +40 again, then a smaller offset rolls over: +71
  f.def(0, 20, [[7, 2, U16]]); // local type 0 can be redefined and compressed too
  f.msg(0, [160], { ct: 10 }); // low bits at +71 are 3, so offset 10 is +78
  const r = parseFit(f.bytes());
  const off = r.points.map((p) => p.t / 1000 - FIT_EPOCH - T0);
  assert.deepEqual(off, [0, 1, 3, 4, 9, 9, 9, 40, 40, 71, 78]);
  assert.deepEqual(r.points.map((p) => p.power), [150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160]);
  assert.deepEqual(r.points[1], { t: ms(T0 + 1), hr: 131, cad: null, power: 151, dist: null, speed: null });
  // no Garmin cross-check here: its JS decoder throws on compressed timestamps
});

await test('parseFit: missing power or HR (field left out, or sent as the invalid value) reads as null', () => {
  const f = activity(new Fit());
  f.def(1, 20, [[253, 4, U32], [3, 1, U8], [4, 1, U8]]); // HR strap only, no power field
  f.def(2, 20, [...REC, [73, 4, U32], [9, 2, S16], [78, 8, U64]]); // power meter only: HR sent as 0xff
  f.msg(1, [T0, 120, 80]);
  f.msg(2, [T0 + 1, 0xff, 0xff, 0xffffffff, 0xffff, 0xffff, 0xffffffff, 0x7fff, Array(8).fill(0xff)]); // everything invalid
  f.msg(2, [T0 + 2, 0xff, 92, 2500, 0xffff, 230, 9100, 150, Array(8).fill(1)]); // enhanced speed when speed is missing
  f.msg(2, [T0 + 3, 0, 0, 2600, 9000, 0, 9200, 0, Array(8).fill(1)]); // zeros are real values (enhanced speed wins)
  const bytes = f.bytes();
  const r = parseFit(bytes);
  assert.deepEqual(r.points, [
    pt(T0, 120, 80, null, null, null),
    { t: ms(T0 + 1), hr: null, cad: null, power: null, dist: null, speed: null },
    pt(T0 + 2, null, 92, 25, 9.1, 230),
    pt(T0 + 3, 0, 0, 26, 9.2, 0),
  ]);
  sameAsGarmin(bytes, r.points);
  // signed base types: 0x7f (sint8) and 0x7fff (sint16) are their invalid values, one below is a value
  const g = activity(new Fit()).def(1, 20, [[253, 4, U32], [3, 1, 0x01], [7, 2, S16]]);
  g.msg(1, [T0, 0x7f, 0x7fff]).msg(1, [T0 + 1, 0x7e, 0x7ffe]);
  assert.deepEqual(parseFit(g.bytes()).points.map((p) => [p.hr, p.power]), [[null, null], [126, 32766]]);
});

const longRide = (t0, sec, rec, fill) => { const f = activity(new Fit()); f.def(1, 18, [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [6, 1, ENUM]]).msg(1, [t0 + sec, t0, 2, 6]); f.def(2, 20, rec); for (let i = 0; i < sec; i++) f.msg(2, fill(i)); return f.bytes(); };
await test('import: a power meter with no HR and an HR strap with no power both import (FIT sent as invalid values)', async () => {
  const powerOnly = longRide(T0, 900, [[253, 4, U32], [3, 1, U8], [7, 2, U16]], (i) => [T0 + i, 0xff, i % 60 < 30 ? 260 : 140]);
  const hrOnly = longRide(T0 + 2000, 900, [[253, 4, U32], [3, 1, U8], [7, 2, U16]], (i) => [T0 + 2000 + i, 125 + (i % 30), 0xffff]);
  const r = await scanFiles([asFile('p.fit', powerOnly), asFile('h.fit', hrOnly)], { since });
  assert.equal(r.found.length, 2);
  assert.deepEqual(r.found.map((a) => a.kind), ['indoor', 'indoor']); // sub-sport 6 = indoor cycling
  const b = buildImport(r.found, [], { ftp: 250, restHr: 55 });
  const [p, h] = b.docs.map((d) => d.summary);
  assert.equal(p.durSec, 900); assert.ok(p.np > 200, `np ${p.np}`); assert.equal(p.decoupling, null); assert.equal(p.tssFrom, undefined);
  assert.equal(h.np, null); assert.equal(h.avgP, null); assert.equal(h.tssFrom, 'hr'); assert.ok(h.tss > 0);
  assert.equal(b.docs[1].streams.power, undefined);
});

await test('parseFit: several sessions: records from all of them, earliest start, sport from the last session that names one', () => {
  const S = [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [6, 1, ENUM]];
  const f = activity(new Fit());
  f.def(1, 12, [[0, 1, ENUM], [1, 1, ENUM]]).msg(1, [2, 58]); // sport message: virtual activity
  f.def(2, 20, [[253, 4, U32], [7, 2, U16]]);
  f.def(3, 18, S);
  f.def(4, 18, [[253, 4, U32], [2, 4, U32]]); // a session without sport fields
  f.msg(2, [T0 + 100, 200]).msg(2, [T0 + 101, 201]);
  f.msg(3, [T0 + 102, T0 + 100, 2, 6]); // bike, indoor
  f.msg(2, [T0 + 200, 210]);
  f.msg(3, [T0 + 201, T0 + 200, 2, 0xff]); // bike, sub-sport missing: keeps indoor
  f.msg(4, [T0 + 300, T0 + 50]); // earliest start, no sport: keeps cycling
  let r = parseFit(f.bytes());
  assert.deepEqual(r.points.map((p) => [p.t - ms(T0), p.power]), [[100e3, 200], [101e3, 201], [200e3, 210]]);
  assert.equal(r.start, ms(T0 + 50));
  assert.deepEqual([r.sport, r.subSport], [2, 6]);
  // a bike + run file (multisport): the last session's sport wins, so the import skips it as not a ride
  f.msg(3, [T0 + 400, T0 + 301, 1, 0]);
  r = parseFit(f.bytes());
  assert.deepEqual([r.sport, r.subSport, r.start], [1, 0, ms(T0 + 50)]);
  // session start 0 / invalid never counts
  const g = activity(new Fit()); g.def(1, 20, [[253, 4, U32]]).msg(1, [T0 + 7]); g.def(2, 18, S).msg(2, [T0 + 8, 0xffffffff, 2, 0]);
  assert.equal(parseFit(g.bytes()).start, ms(T0 + 7));
});

await test('parseFit: sport message only before a session, zones_target gives max and threshold HR', () => {
  const f = activity(new Fit());
  f.def(1, 7, [[1, 1, U8], [2, 1, U8]]).msg(1, [188, 0xff]).msg(1, [0xff, 171]); // max HR, then LTHR; invalid ones ignored
  f.def(2, 12, [[0, 1, ENUM], [1, 1, ENUM]]).msg(2, [2, 0xff]).msg(2, [1, 1]); // the first sport message wins
  f.def(3, 20, [[253, 4, U32], [3, 1, U8]]).msg(3, [T0, 150]);
  let r = parseFit(f.bytes());
  assert.deepEqual([r.sport, r.subSport, r.maxHr, r.lthr], [2, null, 188, 171]);
  const g = activity(new Fit()); g.def(1, 12, [[0, 1, ENUM]]).msg(1, [0xff]).msg(1, [2]); g.def(2, 20, [[253, 4, U32]]).msg(2, [T0]);
  r = parseFit(g.bytes());
  assert.deepEqual([r.sport, r.subSport, r.maxHr, r.lthr], [2, null, null, null]);
});

await test('parseFit: chained segments, 12- and 14-byte headers, big-endian, odd field sizes, unknown messages', () => {
  const settings = new Fit().def(0, 0, [[0, 1, ENUM]]).msg(0, [2]).def(1, 20, [[253, 4, U32], [7, 2, U16]]).msg(1, [T0, 999]); // settings file: skipped whole
  const be = activity(new Fit());
  be.def(1, 20, [[253, 4, U32], [3, 1, U8], [99, 3, 0x0d], [7, 2, U16], [6, 2, U16]], { be: true }); // big-endian, 3-byte field ignored
  be.def(2, 21, [[253, 4, U32], [0, 1, ENUM], [3, 4, U32]]); // event: unknown to the parser
  be.msg(1, [T0 + 1, 141, [1, 2, 3], 0x0102, 0x1f40]).msg(2, [T0 + 2, 0, 0]).msg(1, [T0 + 3, 142, [4, 5, 6], 0x0201, 0x2000]);
  const second = new Fit().def(5, 20, [[253, 4, U32], [7, 2, U16]]).msg(5, [T0 + 10, 300]); // no file_id of its own
  const bytes = cat(settings.bytes({ hs: 12 }), be.bytes(), second.bytes({ hs: 12 }));
  const r = parseFit(bytes);
  assert.deepEqual(r.points, [pt(T0 + 1, 141, null, null, 8, 258), pt(T0 + 3, 142, null, null, 8.192, 513), pt(T0 + 10, null, null, null, null, 300)]);
  // a settings file alone, or an activity with no records, is not an activity
  assert.equal(parseFit(settings.bytes()), null);
  assert.equal(parseFit(activity(new Fit()).bytes()), null);
  assert.equal(parseFit(second.bytes()), null); // records but no file_id
  assert.equal(parseFit(new TextEncoder().encode('<gpx></gpx> not a fit file')), null);
  // a slice inside a bigger buffer (byteOffset) reads the same
  const big = new Uint8Array(bytes.length + 7); big.set(bytes, 5);
  assert.deepEqual(parseFit(big.subarray(5, 5 + bytes.length)), r);
});

await test('parseFit: since, truncated files, a wrong data size and data before its definition keep what was read', () => {
  const f = activity(new Fit(), { created: T0 }).def(1, 20, [[253, 4, U32], [7, 2, U16]]);
  for (let i = 0; i < 5; i++) f.msg(1, [T0 + i, 100 + i]);
  const whole = f.bytes();
  assert.deepEqual(parseFit(whole, { since: ms(T0) + 864e5 + 1 }), { old: true }); // more than a day before since
  assert.equal(parseFit(whole, { since: ms(T0) + 864e5 }).points.length, 5); // exactly a day: kept
  const noDate = activity(new Fit(), { created: 0xffffffff }).def(1, 20, [[253, 4, U32]]).msg(1, [T0]);
  assert.equal(parseFit(noDate.bytes(), { since: Date.now() }).points.length, 1); // no time_created: never old
  const zDate = new Fit().def(0, 0, [[0, 1, ENUM], [4, 4, U32Z]]).msg(0, [4, 0]).def(1, 20, [[253, 4, U32]]).msg(1, [T0]);
  assert.equal(parseFit(zDate.bytes(), { since: Date.now() }).points.length, 1); // z-type 0 is invalid
  const cut = whole.subarray(0, whole.length - 2 - 4); // CRC and most of the last record gone
  assert.deepEqual(parseFit(cut).points.map((p) => p.power), [100, 101, 102, 103]);
  const g = activity(new Fit()).def(1, 20, [[253, 4, U32], [7, 2, U16]]);
  g.msg(1, [T0, 1]).msg(1, [T0 + 1, 2]);
  g.b.push(9, 0, 0, 0, 0); // data for local type 9, never defined: the rest of this segment is dropped
  g.msg(1, [T0 + 2, 3]);
  const next = activity(new Fit()).def(1, 20, [[253, 4, U32], [7, 2, U16]]).msg(1, [T0 + 3, 4]);
  assert.deepEqual(parseFit(cat(g.bytes(), next.bytes())).points.map((p) => p.power), [1, 2, 4]);
  assert.deepEqual(parseFit(cat(f.bytes({ size: 1e6 }), next.bytes())).points.map((p) => p.power), [100, 101, 102, 103, 104]); // size past the end: read to the end
  assert.deepEqual(parseFit(f.bytes({ size: 0 })).points.length, 5); // size 0: read to the end
});

await test('import: a 10-minute FIT with developer fields and compressed timestamps (Wahoo / Zwift shape)', async () => {
  const f = activity(new Fit());
  f.def(1, 207, [[3, 1, U8]]).msg(1, [0]);
  f.def(2, 18, [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [6, 1, ENUM]]);
  f.def(3, 20, REC, { dev: [[0, 2, 0]] });
  f.def(2 + 0, 20, [[3, 1, U8], [7, 2, U16], [4, 1, U8]], { dev: [[0, 2, 0]] }); // local 2 redefined: compressed records
  for (let i = 0; i < 600; i++) {
    if (i % 60 === 0) f.msg(3, [T0 + i, 140, 90, i * 800, 8000, 220], { dev: [1, 2] });
    else f.msg(2, [140 + (i % 10), i % 120 < 60 ? 280 : 160, 90], { ct: (T0 + i) & 0x1f, dev: [3, 4] });
  }
  f.def(4, 18, [[253, 4, U32], [2, 4, U32], [5, 1, ENUM], [6, 1, ENUM]]).msg(4, [T0 + 600, T0, 2, 58]);
  const bytes = f.bytes();
  const r = await scanFiles([asFile('zwift.fit', bytes)], { since });
  assert.equal(r.found.length, 1);
  assert.equal(r.found[0].kind, 'indoor');
  assert.equal(r.found[0].points.length, 600);
  assert.equal(r.found[0].points.at(-1).t, ms(T0 + 599));
  const doc = buildImport(r.found, [], { ftp: 250 }).docs[0];
  assert.equal(doc.summary.durSec, 600);
  assert.equal(doc.summary.start, new Date(ms(T0)).toISOString());
  assert.ok(doc.summary.np > 220 && doc.summary.np < 260, `np ${doc.summary.np}`);
});

console.log(`import: ${passed} tests passed`);
