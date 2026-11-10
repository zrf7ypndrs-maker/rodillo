// Ride history import: a Strava bulk export (.zip), a Garmin Connect export (.zip),
// or loose .fit / .fit.gz / .gpx / .tcx files. Turns each cycling activity into a
// Rodillo ride document (same summary fields as rides recorded in the app), so the
// coach's load numbers (CTL / ATL / Form), power curve and time in zones have history.
// Pure module (no DOM): runs in the browser and in Node (tests).
import { buildRide, rideIdFor } from './stats.js?v=202611102147';

export const IMPORT_DAYS = 183; // about 6 months: enough for CTL (42-day average) to settle
const FIT_EPOCH = 631065600;
const GAP_FILL = 10; // seconds: shorter gaps are smart recording (hold values), longer ones are pauses

// ---------------------------------------------------------------- bytes
async function inflate(bytes, format) {
  const ds = new DecompressionStream(format);
  const out = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const readSlice = async (blob, a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer());
const gunzipIf = (name, bytes) => (/\.gz$/i.test(name) ? inflate(bytes, 'gzip') : bytes);

// ---------------------------------------------------------------- zip (reads only what it needs, so multi-GB exports are fine)
export async function zipEntries(blob) {
  const tailLen = Math.min(blob.size, 65536 + 22);
  const tail = await readSlice(blob, blob.size - tailLen, blob.size);
  const tv = new DataView(tail.buffer);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a zip file');
  let count = tv.getUint16(e + 10, true);
  let cdSize = tv.getUint32(e + 12, true);
  let cdOff = tv.getUint32(e + 16, true);
  // zip64 (exports over 4 GB or with more than 65535 files)
  const loc = e - 20;
  if (loc >= 0 && tv.getUint32(loc, true) === 0x07064b50) {
    const z64Off = Number(tv.getBigUint64(loc + 8, true));
    const z = new DataView((await readSlice(blob, z64Off, z64Off + 56)).buffer);
    if (z.getUint32(0, true) === 0x06064b50) {
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOff = Number(z.getBigUint64(48, true));
    }
  }
  const cd = await readSlice(blob, cdOff, cdOff + cdSize);
  const v = new DataView(cd.buffer);
  const dec = new TextDecoder();
  const out = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    let csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl));
    // zip64 extra field: the 0xFFFFFFFF fields follow in order usize, csize, offset
    for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) {
      const id = v.getUint16(x, true), len = v.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(v.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(v.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(v.getBigUint64(q, true)); }
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) out.push({ name, method, csize, usize, offset });
    p += 46 + nl + xl + cl;
  }
  return out;
}

