// Minimal FIT activity encoder (file_id, event, record, lap, session, activity).
// Produces files Garmin Connect, Strava and TrainingPeaks accept.

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in unix seconds

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];
function crc16(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

// base types: [code, size, invalid]
const T = {
  enum: [0x00, 1, 0xff], uint8: [0x02, 1, 0xff], sint16: [0x83, 2, 0x7fff],
  uint16: [0x84, 2, 0xffff], uint32: [0x86, 4, 0xffffffff], uint32z: [0x8c, 4, 0],
};

// global message number -> [ [fieldNum, type, key, scale, offset], ... ]
const MSGS = {
  file_id: [0, [[0, 'enum', 'type'], [1, 'uint16', 'manufacturer'], [2, 'uint16', 'product'], [3, 'uint32z', 'serial'], [4, 'uint32', 'timeCreated']]],
  event: [21, [[253, 'uint32', 'timestamp'], [0, 'enum', 'event'], [1, 'enum', 'eventType']]],
  record: [20, [[253, 'uint32', 'timestamp'], [3, 'uint8', 'hr'], [4, 'uint8', 'cadence'], [5, 'uint32', 'distance', 100], [6, 'uint16', 'speed', 1000], [7, 'uint16', 'power'], [2, 'uint16', 'altitude', 5, 500], [9, 'sint16', 'grade', 100]]],
  lap: [19, [[253, 'uint32', 'timestamp'], [254, 'uint16', 'index'], [2, 'uint32', 'startTime'], [7, 'uint32', 'elapsed', 1000], [8, 'uint32', 'timer', 1000], [9, 'uint32', 'distance', 100], [0, 'enum', 'event'], [1, 'enum', 'eventType'], [25, 'enum', 'sport'], [19, 'uint16', 'avgPower'], [20, 'uint16', 'maxPower'], [15, 'uint8', 'avgHr'], [16, 'uint8', 'maxHr'], [17, 'uint8', 'avgCadence'], [11, 'uint16', 'calories'], [21, 'uint16', 'ascent']]],
  session: [18, [[253, 'uint32', 'timestamp'], [254, 'uint16', 'index'], [2, 'uint32', 'startTime'], [7, 'uint32', 'elapsed', 1000], [8, 'uint32', 'timer', 1000], [9, 'uint32', 'distance', 100], [0, 'enum', 'event'], [1, 'enum', 'eventType'], [5, 'enum', 'sport'], [6, 'enum', 'subSport'], [20, 'uint16', 'avgPower'], [21, 'uint16', 'maxPower'], [16, 'uint8', 'avgHr'], [17, 'uint8', 'maxHr'], [18, 'uint8', 'avgCadence'], [11, 'uint16', 'calories'], [34, 'uint16', 'np'], [35, 'uint16', 'tss', 10], [22, 'uint16', 'ascent'], [25, 'uint16', 'firstLap'], [26, 'uint16', 'numLaps']]],
  activity: [34, [[253, 'uint32', 'timestamp'], [0, 'uint32', 'timer', 1000], [1, 'uint16', 'numSessions'], [2, 'enum', 'type'], [3, 'enum', 'event'], [4, 'enum', 'eventType'], [5, 'uint32', 'localTimestamp']]],
};

class Writer {
  constructor() { this.buf = []; this.local = {}; this.nextLocal = 0; }
  u8(v) { this.buf.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  write(name, data) {
    const [global, fields] = MSGS[name];
    if (this.local[name] === undefined) {
      const l = this.nextLocal++;
      this.local[name] = l;
      this.u8(0x40 | l); this.u8(0); this.u8(0); this.u16(global); this.u8(fields.length);
      for (const [num, type] of fields) { this.u8(num); this.u8(T[type][1]); this.u8(T[type][0]); }
    }
    this.u8(this.local[name]);
    for (const [, type, key, scale = 1, offset = 0] of fields) {
      const [, size, invalid] = T[type];
      let v = data[key];
      if (v === undefined || v === null || !Number.isFinite(v)) v = invalid;
      else {
        v = Math.round((v + offset) * scale);
        if (type === 'sint16') v = Math.max(-32767, Math.min(32767, v)) & 0xffff;
        else v = Math.max(0, Math.min(type === 'uint32z' ? 0xfffffffe : invalid - 1, v));
      }
      if (size === 1) this.u8(v); else if (size === 2) this.u16(v); else this.u32(v >>> 0);
    }
  }
}

const fitTime = (unixMs) => Math.round(unixMs / 1000) - FIT_EPOCH;

/**
 * samples: [{ t: unixMs, power, hr, cadence, speed (m/s), distance (m), altitude (m), grade (%) }]
 * laps: [{ startIdx, endIdx }] indices into samples (optional; one lap if omitted)
 */
export function encodeActivity(samples, laps, summary = {}) {
  if (!samples.length) throw new Error('No samples');
  const w = new Writer();
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  w.write('file_id', { type: 4, manufacturer: 255, product: 1, serial: 12345, timeCreated: fitTime(t0) });
  w.write('event', { timestamp: fitTime(t0), event: 0, eventType: 0 });
  for (const s of samples) {
    w.write('record', {
      timestamp: fitTime(s.t), hr: s.hr || undefined, cadence: s.cadence, distance: s.distance,
      speed: s.speed, power: s.power, altitude: s.altitude, grade: s.grade,
    });
  }
  w.write('event', { timestamp: fitTime(t1), event: 0, eventType: 4 });

  const lapList = laps && laps.length ? laps : [{ startIdx: 0, endIdx: samples.length - 1 }];
  lapList.forEach((lap, i) => {
    const st = statsFor(samples.slice(lap.startIdx, lap.endIdx + 1));
    w.write('lap', {
      timestamp: fitTime(samples[lap.endIdx].t), index: i, startTime: fitTime(samples[lap.startIdx].t),
      elapsed: st.elapsed, timer: st.timer, distance: st.distance, event: 9, eventType: 1, sport: 2,
      avgPower: st.avgPower, maxPower: st.maxPower, avgHr: st.avgHr, maxHr: st.maxHr,
      avgCadence: st.avgCadence, calories: st.kcal, ascent: st.ascent,
    });
  });
  const st = statsFor(samples);
  w.write('session', {
    timestamp: fitTime(t1), index: 0, startTime: fitTime(t0), elapsed: st.elapsed, timer: st.timer,
    distance: st.distance, event: 8, eventType: 1, sport: 2, subSport: 58,
    avgPower: st.avgPower, maxPower: st.maxPower, avgHr: st.avgHr, maxHr: st.maxHr,
    avgCadence: st.avgCadence, calories: st.kcal, np: st.np, tss: summary.tss, ascent: st.ascent,
    firstLap: 0, numLaps: lapList.length,
  });
  const tzOffset = -new Date(t1).getTimezoneOffset() * 60;
  w.write('activity', {
    timestamp: fitTime(t1), timer: st.timer, numSessions: 1, type: 0, event: 26, eventType: 1,
    localTimestamp: fitTime(t1) + tzOffset,
  });

  const data = w.buf;
  const header = [14, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
  const profile = 2132;
  header[2] = profile & 0xff; header[3] = profile >> 8;
  header[4] = data.length & 0xff; header[5] = (data.length >> 8) & 0xff;
  header[6] = (data.length >> 16) & 0xff; header[7] = (data.length >>> 24) & 0xff;
  const hcrc = crc16(header.slice(0, 12));
  header[12] = hcrc & 0xff; header[13] = hcrc >> 8;
  const all = header.concat(data);
  const crc = crc16(all);
  all.push(crc & 0xff, crc >> 8);
  return new Uint8Array(all);
}

export function statsFor(samples) {
  const n = samples.length;
  const wall = n > 1 ? (samples[n - 1].t - samples[0].t) / 1000 : 0;
  const timer = n; // one sample per active second
  const elapsed = Math.max(wall, timer);
  let pSum = 0, pMax = 0, hSum = 0, hN = 0, hMax = 0, cSum = 0, cN = 0, ascent = 0, joules = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    pSum += s.power || 0; pMax = Math.max(pMax, s.power || 0);
    if (s.hr) { hSum += s.hr; hN++; hMax = Math.max(hMax, s.hr); }
    if (s.cadence) { cSum += s.cadence; cN++; }
    if (i) {
      const dt = (s.t - samples[i - 1].t) / 1000;
      joules += (s.power || 0) * dt;
      const da = (s.altitude || 0) - (samples[i - 1].altitude || 0);
      if (da > 0) ascent += da;
    }
  }
  // normalized power: 30 s rolling average, 4th power mean
  let np;
  if (n >= 30) {
    let roll = 0, acc = 0, k = 0;
    for (let i = 0; i < n; i++) {
      roll += samples[i].power || 0;
      if (i >= 30) roll -= samples[i - 30].power || 0;
      if (i >= 29) { acc += Math.pow(roll / 30, 4); k++; }
    }
    np = Math.round(Math.pow(acc / k, 0.25));
  }
  return {
    elapsed, timer, distance: n ? samples[n - 1].distance || 0 : 0,
    avgPower: n ? Math.round(pSum / n) : 0, maxPower: Math.round(pMax),
    avgHr: hN ? Math.round(hSum / hN) : undefined, maxHr: hN ? hMax : undefined,
    avgCadence: cN ? Math.round(cSum / cN) : undefined,
    kcal: Math.round(joules / 1000 / 0.24 / 4.184), // ~24% gross efficiency
    ascent: Math.round(ascent), np,
  };
}
