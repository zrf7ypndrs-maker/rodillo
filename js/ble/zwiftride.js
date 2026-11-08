// Zwift Ride handlebar controllers (also works for Click v1 / Play on the Ride protocol).
// Protocol notes (from the open-source BikeControl project):
//  - custom service 0xFC82 (older devices: 00000001-19ca-4651-86e5-fa29dcdd09d1)
//  - async notify  00000002-19ca-..., sync RX write 00000003-..., sync TX indicate 00000004-...
//  - handshake: write ASCII "RideOn" to sync RX
//  - button frames: opcode 0x23 + protobuf RideKeyPadStatus
//      field 1 (varint) ButtonMap: a bit is 0 while that button is PRESSED
//      field 3 (repeated msg) AnalogPaddles { 1: location enum, 2: sint32 value }
//  - battery: opcode 0x19 + protobuf { 2: percent }
//  - Ride firmware > 1.2.0 hides the service until Zwift unlocks it.

import { BleDevice, uuid16, logMsg, hex } from './base.js?v=202611082319';

export const RIDE_SERVICE = uuid16(0xfc82);
export const LEGACY_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
const ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1';
const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e];

export const BUTTONS = {
  left: 0x00001, up: 0x00002, right: 0x00004, down: 0x00008,
  a: 0x00010, b: 0x00020, y: 0x00040, z: 0x00080,
  shiftUpL: 0x00100, shiftDnL: 0x00200, powerUpL: 0x00400, onOffL: 0x00800,
  shiftUpR: 0x01000, shiftDnR: 0x02000, powerUpR: 0x04000, onOffR: 0x08000,
};

// ---- tiny protobuf reader ----
function readVarint(b, o) {
  let v = 0, shift = 0, byte;
  do {
    byte = b[o.i++];
    v += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80 && o.i < b.length);
  return v;
}
export function decodeProto(bytes) {
  const o = { i: 0 };
  const fields = [];
  while (o.i < bytes.length) {
    const key = readVarint(bytes, o);
    const num = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) fields.push([num, readVarint(bytes, o)]);
    else if (wt === 2) { const len = readVarint(bytes, o); fields.push([num, bytes.slice(o.i, o.i + len)]); o.i += len; }
    else if (wt === 5) { o.i += 4; }
    else if (wt === 1) { o.i += 8; }
    else break;
  }
  return fields;
}
const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

/** Decode a RideKeyPadStatus body into the set of pressed button names. */
export function decodeRideButtons(body, analogThreshold = 25) {
  const pressed = new Set();
  for (const [num, val] of decodeProto(body)) {
    if (num === 1) {
      for (const [name, mask] of Object.entries(BUTTONS)) if ((val & mask) === 0) pressed.add(name);
    } else if (num === 3 && val instanceof Uint8Array) {
      let loc = 0, v = 0;
      for (const [n2, v2] of decodeProto(val)) { if (n2 === 1) loc = v2; if (n2 === 2) v = zigzag(v2); }
      if (Math.abs(v) >= analogThreshold) { if (loc === 0) pressed.add('paddleL'); if (loc === 1) pressed.add('paddleR'); }
    }
  }
  return pressed;
}

export class ZwiftRide extends BleDevice {
  constructor() {
    super('controller');
    this.pressed = new Set();
    this.battery = null;
  }

  /**
   * The Ride shows up as two Bluetooth devices, both named "Zwift Ride": left hood
   * (manufacturer data 0x08) and right hood (0x07). side = 'left' | 'right' | 'all'.
   */
  static requestOptions(side = 'left') {
    const md = (b) => [{ manufacturerData: [{ companyIdentifier: 0x094a, dataPrefix: new Uint8Array([b]) }] }];
    return {
      filters: side === 'all' ? [{ namePrefix: 'Zwift' }, { services: [RIDE_SERVICE] }] : md(side === 'right' ? 0x07 : 0x08),
      optionalServices: [RIDE_SERVICE, LEGACY_SERVICE, uuid16(0x180a), uuid16(0x180f)],
    };
  }

  async setup() {
    let svc;
    try { svc = await this.server.getPrimaryService(RIDE_SERVICE); }
    catch {
      try { svc = await this.server.getPrimaryService(LEGACY_SERVICE); }
      catch {
        const fw = this.info.firmware || '?';
        throw new Error(`Zwift button service hidden (firmware ${fw}). Ride firmware above 1.2.0 is locked to Zwift.`);
      }
    }
    const asyncCh = await svc.getCharacteristic(ASYNC);
    const tx = await svc.getCharacteristic(SYNC_TX);
    this.rx = await svc.getCharacteristic(SYNC_RX);
    const onData = (e) => this._onData(e.target.value);
    asyncCh.addEventListener('characteristicvaluechanged', onData);
    tx.addEventListener('characteristicvaluechanged', onData);
    await asyncCh.startNotifications();
    await tx.startNotifications();
    await this.write(this.rx, RIDE_ON, false);
    logMsg('controller', `handshake sent, firmware ${this.info.firmware || 'unknown'}`);
  }

  _onData(dv) {
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    if (!bytes.length) return;
    const op = bytes[0];
    const body = bytes.slice(1);
    if (op === 0x23 || op === 0x07 || op === 0x37) {
      const now = decodeRideButtons(body);
      for (const b of now) if (!this.pressed.has(b)) this.emit('press', b);
      for (const b of this.pressed) if (!now.has(b)) this.emit('release', b);
      this.pressed = now;
    } else if (op === 0x19) {
      for (const [n, v] of decodeProto(body)) if (n === 2) { this.battery = v; this.emit('battery', v); }
    } else if (op !== 0x15 && !(bytes.length >= 6 && bytes[0] === 0x52)) {
      logMsg('controller', `rx ${hex(dv)}`);
    }
  }

  /** Short haptic buzz (Ride supports it). */
  vibrate() {
    if (this.rx) this.write(this.rx, [0x12, 0x12, 0x08, 0x0a, 0x06, 0x08, 0x02, 0x10, 0x00, 0x18, 0x20], false);
  }
}
