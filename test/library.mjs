// Workouts library (js/library.js): the pure row builders. renderLibrary(), the switch and the detail slider are DOM
// code, checked by the smoke test. Uses the real coach library in workouts/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  gradeBand, climbLevel, cutClimb, sliderOf, detailText, previewOf, gradeRangeHtml, detailRow, isSlopeOnly, HIDDEN_TAGS,
  workoutCard, GROUPS, GROUP_TAGS, groupOf, groupedHtml, woFacts, GRADE_LABEL,
} from '../js/library.js';
import { flatten, totalDuration, estimateTSS, mainSet } from '../js/engine/workout.js';
import { defaultDetail, detailLabel, DETAIL_MIN, DETAIL_MAX } from '../js/engine/climb.js';
import { DEFAULT_SETTINGS } from '../js/engine/session.js';
import { dayDate } from '../js/dates.js';

let n = 0;
const ok = (name) => { n++; console.log('ok -', name); };
const root = path.resolve(new URL('..', import.meta.url).pathname);
const LIB = JSON.parse(fs.readFileSync(path.join(root, 'workouts/index.json'), 'utf8')).workouts
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'workouts', f), 'utf8')));
const W = (id) => LIB.find((w) => w.id === id);
const ZC = { z1: '#a3a9ae', z2: '#2d7ff9', z3: '#1fa855', z4: '#f4be1a', z5: '#f47b20', z6: '#e23b44' };
const GRADE = ['#g-down', '#g0', '#g1', '#g2', '#g3', '#g4'];
const settings = { ...DEFAULT_SETTINGS };
const v = {
  settings, plan: { days: { '2026-11-18': 'vo2-30-15', '2026-11-20': 'sweetspot-3x12', '2026-11-10': 'z2-60' } }, today: '2026-11-18', signedIn: false, GRADE, ZC,
  profileSvg: (w, width = 340) => `<svg class="profile" data-w="${width}" data-id="${w.id}"></svg>`, woMeta: (w) => `meta ${w.id}`, workSummary: (w) => mainSet(w, settings.ftp),
};
const count = (s, re) => (s.match(re) || []).length;

// ---- grade bands
assert.deepEqual([-0.01, 0, 0.029, 0.03, 0.059, 0.06, 0.09, 0.12, 0.2].map(gradeBand), [0, 1, 1, 2, 2, 3, 4, 5, 5]);
assert.equal(GRADE_LABEL.length, 6);
ok('grade bands: down, 0-3, 3-6, 6-9, 9-12, 12%+');

// ---- real climbs: detail level, cut, preview, slider, text
const climb = W('climb-el-durazno'), lv0 = defaultDetail(climb);
assert.equal(climbLevel(climb, {}), lv0, 'no choice saved: the climb default');
assert.equal(climbLevel(climb, { climbDetail: { [climb.id]: 2 } }), 2);
assert.equal(climbLevel(climb, { climbDetail: { [climb.id]: 99 } }), DETAIL_MAX, 'out of range is clamped');
assert.equal(climbLevel(climb, { climbDetail: { other: 2 } }), lv0, 'another climb\'s choice');
const ss = W('sweetspot-3x12');
assert.equal(cutClimb(ss, settings), ss, 'not a climb: unchanged');
const fine = cutClimb(climb, { climbDetail: { [climb.id]: 2 } }), coarse = cutClimb(climb, {});
assert.equal(fine.detail, 2);
assert.equal(coarse.detail, lv0);
assert.ok(fine.steps.length > coarse.steps.length, 'finer detail, more stretches');
const lead = climb.profile.lead.length;
assert.equal(previewOf(fine).steps.length, fine.steps.length - lead, 'preview leaves out the warm-up');
assert.equal(previewOf(ss), ss);
assert.equal(previewOf(null), null);
assert.equal(detailText(fine), `${detailLabel(fine.profile, 2)} &middot; ${fine.steps.length - lead} steps`);
for (let l = DETAIL_MIN; l <= DETAIL_MAX; l++) assert.equal(sliderOf(sliderOf(l)), l);
assert.equal(sliderOf(DETAIL_MIN), DETAIL_MAX, 'slider right = finest');
assert.equal(detailRow(ss, 3), '');
const row = detailRow(coarse, 7);
assert.match(row, /id="det-7" data-detail="7"/);
assert.match(row, new RegExp(`value="${sliderOf(lv0)}"`));
assert.match(row, /data-detdef="7" tabindex="-1" hidden>Default/, 'Default hidden at the default');
assert.doesNotMatch(detailRow(fine, 7), /hidden>Default/, 'Default shown off the default');
ok('real climbs: level per climb, cut, preview without warm-up, slider and Default');

