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
import { buildRide } from '../js/stats.js';
import { cleanWorkout } from '../js/mine.js';

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
  console.log(`   gear ${s.gb.label}, cadence ${trainer.data.cadence.toFixed(0)}, speed ${(v * 3.6).toFixed(1)} km/h, trainer ${p} W, physics ${expected.toFixed(0)} W, learned dev ${s.devEst.dev.toFixed(2)} trim ${(s.gOff*100).toFixed(1)}%`);
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
  // trainer speed in ERG: speed and distance come from the trainer, not road physics
  assert.ok(Math.abs(s.bike.v - trainer.data.speedKmh / 3.6) < 0.01, 'ERG speed = trainer speed');
  s.toggleErg();
  assert.equal(s.ergOff, true);
  s.skip();
  assert.equal(s.ergOff, true, 'ERG off stays off across intervals until the rider turns it on');
  s.toggleErg();
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
  // one lap per interval ridden (skips included), nothing extra
  const intervals = new Set(s.samples.map((x) => x.si)).size;
  assert.ok(intervals >= 2);
  assert.equal(messages.lapMesgs.length, intervals);
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
    <IntervalsT Repeat="3" OnDuration="60" OffDuration="60" OnPower="1.2" OffPower="0.5"><textevent timeoffset="0" message="Go!"/><textevent timeoffset="130" message="Rep 2 halfway"/><textevent timeoffset="70" message="Rest"/></IntervalsT>
    <SteadyState Duration="300" Power="0.7" Cadence="85"/>
    <FreeRide Duration="120"/>
    <Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4"/></workout></workout_file>`;
  const w = parseZwo(zwo);
  const segs = flatten(w);
  assert.equal(w.name, 'Test ZWO');
  assert.equal(segs.length, 1 + 6 + 1 + 1 + 1);
  assert.deepEqual(segs[1].msgs, [{ t: 0, text: 'Go!' }]);
  assert.deepEqual(segs[2].msgs, [{ t: 10, text: 'Rest' }]);
  assert.deepEqual(segs[3].msgs, [{ t: 10, text: 'Rep 2 halfway' }]);
  assert.equal(segs[5].msgs.length, 0);
  assert.equal(totalDuration(w), 600 + 360 + 300 + 120 + 300);
});

