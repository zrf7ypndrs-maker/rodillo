import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseIndoorBikeData, cmd, parseCyclingPower, CrankCadence } from '../js/ble/trainer.js';
import { decodeRideButtons } from '../js/ble/zwiftride.js';
import { parseHr } from '../js/ble/hr.js';
import { SimTrainer, SimHr } from '../js/ble/sim.js';
import { Session } from '../js/engine/session.js';
import { powerAt } from '../js/engine/physics.js';
import { parseZwo, flatten, totalDuration, estimateTSS } from '../js/engine/workout.js';
import { encodeActivity } from '../js/fit.js';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { Decoder, Stream } = require('@garmin/fitsdk');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const dv = (arr) => new DataView(new Uint8Array(arr).buffer);

test('FTMS indoor bike data', () => {
  // flags 0x0044: speed (bit0 clear), cadence, power
  const r = parseIndoorBikeData(dv([0x44, 0x00, 0xb8, 0x0b, 0xb4, 0x00, 0xfa, 0x00]));
  assert.equal(r.speedKmh, 30); assert.equal(r.cadence, 90); assert.equal(r.power, 250);
  // flags 0x0245 (more data set => no speed), cadence, power, hr
  const r2 = parseIndoorBikeData(dv([0x45, 0x02, 0xb4, 0x00, 0xfa, 0x00, 0x8c]));
  assert.equal(r2.speedKmh, undefined); assert.equal(r2.cadence, 90); assert.equal(r2.power, 250); assert.equal(r2.hr, 140);
});

test('FTMS commands', () => {
  assert.deepEqual([...cmd.setTargetPower(215)], [0x05, 0xd7, 0x00]);
  assert.deepEqual([...cmd.setSim(0.05)], [0x11, 0, 0, 0xf4, 0x01, 0, 0]);
  assert.deepEqual([...cmd.setSim(-0.031)], [0x11, 0, 0, 0xca, 0xfe, 0, 0]);
});

test('Cycling power + crank cadence', () => {
  const r = parseCyclingPower(dv([0x20, 0x00, 0xc8, 0x00, 0x0a, 0x00, 0x00, 0x04]));
  assert.equal(r.power, 200); assert.equal(r.crankRevs, 10); assert.equal(r.crankTime, 1024);
  const c = new CrankCadence(); c.update(10, 1024); assert.equal(Math.round(c.update(11, 1024 + 683)), 90);
});

test('HR parse', () => {
  assert.equal(parseHr(dv([0x00, 0x8f])), 143);
  assert.equal(parseHr(dv([0x01, 0x2c, 0x01])), 300);
});

test('Zwift Ride buttons', () => {
  const varint = (n) => { const o = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; };
  const released = new Uint8Array([0x08, 0xff, 0xff, 0xff, 0xff, 0x0f]);
  assert.equal(decodeRideButtons(released).size, 0);
  const shiftUpR = new Uint8Array([0x08, ...varint(0xffffffff - 0x1000)]);
  assert.deepEqual([...decodeRideButtons(shiftUpR)], ['shiftUpR']);
  const aAndDown = new Uint8Array([0x08, ...varint(0xffffffff - 0x10 - 0x08)]);
  assert.deepEqual([...decodeRideButtons(aAndDown)].sort(), ['a', 'down']);
  // analog right paddle at -60 (zigzag 119), location 1
  const paddle = new Uint8Array([0x08, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x1a, 0x04, 0x08, 0x01, 0x10, 119]);
  assert.deepEqual([...decodeRideButtons(paddle)], ['paddleR']);
});

function ride(session, trainer, hr, seconds, dt = 0.25) {
  for (let t = 0; t < seconds; t += dt) {
    trainer.step();
    hr.step(dt);
    session.tick(dt);
  }
}

