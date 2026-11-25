// Exercise the Web Bluetooth device classes against a fake GATT server.
import assert from 'node:assert/strict';
import { Trainer } from '../js/ble/trainer.js';
import { ZwiftRide } from '../js/ble/zwiftride.js';
import { ZWIFT_INIT } from '../js/ble/zwifthub.js';
import { HeartRate } from '../js/ble/hr.js';
import { uuid16, RETRY_MS, log } from '../js/ble/base.js';
import { HR_STALE_MS } from '../js/ble/hr.js';

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
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** Bytes laid out little-endian: [[value, byteCount], ...] (negatives come out as two's complement). */
function le(fields) {
  const out = [];
  for (const [v, n] of fields) for (let i = 0; i < n; i++) out.push((v >> (8 * i)) & 0xff);
  return out;
}
/**
 * A KICKR on a fake GATT server that can drop and come back: Indoor Bike Data, a control point that answers every
 * command (`answer(op)` picks the result code, 0x01 = success), and optional Cycling Power / FTMS status.
 * `drop()` fires the disconnect the way Chrome does; `failConnects` makes the next reconnect tries fail.
 */
async function fakeKickr({ cps = false, status = false, answer = () => 0x01 } = {}) {
  const ibd = new FakeChar(uuid16(0x2ad2));
  const cp = new FakeChar(uuid16(0x2ad9));
  cp.onWrite = (d) => setTimeout(() => cp.fire([0x80, d[0], answer(d[0])]), 1);
  const cpm = new FakeChar(uuid16(0x2a63));
  const st = new FakeChar(uuid16(0x2ada));
  const ftmsChars = status ? [ibd, cp, st] : [ibd, cp];
  const services = [new FakeService(uuid16(0x1826), ftmsChars)];
  if (cps) services.push(new FakeService(uuid16(0x1818), [cpm]));
  const dev = fakeDevice('KICKR CORE T', services);
  const k = { ibd, cp, cpm, st, dev, failConnects: 0, disc: null, trainer: new Trainer() };
  dev.addEventListener = (ev, f) => { if (ev === 'gattserverdisconnected') k.disc = f; };
  const connect = dev.gatt.connect;
  dev.gatt.connect = async () => {
    if (k.failConnects > 0) { k.failConnects--; throw new Error('out of range'); }
    dev.gatt.connected = true;
    return connect();
  };
  dev.gatt.disconnect = () => { dev.gatt.connected = false; };
  k.drop = () => { dev.gatt.connected = false; return k.disc(); };
  await k.trainer.attach(dev);
  return k;
}
/** Log lines from the trainer while `fn` runs. */
async function trainerLog(fn) {
  const lines = [];
  const off = log.on('log', (e) => { if (e.src === 'trainer') lines.push(e.msg); });
  try { await fn(); } finally { off(); }
  return lines;
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

// ---- trainer with the Zwift protocol (shifting in the trainer)
{
  const zAsync = new FakeChar('00000002-19ca-4651-86e5-fa29dcdd09d1');
  const zRx = new FakeChar('00000003-19ca-4651-86e5-fa29dcdd09d1');
  const zTx = new FakeChar('00000004-19ca-4651-86e5-fa29dcdd09d1');
  zRx.properties = { write: true, writeWithoutResponse: true };
  const origW = zRx.writeValueWithoutResponse.bind(zRx);
  zRx.writeValueWithoutResponse = async (d) => { await origW(d); if (d[0] === 0x52) setTimeout(() => zTx.fire([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x00]), 2); };
  const cp2 = new FakeChar(uuid16(0x2ad9));
  cp2.onWrite = (d) => setTimeout(() => cp2.fire([0x80, d[0], 0x01]), 1);
  const zt = new Trainer();
  await zt.attach(fakeDevice('KICKR CORE 1234', [
    new FakeService(uuid16(0x1826), [new FakeChar(uuid16(0x2ad2)), cp2]),
    new FakeService(uuid16(0xfc82), [zAsync, zRx, zTx]),
  ]));
  assert.equal(zt.zwiftShifting, true);
  assert.deepEqual(zRx.writes[0], [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);
  // then Zwift's own start-up sequence, byte for byte as qdomyos-zwift sends it
  const n0 = 1 + ZWIFT_INIT.length;
  assert.equal(zRx.writes.length, n0);
  assert.deepEqual(zRx.writes[1], [0x41, 0x08, 0x05]);
  assert.deepEqual(zRx.writes[n0 - 1], [0x04, 0x22, 0x02, 0x10, 0x00]);
  zt.setZwiftSim({ grade: 0.2, gearRatio: 32 / 52, riderKg: 77, bikeKg: 12.5 });
  zt.setZwiftSim({ grade: 0.2, gearRatio: 32 / 52, riderKg: 77, bikeKg: 12.5 }); // same: not sent again
  await new Promise((r) => setTimeout(r, 5));
  // entering slope mode sends the start-up sequence again (it also follows every ERG stretch)
  assert.deepEqual(zRx.writes.slice(1, n0), zRx.writes.slice(n0, 2 * n0 - 1));
  zRx.writes.splice(n0, ZWIFT_INIT.length);
  assert.equal(zRx.writes.length, n0 + 3); // gear, gear-ratio request, then the grade as its own message (last word)
  assert.deepEqual([zRx.writes[n0][0], zRx.writes[n0][1]], [0x04, 0x2a]); // Physical
  assert.deepEqual(zRx.writes[n0 + 1], [0x00, 0x08, 0x88, 0x04]);
  assert.deepEqual(zRx.writes[n0 + 2], [0x04, 0x22, 0x03, 0x10, 0xa0, 0x1f]); // Simulation { incline 2000 }
  zt.setZwiftSim({ grade: 0.2, gearRatio: 32 / 50, riderKg: 77, bikeKg: 12.5 }); // shift inside 250 ms: sent a moment later
  assert.equal(zRx.writes.length, n0 + 3);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(zRx.writes.length, n0 + 5); // only the gear changed: gear + request, no grade message
  assert.equal(zRx.writes[n0 + 3][1], 0x2a);
  zAsync.fire([0x03, 0x08, 0xbe, 0x01, 0x10, 0x50]);
  assert.equal(zt.zwift.data.power, 190);
  // switching to ERG goes back to FTMS
  zt.setErg(200);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(cp2.writes.at(-1), [0x05, 200, 0]);
  console.log('ok - trainer Zwift protocol handshake, sim commands, ERG still FTMS');

  // silent trainer (has the service, never answers): shifting stays in Rodillo
  const st = new Trainer();
  const cp3 = new FakeChar(uuid16(0x2ad9));
  cp3.onWrite = (d) => setTimeout(() => cp3.fire([0x80, d[0], 0x01]), 1);
  const t0 = Date.now();
  st.zwiftTimeoutMs = 50;
  await st.attach(fakeDevice('KICKR CORE 9', [
    new FakeService(uuid16(0x1826), [new FakeChar(uuid16(0x2ad2)), cp3]),
    new FakeService(uuid16(0xfc82), [new FakeChar('00000002-19ca-4651-86e5-fa29dcdd09d1'), new FakeChar('00000003-19ca-4651-86e5-fa29dcdd09d1'), new FakeChar('00000004-19ca-4651-86e5-fa29dcdd09d1')]),
  ]));
  assert.equal(st.zwiftShifting, false);
  assert.ok(Date.now() - t0 < 1000);
  // turned off in settings: no handshake at all
  const off = new Trainer(); off.useZwift = false;
  const offRx = new FakeChar('00000003-19ca-4651-86e5-fa29dcdd09d1');
  const cp4 = new FakeChar(uuid16(0x2ad9)); cp4.onWrite = (d) => setTimeout(() => cp4.fire([0x80, d[0], 0x01]), 1);
  await off.attach(fakeDevice('KICKR CORE 8', [new FakeService(uuid16(0x1826), [new FakeChar(uuid16(0x2ad2)), cp4]), new FakeService(uuid16(0xfc82), [offRx])]));
  assert.equal(offRx.writes.length, 0); assert.equal(off.zwiftShifting, false);
  console.log('ok - silent trainer or setting off: shifting stays in Rodillo');
}

// ---- trainer: a drop mid-ride. Targets set while it's gone aren't lost: the trainer gets them when it's back.
{
  const saved = [...RETRY_MS];
  RETRY_MS.splice(0, RETRY_MS.length, 1);
  const k = await fakeKickr();
  const t = k.trainer;
  t.setErg(150);
  await tick();
  assert.deepEqual(k.cp.writes.at(-1), [0x05, 150, 0]);
  k.failConnects = Infinity; // out of range until we say so
  const back = k.drop();
  assert.equal(t.state, 'disconnected');
  const before = k.cp.writes.length;
  t.setErg(180); // next interval starts while the trainer is gone
  await tick();
  assert.equal(k.cp.writes.length, before, 'nothing written to a dropped trainer');
  assert.equal(t.state, 'disconnected');
  k.failConnects = 0; // back in range
  await back;
  assert.equal(t.state, 'connected');
  assert.deepEqual(k.cp.writes.slice(before), [[0x00], [0x07], [0x05, 180, 0]], JSON.stringify(k.cp.writes.slice(before)));
  // same for a grade: the hill the rider was on is restored after the drop
  t.setGrade(0.04);
  await tick();
  await k.drop();
  assert.deepEqual(k.cp.writes.slice(-3), [[0x00], [0x07], [0x11, 0, 0, 0x90, 0x01, 0, 0]]);
  // a target set before the trainer was ever connected waits for the first connect
  const fresh = new Trainer();
  fresh.setErg(120);
  assert.equal(fresh.state, 'disconnected');
  RETRY_MS.splice(0, RETRY_MS.length, ...saved);
  console.log('ok - trainer drop: no writes while gone, latest ERG target or grade restored on reconnect');
}

// ---- trainer: what goes over the control point, tick after tick
{
  const k = await fakeKickr();
  const t = k.trainer;
  const sent = () => k.cp.writes.slice(2); // after request control + start
  for (let i = 0; i < 8; i++) t.setErg(200); // the engine calls this every tick (4 Hz)
  await tick();
  assert.deepEqual(sent(), [[0x05, 200, 0]], 'same ERG target each tick: sent once');
  t.setErg(2600); await tick();
  t.setErg(-20); await tick();
  assert.deepEqual(sent().slice(1), [[0x05, 0xd0, 0x07], [0x05, 0, 0]], 'ERG target kept within 0..2000 W');
  k.cp.writes.length = 2;
  for (let i = 0; i < 8; i++) t.setGrade(0.031); // same grade every tick
  await tick();
  t.setGrade(0.03104); // below the trainer's 0.01 % resolution: no new command
  await tick();
  assert.deepEqual(sent(), [[0x11, 0, 0, 0x36, 0x01, 0, 0]], 'same grade each tick: sent once');
  t.setGrade(0.05); await tick();
  t.setErg(0); await tick();
  t.setGrade(0.05); await tick(); // back to the same grade after an ERG stretch: sent again
  assert.deepEqual(sent().slice(1), [[0x11, 0, 0, 0xf4, 0x01, 0, 0], [0x05, 0, 0], [0x11, 0, 0, 0xf4, 0x01, 0, 0]]);
  console.log('ok - trainer commands: one write per change, ERG clamped, grade back after ERG resent');
}

// ---- trainer: the control point says no
{
  let res = 0x01;
  const k = await fakeKickr({ answer: (op) => (op === 0x00 ? 0x01 : res) });
  const t = k.trainer;
  // control taken away (another app, or the trainer reset itself): Rodillo asks for control again
  res = 0x05;
  const lines = await trainerLog(async () => { t.setErg(220); await tick(20); });
  res = 0x01;
  assert.deepEqual(k.cp.writes.slice(2, 4), [[0x05, 220, 0], [0x00]], JSON.stringify(k.cp.writes));
  assert.ok(lines.some((l) => /op 0x5 result 5/.test(l)), lines.join('\n'));
  // any other refusal shows in the log, and nothing else is written
  res = 0x03; // invalid parameter
  const n = k.cp.writes.length;
  const lines2 = await trainerLog(async () => { t.setGrade(0.02); await tick(20); });
  res = 0x01;
  assert.equal(k.cp.writes.length, n + 1);
  assert.ok(lines2.some((l) => /op 0x11 result 3/.test(l)), lines2.join('\n'));
  // indications that aren't control point responses are ignored
  const n2 = k.cp.writes.length;
  const lines3 = await trainerLog(async () => { k.cp.fire([0x81, 0x05, 0x05]); await tick(); });
  assert.equal(k.cp.writes.length, n2);
  assert.deepEqual(lines3, []);
  console.log('ok - trainer control point: re-requests control when refused, other refusals logged');
}

// ---- trainer: riding data from every Indoor Bike Data field, and cadence from Cycling Power when FTMS has none
{
  const k = await fakeKickr({ cps: true, status: true });
  const t = k.trainer;
  let seen = 0;
  t.on('data', () => seen++);
  // every optional field present: speed, avg speed, cadence, avg cadence, distance, resistance, power, avg power,
  // energy (5 bytes), HR. Values read must not shift into the wrong field.
  k.ibd.fire(le([[0x03fe, 2], [3150, 2], [3000, 2], [182, 2], [170, 2], [70000, 3], [-12, 2], [264, 2], [250, 2], [400, 2], [900, 2], [15, 1], [143, 1]]));
  assert.deepEqual([t.data.speedKmh, t.data.cadence, t.data.distance, t.data.resistance, t.data.power, t.data.hr], [31.5, 91, 70000, -12, 264, 143]);
  assert.equal(seen, 1);

  // a trainer whose FTMS data has no cadence: cadence comes from the crank revolutions in Cycling Power
  const c = await fakeKickr({ cps: true });
  const ct = c.trainer;
  c.ibd.fire(le([[0x0040, 2], [2800, 2], [230, 2]])); // speed + power, no cadence
  assert.equal(ct.data.power, 230);
  // flags: pedal balance, accumulated torque, wheel revs, crank revs
  const cpm = (crank, time) => c.cpm.fire(le([[0x0035, 2], [230, 2], [50, 1], [1000, 2], [5000, 4], [2048, 2], [crank, 2], [time, 2]]));
  cpm(10, 1024);
  cpm(11, 1024 + 683);
  assert.equal(Math.round(ct.data.cadence), 90);
  for (let i = 0; i < 4; i++) cpm(11, 1024 + 683); // the rider stops pedalling: no new crank events
  assert.equal(ct.data.cadence, 0, 'cadence drops to 0, never frozen');
  cpm(12, 1024 + 683 + 700);
  assert.ok(ct.data.cadence > 0);
  // once FTMS reports cadence it wins; Cycling Power cadence is ignored
  c.ibd.fire(le([[0x0044, 2], [2800, 2], [170, 2], [230, 2]]));
  cpm(14, 1024 + 683 + 1000);
  assert.equal(ct.data.cadence, 85);

  // FTMS status notifications go to the log (what shows in the Connections log when the trainer resets)
  const lines = await trainerLog(async () => k.st.fire([0x08, 0x00]));
  assert.ok(lines.includes('status 08 00'), lines.join('\n'));
  console.log('ok - trainer data: all FTMS fields, crank cadence fallback and stop, status logged');
}

// ---- trainer: Zwift protocol hand-off when the trainer has none
{
  const k = await fakeKickr();
  const t = k.trainer;
  t.setErg(180); await tick();
  const n = k.cp.writes.length;
  assert.equal(t.zwiftShifting, false);
  t.setZwiftSim({ grade: 0.05, gearRatio: 34 / 17, riderKg: 77, bikeKg: 12.5 }); // a stale call from the engine
  await tick();
  assert.equal(k.cp.writes.length, n, 'no Zwift link: nothing sent, ERG target unchanged');
  assert.equal(t.mode, 'erg');
  // the picker offers KICKRs and FTMS trainers, and asks for the services the app needs
  const o = Trainer.requestOptions();
  assert.ok(o.filters.some((f) => f.namePrefix === 'KICKR') && o.filters.some((f) => f.services?.includes(uuid16(0x1826))));
  assert.ok(o.optionalServices.includes(uuid16(0x1818)) && o.optionalServices.includes(uuid16(0xfc82)));
  console.log('ok - trainer without Zwift protocol ignores Zwift sim; picker options');
}

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

// a strap that goes silent (lost skin contact, link still up) reads 0, never a frozen number
{
  const real = performance.now;
  const t0 = real.call(performance);
  performance.now = () => t0 + HR_STALE_MS + 1;
  assert.equal(hr.bpm, 0);
  performance.now = real;
  hrm.fire([0x00, 150]);
  assert.equal(hr.bpm, 150);
  console.log('ok - silent strap reads 0');
}

// a drop: bpm clears at once, and reconnect keeps trying past the old 8-try limit until the strap is back
{
  RETRY_MS.splice(0, RETRY_MS.length, 1);
  const c = new FakeChar(uuid16(0x2a37));
  let fail = 12, disc = null, tries = 0;
  const svc = new FakeService(uuid16(0x180d), [c]);
  const dev = {
    name: 'HRM-Pro', id: 'hrm2', addEventListener(ev, f) { if (ev === 'gattserverdisconnected') { assert.equal(disc, null, 'one drop listener per device'); disc = f; } },
    gatt: {
      connected: true,
      disconnect() {},
      async connect() { tries++; if (fail-- > 0) throw new Error('out of range'); return { async getPrimaryService(u) { if (u !== svc.uuid) throw new Error('no svc'); return svc; } }; },
    },
  };
  const h = new HeartRate();
  fail = 0;
  await h.attach(dev);
  await h.attach(dev); // re-picked the same strap: still one listener
  c.fire([0x00, 160]);
  assert.equal(h.bpm, 160);
  fail = 12; tries = 0;
  const p1 = disc(); disc(); // two events, one loop
  assert.equal(h.bpm, 0);
  assert.equal(h.state, 'disconnected');
  await p1;
  for (let i = 0; i < 100 && h.state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.state, 'connected');
  assert.equal(tries, 13, `tries ${tries}`);
  // rider disconnects on purpose: no retry loop
  await h.disconnect(); tries = 0;
  await disc();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tries, 0);
  console.log('ok - drop clears HR, reconnect never gives up, one loop');
}
process.exit(0);