// ---- grade range of the open slope row
assert.equal(gradeRangeHtml(ss, 0, settings), '', 'ERG: none');
const segs = flatten(previewOf(fine)), pct = (f) => `${+(f * 100).toFixed(1)}%`;
const gr = gradeRangeHtml(fine, 4, settings);
assert.match(gr, /data-gi="4"/);
assert.ok(gr.includes(`Max <b>${pct(Math.max(...segs.map((g) => g.grade)))}</b>`) && gr.includes(`Min <b>${pct(Math.min(...segs.map((g) => g.grade)))}</b>`), gr);
const tooSteep = gradeRangeHtml(fine, 4, { ...settings, maxSendGrade: 0.001, trainerModel: '' });
assert.match(tooSteep, /class="over"/);
assert.match(tooSteep, /Too steep for your trainer even in /);
assert.equal(count(tooSteep, /ico-warn/g), 2, 'warning on Max and on the note');
const flat = gradeRangeHtml(fine, 4, { ...settings, gradeScale: 0, maxSendGrade: 0.001 });
assert.doesNotMatch(flat, /wo-gnote|over/, 'grade realism 0: nothing uphill to check');
ok('grade range: max / min, too steep for the trainer, grade realism');

// ---- ERG vs slope, groups by tag and by content
for (const w of LIB) {
  const t = w.tags || [], slope = isSlopeOnly(w), g = groupOf(w, slope ? 'slope' : 'erg');
  assert.ok(GROUPS[slope ? 'slope' : 'erg'].includes(g), `${w.id}: ${g}`);
  if (t.includes('test') || t.includes('max')) assert.equal(g, 'Tests', w.id);
  else if (slope && t.includes('real climb')) assert.equal(g, 'Real climbs', w.id);
  else if (slope && (t.includes('climb') || t.includes('strength'))) assert.equal(g, 'Climb intervals', w.id);
  else if (!slope && t.includes('vo2')) assert.equal(g, 'VO2max', w.id);
  else if (!slope && t.includes('threshold')) assert.equal(g, 'Threshold', w.id);
  else if (!slope && t.includes('z2')) assert.equal(g, 'Endurance', w.id);
}
assert.equal(isSlopeOnly(W('sim-rolling-45')), true);
assert.equal(isSlopeOnly(W('mtb-overunders-3x9')), false);
const erg = (power, dur = 300) => ({ id: 'x', name: 'x', steps: [{ dur: 600, power: 0.5 }, { dur, power }] });
assert.equal(groupOf(erg(1.2), 'erg'), 'VO2max', 'untagged: hardest step over 105%');
assert.equal(groupOf(erg(0.95), 'erg'), 'Threshold');
assert.equal(groupOf(erg(0.7), 'erg'), 'Endurance');
assert.equal(groupOf(erg(1.5, 30), 'erg'), 'Endurance', 'steps under a minute don\'t count');
assert.equal(groupOf({ ...erg(0.7), tags: ['sweetspot'] }, 'erg'), 'Threshold');
const hill = (grade) => ({ id: 'h', name: 'h', steps: [{ dur: 300, grade: 0 }, { dur: 600, grade }] });
assert.equal(groupOf(hill(6), 'slope'), 'Climb intervals', 'untagged: 5%+ is a climb');
assert.equal(groupOf(hill(3), 'slope'), 'Endurance');
assert.equal(groupOf({ ...climb, tags: [] }, 'slope'), 'Real climbs', 'untagged long distance profile');
ok('groups: from tags, untagged by hardest step or steepest grade');

