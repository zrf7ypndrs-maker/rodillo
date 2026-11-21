// Zwift trainer protocol ("Zwift Protocol", trainer side): lets the trainer do virtual shifting itself, like it does
// for Zwift. Rodillo sends the course grade and the virtual gear ratio; the trainer's firmware measures the real gear
// (cadence x flywheel speed) and sets its brake on its own, many times a second, with no Bluetooth round trip.
// Nov 11, 2026, asked for by Agustín after the app-side gearing (FTMS grade + closed-loop trim) lagged at 20%.
//
// Protocol notes: reverse-engineered by Makinolo from a KICKR CORE (makinolo.com, "Zwift Trainer protocol", Oct 2024);
// not an official spec. KICKR CORE needs firmware 1.3.17+ (Wahoo's virtual shifting support).
//  - service 0xFC82 (older: 00000001-19ca-4651-86e5-fa29dcdd09d1), same layout as the Zwift Ride controllers:
//    async notify 0002, control point / sync RX 0003 (write), sync TX 0004 (indicate)
//  - handshake: ASCII "RideOn" to 0003, like the Ride
//  - every message = 1 byte id + protobuf body
//      0x03 riding data (notify): { 1 power, 2 cadence, 3 speedX100, 4 hr, ... }
//      0x04 HubCommand (write):   { 3 PowerTarget, 4 SimulationParam, 5 PhysicalParam }
//         SimulationParam { 1 wind sint32 (m/s x100), 2 inclineX100 sint32, 3 CWa x10000 (Zwift 5100), 4 Crr x100000 (Zwift 400) }
//         PhysicalParam   { 2 GearRatioX10000, 4 BikeWeightX100, 5 RiderWeightX100 }
//  - Makinolo's example 04 2a 08 10 00 20 81 05 28 c4 3b = Physical { gear 0, bike 6.41 kg, rider 76.2 kg }.

import { uuid16, logMsg, hex } from './base.js?v=202611102147';
import { decodeProto } from './zwiftride.js?v=202611102147';

export const ZP_SERVICES = [uuid16(0xfc82), '00000001-19ca-4651-86e5-fa29dcdd09d1'];
const ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1';
const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e];
export const ZP_WHEEL = 2.105; // m: the wheel the trainer's virtual speed assumes (700 x 25c); other wheels scale the ratio

