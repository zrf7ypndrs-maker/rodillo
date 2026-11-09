import { BleDevice, uuid16 } from './base.js?v=202611092202';

const HRS = uuid16(0x180d);
const HRM = uuid16(0x2a37);

export function parseHr(dv) {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

export class HeartRate extends BleDevice {
  constructor() { super('hr'); this.bpm = 0; this.t = 0; }

  static requestOptions() {
    return { filters: [{ services: [HRS] }], optionalServices: [uuid16(0x180a), uuid16(0x180f)] };
  }

  async setup() {
    const svc = await this.server.getPrimaryService(HRS);
    const ch = await svc.getCharacteristic(HRM);
    ch.addEventListener('characteristicvaluechanged', (e) => {
      this.bpm = parseHr(e.target.value);
      this.t = performance.now();
      this.emit('data', this.bpm);
    });
    await ch.startNotifications();
  }
}
