// Training tab (js/training.js): the pure chart builders. renderTraining() itself is DOM code, checked by the smoke test.
import assert from 'node:assert/strict';
import { svgLoad, svgWeekly, svgCurve, svgCurvePhone, zoneBars, zonesHtml, infoTip, LOAD_INFO } from '../js/training.js';
import { loadSeries, loadNow, weekly, powerCurve } from '../js/stats.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const ZC = { z1: '#a3a9ae', z2: '#2d7ff9', z3: '#1fa855', z4: '#f4be1a', z5: '#f47b20', z6: '#e23b44' };
const desk = { phone: false, INK: '#111', MUTED: '#777', RULE: '#ddd', FAINT: '#bbb', UNDERLAY: '#eee', FITNESS: '#0aa', FATIGUE: '#a0a', TOK: { sheet: '#fff' }, ZC, zoneHex: () => '#f47b20' };
const phone = { ...desk, phone: true };
const count = (s, re) => (s.match(re) || []).length;

// six weeks of rides, every third day, ending yesterday; one HR-only import with no power and no zones
const now = new Date('2026-11-17T21:00:00');
const rides = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(now); d.setDate(d.getDate() - 1 - i * 3); d.setHours(18, 30, 0, 0);
  const hr = i === 5;
  return {
    id: `${d.toLocaleDateString('en-CA')}T1830`, start: d.toISOString(), name: `Ride ${i + 1}`, ftp: 250, durSec: 3600, tss: 60 + i, ...(hr ? { tssFrom: 'hr' } : {}),
    bests: hr ? {} : { 5: 700 - i, 15: 600, 30: 480, 60: 380, 180: 310, 300: 290, 600: 270, 1200: 255, 3600: 200 },
    zones: hr ? undefined : [300, 1800, 600, 600, 300, 0, 0],
  };
});

// ---- fitness / fatigue / form
const series = loadSeries(rides, now, 90);
const d = svgLoad(series, desk), p = svgLoad(series, phone);
assert.match(d, /viewBox="0 0 640 330"/);
assert.match(p, /viewBox="0 0 640 440"/, 'phone draws taller with bigger text');
assert.equal(count(d, /<polyline/g), 2, 'fitness and fatigue lines');
assert.match(d, /stroke="#0aa"/); assert.match(d, /stroke="#a0a"/);
const e = loadNow(series.at(-1));
assert.match(d, new RegExp(`>${e.fitness}</text><text[^>]*>Fitness<`), 'fitness end value');
assert.match(d, new RegExp(`>${e.fatigue}</text><text[^>]*>Fatigue<`), 'fatigue end value');
assert.match(d, new RegExp(`Form <tspan[^>]*>now ${e.form > 0 ? '\\+' : ''}${e.form}, `), 'form now, same number as the cards');
for (const band of ['Very fresh', 'Fresh', 'Balanced', 'Productive fatigue', 'Overreaching']) assert.ok(d.includes(`>${band}</text>`), band);
assert.equal(count(d, /font-weight="700">[A-Z][a-z]/g), 1, 'only the current form band is bold');
assert.match(d, /Nov 1</, 'the 1st of the month is a tick');
assert.match(svgLoad([series[0]], desk), /Ride a few times/, 'one day is not a chart');
assert.doesNotMatch(d, /NaN|undefined/);
ok('fitness chart: lines, end values, form bands, phone layout');