// ---- tiny protobuf writer ----
function varint(n) {
  const out = [];
  n = Math.max(0, Math.round(n));
  while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const zz = (n) => { n = Math.round(n); return n >= 0 ? 2 * n : -2 * n - 1; }; // sint32 zigzag
const fieldVarint = (num, v) => [...varint(num * 8), ...varint(v)];
const fieldMsg = (num, body) => [...varint(num * 8 + 2), ...varint(body.length), ...body];

/**
 * SimulationParam body: grade as a fraction (0.20 = 20%). Incline only by default, like qdomyos-zwift (known to work
 * on Wahoo/Zwift Hub): with wind, CWa and Crr in the same message the KICKR CORE took the gear but ignored the grade
 * (Nov 20, Agustín: 167 W at 25.5 km/h on "7%", a flat road). wind / cwa / crr go out only when given.
 */
export function simulationParam({ grade = 0, wind, cwa, crr } = {}) {
  return [
    ...(wind != null ? fieldVarint(1, zz(wind * 100)) : []),
    ...fieldVarint(2, zz(grade * 10000)),
    ...(cwa != null ? fieldVarint(3, cwa * 10000) : []),
    ...(crr != null ? fieldVarint(4, crr * 100000) : []),
  ];
}
/** PhysicalParam body. gearRatio = chainring / cog (e.g. 32/52 = 0.615); 0 leaves it out. */
export function physicalParam({ gearRatio = 0, bikeKg, riderKg } = {}) {
  return [
    ...fieldVarint(2, gearRatio * 10000),
    ...(bikeKg ? fieldVarint(4, bikeKg * 100) : []),
    ...(riderKg ? fieldVarint(5, riderKg * 100) : []),
  ];
}
/** 0x04 HubCommand with any of: powerTarget (W), sim (SimulationParam fields), physical (PhysicalParam fields). */
export function hubCommand({ powerTarget, sim, physical } = {}) {
  return new Uint8Array([
    0x04,
    ...(powerTarget != null ? fieldVarint(3, powerTarget) : []),
    ...(sim ? fieldMsg(4, simulationParam(sim)) : []),
    ...(physical ? fieldMsg(5, physicalParam(physical)) : []),
  ]);
}
/** 0x03 riding data body -> { power, cadence, speedKmh, hr }. */
export function ridingData(body) {
  const out = {};
  for (const [n, v] of decodeProto(body)) {
    if (n === 1) out.power = v;
    else if (n === 2) out.cadence = v;
    else if (n === 3) out.speedKmh = v / 100;
    else if (n === 4) out.hr = v;
  }
  return out;
}
const isRideOn = (b) => b.length >= 6 && RIDE_ON.every((c, i) => b[i] === c);

/**
 * What Zwift's own app sends after RideOn, byte for byte as qdomyos-zwift replays it (ftmsbike.cpp zwiftPlayInit(),
 * proven on Zwift-protocol trainers). Rodillo skipped it until Nov 20, when the KICKR CORE took the virtual gear but
 * never the grade. 0x41 08 05 is not decoded; 00 08 88 04 asks for the gear ratio (DataId 520); the rest are a gear
 * (ratio 2.4, 8.31 kg bike, 85 kg rider) and grades 1.73%, -0.85%, 0%. The ride's own values follow at once.
 */
export const ZWIFT_INIT = [
  [0x41, 0x08, 0x05],
  [0x04, 0x2a, 0x04, 0x10, 0xc0, 0xbb, 0x01],
  [0x00, 0x08, 0x00],
  [0x41, 0x08, 0x05],
  [0x00, 0x08, 0x88, 0x04],
  [0x04, 0x2a, 0x0a, 0x10, 0xc0, 0xbb, 0x01, 0x20, 0xbf, 0x06, 0x28, 0xb4, 0x42],
  [0x04, 0x22, 0x0b, 0x08, 0x00, 0x10, 0xda, 0x02, 0x18, 0xec, 0x27, 0x20, 0x90, 0x03],
  [0x04, 0x2a, 0x04, 0x10, 0xc0, 0xbb, 0x01],
  [0x00, 0x08, 0x88, 0x04],
  [0x04, 0x22, 0x03, 0x10, 0xa9, 0x01],
  [0x04, 0x2a, 0x04, 0x10, 0xc0, 0xbb, 0x01],
  [0x00, 0x08, 0x88, 0x04],
  [0x04, 0x22, 0x02, 0x10, 0x00],
].map((b) => new Uint8Array(b));
/** After every gear: ask for the gear ratio back, as Zwift and qdomyos-zwift do ("gearApply"). */
const GEAR_APPLY = new Uint8Array([0x00, 0x08, 0x88, 0x04]);

/**
 * The Zwift link on an already connected trainer. start() resolves true when the trainer answered the handshake
 * (a "RideOn" reply or riding data), false when it has no such service or stays silent: then Rodillo keeps doing
 * virtual shifting itself over FTMS.
 */
export class ZwiftHubLink {
  constructor(device) {
    this.dev = device; // BleDevice (write queue, server)
    this.ok = false;
    this.rx = null;
    this.data = {};
    this._last = null; this._lastAt = -Infinity; this._timer = null; this._wr = false;
  }

  async start(timeoutMs = 3000) {
    let svc = null;
    for (const id of ZP_SERVICES) { try { svc = await this.dev.server.getPrimaryService(id); break; } catch { /* next */ } }
    if (!svc) { logMsg('zwift', 'no Zwift service on the trainer: shifting stays in Rodillo'); return false; }
    try {
      this.rx = await svc.getCharacteristic(SYNC_RX);
      this._wr = this.rx.properties ? !this.rx.properties.writeWithoutResponse : false; // without response when it can
      const on = (e) => this._onData(e.target.value);
      for (const id of [ASYNC, SYNC_TX]) {
        try { const ch = await svc.getCharacteristic(id); ch.addEventListener('characteristicvaluechanged', on); await ch.startNotifications(); } catch { /* optional */ }
      }
      const answered = new Promise((res) => { this._answer = res; setTimeout(() => res(false), timeoutMs); });
      await this.dev.write(this.rx, RIDE_ON, this._wr);
      this.ok = await answered;
      logMsg('zwift', this.ok ? 'trainer answered: shifting in the trainer' : 'no answer to RideOn: shifting stays in Rodillo');
      if (this.ok) for (const m of ZWIFT_INIT) await this.dev.write(this.rx, m, this._wr);
      return this.ok;
    } catch (e) {
      logMsg('zwift', `setup failed (${e.message}): shifting stays in Rodillo`);
      return false;
    }
  }

  _onData(dv) {
    const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    if (!b.length) return;
    if (isRideOn(b)) { logMsg('zwift', `rx ${hex(dv)}`); this._answer?.(true); return; }
    if (b[0] === 0x03) { this.data = ridingData(b.slice(1)); this._answer?.(true); return; }
    if ((this._logged = (this._logged || 0) + 1) <= 30) logMsg('zwift', `rx ${hex(dv)}`); // other messages: first 30 to the log
  }

  /**
   * Course grade + virtual gear, sent when something changed (grade by 0.1% or more, or the gear) and at least every
   * 2 s, never more than 4 times a second. The trainer does the rest. Gear and grade go out as separate messages,
   * the way Zwift sends them (gear + gear-ratio request first, grade last), each only when it changed or on the 2 s
   * refresh: one combined message moved the gear but left the grade at flat on the KICKR CORE (Nov 20).
   */
  setSim({ grade, gearRatio, riderKg, bikeKg }) {
    if (!this.ok || !this.rx) return;
    const g = Math.round(grade * 1000) / 1000, r = Math.round(gearRatio * 10000) / 10000;
    const now = performance.now(), last = this._last;
    const gChanged = !last || Math.abs(last.g - g) >= 0.001;
    const pChanged = !last || last.r !== r || last.riderKg !== riderKg || last.bikeKg !== bikeKg;
    const refresh = now - this._lastAt >= 2000;
    if (!gChanged && !pChanged && !refresh) return;
    if (now - this._lastAt < 250) { // too soon: send the newest values a moment later
      this._next = { grade, gearRatio, riderKg, bikeKg };
      if (!this._timer) this._timer = setTimeout(() => { this._timer = null; const n = this._next; this._next = null; if (n) this.setSim(n); }, 260);
      return;
    }
    this._last = { g, r, riderKg, bikeKg }; this._lastAt = now;
    if (pChanged || refresh) {
      this.dev.write(this.rx, hubCommand({ physical: { gearRatio: r, riderKg, bikeKg } }), this._wr);
      this.dev.write(this.rx, GEAR_APPLY, this._wr);
    }
    if (gChanged || refresh) {
      this.dev.write(this.rx, hubCommand({ sim: { grade: g } }), this._wr);
      // the log shows each whole-percent grade sent, so a trainer that ignores it can be told apart from one that never got it
      const pct = Math.round(g * 100);
      if (pct !== this._loggedPct) { this._loggedPct = pct; logMsg('zwift', `grade ${pct}% sent`); }
    }
  }

  /** Forget what was sent (mode switch, e.g. after ERG over FTMS): Zwift's start-up sequence again, then the next
   *  setSim goes out at once. */
  reset() {
    this._last = null; this._lastAt = -Infinity;
    if (this.ok && this.rx) for (const m of ZWIFT_INIT) this.dev.write(this.rx, m, this._wr);
  }
}
