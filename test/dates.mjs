// js/dates.js: the shared day keys (app.js, library.js, training.js and stats.js all use these, no copies).
// Run in other time zones too: TZ=America/Santiago node test/dates.mjs, TZ=Asia/Tokyo ...
import assert from 'node:assert/strict';
import { dkey, dayDate, addDays, mondayOf } from '../js/dates.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };

assert.equal(dkey(new Date(2026, 10, 18, 0, 0, 1)), '2026-11-18', 'local day, just after midnight');
assert.equal(dkey(new Date(2026, 10, 18, 23, 59, 59)), '2026-11-18', 'local day, just before midnight');
assert.equal(dkey(new Date(2027, 0, 5, 9)), '2027-01-05', 'zero-padded month and day');
ok('dkey: local date as YYYY-MM-DD');

const d = dayDate('2026-11-18');
assert.equal(dkey(d), '2026-11-18');
assert.equal(d.getHours(), 12);
assert.equal(+dayDate('2026-02-28'), +new Date(2026, 1, 28, 12));
ok('dayDate: a key back to local noon');

assert.equal(dkey(addDays(dayDate('2026-11-18'), 1)), '2026-11-19');
assert.equal(dkey(addDays(dayDate('2026-12-31'), 1)), '2027-01-01', 'across a year');
assert.equal(dkey(addDays(dayDate('2026-03-01'), -1)), '2026-02-28', 'backwards across a month');
const t = new Date(2026, 10, 18, 7, 30);
assert.equal(addDays(t, 3).getHours(), 7, 'keeps the time of day');
assert.equal(+t, +new Date(2026, 10, 18, 7, 30), 'leaves its argument alone');
// a day at a time from noon never skips or repeats a key, DST changes included (US: Mar 8 / Nov 1; Chile: Apr 5 / Sep 6)
const keys = [];
for (let x = dayDate('2026-01-01'); dkey(x) <= '2026-12-31'; x = addDays(x, 1)) keys.push(dkey(x));
assert.equal(keys.length, 365);
assert.equal(new Set(keys).size, 365);
ok('addDays: calendar days, DST changes included');

for (const [day, want] of [['2026-11-16', '2026-11-16'], ['2026-11-18', '2026-11-16'], ['2026-11-22', '2026-11-16'], ['2026-11-23', '2026-11-23'], ['2027-01-01', '2026-12-28']]) {
  const m = mondayOf(new Date(`${day}T06:00`));
  assert.equal(dkey(m), want, `Monday of ${day}`);
  assert.equal(m.getHours(), 12);
}
ok('mondayOf: Monday of the week (Sunday belongs to the week before), at noon');

console.log(`dates: ${n} tests passed`);