// ---- weekly load
const wk12 = weekly(rides, 12, now), wk8 = weekly(rides, 8, now);
const w = svgWeekly(wk12, desk), wp = svgWeekly(wk8, phone);
assert.match(w, /viewBox="0 0 560 /); assert.match(wp, /viewBox="0 0 340 /);
assert.equal(count(w, /<title>/g), 12); assert.equal(count(wp, /<title>/g), 8);
assert.equal(count(w, /<clipPath id="wk-c\d+"><rect [^>]*rx="6"/g), 12, 'round tops on every bar');
assert.match(w, /fill="url\(#wk-hr\)"/, 'HR-only TSS hatched');
assert.match(w, /HR only \(no power\)/, 'legend names the hatch');
assert.match(w, /fill="#2d7ff9"/, 'Z2 from the zone palette');
assert.match(w, new RegExp(`>${wk12.at(-1).tss}</text>`), 'this week\'s TSS on its bar');
assert.match(w, /font-weight="700">[A-Z][a-z]{2} \d+</, 'this week\'s date is bold');
assert.ok(!/filter|glow/.test(w), 'no glow');
const noHr = svgWeekly(weekly(rides.filter((r) => r.zones), 12, now), desk);
assert.doesNotMatch(noHr, /HR only \(no power\)/);
assert.match(svgWeekly(weekly([], 4, now), desk), /fill="#111" font-size="12" font-weight="700"/, 'empty weeks still draw labels');
ok('weekly bars: 12 weeks desktop, 8 phone, zones stacked, HR-only hatched');

// ---- power curve
const c90 = powerCurve(rides, 90, now.getTime()), cAll = powerCurve(rides);
const cd = svgCurve(c90, cAll, desk), cp = svgCurve(c90, cAll, phone);
assert.match(cd, /viewBox="0 0 1000 230"/); assert.doesNotMatch(cd, /pc-phone/);
assert.equal(cp, svgCurvePhone(c90, cAll, phone), 'phone look draws the phone curve');
assert.match(cp, /class="svgchart pc-phone"/);
for (const c of [cd, cp]) {
  assert.equal(count(c, /<circle/g), 9, 'a dot per duration');
  assert.equal(count(c, /<polyline/g), 2, '90 days and all time');
  assert.match(c, /stroke="#f47b20" stroke-width/, 'orange line');
  assert.match(c, /<polygon/, 'soft fill');
  assert.match(c, />700</, 'best 5 s labelled');
  assert.match(c, />60m</);
}
assert.match(cd, /stroke="#fff" stroke-width="2"/, 'dots ringed in the sheet color');
const one = svgCurve({ 5: 500 }, { 5: 500 }, desk);
assert.doesNotMatch(one, /<polygon/, 'no fill under a single point');
ok('power curve: desktop and phone, orange, a dot per duration');

// ---- time in zones
assert.match(zoneBars([]), /No rides in this period/);
assert.match(zoneBars([0, 0, 0, 0, 0, 0, 0]), /No rides in this period/);
const zb = zoneBars([600, 3600, 0, 0, 0, 0, 0]);
assert.equal(count(zb, /class="zb-z"/g), 7);
assert.match(zb, /Z2<\/div><div class="zb-n">Endurance<span>56-75%<\/span>/);
assert.match(zb, /width:100%;background:var\(--z2\)/, 'longest zone fills the bar');
assert.match(zb, />1h 00m</); assert.match(zb, />10:00</);
assert.match(zb, />86%</);
assert.match(zoneBars([600], 250), /Recovery<span>0-137 W/, 'watts with an FTP');
const thisWeek = wk12.at(-1).start;
const zh = zonesHtml(rides, thisWeek, now.getTime());
assert.match(zh, /<h4>This week /); assert.match(zh, /<h4>Last 4 weeks /);
const in28 = rides.filter((r) => r.id.slice(0, 10) >= new Date(now.getTime() - 27 * 864e5).toLocaleDateString('en-CA')).length;
assert.ok(zh.includes(`${in28} rides`), 'ride count in the last 4 weeks');
assert.match(zonesHtml(rides, thisWeek, Date.parse('2027-06-01')), /No rides in this period/, 'nothing in an empty month');
assert.match(zonesHtml([rides[0]], rides[0].id.slice(0, 10), now.getTime()), /1 ride</, 'singular');
ok('time in zones: rows, ranges, this week and the last 4 weeks');

// ---- info tips
const tip = infoTip(LOAD_INFO.ctl, 'Fitness <CTL>');
assert.match(tip, /aria-label="What is Fitness &lt;CTL&gt;\?"/, 'label escaped');
assert.match(tip, /<b>Chronic Training Load\.<\/b>/, 'tip keeps its HTML');
assert.deepEqual(Object.keys(LOAD_INFO), ['ctl', 'atl', 'tsb']);
ok('info tips');

console.log(`training: ${n} tests passed`);
