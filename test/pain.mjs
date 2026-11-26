// Pain vision (js/pain.js): the strain model and what paintPain() sets on #ride. The drawing itself is CSS.
// Expectations are written out by hand, not computed with the module's own formulas.
import assert from 'node:assert/strict';
import { painChoice, painLevel, intervalStrain, wprimeStrain, wbalStep, paintPain, W_PRIME } from '../js/pain.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const near = (a, b, tol = 0.001) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ---- setting
assert.equal(painChoice(undefined), 'full');
assert.equal(painChoice('subtle'), 'subtle');
assert.equal(painChoice('off'), 'off');
assert.equal(painChoice('loud'), 'full');
assert.equal(painLevel('off'), 0);
assert.equal(painLevel('subtle'), 0.55);
assert.equal(painLevel(undefined), 1);
ok('setting: off / subtle / full, unknown = full');

// ---- interval part
assert.equal(intervalStrain(null, 1), 0);
assert.equal(intervalStrain(1.0, 1), 0); // threshold work: never
assert.equal(intervalStrain(1.04, 1), 0);
assert.equal(intervalStrain(1.1, 0.5), 0); // first two thirds clear
assert.equal(intervalStrain(1.1, 2 / 3), 0);
near(intervalStrain(1.1, 5 / 6), 0.3299); // halfway through the last third: 0.5^1.6
near(intervalStrain(1.1, 1), 1);
near(intervalStrain(1.05, 1), 0.6667); // 105% FTP tops out at two thirds
near(intervalStrain(1.5, 1), 1);
near(intervalStrain(1.1, 1.2), 1); // progress past the end is the end
ok('interval part: last third of 105%+ steps, full at 110%');

// ---- W' part and balance
assert.equal(wprimeStrain(W_PRIME, 300, 250), 0);
assert.equal(wprimeStrain(9000, 300, 250), 0); // half spent: starts here
near(wprimeStrain(4950, 300, 250), 0.5); // 72.5% spent
near(wprimeStrain(900, 300, 250), 1); // 95% spent
assert.equal(wprimeStrain(900, 200, 250), 0); // under 90% of CP: recovering, clear
assert.equal(wprimeStrain(900, 300, 0), 0); // no FTP
assert.equal(wbalStep(18000, 300, 250, 10), 17500); // 50 W over CP for 10 s
assert.equal(wbalStep(100, 400, 250, 10), 0); // never below 0
near(wbalStep(8000, 150, 250, 60), 9096.1, 0.5); // tau 516.9 s at 100 W under CP
assert.equal(wbalStep(18000, 100, 250, 60), 18000); // never above W'
ok("W' part: past half spent, only near or above CP; Skiba balance");

// ---- paintPain on a fake #ride
function root() {
  const cls = new Set(), vars = {};
  return {
    cls, vars, offsetWidth: 0,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
    style: { setProperty: (k, v) => { vars[k] = v; } },
  };
}
const vo2 = { kind: 'erg', from: 1.1, to: 1.1, dur: 240 };
const rec = { kind: 'erg', from: 0.5, to: 0.5, dur: 240 };
function ses(x = {}) {
  return { elapsed: 0, segIndex: 3, seg: vo2, segProgress: 0.99, started: true, paused: false, finished: false, intensity: 1,
    s: { ftp: 200 }, powerBuf: Array(12).fill(220), _dt: 0.25, hr: { bpm: 150 }, ...x };
}
{
  const r = root(), s = ses();
  let out = paintPain(s, r, 1);
  near(out.strain, 0.9524); // tail 0.97 -> 0.97^1.6
  assert.equal(r.vars['--pain'], '0.952');
  assert.equal(r.vars['--beat'], '0.40s'); // 150 bpm
  assert.ok(r.cls.has('pain-on'));
  assert.ok(!r.cls.has('pain-nohr'));
  out = paintPain(s, root(), 0.55); // a new root, same session: subtle caps it
  near(out.strain, 0.5238);
  const off = root();
  assert.equal(paintPain(ses(), off, 0).strain, 0);
  assert.ok(!off.cls.has('pain-on'));
  assert.equal(off.vars['--pain'], '0.000');
  ok('paintPain: strain, --pain, --beat from HR, setting caps it, off = nothing');
}
{
  const r = root();
  assert.equal(paintPain(ses({ paused: true }), r, 1).strain, 0);
  assert.equal(paintPain(ses({ started: false }), root(), 1).strain, 0);
  assert.equal(paintPain(ses({ finished: true }), root(), 1).strain, 0);
  assert.equal(paintPain(ses({ intensity: 0.9 }), root(), 1).strain, 0); // effort -10%: 99% FTP is no longer hard
  const nohr = root();
  paintPain(ses({ hr: null }), nohr, 1);
  assert.ok(nohr.cls.has('pain-nohr'));
  assert.equal(nohr.vars['--beat'], undefined);
  ok('paintPain: paused, not started, done, lowered effort and no HR strap');
}
{
  // free ride at 400 W, CP 200: 200 J/s spent, half of W' gone at 45 s, then the W' part rises
  const r = root(), s = ses({ seg: null, segIndex: -1, powerBuf: Array(12).fill(400) });
  let out;
  for (let t = 0; t <= 60; t += 0.25) { s.elapsed = t; out = paintPain(s, r, 1); }
  near(out.wbal, 6000, 1); // 18000 - 200 x 60
  near(out.strain, 0.3704); // 12 of 18 kJ spent: (0.6667 - 0.5) / 0.45
  ok("paintPain: W' builds strain in free ride");
}
{
  // a hard rep ends: clear flash, gone a second later
  const r = root(), s = ses();
  paintPain(s, r, 1);
  Object.assign(s, { elapsed: 0.25, segIndex: 4, seg: rec, segProgress: 0, powerBuf: Array(12).fill(100) });
  const out = paintPain(s, r, 1);
  assert.equal(out.strain, 0);
  assert.ok(r.cls.has('pain-release'));
  assert.ok(!r.cls.has('pain-on'));
  s.elapsed = 1.5; paintPain(s, r, 1);
  assert.ok(!r.cls.has('pain-release'));
  // an easy step ending doesn't flash
  Object.assign(s, { elapsed: 1.75, segIndex: 5 });
  paintPain(s, r, 1);
  assert.ok(!r.cls.has('pain-release'));
  ok('paintPain: clear flash when a hard rep ends, none after an easy step');
}
console.log(`${n} pain tests passed`);
