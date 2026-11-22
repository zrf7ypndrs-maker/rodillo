// @ts-check
import { BleDevice, uuid16 } from './base.js';

const HRS = uuid16(0x180d);
const HRM = uuid16(0x2a37);

export function parseHr(dv) {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

// a strap that goes quiet this long reads as no heart rate: "--" on screen and a gap in the file, never a frozen number
export const HR_STALE_MS = 5000;

export class HeartRate extends BleDevice {
  constructor() {
    super('hr'); this._bpm = 0; this.t = 0;
    this.on('state', (st) => { if (st !== 'connected') this._bpm = 0; });
  }

  /** Last beat rate, 0 once the strap is disconnected or silent for HR_STALE_MS (lost skin contact keeps the link up). */
  get bpm() { return this._bpm && performance.now() - this.t < HR_STALE_MS ? this._bpm : 0; }

  static requestOptions() {
    return { filters: [{ services: [HRS] }], optionalServices: [uuid16(0x180a), uuid16(0x180f)] };
  }

  async setup() {
    const svc = await this.server.getPrimaryService(HRS);
    const ch = await svc.getCharacteristic(HRM);
    ch.addEventListener('characteristicvaluechanged', (e) => {
      this._bpm = parseHr(e.target.value);
      this.t = performance.now();
      this.emit('data', this.bpm);
    });
    await ch.startNotifications();
  }
}
