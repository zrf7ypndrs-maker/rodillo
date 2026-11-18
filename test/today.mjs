// Today and Calendar (js/today.js): the pure pieces (day facts, card and hero markup, the WHOOP recovery call).
// renderOverview / renderHero / renderWeek / renderCalendar are DOM code, checked by the smoke test (seeded week,
// fixed clock). Uses the real coach library in workouts/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  dayInfo, workoutColor, dayCardHtml, rideStatsHtml, complianceLine, heroDoneBody, heroNums, heroRecovery, recoveryAdvice,
  coachDecision, DECISION_LABEL, isHard, recZone, whoopDay, fmtHours, BIKE_ICO, overviewHtml, calGridHtml, calDayHtml,
} from '../js/today.js';
import { flatten, totalDuration, estimateTSS, mainSet, isTrack } from '../js/engine/workout.js';
import { fmtTime } from '../js/ridepage.js';
import { loadSeries, loadNow, formLabel } from '../js/stats.js';
import { LOAD_INFO } from '../js/training.js';
import { DEFAULT_SETTINGS } from '../js/engine/session.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const root = path.resolve(new URL('..', import.meta.url).pathname);
const LIB = JSON.parse(fs.readFileSync(path.join(root, 'workouts/index.json'), 'utf8')).workouts
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'workouts', f), 'utf8')));
const W = (id) => LIB.find((w) => w.id === id);
const ftp = DEFAULT_SETTINGS.ftp;
const ride = (id, x = {}) => ({ summary: { id, name: `Ride ${id}`, durSec: 3600, tss: 50, ftp: 240, ...x } });
const v = {
  plan: {
    days: { '2026-11-16': 'z2-60', '2026-11-17': 'vo2-30-15', '2026-11-18': 'sweetspot-3x12', '2026-11-19': 'rest', '2026-11-20': 'strength', '2026-11-21': 'sim-rolling-45', '2026-11-22': 'z2-90', '2026-11-23': 'gone-workout' },
    notes: { '2026-11-18': 'Steady <not> heroic.' },
    optional: ['2026-11-22', '2026-11-15'],
    daily: { '2026-11-19': { action: 'rest', reason: 'Legs & lungs need a day.' }, '2026-11-24': { action: 'mystery', reason: 'Odd one.' }, '2026-11-25': { action: 'kept' } },
  },
  library: LIB,
  rows: [
    ride('2026-11-18T0715', { name: 'Free <ride>', tss: 15 }),
    ride('2026-11-17T2100', { name: 'Evening spin', tss: 8 }), // newest first: the spin after the workout comes first
    ride('2026-11-17T1830', { name: 'VO2', workoutId: 'vo2-30-15', tss: 72 }),
    { ...ride('2026-11-16T1000', { workoutId: 'z2-60' }), demo: true },
  ],
  whoop: { '2026-11-18': { recovery: 25 } },
  settings: { ...DEFAULT_SETTINGS, ftp: 250, riderKg: 80 },
  today: '2026-11-18',
  gradeHex: (g) => `grade(${g})`, zoneHex: (f) => `zone(${+f.toFixed(3)})`,
  woMeta: (w) => `meta ${w.id}`, profileSvg: (w, width, height) => `<svg class="profile" data-id="${w.id}" data-size="${width}x${height}"></svg>`,
  isSim: (w) => flatten(w).some((s) => s.kind === 'sim'), workSummary: (w) => mainSet(w, ftp),
};
const count = (s, re) => (s.match(re) || []).length;