test('Virtual gearbox: trainer power matches virtual bike physics', () => {
  // the "real" trainer differs from the app defaults; the app must learn it
  const trainer = new SimTrainer({ realDev: 5.4, trainerMass: 82 });
  const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { riderKg: 77, bikeKg: 9, drivetrain: 'zwift-24' } });
  s.gradeOffset = 0.06;
  s.start();
  trainer.riderPower = 220;
  ride(s, trainer, hr, 900);
  const v = s.bike.v, p = trainer.data.power;
  const expected = powerAt(v, s.grade, s.s);
  console.log(`   gear ${s.gb.label}, cadence ${trainer.data.cadence.toFixed(0)}, speed ${(v * 3.6).toFixed(1)} km/h, trainer ${p} W, physics ${expected.toFixed(0)} W, learned dev ${s.devEst.dev.toFixed(2)} model ${JSON.stringify(s.tm.toJSON())}`);
  assert.ok(Math.abs(s.devEst.dev - 5.4) < 0.1, 'learns real development');
  assert.ok(Math.abs(p - expected) / expected < 0.08, 'trainer power within 8% of physics');
  // shifting harder at the same power lowers cadence
  const cadBefore = trainer.data.cadence;
  for (let i = 0; i < 4; i++) s.shift(+1);
  ride(s, trainer, hr, 20);
  assert.ok(trainer.data.cadence < cadBefore * 0.9, `harder gear lowers cadence (${cadBefore.toFixed(0)} -> ${trainer.data.cadence.toFixed(0)})`);
  // speed at that power on 6% matches real-world physics (~13-14 km/h for 220 W, 86 kg)
  assert.ok(v * 3.6 > 11 && v * 3.6 < 16);
});

test('ERG workout, skip, lap, FIT export decodes', () => {
  const wo = JSON.parse(fs.readFileSync(new URL('../workouts/vo2-5x4.json', import.meta.url)));
  const segs = flatten(wo);
  assert.ok(segs.length > 5);
  const trainer = new SimTrainer();
  const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { ftp: 200 }, workout: wo });
  s.start();
  ride(s, trainer, hr, 120);
  assert.equal(trainer.mode, 'erg');
  assert.equal(trainer.erg, Math.round(200 * (segs[0].from + (segs[0].to - segs[0].from) * (120 / segs[0].dur))));
  s.lap();
  s.skip();
  ride(s, trainer, hr, 60);
  s.bump(+1);
  ride(s, trainer, hr, 30);
  s.finish();
  const bytes = encodeActivity(s.samples, s.laps, { tss: 50 });
  const dec = new Decoder(Stream.fromByteArray(bytes));
  assert.ok(dec.isFIT() && dec.checkIntegrity(), 'FIT integrity');
  const { messages, errors } = dec.read();
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(messages.recordMesgs.length, s.samples.length);
  assert.equal(messages.lapMesgs.length, 2);
  const ses = messages.sessionMesgs[0];
  assert.equal(ses.sport, 'cycling'); assert.equal(ses.subSport, 'virtualActivity');
  assert.ok(ses.avgPower > 100 && ses.avgHeartRate > 60);
  console.log(`   ${s.samples.length} records, avg ${ses.avgPower} W, NP ${ses.normalizedPower}, HR ${ses.avgHeartRate}, ${ses.totalDistance.toFixed(0)} m`);
});

test('All library workouts parse', () => {
  const idx = JSON.parse(fs.readFileSync(new URL('../workouts/index.json', import.meta.url)));
  for (const f of idx.workouts) {
    const w = JSON.parse(fs.readFileSync(new URL(`../workouts/${f}`, import.meta.url)));
    const segs = flatten(w);
    assert.ok(segs.every((x) => x.dur > 0 && (x.kind === 'sim' || (x.from > 0 && x.from < 2))), f);
    console.log(`   ${w.name}: ${(totalDuration(w) / 60).toFixed(0)} min, TSS ~${estimateTSS(w)}`);
  }
});

test('ZWO import', () => {
  const zwo = `<workout_file><name>Test ZWO</name><description>d</description><workout>
    <Warmup Duration="600" PowerLow="0.4" PowerHigh="0.75"/>
    <IntervalsT Repeat="3" OnDuration="60" OffDuration="60" OnPower="1.2" OffPower="0.5"><textevent timeoffset="0" message="Go!"/></IntervalsT>
    <SteadyState Duration="300" Power="0.7" Cadence="85"/>
    <FreeRide Duration="120"/>
    <Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4"/></workout></workout_file>`;
  const w = parseZwo(zwo);
  const segs = flatten(w);
  assert.equal(w.name, 'Test ZWO');
  assert.equal(segs.length, 1 + 6 + 1 + 1 + 1);
  assert.equal(segs[1].text, 'Go!');
  assert.equal(totalDuration(w), 600 + 360 + 300 + 120 + 300);
});


