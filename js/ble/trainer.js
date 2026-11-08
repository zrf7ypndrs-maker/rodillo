// Smart trainer over FTMS (Fitness Machine Service), with Cycling Power as a
// fallback/supplement for power, cadence and wheel data.

import { BleDevice, uuid16, logMsg, hex } from './base.js?v=202611082251';

export const FTMS = uuid16(0x1826);
export const CPS = uuid16(0x1818);
const IBD = uuid16(0x2ad2);       // Indoor Bike Data
const FTMS_CP = uuid16(0x2ad9);   // Fitness Machine Control Point
const FTMS_STATUS = uuid16(0x2ada);
const CPM = uuid16(0x2a63);       // Cycling Power Measurement

/** Parse FTMS Indoor Bike Data. Returns only the fields present. */
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const r = {};
  if (!(flags & 0x0001)) { r.speedKmh = dv.getUint16(o, true) / 100; o += 2; } // bit0 = "more data": speed present when 0
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004) { r.cadence = dv.getUint16(o, true) / 2; o += 2; }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010) { r.distance = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16); o += 3; }
  if (flags & 0x0020) { r.resistance = dv.getInt16(o, true); o += 2; }
  if (flags & 0x0040) { r.power = dv.getInt16(o, true); o += 2; }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy
  if (flags & 0x0200) { r.hr = dv.getUint8(o); o += 1; }
  return r;
}

/** Parse Cycling Power Measurement: power plus raw wheel/crank revolution data. */
export function parseCyclingPower(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const r = { power: dv.getInt16(o, true) };
  o += 2;
  if (flags & 0x0001) o += 1;
  if (flags & 0x0004) o += 2;
  if (flags & 0x0010) { r.wheelRevs = dv.getUint32(o, true); r.wheelTime = dv.getUint16(o + 4, true); o += 6; }
  if (flags & 0x0020) { r.crankRevs = dv.getUint16(o, true); r.crankTime = dv.getUint16(o + 2, true); o += 4; }
  return r;
}

/** Turns cumulative crank revolution events into rpm. */
export class CrankCadence {
  constructor() { this.last = null; this.rpm = 0; this.stale = 0; }
  update(revs, time) {
    if (this.last) {
      const dr = (revs - this.last.revs + 0x10000) & 0xffff;
      const dt = ((time - this.last.time + 0x10000) & 0xffff) / 1024;
      if (dr > 0 && dt > 0) { this.rpm = (dr / dt) * 60; this.stale = 0; }
      else if (++this.stale > 3) this.rpm = 0;
    }
    this.last = { revs, time };
    return this.rpm;
  }
}

export const cmd = {
  requestControl: () => [0x00],
  reset: () => [0x01],
  start: () => [0x07],
  setTargetPower: (w) => { const b = new DataView(new ArrayBuffer(3)); b.setUint8(0, 0x05); b.setInt16(1, Math.round(w), true); return new Uint8Array(b.buffer); },
  // grade fraction, crr, cw (kg/m), wind m/s
  setSim: (grade, crr = 0, cw = 0, wind = 0) => {
    const b = new DataView(new ArrayBuffer(7));
    b.setUint8(0, 0x11);
    b.setInt16(1, Math.round(wind * 1000), true);
    b.setInt16(3, Math.max(-32768, Math.min(32767, Math.round(grade * 10000))), true); // 0.01 % units
    b.setUint8(5, Math.max(0, Math.min(255, Math.round(crr * 10000))));
    b.setUint8(6, Math.max(0, Math.min(255, Math.round(cw * 100))));
    return new Uint8Array(b.buffer);
  },
};

export class Trainer extends BleDevice {
  constructor() {
    super('trainer');
    this.data = { power: 0, cadence: 0, speedKmh: 0, hr: 0 };
    this.cp = null;
    this._pending = null;
    this._busy = false;
    this.lastCmd = null;
    this.crank = new CrankCadence();
    this.hasFtmsCadence = false;
    this.mode = null;
  }

  static requestOptions() {
    return {
      filters: [{ services: [FTMS] }, { namePrefix: 'KICKR' }],
      optionalServices: [FTMS, CPS, uuid16(0x180a), uuid16(0x180f), uuid16(0xfc82), 'a026ee0b-0a7d-4ab3-97fa-f1500f9feb8b'],
    };
  }

  async setup() {
    const ftms = await this.server.getPrimaryService(FTMS);
    const ibd = await ftms.getCharacteristic(IBD);
    ibd.addEventListener('characteristicvaluechanged', (e) => this._onIbd(e.target.value));
    await ibd.startNotifications();

    this.cp = await ftms.getCharacteristic(FTMS_CP);
    this.cp.addEventListener('characteristicvaluechanged', (e) => this._onCpResponse(e.target.value));
    await this.cp.startNotifications(); // indications

    try {
      const st = await ftms.getCharacteristic(FTMS_STATUS);
      st.addEventListener('characteristicvaluechanged', (e) => logMsg('trainer', `status ${hex(e.target.value)}`));
      await st.startNotifications();
    } catch { /* optional */ }

    try {
      const cps = await this.server.getPrimaryService(CPS);
      const m = await cps.getCharacteristic(CPM);
      m.addEventListener('characteristicvaluechanged', (e) => this._onCpm(e.target.value));
      await m.startNotifications();
    } catch { logMsg('trainer', 'no cycling power service (fine)'); }

    await this.write(this.cp, cmd.requestControl());
    await this.write(this.cp, cmd.start());
    if (this.lastCmd) await this.write(this.cp, this.lastCmd); // restore after reconnect
  }

  _onIbd(dv) {
    const r = parseIndoorBikeData(dv);
    if (r.cadence !== undefined) this.hasFtmsCadence = true;
    Object.assign(this.data, r);
    this.data.t = performance.now();
    this.emit('data', this.data);
  }

  _onCpm(dv) {
    const r = parseCyclingPower(dv);
    if (!this.hasFtmsCadence && r.crankRevs !== undefined) this.data.cadence = this.crank.update(r.crankRevs, r.crankTime);
  }

  _onCpResponse(dv) {
    if (dv.getUint8(0) !== 0x80) return;
    const op = dv.getUint8(1), res = dv.getUint8(2);
    if (res !== 0x01) {
      logMsg('trainer', `control point op 0x${op.toString(16)} result ${res}`);
      if (res === 0x05) this.write(this.cp, cmd.requestControl()); // control not permitted: re-request
    }
  }

  /** Send a control command, coalescing so only the latest pending one is sent. */
  _send(bytes) {
    this.lastCmd = bytes;
    if (!this.cp || this.state !== 'connected') return;
    if (this._busy) { this._pending = bytes; return; }
    this._busy = true;
    this.write(this.cp, bytes).finally(() => {
      this._busy = false;
      if (this._pending) { const p = this._pending; this._pending = null; this._send(p); }
    });
  }

  setErg(watts) {
    watts = Math.max(0, Math.min(2000, Math.round(watts)));
    if (this.mode === 'erg' && this._lastErg === watts) return;
    this.mode = 'erg'; this._lastErg = watts;
    this._send(cmd.setTargetPower(watts));
  }

  setGrade(grade) {
    const g = Math.round(grade * 10000) / 10000; // 0.01 % resolution
    if (this.mode === 'sim' && this._lastGrade === g) return;
    this.mode = 'sim'; this._lastGrade = g;
    this._send(cmd.setSim(g, 0, 0, 0)); // crr/cw zeroed: the app models them itself
  }
}