// ---- day facts
const wed = dayInfo('2026-11-18', v);
assert.equal(wed.workout.id, 'sweetspot-3x12');
assert.equal(wed.kind, 'ride');
assert.equal(wed.note, 'Steady <not> heroic.');
assert.equal(wed.done.name, 'Free <ride>', 'another ride counts as done (the hero still leaves the workout open)');
assert.deepEqual([wed.isToday, wed.isPast, wed.optional], [true, false, false]);
const tue = dayInfo('2026-11-17', v);
assert.equal(tue.ridden.length, 2);
assert.equal(tue.done.name, 'VO2', 'the planned workout wins over another ride the same day');
assert.deepEqual([tue.isToday, tue.isPast], [false, true]);
assert.equal(dayInfo('2026-11-16', v).ridden.length, 0, 'demo rides never count');
assert.equal(dayInfo('2026-11-16', v).done, undefined);
assert.deepEqual([dayInfo('2026-11-19', v).kind, dayInfo('2026-11-19', v).workout], ['rest', null]);
assert.equal(dayInfo('2026-11-20', v).kind, 'strength');
assert.equal(dayInfo('2026-11-22', v).optional, true);
assert.deepEqual([dayInfo('2026-11-23', v).workout, dayInfo('2026-11-23', v).kind], [null, 'gone-workout'], 'a workout the library lost is not a ride');
assert.deepEqual([dayInfo('2026-12-30', v).kind, dayInfo('2026-12-30', v).note], [null, '']);
assert.equal(dayInfo('2026-11-18', { ...v, plan: null, rows: undefined }).workout, null, 'no plan, no rides');
ok('day facts: workout, done (planned workout first), demo rides left out, rest / strength, optional, past / today');

// ---- the day's color: steepest grade on a slope day, else the zone of the hardest stretch (30 s or more)
const sim = W('sim-rolling-45');
assert.equal(workoutColor(sim, v), `grade(${Math.max(...flatten(sim).map((x) => x.grade ?? 0))})`);
const ss = W('sweetspot-3x12'), ssWork = Math.max(...flatten(ss).filter((x) => x.kind === 'erg' && x.dur >= 30).map((x) => (x.from + x.to) / 2));
assert.equal(workoutColor(ss, v), `zone(${+ssWork.toFixed(3)})`);
const spike = { id: 'spike', steps: [{ dur: 600, power: 0.6 }, { dur: 10, power: 2 }, { dur: 600, power: 0.6 }] };
assert.equal(workoutColor(spike, v), 'zone(0.6)', 'a 10 s spike does not color the day');
ok('day color: steepest grade for slope days, hardest 30 s+ stretch for ERG');

