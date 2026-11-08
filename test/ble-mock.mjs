// Exercise the Web Bluetooth device classes against a fake GATT server.
import assert from 'node:assert/strict';
import { Trainer } from '../js/ble/trainer.js';
import { ZwiftRide } from '../js/ble/zwiftride.js';
import { HeartRate } from '../js/ble/hr.js';
import { uuid16 } from '../js/ble/base.js';

globalThis.performance ??= { now: () => Date.now() };
globalThis.TextDecoder ??= (await import('node:util')).TextDecoder;

class FakeChar {
  constructor(uuid, value) { this.uuid = uuid; this.l = []; this.writes = []; this.value = value; }
  addEventListener(_, f) { this.l.push(f); }
  async startNotifications() { this.notifying = true; }
  async readValue() { return new DataView(new TextEncoder().encode(this.value || '').buffer); }
  async writeValueWithResponse(d) { this.writes.push([...d]); if (this.onWrite) this.onWrite(d); }
  async writeValueWithoutResponse(d) { this.writes.push([...d]); }
  fire(bytes) { const v = new DataView(new Uint8Array(bytes).buffer); for (const f of this.l) f({ target: { value: v } }); }
}
class FakeService {
  constructor(uuid, chars) { this.uuid = uuid; this.chars = Object.fromEntries(chars.map((c) => [c.uuid, c])); }
  async getCharacteristic(u) { if (!this.chars[u]) throw new Error('no char ' + u); return this.chars[u]; }
}
function fakeDevice(name, services) {
  const map = Object.fromEntries(services.map((s) => [s.uuid, s]));
  return {
    name, id: name, addEventListener() {},
    gatt: {
      connected: true,
      async connect() { return { async getPrimaryService(u) { if (!map[u]) throw new Error('no svc ' + u); return map[u]; }, async getPrimaryServices() { return services; } }; },
    },
  };
}

// ---- trainer
const ibd = new FakeChar(uuid16(0x2ad2));
const cp = new FakeChar(uuid16(0x2ad9));
cp.onWrite = (d) => setTimeout(() => cp.fire([0x80, d[0], 0x01]), 1);
const fw = new FakeChar(uuid16(0x2a26), '3.5.37');
const trainer = new Trainer();
await trainer.attach(fakeDevice('KICKR CORE B559', [
  new FakeService(uuid16(0x1826), [ibd, cp]),
  new FakeService(uuid16(0x180a), [fw]),
]));
assert.equal(trainer.state, 'connected');
assert.equal(trainer.info.firmware, '3.5.37');
assert.deepEqual(cp.writes, [[0x00], [0x07]]);
ibd.fire([0x44, 0x00, 0xb8, 0x0b, 0xb4, 0x00, 0xfa, 0x00]);
assert.equal(trainer.data.power, 250);
trainer.setErg(200); trainer.setErg(205); trainer.setErg(210); // coalesce
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(cp.writes.slice(2), [[0x05, 200, 0], [0x05, 210, 0]], JSON.stringify(cp.writes));
trainer.setGrade(0.05);
await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(cp.writes.at(-1), [0x11, 0, 0, 0xf4, 0x01, 0, 0]);
console.log('ok - trainer connect, control, coalescing');

// ---- zwift ride
const asyncC = new FakeChar('00000002-19ca-4651-86e5-fa29dcdd09d1');
const rx = new FakeChar('00000003-19ca-4651-86e5-fa29dcdd09d1');
const tx = new FakeChar('00000004-19ca-4651-86e5-fa29dcdd09d1');
const ride = new ZwiftRide();
const presses = [];
ride.on('press', (b) => presses.push(b));
await ride.attach(fakeDevice('Zwift Ride', [new FakeService(uuid16(0xfc82), [asyncC, rx, tx]), new FakeService(uuid16(0x180a), [new FakeChar(uuid16(0x2a26), '1.2.0')])]));
await new Promise((r) => setTimeout(r, 5));
assert.deepEqual(rx.writes[0], [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);
asyncC.fire([0x23, 0x08, 0xff, 0xdf, 0xff, 0xff, 0x0f]); // shiftUpR (0x1000) pressed
asyncC.fire([0x23, 0x08, 0xff, 0xdf, 0xff, 0xff, 0x0f]); // repeat: no new press
asyncC.fire([0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f]); // released
asyncC.fire([0x23, 0x08, 0xef, 0xff, 0xff, 0xff, 0x0f]); // a (0x10)
asyncC.fire([0x19, 0x08, 0x00, 0x10, 0x55]);              // battery 85
assert.deepEqual(presses, ['shiftUpR', 'a']);
assert.equal(ride.battery, 85);
console.log('ok - zwift ride handshake, buttons, battery');

// locked firmware: service hidden
const locked = new ZwiftRide();
await assert.rejects(locked.attach(fakeDevice('Zwift Ride', [new FakeService(uuid16(0x180a), [new FakeChar(uuid16(0x2a26), '1.3.1')])])), /firmware 1.3.1/);
console.log('ok - locked firmware is reported clearly');

// ---- hr
const hrm = new FakeChar(uuid16(0x2a37));
const hr = new HeartRate();
await hr.attach(fakeDevice('HRM-Pro', [new FakeService(uuid16(0x180d), [hrm])]));
hrm.fire([0x00, 141]);
assert.equal(hr.bpm, 141);
console.log('ok - heart rate');
process.exit(0);