{
  const { msgTime, parseMessageLines, formatMessageLines, fillMessage } = await import('../js/engine/workout.js');
  assert.equal(msgTime(0, 240), 0); assert.equal(msgTime(-30, 240), 210); assert.equal(msgTime('50%', 240), 120);
  assert.equal(msgTime(999, 240), 239); assert.equal(msgTime(-999, 240), 0);
  const w = { steps: [{ dur: 60, power: 0.5, messages: [{ at: -10, text: 'b' }, { text: 'a' }] },
    { repeat: 3, steps: [{ dur: 30, power: 1.1, messages: [{ at: '50%', text: 'Rep {rep} of {of}, {left} left, hold {watts}' }, { at: -5, rep: 'last', text: 'Last one' }, { rep: [1, 2], text: 'early' }] }, { dur: 20, power: 0.5 }] }] };
  const segs = flatten(w, 200);
  assert.deepEqual(segs[0].msgs.map((m) => m.text), ['a', 'b'], 'sorted by time');
  assert.equal(segs[1].msgs.length, 2); assert.equal(segs[5].msgs.length, 2);
  assert.deepEqual(segs[5].msgs.map((m) => m.text), ['Rep {rep} of {of}, {left} left, hold {watts}', 'Last one']);
  assert.equal(fillMessage(segs[5].msgs[0].text, { seg: segs[5], watts: 219.6, ftp: 200 }), 'Rep 3 of 3, 0 left, hold 220');
  // a ride fires each once, in order, with the live target
  const trainer = new SimTrainer(); const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { ftp: 200 }, workout: w });
  const got = []; s.on('message', (t) => got.push([Math.round(s.elapsed), t]));
  s.start(); trainer.ergCadence = 90; ride(s, trainer, hr, 60 + 3 * 50 + 2);
  assert.deepEqual(got.map((g) => g[1]), ['a', 'b', 'early', 'Rep 1 of 3, 2 left, hold 220', 'early', 'Rep 2 of 3, 1 left, hold 220', 'Rep 3 of 3, 0 left, hold 220', 'Last one']);
  assert.ok(Math.abs(got[1][0] - 50) <= 1 && Math.abs(got.at(-1)[0] - (60 + 100 + 25)) <= 1, JSON.stringify(got));
  // skipping a step drops its messages
  const s2 = new Session({ trainer: new SimTrainer(), hr: null, settings: {}, workout: w });
  const got2 = []; s2.on('message', (t) => got2.push(t));
  s2.start(); s2.tick(0.25); s2.skip(); s2.skip(); s2.tick(0.25);
  assert.deepEqual(got2, ['a']);
  // builder text form round-trips
  const { messages, bad } = parseMessageLines('Welcome\n-0:30 Thirty seconds\nlast -10s Empty the tank\nrep 2: 50% Halfway\n1:15: colon ok\n\n-0:20');
  assert.deepEqual(messages, [{ text: 'Welcome' }, { at: -30, text: 'Thirty seconds' }, { at: -10, rep: 'last', text: 'Empty the tank' }, { at: '50%', rep: 2, text: 'Halfway' }, { at: 75, text: 'colon ok' }]);
  assert.deepEqual(bad, [7]);
  assert.equal(formatMessageLines(messages), 'Welcome\n-0:30 Thirty seconds\nlast -0:10 Empty the tank\nrep 2 50% Halfway\n1:15 colon ok');
  assert.deepEqual(parseMessageLines(formatMessageLines(messages)).messages, messages);
  const lists = [{ rep: [2, 3, 4], text: 'Rep {rep}' }, { at: -60, rep: 'first', text: 'x' }];
  assert.equal(formatMessageLines(lists), 'rep 2,3,4: Rep {rep}\nfirst -1:00 x');
  assert.deepEqual(parseMessageLines('Last step. Go\nRep 1. Settle\n0:00 last: plain\n30s Last 15 seconds').messages, [{ text: 'Last step. Go' }, { text: 'Rep 1. Settle' }, { text: 'last: plain' }, { at: 30, text: 'Last 15 seconds' }]);
  assert.deepEqual(parseMessageLines(formatMessageLines(lists)).messages, lists);
  // every library workout's messages survive the builder's text form
  for (const f of fs.readdirSync(new URL('../workouts/', import.meta.url)).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
    const walk = (steps) => steps.forEach((st) => st.steps ? walk(st.steps) : st.messages && assert.deepEqual(parseMessageLines(formatMessageLines(st.messages)).messages, st.messages, f));
    walk(JSON.parse(fs.readFileSync(new URL(`../workouts/${f}`, import.meta.url))).steps);
  }
  console.log('ok - timed messages (times, reps, placeholders, skip, builder lines)');
}

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
  console.log(`   ${s.gb.label} at 200 W: ${v.toFixed(1)} km/h, ${trainer.data.cadence.toFixed(0)} rpm, physics says ${expected.toFixed(0)} W, trim ${(s.gOff*100).toFixed(1)}%`);
  assert.ok(Math.abs(trainer.data.power - expected) / expected < 0.1, 'trainer power matches road physics on the flat');
  assert.ok(v > 30 && v < 37, `flat speed at 200 W ${v}`);
  console.log('ok - light gears are light (trainer drag compensated)');
}
{
  // distance-based slope steps advance by distance; per-segment stats accumulate
  const w = JSON.parse(fs.readFileSync(new URL('../workouts/sim-hill-repeats-1500.json', import.meta.url)));
  const trainer = new SimTrainer();
  const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { drivetrain: 'road-2x12-shimano-50-34' }, workout: w });
  s.start(); trainer.riderPower = 230;
  ride(s, trainer, hr, 610);
  assert.equal(s.segIndex, 1); assert.equal(s.seg.dist, 1500);
  const d0 = s.segD0;
  while (s.segIndex === 1) ride(s, trainer, hr, 1);
  assert.ok(Math.abs(s.bike.dist - d0 - 1500) < 15, `climb ended after ${(s.bike.dist - d0).toFixed(0)} m`);
  const a = s.segAgg[1];
  assert.ok(a.n > 100 && Math.abs(a.p / a.n - 230) < 25, `avg power on climb ${a.p / a.n}`);
  s.skip(); assert.equal(s.segIndex, 3);
  ride(s, trainer, hr, 20);
  s.finish();
  const ints = buildRide(s.samples, { name: w.name, ftp: 200, startMs: Date.now(), segs: s.segs }).intervals;
  assert.ok(ints.find((x) => x.i === 1 && x.dist === 1500 && x.avgP > 200));
  console.log(`ok - distance segments (climb 1 took ${a.n}s at ${Math.round(a.p / a.n)} W)`);
}
{
  // auto start on pedalling, auto pause in ERG with no watts, resume on pedalling
  const wo = JSON.parse(fs.readFileSync(new URL('../workouts/z2-60.json', import.meta.url)));
  const trainer = new SimTrainer(); const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: {}, workout: wo });
  trainer.riderPower = 0; ride(s, trainer, hr, 5);
  assert.ok(!s.started, 'waits for pedalling');
  trainer.riderPower = 150; ride(s, trainer, hr, 3);
  assert.ok(s.started && !s.paused, 'started by pedalling');
  ride(s, trainer, hr, 30);
  trainer.riderPower = 0; ride(s, trainer, hr, 4);
  assert.ok(!s.paused); ride(s, trainer, hr, 2);
  assert.ok(s.paused && s.autoPaused, 'auto-paused after 5 s without watts');
  const t = s.elapsed; ride(s, trainer, hr, 20); assert.equal(s.elapsed, t, 'clock stops while paused');
  trainer.riderPower = 150; ride(s, trainer, hr, 2);
  assert.ok(!s.paused, 'resumes when pedalling');
  // manual pause is not auto-resumed
  s.togglePause(); ride(s, trainer, hr, 5); assert.ok(s.paused, 'manual pause holds');
  // slope: coasting downhill doesn't pause, stopping does
  const t2 = new SimTrainer(); const h2 = new SimHr(t2);
  const f = new Session({ trainer: t2, hr: h2, settings: {} });
  t2.riderPower = 200; ride(f, t2, h2, 60);
  f.gradeOffset = -0.06; t2.riderPower = 0; ride(f, t2, h2, 15);
  assert.ok(!f.paused && f.bike.v > 5, 'coasting downhill keeps riding');
  f.gradeOffset = 0.05; ride(f, t2, h2, 40);
  assert.ok(f.paused, 'stopped on a climb -> auto-paused');
  console.log('ok - auto start / pause / resume');
}
{
  const { parseCadence } = await import('../js/engine/workout.js');
  assert.deepEqual(parseCadence(90), { lo: 85, hi: 95, label: '90 rpm' });
  assert.deepEqual(parseCadence('80-90'), { lo: 80, hi: 90, label: '80-90 rpm' });
  assert.equal(parseCadence('100+').hi, Infinity);
  assert.equal(parseCadence(''), null);
  const wo = { steps: [{ dur: 120, power: 1.1, cadence: 100 }, { dur: 60, power: 0.5 }] };
  const trainer = new SimTrainer(); const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: {}, workout: wo });
  s.start(); trainer.ergCadence = 90; ride(s, trainer, hr, 5);
  assert.equal(s.cadStatus, null, 'settling period');
  ride(s, trainer, hr, 10); assert.equal(s.cadStatus, 'low');
  trainer.ergCadence = 99; ride(s, trainer, hr, 4); assert.equal(s.cadStatus, 'ok');
  trainer.ergCadence = 108; ride(s, trainer, hr, 4); assert.equal(s.cadStatus, 'high');
  ride(s, trainer, hr, 110); assert.equal(s.cadStatus, null, 'no target on recovery');
  s.finish();
  const ints = buildRide(s.samples, { name: 'x', ftp: 200, startMs: Date.now(), segs: s.segs }).intervals;
  assert.ok(ints[0].cadTarget === '100 rpm' && ints[0].cadInRange > 0 && ints[0].cadInRange < 60, JSON.stringify(ints[0]));
  console.log(`ok - cadence targets (${ints[0].cadInRange}% in range)`);
}
{
  const w = JSON.parse(fs.readFileSync(new URL('../workouts/test-100w-85rpm.json', import.meta.url)));
  const trainer = new SimTrainer(); const hr = new SimHr(trainer);
  const s = new Session({ trainer, hr, settings: { ftp: 263 }, workout: w });
  s.start(); trainer.ergCadence = 85; ride(s, trainer, hr, 20);
  assert.equal(trainer.erg, 100, 'absolute watts ignore FTP');
  assert.equal(s.cadStatus, 'ok');
  console.log('ok - absolute-watts test session (100 W @ 85 rpm)');
}
{
  const erg = new Session({ trainer: new SimTrainer(), hr: null, settings: {}, workout: { steps: [{ dur: 60, power: 0.5 }] } });
  assert.equal(erg.mode, 'erg', 'ERG layout before the ride starts');
  const slope = new Session({ trainer: new SimTrainer(), hr: null, settings: {}, workout: { steps: [{ dur: 60, grade: 3 }] } });
  assert.equal(slope.mode, 'sim');
  console.log('ok - mode known before start');
}