console.log(`\n${passed} tests passed`);

import { Gearbox, DRIVETRAINS } from '../js/engine/drivetrain.js';
{
  const g = new Gearbox('road-2x12-shimano-50-34');
  assert.equal(g.label, '50x19'); // start near 2.6 in the big ring
  g.shiftRear(+1); assert.equal(g.label, '50x17');
  g.toggleFront(); assert.equal(g.label, '34x17');
  for (let i = 0; i < 20; i++) g.shiftRear(-1);
  assert.equal(g.label, '34x34');
  assert.ok(!g.shiftRear(-1));
  const m = new Gearbox('mtb-1x12-sram-34');
  assert.ok(!m.isDouble && !m.toggleFront());
  assert.equal(m.wheel, 2.32);
  const z = new Gearbox('zwift-24');
  assert.equal(z.label, '12'); assert.equal(z.ratio, 2.4);
  for (const [k, d] of Object.entries(DRIVETRAINS)) if (!d.seq) assert.equal(d.cogs.length, 12, k);
  console.log('ok - drivetrains');
}
{
  // sim session on a real drivetrain: front shift to the small ring on a climb drops resistance
  const trainer = new SimTrainer();
  const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { drivetrain: 'road-2x12-shimano-50-34' } });
  s.gradeOffset = 0.08; s.start(); trainer.riderPower = 220;
  ride(s, trainer, hr, 120);
  const cadBig = trainer.data.cadence;
  s.toggleFront();
  ride(s, trainer, hr, 30);
  assert.ok(trainer.data.cadence > cadBig * 1.3, `small ring spins faster (${cadBig.toFixed(0)} -> ${trainer.data.cadence.toFixed(0)})`);
  console.log(`ok - front shift on a climb (${cadBig.toFixed(0)} -> ${trainer.data.cadence.toFixed(0)} rpm)`);
  // coasting sends minimum resistance
  trainer.riderPower = 0;
  ride(s, trainer, hr, 10);
  assert.equal(trainer.grade, -0.15);
  console.log('ok - freewheel drops trainer to minimum resistance');
}

{
  // The reported bug: lightest gear on the flat must be light, not ~220 W at 90 rpm.
  const trainer = new SimTrainer({ realDev: 5.1, trainerMass: 75, c1: 2.9, c3: 0.51 });
  const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { drivetrain: 'road-2x12-shimano-50-34' } });
  s.start();
  s.toggleFront(); for (let i = 0; i < 12; i++) s.shift(-1); // 34x34
  trainer.riderPower = 60;
  ride(s, trainer, hr, 300);
  console.log(`   34x34 on 0%: ${trainer.data.cadence.toFixed(0)} rpm at ${trainer.data.power} W (sent grade ${(trainer.grade * 100).toFixed(1)}%)`);
  assert.ok(trainer.data.cadence > 100, 'lightest gear spins easily on the flat');
  // and a normal gear at a normal power gives realistic speed
  s.toggleFront(); for (let i = 0; i < 6; i++) s.shift(+1);
  trainer.riderPower = 200;
  ride(s, trainer, hr, 300);
  const v = s.bike.v * 3.6, expected = powerAt(s.bike.v, 0, s.s);
  console.log(`   ${s.gb.label} at 200 W: ${v.toFixed(1)} km/h, ${trainer.data.cadence.toFixed(0)} rpm, physics says ${expected.toFixed(0)} W, model ${JSON.stringify(s.tm.toJSON())}`);
  assert.ok(Math.abs(trainer.data.power - expected) / expected < 0.1, 'trainer power matches road physics on the flat');
  assert.ok(v > 30 && v < 37, `flat speed at 200 W ${v}`);
  console.log('ok - light gears are light (trainer drag compensated)');
}