// ---- Next days cards
const card = (key) => dayCardHtml(dayInfo(key, v), v);
const wedCard = card('2026-11-18');
assert.match(wedCard, /data-day="2026-11-18"/);
assert.match(wedCard, />Wed 18</, 'weekday and date (local noon, same in every time zone)');
assert.match(wedCard, /<div class="d-name">Sweet spot 3 x 12<\/div><div class="d-meta">meta sweetspot-3x12<\/div>/);
assert.match(wedCard, new RegExp(`--c:zone\\(${+ssWork.toFixed(3)}\\)`));
assert.match(wedCard, /&#10003; Free &lt;ride&gt; &middot; 15 TSS/, 'another ride: its (escaped) name');
assert.match(wedCard, /class="day\s+done"/);
assert.match(card('2026-11-17'), /&#10003; Done &middot; 72 TSS/, 'the planned workout: Done');
assert.match(card('2026-11-17'), /class="day  past done"/);
assert.match(card('2026-11-16'), /<div class="d-missed">Missed<\/div>/);
assert.match(dayCardHtml(dayInfo('2026-11-15', { ...v, plan: { ...v.plan, days: { '2026-11-15': 'z2-60' } } }), v), /Skipped \(optional\)/);
assert.match(card('2026-11-22'), /<div class="d-missed">Optional<\/div>/);
assert.match(card('2026-11-19'), /<div class="d-name muted">Rest<\/div>/);
assert.match(card('2026-11-19'), /class="day nowo  "/);
assert.match(card('2026-11-19'), /--c:transparent/);
assert.match(card('2026-11-20'), />Strength</);
assert.match(card('2026-12-30'), />Nothing planned</);
ok('Next days cards: name and meta, color, done / missed / skipped / optional, rest, strength, nothing planned');

// ---- a finished ride's numbers (done hero, Calendar day)
const vo2 = W('vo2-30-15');
const r = { id: '2026-11-17T1830', workoutId: 'vo2-30-15', name: 'VO2', durSec: 3300, np: 210, avgP: 180, tss: 72, if: 0.84, kj: 600, avgHr: 150, maxHr: 178, compliance: { avg: 97, min: 93, reps: 30 } };
const stats = rideStatsHtml(vo2, r, v);
const labels = (h) => [...h.matchAll(/<b>(.*?)<\/b>/g)].map((m) => m[1]);
assert.deepEqual(labels(stats), ['Time', 'NP', 'TSS', 'IF', 'Avg HR', 'Intervals']);
assert.match(stats, new RegExp(`>${fmtTime(3300)}</div><div class="l"><b>Time</b><span class="wide-only"> &middot; plan ${fmtTime(totalDuration(vo2))}`));
assert.match(stats, /210 W<\/div><div class="l"><b>NP<\/b><span class="wide-only"> &middot; avg 180 W/);
assert.match(stats, new RegExp(`<b>TSS</b><span class="wide-only"> &middot; plan ~${estimateTSS(vo2)}`));
assert.match(stats, /0\.84<\/div><div class="l"><b>IF<\/b><span class="wide-only"> &middot; 600 kJ/);
assert.match(stats, /class="v hr">150<\/div><div class="l"><b>Avg HR<\/b><span class="wide-only"> &middot; max 178/);
assert.match(stats, /class="v warn">97%<\/div><div class="l"><b>Intervals<\/b><span class="wide-only"> &middot; 30 reps &middot; min 93%/);
assert.match(rideStatsHtml(vo2, { ...r, compliance: { avg: 100, min: 95, reps: 1 } }, v), /class="v ok">100%.*1 rep &middot;/);
const free = rideStatsHtml(vo2, { id: 'x', name: 'Free', durSec: 600, tss: 0 }, v);
assert.deepEqual(labels(free), ['Time', 'TSS'], 'only the numbers the ride has (TSS 0 still shows)');
assert.doesNotMatch(free, /plan/, 'another ride: no plan numbers');
assert.doesNotMatch(rideStatsHtml(sim, { workoutId: sim.id, durSec: 600, tss: 30 }, v), /plan ~/, 'slope workouts have no planned TSS');
assert.deepEqual(labels(rideStatsHtml(null, { durSec: 60, tss: 1 }, v)), ['Time', 'TSS'], 'no planned workout');
ok('ride numbers: only what the ride has, plan figures for the planned workout, intervals ok / warn at 95%');

assert.equal(complianceLine(null), '');
assert.equal(complianceLine({ min: 95, reps: 1 }), 'All 1 rep on target.');
assert.equal(complianceLine({ min: 99, reps: 4 }), 'All 4 reps on target.');
assert.equal(complianceLine({ min: 93, reps: 30 }), 'Weakest rep at 93% of target.');
ok('compliance line: all on target from 95%, else the weakest rep');

// ---- the done hero and the phone's big numbers
const doneSame = heroDoneBody(vo2, { ...r, start: '2026-11-17T18:30:00' }, 'Tue, Nov 17', v);
assert.match(doneSame, /<span class="ok">Done\.<\/span> VO2max 30\/15 x 3 sets/);
assert.match(doneSame, /<p class="hero-desc">Weakest rep at 93% of target\.<\/p>/);
assert.match(doneSame, /<span>Tue, Nov 17 &middot; \d{1,2}:30/, 'the time it was ridden');
assert.match(doneSame, /data-id="vo2-30-15" data-size="1000x100"/, 'the planned workout\'s profile');
assert.equal(count(doneSame, /class="hs"/g), 6);
assert.match(doneSame, /id="hero-see"/);
assert.match(doneSame, /id="btn-free"/);
const doneOther = heroDoneBody(vo2, { id: 'x', workoutId: 'z2-60', name: 'Zone <2>', durSec: 3600, tss: 40 }, 'Tue, Nov 17', v);
assert.match(doneOther, /Done\.<\/span> Zone &lt;2&gt;/);
assert.match(doneOther, /Instead of VO2max 30\/15 x 3 sets\./);
assert.doesNotMatch(doneOther, /class="hero-prof/, 'no profile of a workout that was not ridden');
assert.doesNotMatch(heroDoneBody(vo2, { ...r, compliance: null }, 'd', v), /hero-desc/, 'nothing to say: no line');
ok('done hero: result, time ridden, numbers, profile only for the planned workout, "Instead of" for a swap');

const nums = (w) => [...heroNums(w, mainSet(w, ftp), v).matchAll(/<div class="v">(.*?)<\/div><div class="l">(.*?)<\/div>/g)].map((m) => [m[1].replace(/<\/?small>/g, ''), m[2]]);
const ssNums = nums(ss), ssSet = mainSet(ss, ftp);
assert.deepEqual(ssNums.map(([, l]) => l), [ssSet.replace(/\sat\s[\d/]+\sW/, '').trim(), 'Time', 'TSS']);
assert.equal(ssNums[0][0], `${ssSet.match(/\sat\s([\d/]+)\sW/)[1]}W`);
assert.deepEqual(ssNums[1], [`${Math.round(totalDuration(ss) / 60)}min`, 'Time']);
assert.deepEqual(ssNums[2], [`~${estimateTSS(ss)}`, 'TSS']);
assert.match(heroNums(ss, mainSet(ss, ftp), v), /class="hn main"/);
const climb = W('climb-el-durazno');
assert.ok(isTrack(flatten(climb)));
assert.equal(heroNums(climb, '', v), '', 'real climbs keep the meta line (ascent)');
assert.deepEqual(nums(W('ramp-test')).map(([, l]) => l), ['Time', 'TSS'], 'no main set: time and TSS');
for (const w of LIB.filter((x) => flatten(x).every((s) => s.kind === 'sim'))) assert.equal(heroNums(w, '', v), '', `${w.id}: slope workouts keep the meta line`);
const mixed = { id: 'mixed', steps: [{ dur: 300, power: 0.5 }, { dur: 600, grade: 5 }] };
assert.ok(!isTrack(flatten(mixed)));
assert.deepEqual(nums(mixed).map(([, l]) => l), ['Time'], 'part slope: no TSS estimate');
ok('hero numbers: main set watts, time, TSS; no TSS with slope parts; nothing for slope workouts');

// ---- WHOOP recovery and the coach's call
assert.deepEqual([100, 67, 66, 34, 33, 0].map(recZone), ['green', 'green', 'yellow', 'yellow', 'red', 'red']);
assert.equal(whoopDay('2026-11-18', v).recovery, 25);
assert.equal(whoopDay('2026-11-18', { ...v, whoop: null }), undefined);
assert.equal(isHard(null), false);
assert.equal(isHard(ss), true, 'threshold tag');
assert.equal(isHard(vo2), true, 'vo2 tag');
assert.equal(isHard(W('z2-60')), false);
assert.equal(isHard({ steps: [{ dur: 120, power: 0.9 }] }), true, '2 min at 88%+ without tags');
assert.equal(isHard({ steps: [{ dur: 119, power: 1.2 }] }), false, 'shorter is not');
ok('recovery zones, WHOOP day, hard sessions (tags or 2 min at 88%+)');

assert.equal(coachDecision('2026-11-18', v), '');
assert.equal(coachDecision('2026-11-25', v), '', 'no reason, nothing to show');
assert.equal(coachDecision('2026-11-19', v), '<p class="coach-call"><span class="tag coach">coach &middot; Rest instead</span> Legs &amp; lungs need a day.</p>');
assert.match(coachDecision('2026-11-24', v), /coach &middot; Coach<\/span> Odd one\./, 'an unknown action is just "Coach"');
assert.deepEqual(Object.keys(DECISION_LABEL), ['kept', 'scaled', 'swapped', 'moved', 'rest']);
const at = (key, rec, x = {}) => ({ ...dayInfo(key, { ...v, rows: [], whoop: { [key]: { recovery: rec } } }), ...x });
const vw = (key, rec) => ({ ...v, rows: [], whoop: rec == null ? {} : { [key]: { recovery: rec } } });
const advice = (key, rec, x) => recoveryAdvice(at(key, rec, x), vw(key, rec));
assert.match(advice('2026-11-18', 20), /class="rec-advice red"><p>Hard session on a red recovery day/);
assert.deepEqual([...advice('2026-11-18', 20).matchAll(/data-rec="(.*?)"/g)].map((m) => m[1]), ['swap', '0.9']);
assert.deepEqual([...advice('2026-11-16', 20).matchAll(/data-rec="(.*?)"/g)].map((m) => m[1]), ['0.95'], 'red, easy day');
assert.deepEqual([...advice('2026-11-18', 50).matchAll(/data-rec="(.*?)"/g)].map((m) => m[1]), ['0.97'], 'yellow, hard day');
assert.match(advice('2026-11-16', 50), /Green light: ride as planned\./, 'yellow, easy day');
assert.match(advice('2026-11-18', 80), /class="rec-advice green"><p>Green light: ride as planned\.<\/p><\/div>/);
assert.equal(advice('2026-11-18', 20, { done: { name: 'x' } }), '', 'already ridden');
assert.equal(advice('2026-11-20', 20), '', 'no workout');
assert.equal(recoveryAdvice(null, v), '');
assert.equal(advice('2026-11-18', null), '', 'no recovery, no decision');
assert.match(recoveryAdvice(at('2026-11-19', null), vw('2026-11-19', null)), /^<p class="coach-call">/, 'no recovery: the decision alone');
assert.match(recoveryAdvice(at('2026-11-19', 20), vw('2026-11-19', 20)), /^<div class="rec-advice red stacked"><p class="coach-call">/, 'the coach already decided: no second adjustment');
ok('recovery advice: red / yellow / green by session, buttons, the coach\'s decision wins');

const hero = (key, rec, x) => heroRecovery(at(key, rec, x), vw(key, rec));
assert.equal(hero('2026-11-18', null), '', 'no WHOOP, no decision: nothing');
assert.match(hero('2026-11-18', 20), /^<div class="hero-rec"><span class="rdot red"><\/span><span>Hard session on a red recovery day.*<\/span><span class="row-btns"><button[^>]*data-rec="swap".*data-rec="0\.9".*<\/button><\/span><\/div>$/s);
assert.equal(hero('2026-11-18', 80), '<div class="hero-rec"><span class="rdot green"></span><span>Green light: ride as planned.</span></div>');
assert.equal(hero('2026-11-18', 20, { done: { name: 'x' } }), '', 'already ridden: no call');
assert.equal(hero('2026-11-19', null), '<div class="hero-rec"><span><span class="tag coach">coach &middot; Rest instead</span> Legs &amp; lungs need a day.</span></div>');
assert.match(hero('2026-11-19', 50), /^<div class="hero-rec"><span class="rdot yellow"><\/span><span><span class="tag coach">/);
ok('hero recovery line: the call with its zone dot and buttons, the coach\'s decision, nothing once ridden');

// ---- overview tiles (desktop four tiles; phone three plus the recovery card, which css pulls to the top)
const now = new Date(2026, 10, 18, 9, 0);
const ov = overviewHtml(now, false, v), ovPhone = overviewHtml(now, true, v);
const tiles = (h) => [...h.matchAll(/<div class="ol">(.*?)<\/div><div class="v">(.*?)<\/div>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim()]);
const tileOf = (h, l) => tiles(h).find(([x]) => x === l)?.[1];
assert.deepEqual(tiles(ov).map(([l]) => l), ['Recovery', 'This week', 'Form', 'FTP']);
assert.deepEqual(tiles(ovPhone).map(([l]) => l), ['Recovery', 'This week', 'Form', 'FTP'], 'the phone hides the recovery tile with css');
assert.match(ov, /<span class="rz red">25%<\/span>/);
assert.match(ov, /<div class="ov-bar red"><i style="width:25%"><\/i><\/div>/);
assert.doesNotMatch(ov, /rec-card/, 'desktop: no recovery card');
assert.match(ovPhone, /<div class="rec-card">.*<span class="rc-v">25<small>%<\/small><\/span>/s);
assert.match(ovPhone, /<svg class="rec-ring red".*stroke-dasharray="42\.4 169\.6"/s, 'ring a quarter full');
assert.doesNotMatch(ovPhone, /rc-call/, 'ridden today: no call');
assert.match(overviewHtml(now, true, { ...v, rows: v.rows.slice(1) }), /<div class="rc-call"><span class="rdot red"><\/span><span>Hard session/, "the hero's recovery call, in the card");
const real = v.rows.filter((r) => !r.demo).map((r) => r.summary);
const wk = ['16', '17', '18', '19', '20', '21', '22'].map((d) => `2026-11-${d}`);
const planSec = wk.filter((k) => W(v.plan.days[k]) && !v.plan.optional.includes(k)).reduce((a, k) => a + totalDuration(W(v.plan.days[k])), 0);
const doneSec = real.filter((r) => wk.includes(r.id.slice(0, 10))).reduce((a, r) => a + r.durSec, 0);
assert.equal(tileOf(ov, 'This week'), `${fmtHours(doneSec)} / ${fmtHours(planSec)}`, 'done / planned, optional day left out, demo ride left out');
assert.deepEqual([...ov.matchAll(/<span class="wd (.*?)"/g)].map((m) => m[1]), ['plan', 'done', 'done today', 'off', 'off', 'plan', 'plan']);
assert.equal([...ov.matchAll(/<em>(.)<\/em>/g)].map((m) => m[1]).join(''), 'MTWTFSS');
const ld = loadNow(loadSeries(real, now, 90).at(-1));
assert.equal(tileOf(ov, 'Form'), `${ld.form > 0 ? '+' : ''}${ld.form} ${formLabel(ld.form).toLowerCase()}`);
assert.ok(ov.includes(`<div class="os">fitness ${ld.fitness} &middot; fatigue ${ld.fatigue}</div>`));
assert.equal(tileOf(ovPhone, 'Form'), `${ld.form > 0 ? '+' : ''}${ld.form}`, 'phone: the label goes under the number');
assert.ok(ovPhone.includes(`<div class="os">${formLabel(ld.form).toLowerCase()}</div>`));
assert.ok(ov.includes(LOAD_INFO.tsb), 'Form explains itself in an info tip');
assert.equal(tileOf(ov, 'FTP'), '250 W · 3.1 W/kg');
assert.equal(tileOf(ovPhone, 'FTP'), '250 W');
assert.match(ovPhone, /<div class="os">3\.1 W\/kg<\/div>/);
assert.match(ov, /<b class="up">\+10 W<\/b> since Nov 17/, 'FTP change since the oldest ride in 90 days (the FTP it was ridden at)');
assert.match(overviewHtml(now, false, { ...v, settings: { ...v.settings, ftp: 240 } }), /same since Nov 17/);
const ovNone = overviewHtml(now, false, { ...v, whoop: null, rows: [] });
assert.match(ovNone, /<span class="none">Off<\/span>.*<div class="os">no WHOOP<\/div>/s, 'no WHOOP connected');
assert.match(overviewHtml(now, true, { ...v, whoop: {}, rows: [] }), /<span class="none">Not yet<\/span>.*not scored yet/s, 'WHOOP, no score today');
assert.equal(tileOf(ovNone, 'This week'), `0:00 / ${fmtHours(planSec)}`);
assert.doesNotMatch(ovNone, /ov-ftp/, 'no ride with an FTP: no FTP line');
assert.equal(tileOf(overviewHtml(now, false, { ...v, plan: null, rows: [] }), 'This week'), '0:00', 'no plan: no planned hours');
ok('overview tiles: recovery tile / phone card, this week done vs planned and its dots, form vs stats.js, FTP and its change');

// ---- Calendar: month grid and the selected day's detail
const grid = (ym, sel = '2026-11-18', x = v) => calGridHtml(ym, sel, x).split('<div class="cal-cell ').slice(1).map((c) => ({
  cls: c.slice(0, c.indexOf('"')).replace(/\s+/g, ' ').trim(), day: c.match(/data-day="(.*?)"/)[1],
  rest: c.slice(c.indexOf('</div>') + 6).replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/\s+/g, ' ').trim(),
}));
const nov = grid('2026-11');
assert.equal(count(calGridHtml('2026-11', '2026-11-18', v), /class="cal-dow"/g), 7);
assert.deepEqual([nov.length, nov[0].day, nov.at(-1).day], [36, '2026-10-26', '2026-11-30'], 'Monday first; the sixth row only as far as the month goes');
assert.deepEqual([grid('2026-06').length, grid('2026-06')[0].day], [35, '2026-06-01'], 'a month starting on a Monday');
assert.deepEqual([grid('2026-02').length, grid('2026-02').at(-1).day], [35, '2026-03-01']);
const cellOf = (day) => nov.find((c) => c.day === day);
assert.equal(cellOf('2026-10-31').cls, 'other');
assert.equal(cellOf('2026-11-18').cls, 'today sel');
assert.equal(grid('2026-11', '2026-11-03').find((c) => c.day === '2026-11-03').cls, 'sel');
const mins = (id) => Math.round(totalDuration(W(id)) / 60);
assert.equal(cellOf('2026-11-16').rest, `|${W('z2-60').name}|${mins('z2-60')}'|missed|`);
assert.equal(cellOf('2026-11-17').rest, `|${W('vo2-30-15').name}|${mins('vo2-30-15')}'|&#10003; 72 TSS|`);
assert.equal(cellOf('2026-11-18').rest, `|${ss.name}|${mins(ss.id)}'|&#10003; 15 TSS|`);
assert.equal(cellOf('2026-11-19').rest, '|Rest|');
assert.equal(cellOf('2026-11-20').rest, '|Strength|');
assert.equal(cellOf('2026-11-22').rest, `|${W('z2-90').name}|${mins('z2-90')}'|optional|`);
assert.equal(cellOf('2026-11-25').rest, '|');
assert.ok(calGridHtml('2026-11', '2026-11-18', v).includes(`<div class="cal-num">18</div><div class="cal-chip" style="--c:zone(${+ssWork.toFixed(3)})">`));
ok('month grid: Monday first, five or six rows, other-month days, today and selected, chips, done / missed / optional');

const det = (day, x = v) => calDayHtml(day, x);
const tday = det('2026-11-18');
assert.match(tday, /^<h3>Wednesday, November 18<\/h3><div class="cal-wo"><div class="wo-top"><div class="wo-name">Sweet spot 3 x 12<\/div><div class="wo-meta">meta sweetspot-3x12<\/div>/);
assert.match(tday, /data-size="600x60"/);
assert.match(tday, /<p><b>Coach:<\/b> Steady &lt;not&gt; heroic\.<\/p>/);
assert.match(tday, /<button class="primary small" data-startday="2026-11-18">Start<\/button>/);
assert.match(tday, /WHOOP: recovery <b class="rz red">25%<\/b>/);
assert.match(tday, /&#10003; <b>Free &lt;ride&gt;<\/b> &middot; 1:00:00 &middot; TSS 15.*data-ride="2026-11-18T0715"/s, 'other rides that day, with See ride');
const dn = det('2026-11-17');
assert.match(dn, /<span class="ok">Done\.<\/span> VO2max 30\/15 x 3 sets<\/div>/);
assert.equal(count(dn, /data-startday/g), 0, 'ridden: no Start');
assert.match(dn, /class="primary small cal-see-main" data-ride="2026-11-17T1830"/);
assert.match(dn, /&#10003; <b>Evening spin<\/b>/, 'the other ride that day is still listed');
assert.equal(count(dn, /<b>VO2<\/b>/g), 0, 'the done workout is not listed twice');
assert.match(det('2026-11-16'), /<p class="cal-missed-line">Missed\.<\/p>\s*<button class="ghost small" data-startday="2026-11-16">Ride it now<\/button>/);
assert.doesNotMatch(det('2026-11-16', { ...v, plan: { ...v.plan, notes: { '2026-11-16': 'old note' } } }), /old note/, 'no pre-ride note on a past day');
assert.match(det('2026-11-21'), /<button class="primary small" data-startday="2026-11-21">Ride it now<\/button>/);
assert.match(det('2026-11-19'), /<p class="muted">Rest day\.<\/p><p class="coach-call"><span class="tag coach">coach &middot; Rest instead<\/span>/);
assert.match(det('2026-11-20'), /Strength day: no ride planned\./);
assert.match(det('2026-12-30'), /^<h3>Wednesday, December 30<\/h3><p class="muted">Nothing planned\.<\/p>$/);
const hrOnly = det('2026-12-01', { ...v, rows: [ride('2026-12-01T1000', { name: 'Outdoor', np: null, tss: 40, tssFrom: 'hr', avgHr: 130 })] });
assert.match(hrOnly, /TSS 40 \(from HR\) &middot; HR 130/);
assert.doesNotMatch(hrOnly, /NP/);
assert.match(det('2026-11-17', { ...v, rows: [ride('2026-11-17T1830', { workoutId: 'vo2-30-15', compliance: { avg: 99, min: 98, reps: 30 }, start: '2026-11-17T18:30:00' })] }), /All 30 reps on target\. Ridden at /);
ok("day detail: plan with coach note and Start, done result first, missed, rest with the coach's call, strength, nothing, WHOOP, other rides");

assert.deepEqual([0, 29, 31, 3600, 5399, 36000].map(fmtHours), ['0:00', '0:00', '0:01', '1:00', '1:30', '10:00']);
assert.match(BIKE_ICO, /^<svg class="bike-ico"[^]*<g class="crank">[^]*<\/svg>$/);
ok('hours and the bike icon');

console.log(`today: ${n} tests passed`);