// ---- grouped lists: group order, empty groups left out, ERG by TSS, slope by duration
const items = (slope) => LIB.map((w, i) => ({ w, i })).filter((x) => isSlopeOnly(x.w) === slope);
for (const [kind, key] of [['erg', estimateTSS], ['slope', totalDuration]]) {
  const html = groupedHtml(items(kind === 'slope'), kind, v);
  const heads = [...html.matchAll(/<h3 class="wo-gh">([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(heads, GROUPS[kind].filter((g) => heads.includes(g)), `${kind} group order`);
  assert.equal(count(html, /class="wo-sec"/g), heads.length);
  for (const sec of html.split('<section class="wo-sec">').slice(1)) {
    const ids = [...sec.matchAll(/data-i="(\d+)" tabindex="0"/g)].map((m) => LIB[+m[1]]);
    assert.ok(ids.length, 'no empty group');
    assert.ok(ids.every((w, j) => !j || key(w) >= key(ids[j - 1])), `${kind}: ${ids.map((w) => w.id)}`);
  }
  assert.equal(count(html, /class="wo" data-i/g), items(kind === 'slope').length);
}
assert.equal(groupedHtml([], 'erg', v), '');
ok('grouped lists: groups in order, none empty, ERG easiest first, slope shortest first');

// ---- one row
const card = (w, i, x = {}) => workoutCard(w, i, { ...v, ...x });
const c = card(ss, 4);
assert.match(c, /<div class="wo" data-i="4" tabindex="0">/);
assert.match(c, /<div class="wo-meta">meta sweetspot-3x12<\/div>/);
assert.match(c, /data-w="340" data-id="sweetspot-3x12"/, 'mini profile');
assert.match(c, /<div class="wo-prof prof-hover"><svg class="profile" data-w="1000"/, 'big chart in the open row');
assert.match(c, /<button class="primary small" data-start="4" tabindex="-1">Start<\/button><\/div>/, 'signed out: Start only');
assert.ok(c.includes(`<div class="wo-desc">${ss.description}</div>`));
assert.doesNotMatch(c, /class="tag">threshold/, 'the group label says it');
assert.doesNotMatch(c, /wo-grades|wo-detail|nofacts|tag coach/);
assert.match(card(ss, 4, { signedIn: true }), /data-copy="4" tabindex="-1">Edit a copy/);
const mine = card({ ...ss, _source: 'mine' }, 0, { signedIn: true });
assert.match(mine, /data-edit="0" tabindex="-1">Edit</);
assert.doesNotMatch(mine, /Edit a copy/);
assert.match(card({ ...ss, _source: 'coach' }, 1), /<span class="tag coach">coach<\/span>/);
const odd = card({ ...ss, name: 'A <b> & B', description: '<i>x</i>', tags: ['imported', 'sim', 'monday', 'vo2', 'hills'] }, 2);
assert.ok(odd.includes('A &lt;b&gt; &amp; B') && odd.includes('&lt;i&gt;x&lt;/i&gt;'), 'escaped');
assert.deepEqual([...odd.matchAll(/class="tag">([^<]+)</g)].map((m) => m[1]), ['imported', 'hills'], 'sim, weekdays and group tags hidden');
assert.match(odd, /data-remove="2" tabindex="-1">Remove/, 'imported: Remove');
assert.ok(['sim', 'monday'].every((t) => HIDDEN_TAGS.has(t)) && GROUP_TAGS.has('vo2'));
const cc = card(fine, 9);
assert.match(cc, /wo-grades" data-gi="9"/);
assert.match(cc, /id="det-9"/);
assert.equal(woFacts(W('ramp-test'), v), '', 'ramp test: no main set, not planned, no zone bar');
assert.match(card(W('ramp-test'), 0), /wo-info nofacts/, 'nothing to show: no facts column');
ok('row: meta, profiles, Start / Edit / Edit a copy / Remove, chips, escaping, climb extras');

// ---- facts of the open row
const f = woFacts(ss, v);
assert.ok(f.includes(`<span class="fl">Main set</span><span class="fv">${mainSet(ss, settings.ftp)}</span>`));
const when = dayDate('2026-11-20').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
assert.ok(f.includes(`<span class="fl">In the plan</span><span class="fv">${when}</span>`), 'next date in the plan');
assert.match(woFacts(W('vo2-30-15'), v), /In the plan<\/span><span class="fv">Today</);
assert.doesNotMatch(woFacts(W('z2-60'), v), /In the plan/, 'only dates from today on');
assert.match(f, /Time in zones/);
const legend = [...f.matchAll(/<span><i style="background:([^"]+)"><\/i>(Z\d) (\d+) min<\/span>/g)].map((m) => [m[2], +m[3], m[1]]);
assert.deepEqual(legend[0], ['Z3', 36, ZC.z3], 'hardest zone first: 3 x 12 min at 90%');
const ramp = woFacts({ id: 'r', name: 'r', steps: [{ dur: 600, from: 0.5, to: 1.0 }] }, { ...v, workSummary: () => '' });
assert.deepEqual([...ramp.matchAll(/<\/i>(Z\d) (\d+) min</g)].map((m) => `${m[1]} ${m[2]}`), ['Z4 2', 'Z3 3', 'Z2 4', 'Z1 1'], 'a ramp counts in every zone it crosses');
assert.ok(legend.length <= 4);
const flex = [...f.matchAll(/flex:([\d.]+)/g)].reduce((a, m) => a + +m[1], 0);
assert.ok(Math.abs(flex - totalDuration(ss)) < 1e-6, 'bars add up to the whole workout');
const sf = woFacts(W('sim-rolling-45'), v);
assert.match(sf, /Time by grade/);
assert.doesNotMatch(sf, /Main set/, 'slope sessions have no main set');
assert.ok([...sf.matchAll(/<\/i>([^<]+) \d+ min</g)].every((m) => GRADE_LABEL.includes(m[1])), 'grade labels');
assert.ok(GRADE.some((g) => sf.includes(`background:${g}`)), 'grade colors from v');
assert.doesNotMatch(woFacts(W('ramp-test'), { ...v, plan: { days: { '2026-11-19': 'ramp-test' } } }), /zbar/, 'no zone bar for a ramp with no top');
assert.equal(woFacts(W('z2-60'), { ...v, plan: null }).includes('In the plan'), false, 'no plan');
ok('open row facts: main set, next date in the plan, time in zones / by grade');

console.log(`library: ${n} tests passed`);