test('Ramp test is open-ended and ends when the rider fails', () => {
  const wo = JSON.parse(fs.readFileSync(new URL('../workouts/ramp-test.json', import.meta.url)));
  const steps = (s) => s.segs.filter((g) => g.untilFail);
  // strong rider: holds 330 W at FTP 200 = 165%, past the 16 planned steps (140%)
  const tr = new SimTrainer(), hr = new SimHr(tr);
  tr.ergMax = 330;
  const s = new Session({ trainer: tr, hr, settings: { ftp: 200 }, workout: wo });
  const ends = []; s.on('testEnd', (e) => ends.push(e));
  s.start();
  ride(s, tr, hr, 7 * 60 + 25 * 60);
  assert.equal(ends.length, 1, 'test ended once');
  assert.equal(ends[0].reason, 'fail');
  assert.equal(ends[0].label, 'Step 21', JSON.stringify(ends[0])); // 50% + 20 x 6% = 170% = 340 W > 330 W
  assert.equal(steps(s).length, 21, 'steps not ridden are gone');
  assert.equal(s.seg.label, 'Cool-down', 'cool-down follows the failed step');
  const cut = steps(s).at(-1);
  assert.ok(cut.dur >= 8 && cut.dur <= 12, `failed step cut where it failed (${cut.dur} s)`);
  assert.equal(steps(s)[20].from, 1.7);
  assert.equal(steps(s)[16].label, 'Step 17');
  for (let i = 1; i < s.segs.length; i++) assert.equal(s.segs[i].start, s.segs[i - 1].end, 'chart times stay continuous');
  ride(s, tr, hr, 300);
  const doc = buildRide(s.samples, { ftp: 200, startMs: Date.now(), segs: s.segs, segsChanged: s.segsChanged, tags: ['test'] });
  assert.equal(doc.segs.length, s.segs.length, 'ride doc carries the steps as ridden');
  assert.ok(doc.summary.bests[60] >= 320, `best minute ${doc.summary.bests[60]} W`);
  assert.ok(Math.abs(doc.intervals.find((x) => x.label === 'Step 20')?.avgP - 328) <= 3, 'step 20 held at 328 W');

  // weaker rider fails inside the plan; holding B in the test ends the test, not the ride
  const tr2 = new SimTrainer(), hr2 = new SimHr(tr2);
  const s2 = new Session({ trainer: tr2, hr: hr2, settings: { ftp: 200 }, workout: wo });
  s2.start();
  ride(s2, tr2, hr2, 7 * 60 + 10 * 60 + 30);
  assert.equal(s2.seg.label, 'Step 11');
  assert.equal(s2.endTest('manual'), true);
  assert.equal(s2.seg.label, 'Cool-down');
  assert.equal(steps(s2).length, 11);
  assert.equal(s2.endTest('manual'), false, 'outside the test there is nothing to end');
  assert.equal(s2.finished, false);

  // stopping mid-test (auto-pause) ends it too; the cool-down waits for the restart
  const tr3 = new SimTrainer(), hr3 = new SimHr(tr3);
  const s3 = new Session({ trainer: tr3, hr: hr3, settings: { ftp: 200 }, workout: wo });
  s3.start(); ride(s3, tr3, hr3, 7 * 60 + 90);
  tr3.riderPower = 0; ride(s3, tr3, hr3, 10);
  assert.equal(s3.paused, true);
  assert.equal(s3.seg.label, 'Cool-down');

  // the builder keeps the flag
  assert.ok(cleanWorkout(wo).steps.filter((x) => x.untilFail).length === 16);
});