export async function zipRead(blob, entry) {
  const h = new DataView((await readSlice(blob, entry.offset, entry.offset + 30)).buffer);
  if (h.getUint32(0, true) !== 0x04034b50) throw new Error(`Bad zip entry ${entry.name}`);
  const start = entry.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const data = await readSlice(blob, start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflate(data, 'deflate-raw');
  throw new Error(`Unsupported compression in ${entry.name}`);
}

// ---------------------------------------------------------------- FIT
const FIT_SUB = { 6: 'indoor', 58: 'indoor', 8: 'mtb', 7: 'road', 46: 'gravel', 49: 'gravel', 28: 'ebike', 47: 'ebike', 69: 'ebike' };

/**
 * Minimal FIT reader: file_id, zones_target, session, sport and record messages.
 * Returns { start, sport, subSport, lthr, maxHr, points: [{ t, hr, cad, power, dist, speed }] }
 * or { old: true } when the file was created before `since` (ms), or null if it isn't an activity.
 */
export function parseFit(bytes, { since = 0 } = {}) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const res = { start: null, sport: null, subSport: null, lthr: null, maxHr: null, points: [] };
  let pos = 0, isActivity = null;
  while (pos + 12 <= bytes.length) { // a file can chain several FIT segments
    const hs = v.getUint8(pos);
    if (String.fromCharCode(...bytes.subarray(pos + 8, pos + 12)) !== '.FIT') break;
    let end = pos + hs + v.getUint32(pos + 4, true);
    if (end <= pos + hs || end > bytes.length) end = bytes.length;
    let p = pos + hs;
    const defs = {};
    let lastT = 0, skipSeg = false;
    try { while (p < end && !skipSeg) {
      const h = v.getUint8(p++);
      let local, compressedT = null;
      if (h & 0x80) { // compressed timestamp header
        local = (h >> 5) & 3;
        const off = h & 0x1f;
        compressedT = (lastT & ~0x1f) + off + (off < (lastT & 0x1f) ? 0x20 : 0);
        lastT = compressedT;
      } else if (h & 0x40) { // definition
        local = h & 0x0f;
        const little = v.getUint8(p + 1) === 0;
        const global = v.getUint16(p + 2, little);
        const n = v.getUint8(p + 4);
        p += 5;
        const fields = [];
        for (let i = 0; i < n; i++, p += 3) fields.push([v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2)]);
        let devSize = 0;
        if (h & 0x20) { const dn = v.getUint8(p++); for (let i = 0; i < dn; i++, p += 3) devSize += v.getUint8(p + 1); }
        defs[local] = { global, little, fields, devSize };
        continue;
      } else local = h & 0x0f;
      const d = defs[local];
      if (!d) throw new Error('FIT: data before its definition');
      const m = {};
      for (const [num, size, base] of d.fields) {
        if (size === 1 || size === 2 || size === 4) {
          const raw = size === 1 ? v.getUint8(p) : size === 2 ? v.getUint16(p, d.little) : v.getUint32(p, d.little);
          const zType = (base & 0x1f) >= 10 && (base & 0x1f) <= 12;
          const invalid = zType ? raw === 0 : raw === (size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff) || ((base & 0x1f) === 3 && raw === 0x7fff) || ((base & 0x1f) === 1 && raw === 0x7f);
          if (!invalid) m[num] = raw;
        }
        p += size;
      }
      p += d.devSize;
      if (m[253] != null) lastT = m[253];
      const t = m[253] ?? compressedT ?? lastT;
      switch (d.global) {
        case 0: // file_id (a chained file can start with a settings segment)
          if (m[0] !== 4) { skipSeg = true; break; }
          isActivity = true;
          if (since && m[4] && (m[4] + FIT_EPOCH) * 1000 < since - 864e5) return { old: true };
          break;
        case 7: // zones_target
          if (m[1]) res.maxHr = m[1];
          if (m[2]) res.lthr = m[2];
          break;
        case 12: // sport
          if (res.sport == null && m[0] != null) { res.sport = m[0]; res.subSport = m[1] ?? null; }
          break;
        case 18: // session
          if (m[5] != null) { res.sport = m[5]; res.subSport = m[6] ?? res.subSport; }
          if (m[2] && (!res.start || m[2] < res.start)) res.start = m[2];
          break;
        case 20: { // record
          const speed = m[73] ?? m[6];
          res.points.push({
            t, hr: m[3] ?? null, cad: m[4] ?? null, power: m[7] ?? null,
            dist: m[5] != null ? m[5] / 100 : null, speed: speed != null ? speed / 1000 : null,
          });
          break;
        }
      }
    } } catch { /* truncated or odd file: keep what was read */ }
    pos = end + 2; // CRC
  }
  if (!isActivity || !res.points.length) return null;
  res.start = ((res.start || res.points[0].t) + FIT_EPOCH) * 1000;
  for (const pt of res.points) pt.t = (pt.t + FIT_EPOCH) * 1000;
  return res;
}

// ---------------------------------------------------------------- GPX / TCX (regex, so it also runs in Node)
const tag = (s, name) => { const m = s.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>\\s*([^<]*?)\\s*</(?:[\\w-]+:)?${name}>`, 'i')); return m ? m[1] : null; };
const num = (x) => (x == null || x === '' ? null : Number(x));
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function parseXmlActivity(text) {
  const isTcx = /<TrainingCenterDatabase/i.test(text);
  const res = { start: null, sport: null, subSport: null, lthr: null, maxHr: null, points: [], type: null };
  if (isTcx) {
    res.type = (text.match(/<Activity\s+Sport="([^"]+)"/i) || [])[1] || null;
    for (const blk of text.split(/<Trackpoint>/i).slice(1)) {
      const t = Date.parse(tag(blk, 'Time'));
      if (!t) continue;
      const hrBlk = blk.match(/<HeartRateBpm[^>]*>([\s\S]*?)<\/HeartRateBpm>/i);
      res.points.push({
        t, hr: hrBlk ? num(tag(hrBlk[1], 'Value')) : null, cad: num(tag(blk, 'Cadence') ?? tag(blk, 'RunCadence')),
        power: num(tag(blk, 'Watts')), dist: num(tag(blk, 'DistanceMeters')), speed: num(tag(blk, 'Speed')),
      });
    }
  } else {
    res.type = tag(text.split(/<trkseg/i)[0], 'type');
    let prev = null, dist = 0;
    for (const blk of text.split(/<trkpt\b/i).slice(1)) {
      const t = Date.parse(tag(blk, 'time'));
      if (!t) continue;
      const lat = num((blk.match(/lat="([^"]+)"/) || [])[1]), lon = num((blk.match(/lon="([^"]+)"/) || [])[1]);
      const here = lat != null && lon != null ? { lat, lon } : null;
      if (prev && here) dist += haversine(prev, here);
      if (here) prev = here;
      res.points.push({ t, hr: num(tag(blk, 'hr') ?? tag(blk, 'heartrate')), cad: num(tag(blk, 'cad') ?? tag(blk, 'cadence')), power: num(tag(blk, 'power') ?? tag(blk, 'watts')), dist: here ? dist : null, speed: null });
    }
  }
  if (!res.points.length) return null;
  res.points.sort((a, b) => a.t - b.t);
  res.start = res.points[0].t;
  return res;
}

// ---------------------------------------------------------------- to 1 Hz samples
/** 1 Hz moving-time samples in Rodillo's shape. Gaps up to GAP_FILL s hold the last values; longer gaps are pauses. */
export function toSamples(points) {
  const pts = points.filter((p) => p.t).sort((a, b) => a.t - b.t);
  const out = [];
  let dist = 0, lastDist = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    if (next && Math.round((next.t - p.t) / 1000) <= 0) continue; // duplicate second
    if (p.dist != null) { if (lastDist != null && p.dist >= lastDist) dist += p.dist - lastDist; lastDist = p.dist; }
    const s = { power: p.power || 0, hr: p.hr || 0, cadence: p.cad || 0, distance: dist, speed: p.speed || 0 };
    out.push(s);
    const gap = next ? Math.round((next.t - p.t) / 1000) : 1;
    if (gap > 1 && gap <= GAP_FILL) for (let k = 1; k < gap; k++) out.push({ ...s });
  }
  return out;
}

// ---------------------------------------------------------------- heart-rate load
/** Max HR of a ride as the best 5-s average (ignores one-sample strap spikes). */
export function bestHr5(hr) {
  let best = 0, sum = 0;
  for (let i = 0; i < hr.length; i++) { sum += hr[i]; if (i >= 5) sum -= hr[i - 5]; if (i >= 4 && hr[i] && hr[i - 4]) best = Math.max(best, sum / 5); }
  return Math.round(best);
}

/** TSS from heart rate: Banister TRIMP, scaled so one hour at threshold HR = 100. */
export function hrTss(hr, { rest, max, lthr }) {
  const w = (x) => x * 0.64 * Math.exp(1.92 * x);
  const range = Math.max(20, max - rest);
  let trimp = 0;
  for (const h of hr) if (h) trimp += w(Math.min(1, Math.max(0, (h - rest) / range))) / 60;
  const atLt = 60 * w(Math.min(1, Math.max(0.3, (lthr - rest) / range)));
  return Math.round((100 * trimp) / atLt);
}

// ---------------------------------------------------------------- reading inputs
const ACT_FILE = /\.(fit|gpx|tcx)(\.gz)?$/i;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Strava's activities.csv: { filename -> { name, type, date } } */
function stravaIndex(text) {
  const [head, ...rows] = parseCsv(text);
  const col = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
  const iName = col('activity name'), iType = col('activity type'), iDate = col('activity date'), iFile = col('filename');
  const out = {};
  for (const r of rows) {
    const f = r[iFile]?.trim();
    if (f) out[f] = { name: r[iName], type: r[iType], date: Date.parse(`${r[iDate]} UTC`) || null };
  }
  return out;
}

const isRideType = (type) => /ride|cycl|bik/i.test(type || '') && !/e-?(mountain )?bike|ebike/i.test(type || '');
function kindOf(act) {
  const ty = (act.stravaType || act.type || '').toLowerCase();
  if (act.stravaType) { // Strava's activity type is what he chose; it wins over the device's guess
    if (/e-?(mountain )?bike/.test(ty)) return 'ebike';
    if (/virtual|indoor/.test(ty)) return 'indoor';
    if (/mountain/.test(ty)) return 'mtb';
    if (/gravel/.test(ty)) return 'gravel';
    return 'outdoor';
  }
  return FIT_SUB[act.subSport] && FIT_SUB[act.subSport] !== 'road' ? FIT_SUB[act.subSport] : /virtual|indoor/.test(ty) ? 'indoor' : 'outdoor';
}
const KIND_NAME = { indoor: 'Indoor ride', mtb: 'Mountain bike ride', gravel: 'Gravel ride', outdoor: 'Ride' };

async function parseActivityFile(name, bytes, since) {
  const raw = await gunzipIf(name, bytes);
  if (/\.fit(\.gz)?$/i.test(name)) return parseFit(raw, { since });
  return parseXmlActivity(new TextDecoder().decode(raw));
}

/**
 * Reads the chosen files (zip exports and/or loose activity files) and returns the cycling
 * activities since `since` (ms). onProgress(done, total) while reading.
 */
export async function scanFiles(files, { since, onProgress = () => {} } = {}) {
  const found = [];
  const skip = { old: 0, notRide: 0, unreadable: 0, ebike: 0, noData: 0 };
  const jobs = []; // { name, read: () => bytes, source, meta }
  const fromZip = async (blob, depth) => {
    const entries = await zipEntries(blob);
    const csv = entries.find((e) => /(^|\/)activities\.csv$/i.test(e.name));
    const strava = csv ? stravaIndex(new TextDecoder().decode(await zipRead(blob, csv))) : null;
    const base = csv ? csv.name.replace(/activities\.csv$/i, '') : '';
    for (const e of entries) {
      if (/\.zip$/i.test(e.name) && depth < 2) { // Garmin exports nest the activity files in zips
        try { await fromZip(new Blob([await zipRead(blob, e)]), depth + 1); } catch { skip.unreadable++; }
        continue;
      }
      if (!ACT_FILE.test(e.name)) continue;
      let meta = null;
      if (strava) {
        meta = strava[e.name.slice(base.length)];
        if (!meta) continue; // media or other files Strava keeps next to activities
        if (!isRideType(meta.type)) { skip.notRide++; continue; }
        if (/e-?(mountain )?bike/i.test(meta.type)) { skip.ebike++; continue; }
        if (meta.date && meta.date < since - 864e5) { skip.old++; continue; }
      }
      jobs.push({ name: e.name, read: () => zipRead(blob, e), source: strava ? 'strava' : 'garmin', meta });
    }
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) await fromZip(f, 0);
    else if (ACT_FILE.test(f.name)) jobs.push({ name: f.name, read: async () => new Uint8Array(await f.arrayBuffer()), source: 'file', meta: null });
  }
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    onProgress(i, jobs.length);
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
    let act;
    try { act = await parseActivityFile(j.name, await j.read(), since); } catch { skip.unreadable++; continue; }
    if (!act) { skip.notRide++; continue; }
    if (act.old || act.start < since) { skip.old++; continue; }
    if (!j.meta && /\.fit(\.gz)?$/i.test(j.name) && act.sport !== 2) { skip.notRide++; continue; } // FIT sport 2 = cycling
    if (!j.meta && act.type && !isRideType(act.type) && !/^biking$/i.test(act.type)) { skip.notRide++; continue; }
    act.stravaType = j.meta?.type || null;
    act.kind = kindOf(act);
    if (act.kind === 'ebike') { skip.ebike++; continue; }
    act.name = j.meta?.name?.trim() || KIND_NAME[act.kind];
    act.source = j.source;
    act.file = j.name;
    found.push(act);
  }
  onProgress(jobs.length, jobs.length);
  return { found, skip };
}

// ---------------------------------------------------------------- planning and building
const span = (start, sec) => [start, start + sec * 1000];
const overlap = ([a0, a1], [b0, b1]) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, Math.min(a1 - a0, b1 - b0));

/**
 * Builds the ride documents. existing = summaries already in index.json (Rodillo rides win).
 * opts: { ftp, restHr } . Returns { docs, stats }.
 */
export function buildImport(found, existing, { ftp, restHr = 55 } = {}) {
  const acts = found.map((a) => {
    const samples = toSamples(a.points);
    const hr = samples.map((s) => s.hr);
    const hasPower = samples.filter((s) => s.power > 0).length > samples.length * 0.3;
    const hasHr = hr.filter(Boolean).length > samples.length * 0.5;
    const elapsed = a.points.length ? (a.points.at(-1).t - a.points[0].t) / 1000 : samples.length;
    return { ...a, samples, hasPower, hasHr, maxHr5: hasHr ? bestHr5(hr) : 0, elapsed };
  });
  const stats = { noData: 0, already: 0, dupes: 0, short: 0 };
  // one threshold for every heart-rate-only ride: the watch's own (zones_target) or 90% of the highest 5-s HR
  const maxHr = Math.min(210, Math.max(0, ...acts.map((a) => a.maxHr5), ...acts.map((a) => a.maxHr || 0)));
  const lthr = acts.map((a) => a.lthr).filter(Boolean).at(-1) || Math.round(maxHr * 0.9);
  const hrCfg = { rest: restHr, max: Math.max(maxHr, lthr + 5), lthr };
  // keep the better of two recordings of the same ride (power first, then longer)
  const keep = [];
  for (const a of acts.sort((x, y) => (y.hasPower - x.hasPower) || (y.samples.length - x.samples.length))) {
    if (a.samples.length < 300) { stats.short++; continue; }
    if (!a.hasPower && !a.hasHr) { stats.noData++; continue; }
    const s = span(a.start, a.elapsed);
    if (existing.some((r) => overlap(s, span(Date.parse(r.start), r.durSec)) > 0.5)) { stats.already++; continue; }
    if (keep.some((k) => overlap(s, span(k.start, k.elapsed)) > 0.5)) { stats.dupes++; continue; }
    keep.push(a);
  }
  const ids = new Set(existing.map((r) => r.id));
  const docs = keep.sort((x, y) => x.start - y.start).map((a) => {
    let startMs = a.start;
    while (ids.has(rideIdFor(startMs))) startMs += 60000; // ids are per minute
    ids.add(rideIdFor(startMs));
    const doc = buildRide(a.samples, { name: a.name, tags: ['imported', a.kind], ftp, startMs, source: a.source });
    const s = doc.summary;
    s.start = new Date(a.start).toISOString();
    s.elapsedSec = Math.round(a.elapsed);
    if (!a.hasPower) {
      Object.assign(s, { kj: null, avgP: null, np: null, if: null, ef: null, decoupling: null, bests: {}, zones: null, tss: hrTss(a.samples.map((x) => x.hr), hrCfg), tssFrom: 'hr', lthr: hrCfg.lthr });
    } else if (!a.hasHr) s.decoupling = null;
    s.slopeSec = 0;
    delete doc.streams.grade; delete doc.streams.target; delete doc.streams.gear;
    if (!a.hasPower) delete doc.streams.power;
    doc.intervals = [];
    return doc;
  });
  return { docs, stats, hrCfg, withPower: docs.filter((d) => d.summary.np != null).length };
}
